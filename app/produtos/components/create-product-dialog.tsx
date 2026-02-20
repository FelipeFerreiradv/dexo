"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  parseTitleToFields,
  suggestCategoryFromTitle,
  mapSuggestedCategory,
  ML_CATALOG,
  ML_CATEGORIES,
  ML_CATEGORY_OPTIONS,
} from "../../lib/product-parser"; // ML_CATALOG + ML_CATEGORIES (top-level) + ML_CATEGORY_OPTIONS (detailed)
import {
  getMeasurementsForCategory,
  ML_MEASUREMENTS_MAP,
} from "../../lib/ml-measurements";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Plus,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Check,
  Package,
  DollarSign,
  Car,
  ClipboardCheck,
  Image,
  ShoppingCart,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ImageUpload } from "@/components/ui/image-upload";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { CurrencyInput } from "@/components/ui/currency-input";

// NextAuth
import { useSession } from "next-auth/react";

// Schema de validação com campos de autopeças
const productSchema = z.object({
  // Step 1: Identificação
  sku: z
    .string()
    .min(1, "SKU é obrigatório")
    .max(50, "SKU deve ter no máximo 50 caracteres")
    .regex(
      /^[A-Za-z0-9-_]+$/,
      "SKU deve conter apenas letras, números, - ou _",
    ),
  name: z
    .string()
    .min(3, "Nome deve ter pelo menos 3 caracteres")
    .max(100, "Nome deve ter no máximo 100 caracteres"),
  description: z
    .string()
    .max(500, "Descrição deve ter no máximo 500 caracteres")
    .optional(),
  partNumber: z.string().max(100).optional().nullable(),

  // Step 1.5: Imagem
  imageUrl: z
    .string()
    .min(1, "Imagem é obrigatória")
    .refine((value) => {
      // Aceitar URLs completas (http/https) ou URLs relativas que começam com /
      return /^https?:\/\/.+/.test(value) || /^\/.+/.test(value);
    }, "URL da imagem inválida"),

  // Step 4: Anúncio Mercado Livre (opcional)
  createMLListing: z.boolean().optional(),
  mlCategory: z.string().optional(),

  // Step 2: Preços e Estoque
  price: z
    .number({ invalid_type_error: "Preço deve ser um número" })
    .min(0, "Preço deve ser maior ou igual a zero")
    .multipleOf(0.01, "Preço deve ter no máximo 2 casas decimais"),
  stock: z
    .number({ invalid_type_error: "Estoque deve ser um número" })
    .int("Estoque deve ser um número inteiro")
    .min(0, "Estoque deve ser maior ou igual a zero"),
  costPrice: z
    .number()
    .min(0, "Custo deve ser maior ou igual a zero")
    .optional()
    .nullable(),
  markup: z
    .number()
    .min(0, "Margem deve ser maior ou igual a zero")
    .optional()
    .nullable(),
  location: z.string().max(100).optional().nullable(),

  // Step 3: Veículo e Peça
  brand: z.string().max(100).optional().nullable(),
  model: z.string().max(100).optional().nullable(),
  year: z.string().max(20).optional().nullable(),
  version: z.string().max(100).optional().nullable(),
  category: z.string().max(100).optional().nullable(),
  quality: z
    .enum(["SUCATA", "SEMINOVO", "NOVO", "RECONDICIONADO"])
    .optional()
    .nullable(),
  isSecurityItem: z.boolean().optional(),
  isTraceable: z.boolean().optional(),
  sourceVehicle: z.string().max(200).optional().nullable(),

  // Medidas / peso (cm / kg)
  heightCm: z
    .number({ invalid_type_error: "Altura deve ser um número" })
    .int("Altura deve ser um número inteiro")
    .min(0, "Altura inválida")
    .optional()
    .nullable(),
  widthCm: z
    .number({ invalid_type_error: "Largura deve ser um número" })
    .int("Largura deve ser um número inteiro")
    .min(0, "Largura inválida")
    .optional()
    .nullable(),
  lengthCm: z
    .number({ invalid_type_error: "Comprimento deve ser um número" })
    .int("Comprimento deve ser um número inteiro")
    .min(0, "Comprimento inválido")
    .optional()
    .nullable(),
  weightKg: z
    .number({ invalid_type_error: "Peso deve ser um número" })
    .min(0, "Peso inválido")
    .optional()
    .nullable(),
});

type ProductFormData = z.infer<typeof productSchema>;

interface CreateProductDialogProps {
  onProductCreated: () => void;
  onToast: (message: string, type: "success" | "error") => void;
}

const qualityOptions = [
  { value: "SUCATA", label: "Sucata" },
  { value: "SEMINOVO", label: "Seminovo" },
  { value: "NOVO", label: "Novo" },
  { value: "RECONDICIONADO", label: "Recondicionado" },
];

// Configuração dos steps
const STEPS = [
  {
    id: 1,
    title: "Identificação",
    description: "Dados básicos do produto",
    icon: Package,
    fields: ["sku", "name", "description", "partNumber"],
  },
  {
    id: 2,
    title: "Imagem",
    description: "Foto do produto",
    icon: Image,
    fields: ["imageUrl"],
  },
  {
    id: 3,
    title: "Preços e Estoque",
    description: "Valores e quantidade",
    icon: DollarSign,
    fields: ["price", "stock", "costPrice", "markup", "location"],
  },
  {
    id: 4,
    title: "Veículo e Peça",
    description: "Dados de autopeças",
    icon: Car,
    fields: [
      "brand",
      "model",
      "year",
      "version",
      "category",
      "quality",
      "isSecurityItem",
      "isTraceable",
      "sourceVehicle",
    ],
  },
  {
    id: 5,
    title: "Mercado Livre",
    description: "Criar anúncio (opcional)",
    icon: ShoppingCart,
    fields: ["createMLListing", "mlCategory"],
  },
  {
    id: 6,
    title: "Revisão",
    description: "Confirme os dados",
    icon: ClipboardCheck,
    fields: [],
  },
];

const TOTAL_STEPS = STEPS.length;

export function CreateProductDialog({
  onProductCreated,
  onToast,
}: CreateProductDialogProps) {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingSku, setIsLoadingSku] = useState(false);
  const [defaultDescription, setDefaultDescription] = useState("");
  const [mlOptions, setMlOptions] = useState<{ id: string; value: string }[]>(
    [],
  );
  const [mlConnected, setMlConnected] = useState<boolean | null>(null);
  const [mlAccountStatus, setMlAccountStatus] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors },
    setValue,
    watch,
    trigger,
  } = useForm<ProductFormData>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      sku: "",
      name: "",
      description: "",
      partNumber: "",
      imageUrl: "",
      createMLListing: false,
      mlCategory: "",
      price: 0,
      stock: 0,
      costPrice: null,
      markup: null,
      location: "",
      brand: "",
      model: "",
      year: "",
      version: "",
      category: "",
      quality: null,
      isSecurityItem: false,
      isTraceable: false,
      sourceVehicle: "",

      // Medidas iniciais (cm / kg)
      heightCm: undefined,
      widthCm: undefined,
      lengthCm: undefined,
      weightKg: undefined,
    },
  });

  // Watch all form values for review step
  const formValues = watch();

  // Watch específicos para cálculos automáticos
  const watchName = watch("name");
  const watchPartNumber = watch("partNumber");
  const watchCostPrice = watch("costPrice");
  const watchPrice = watch("price");
  const watchCategory = watch("category");
  const watchMlCategory = watch("mlCategory");
  const watchHeight = watch("heightCm");
  const watchWidth = watch("widthCm");
  const watchLength = watch("lengthCm");
  const watchWeight = watch("weightKg");

  // Busca próximo SKU ao abrir o dialog
  const fetchNextSku = useCallback(async () => {
    setIsLoadingSku(true);
    try {
      const response = await fetch("http://localhost:3333/products/next-sku");
      if (response.ok) {
        const data = await response.json();
        setValue("sku", data.sku);
      }
    } catch (error) {
      console.error("Erro ao buscar SKU:", error);
    } finally {
      setIsLoadingSku(false);
    }
  }, [setValue]);

  // Busca descrição padrão do usuário
  const fetchDefaultDescription = useCallback(async () => {
    // Tentar usar id (quando disponível). Caso contrário, usar /me com header email como fallback.
    try {
      // Preferir buscar por id (quando id interno existir)
      if (session?.user?.id) {
        try {
          const resp = await fetch(
            `http://localhost:3333/users/${session.user.id}`,
          );
          if (resp.ok) {
            const user = await resp.json();
            const desc = user.defaultProductDescription || "";
            setDefaultDescription(desc);
            setValue("description", desc);
            return;
          }
          // se 404, cair para fallback
        } catch (err) {
          // continue to fallback
        }
      }

      // Fallback: buscar /users/me pelo header `email` (mais confiável quando session.id não é o internal id)
      if (session?.user?.email) {
        const resp2 = await fetch(`http://localhost:3333/users/me`, {
          headers: { email: session.user.email },
        });
        if (resp2.ok) {
          const user = await resp2.json();
          const desc = user.defaultProductDescription || "";
          setDefaultDescription(desc);
          setValue("description", desc);
          return;
        }
      }
    } catch (error) {
      console.error("Erro ao buscar descrição padrão:", error);
    }
  }, [session?.user?.email, session?.user?.id, setValue]);

  // Import shared parser
  // NOTE: keep logic same, just using central util to avoid duplication
  useEffect(() => {
    /* dynamic import to avoid SSR issues */
    // no-op here; actual parsing is triggered when name changes in the effect below
  }, []);

  // Busca SKU, descrição padrão e categorias ML quando dialog abre
  useEffect(() => {
    if (open) {
      // Reset auto-detection state when opening modal to avoid stale auto-detected values
      autoDetectedRef.current = null;

      fetchNextSku();
      fetchDefaultDescription();

      // Buscar categorias ML do backend (apenas quando modal aberto)
      (async () => {
        try {
          const base =
            (process.env.NEXT_PUBLIC_APP_BACKEND_URL as string) ||
            "http://localhost:3333";
          const resp = await fetch(`${base}/marketplace/ml/categories`, {
            headers: { email: session?.user?.email || "" },
          });
          if (resp.ok) {
            const json = await resp.json();
            setMlOptions(json.categories || []);
          }

          // Também buscar status da conta ML para proteger a UI (ex: impedir criar anúncio se conta RESTRICTED/ERROR)
          try {
            const respStatus = await fetch(`${base}/marketplace/ml/status`, {
              headers: { email: session?.user?.email || "" },
            });
            if (respStatus.ok) {
              const statusJson = await respStatus.json();
              setMlConnected(Boolean(statusJson.connected));
              setMlAccountStatus(statusJson.status || null);
            }
          } catch (sErr) {
            console.error("Erro ao buscar status ML:", sErr);
          }
        } catch (err) {
          console.error("Erro ao buscar categorias ML:", err);
        }
      })();
    }
  }, [open, fetchNextSku, fetchDefaultDescription]);

  // Define descrição padrão quando carregada
  useEffect(() => {
    if (defaultDescription) {
      setValue("description", defaultDescription);
    }
  }, [defaultDescription, setValue]);

  // Calcula margem automaticamente (Preço Venda - Preço Custo) / Preço Custo * 100
  useEffect(() => {
    if (watchCostPrice && watchPrice && watchCostPrice > 0) {
      const markup = ((watchPrice - watchCostPrice) / watchCostPrice) * 100;
      setValue("markup", Math.round(markup * 100) / 100); // 2 casas decimais
    }
  }, [watchCostPrice, watchPrice, setValue]);

  // Sugere categoria e extrai marca/modelo/ano baseada no nome do produto (sempre atualiza quando nome muda).
  // Só sobrescreve campos se estiverem vazios ou se o valor atual for o mesmo que foi preenchido automaticamente antes.
  const autoDetectedRef = useRef<{
    brand?: string;
    model?: string;
    year?: string;
    category?: string;
    // medidas auto-detectadas
    heightCm?: number;
    widthCm?: number;
    lengthCm?: number;
    weightKg?: number;
  } | null>(null);

  // Debounced auto-fill: wait a short time after typing stops to apply detection (avoids transient partial parses blocking updates)
  const autoFillTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!watchName) return;

    // Clear existing timer
    if (autoFillTimerRef.current) {
      clearTimeout(autoFillTimerRef.current);
    }

    // Schedule debounced run
    autoFillTimerRef.current = window.setTimeout(() => {
      const detected = parseTitleToFields(watchName);

      // Prefer dynamic ML categories fetched from backend when available
      let mapping: {
        topLevel?: string;
        detailedId?: string;
        detailedValue?: string;
      } = {};

      if (mlOptions && mlOptions.length > 0) {
        const tl = watchName.toLowerCase();

        // Try exact fullPath match
        const byFullPath = mlOptions.find((c) =>
          tl.includes(c.value.toLowerCase()),
        );
        if (byFullPath) {
          mapping = {
            topLevel: byFullPath.value.split(" > ")[0].trim(),
            detailedId: byFullPath.id,
            detailedValue: byFullPath.value,
          };
        } else {
          // Try last-segment (subcategory name)
          const byLast = mlOptions.find((c) => {
            const last = c.value.split(" > ").slice(-1)[0].toLowerCase();
            return tl.includes(last);
          });
          if (byLast) {
            mapping = {
              topLevel: byLast.value.split(" > ")[0].trim(),
              detailedId: byLast.id,
              detailedValue: byLast.value,
            };
          }
        }
      }

      // Fallback to static parser suggestion
      if (!mapping.detailedId) {
        const suggestedCategory = suggestCategoryFromTitle(watchName);
        const suggestedForMapping =
          detected.category || suggestedCategory || undefined;
        mapping = suggestedForMapping
          ? mapSuggestedCategory(suggestedForMapping)
          : mapping;
      }

      // Normalizer for comparisons
      const norm = (s?: string) => (s || "").toString().trim().toLowerCase();

      // Capture previous auto-detected values
      const prev = autoDetectedRef.current || ({} as any);

      // DEBUG: log detection flow to help debug cases where fields are not updated in the UI
      try {
        // eslint-disable-next-line no-console
        console.debug("[auto-fill/run]", {
          name: watchName,
          detected,
          mapping,
          prev,
        });

        // Send lightweight diagnostic to backend in dev mode to help debugging
        if (
          typeof window !== "undefined" &&
          window.location.hostname === "localhost"
        ) {
          const base =
            (process.env.NEXT_PUBLIC_APP_BACKEND_URL as string) ||
            "http://localhost:3333";
          void fetch(`${base}/debug/client-log`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "auto-fill",
              name: watchName,
              detected,
              mapping,
              prev,
            }),
          }).catch(() => null);
        }
      } catch (e) {
        /* ignore logging errors in rare environments */
      }

      // Categoria: atualizar se vazio ou se o valor atual foi auto-detectado anteriormente
      const currentCategory = watch("category");
      const currentMlCategory = watch("mlCategory");
      const shouldUpdateCategory =
        !currentCategory || norm(prev.category) === norm(currentCategory);

      if (shouldUpdateCategory) {
        if (mapping.topLevel) {
          setValue("category", mapping.topLevel, { shouldDirty: true });
          if (
            typeof window !== "undefined" &&
            window.location.hostname === "localhost"
          ) {
            setTimeout(
              () =>
                console.debug(
                  "[auto-fill] post-set category",
                  watch("category"),
                ),
              0,
            );
          }
        } else if (detected.category) {
          setValue("category", detected.category, { shouldDirty: true });
          if (
            typeof window !== "undefined" &&
            window.location.hostname === "localhost"
          ) {
            setTimeout(
              () =>
                console.debug(
                  "[auto-fill] post-set category",
                  watch("category"),
                ),
              0,
            );
          }
        }
      }

      // mlCategory: setar ou limpar dependendo do mapeamento atual
      const prevMl = prev.mlCategory;
      const isPrevAutoMl =
        prevMl && norm(prevMl) === norm(currentMlCategory || "");

      if (mapping.detailedId) {
        // Só atribuir mlCategory se for um ID válido presente em mlOptions
        const externalFromMlOptions = mlOptions.find(
          (c) => c.value === mapping.detailedValue,
        )?.id;

        if (!currentMlCategory || isPrevAutoMl) {
          if (externalFromMlOptions) {
            setValue("mlCategory", externalFromMlOptions, {
              shouldDirty: true,
            });
            if (
              typeof window !== "undefined" &&
              window.location.hostname === "localhost"
            ) {
              setTimeout(
                () =>
                  console.debug(
                    "[auto-fill] post-set mlCategory",
                    watch("mlCategory"),
                  ),
                0,
              );
            }
          } else {
            // Não encontrou categoria válida, limpar mlCategory
            setValue("mlCategory", "", { shouldDirty: true });
            if (
              typeof window !== "undefined" &&
              window.location.hostname === "localhost"
            ) {
              setTimeout(
                () =>
                  console.debug(
                    "[auto-fill] post-clear mlCategory",
                    watch("mlCategory"),
                  ),
                0,
              );
            }
          }
        }

        // Ensure top-level is set too
        if (mapping.topLevel && shouldUpdateCategory) {
          setValue("category", mapping.topLevel, { shouldDirty: true });
          if (
            typeof window !== "undefined" &&
            window.location.hostname === "localhost"
          ) {
            setTimeout(
              () =>
                console.debug(
                  "[auto-fill] post-set category",
                  watch("category"),
                ),
              0,
            );
          }
        }
      } else {
        // No detailed mapping: if previously auto-filled mlCategory and user didn't change it, clear it
        if (isPrevAutoMl && currentMlCategory) {
          setValue("mlCategory", "", { shouldDirty: true });
          if (
            typeof window !== "undefined" &&
            window.location.hostname === "localhost"
          ) {
            setTimeout(
              () =>
                console.debug(
                  "[auto-fill] post-clear mlCategory",
                  watch("mlCategory"),
                ),
              0,
            );
          }
        }
      }

      // Marca
      const currentBrand = watch("brand");
      const shouldUpdateBrand =
        !currentBrand || norm(prev.brand) === norm(currentBrand);
      if (
        typeof window !== "undefined" &&
        window.location.hostname === "localhost"
      ) {
        console.debug("[auto-fill] decision brand", {
          shouldUpdateBrand,
          currentBrand,
          prevBrand: prev.brand,
          detectedBrand: detected.brand,
          inputMounted: !!document.getElementById("brand"),
          inputDom: document.getElementById("brand")?.value,
        });
      }
      if (shouldUpdateBrand) {
        if (detected.brand) {
          setValue("brand", detected.brand, { shouldDirty: true });
          if (
            typeof window !== "undefined" &&
            window.location.hostname === "localhost"
          ) {
            setTimeout(() => {
              console.debug("[auto-fill] post-set brand", watch("brand"));
              console.debug(
                "[auto-fill] dom brand after set",
                document.getElementById("brand")?.value,
              );
            }, 50);
          }
        } else if (!currentBrand) {
          setValue("brand", "", { shouldDirty: true });
          if (
            typeof window !== "undefined" &&
            window.location.hostname === "localhost"
          ) {
            setTimeout(() => {
              console.debug("[auto-fill] post-clear brand", watch("brand"));
              console.debug(
                "[auto-fill] dom brand after clear",
                document.getElementById("brand")?.value,
              );
            }, 50);
          }
        }
      }

      // Modelo
      const currentModel = watch("model");
      const shouldUpdateModel =
        !currentModel || norm(prev.model) === norm(currentModel);
      if (
        typeof window !== "undefined" &&
        window.location.hostname === "localhost"
      ) {
        console.debug("[auto-fill] decision model", {
          shouldUpdateModel,
          currentModel,
          prevModel: prev.model,
          detectedModel: detected.model,
          inputMounted: !!document.getElementById("model"),
          inputDom: document.getElementById("model")?.value,
        });
      }
      if (shouldUpdateModel) {
        if (detected.model) {
          setValue("model", detected.model, { shouldDirty: true });
          if (
            typeof window !== "undefined" &&
            window.location.hostname === "localhost"
          ) {
            setTimeout(() => {
              console.debug("[auto-fill] post-set model", watch("model"));
              console.debug(
                "[auto-fill] dom model after set",
                document.getElementById("model")?.value,
              );
            }, 50);
          }
        } else if (!currentModel) {
          setValue("model", "", { shouldDirty: true });
          if (
            typeof window !== "undefined" &&
            window.location.hostname === "localhost"
          ) {
            setTimeout(() => {
              console.debug("[auto-fill] post-clear model", watch("model"));
              console.debug(
                "[auto-fill] dom model after clear",
                document.getElementById("model")?.value,
              );
            }, 50);
          }
        }
      }

      // Ano
      const currentYear = watch("year");
      const shouldUpdateYear =
        !currentYear || norm(prev.year) === norm(currentYear);
      if (
        typeof window !== "undefined" &&
        window.location.hostname === "localhost"
      ) {
        console.debug("[auto-fill] decision year", {
          shouldUpdateYear,
          currentYear,
          prevYear: prev.year,
          detectedYear: detected.year,
          inputMounted: !!document.getElementById("year"),
          inputDom: document.getElementById("year")?.value,
        });
      }
      if (shouldUpdateYear) {
        if (detected.year) {
          setValue("year", detected.year, { shouldDirty: true });
          if (
            typeof window !== "undefined" &&
            window.location.hostname === "localhost"
          ) {
            setTimeout(() => {
              console.debug("[auto-fill] post-set year", watch("year"));
              console.debug(
                "[auto-fill] dom year after set",
                document.getElementById("year")?.value,
              );
            }, 50);
          }
        } else if (!currentYear) {
          setValue("year", "", { shouldDirty: true });
          if (
            typeof window !== "undefined" &&
            window.location.hostname === "localhost"
          ) {
            setTimeout(() => {
              console.debug("[auto-fill] post-clear year", watch("year"));
              console.debug(
                "[auto-fill] dom year after clear",
                document.getElementById("year")?.value,
              );
            }, 50);
          }
        }
      }

      // Measurements: auto-fill from category OR from product title when appropriate
      try {
        const measurements = getMeasurementsForCategory(
          mapping.topLevel || detected.category || watchName,
          mapping.detailedValue,
        );

        // height
        const currentHeight = watch("heightCm");
        const prevHeight = prev.heightCm;
        const shouldUpdateHeight =
          currentHeight === null ||
          currentHeight === undefined ||
          prevHeight === currentHeight;
        if (shouldUpdateHeight && measurements?.heightCm !== undefined) {
          setValue("heightCm", measurements.heightCm, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
        }

        // width
        const currentWidth = watch("widthCm");
        const prevWidth = prev.widthCm;
        const shouldUpdateWidth =
          currentWidth === null ||
          currentWidth === undefined ||
          prevWidth === currentWidth;
        if (shouldUpdateWidth && measurements?.widthCm !== undefined) {
          setValue("widthCm", measurements.widthCm, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
        }

        // length
        const currentLength = watch("lengthCm");
        const prevLength = prev.lengthCm;
        const shouldUpdateLength =
          currentLength === null ||
          currentLength === undefined ||
          prevLength === currentLength;
        if (shouldUpdateLength && measurements?.lengthCm !== undefined) {
          setValue("lengthCm", measurements.lengthCm, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
        }

        // weight
        const currentWeight = watch("weightKg");
        const prevWeight = prev.weightKg;
        const shouldUpdateWeight =
          currentWeight === null ||
          currentWeight === undefined ||
          prevWeight === currentWeight;
        if (shouldUpdateWeight && measurements?.weightKg !== undefined) {
          setValue("weightKg", measurements.weightKg, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
        }

        // If category wasn't detected earlier, try to suggest a category from
        // the input title or from the measurement key that matched (best-effort).
        try {
          const currentCategory = watch("category");
          const shouldUpdateCategory =
            !currentCategory ||
            (autoDetectedRef.current?.category ?? "") === currentCategory;

          if (shouldUpdateCategory && !mapping.topLevel && !detected.category) {
            const source = (watchName || "").toString().toLowerCase();
            const tokens = source.split(/\s+/).filter(Boolean);

            // 1) try to find a detailed ML category whose value or keywords contain any token
            let childMatch = ML_CATEGORY_OPTIONS.find((ch) => {
              const v = ch.value.toLowerCase();
              if (tokens.some((t) => v.includes(t) || t.includes(v)))
                return true;
              return ch.keywords?.some((kw) =>
                tokens.some(
                  (t) =>
                    kw.toLowerCase().includes(t) ||
                    t.includes(kw.toLowerCase()),
                ),
              );
            });

            // 2) fallback: try to map measurement key -> ML category
            if (!childMatch && measurements) {
              // find key in ML_MEASUREMENTS_MAP that has the same measurements
              const matchedKey = Object.keys(ML_MEASUREMENTS_MAP).find((k) => {
                const mm = ML_MEASUREMENTS_MAP[k];
                return (
                  mm.heightCm === measurements.heightCm &&
                  mm.widthCm === measurements.widthCm &&
                  mm.lengthCm === measurements.lengthCm &&
                  mm.weightKg === measurements.weightKg
                );
              });

              if (matchedKey) {
                // try to find an ML child that mentions this key/token
                const mk = matchedKey.toLowerCase();
                childMatch = ML_CATEGORY_OPTIONS.find((ch) => {
                  const v = ch.value.toLowerCase();
                  if (v.includes(mk)) return true;
                  return ch.keywords?.some((kw) =>
                    kw.toLowerCase().includes(mk),
                  );
                });

                // if still no childMatch, try matching tokens of the key against children
                if (!childMatch) {
                  const keyTokens = mk.split(/\s+/).filter(Boolean);
                  childMatch = ML_CATEGORY_OPTIONS.find((ch) =>
                    ch.keywords?.some((kw) =>
                      keyTokens.some((kt) => kw.toLowerCase().includes(kt)),
                    ),
                  );
                }

                // if still no childMatch, set readable category from key (capitalized)
                if (!childMatch && matchedKey) {
                  const pretty = matchedKey
                    .split(/\s+/)
                    .map((w) => w[0]?.toUpperCase() + w.slice(1))
                    .join(" ");
                  setValue("category", pretty, { shouldDirty: true });
                }
              }
            }

            if (childMatch) {
              // set both mlCategory (detailed) and the top-level category label
              const topLevelLabel = childMatch.value.split(" > ")[0].trim();

              // Prefer the external category id synced from the backend (`mlOptions`) when available.
              // `mlOptions` contains { id: externalId, value: fullPath }.
              const externalMatch = mlOptions.find(
                (c) =>
                  c.value &&
                  c.value.trim().toLowerCase() ===
                    childMatch.value.trim().toLowerCase(),
              );

              // Always set a STRING into the form field (never an object)
              // Only set internal ML_CATALOG id when there are NO synced `mlOptions`.
              // If `mlOptions` exists but there's no external match, leave blank to avoid auto-sending internal ids.
              const mlValueToSet =
                externalMatch?.id ??
                (mlOptions && mlOptions.length === 0 ? childMatch.id : "");

              setValue("mlCategory", mlValueToSet, { shouldDirty: true });
              setValue("category", topLevelLabel, { shouldDirty: true });
              if (
                typeof window !== "undefined" &&
                window.location.hostname === "localhost"
              )
                console.debug(
                  "[auto-fill] post-set category from measurements/keywords",
                  topLevelLabel,
                  mlValueToSet,
                );
            }
          }
        } catch (err) {
          /* ignore category-suggestion failures */
        }

        // ensure controllers update and validation runs
        void trigger(["heightCm", "widthCm", "lengthCm", "weightKg"]);
      } catch (err) {
        /* ignore measurement lookup errors */
      }

      // Salvar o que detectamos agora para próxima comparação (mantém valores anteriores quando parser retorna campos undefined)
      autoDetectedRef.current = {
        // preserve any previously-detected value unless parser returned a non-empty value
        brand: detected.brand ?? autoDetectedRef.current?.brand,
        model: detected.model ?? autoDetectedRef.current?.model,
        year: detected.year ?? autoDetectedRef.current?.year,
        category:
          mapping.topLevel ||
          detected.category ||
          autoDetectedRef.current?.category,
        mlCategory:
          mlOptions.find((c) => c.value === mapping.detailedValue)?.id ??
          autoDetectedRef.current?.mlCategory,
        heightCm:
          getMeasurementsForCategory(
            mapping.topLevel || detected.category || watchName,
            mapping.detailedValue,
          )?.heightCm ?? autoDetectedRef.current?.heightCm,
        widthCm:
          getMeasurementsForCategory(
            mapping.topLevel || detected.category || watchName,
            mapping.detailedValue,
          )?.widthCm ?? autoDetectedRef.current?.widthCm,
        lengthCm:
          getMeasurementsForCategory(
            mapping.topLevel || detected.category || watchName,
            mapping.detailedValue,
          )?.lengthCm ?? autoDetectedRef.current?.lengthCm,
        weightKg:
          getMeasurementsForCategory(
            mapping.topLevel || detected.category || watchName,
            mapping.detailedValue,
          )?.weightKg ?? autoDetectedRef.current?.weightKg,
      };
    }, 300);

    return () => {
      if (autoFillTimerRef.current) clearTimeout(autoFillTimerRef.current);
    };
  }, [watchName, setValue, watch, mlOptions]);

  // When category (top-level or mlCategory) changes, update measurements accordingly.
  useEffect(() => {
    const category = watchCategory;
    const detailedValue = mlOptions.find(
      (c) => c.id === watchMlCategory,
    )?.value;

    const prev = autoDetectedRef.current || ({} as any);

    try {
      const measurements = getMeasurementsForCategory(category, detailedValue);

      // read current field values directly to avoid re-running effect on measurement updates
      const currentHeight = watch("heightCm");
      const currentWidth = watch("widthCm");
      const currentLength = watch("lengthCm");
      const currentWeight = watch("weightKg");

      // helper to decide update
      const shouldReplace = (current: any, prevAuto: any) =>
        current === null || current === undefined || prevAuto === current;

      if (measurements) {
        if (shouldReplace(currentHeight, prev.heightCm))
          setValue("heightCm", measurements.heightCm ?? undefined, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
        if (shouldReplace(currentWidth, prev.widthCm))
          setValue("widthCm", measurements.widthCm ?? undefined, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
        if (shouldReplace(currentLength, prev.lengthCm))
          setValue("lengthCm", measurements.lengthCm ?? undefined, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
        if (shouldReplace(currentWeight, prev.weightKg))
          setValue("weightKg", measurements.weightKg ?? undefined, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });

        // force validation/update so Controllers reflect the new values immediately
        void trigger(["heightCm", "widthCm", "lengthCm", "weightKg"]);

        // update prev auto-detected measurements
        autoDetectedRef.current = {
          ...autoDetectedRef.current,
          heightCm: measurements.heightCm ?? autoDetectedRef.current?.heightCm,
          widthCm: measurements.widthCm ?? autoDetectedRef.current?.widthCm,
          lengthCm: measurements.lengthCm ?? autoDetectedRef.current?.lengthCm,
          weightKg: measurements.weightKg ?? autoDetectedRef.current?.weightKg,
          category: category || autoDetectedRef.current?.category,
          mlCategory: watchMlCategory || autoDetectedRef.current?.mlCategory,
        };
      } else {
        // no measurements for this category: clear fields only if they were previously auto-filled
        if (
          prev.heightCm !== undefined &&
          (currentHeight === prev.heightCm || currentHeight === null)
        )
          setValue("heightCm", undefined, { shouldDirty: true });
        if (
          prev.widthCm !== undefined &&
          (currentWidth === prev.widthCm || currentWidth === null)
        )
          setValue("widthCm", undefined, { shouldDirty: true });
        if (
          prev.lengthCm !== undefined &&
          (currentLength === prev.lengthCm || currentLength === null)
        )
          setValue("lengthCm", undefined, { shouldDirty: true });
        if (
          prev.weightKg !== undefined &&
          (currentWeight === prev.weightKg || currentWeight === null)
        )
          setValue("weightKg", undefined, { shouldDirty: true });

        autoDetectedRef.current = {
          ...autoDetectedRef.current,
          heightCm: undefined,
          widthCm: undefined,
          lengthCm: undefined,
          weightKg: undefined,
          category: category || autoDetectedRef.current?.category,
          mlCategory: watchMlCategory || autoDetectedRef.current?.mlCategory,
        };
      }
    } catch (err) {
      /* ignore */
    }
  }, [watchCategory, watchMlCategory, mlOptions, setValue]);

  const progressPercentage = (currentStep / TOTAL_STEPS) * 100;

  const onSubmit = async (data: ProductFormData) => {
    setIsSubmitting(true);
    try {
      // Limpar campos vazios/nulos antes de enviar
      const cleanData = {
        ...data,
        costPrice: data.costPrice || undefined,
        markup: data.markup || undefined,
        brand: data.brand || undefined,
        model: data.model || undefined,
        year: data.year || undefined,
        version: data.version || undefined,
        category: data.category || undefined,
        location: data.location || undefined,
        partNumber: data.partNumber || undefined,
        quality: data.quality || undefined,
        sourceVehicle: data.sourceVehicle || undefined,

        // Medidas
        heightCm: data.heightCm ?? undefined,
        widthCm: data.widthCm ?? undefined,
        lengthCm: data.lengthCm ?? undefined,
        weightKg: data.weightKg ?? undefined,

        createListing: data.createMLListing || false,
        createListingCategoryId: data.mlCategory || undefined,
      };

      // Criar produto primeiro
      const response = await fetch("http://localhost:3333/products", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          email: session?.user?.email || "",
        },
        body: JSON.stringify(cleanData),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Erro ao criar produto");
      }

      // Mostrar feedback sobre criação do produto e (quando aplicável)
      onToast("Produto criado com sucesso!", "success");

      // Se um anúncio foi solicitado, informar o usuário do resultado
      if (result.listing) {
        if (result.listing.success) {
          const permalink = result.listing.permalink;
          if (permalink) {
            onToast(
              "Anúncio criado no Mercado Livre — ver na aba Anúncios",
              "success",
            );
          } else {
            onToast("Anúncio criado (vínculo local registrado)", "success");
          }
        } else {
          onToast(
            `Produto criado, mas falha ao criar anúncio: ${result.listing.error || "Erro desconhecido"}`,
            "error",
          );
        }
      }

      handleClose();
      onProductCreated();
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : "Erro ao criar produto",
        "error",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    reset();
    setCurrentStep(1);
    setOpen(false);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      handleClose();
    }
    setOpen(newOpen);
  };

  // Validar campos do step atual antes de avançar
  const validateCurrentStep = async () => {
    const currentStepConfig = STEPS[currentStep - 1];
    const fieldsToValidate =
      currentStepConfig.fields as (keyof ProductFormData)[];

    if (fieldsToValidate.length === 0) return true;

    const isValid = await trigger(fieldsToValidate);
    return isValid;
  };

  const handleNext = async () => {
    const isValid = await validateCurrentStep();
    if (isValid && currentStep < TOTAL_STEPS) {
      setCurrentStep((prev) => prev + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep((prev) => prev - 1);
    }
  };

  const goToStep = (step: number) => {
    // Permite voltar para qualquer step anterior
    if (step < currentStep) {
      setCurrentStep(step);
    }
  };

  // Função para formatar valor monetário
  const formatCurrency = (value: number | null | undefined) => {
    if (value === null || value === undefined) return "—";
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(value);
  };

  // Função para formatar qualidade
  const formatQuality = (value: string | null | undefined) => {
    if (!value) return "—";
    const option = qualityOptions.find((opt) => opt.value === value);
    return option?.label || value;
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" />
          Novo Produto
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[650px]">
        <DialogHeader>
          <DialogTitle>Criar Novo Produto</DialogTitle>
          <DialogDescription>
            Preencha os dados do produto em {TOTAL_STEPS} etapas simples.
          </DialogDescription>
        </DialogHeader>

        {/* Progress Bar */}
        <div className="space-y-4">
          <Progress value={progressPercentage} className="h-2" />

          {/* Step Indicators */}
          <div className="flex justify-between">
            {STEPS.map((step) => {
              const Icon = step.icon;
              const isActive = step.id === currentStep;
              const isCompleted = step.id < currentStep;
              const isClickable = step.id < currentStep;

              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => goToStep(step.id)}
                  disabled={!isClickable}
                  className={`flex flex-col items-center gap-1 transition-colors ${
                    isClickable ? "cursor-pointer" : "cursor-default"
                  }`}
                >
                  <div
                    className={`flex h-10 w-10 items-center justify-center rounded-full border-2 transition-all ${
                      isActive
                        ? "border-primary bg-primary text-primary-foreground"
                        : isCompleted
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-muted-foreground/30 text-muted-foreground/50"
                    }`}
                  >
                    {isCompleted ? (
                      <Check className="h-5 w-5" />
                    ) : (
                      <Icon className="h-5 w-5" />
                    )}
                  </div>
                  <span
                    className={`text-xs font-medium ${
                      isActive
                        ? "text-primary"
                        : isCompleted
                          ? "text-primary/80"
                          : "text-muted-foreground/50"
                    }`}
                  >
                    {step.title}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <Separator />

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          {/* Step 1: Identificação */}
          {currentStep === 1 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="sku">SKU (automático)</Label>
                  <Input
                    id="sku"
                    placeholder={isLoadingSku ? "Carregando..." : "PROD-001"}
                    {...register("sku")}
                    readOnly
                    disabled={isLoadingSku}
                    className="bg-muted"
                  />
                  <p className="text-xs text-muted-foreground">
                    Gerado automaticamente
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="partNumber">Part Number</Label>
                  <Input
                    id="partNumber"
                    placeholder="OEM / Código original"
                    {...register("partNumber")}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="name">Nome do Produto *</Label>
                <Input
                  id="name"
                  placeholder="Nome do produto"
                  {...register("name")}
                  aria-invalid={!!errors.name}
                />
                {errors.name && (
                  <p className="text-sm text-destructive">
                    {errors.name.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Descrição</Label>
                <Textarea
                  id="description"
                  placeholder="A descrição padrão configurada nas suas Preferências será aplicada automaticamente. Você pode editar."
                  {...register("description")}
                  className="min-h-24 resize-none"
                />
                <p className="text-xs text-muted-foreground">
                  A descrição padrão definida em suas Configurações será
                  aplicada automaticamente ao criar novos produtos. Você pode
                  editar manualmente se desejar.
                </p>
                {errors.description && (
                  <p className="text-sm text-destructive">
                    {errors.description.message}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Step 2: Imagem */}
          {currentStep === 2 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Foto do Produto *</Label>
                <Controller
                  name="imageUrl"
                  control={control}
                  render={({ field }) => (
                    <ImageUpload
                      value={field.value}
                      onChange={field.onChange}
                      onError={(error: string) => {
                        console.error("Erro no upload:", error);
                        onToast("Erro ao fazer upload da imagem", "error");
                      }}
                    />
                  )}
                />
                {errors.imageUrl && (
                  <p className="text-sm text-destructive">
                    {errors.imageUrl.message}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Faça upload de uma foto clara do produto. Máximo 5MB,
                  formatos: JPG, PNG, WebP.
                </p>
              </div>
            </div>
          )}

          {/* Step 3: Preços e Estoque */}
          {currentStep === 3 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="costPrice">Preço de Custo</Label>
                  <Controller
                    name="costPrice"
                    control={control}
                    render={({ field }) => (
                      <CurrencyInput
                        id="costPrice"
                        placeholder="0,00"
                        value={field.value}
                        onChange={field.onChange}
                      />
                    )}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="markup">Margem (%) - automática</Label>
                  <Controller
                    name="markup"
                    control={control}
                    render={({ field }) => (
                      <Input
                        id="markup"
                        value={
                          field.value !== null && field.value !== undefined
                            ? `${field.value.toFixed(2)}%`
                            : ""
                        }
                        placeholder="Informe custo e venda"
                        readOnly
                        className="bg-muted"
                      />
                    )}
                  />
                  <p className="text-xs text-muted-foreground">
                    (Venda - Custo) / Custo × 100
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="price">Preço de Venda *</Label>
                  <Controller
                    name="price"
                    control={control}
                    render={({ field }) => (
                      <CurrencyInput
                        id="price"
                        placeholder="0,00"
                        value={field.value}
                        onChange={(v) => field.onChange(v ?? 0)}
                        aria-invalid={!!errors.price}
                      />
                    )}
                  />
                  {errors.price && (
                    <p className="text-sm text-destructive">
                      {errors.price.message}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="stock">Quantidade em Estoque *</Label>
                  <Input
                    id="stock"
                    type="number"
                    min="0"
                    step="1"
                    placeholder="0"
                    {...register("stock", { valueAsNumber: true })}
                    aria-invalid={!!errors.stock}
                    onChange={(e) => {
                      const value = parseInt(e.target.value);
                      setValue("stock", isNaN(value) ? 0 : value);
                    }}
                  />
                  {errors.stock && (
                    <p className="text-sm text-destructive">
                      {errors.stock.message}
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="location">Localização no Estoque</Label>
                <Input
                  id="location"
                  placeholder="Ex: Prateleira A1, Gaveta 3"
                  {...register("location")}
                />
                <p className="text-xs text-muted-foreground">
                  Onde o produto está armazenado fisicamente
                </p>
              </div>
            </div>
          )}

          {/* Step 4: Veículo e Peça */}
          {currentStep === 4 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="quality">Qualidade</Label>
                  <Controller
                    name="quality"
                    control={control}
                    render={({ field }) => (
                      <Select
                        onValueChange={field.onChange}
                        value={field.value || undefined}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Selecione..." />
                        </SelectTrigger>
                        <SelectContent>
                          {qualityOptions.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="brand">Marca</Label>
                  <Controller
                    name="brand"
                    control={control}
                    render={({ field }) => (
                      <Input
                        id="brand"
                        placeholder="Ex: Bosch, Denso"
                        {...field}
                      />
                    )}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="model">Modelo</Label>
                  <Controller
                    name="model"
                    control={control}
                    render={({ field }) => (
                      <Input id="model" placeholder="Ex: Civic" {...field} />
                    )}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="year">Ano</Label>
                  <Controller
                    name="year"
                    control={control}
                    render={({ field }) => (
                      <Input id="year" placeholder="Ex: 2018-2022" {...field} />
                    )}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="version">Versão</Label>
                  <Input
                    id="version"
                    placeholder="Ex: EXL, LX"
                    {...register("version")}
                  />
                </div>
              </div>

              {/* Medidas */}
              <div className="mt-2 grid grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="heightCm">Altura (cm)</Label>
                  <Controller
                    name="heightCm"
                    control={control}
                    render={({ field }) => {
                      return (
                        <Input
                          id="heightCm"
                          type="number"
                          value={field.value ?? ""}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value === ""
                                ? undefined
                                : Number(e.target.value),
                            )
                          }
                        />
                      );
                    }}
                  />
                  {errors.heightCm && (
                    <p className="text-sm text-destructive">
                      {errors.heightCm.message}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="widthCm">Largura (cm)</Label>
                  <Controller
                    name="widthCm"
                    control={control}
                    render={({ field }) => {
                      return (
                        <Input
                          id="widthCm"
                          type="number"
                          value={field.value ?? ""}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value === ""
                                ? undefined
                                : Number(e.target.value),
                            )
                          }
                        />
                      );
                    }}
                  />
                  {errors.widthCm && (
                    <p className="text-sm text-destructive">
                      {errors.widthCm.message}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="lengthCm">Comprimento (cm)</Label>
                  <Controller
                    name="lengthCm"
                    control={control}
                    render={({ field }) => {
                      return (
                        <Input
                          id="lengthCm"
                          type="number"
                          value={field.value ?? ""}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value === ""
                                ? undefined
                                : Number(e.target.value),
                            )
                          }
                        />
                      );
                    }}
                  />
                  {errors.lengthCm && (
                    <p className="text-sm text-destructive">
                      {errors.lengthCm.message}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="weightKg">Peso (kg)</Label>
                  <Controller
                    name="weightKg"
                    control={control}
                    render={({ field }) => {
                      return (
                        <Input
                          id="weightKg"
                          type="number"
                          step="0.01"
                          value={field.value ?? ""}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value === ""
                                ? undefined
                                : Number(e.target.value),
                            )
                          }
                        />
                      );
                    }}
                  />
                  {errors.weightKg && (
                    <p className="text-sm text-destructive">
                      {errors.weightKg.message}
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="category">
                  Categoria (sugerida automaticamente)
                </Label>
                <Controller
                  name="category"
                  control={control}
                  render={({ field }) => {
                    const detailed = ML_CATEGORY_OPTIONS.find(
                      (c) => c.id === watch("mlCategory"),
                    )?.value;

                    return (
                      <Select
                        onValueChange={(val) => {
                          field.onChange(val);
                          // If user manually picks a top-level category, clear detailed mlCategory
                          setValue("mlCategory", "");
                        }}
                        value={field.value || undefined}
                      >
                        <SelectTrigger>
                          <SelectValue>
                            {detailed || field.value || undefined}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {ML_CATEGORIES.map((cat) => (
                            <SelectItem key={cat.id} value={cat.value}>
                              {cat.value}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    );
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Sugerida com base no nome. Categorias do Mercado Livre.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="sourceVehicle">Veículo de Origem</Label>
                <Input
                  id="sourceVehicle"
                  placeholder="Ex: Honda Civic 2020 - Placa ABC1234"
                  {...register("sourceVehicle")}
                />
                <p className="text-xs text-muted-foreground">
                  Para peças de sucata, informe o veículo de origem
                </p>
              </div>

              <Separator />

              <div className="flex flex-wrap gap-6">
                <div className="flex items-center gap-2">
                  <Controller
                    name="isSecurityItem"
                    control={control}
                    render={({ field }) => (
                      <Switch
                        id="isSecurityItem"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                  <Label htmlFor="isSecurityItem" className="cursor-pointer">
                    Item de Segurança
                  </Label>
                </div>

                <div className="flex items-center gap-2">
                  <Controller
                    name="isTraceable"
                    control={control}
                    render={({ field }) => (
                      <Switch
                        id="isTraceable"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                  <Label htmlFor="isTraceable" className="cursor-pointer">
                    Item Rastreável
                  </Label>
                </div>
              </div>
            </div>
          )}

          {/* Step 5: Mercado Livre */}
          {currentStep === 5 && (
            <div className="space-y-4">
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Controller
                    name="createMLListing"
                    control={control}
                    render={({ field }) => (
                      <Switch
                        id="createMLListing"
                        checked={field.value || false}
                        onCheckedChange={field.onChange}
                        disabled={mlConnected === false || mlAccountStatus === 'ERROR'}
                      />
                    )}
                  />
                  <Label htmlFor="createMLListing" className="cursor-pointer">
                    Criar anúncio no Mercado Livre
                  </Label>
                </div>

                <p className="text-sm text-muted-foreground">
                  Selecione esta opção para criar automaticamente um anúncio do
                  produto no Mercado Livre. Você pode escolher uma categoria
                  específica ou usar a sugerida automaticamente.
                </p>

                {mlAccountStatus === 'ERROR' && (
                  <p className="text-sm text-red-600">
                    Conta do Mercado Livre com restrição — anúncios bloqueados. Reconecte a conta ou verifique o Seller Center.
                  </p>
                )}

                {mlConnected === false && (
                  <p className="text-sm text-yellow-600">
                    Conta do Mercado Livre não conectada — conecte sua conta em Integrações para habilitar a criação de anúncios.
                  </p>
                )}

                {watch("createMLListing") && (
                  <div className="space-y-2">
                    <Label htmlFor="mlCategory">
                      Categoria no Mercado Livre
                    </Label>
                    <Controller
                      name="mlCategory"
                      control={control}
                      render={({ field }) => (
                        <Select
                          onValueChange={(val) => {
                            field.onChange(val);
                            // When user selects a detailed ML category, set the top-level category accordingly
                            const parent = ML_CATALOG.find((p) =>
                              p.children?.some((ch) => ch.id === val),
                            );
                            if (parent) setValue("category", parent.value);
                          }}
                          value={
                            field.value ||
                            ML_CATEGORIES.find(
                              (c) => c.value === watch("category"),
                            )?.id ||
                            ""
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Selecione uma categoria..." />
                          </SelectTrigger>
                          <SelectContent>
                            {ML_CATEGORY_OPTIONS.map((cat) => (
                              <SelectItem key={cat.id} value={cat.id}>
                                {cat.value}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                    <p className="text-xs text-muted-foreground">
                      Categoria sugerida: {watch("category") || "Nenhuma"}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 6: Revisão */}
          {currentStep === 6 && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-muted/30 p-4">
                <h4 className="mb-3 font-medium">Identificação</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">SKU:</span>{" "}
                    <span className="font-medium">{formValues.sku || "—"}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Part Number:</span>{" "}
                    <span className="font-medium">
                      {formValues.partNumber || "—"}
                    </span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">Nome:</span>{" "}
                    <span className="font-medium">
                      {formValues.name || "—"}
                    </span>
                  </div>
                  {formValues.description && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">Descrição:</span>{" "}
                      <span className="font-medium">
                        {formValues.description}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-lg border bg-muted/30 p-4">
                <h4 className="mb-3 font-medium">Imagem</h4>
                <div className="text-sm">
                  {formValues.imageUrl ? (
                    <div className="space-y-2">
                      <img
                        src={formValues.imageUrl}
                        alt="Produto"
                        className="h-24 w-24 rounded-lg object-cover border"
                      />
                      <p className="text-muted-foreground">Imagem carregada</p>
                    </div>
                  ) : (
                    <p className="text-muted-foreground">Nenhuma imagem</p>
                  )}
                </div>
              </div>

              <div className="rounded-lg border bg-muted/30 p-4">
                <h4 className="mb-3 font-medium">Preços e Estoque</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Preço Custo:</span>{" "}
                    <span className="font-medium">
                      {formatCurrency(formValues.costPrice)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Margem:</span>{" "}
                    <span className="font-medium">
                      {formValues.markup ? `${formValues.markup}%` : "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Preço Venda:</span>{" "}
                    <span className="font-medium text-primary">
                      {formatCurrency(formValues.price)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Estoque:</span>{" "}
                    <span className="font-medium">
                      {formValues.stock} unidades
                    </span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">Localização:</span>{" "}
                    <span className="font-medium">
                      {formValues.location || "—"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border bg-muted/30 p-4">
                <h4 className="mb-3 font-medium">Veículo e Peça</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Qualidade:</span>{" "}
                    <span className="font-medium">
                      {formatQuality(formValues.quality)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Marca:</span>{" "}
                    <span className="font-medium">
                      {formValues.brand || "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Modelo:</span>{" "}
                    <span className="font-medium">
                      {formValues.model || "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Ano:</span>{" "}
                    <span className="font-medium">
                      {formValues.year || "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Versão:</span>{" "}
                    <span className="font-medium">
                      {formValues.version || "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Categoria:</span>{" "}
                    <span className="font-medium">
                      {formValues.category || "—"}
                    </span>
                  </div>
                  {formValues.sourceVehicle && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">
                        Veículo Origem:
                      </span>{" "}
                      <span className="font-medium">
                        {formValues.sourceVehicle}
                      </span>
                    </div>
                  )}
                  <div className="col-span-2 flex gap-4 pt-2">
                    {formValues.isSecurityItem && (
                      <span className="rounded-full bg-orange-100 px-2 py-1 text-xs font-medium text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
                        Item de Segurança
                      </span>
                    )}
                    {formValues.isTraceable && (
                      <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                        Rastreável
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-lg border bg-muted/30 p-4">
                <h4 className="mb-3 font-medium">Mercado Livre</h4>
                <div className="text-sm">
                  {formValues.createMLListing ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                          Anúncio será criado
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">
                          Categoria:
                        </span>{" "}
                        <span className="font-medium">
                          {(formValues.mlCategory &&
                            (mlOptions.find(
                              (c) => c.id === formValues.mlCategory,
                            )?.value ||
                              ML_CATEGORIES.find(
                                (c) => c.id === formValues.mlCategory,
                              )?.value)) ||
                            formValues.category ||
                            "Não especificada"}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-muted-foreground">
                      Anúncio não será criado
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Footer com navegação */}
          <div className="flex items-center justify-between pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={
                currentStep === 1 ? () => handleOpenChange(false) : handleBack
              }
              disabled={isSubmitting}
            >
              {currentStep === 1 ? (
                "Cancelar"
              ) : (
                <>
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Voltar
                </>
              )}
            </Button>

            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                Etapa {currentStep} de {TOTAL_STEPS}
              </span>

              {currentStep < TOTAL_STEPS ? (
                <Button type="button" onClick={handleNext}>
                  Próximo
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              ) : (
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Criando...
                    </>
                  ) : (
                    <>
                      <Check className="mr-1 h-4 w-4" />
                      Criar Produto
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
