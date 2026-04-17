"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, ChevronDown, Link2, Check } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { CompatibilityTab, CompatibilityEntry } from "./compatibility-tab";
import {
  isProductVehicular,
  isCategoryUnderVehicleRoot,
  sanityCheckInitialMlCategory,
} from "./edit-product-dialog.helpers";
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
import { MultiImageUpload } from "@/components/ui/multi-image-upload";
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
    .max(60, "Nome deve ter no máximo 60 caracteres"),
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
  category: z.string().max(500).optional().nullable(),
  mlCategory: z.string().optional().nullable(),
  shopeeCategory: z.string().optional().nullable(),
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

  imageUrl: z.string().optional().nullable(),
  imageUrls: z.array(z.string()).optional(),
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
  mlCategoryId?: string | null;
  shopeeCategory?: string | null;
  shopeeCategoryId?: string | null;
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
  imageUrls?: string[] | null;
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

// Module-level caches: reaproveitam entre aberturas do modal (não alteram fluxo,
// apenas evitam refetch das mesmas listas de categorias / sugestões).
type CatOption = { id: string; value: string };
const ML_CATEGORIES_STORAGE_KEY = "edit-modal.mlCategoriesCache.v1";
const ML_CATEGORIES_TTL_MS = 15 * 60 * 1000;
function hydrateMlCategoriesCache(): CatOption[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(ML_CATEGORIES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts: number; data: CatOption[] };
    if (!parsed?.data || !Array.isArray(parsed.data)) return null;
    if (Date.now() - (parsed.ts || 0) > ML_CATEGORIES_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
function persistMlCategoriesCache(data: CatOption[]) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(
      ML_CATEGORIES_STORAGE_KEY,
      JSON.stringify({ ts: Date.now(), data }),
    );
  } catch {
    // sessionStorage cheio ou bloqueado — ignora silenciosamente
  }
}
const mlCategoriesCache: { data: CatOption[] | null } = {
  data: hydrateMlCategoriesCache(),
};
const shopeeAllCategoriesCache: { data: CatOption[] | null } = { data: null };
const shopeeSuggestCache = new Map<string, CatOption[]>();

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
  const mlOptionsFetchedRef = useRef(false);
  const mlOptionsFetchingRef = useRef(false);
  const [mlLeafSelectOpen, setMlLeafSelectOpen] = useState(false);
  const [mlCategoryWarning, setMlCategoryWarning] = useState<string | null>(
    null,
  );
  const [shopeeOptions, setShopeeOptions] = useState<
    { id: string; value: string }[]
  >([]);
  const [shopeeSuggestedOptions, setShopeeSuggestedOptions] = useState<
    { id: string; value: string }[]
  >([]);
  const [shopeeCategoryOpen, setShopeeCategoryOpen] = useState(false);
  const shopeeOptionsFetchedRef = useRef(false);
  const shopeeOptionsFetchingRef = useRef(false);
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
  const originalMlCategoryRef = useRef(product.mlCategory || "");

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
      shopeeCategory: product.shopeeCategoryId || "",
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
      imageUrls:
        Array.isArray(product.imageUrls) && product.imageUrls.length > 0
          ? product.imageUrls
          : product.imageUrl
            ? [product.imageUrl]
            : [],
    },
  });

  // Watch para campos automáticos
  const watchName = watch("name");
  const watchCostPrice = watch("costPrice");
  const watchPrice = watch("price");
  const watchCategory = watch("category");
  const watchMlCategory = watch("mlCategory");
  const watchDescription = watch("description") || "";

  // Índices memoizados para lookups O(1) em mlOptions (evita find() em arrays grandes a cada render)
  const mlOptionsById = useMemo(
    () => new Map(mlOptions.map((c) => [c.id, c])),
    [mlOptions],
  );
  const mlOptionsByValue = useMemo(
    () => new Map(mlOptions.map((c) => [c.value, c])),
    [mlOptions],
  );

  // Lazy-load ML categories: chamado apenas quando o usuário abre o seletor ou ativa publicação ML
  const fetchMlCategories = useCallback(async () => {
    if (mlOptionsFetchedRef.current || mlOptionsFetchingRef.current) return;
    if (!session?.user?.email) return;
    if (mlCategoriesCache.data) {
      setMlOptions(mlCategoriesCache.data);
      mlOptionsFetchedRef.current = true;
      return;
    }
    mlOptionsFetchingRef.current = true;
    try {
      const base = getApiBaseUrl();
      const resp = await fetch(`${base}/marketplace/ml/categories`, {
        headers: { email: session.user.email },
      });
      if (resp.ok) {
        const json = await resp.json();
        const cats = json.categories || [];
        mlCategoriesCache.data = cats;
        persistMlCategoriesCache(cats);
        setMlOptions(cats);
        mlOptionsFetchedRef.current = true;
      }
    } catch (err) {
      console.error("Erro ao buscar categorias ML:", err);
    } finally {
      mlOptionsFetchingRef.current = false;
    }
  }, [session?.user?.email]);

  // Lazy-load categorias ML quando o usuário ativa publicação ML
  useEffect(() => {
    if (createMlListing) void fetchMlCategories();
  }, [createMlListing, fetchMlCategories]);

  const fetchShopeeCategories = useCallback(async () => {
    if (shopeeOptionsFetchedRef.current || shopeeOptionsFetchingRef.current)
      return;
    if (!session?.user?.email) return;
    shopeeOptionsFetchingRef.current = true;
    try {
      const base = getApiBaseUrl();
      const title = product.name || "";
      const headers = { email: session.user.email };
      const suggestKey = title.trim().toLowerCase();
      const cachedSuggest = suggestKey
        ? shopeeSuggestCache.get(suggestKey)
        : undefined;
      const cachedAll = shopeeAllCategoriesCache.data;

      // Sempre busca AMBOS: sugestões por título + lista completa filtrada.
      // Sugestões viram grupo "Sugeridas" no topo do combobox; lista completa
      // permite busca livre quando a sugestão não atende.
      // Caches de módulo evitam refetch entre aberturas do modal.
      const [suggestResp, allResp] = await Promise.all([
        cachedSuggest !== undefined
          ? Promise.resolve(null)
          : title
            ? fetch(
                `${base}/marketplace/shopee/category-suggest?title=${encodeURIComponent(title)}`,
                { headers },
              ).catch(() => null)
            : Promise.resolve(null),
        cachedAll !== null
          ? Promise.resolve(null)
          : fetch(`${base}/marketplace/shopee/categories`, { headers }).catch(
              () => null,
            ),
      ]);

      let suggestions: { id: string; value: string }[] = cachedSuggest ?? [];
      if (cachedSuggest === undefined && suggestResp && suggestResp.ok) {
        const json = await suggestResp.json();
        suggestions = (json.suggestions || [])
          .map((s: any) => ({
            id: s.categoryId || s.externalId || s.id,
            value: s.fullPath || s.name || s.categoryId,
          }))
          .filter((s: any) => s.id && s.value);
        if (suggestKey) shopeeSuggestCache.set(suggestKey, suggestions);
      }

      let allFiltered: { id: string; value: string }[] = cachedAll ?? [];
      if (cachedAll === null && allResp && allResp.ok) {
        const json = await allResp.json();
        const all = (json.categories || []) as { id: string; value: string }[];
        const norm = (s: string) =>
          (s || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase();
        const AUTO_MARKERS = [
          "veiculos",
          "automoveis",
          "automotiv",
          "pecas e acessorios para veiculos",
        ];
        const BLOCKED = [
          "moda",
          "beleza",
          "roupa",
          "vestuario",
          "calcado",
          "bolsa",
          "cinto",
          "relogio",
          "oculos",
          "joias",
          "bijuteria",
          "esporte",
          "brinquedo",
          "pet",
          "alimento",
          "bebida",
          "papelaria",
          "bebe",
          "saude",
          "casa",
          "cozinha",
          "eletrodomestico",
          "hobbies",
          "colecoes",
          "colecionaveis",
          "musical",
          "livros",
          "ferramenta",
          "jardim",
        ];
        allFiltered = all.filter((c) => {
          const p = norm(c.value);
          if (BLOCKED.some((b) => p.includes(b))) return false;
          return AUTO_MARKERS.some((m) => p.includes(m));
        });
        shopeeAllCategoriesCache.data = allFiltered;
      }

      // Deduplica: remove das "todas" as que já estão em sugeridas
      const suggestedIds = new Set(suggestions.map((s) => s.id));
      const allMinusSuggested = allFiltered.filter(
        (o) => !suggestedIds.has(o.id),
      );

      setShopeeSuggestedOptions(suggestions);
      setShopeeOptions(allMinusSuggested);
      shopeeOptionsFetchedRef.current = true;
    } catch (err) {
      console.error("Erro ao buscar categorias Shopee:", err);
    } finally {
      shopeeOptionsFetchingRef.current = false;
    }
  }, [session?.user?.email, product.name]);

  useEffect(() => {
    if (createShopeeListing) void fetchShopeeCategories();
  }, [createShopeeListing, fetchShopeeCategories]);

  // Ao habilitar a criação de anúncio, selecionar automaticamente todas as contas disponíveis
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
  // e padrões de anúncio ML. Em seguida, sobrepõe com settings já persistidos
  // em ProductListing (se houver) — precedência: ProductListing > user.default*.
  const fetchDefaultDescription = useCallback(async () => {
    try {
      if (!session?.user?.email) return;

      // Carregar em paralelo: defaults do usuário + detalhe do produto (com
      // detailedListings que agora expõem os 9 campos de settings ML).
      const [userResp, detailResp] = await Promise.all([
        fetch(`${getApiBaseUrl()}/users/me`, {
          headers: { email: session.user.email },
        }),
        product.id
          ? fetch(`${getApiBaseUrl()}/products/${product.id}`, {
              headers: { email: session.user.email },
            })
          : Promise.resolve(null as Response | null),
      ]);

      if (userResp && userResp.ok) {
        const user = await userResp.json();
        const desc = user.defaultProductDescription || "";
        setDefaultDescription(desc);
        if (!product.description && desc) setValue("description", desc);

        if (user.defaultListingType) setMlListingType(user.defaultListingType);
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

      // Sobrepõe com settings persistidos em ProductListing (primeiro listing ML
      // com settings não-nulos). Respeita a regra: um produto pode ter várias
      // contas ML, mas o edit modal atual só expõe um conjunto de controles —
      // usa o primeiro como base para hidratação.
      if (detailResp && detailResp.ok) {
        try {
          const detail = await detailResp.json();
          const listings = Array.isArray(detail?.detailedListings)
            ? detail.detailedListings
            : [];
          const mlListing = listings.find(
            (l: any) =>
              l?.platform === "MERCADO_LIVRE" &&
              (l.listingType != null ||
                l.itemCondition != null ||
                l.hasWarranty != null ||
                l.shippingMode != null ||
                l.freeShipping != null ||
                l.localPickup != null ||
                l.manufacturingTime != null ||
                l.warrantyUnit != null ||
                l.warrantyDuration != null),
          );
          if (mlListing) {
            if (mlListing.listingType) setMlListingType(mlListing.listingType);
            if (mlListing.itemCondition)
              setMlItemCondition(mlListing.itemCondition);
            if (mlListing.hasWarranty != null)
              setMlHasWarranty(!!mlListing.hasWarranty);
            if (mlListing.warrantyUnit)
              setMlWarrantyUnit(mlListing.warrantyUnit);
            if (mlListing.warrantyDuration != null)
              setMlWarrantyDuration(mlListing.warrantyDuration);
            if (mlListing.shippingMode)
              setMlShippingMode(mlListing.shippingMode);
            if (mlListing.freeShipping != null)
              setMlFreeShipping(!!mlListing.freeShipping);
            if (mlListing.localPickup != null)
              setMlLocalPickup(!!mlListing.localPickup);
            if (mlListing.manufacturingTime != null)
              setMlManufacturingTime(mlListing.manufacturingTime);
          }
        } catch (detailErr) {
          console.warn(
            "Erro ao ler detalhe do produto para hidratar settings ML:",
            detailErr,
          );
        }
      }
    } catch (err) {
      console.error("Erro ao buscar descrição padrão (edit dialog):", err);
    }
  }, [product.description, product.id, session?.user?.email, setValue]);

  const fetchDefaultDescriptionRef = useRef(fetchDefaultDescription);
  useEffect(() => {
    fetchDefaultDescriptionRef.current = fetchDefaultDescription;
  }, [fetchDefaultDescription]);

  const fetchMlCategoriesRef = useRef(fetchMlCategories);
  useEffect(() => {
    fetchMlCategoriesRef.current = fetchMlCategories;
  }, [fetchMlCategories]);

  // Guarda idempotência: evita que StrictMode (dev) ou re-renders causem
  // múltiplas execuções do corpo do open-effect para o mesmo (productId).
  const lastOpenKeyRef = useRef<string | null>(null);
  // Guarda idempotência para o sanity-check/auto-suggest: aplica no máximo
  // uma vez por (productId + mlOptions carregado).
  const sanityAppliedRef = useRef<string | null>(null);

  useEffect(() => {
    if (open) {
      const openKey = product.id;
      if (lastOpenKeyRef.current === openKey) {
        return;
      }
      lastOpenKeyRef.current = openKey;
      sanityAppliedRef.current = null;

      // Reset previous auto-detection when opening dialog so it's recalculated
      autoDetectedRef.current = null;

      // Atualizar refs com valores originais do produto
      originalNameRef.current = product.name;
      originalBrandRef.current = product.brand || "";
      originalModelRef.current = product.model || "";
      originalYearRef.current = product.year || "";
      originalCategoryRef.current = product.category || "";
      originalMlCategoryRef.current = product.mlCategory || "";

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
        shopeeCategory: product.shopeeCategoryId || "",
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
        imageUrls:
          Array.isArray(product.imageUrls) && product.imageUrls.length > 0
            ? product.imageUrls
            : product.imageUrl
              ? [product.imageUrl]
              : [],
      });
      // Abrir seção de autopeças se houver dados
      setShowAutopartsSection(hasAutopartsData);
      setCreateMlListing(false);
      setCreateShopeeListing(false);
      setSelectedMlAccounts([]);
      setSelectedShopeeAccounts([]);

      setMlCategoryWarning(null);

      // Pre-fetch ML categories (reusa cache de módulo se disponível).
      // Necessário para o sanity-check/auto-suggest resolver o título
      // contra uma lista real antes do usuário interagir.
      void fetchMlCategoriesRef.current();

      // Disparar todos os fetches em paralelo para abrir o modal mais rápido
      const email = session?.user?.email || "";
      const base = getApiBaseUrl();
      const headers = { email };

      setCompatibilitiesLoading(true);

      Promise.all([
        // 1. Localizações
        fetch(`${base}/locations/select`, { headers }).then((r) =>
          r.ok ? r.json() : null,
        ),
        // 2. Contas ML
        email
          ? fetch(`${base}/marketplace/ml/accounts`, { headers }).then((r) =>
              r.ok ? r.json() : null,
            )
          : null,
        // 3. Contas Shopee
        email
          ? fetch(`${base}/marketplace/shopee/accounts`, { headers }).then(
              (r) => (r.ok ? r.json() : null),
            )
          : null,
        // 4. Compatibilidades
        email && product.id
          ? fetch(`${base}/products/${product.id}/compatibilities`, {
              headers,
            }).then((r) => (r.ok ? r.json() : null))
          : null,
        // 5. Descrição padrão do usuário
        fetchDefaultDescriptionRef.current(),
      ])
        .then(([locJson, mlJson, shJson, compatJson]) => {
          if (locJson)
            setLocationOptions(
              Array.isArray(locJson.locations) ? locJson.locations : [],
            );
          if (mlJson)
            setMlAccounts(
              Array.isArray(mlJson.accounts) ? mlJson.accounts : [],
            );
          if (shJson)
            setShopeeAccounts(
              Array.isArray(shJson.accounts) ? shJson.accounts : [],
            );
          if (compatJson) {
            const items: CompatibilityEntry[] = (
              compatJson.compatibilities || []
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
        })
        .catch((err) => {
          console.error("Erro ao carregar dados do modal:", err);
        })
        .finally(() => {
          setCompatibilitiesLoading(false);
        });
    }
  }, [
    open,
    product.id,
    reset,
    session?.user?.email,
  ]);

  // Ao fechar, libera a guarda para permitir reabrir e reexecutar o corpo.
  useEffect(() => {
    if (!open) {
      lastOpenKeyRef.current = null;
      sanityAppliedRef.current = null;
    }
  }, [open]);

  // Sanity-check + auto-suggest de categoria ML.
  // Executa no máximo uma vez por (open, productId, mlOptions-ready):
  //  - Se categoria persistida cai fora do nicho veicular → limpa + avisa.
  //  - Se categoria está vazia + produto veicular → tenta sugerir a partir
  //    do título, SOMENTE entre categorias sob a raiz veicular.
  useEffect(() => {
    if (!open) return;
    if (!mlOptions || mlOptions.length === 0) return;

    const applyKey = `${product.id}|${mlOptions.length}`;
    if (sanityAppliedRef.current === applyKey) return;
    sanityAppliedRef.current = applyKey;

    const vehicular = !!(product.brand && product.model && product.year);
    const currentMlCategory = watch("mlCategory") || "";

    if (currentMlCategory) {
      const check = sanityCheckInitialMlCategory(
        { brand: product.brand, model: product.model, year: product.year },
        currentMlCategory,
        mlOptions,
      );
      if (check.clear) {
        setValue("mlCategory", "", { shouldDirty: false });
        setValue("category", "", { shouldDirty: false });
        setMlCategoryWarning(check.warning || null);
      } else {
        setMlCategoryWarning(null);
        return;
      }
    }

    if (!vehicular) return;

    // Pool restrito a categorias sob o nicho veicular (só elas interessam
    // para um produto com brand+model+year).
    const vehiclePool = mlOptions.filter(
      (c) =>
        isCategoryUnderVehicleRoot(c.id, mlOptions) === true,
    );

    if (vehiclePool.length === 0) {
      setMlCategoryWarning(
        "Selecione manualmente uma categoria de autopeças antes de publicar.",
      );
      return;
    }

    // Tokens significativos do título (≥4 chars, exclui palavras do veículo)
    const stop = new Set<string>([
      (product.brand || "").toLowerCase(),
      (product.model || "").toLowerCase(),
      (product.year || "").toLowerCase(),
      (product.version || "").toLowerCase(),
      "para",
      "com",
      "sem",
      "de",
      "do",
      "da",
    ]);
    const titleTokens = (product.name || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !stop.has(t));

    const scoreOption = (value: string) => {
      const leafRaw = value.split(" > ").slice(-1)[0] || "";
      const pathNormalized = value
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
      const leafNormalized = leafRaw
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
      let score = 0;
      for (const t of titleTokens) {
        if (leafNormalized.includes(t)) score += 3;
        else if (pathNormalized.includes(t)) score += 1;
      }
      return score;
    };

    let best: { id: string; value: string } | undefined;
    let bestScore = 0;
    for (const opt of vehiclePool) {
      const s = scoreOption(opt.value);
      if (s > bestScore) {
        bestScore = s;
        best = opt;
      }
    }

    if (best && bestScore >= 3) {
      console.info("[EditModalML] auto-suggest", {
        productId: product.id,
        title: product.name,
        suggestedId: best.id,
        suggestedValue: best.value,
        score: bestScore,
      });
      setValue("mlCategory", best.id, {
        shouldDirty: false,
        shouldTouch: false,
        shouldValidate: true,
      });
      setValue("category", best.value.split(" > ")[0].trim(), {
        shouldDirty: false,
      });
      setMlCategoryWarning(
        "Categoria sugerida automaticamente. Confirme antes de publicar.",
      );
    } else {
      console.info("[EditModalML] auto-suggest miss", {
        productId: product.id,
        title: product.name,
        poolSize: vehiclePool.length,
        tokens: titleTokens,
      });
      setMlCategoryWarning(
        "Selecione manualmente uma categoria de autopeças antes de publicar.",
      );
    }
  }, [
    open,
    mlOptions,
    product.id,
    product.brand,
    product.model,
    product.year,
    product.version,
    product.name,
    setValue,
    watch,
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
      const setOpts = { shouldDirty: true, shouldTouch: true } as const;

      // Helper: update field only if user hasn't manually edited it
      const maybeSet = (
        field: "brand" | "model" | "year",
        current: string | undefined | null,
        prevAuto: string | undefined,
        originalRef: string,
        newVal: string | undefined,
      ) => {
        const shouldUpdate =
          !current ||
          norm(prevAuto) === norm(current) ||
          current === originalRef;
        if (shouldUpdate) {
          setValue(field, newVal || (current ? current : ""), setOpts);
        }
      };

      maybeSet("brand", watch("brand"), prev.brand, originalBrandRef.current, detected.brand);
      maybeSet("model", watch("model"), prev.model, originalModelRef.current, detected.model);
      maybeSet("year", watch("year"), prev.year, originalYearRef.current, detected.year);

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
        const isPristineMl =
          currentMlCategory === originalMlCategoryRef.current;

        if (mapping.detailedId) {
          // try to resolve internal detailed id to an external id from mlOptions
          const externalFromMlOptions = mlOptionsByValue.get(
            mapping.detailedValue || "",
          )?.id;

          // Only allow internal mapping.detailedId when we have NO synced mlOptions;
          // otherwise prefer externalFromMlOptions or clear field to avoid auto-sending internal ids.
          const resolvedMlCategory =
            externalFromMlOptions ??
            (mlOptions && mlOptions.length === 0 ? mapping.detailedId : "");

          if (!currentMlCategory || isPrevAutoMl || isPristineMl) {
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
      // Single call — reused below to update autoDetectedRef
      let measurements: ReturnType<typeof getMeasurementsForCategory> | undefined;
      try {
        measurements = getMeasurementsForCategory(
          mapping.topLevel || detected.category,
          mapping.detailedValue,
        );

        const measureFields = ["heightCm", "widthCm", "lengthCm", "weightKg"] as const;
        for (const field of measureFields) {
          const current = watch(field);
          const prevAuto = prev[field];
          const shouldUpdate =
            current === null || current === undefined || prevAuto === current;
          if (shouldUpdate && measurements?.[field] !== undefined) {
            setValue(field, measurements[field], setOpts);
          }
        }
      } catch {
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
          mlOptionsByValue.get(mapping.detailedValue || "")?.id ??
          autoDetectedRef.current?.mlCategory,
        heightCm: measurements?.heightCm ?? autoDetectedRef.current?.heightCm,
        widthCm: measurements?.widthCm ?? autoDetectedRef.current?.widthCm,
        lengthCm: measurements?.lengthCm ?? autoDetectedRef.current?.lengthCm,
        weightKg: measurements?.weightKg ?? autoDetectedRef.current?.weightKg,
      };
    }, 300);

    return () => {
      if (editAutoFillTimer.current) clearTimeout(editAutoFillTimer.current);
    };
  }, [watchName, setValue, mlOptions, trigger, watch, open]);

  // When category (top-level or mlCategory) changes, update measurements accordingly (same logic as create dialog).
  useEffect(() => {
    const category = watchCategory || undefined;
    const detailedValue = mlOptionsById.get(watchMlCategory || "")?.value;
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
  }, [watchCategory, watchMlCategory, mlOptionsById, setValue, watch, trigger]);

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
        !(
          data.mlCategory ||
          autoDetectedRef.current?.mlCategory ||
          data.category ||
          product.mlCategory ||
          product.category
        )
      ) {
        onToast(
          "Defina uma categoria (topo ou ML) antes de criar o anúncio.",
          "error",
        );
        setIsSubmitting(false);
        return;
      }

      // Guard de domínio: produto veicular só pode criar anúncio ML com
      // categoria sob o nicho de autopeças. Usa a lista mlOptions já
      // carregada; se verdict for "unknown", confia no backend (fail-open).
      if (createMlListing && isProductVehicular(data)) {
        const candidateCategory =
          data.mlCategory ||
          autoDetectedRef.current?.mlCategory ||
          product.mlCategory ||
          "";
        const verdict = isCategoryUnderVehicleRoot(
          candidateCategory,
          mlOptions,
        );
        if (verdict === false) {
          onToast(
            "Selecione uma categoria de autopeças antes de publicar no Mercado Livre.",
            "error",
          );
          setMlCategoryWarning(
            "Categoria fora do nicho de autopeças. Escolha uma categoria sob 'Acessórios para Veículos'.",
          );
          setIsSubmitting(false);
          return;
        }
      }

      console.info("[EditModalML] submit", {
        productId: product.id,
        persisted: product.mlCategory,
        sent: data.mlCategory,
      });

      // Categoria ML não obrigatória no frontend quando houver categoria de topo;
      // o backend resolve/normaliza para uma folha válida.

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

      // Normalizar campos: preservar 0 numérico, permitir limpar strings com null
      const strOrNull = (v: string | null | undefined) =>
        v && v.trim().length > 0 ? v.trim() : null;

      const cleanData = {
        ...data,
        // Numéricos: ?? preserva 0; null limpa o campo
        costPrice: data.costPrice ?? null,
        markup: data.markup ?? null,
        // Strings: vazio = intenção de limpar -> null
        brand: strOrNull(data.brand),
        model: strOrNull(data.model),
        year: strOrNull(data.year),
        version: strOrNull(data.version),
        category: strOrNull(data.category),
        location: strOrNull(data.location),
        locationId: data.locationId ?? null,
        partNumber: strOrNull(data.partNumber),
        quality: data.quality ?? null,
        sourceVehicle: strOrNull(data.sourceVehicle),

        // Medidas: ?? preserva 0
        heightCm: data.heightCm ?? null,
        widthCm: data.widthCm ?? null,
        lengthCm: data.lengthCm ?? null,
        weightKg: data.weightKg ?? null,

        imageUrl: (data.imageUrls && data.imageUrls[0]) || data.imageUrl || null,
        imageUrls: data.imageUrls || [],
        mlCategorySource: mlCategorySourceToSend,
        mlCategory: data.mlCategory || autoDetectedRef.current?.mlCategory || null,
        shopeeCategory: data.shopeeCategory || null,

        // Compatibilidades no mesmo payload
        compatibilities: compatibilities.map((c) => ({
          brand: c.brand,
          model: c.model,
          yearFrom: c.yearFrom || null,
          yearTo: c.yearTo || null,
          version: c.version || null,
        })),
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

      // Compatibilidades já foram salvas atomicamente no PUT acima

      const base = getApiBaseUrl();

      // Monta um único POST /listings/dispatch com todas as plataformas e contas.
      // O endpoint retorna 202 imediato (fire-and-forget) — sem timeout síncrono
      // de 60s por conta. O status final aparece na aba Anúncios conforme os
      // jobs terminam em background.
      const dispatchRequests: Array<{
        platform: "MERCADO_LIVRE" | "SHOPEE";
        accountId?: string;
        categoryId?: string;
        mlSettings?: Record<string, unknown>;
      }> = [];

      if (createMlListing && selectedMlAccounts.length > 0) {
        const mlCategoryId =
          data.mlCategory && data.mlCategory !== product.mlCategory
            ? data.mlCategory
            : autoDetectedRef.current?.mlCategory || undefined;
        for (const accountId of selectedMlAccounts) {
          dispatchRequests.push({
            platform: "MERCADO_LIVRE",
            accountId,
            categoryId: mlCategoryId,
            mlSettings: {
              listingType: mlListingType,
              hasWarranty: mlHasWarranty,
              warrantyUnit: mlWarrantyUnit,
              warrantyDuration: mlWarrantyDuration,
              itemCondition: mlItemCondition,
              shippingMode: mlShippingMode,
              freeShipping: mlFreeShipping,
              localPickup: mlLocalPickup,
              manufacturingTime: mlManufacturingTime,
            },
          });
        }
      }

      if (createShopeeListing && selectedShopeeAccounts.length > 0) {
        const shopeeCategoryId =
          data.shopeeCategory || product.shopeeCategoryId || undefined;
        for (const accountId of selectedShopeeAccounts) {
          dispatchRequests.push({
            platform: "SHOPEE",
            accountId,
            categoryId: shopeeCategoryId,
          });
        }
      }

      let dispatched = 0;
      if (dispatchRequests.length > 0) {
        try {
          const resp = await fetch(`${base}/listings/dispatch`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              email: session?.user?.email || "",
            },
            body: JSON.stringify({
              productId: product.id,
              requests: dispatchRequests,
            }),
          });
          const body = await resp.json().catch(() => ({}));
          if (resp.ok && Array.isArray(body?.queued)) {
            dispatched = body.queued.length;
          } else {
            onToast(
              body?.message ||
                body?.error ||
                "Falha ao enfileirar anúncios. Confira a aba Anúncios.",
              "error",
            );
          }
        } catch (err) {
          onToast(
            err instanceof Error
              ? `Erro ao enfileirar anúncios: ${err.message}`
              : "Erro ao enfileirar anúncios",
            "error",
          );
        }
      }

      onToast(
        dispatched > 0
          ? `Produto atualizado. ${dispatched} anúncio(s) em processamento — acompanhe na aba Anúncios.`
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Editar Produto</DialogTitle>
          <DialogDescription>
            Atualize os dados do produto &quot;{product.name}&quot;
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={handleSubmit(onSubmit, (formErrors) => {
            const first = Object.values(formErrors)[0] as
              | { message?: string }
              | undefined;
            const firstKey = Object.keys(formErrors)[0];
            onToast(
              first?.message
                ? `${firstKey}: ${first.message}`
                : "Corrija os campos destacados antes de atualizar.",
              "error",
            );
          })}
          className="space-y-4"
        >
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
                maxLength={60}
              />
              <div className="flex justify-end text-xs text-muted-foreground">
                <span
                  className={
                    (watchName?.length || 0) > 60
                      ? "text-destructive"
                      : undefined
                  }
                >
                  {watchName?.length || 0}/60
                </span>
              </div>
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
              <Label>Fotos do Produto</Label>
              <Controller
                name="imageUrls"
                control={control}
                render={({ field }) => (
                  <MultiImageUpload
                    value={field.value || []}
                    onChange={(urls) => {
                      field.onChange(urls);
                      setValue("imageUrl", urls[0] || "", {
                        shouldDirty: true,
                      });
                    }}
                    onError={(error: string) => onToast(error, "error")}
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
                      const mlById = mlOptionsById.get(
                        watch("mlCategory") || "",
                      )?.value;

                      const mlByFull = mlOptionsByValue.get(
                        watch("category") || "",
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
                              mlOptionsByValue.get(val) ||
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
                        const hasMl = mlOptions.length > 0;
                        const optionsSource = hasMl
                          ? mlOptions
                          : ML_CATEGORY_OPTIONS.map((c) => ({
                              id: c.id,
                              value: c.value,
                            }));

                        // Pick selectedId: prefer explicit field value, otherwise match fullPath in category
                        const catVal = watch("category") || "";
                        const candidateByFull = hasMl
                          ? mlOptionsByValue.get(catVal)
                          : optionsSource.find((o) => o.value === catVal);
                        const selectedId =
                          field.value || candidateByFull?.id || "";

                        const selectedLabel = hasMl
                          ? (mlOptionsById.get(field.value || "")?.value ||
                            candidateByFull?.value ||
                            catVal ||
                            undefined)
                          : (optionsSource.find((o) => o.id === field.value)
                              ?.value ||
                            candidateByFull?.value ||
                            ML_CATEGORY_OPTIONS.find(
                              (c) => c.value === catVal,
                            )?.value ||
                            catVal ||
                            undefined);

                        return (
                          <Select
                            open={mlLeafSelectOpen}
                            onOpenChange={(isOpen) => {
                              setMlLeafSelectOpen(isOpen);
                              if (isOpen) void fetchMlCategories();
                            }}
                            onValueChange={(val) => {
                              field.onChange(val);
                              const sel = hasMl
                                ? mlOptionsById.get(val)
                                : optionsSource.find((o) => o.id === val);
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
                              {mlLeafSelectOpen &&
                                optionsSource.map((cat) => (
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
                  {mlCategoryWarning && (
                    <p
                      className="text-xs text-destructive"
                      role="alert"
                      data-testid="ml-category-warning"
                    >
                      {mlCategoryWarning}
                    </p>
                  )}
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
                          <SelectItem value="gold_special">Premium</SelectItem>
                          <SelectItem value="gold_pro">Clássico</SelectItem>
                          <SelectItem value="bronze">Grátis</SelectItem>
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
                <>
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
                  <div className="mt-2">
                    <Label>Categoria no Shopee</Label>
                    <Controller
                      name="shopeeCategory"
                      control={control}
                      render={({ field }) => {
                        const selected = [
                          ...shopeeSuggestedOptions,
                          ...shopeeOptions,
                        ].find((o) => o.id === (field.value || ""));
                        const isLoading =
                          shopeeSuggestedOptions.length === 0 &&
                          shopeeOptions.length === 0;
                        return (
                          <Popover
                            open={shopeeCategoryOpen}
                            onOpenChange={(isOpen) => {
                              setShopeeCategoryOpen(isOpen);
                              if (isOpen) void fetchShopeeCategories();
                            }}
                            modal
                          >
                            <PopoverTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                role="combobox"
                                aria-expanded={shopeeCategoryOpen}
                                className={cn(
                                  "w-full justify-between font-normal",
                                  !selected && "text-muted-foreground",
                                )}
                              >
                                <span className="truncate text-left">
                                  {selected
                                    ? selected.value
                                    : isLoading
                                      ? "Carregando categorias..."
                                      : "Selecione ou pesquise uma categoria"}
                                </span>
                                <ChevronDown className="ml-2 size-4 shrink-0 opacity-50" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent
                              className="p-0"
                              align="start"
                              style={{
                                width:
                                  "var(--radix-popover-trigger-width)",
                                maxHeight: 360,
                              }}
                            >
                              <Command>
                                <CommandInput placeholder="Pesquisar categoria..." />
                                <CommandList>
                                  <CommandEmpty>
                                    Nenhuma categoria encontrada.
                                  </CommandEmpty>
                                  {shopeeSuggestedOptions.length > 0 && (
                                    <CommandGroup heading="Sugeridas pelo título">
                                      {shopeeSuggestedOptions.map((opt) => (
                                        <CommandItem
                                          key={`sug-${opt.id}`}
                                          value={`${opt.value} ${opt.id}`}
                                          onSelect={() => {
                                            field.onChange(opt.id);
                                            setShopeeCategoryOpen(false);
                                          }}
                                        >
                                          <Check
                                            className={cn(
                                              "mr-2 size-4",
                                              field.value === opt.id
                                                ? "opacity-100"
                                                : "opacity-0",
                                            )}
                                          />
                                          <span className="truncate">
                                            {opt.value}
                                          </span>
                                        </CommandItem>
                                      ))}
                                    </CommandGroup>
                                  )}
                                  {shopeeOptions.length > 0 && (
                                    <CommandGroup heading="Todas as categorias de autopeças">
                                      {shopeeOptions.map((opt) => (
                                        <CommandItem
                                          key={opt.id}
                                          value={`${opt.value} ${opt.id}`}
                                          onSelect={() => {
                                            field.onChange(opt.id);
                                            setShopeeCategoryOpen(false);
                                          }}
                                        >
                                          <Check
                                            className={cn(
                                              "mr-2 size-4",
                                              field.value === opt.id
                                                ? "opacity-100"
                                                : "opacity-0",
                                            )}
                                          />
                                          <span className="truncate">
                                            {opt.value}
                                          </span>
                                        </CommandItem>
                                      ))}
                                    </CommandGroup>
                                  )}
                                </CommandList>
                              </Command>
                            </PopoverContent>
                          </Popover>
                        );
                      }}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Obrigatório para publicar no Shopee. Use o campo de busca
                      para filtrar a lista. A categoria será persistida no
                      produto.
                    </p>
                  </div>
                </>
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
