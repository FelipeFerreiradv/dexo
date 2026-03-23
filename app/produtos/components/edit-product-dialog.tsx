"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, ChevronDown, Link2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CompatibilityTab, CompatibilityEntry } from "./compatibility-tab";
import { getApiBaseUrl } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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

// NextAuth
import { useSession } from "next-auth/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { CurrencyInput } from "@/components/ui/currency-input";
import {
  parseTitleToFields,
  suggestCategoryFromTitle,
  mapSuggestedCategory,
  ML_CATALOG,
  ML_CATEGORIES,
  ML_CATEGORY_OPTIONS,
} from "../../lib/product-parser"; // ML_CATALOG + ML_CATEGORIES (top-level) + ML_CATEGORY_OPTIONS (detailed)
import { getMeasurementsForCategory } from "../../lib/ml-measurements";

// Category suggestion centralized in `suggestCategoryFromTitle` in app/lib/product-parser.ts
// Schema de validação com campos de autopeças
const productEditSchema = z.object({
  name: z
    .string()
    .min(3, "Nome deve ter pelo menos 3 caracteres")
    .max(100, "Nome deve ter no máximo 100 caracteres"),
  description: z
    .string()
    .max(4000, "Descrição deve ter no máximo 4000 caracteres")
    .optional(),
  price: z
    .number({ invalid_type_error: "Preço deve ser um número" })
    .min(0, "Preço deve ser maior ou igual a zero")
    .multipleOf(0.01, "Preço deve ter no máximo 2 casas decimais"),
  stock: z
    .number({ invalid_type_error: "Estoque deve ser um número" })
    .int("Estoque deve ser um número inteiro")
    .min(0, "Estoque deve ser maior ou igual a zero"),

  // Campos de autopeças (opcionais)
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
  brand: z.string().max(100).optional().nullable(),
  model: z.string().max(100).optional().nullable(),
  year: z.string().max(20).optional().nullable(),
  version: z.string().max(100).optional().nullable(),
  category: z.string().max(100).optional().nullable(),
  mlCategory: z.string().optional().nullable(),
  location: z.string().max(100).optional().nullable(),
  locationId: z.string().optional().nullable(),
  partNumber: z.string().max(100).optional().nullable(),
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

  imageUrl: z.string().url("URL da imagem inválida").optional().nullable(),
});

type ProductEditFormData = z.infer<typeof productEditSchema>;

type Quality = "SUCATA" | "SEMINOVO" | "NOVO" | "RECONDICIONADO";

interface Product {
  id: string;
  sku: string;
  name: string;
  description?: string | null;
  price: number;
  stock: number;
  createdAt: string;
  updatedAt: string;
  // Campos de autopeças
  costPrice?: number | null;
  markup?: number | null;
  brand?: string | null;
  model?: string | null;
  year?: string | null;
  version?: string | null;
  category?: string | null;
  mlCategory?: string | null;
  location?: string | null;
  locationId?: string | null;
  partNumber?: string | null;
  quality?: Quality | null;
  isSecurityItem?: boolean;
  isTraceable?: boolean;
  sourceVehicle?: string | null;
  heightCm?: number | null;
  widthCm?: number | null;
  lengthCm?: number | null;
  weightKg?: number | null;
  imageUrl?: string | null;
}

interface EditProductDialogProps {
  product: Product;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProductUpdated: () => void;
  onToast: (message: string, type: "success" | "error") => void;
}

const qualityOptions = [
  { value: "SUCATA", label: "Sucata" },
  { value: "SEMINOVO", label: "Seminovo" },
  { value: "NOVO", label: "Novo" },
  { value: "RECONDICIONADO", label: "Recondicionado" },
];

export function EditProductDialog({
  product,
  open,
  onOpenChange,
  onProductUpdated,
  onToast,
}: EditProductDialogProps) {
  const { data: session } = useSession();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [defaultDescription, setDefaultDescription] = useState("");
  const [showAutopartsSection, setShowAutopartsSection] = useState(false);
  const [mlOptions, setMlOptions] = useState<{ id: string; value: string }[]>(
    [],
  );
  const [mlAccounts, setMlAccounts] = useState<
    Array<{ id: string; accountName?: string }>
  >([]);
  const [shopeeAccounts, setShopeeAccounts] = useState<
    Array<{ id: string; accountName?: string }>
  >([]);
  const [selectedMlAccounts, setSelectedMlAccounts] = useState<string[]>([]);
  const [selectedShopeeAccounts, setSelectedShopeeAccounts] = useState<
    string[]
  >([]);
  const [createMlListing, setCreateMlListing] = useState(false);
  const [createShopeeListing, setCreateShopeeListing] = useState(false);

  // ML listing settings (loaded from user defaults)
  const [mlListingType, setMlListingType] = useState("bronze");
  const [mlHasWarranty, setMlHasWarranty] = useState(false);
  const [mlWarrantyUnit, setMlWarrantyUnit] = useState("dias");
  const [mlWarrantyDuration, setMlWarrantyDuration] = useState(30);
  const [mlItemCondition, setMlItemCondition] = useState("new");
  const [mlShippingMode, setMlShippingMode] = useState("me2");
  const [mlFreeShipping, setMlFreeShipping] = useState(false);
  const [mlLocalPickup, setMlLocalPickup] = useState(false);
  const [mlManufacturingTime, setMlManufacturingTime] = useState(0);
  const [compatibilities, setCompatibilities] = useState<CompatibilityEntry[]>(
    [],
  );
  const [compatibilitiesLoading, setCompatibilitiesLoading] = useState(false);
  const [showCompatibilitySection, setShowCompatibilitySection] =
    useState(false);
  const [locationOptions, setLocationOptions] = useState<
    Array<{
      id: string;
      code: string;
      description?: string;
      fullPath: string;
      maxCapacity: number;
      productsCount: number;
      isFull: boolean;
    }>
  >([]);

  // Referências para valores originais do produto (para detectar edições do usuário)
  const originalNameRef = useRef(product.name);
  const originalBrandRef = useRef(product.brand || "");
  const originalModelRef = useRef(product.model || "");
  const originalYearRef = useRef(product.year || "");
  const originalCategoryRef = useRef(product.category || "");

  // Auto-detection ref to track previously auto-detected fields (so we don't overwrite manual edits)
  const autoDetectedRef = useRef<{
    brand?: string;
    model?: string;
    year?: string;
    category?: string;
    mlCategory?: string;
    // measurements auto-detected from category
    heightCm?: number;
    widthCm?: number;
    lengthCm?: number;
    weightKg?: number;
  } | null>(null);

  // Verificar se há campos de autopeças preenchidos
  const hasAutopartsData = !!(
    product.brand ||
    product.model ||
    product.year ||
    product.quality ||
    product.category ||
    product.sourceVehicle
  );

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    reset,
    control,
    watch,
    trigger,
  } = useForm<ProductEditFormData>({
    resolver: zodResolver(productEditSchema),
    defaultValues: {
      name: product.name,
      description: product.description || "",
      price: product.price,
      stock: product.stock,
      costPrice: product.costPrice || null,
      markup: product.markup || null,
      brand: product.brand || "",
      model: product.model || "",
      year: product.year || "",
      version: product.version || "",
      category: product.category || "",
      mlCategory: product.mlCategory || "",
      location: product.location || "",
      partNumber: product.partNumber || "",
      quality: product.quality || null,
      isSecurityItem: product.isSecurityItem || false,
      isTraceable: product.isTraceable || false,
      sourceVehicle: product.sourceVehicle || "",

      // Medidas (preenchidas se existirem)
      heightCm: product.heightCm ?? undefined,
      widthCm: product.widthCm ?? undefined,
      lengthCm: product.lengthCm ?? undefined,
      weightKg: product.weightKg ?? undefined,

      imageUrl: product.imageUrl || undefined,
    },
  });

  // Watch para campos automáticos
  const watchName = watch("name");
  const watchCostPrice = watch("costPrice");
  const watchPrice = watch("price");
  const watchCategory = watch("category");
  const watchMlCategory = watch("mlCategory");
  const watchDescription = watch("description") || "";

  // Ao habilitar a criaÃ§Ã£o de anÃºncio, selecionar automaticamente todas as contas disponÃ­veis
  useEffect(() => {
    if (!createMlListing) return;
    if (mlAccounts.length === 0) return;
    setSelectedMlAccounts((prev) => {
      const allIds = mlAccounts.map((acc) => acc.id);
      const hasAll =
        prev.length === allIds.length &&
        allIds.every((id) => prev.includes(id));
      return hasAll ? prev : allIds;
    });
  }, [createMlListing, mlAccounts]);

  useEffect(() => {
    if (!createShopeeListing) return;
    if (shopeeAccounts.length === 0) return;
    setSelectedShopeeAccounts((prev) => {
      const allIds = shopeeAccounts.map((acc) => acc.id);
      const hasAll =
        prev.length === allIds.length &&
        allIds.every((id) => prev.includes(id));
      return hasAll ? prev : allIds;
    });
  }, [createShopeeListing, shopeeAccounts]);

  // Busca descrição padrão do usuário (para pré‑preencher quando produto não tiver descrição)
  // e padrões de anúncio ML
  const fetchDefaultDescription = useCallback(async () => {
    try {
      if (session?.user?.email) {
        const resp = await fetch(`${getApiBaseUrl()}/users/me`, {
          headers: { email: session.user.email },
        });
        if (resp.ok) {
          const user = await resp.json();
          const desc = user.defaultProductDescription || "";
          setDefaultDescription(desc);
          if (!product.description && desc) setValue("description", desc);

          // Carregar padrões de anúncio ML
          if (user.defaultListingType)
            setMlListingType(user.defaultListingType);
          if (
            user.defaultHasWarranty !== undefined &&
            user.defaultHasWarranty !== null
          )
            setMlHasWarranty(user.defaultHasWarranty);
          if (user.defaultWarrantyUnit)
            setMlWarrantyUnit(user.defaultWarrantyUnit);
          if (
            user.defaultWarrantyDuration !== undefined &&
            user.defaultWarrantyDuration !== null
          )
            setMlWarrantyDuration(user.defaultWarrantyDuration);
          if (user.defaultItemCondition)
            setMlItemCondition(user.defaultItemCondition);
          if (user.defaultShippingMode)
            setMlShippingMode(user.defaultShippingMode);
          if (
            user.defaultFreeShipping !== undefined &&
            user.defaultFreeShipping !== null
          )
            setMlFreeShipping(user.defaultFreeShipping);
          if (
            user.defaultLocalPickup !== undefined &&
            user.defaultLocalPickup !== null
          )
            setMlLocalPickup(user.defaultLocalPickup);
          if (
            user.defaultManufacturingTime !== undefined &&
            user.defaultManufacturingTime !== null
          )
            setMlManufacturingTime(user.defaultManufacturingTime);
        }
      }
    } catch (err) {
      console.error("Erro ao buscar descrição padrão (edit dialog):", err);
    }
  }, [product.description, session?.user?.email, setValue]);

  useEffect(() => {
    if (open) {
      // Reset previous auto-detection when opening dialog so it's recalculated
      autoDetectedRef.current = null;

      // Atualizar refs com valores originais do produto
      originalNameRef.current = product.name;
      originalBrandRef.current = product.brand || "";
      originalModelRef.current = product.model || "";
      originalYearRef.current = product.year || "";
      originalCategoryRef.current = product.category || "";

      reset({
        name: product.name,
        description: product.description || "",
        price: product.price,
        stock: product.stock,
        costPrice: product.costPrice || null,
        markup: product.markup || null,
        brand: product.brand || "",
        model: product.model || "",
        year: product.year || "",
        version: product.version || "",
        category: product.category || "",
        mlCategory: product.mlCategory || "",
        location: product.location || "",
        locationId: product.locationId || null,
        partNumber: product.partNumber || "",
        quality: product.quality || null,
        isSecurityItem: product.isSecurityItem || false,
        isTraceable: product.isTraceable || false,
        sourceVehicle: product.sourceVehicle || "",

        // Medidas
        heightCm: product.heightCm ?? undefined,
        widthCm: product.widthCm ?? undefined,
        lengthCm: product.lengthCm ?? undefined,
        weightKg: product.weightKg ?? undefined,
        imageUrl: product.imageUrl || undefined,
      });
      // Abrir seção de autopeças se houver dados
      setShowAutopartsSection(hasAutopartsData);
      setCreateMlListing(false);
      setCreateShopeeListing(false);
      setSelectedMlAccounts([]);
      setSelectedShopeeAccounts([]);

      // Buscar categorias ML quando abrir o diálogo
      (async () => {
        try {
          const base = getApiBaseUrl();
          const resp = await fetch(`${base}/marketplace/ml/categories`, {
            headers: { email: session?.user?.email || "" },
          });
          if (resp.ok) {
            const json = await resp.json();
            setMlOptions(json.categories || []);
          }
        } catch (err) {
          console.error("Erro ao buscar categorias ML:", err);
        }
      })();

      // Buscar localizações para o seletor
      (async () => {
        try {
          const base = getApiBaseUrl();
          const respLoc = await fetch(`${base}/locations/select`, {
            headers: { email: session?.user?.email || "" },
          });
          if (respLoc.ok) {
            const locJson = await respLoc.json();
            setLocationOptions(
              Array.isArray(locJson.locations) ? locJson.locations : [],
            );
          }
        } catch (err) {
          console.error("Erro ao buscar localizações:", err);
        }
      })();

      // buscar descrição padrão do usuário (se necessário)
      void fetchDefaultDescription();

      // Buscar contas ML / Shopee para seleção de multi-contas
      (async () => {
        if (!session?.user?.email) return;
        try {
          const headers = { email: session.user.email };
          const base = getApiBaseUrl();
          const [mlResp, shResp] = await Promise.all([
            fetch(`${base}/marketplace/ml/accounts`, { headers }),
            fetch(`${base}/marketplace/shopee/accounts`, { headers }),
          ]);
          if (mlResp.ok) {
            const json = await mlResp.json();
            setMlAccounts(Array.isArray(json.accounts) ? json.accounts : []);
          }
          if (shResp.ok) {
            const json = await shResp.json();
            setShopeeAccounts(
              Array.isArray(json.accounts) ? json.accounts : [],
            );
          }
        } catch (err) {
          console.error("Erro ao buscar contas de marketplace:", err);
        }
      })();

      // Buscar compatibilidades existentes do produto
      (async () => {
        if (!session?.user?.email || !product.id) return;
        setCompatibilitiesLoading(true);
        try {
          const base = getApiBaseUrl();
          const resp = await fetch(
            `${base}/products/${product.id}/compatibilities`,
            { headers: { email: session.user.email } },
          );
          if (resp.ok) {
            const json = await resp.json();
            const items: CompatibilityEntry[] = (
              json.compatibilities || []
            ).map(
              (c: {
                id: string;
                brand: string;
                model: string;
                yearFrom?: number | null;
                yearTo?: number | null;
                version?: string | null;
              }) => ({
                _localId: c.id,
                brand: c.brand,
                model: c.model,
                yearFrom: c.yearFrom ?? undefined,
                yearTo: c.yearTo ?? undefined,
                version: c.version ?? undefined,
              }),
            );
            setCompatibilities(items);
            setShowCompatibilitySection(items.length > 0);
          }
        } catch (err) {
          console.error("Erro ao buscar compatibilidades:", err);
        } finally {
          setCompatibilitiesLoading(false);
        }
      })();
    }
  }, [
    open,
    product,
    reset,
    hasAutopartsData,
    session?.user?.email,
    session?.user?.id,
    fetchDefaultDescription,
  ]);

  // Aplicar descrição padrão quando carregada (se produto não tiver descrição)
  useEffect(() => {
    if (defaultDescription && !product.description) {
      setValue("description", defaultDescription);
    }
  }, [defaultDescription, product.description, setValue]);

  // Cálculo automático da margem
  useEffect(() => {
    if (watchCostPrice && watchPrice && watchCostPrice > 0) {
      const markup = ((watchPrice - watchCostPrice) / watchCostPrice) * 100;
      setValue("markup", Math.round(markup * 100) / 100);
    }
  }, [watchCostPrice, watchPrice, setValue]);

  // Debounced auto-fill for edit dialog as well
  // Only run when dialog is open to avoid racing with `reset()` that sets
  // original refs on open.
  const editAutoFillTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!open) return;

    const nameChanged = watchName !== originalNameRef.current;
    if (!watchName || !nameChanged) return;

    if (editAutoFillTimer.current) clearTimeout(editAutoFillTimer.current);
    editAutoFillTimer.current = window.setTimeout(() => {
      const detected = parseTitleToFields(watchName);

      // Prefer dynamic ML categories first
      let mapping: {
        topLevel?: string;
        detailedId?: string;
        detailedValue?: string;
      } = {};
      const tl = watchName.toLowerCase();
      const byFull = mlOptions.find((c) => tl.includes(c.value.toLowerCase()));
      if (byFull)
        mapping = {
          topLevel: byFull.value.split(" > ")[0].trim(),
          detailedId: byFull.id,
          detailedValue: byFull.value,
        };
      else {
        const byLast = mlOptions.find((c) => {
          const last = c.value.split(" > ").slice(-1)[0].toLowerCase();
          return tl.includes(last);
        });
        if (byLast)
          mapping = {
            topLevel: byLast.value.split(" > ")[0].trim(),
            detailedId: byLast.id,
            detailedValue: byLast.value,
          };
      }

      if (!mapping.detailedId) {
        const suggested = suggestCategoryFromTitle(watchName);
        const suggestedForMapping = detected.category || suggested || undefined;
        if (suggestedForMapping)
          mapping = mapSuggestedCategory(suggestedForMapping);
      }

      const norm = (s?: string) => (s || "").toString().trim().toLowerCase();
      const prev = autoDetectedRef.current || ({} as any);

      // brand
      const currentBrand = watch("brand");
      const shouldUpdateBrand =
        !currentBrand ||
        norm(prev.brand) === norm(currentBrand) ||
        currentBrand === originalBrandRef.current;
      if (
        typeof window !== "undefined" &&
        window.location.hostname === "localhost"
      ) {
        console.debug("[auto-fill][edit] decision brand", {
          shouldUpdateBrand,
          currentBrand,
          prevBrand: prev.brand,
          detectedBrand: detected.brand,
          inputMounted: !!document.getElementById("edit-brand"),
          inputDom: (
            document.getElementById("edit-brand") as HTMLInputElement | null
          )?.value,
        });
      }
      if (shouldUpdateBrand) {
        if (detected.brand) {
          setValue("brand", detected.brand, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
          if (
            typeof window !== "undefined" &&
            window.location.hostname === "localhost"
          ) {
            setTimeout(() => {
              console.debug("[auto-fill][edit] post-set brand", watch("brand"));
              console.debug(
                "[auto-fill][edit] dom brand after set",
                (
                  document.getElementById(
                    "edit-brand",
                  ) as HTMLInputElement | null
                )?.value,
              );
            }, 50);
          }
        } else if (!currentBrand) {
          setValue("brand", "", {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
          if (
            typeof window !== "undefined" &&
            window.location.hostname === "localhost"
          ) {
            setTimeout(() => {
              console.debug(
                "[auto-fill][edit] post-clear brand",
                watch("brand"),
              );
              console.debug(
                "[auto-fill][edit] dom brand after clear",
                (
                  document.getElementById(
                    "edit-brand",
                  ) as HTMLInputElement | null
                )?.value,
              );
            }, 50);
          }
        }
      }

      // model
      const currentModel = watch("model");
      const shouldUpdateModel =
        !currentModel ||
        norm(prev.model) === norm(currentModel) ||
        currentModel === originalModelRef.current;
      if (
        typeof window !== "undefined" &&
        window.location.hostname === "localhost"
      ) {
        console.debug("[auto-fill][edit] decision model", {
          shouldUpdateModel,
          currentModel,
          prevModel: prev.model,
          detectedModel: detected.model,
          inputMounted: !!document.getElementById("edit-model"),
          inputDom: (
            document.getElementById("edit-model") as HTMLInputElement | null
          )?.value,
        });
      }
      if (shouldUpdateModel) {
        if (detected.model) {
          setValue("model", detected.model, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
          if (
            typeof window !== "undefined" &&
            window.location.hostname === "localhost"
          ) {
            setTimeout(() => {
              console.debug("[auto-fill][edit] post-set model", watch("model"));
              console.debug(
                "[auto-fill][edit] dom model after set",
                (
                  document.getElementById(
                    "edit-model",
                  ) as HTMLInputElement | null
                )?.value,
              );
            }, 50);
          }
        } else if (!currentModel) {
          setValue("model", "", {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
          if (
            typeof window !== "undefined" &&
            window.location.hostname === "localhost"
          ) {
            setTimeout(() => {
              console.debug(
                "[auto-fill][edit] post-clear model",
                watch("model"),
              );
              console.debug(
                "[auto-fill][edit] dom model after clear",
                (
                  document.getElementById(
                    "edit-model",
                  ) as HTMLInputElement | null
                )?.value,
              );
            }, 50);
          }
        }
      }

      // year
      const currentYear = watch("year");
      const shouldUpdateYear =
        !currentYear ||
        norm(prev.year) === norm(currentYear) ||
        currentYear === originalYearRef.current;
      if (
        typeof window !== "undefined" &&
        window.location.hostname === "localhost"
      ) {
        console.debug("[auto-fill][edit] decision year", {
          shouldUpdateYear,
          currentYear,
          prevYear: prev.year,
          detectedYear: detected.year,
          inputMounted: !!document.getElementById("edit-year"),
          inputDom: (
            document.getElementById("edit-year") as HTMLInputElement | null
          )?.value,
        });
      }
      if (shouldUpdateYear) {
        if (detected.year) {
          setValue("year", detected.year, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
          if (
            typeof window !== "undefined" &&
            window.location.hostname === "localhost"
          ) {
            setTimeout(() => {
              console.debug("[auto-fill][edit] post-set year", watch("year"));
              console.debug(
                "[auto-fill][edit] dom year after set",
                (
                  document.getElementById(
                    "edit-year",
                  ) as HTMLInputElement | null
                )?.value,
              );
            }, 50);
          }
        } else if (!currentYear) {
          setValue("year", "", {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
          if (
            typeof window !== "undefined" &&
            window.location.hostname === "localhost"
          ) {
            setTimeout(() => {
              console.debug("[auto-fill][edit] post-clear year", watch("year"));
              console.debug(
                "[auto-fill][edit] dom year after clear",
                (
                  document.getElementById(
                    "edit-year",
                  ) as HTMLInputElement | null
                )?.value,
              );
            }, 50);
          }
        }
      }

      // ensure Controller inputs reflect changes
      void trigger(["brand", "model", "year"]);

      // category (allow overwrite when field is unchanged from original product)
      const currentCategory = watch("category");
      const currentMlCategory = watch("mlCategory");
      const shouldUpdateCategory =
        !currentCategory ||
        norm(prev.category) === norm(currentCategory) ||
        currentCategory === originalCategoryRef.current;

      if (shouldUpdateCategory) {
        if (mapping.topLevel) {
          setValue("category", mapping.topLevel, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
        } else if (detected.category) {
          setValue("category", detected.category, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
        }

        // mlCategory: follow same policy as create dialog (set/clear only when user didn't manually edit)
        const prevMl = prev.mlCategory;
        const isPrevAutoMl =
          prevMl && norm(prevMl) === norm(currentMlCategory || "");

        if (mapping.detailedId) {
          // try to resolve internal detailed id to an external id from mlOptions
          const externalFromMlOptions = mlOptions.find(
            (c) => c.value === mapping.detailedValue,
          )?.id;

          // Only allow internal mapping.detailedId when we have NO synced mlOptions;
          // otherwise prefer externalFromMlOptions or clear field to avoid auto-sending internal ids.
          const resolvedMlCategory =
            externalFromMlOptions ??
            (mlOptions && mlOptions.length === 0 ? mapping.detailedId : "");

          if (!currentMlCategory || isPrevAutoMl) {
            if (resolvedMlCategory) {
              setValue("mlCategory", resolvedMlCategory, {
                shouldDirty: true,
                shouldTouch: true,
                shouldValidate: true,
              });
            } else {
              setValue("mlCategory", "", {
                shouldDirty: true,
                shouldTouch: true,
                shouldValidate: true,
              });
            }
          }
        } else {
          if (isPrevAutoMl && currentMlCategory) {
            setValue("mlCategory", "", {
              shouldDirty: true,
              shouldTouch: true,
              shouldValidate: true,
            });
          }
        }

        // ensure select controllers update
        void trigger(["category", "mlCategory"]);
      }

      // Measurements: try to auto-fill from category when available
      try {
        const measurements = getMeasurementsForCategory(
          mapping.topLevel || detected.category,
          mapping.detailedValue,
        );

        // height
        const currentHeight = watch("heightCm");
        const prevHeight = prev.heightCm;
        const shouldUpdateHeight =
          currentHeight === null ||
          currentHeight === undefined ||
          prevHeight === currentHeight;
        if (shouldUpdateHeight) {
          if (measurements?.heightCm !== undefined) {
            setValue("heightCm", measurements.heightCm, {
              shouldDirty: true,
              shouldTouch: true,
              shouldValidate: true,
            });
            if (
              typeof window !== "undefined" &&
              window.location.hostname === "localhost"
            )
              console.debug(
                "[auto-fill][edit] post-set heightCm",
                watch("heightCm"),
              );
          }
        }

        // width
        const currentWidth = watch("widthCm");
        const prevWidth = prev.widthCm;
        const shouldUpdateWidth =
          currentWidth === null ||
          currentWidth === undefined ||
          prevWidth === currentWidth;
        if (shouldUpdateWidth) {
          if (measurements?.widthCm !== undefined) {
            setValue("widthCm", measurements.widthCm, {
              shouldDirty: true,
              shouldTouch: true,
              shouldValidate: true,
            });
            if (
              typeof window !== "undefined" &&
              window.location.hostname === "localhost"
            )
              console.debug(
                "[auto-fill][edit] post-set widthCm",
                watch("widthCm"),
              );
          }
        }

        // length
        const currentLength = watch("lengthCm");
        const prevLength = prev.lengthCm;
        const shouldUpdateLength =
          currentLength === null ||
          currentLength === undefined ||
          prevLength === currentLength;
        if (shouldUpdateLength) {
          if (measurements?.lengthCm !== undefined) {
            setValue("lengthCm", measurements.lengthCm, {
              shouldDirty: true,
              shouldTouch: true,
              shouldValidate: true,
            });
            if (
              typeof window !== "undefined" &&
              window.location.hostname === "localhost"
            )
              console.debug(
                "[auto-fill][edit] post-set lengthCm",
                watch("lengthCm"),
              );
          }
        }

        // weight
        const currentWeight = watch("weightKg");
        const prevWeight = prev.weightKg;
        const shouldUpdateWeight =
          currentWeight === null ||
          currentWeight === undefined ||
          prevWeight === currentWeight;
        if (shouldUpdateWeight) {
          if (measurements?.weightKg !== undefined) {
            setValue("weightKg", measurements.weightKg, {
              shouldDirty: true,
              shouldTouch: true,
              shouldValidate: true,
            });
            if (
              typeof window !== "undefined" &&
              window.location.hostname === "localhost"
            )
              console.debug(
                "[auto-fill][edit] post-set weightKg",
                watch("weightKg"),
              );
          }
        }

        // trigger validation/render for measurements (ensure Controllers update)
        void trigger(["heightCm", "widthCm", "lengthCm", "weightKg"]);
      } catch (err) {
        /* ignore measurement lookup errors */
      }

      // store detected (merge — preserve previously-detected values when parser returns undefined)
      autoDetectedRef.current = {
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
        // preserve measurement-derived autos
        heightCm:
          getMeasurementsForCategory(
            mapping.topLevel || detected.category,
            mapping.detailedValue,
          )?.heightCm ?? autoDetectedRef.current?.heightCm,
        widthCm:
          getMeasurementsForCategory(
            mapping.topLevel || detected.category,
            mapping.detailedValue,
          )?.widthCm ?? autoDetectedRef.current?.widthCm,
        lengthCm:
          getMeasurementsForCategory(
            mapping.topLevel || detected.category,
            mapping.detailedValue,
          )?.lengthCm ?? autoDetectedRef.current?.lengthCm,
        weightKg:
          getMeasurementsForCategory(
            mapping.topLevel || detected.category,
            mapping.detailedValue,
          )?.weightKg ?? autoDetectedRef.current?.weightKg,
      };
    }, 300);

    return () => {
      if (editAutoFillTimer.current) clearTimeout(editAutoFillTimer.current);
    };
  }, [watchName, setValue, mlOptions, trigger, watch, open]);

  // When category (top-level or mlCategory) changes, update measurements accordingly (same logic as create dialog).
  useEffect(() => {
    const category = watchCategory || undefined;
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
  }, [watchCategory, watchMlCategory, mlOptions, setValue, watch, trigger]);

  const onSubmit = async (data: ProductEditFormData) => {
    setIsSubmitting(true);
    try {
      if (createMlListing && selectedMlAccounts.length === 0) {
        onToast(
          "Selecione ao menos uma conta do Mercado Livre para criar o anúncio.",
          "error",
        );
        setIsSubmitting(false);
        return;
      }
      if (
        createMlListing &&
        !(data.mlCategory || autoDetectedRef.current?.mlCategory)
      ) {
        onToast(
          "Selecione uma categoria do Mercado Livre antes de criar o anúncio.",
          "error",
        );
        setIsSubmitting(false);
        return;
      }

      // Categoria não obrigatória no frontend; o backend resolve/normaliza.

      if (createShopeeListing && selectedShopeeAccounts.length === 0) {
        onToast(
          "Selecione ao menos uma conta do Shopee para criar o anúncio.",
          "error",
        );
        setIsSubmitting(false);
        return;
      }

      const mlCategorySourceToSend = data.mlCategory
        ? autoDetectedRef.current?.mlCategory === data.mlCategory
          ? "auto"
          : "manual"
        : autoDetectedRef.current?.mlCategory
          ? "auto"
          : undefined;

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
        locationId: data.locationId || undefined,
        partNumber: data.partNumber || undefined,
        quality: data.quality || undefined,
        sourceVehicle: data.sourceVehicle || undefined,

        // Medidas
        heightCm: data.heightCm ?? undefined,
        widthCm: data.widthCm ?? undefined,
        lengthCm: data.lengthCm ?? undefined,
        weightKg: data.weightKg ?? undefined,

        imageUrl: data.imageUrl || undefined,
        mlCategorySource: mlCategorySourceToSend,
        mlCategory: data.mlCategory || autoDetectedRef.current?.mlCategory,
      };

      const fetchWithTimeout = async (
        input: RequestInfo | URL,
        init: RequestInit = {},
        timeoutMs = 15000,
      ) => {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await fetch(input, { ...init, signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
      };

      const response = await fetch(
        `${getApiBaseUrl()}/products/${product.id}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            email: session?.user?.email || "",
          },
          body: JSON.stringify(cleanData),
        },
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Erro ao atualizar produto");
      }

      // Salvar compatibilidades (PUT substitui todas)
      try {
        await fetch(
          `${getApiBaseUrl()}/products/${product.id}/compatibilities`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              email: session?.user?.email || "",
            },
            body: JSON.stringify({
              items: compatibilities.map((c) => ({
                brand: c.brand,
                model: c.model,
                yearFrom: c.yearFrom || undefined,
                yearTo: c.yearTo || undefined,
                version: c.version || undefined,
              })),
            }),
          },
        );
      } catch (err) {
        console.error("Erro ao salvar compatibilidades:", err);
      }

      const base = getApiBaseUrl();
      const listingResults: string[] = [];

      if (createMlListing && selectedMlAccounts.length > 0) {
        const mlResponses = await Promise.all(
          selectedMlAccounts.map(async (accountId) => {
            const url = new URL(`${base}/listings/ml`);
            url.searchParams.set("accountId", accountId);
            let resp: Response | null = null;
            let body: any = {};
            try {
              resp = await fetchWithTimeout(
                url.toString(),
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    email: session?.user?.email || "",
                  },
                  body: JSON.stringify({
                    productId: product.id,
                    categoryId: data.mlCategory || undefined,
                    listingType: mlListingType,
                    hasWarranty: mlHasWarranty,
                    warrantyUnit: mlWarrantyUnit,
                    warrantyDuration: mlWarrantyDuration,
                    itemCondition: mlItemCondition,
                    shippingMode: mlShippingMode,
                    freeShipping: mlFreeShipping,
                    localPickup: mlLocalPickup,
                    manufacturingTime: mlManufacturingTime,
                  }),
                },
                15000,
              );
              body = await resp.json().catch(() => ({}));
            } catch (err) {
              return {
                accountId,
                ok: false,
                message:
                  (err as any)?.name === "AbortError"
                    ? "Requisição expirou (timeout)"
                    : (err as Error).message || "Erro ao criar anúncio",
              };
            }
            return {
              accountId,
              ok: resp?.ok ?? false,
              message: body.message || body.error || "",
            };
          }),
        );

        const ok = mlResponses.filter((r) => r.ok).length;
        const failed = mlResponses.length - ok;
        listingResults.push(
          `ML: ${ok} criado(s)${failed ? `, ${failed} falhou(falharam)` : ""}`,
        );
        if (failed > 0) {
          onToast(
            "Alguns anúncios ML não foram criados. Veja detalhes na aba Anúncios.",
            "error",
          );
        }
      }

      if (createShopeeListing && selectedShopeeAccounts.length > 0) {
        const shResponses = await Promise.all(
          selectedShopeeAccounts.map(async (accountId) => {
            const url = new URL(`${base}/listings/shopee`);
            url.searchParams.set("accountId", accountId);
            const resp = await fetch(url.toString(), {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                email: session?.user?.email || "",
              },
              body: JSON.stringify({ productId: product.id }),
            });
            const body = await resp.json().catch(() => ({}));
            return {
              accountId,
              ok: resp.ok,
              message: body.message || body.error || "",
            };
          }),
        );

        const ok = shResponses.filter((r) => r.ok).length;
        const failed = shResponses.length - ok;
        listingResults.push(
          `Shopee: ${ok} criado(s)${failed ? `, ${failed} falhou(falharam)` : ""}`,
        );
        if (failed > 0) {
          onToast(
            "Alguns anúncios Shopee não foram criados. Confira a aba Anúncios.",
            "error",
          );
        }
      }

      onToast(
        listingResults.length > 0
          ? `Produto atualizado. ${listingResults.join(" | ")}`
          : "Produto atualizado com sucesso!",
        "success",
      );
      onProductUpdated();
      onOpenChange(false);
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : "Erro ao atualizar produto",
        "error",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-150">
        <DialogHeader>
          <DialogTitle>Editar Produto</DialogTitle>
          <DialogDescription>
            Atualize os dados do produto &quot;{product.name}&quot;
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Seção: Dados Básicos */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground">
              Dados Básicos
            </h3>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-sku">SKU</Label>
                <Input
                  id="edit-sku"
                  value={product.sku}
                  disabled
                  className="bg-muted"
                />
                <p className="text-xs text-muted-foreground">
                  SKU não pode ser alterado
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-partNumber">Part Number</Label>
                <Input
                  id="edit-partNumber"
                  placeholder="OEM / Código original"
                  {...register("partNumber")}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-name">Nome *</Label>
              <Input
                id="edit-name"
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
              <Label htmlFor="edit-description">Descrição (automática)</Label>
              <Textarea
                id="edit-description"
                placeholder="Descrição do produto"
                {...register("description")}
                className="min-h-20 resize-none"
                maxLength={4000}
              />
              <div className="flex items-start justify-between text-xs text-muted-foreground">
                <span className="pr-3">
                  Atualizada ao editar nome ou part number
                </span>
                <span>{watchDescription.length}/4000</span>
              </div>
              {errors.description && (
                <p className="text-sm text-destructive">
                  {errors.description.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Foto do Produto</Label>
              <Controller
                name="imageUrl"
                control={control}
                render={({ field }) => (
                  <ImageUpload
                    value={field.value || undefined}
                    onChange={field.onChange}
                    onError={(error: string) => {
                      console.error("Erro no upload:", error);
                      // You might want to show a toast here
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
                Faça upload de uma nova foto ou mantenha a atual. Máximo 5MB,
                formatos: JPG, PNG, WebP.
              </p>
            </div>
          </div>

          {/* Seção: Preços e Estoque */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground">
              Preços e Estoque
            </h3>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-costPrice">Preço de Custo</Label>
                <Controller
                  name="costPrice"
                  control={control}
                  render={({ field }) => (
                    <CurrencyInput
                      id="edit-costPrice"
                      placeholder="0,00"
                      value={field.value}
                      onChange={field.onChange}
                    />
                  )}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-price">Preço de Venda *</Label>
                <Controller
                  name="price"
                  control={control}
                  render={({ field }) => (
                    <CurrencyInput
                      id="edit-price"
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
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-markup">Margem (%) - calculada</Label>
                <Controller
                  name="markup"
                  control={control}
                  render={({ field }) => (
                    <Input
                      id="edit-markup"
                      value={
                        field.value !== null && field.value !== undefined
                          ? `${field.value.toFixed(2)}%`
                          : ""
                      }
                      placeholder="Informe custo e venda"
                      disabled
                      className="bg-muted"
                    />
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  = (Venda - Custo) / Custo × 100
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-stock">Estoque *</Label>
                <Input
                  id="edit-stock"
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
          </div>

          {/* Seção: Dados de Autopeças (Colapsável) */}
          <Collapsible
            open={showAutopartsSection}
            onOpenChange={setShowAutopartsSection}
          >
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="flex w-full justify-between p-0 hover:bg-transparent"
              >
                <span className="text-sm font-medium text-muted-foreground">
                  Dados do Veículo e Peça
                </span>
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${
                    showAutopartsSection ? "rotate-180" : ""
                  }`}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-quality">Qualidade</Label>
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
                  <Label htmlFor="edit-brand">Marca</Label>
                  <Controller
                    name="brand"
                    control={control}
                    render={({ field }) => (
                      <Input
                        id="edit-brand"
                        placeholder="Ex: Bosch, Denso"
                        {...field}
                        value={field.value ?? ""}
                      />
                    )}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-model">Modelo</Label>
                  <Controller
                    name="model"
                    control={control}
                    render={({ field }) => (
                      <Input
                        id="edit-model"
                        placeholder="Ex: Civic, Corolla"
                        {...field}
                        value={field.value ?? ""}
                      />
                    )}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-year">Ano</Label>
                  <Controller
                    name="year"
                    control={control}
                    render={({ field }) => (
                      <Input
                        id="edit-year"
                        placeholder="Ex: 2018-2022"
                        {...field}
                        value={field.value ?? ""}
                      />
                    )}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-version">Versão</Label>
                  <Input
                    id="edit-version"
                    placeholder="Ex: EXL, LX"
                    {...register("version")}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-category">
                    Categoria ML (automática)
                  </Label>
                  <Controller
                    name="category"
                    control={control}
                    render={({ field }) => {
                      // Prefer mlOptions fullPath when available. When multiple mlOptions
                      // share the same top-level, pick the most specific (longest) path.
                      const mlById = mlOptions.find(
                        (c) => c.id === watch("mlCategory"),
                      )?.value;

                      const mlByFull = mlOptions.find(
                        (c) => c.value === watch("category"),
                      )?.value;

                      const staticById = ML_CATEGORY_OPTIONS.find(
                        (c) => c.id === watch("mlCategory"),
                      )?.value;
                      const staticByFull = ML_CATEGORY_OPTIONS.find(
                        (c) => c.value === watch("category"),
                      )?.value;

                      const detailed =
                        mlById || mlByFull || staticById || staticByFull;

                      return (
                        <Select
                          onValueChange={(val) => {
                            field.onChange(val);
                            const match =
                              mlOptions.find((c) => c.value === val) ||
                              ML_CATEGORY_OPTIONS.find((c) => c.value === val);
                            setValue("mlCategory", match?.id || "");
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
                              <SelectItem
                                key={`${cat.id}-${cat.value}`}
                                value={cat.value}
                              >
                                {cat.value}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      );
                    }}
                  />

                  <div className="mt-2">
                    <Label>Categoría no Mercado Livre (opcional)</Label>
                    <Controller
                      name="mlCategory"
                      control={control}
                      render={({ field }) => {
                        const optionsSource =
                          mlOptions && mlOptions.length > 0
                            ? mlOptions
                            : ML_CATEGORY_OPTIONS.map((c) => ({
                                id: c.id,
                                value: c.value,
                              }));

                        // Pick selectedId: prefer explicit field value, otherwise match fullPath in category
                        const candidateByFull = optionsSource.find(
                          (o) => o.value === watch("category"),
                        );
                        const selectedId =
                          field.value || candidateByFull?.id || "";

                        const selectedLabel =
                          optionsSource.find((o) => o.id === field.value)
                            ?.value ||
                          candidateByFull?.value ||
                          ML_CATEGORY_OPTIONS.find(
                            (c) => c.value === watch("category"),
                          )?.value ||
                          watch("category") ||
                          undefined;

                        return (
                          <Select
                            onValueChange={(val) => {
                              field.onChange(val);
                              const sel = optionsSource.find(
                                (o) => o.id === val,
                              );
                              if (sel?.value) {
                                setValue("category", sel.value);
                              }
                            }}
                            value={selectedId}
                          >
                            <SelectTrigger>
                              <SelectValue>
                                {selectedLabel ||
                                  "Selecione uma subcategoria ML (opcional)"}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {optionsSource.map((cat) => (
                                <SelectItem
                                  key={`${cat.id}-${cat.value}`}
                                  value={cat.id}
                                >
                                  {cat.value.split(" > ").slice(-1)[0]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        );
                      }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Sugerida ao editar nome
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-location">Localização</Label>
                  {locationOptions.length > 0 ? (
                    <Controller
                      name="locationId"
                      control={control}
                      render={({ field }) => (
                        <Select
                          onValueChange={(value) => {
                            field.onChange(value === "__none__" ? null : value);
                            const selected = locationOptions.find(
                              (l) => l.id === value,
                            );
                            setValue("location", selected?.fullPath || "");
                          }}
                          value={field.value ?? "__none__"}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Selecione uma localização" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">Nenhuma</SelectItem>
                            {locationOptions.map((loc) => (
                              <SelectItem
                                key={loc.id}
                                value={loc.id}
                                disabled={loc.isFull && loc.id !== field.value}
                              >
                                {loc.fullPath}
                                {loc.maxCapacity > 0
                                  ? ` (${loc.productsCount}/${loc.maxCapacity})`
                                  : ""}
                                {loc.isFull && loc.id !== field.value
                                  ? " — Lotado"
                                  : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  ) : (
                    <Input
                      id="edit-location"
                      placeholder="Ex: Prateleira A1"
                      {...register("location")}
                    />
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-sourceVehicle">Veículo de Origem</Label>
                <Input
                  id="edit-sourceVehicle"
                  placeholder="Ex: Honda Civic 2020 - Placa ABC1234"
                  {...register("sourceVehicle")}
                />
                <p className="text-xs text-muted-foreground">
                  Para peças de sucata, informe o veículo de origem
                </p>
              </div>

              {/* Medidas (cm / kg) */}
              <div className="mt-2 grid grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-heightCm">Altura (cm)</Label>
                  <Controller
                    name="heightCm"
                    control={control}
                    render={({ field }) => (
                      <Input
                        id="edit-heightCm"
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
                    )}
                  />
                  {errors.heightCm && (
                    <p className="text-sm text-destructive">
                      {errors.heightCm.message}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-widthCm">Largura (cm)</Label>
                  <Controller
                    name="widthCm"
                    control={control}
                    render={({ field }) => (
                      <Input
                        id="edit-widthCm"
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
                    )}
                  />
                  {errors.widthCm && (
                    <p className="text-sm text-destructive">
                      {errors.widthCm.message}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-lengthCm">Comprimento (cm)</Label>
                  <Controller
                    name="lengthCm"
                    control={control}
                    render={({ field }) => (
                      <Input
                        id="edit-lengthCm"
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
                    )}
                  />
                  {errors.lengthCm && (
                    <p className="text-sm text-destructive">
                      {errors.lengthCm.message}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-weightKg">Peso (kg)</Label>
                  <Controller
                    name="weightKg"
                    control={control}
                    render={({ field }) => (
                      <Input
                        id="edit-weightKg"
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
                    )}
                  />
                  {errors.weightKg && (
                    <p className="text-sm text-destructive">
                      {errors.weightKg.message}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap gap-6 pt-2">
                <div className="flex items-center gap-2">
                  <Controller
                    name="isSecurityItem"
                    control={control}
                    render={({ field }) => (
                      <Switch
                        id="edit-isSecurityItem"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                  <Label
                    htmlFor="edit-isSecurityItem"
                    className="cursor-pointer"
                  >
                    Item de Segurança
                  </Label>
                </div>

                <div className="flex items-center gap-2">
                  <Controller
                    name="isTraceable"
                    control={control}
                    render={({ field }) => (
                      <Switch
                        id="edit-isTraceable"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                  <Label htmlFor="edit-isTraceable" className="cursor-pointer">
                    Item Rastreável
                  </Label>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Seção: Compatibilidade de Veículos (Colapsável) */}
          <Collapsible
            open={showCompatibilitySection}
            onOpenChange={setShowCompatibilitySection}
          >
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="flex w-full justify-between p-0 hover:bg-transparent"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Link2 className="size-4" />
                  Compatibilidade de Veículos
                  {compatibilities.length > 0 && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                      {compatibilities.length}
                    </span>
                  )}
                </span>
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${
                    showCompatibilitySection ? "rotate-180" : ""
                  }`}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-4">
              {compatibilitiesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-sm text-muted-foreground">
                    Carregando compatibilidades...
                  </span>
                </div>
              ) : (
                <CompatibilityTab
                  value={compatibilities}
                  onChange={setCompatibilities}
                />
              )}
            </CollapsibleContent>
          </Collapsible>

          {/* PublicaÃ§Ã£o de anÃºncios multi-contas */}
          <div className="space-y-4 rounded-lg border p-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Publicar anúncios</p>
              <p className="text-xs text-muted-foreground">
                Crie anúncios nas contas selecionadas (Mercado Livre e Shopee).
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Switch
                  id="edit-create-ml-listing"
                  checked={createMlListing}
                  onCheckedChange={setCreateMlListing}
                />
                <Label
                  htmlFor="edit-create-ml-listing"
                  className="cursor-pointer"
                >
                  Criar anúncio no Mercado Livre
                </Label>
                <span className="text-xs text-muted-foreground">
                  Usa a categoria ML selecionada acima (se informada).
                </span>
              </div>
              {createMlListing && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {mlAccounts.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Conecte ao menos uma conta do Mercado Livre.
                    </p>
                  ) : (
                    mlAccounts.map((acc) => (
                      <label
                        key={acc.id}
                        className="flex items-center justify-between rounded-md border p-2 text-sm"
                      >
                        <span>{acc.accountName || acc.id}</span>
                        <Switch
                          checked={selectedMlAccounts.includes(acc.id)}
                          onCheckedChange={(checked) =>
                            setSelectedMlAccounts((prev) =>
                              checked
                                ? [...prev, acc.id]
                                : prev.filter((id) => id !== acc.id),
                            )
                          }
                        />
                      </label>
                    ))
                  )}
                </div>
              )}

              {/* Configurações do Anúncio ML */}
              {createMlListing && (
                <div className="space-y-3 rounded-md border p-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    Configurações do Anúncio
                  </p>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {/* Tipo de listagem */}
                    <div className="space-y-1">
                      <Label className="text-xs">Listagem do anúncio</Label>
                      <Select
                        value={mlListingType}
                        onValueChange={setMlListingType}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="gold_special">
                            Premium (gold_special)
                          </SelectItem>
                          <SelectItem value="gold_pro">
                            Clássico (gold_pro)
                          </SelectItem>
                          <SelectItem value="bronze">
                            Grátis (bronze)
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Condição do item */}
                    <div className="space-y-1">
                      <Label className="text-xs">Condição do item</Label>
                      <Select
                        value={mlItemCondition}
                        onValueChange={setMlItemCondition}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="new">Novo</SelectItem>
                          <SelectItem value="used">Usado</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Frete */}
                    <div className="space-y-1">
                      <Label className="text-xs">Frete</Label>
                      <Select
                        value={mlShippingMode}
                        onValueChange={setMlShippingMode}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="me2">Mercado Envios</SelectItem>
                          <SelectItem value="me1">Mercado Envios 1</SelectItem>
                          <SelectItem value="custom">Personalizado</SelectItem>
                          <SelectItem value="not_specified">
                            Não especificado
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Frete grátis */}
                    <div className="space-y-1">
                      <Label className="text-xs">Frete grátis</Label>
                      <Select
                        value={mlFreeShipping ? "true" : "false"}
                        onValueChange={(v) => setMlFreeShipping(v === "true")}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="true">Sim</SelectItem>
                          <SelectItem value="false">Não</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Retirar pessoalmente */}
                    <div className="space-y-1">
                      <Label className="text-xs">Retirar pessoalmente</Label>
                      <Select
                        value={mlLocalPickup ? "true" : "false"}
                        onValueChange={(v) => setMlLocalPickup(v === "true")}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="true">Sim</SelectItem>
                          <SelectItem value="false">Não</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Tempo de disponibilidade */}
                    <div className="space-y-1">
                      <Label className="text-xs">
                        Tempo de disponibilidade (dias)
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        className="h-8 text-xs"
                        value={mlManufacturingTime}
                        onChange={(e) =>
                          setMlManufacturingTime(Number(e.target.value) || 0)
                        }
                      />
                    </div>
                  </div>

                  {/* Garantia */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Switch
                        id="edit-ml-has-warranty"
                        checked={mlHasWarranty}
                        onCheckedChange={setMlHasWarranty}
                      />
                      <Label
                        htmlFor="edit-ml-has-warranty"
                        className="cursor-pointer text-xs"
                      >
                        Possui garantia
                      </Label>
                    </div>
                    {mlHasWarranty && (
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs">Garantia em</Label>
                          <Select
                            value={mlWarrantyUnit}
                            onValueChange={setMlWarrantyUnit}
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="dias">Dias</SelectItem>
                              <SelectItem value="meses">Meses</SelectItem>
                              <SelectItem value="anos">Anos</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Prazo da garantia</Label>
                          <Input
                            type="number"
                            min={1}
                            className="h-8 text-xs"
                            value={mlWarrantyDuration}
                            onChange={(e) =>
                              setMlWarrantyDuration(
                                Number(e.target.value) || 30,
                              )
                            }
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Switch
                  id="edit-create-shopee-listing"
                  checked={createShopeeListing}
                  onCheckedChange={setCreateShopeeListing}
                />
                <Label
                  htmlFor="edit-create-shopee-listing"
                  className="cursor-pointer"
                >
                  Criar anúncio no Shopee
                </Label>
              </div>
              {createShopeeListing && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {shopeeAccounts.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Conecte ao menos uma conta do Shopee.
                    </p>
                  ) : (
                    shopeeAccounts.map((acc) => (
                      <label
                        key={acc.id}
                        className="flex items-center justify-between rounded-md border p-2 text-sm"
                      >
                        <span>{acc.accountName || acc.id}</span>
                        <Switch
                          checked={selectedShopeeAccounts.includes(acc.id)}
                          onCheckedChange={(checked) =>
                            setSelectedShopeeAccounts((prev) =>
                              checked
                                ? [...prev, acc.id]
                                : prev.filter((id) => id !== acc.id),
                            )
                          }
                        />
                      </label>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Atualizando...
                </>
              ) : (
                "Atualizar Produto"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
