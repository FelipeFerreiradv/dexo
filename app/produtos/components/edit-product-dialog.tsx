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
import { invalidateListingsStatusCache } from "./marketplace-listings-dialog";
import { MLDynamicAttributesSection } from "./ml-dynamic-attributes-section";
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
import {
  LocationCombobox,
  type LocationSelectItem,
} from "@/app/produtos/components/location-combobox";
import { LocationScanButton } from "./location-scan-button";
import { ScrapLinkSection } from "./scrap-link-section";
import { isScrapRelinkUiEnabled } from "../lib/scrap-relink";
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
  magaluCategory: z.string().optional().nullable(),
  olxCategory: z.string().optional().nullable(),
  facebookCategory: z.string().optional().nullable(),
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

  // Ficha técnica secundária (atributos por categoria do ML)
  attributes: z
    .record(
      z.object({
        value_id: z.string().optional(),
        value_name: z.string().optional(),
      }),
    )
    .optional(),
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
  olxCategoryId?: string | null;
  fbCategory?: string | null;
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
  attributes?: Record<
    string,
    { value_id?: string; value_name?: string }
  > | null;
  mlCatalogProductId?: string | null;
  /** Posição das compatibilidades no ML (["Dianteira","Esquerda"]). */
  compatibilityPositions?: string[] | null;
}

/**
 * Quando o modal é aberto a partir do clique em "Editar anúncio" de uma conta
 * específica, recebemos esse contexto. Sem ele, o componente comporta-se
 * exatamente como antes (edição apenas do produto compartilhado).
 *
 * Com listingContext:
 *  - título e subtítulo mudam para refletir que está editando um anúncio
 *    específico daquela conta;
 *  - settings ML (listingType/garantia/frete/...) são pré-populados a partir
 *    do listing escolhido (não do "primeiro qualquer");
 *  - a seção "Publicar anúncios" (criar em outras contas) é escondida —
 *    estamos editando um existente;
 *  - ao salvar, faz PUT /listings/:listingId além do PUT /products/:id, sem
 *    disparar o dispatcher de criação de novos anúncios.
 */
export interface EditProductDialogListingContext {
  listingId: string;
  accountName: string;
  platform: "MERCADO_LIVRE" | "SHOPEE" | "MAGALU" | "OLX" | "FACEBOOK";
  externalListingId: string | null;
  status: string;
}

// BLOCO J — seletor de sucata no modal de edição. Flag OFF ⇒ o modal renderiza
// exatamente como hoje (nenhum campo, nenhum request extra).
const SCRAP_RELINK_UI_ENABLED = isScrapRelinkUiEnabled();

interface EditProductDialogProps {
  product: Product;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProductUpdated: () => void;
  onToast: (message: string, type: "success" | "error" | "warning") => void;
  listingContext?: EditProductDialogListingContext | null;
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
// Cache de sugestões ML por título (módulo) — espelha o de Shopee. Reaproveita
// entre aberturas do modal; chave = title.trim().toLowerCase().
const mlSuggestCache = new Map<string, CatOption[]>();

// Magalu (3º marketplace) só aparece com a flag. Módulo (não é dep de hook).
const MAGALU_ENABLED =
  process.env.NEXT_PUBLIC_MAGALU_INTEGRATION_ENABLED === "true";
// OLX e Facebook (novas plataformas) atrás das próprias flags.
const OLX_ENABLED = process.env.NEXT_PUBLIC_OLX_INTEGRATION_ENABLED === "true";
const FACEBOOK_ENABLED =
  process.env.NEXT_PUBLIC_FACEBOOK_INTEGRATION_ENABLED === "true";

const PLATFORM_LABELS: Record<
  EditProductDialogListingContext["platform"],
  string
> = {
  MERCADO_LIVRE: "Mercado Livre",
  SHOPEE: "Shopee",
  MAGALU: "Magalu",
  OLX: "OLX",
  FACEBOOK: "Facebook",
};
function platformLabel(platform: EditProductDialogListingContext["platform"]) {
  return PLATFORM_LABELS[platform] ?? platform;
}

export function EditProductDialog({
  product,
  open,
  onOpenChange,
  onProductUpdated,
  onToast,
  listingContext = null,
}: EditProductDialogProps) {
  // Ref usada dentro de callbacks (fetchDefaultDescription) para evitar
  // recriar o useCallback quando listingContext mudar.
  const listingContextRef = useRef<EditProductDialogListingContext | null>(
    listingContext,
  );
  useEffect(() => {
    listingContextRef.current = listingContext;
  }, [listingContext]);
  const { data: session } = useSession();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [defaultDescription, setDefaultDescription] = useState("");
  const [showAutopartsSection, setShowAutopartsSection] = useState(false);
  const [mlOptions, setMlOptions] = useState<{ id: string; value: string }[]>(
    [],
  );
  const [mlSuggestedOptions, setMlSuggestedOptions] = useState<
    { id: string; value: string }[]
  >([]);
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
  // Magalu (3º marketplace, atrás da flag) — espelha ML/Shopee (toggle + contas);
  // a categoria é resolvida no backend, então não há seletor de categoria aqui.
  const [magaluAccounts, setMagaluAccounts] = useState<
    Array<{ id: string; accountName?: string }>
  >([]);
  const [selectedMagaluAccounts, setSelectedMagaluAccounts] = useState<
    string[]
  >([]);
  const [createMagaluListing, setCreateMagaluListing] = useState(false);
  // Categoria Magalu (opcional; se vazia o backend resolve). Espelha o modal de
  // criação — sugestão 1x no toggle + busca server-side debounced.
  const [magaluOptions, setMagaluOptions] = useState<
    { id: string; value: string }[]
  >([]);
  const [magaluCategorySearch, setMagaluCategorySearch] = useState("");
  const [magaluCategoryDropdownOpen, setMagaluCategoryDropdownOpen] =
    useState(false);
  const [magaluCategoryLoading, setMagaluCategoryLoading] = useState(false);
  const [magaluSelectedLabel, setMagaluSelectedLabel] = useState("");
  const magaluSuggestedRef = useRef(false);
  // OLX e Facebook (atrás das flags) — espelham Magalu (toggle + contas +
  // categoria opcional). Sugestão 1x no toggle + busca server-side debounced;
  // vazia = o backend resolve automaticamente.
  const [olxAccounts, setOlxAccounts] = useState<
    Array<{ id: string; accountName?: string }>
  >([]);
  const [selectedOlxAccounts, setSelectedOlxAccounts] = useState<string[]>([]);
  const [createOlxListing, setCreateOlxListing] = useState(false);
  const [olxOptions, setOlxOptions] = useState<{ id: string; value: string }[]>(
    [],
  );
  const [olxCategorySearch, setOlxCategorySearch] = useState("");
  const [olxCategoryDropdownOpen, setOlxCategoryDropdownOpen] = useState(false);
  const [olxCategoryLoading, setOlxCategoryLoading] = useState(false);
  const [olxSelectedLabel, setOlxSelectedLabel] = useState("");
  const olxSuggestedRef = useRef(false);
  const [facebookAccounts, setFacebookAccounts] = useState<
    Array<{ id: string; accountName?: string }>
  >([]);
  const [selectedFacebookAccounts, setSelectedFacebookAccounts] = useState<
    string[]
  >([]);
  const [createFacebookListing, setCreateFacebookListing] = useState(false);
  const [facebookOptions, setFacebookOptions] = useState<
    { id: string; value: string }[]
  >([]);
  const [facebookCategorySearch, setFacebookCategorySearch] = useState("");
  const [facebookCategoryDropdownOpen, setFacebookCategoryDropdownOpen] =
    useState(false);
  const [facebookCategoryLoading, setFacebookCategoryLoading] = useState(false);
  const [facebookSelectedLabel, setFacebookSelectedLabel] = useState("");
  const facebookSuggestedRef = useRef(false);

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
  // Aumento percentual escalonado entre contas ML (anti-penalização)
  const [crossAccountIncrease, setCrossAccountIncrease] = useState(false);
  const [crossAccountPercent, setCrossAccountPercent] = useState<string>("");
  const [compatibilities, setCompatibilities] = useState<CompatibilityEntry[]>(
    [],
  );
  const [compatibilitiesLoading, setCompatibilitiesLoading] = useState(false);
  const [compatibilityPositions, setCompatibilityPositions] = useState<
    string[]
  >(
    Array.isArray(product.compatibilityPositions)
      ? product.compatibilityPositions
      : [],
  );
  const [showCompatibilitySection, setShowCompatibilitySection] =
    useState(false);
  const [locationOptions, setLocationOptions] = useState<LocationSelectItem[]>(
    [],
  );

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

  // Snapshot dos settings ML do listing no momento da abertura do modal
  // (modo listingContext). Usado no save para enviar apenas os settings que
  // o usuário REALMENTE alterou — evita o ML rejeitar shipping/warranty/etc.
  // como `field_not_modifiable` em anúncios com vendas.
  // null em qualquer campo = listing não tinha baseline => diff trata como
  // "não envia" para evitar empurrar setting que o ML pode rejeitar.
  const mlSettingsSnapshotRef = useRef<{
    listingType: string | null;
    itemCondition: string | null;
    hasWarranty: boolean | null;
    warrantyUnit: string | null;
    warrantyDuration: number | null;
    shippingMode: string | null;
    freeShipping: boolean | null;
    localPickup: boolean | null;
    manufacturingTime: number | null;
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
      magaluCategory: "",
      olxCategory: product.olxCategoryId || "",
      facebookCategory: product.fbCategory || "",
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
      attributes: product.attributes || {},
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

  // Lazy-load ML categories: chamado apenas quando o usuário abre o seletor ou
  // ativa publicação ML. Mesmo padrão do `fetchShopeeCategories`: busca em
  // paralelo (a) sugestões por título (grupo "Sugeridas") e (b) lista completa
  // (grupo "Todas"). Caches de módulo evitam refetch entre aberturas.
  const fetchMlCategories = useCallback(async () => {
    if (mlOptionsFetchedRef.current || mlOptionsFetchingRef.current) return;
    if (!session?.user?.email) return;

    mlOptionsFetchingRef.current = true;
    try {
      const base = getApiBaseUrl();
      const title = product.name || "";
      const headers = { email: session.user.email };
      const suggestKey = title.trim().toLowerCase();
      const cachedSuggest = suggestKey
        ? mlSuggestCache.get(suggestKey)
        : undefined;
      const cachedAll = mlCategoriesCache.data;

      // Sempre busca AMBOS: sugestões por título + lista completa.
      const [suggestResp, allResp] = await Promise.all([
        cachedSuggest !== undefined
          ? Promise.resolve(null)
          : title
            ? fetch(
                `${base}/marketplace/ml/category-suggest?title=${encodeURIComponent(title)}`,
                { headers },
              ).catch(() => null)
            : Promise.resolve(null),
        cachedAll !== null
          ? Promise.resolve(null)
          : fetch(`${base}/marketplace/ml/categories`, { headers }).catch(
              () => null,
            ),
      ]);

      let suggestions: CatOption[] = cachedSuggest ?? [];
      if (cachedSuggest === undefined && suggestResp && suggestResp.ok) {
        const json = await suggestResp.json();
        suggestions = (json.suggestions || [])
          .map((s: any) => ({
            id: s.categoryId || s.externalId || s.id,
            value: s.fullPath || s.name || s.categoryId,
          }))
          .filter((s: any) => s.id && s.value);
        if (suggestKey) mlSuggestCache.set(suggestKey, suggestions);
      }

      let allCats: CatOption[] = cachedAll ?? [];
      if (cachedAll === null && allResp && allResp.ok) {
        const json = await allResp.json();
        allCats = json.categories || [];
        mlCategoriesCache.data = allCats;
        persistMlCategoriesCache(allCats);
      }

      // Filtro automotivo (perf): o ML devolve milhares de categorias; renderizar
      // tudo no cmdk trava o popover. Mantemos só o ramo automotivo + nichos
      // próximos (mesma estratégia do Shopee em `fetchShopeeCategories`).
      const norm = (s: string) =>
        (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
      const ML_AUTO_MARKERS = [
        "acessorios para veiculos",
        "pecas para veiculos",
        "automotivo",
      ];
      const ML_BLOCKED = [
        "moda",
        "beleza",
        "roupa",
        "vestuario",
        "calcado",
        "bolsa",
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
        "jardim",
        "imoveis",
        "industria",
      ];
      const allFiltered = allCats.filter((c) => {
        const p = norm(c.value);
        if (ML_BLOCKED.some((b) => p.includes(b))) return false;
        return ML_AUTO_MARKERS.some((m) => p.includes(m));
      });

      // Deduplica: remove de "todas" as que já estão em sugeridas
      const suggestedIds = new Set(suggestions.map((s) => s.id));
      const allMinusSuggested = allFiltered.filter(
        (o) => !suggestedIds.has(o.id),
      );

      setMlSuggestedOptions(suggestions);
      setMlOptions(allMinusSuggested);
      mlOptionsFetchedRef.current = true;
    } catch (err) {
      console.error("Erro ao buscar categorias ML:", err);
    } finally {
      mlOptionsFetchingRef.current = false;
    }
  }, [session?.user?.email, product.name]);

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

  useEffect(() => {
    if (!createMagaluListing) return;
    if (magaluAccounts.length === 0) return;
    setSelectedMagaluAccounts((prev) => {
      const allIds = magaluAccounts.map((acc) => acc.id);
      const hasAll =
        prev.length === allIds.length &&
        allIds.every((id) => prev.includes(id));
      return hasAll ? prev : allIds;
    });
  }, [createMagaluListing, magaluAccounts]);

  useEffect(() => {
    if (!createOlxListing) return;
    if (olxAccounts.length === 0) return;
    setSelectedOlxAccounts((prev) => {
      const allIds = olxAccounts.map((acc) => acc.id);
      const hasAll =
        prev.length === allIds.length &&
        allIds.every((id) => prev.includes(id));
      return hasAll ? prev : allIds;
    });
  }, [createOlxListing, olxAccounts]);

  useEffect(() => {
    if (!createFacebookListing) return;
    if (facebookAccounts.length === 0) return;
    setSelectedFacebookAccounts((prev) => {
      const allIds = facebookAccounts.map((acc) => acc.id);
      const hasAll =
        prev.length === allIds.length &&
        allIds.every((id) => prev.includes(id));
      return hasAll ? prev : allIds;
    });
  }, [createFacebookListing, facebookAccounts]);

  // Sugere a categoria Magalu 1x quando o toggle liga (ref-guard = 1 fetch, não
  // por tecla). Usa o nome atual do produto. Espelha o modal de criação.
  useEffect(() => {
    if (!MAGALU_ENABLED || !createMagaluListing) {
      magaluSuggestedRef.current = false;
      return;
    }
    if (magaluSuggestedRef.current) return;
    const name = (watchName || product.name || "").trim();
    if (!name) return;
    magaluSuggestedRef.current = true;
    (async () => {
      try {
        const resp = await fetch(
          `${getApiBaseUrl()}/marketplace/magalu/category-suggest?name=${encodeURIComponent(
            name,
          )}`,
          { headers: { email: session?.user?.email || "" } },
        );
        if (!resp.ok) return;
        const data = await resp.json();
        if (data?.categoryId) {
          const label = data.path || data.categoryId;
          setValue("magaluCategory", data.categoryId, { shouldDirty: true });
          setMagaluSelectedLabel(label);
          setMagaluOptions([{ id: data.categoryId, value: label }]);
        }
      } catch (err) {
        console.error("Erro ao sugerir categoria Magalu:", err);
      }
    })();
  }, [
    createMagaluListing,
    watchName,
    setValue,
    session?.user?.email,
    product.name,
  ]);

  // Busca server-side (debounced 400ms, só com >=2 chars e dropdown aberto) —
  // não dispara por tecla nem sem intenção. Espelha o modal de criação.
  useEffect(() => {
    if (!MAGALU_ENABLED || !createMagaluListing) return;
    const term = magaluCategorySearch.trim();
    if (term.length < 2) return;
    const handle = setTimeout(async () => {
      setMagaluCategoryLoading(true);
      try {
        const resp = await fetch(
          `${getApiBaseUrl()}/marketplace/magalu/categories?search=${encodeURIComponent(
            term,
          )}`,
          { headers: { email: session?.user?.email || "" } },
        );
        if (resp.ok) {
          const data = await resp.json();
          setMagaluOptions(
            Array.isArray(data?.categories) ? data.categories : [],
          );
        }
      } catch (err) {
        console.error("Erro ao buscar categorias Magalu:", err);
      } finally {
        setMagaluCategoryLoading(false);
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [magaluCategorySearch, createMagaluListing, session?.user?.email]);

  // Sugere a categoria OLX 1x quando o toggle liga. Espelha o fluxo Magalu.
  useEffect(() => {
    if (!OLX_ENABLED || !createOlxListing) {
      olxSuggestedRef.current = false;
      return;
    }
    if (olxSuggestedRef.current) return;
    const name = (watchName || product.name || "").trim();
    if (!name) return;
    olxSuggestedRef.current = true;
    (async () => {
      try {
        const resp = await fetch(
          `${getApiBaseUrl()}/marketplace/olx/category-suggest?name=${encodeURIComponent(
            name,
          )}`,
          { headers: { email: session?.user?.email || "" } },
        );
        if (!resp.ok) return;
        const data = await resp.json();
        if (data?.categoryId) {
          const label = data.path || data.categoryId;
          setValue("olxCategory", data.categoryId, { shouldDirty: true });
          setOlxSelectedLabel(label);
          setOlxOptions([{ id: data.categoryId, value: label }]);
        }
      } catch (err) {
        console.error("Erro ao sugerir categoria OLX:", err);
      }
    })();
  }, [
    createOlxListing,
    watchName,
    setValue,
    session?.user?.email,
    product.name,
  ]);

  useEffect(() => {
    if (!OLX_ENABLED || !createOlxListing) return;
    const term = olxCategorySearch.trim();
    // OLX tem 5 categorias e o Facebook 3 — a lista inteira cabe numa resposta,
    // e o endpoint manda Cache-Control de 10 min. Exigir 2 letras deixava a
    // lista VAZIA quando o campo vinha pré-preenchido pela sugestão, e a tela
    // caía no id cru ("2101" / o path em inglês) por não achar o rótulo.
    // Termo vazio carrega tudo; 1 letra é ruído. O Magalu segue exigindo busca
    // de propósito — lá são milhares de categorias.
    if (term.length === 1) return;
    const handle = setTimeout(async () => {
      setOlxCategoryLoading(true);
      try {
        const resp = await fetch(
          `${getApiBaseUrl()}/marketplace/olx/categories?search=${encodeURIComponent(
            term,
          )}`,
          { headers: { email: session?.user?.email || "" } },
        );
        if (resp.ok) {
          const data = await resp.json();
          setOlxOptions(Array.isArray(data?.categories) ? data.categories : []);
        }
      } catch (err) {
        console.error("Erro ao buscar categorias OLX:", err);
      } finally {
        setOlxCategoryLoading(false);
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [olxCategorySearch, createOlxListing, session?.user?.email]);

  // Sugere a categoria Facebook 1x quando o toggle liga. Espelha o fluxo Magalu.
  useEffect(() => {
    if (!FACEBOOK_ENABLED || !createFacebookListing) {
      facebookSuggestedRef.current = false;
      return;
    }
    if (facebookSuggestedRef.current) return;
    const name = (watchName || product.name || "").trim();
    if (!name) return;
    facebookSuggestedRef.current = true;
    (async () => {
      try {
        const resp = await fetch(
          `${getApiBaseUrl()}/marketplace/facebook/category-suggest?name=${encodeURIComponent(
            name,
          )}`,
          { headers: { email: session?.user?.email || "" } },
        );
        if (!resp.ok) return;
        const data = await resp.json();
        if (data?.categoryId) {
          const label = data.path || data.categoryId;
          setValue("facebookCategory", data.categoryId, { shouldDirty: true });
          setFacebookSelectedLabel(label);
          setFacebookOptions([{ id: data.categoryId, value: label }]);
        }
      } catch (err) {
        console.error("Erro ao sugerir categoria Facebook:", err);
      }
    })();
  }, [
    createFacebookListing,
    watchName,
    setValue,
    session?.user?.email,
    product.name,
  ]);

  useEffect(() => {
    if (!FACEBOOK_ENABLED || !createFacebookListing) return;
    const term = facebookCategorySearch.trim();
    // OLX tem 5 categorias e o Facebook 3 — a lista inteira cabe numa resposta,
    // e o endpoint manda Cache-Control de 10 min. Exigir 2 letras deixava a
    // lista VAZIA quando o campo vinha pré-preenchido pela sugestão, e a tela
    // caía no id cru ("2101" / o path em inglês) por não achar o rótulo.
    // Termo vazio carrega tudo; 1 letra é ruído. O Magalu segue exigindo busca
    // de propósito — lá são milhares de categorias.
    if (term.length === 1) return;
    const handle = setTimeout(async () => {
      setFacebookCategoryLoading(true);
      try {
        const resp = await fetch(
          `${getApiBaseUrl()}/marketplace/facebook/categories?search=${encodeURIComponent(
            term,
          )}`,
          { headers: { email: session?.user?.email || "" } },
        );
        if (resp.ok) {
          const data = await resp.json();
          setFacebookOptions(
            Array.isArray(data?.categories) ? data.categories : [],
          );
        }
      } catch (err) {
        console.error("Erro ao buscar categorias Facebook:", err);
      } finally {
        setFacebookCategoryLoading(false);
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [facebookCategorySearch, createFacebookListing, session?.user?.email]);

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
          user.crossAccountPriceIncreasePercent != null &&
          Number(user.crossAccountPriceIncreasePercent) > 0
        )
          setCrossAccountPercent(String(user.crossAccountPriceIncreasePercent));
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

      // Sobrepõe com settings persistidos em ProductListing.
      // - Modo "editar anúncio" (listingContext presente): usa exatamente o
      //   listing daquela conta (lookup por id) para hidratar os settings.
      // - Modo "editar produto" (sem listingContext): usa o primeiro listing
      //   ML com settings não-nulos como base — comportamento original
      //   preservado para zero regressão.
      if (detailResp && detailResp.ok) {
        try {
          const detail = await detailResp.json();
          const listings = Array.isArray(detail?.detailedListings)
            ? detail.detailedListings
            : [];
          const ctx = listingContextRef.current;
          const mlListing = ctx
            ? listings.find(
                (l: any) =>
                  l?.id === ctx.listingId && l?.platform === "MERCADO_LIVRE",
              )
            : listings.find(
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
      setCreateMagaluListing(false);
      setCreateOlxListing(false);
      setCreateFacebookListing(false);
      setSelectedMlAccounts([]);
      setSelectedShopeeAccounts([]);
      setSelectedMagaluAccounts([]);
      setSelectedOlxAccounts([]);
      setSelectedFacebookAccounts([]);
      magaluSuggestedRef.current = false;
      setMagaluSelectedLabel("");
      setMagaluOptions([]);
      setMagaluCategorySearch("");
      setMagaluCategoryDropdownOpen(false);
      olxSuggestedRef.current = false;
      setOlxSelectedLabel("");
      setOlxOptions([]);
      setOlxCategorySearch("");
      setOlxCategoryDropdownOpen(false);
      facebookSuggestedRef.current = false;
      setFacebookSelectedLabel("");
      setFacebookOptions([]);
      setFacebookCategorySearch("");
      setFacebookCategoryDropdownOpen(false);

      setMlCategoryWarning(null);

      // A posição vem junto do produto (está no productSelect da listagem), não
      // do fetch de compatibilidades. Reaplicada a cada abertura porque o modal
      // fica montado entre produtos — sem isso, abrir o produto B depois do A
      // mostraria a posição do A.
      setCompatibilityPositions(
        Array.isArray(product.compatibilityPositions)
          ? product.compatibilityPositions
          : [],
      );

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
        // 3b. Contas Magalu (atrás da flag)
        email && MAGALU_ENABLED
          ? fetch(`${base}/marketplace/magalu/accounts`, { headers }).then(
              (r) => (r.ok ? r.json() : null),
            )
          : null,
        // 3c. Contas OLX (atrás da flag)
        email && OLX_ENABLED
          ? fetch(`${base}/marketplace/olx/accounts`, { headers }).then((r) =>
              r.ok ? r.json() : null,
            )
          : null,
        // 3d. Contas Facebook (atrás da flag)
        email && FACEBOOK_ENABLED
          ? fetch(`${base}/marketplace/facebook/accounts`, { headers }).then(
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
        .then(
          ([
            locJson,
            mlJson,
            shJson,
            magaluJson,
            olxJson,
            facebookJson,
            compatJson,
          ]) => {
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
            if (magaluJson)
              setMagaluAccounts(
                Array.isArray(magaluJson.accounts) ? magaluJson.accounts : [],
              );
            if (olxJson)
              setOlxAccounts(
                Array.isArray(olxJson.accounts) ? olxJson.accounts : [],
              );
            if (facebookJson)
              setFacebookAccounts(
                Array.isArray(facebookJson.accounts)
                  ? facebookJson.accounts
                  : [],
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
          },
        )
        .catch((err) => {
          console.error("Erro ao carregar dados do modal:", err);
        })
        .finally(() => {
          setCompatibilitiesLoading(false);
        });
    }
  }, [open, product.id, reset, session?.user?.email]);

  // Ao fechar, libera a guarda para permitir reabrir e reexecutar o corpo.
  useEffect(() => {
    if (!open) {
      lastOpenKeyRef.current = null;
      sanityAppliedRef.current = null;
      mlSettingsSnapshotRef.current = null;
    }
  }, [open]);

  // Modo "editar anúncio": pré-popula os campos do form com os overrides
  // existentes daquele listing específico. Quando o override é null o campo
  // mantém o valor do produto que já foi populado pelo reset acima.
  useEffect(() => {
    const email = session?.user?.email;
    if (!open || !listingContext || !email) return;

    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const resp = await fetch(
          `${getApiBaseUrl()}/listings/${listingContext.listingId}`,
          {
            headers: { email },
            signal: controller.signal,
          },
        );
        if (!resp.ok) return;
        const json = (await resp.json()) as {
          listing?: {
            listingType: string | null;
            itemCondition: string | null;
            hasWarranty: boolean | null;
            warrantyUnit: string | null;
            warrantyDuration: number | null;
            shippingMode: string | null;
            freeShipping: boolean | null;
            localPickup: boolean | null;
            manufacturingTime: number | null;
            titleOverride: string | null;
            descriptionOverride: string | null;
            priceOverride: number | null;
            brandOverride: string | null;
            modelOverride: string | null;
            yearOverride: string | null;
            versionOverride: string | null;
            categoryOverride: string | null;
            mlCategoryOverride: string | null;
            shopeeCategoryOverride: string | null;
            partNumberOverride: string | null;
            qualityOverride: string | null;
            heightCmOverride: number | null;
            widthCmOverride: number | null;
            lengthCmOverride: number | null;
            weightKgOverride: number | null;
            imageUrlsOverride: string[] | null;
            attributesOverride: Record<
              string,
              { value_id?: string; value_name?: string }
            > | null;
            compatibilitiesOverride: Array<{
              brand: string;
              model: string;
              yearFrom?: number | null;
              yearTo?: number | null;
              version?: string | null;
            }> | null;
            sourceVehicleOverride: string | null;
          };
        };
        if (cancelled || !json?.listing) return;
        const l = json.listing;

        // Snapshot dos settings ML diretamente do banco. Usado no save para
        // só enviar settings que o usuário REALMENTE alterou.
        // Convenção: campo null no banco => sem baseline confiável =>
        // diff trata como "não enviar" (defesa contra ML rejeitar com
        // field_not_modifiable em anúncios com vendas).
        mlSettingsSnapshotRef.current = {
          listingType: l.listingType,
          itemCondition: l.itemCondition,
          hasWarranty: l.hasWarranty,
          warrantyUnit: l.warrantyUnit,
          warrantyDuration: l.warrantyDuration,
          shippingMode: l.shippingMode,
          freeShipping: l.freeShipping,
          localPickup: l.localPickup,
          manufacturingTime: l.manufacturingTime,
        };

        if (l.titleOverride !== null) setValue("name", l.titleOverride);
        if (l.descriptionOverride !== null)
          setValue("description", l.descriptionOverride);
        if (l.priceOverride !== null) setValue("price", l.priceOverride);
        if (l.brandOverride !== null) setValue("brand", l.brandOverride);
        if (l.modelOverride !== null) setValue("model", l.modelOverride);
        if (l.yearOverride !== null) setValue("year", l.yearOverride);
        if (l.versionOverride !== null) setValue("version", l.versionOverride);
        if (l.categoryOverride !== null)
          setValue("category", l.categoryOverride);
        if (l.mlCategoryOverride !== null)
          setValue("mlCategory", l.mlCategoryOverride);
        if (l.shopeeCategoryOverride !== null)
          setValue("shopeeCategory", l.shopeeCategoryOverride);
        if (l.partNumberOverride !== null)
          setValue("partNumber", l.partNumberOverride);
        if (l.qualityOverride !== null)
          setValue(
            "quality",
            l.qualityOverride as
              "SUCATA" | "SEMINOVO" | "NOVO" | "RECONDICIONADO",
          );
        if (l.heightCmOverride !== null)
          setValue("heightCm", l.heightCmOverride);
        if (l.widthCmOverride !== null) setValue("widthCm", l.widthCmOverride);
        if (l.lengthCmOverride !== null)
          setValue("lengthCm", l.lengthCmOverride);
        if (l.weightKgOverride !== null)
          setValue("weightKg", l.weightKgOverride);
        if (Array.isArray(l.imageUrlsOverride)) {
          setValue("imageUrls", l.imageUrlsOverride);
          if (l.imageUrlsOverride[0])
            setValue("imageUrl", l.imageUrlsOverride[0]);
        }
        if (l.attributesOverride && typeof l.attributesOverride === "object") {
          setValue("attributes", l.attributesOverride);
        }
        if (l.sourceVehicleOverride !== null)
          setValue("sourceVehicle", l.sourceVehicleOverride);

        if (Array.isArray(l.compatibilitiesOverride)) {
          const items: CompatibilityEntry[] = l.compatibilitiesOverride.map(
            (c, idx) => ({
              _localId: `override-${idx}-${Date.now()}`,
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
      } catch {
        /* aborted ou network — silencioso */
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, listingContext, session?.user?.email, setValue]);

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
      (c) => isCategoryUnderVehicleRoot(c.id, mlOptions) === true,
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

      maybeSet(
        "brand",
        watch("brand"),
        prev.brand,
        originalBrandRef.current,
        detected.brand,
      );
      maybeSet(
        "model",
        watch("model"),
        prev.model,
        originalModelRef.current,
        detected.model,
      );
      maybeSet(
        "year",
        watch("year"),
        prev.year,
        originalYearRef.current,
        detected.year,
      );

      // Sugestão automática de category/mlCategory removida: o usuário escolhe
      // a categoria ML manualmente no popover (grupo "Sugeridas pelo título" +
      // lista completa), mesmo padrão do Shopee. Mantemos apenas brand/model/
      // year/measurements como auto-fill por serem campos do produto local.

      // Measurements: try to auto-fill from category when available
      // Single call — reused below to update autoDetectedRef
      let measurements:
        ReturnType<typeof getMeasurementsForCategory> | undefined;
      try {
        measurements = getMeasurementsForCategory(
          mapping.topLevel || detected.category,
          mapping.detailedValue,
        );

        const measureFields = [
          "heightCm",
          "widthCm",
          "lengthCm",
          "weightKg",
        ] as const;
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

      // store detected (merge — preserve previously-detected values when parser returns undefined).
      // category/mlCategory removidos do auto-detect: a 2.2 exige que o usuário
      // escolha manualmente; deixar valores aqui faria os fallbacks no submit
      // (linhas ~1606 e ~1971) republicarem a sugestão por trás.
      autoDetectedRef.current = {
        ...autoDetectedRef.current,
        brand: detected.brand ?? autoDetectedRef.current?.brand,
        model: detected.model ?? autoDetectedRef.current?.model,
        year: detected.year ?? autoDetectedRef.current?.year,
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

      if (createMagaluListing && selectedMagaluAccounts.length === 0) {
        onToast(
          "Selecione ao menos uma conta do Magalu para criar o anúncio.",
          "error",
        );
        setIsSubmitting(false);
        return;
      }

      if (createOlxListing && selectedOlxAccounts.length === 0) {
        onToast(
          "Selecione ao menos uma conta da OLX para criar o anúncio.",
          "error",
        );
        setIsSubmitting(false);
        return;
      }

      if (createFacebookListing && selectedFacebookAccounts.length === 0) {
        onToast(
          "Selecione ao menos uma conta do Facebook para criar o anúncio.",
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

        imageUrl:
          (data.imageUrls && data.imageUrls[0]) || data.imageUrl || null,
        imageUrls: data.imageUrls || [],
        mlCategorySource: mlCategorySourceToSend,
        mlCategory:
          data.mlCategory || autoDetectedRef.current?.mlCategory || null,
        shopeeCategory: data.shopeeCategory || null,

        // Compatibilidades no mesmo payload
        compatibilities: compatibilities.map((c) => ({
          brand: c.brand,
          model: c.model,
          yearFrom: c.yearFrom || null,
          yearTo: c.yearTo || null,
          version: c.version || null,
        })),
        // Sempre enviado (mesmo vazio): é assim que o operador consegue REMOVER
        // uma posição. A rota trata ausente como "não mexer".
        compatibilityPositions,
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

      const base = getApiBaseUrl();

      // Modo "editar anúncio" (listingContext presente): TODO o save vai como
      // overrides em PUT /listings/:id. NÃO chama PUT /products/:id — assim
      // alterações neste anúncio NÃO afetam os anúncios de outras contas nem
      // o produto compartilhado. Cada campo do form vira um override naquele
      // listing específico.
      if (listingContext) {
        // Para cada campo, só enviamos como override quando o valor difere
        // do produto. Caso contrário enviamos `null` (limpa override e o
        // anúncio volta a herdar do produto). Isso evita enviar `title`,
        // `attributes` etc. para o ML em anúncios que não permitem alterar
        // esses campos via PUT (autopeças/catálogo) — caso clássico de
        // BODY_INVALID_FIELDS.
        const diffStr = (
          newVal: string | null | undefined,
          productVal: string | null | undefined,
        ): string | null => {
          const a = newVal == null || newVal === "" ? null : String(newVal);
          const b =
            productVal == null || productVal === "" ? null : String(productVal);
          return a === b ? null : a;
        };
        const diffNum = (
          newVal: number | null | undefined,
          productVal: number | null | undefined,
        ): number | null => {
          const a = newVal == null ? null : Number(newVal);
          const b = productVal == null ? null : Number(productVal);
          return a === b ? null : a;
        };
        // Preço do anúncio zerado significa "herdar o preço do produto", nunca
        // "publicar por R$ 0" (o ML rejeita price=0). Um override <= 0 nunca é
        // persistido: vira null = herda.
        const diffPrice = (
          newVal: number | null | undefined,
          productVal: number | null | undefined,
        ): number | null => {
          const diff = diffNum(newVal, productVal);
          return diff !== null && diff > 0 ? diff : null;
        };
        const diffJson = (newVal: unknown, productVal: unknown): unknown => {
          try {
            return JSON.stringify(newVal ?? null) ===
              JSON.stringify(productVal ?? null)
              ? null
              : (newVal ?? null);
          } catch {
            return newVal ?? null;
          }
        };

        const productImages: string[] = Array.isArray(product.imageUrls)
          ? product.imageUrls
          : product.imageUrl
            ? [product.imageUrl]
            : [];
        const formImages: string[] = Array.isArray(data.imageUrls)
          ? data.imageUrls
          : [];

        const productCompatList = cleanData.compatibilities ?? [];

        // Settings ML: só vão no payload quando o usuário REALMENTE alterou.
        // Sem isso, o backend recebe shipping/warranty/sale_terms inalterados
        // e o ML rejeita com `field_not_modifiable` em anúncios com vendas.
        // Snapshot null no campo = listing não tinha baseline => não envia
        // (defesa: ML pode rejeitar setting "novo" em anúncio com vendas).
        const settingsSnap = mlSettingsSnapshotRef.current;
        const mlSettingsDiff: Record<string, unknown> = {};
        if (settingsSnap) {
          if (
            settingsSnap.listingType !== null &&
            mlListingType !== settingsSnap.listingType
          )
            mlSettingsDiff.listingType = mlListingType;
          if (
            settingsSnap.itemCondition !== null &&
            mlItemCondition !== settingsSnap.itemCondition
          )
            mlSettingsDiff.itemCondition = mlItemCondition;
          if (
            settingsSnap.hasWarranty !== null &&
            mlHasWarranty !== settingsSnap.hasWarranty
          )
            mlSettingsDiff.hasWarranty = mlHasWarranty;
          if (
            settingsSnap.warrantyUnit !== null &&
            mlWarrantyUnit !== settingsSnap.warrantyUnit
          )
            mlSettingsDiff.warrantyUnit = mlWarrantyUnit;
          if (
            settingsSnap.warrantyDuration !== null &&
            mlWarrantyDuration !== settingsSnap.warrantyDuration
          )
            mlSettingsDiff.warrantyDuration = mlWarrantyDuration;
          if (
            settingsSnap.shippingMode !== null &&
            mlShippingMode !== settingsSnap.shippingMode
          )
            mlSettingsDiff.shippingMode = mlShippingMode;
          if (
            settingsSnap.freeShipping !== null &&
            mlFreeShipping !== settingsSnap.freeShipping
          )
            mlSettingsDiff.freeShipping = mlFreeShipping;
          if (
            settingsSnap.localPickup !== null &&
            mlLocalPickup !== settingsSnap.localPickup
          )
            mlSettingsDiff.localPickup = mlLocalPickup;
          if (
            settingsSnap.manufacturingTime !== null &&
            mlManufacturingTime !== settingsSnap.manufacturingTime
          )
            mlSettingsDiff.manufacturingTime = mlManufacturingTime;
        }

        const overridesPayload: Record<string, unknown> = {
          // Campos do produto que viram overrides — apenas quando diferentes
          titleOverride: diffStr(data.name, product.name),
          descriptionOverride: diffStr(data.description, product.description),
          priceOverride: diffPrice(data.price, product.price),
          brandOverride: diffStr(cleanData.brand, product.brand),
          modelOverride: diffStr(cleanData.model, product.model),
          yearOverride: diffStr(cleanData.year, product.year),
          versionOverride: diffStr(cleanData.version, product.version),
          categoryOverride: diffStr(cleanData.category, product.category),
          mlCategoryOverride: diffStr(
            cleanData.mlCategory,
            product.mlCategory ?? product.mlCategoryId,
          ),
          shopeeCategoryOverride: diffStr(
            data.shopeeCategory,
            product.shopeeCategoryId,
          ),
          partNumberOverride: diffStr(cleanData.partNumber, product.partNumber),
          qualityOverride: diffStr(cleanData.quality, product.quality),
          heightCmOverride: diffNum(data.heightCm, product.heightCm),
          widthCmOverride: diffNum(data.widthCm, product.widthCm),
          lengthCmOverride: diffNum(data.lengthCm, product.lengthCm),
          weightKgOverride: diffNum(data.weightKg, product.weightKg),
          imageUrlsOverride: diffJson(formImages, productImages),
          attributesOverride: diffJson(data.attributes, product.attributes),
          compatibilitiesOverride: productCompatList,
          sourceVehicleOverride: diffStr(
            cleanData.sourceVehicle,
            product.sourceVehicle,
          ),
          // Settings ML: apenas os que mudaram desde a abertura do modal.
          ...mlSettingsDiff,
        };

        try {
          const respListing = await fetch(
            `${base}/listings/${listingContext.listingId}`,
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                email: session?.user?.email || "",
              },
              body: JSON.stringify(overridesPayload),
            },
          );
          const listingBody = await respListing.json().catch(() => ({}));
          if (!respListing.ok) {
            onToast(
              listingBody?.message ||
                listingBody?.error ||
                "Falha ao atualizar este anúncio.",
              "error",
            );
            onOpenChange(false);
            return;
          }

          // Backend pode retornar 200 com warning (ex.: ML bloqueou title
          // por family_name). O save foi bem-sucedido — alguns campos
          // foram aplicados no ML, outros ficaram só locais como override.
          if (listingBody?.warning) {
            invalidateListingsStatusCache(product.id);
            onToast(`Anúncio atualizado. ${listingBody.warning}`, "warning");
            onProductUpdated();
            onOpenChange(false);
            return;
          }
        } catch (err) {
          onToast(
            err instanceof Error
              ? `Erro ao atualizar este anúncio: ${err.message}`
              : "Erro ao atualizar este anúncio.",
            "error",
          );
          onOpenChange(false);
          return;
        }

        onToast(
          "Anúncio atualizado com sucesso (apenas esta conta foi afetada).",
          "success",
        );
        // Invalida cache do modal de listings — overrides mudaram.
        invalidateListingsStatusCache(product.id);
        // onProductUpdated dispara refresh da lista de produtos (que precisa
        // refletir overrides — embora o produto em si não tenha mudado).
        onProductUpdated();
        onOpenChange(false);
        return;
      }

      // Modo "editar produto" (sem listingContext): fluxo original — PUT no
      // produto + dispatcher. Aqui é onde editar produto afeta TODOS os anúncios.
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

      // Monta um único POST /listings/dispatch com todas as plataformas e contas.
      // O endpoint retorna 202 imediato (fire-and-forget) — sem timeout síncrono
      // de 60s por conta. O status final aparece na aba Anúncios conforme os
      // jobs terminam em background.
      const dispatchRequests: Array<{
        platform: "MERCADO_LIVRE" | "SHOPEE" | "MAGALU" | "OLX" | "FACEBOOK";
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

      // Magalu: envia a categoria escolhida (se houver); vazia → o backend
      // resolve automaticamente (mesmo comportamento do modal de criação).
      if (createMagaluListing && selectedMagaluAccounts.length > 0) {
        const magaluCategoryId = data.magaluCategory || undefined;
        for (const accountId of selectedMagaluAccounts) {
          dispatchRequests.push({
            platform: "MAGALU",
            accountId,
            categoryId: magaluCategoryId,
          });
        }
      }

      // OLX/Facebook: mesma semântica do Magalu — categoria opcional, vazia →
      // resolvida no backend no momento do envio.
      if (createOlxListing && selectedOlxAccounts.length > 0) {
        const olxCategoryId =
          data.olxCategory || product.olxCategoryId || undefined;
        for (const accountId of selectedOlxAccounts) {
          dispatchRequests.push({
            platform: "OLX",
            accountId,
            categoryId: olxCategoryId,
          });
        }
      }

      if (createFacebookListing && selectedFacebookAccounts.length > 0) {
        const facebookCategoryId =
          data.facebookCategory || product.fbCategory || undefined;
        for (const accountId of selectedFacebookAccounts) {
          dispatchRequests.push({
            platform: "FACEBOOK",
            accountId,
            categoryId: facebookCategoryId,
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
              crossAccountIncrease: crossAccountIncrease
                ? {
                    enabled: true,
                    percent: crossAccountPercent
                      ? Number(crossAccountPercent)
                      : undefined,
                  }
                : undefined,
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

      // Sumário do re-sync de anúncios EXISTENTES feito dentro do PUT
      // /products/:id (ProductUseCase.update → syncProductListings).
      // Mostra ao usuário quantos anúncios ML/Shopee receberam a alteração
      // e quais falharam, para que ele saiba que a edição se propagou.
      const syncResults: Array<{
        success?: boolean;
        externalListingId?: string;
        error?: string;
      }> = Array.isArray(result?.syncResults) ? result.syncResults : [];
      const synced = syncResults.filter((r) => r?.success).length;
      const failedItems = syncResults.filter((r) => !r?.success);
      const failedSummary = failedItems
        .slice(0, 3)
        .map(
          (r) =>
            `${r?.externalListingId || "?"}${
              r?.error ? `: ${r.error.slice(0, 80)}` : ""
            }`,
        )
        .join("; ");
      const moreFailed =
        failedItems.length > 3 ? ` (+${failedItems.length - 3})` : "";

      let summaryMsg = "Produto atualizado com sucesso!";
      let summaryType: "success" | "warning" | "error" = "success";
      if (syncResults.length > 0) {
        if (failedItems.length === 0) {
          summaryMsg = `Produto atualizado e ${synced} anúncio(s) sincronizado(s).`;
        } else if (synced > 0) {
          summaryMsg = `Produto atualizado. ${synced} anúncio(s) sincronizado(s); ${failedItems.length} falhou(aram): ${failedSummary}${moreFailed}.`;
          summaryType = "warning";
        } else {
          summaryMsg = `Produto atualizado, mas ${failedItems.length} anúncio(s) falhou(aram): ${failedSummary}${moreFailed}.`;
          summaryType = "warning";
        }
      }
      if (dispatched > 0) {
        summaryMsg += ` ${dispatched} novo(s) anúncio(s) em processamento — acompanhe na aba Anúncios.`;
      }

      onToast(summaryMsg, summaryType);
      // Invalida cache de listings — re-sync vai atualizar status/permalinks.
      invalidateListingsStatusCache(product.id);
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
      <DialogContent className="max-h-[90vh] min-w-0 overflow-y-auto p-4 sm:max-w-5xl sm:p-6">
        <DialogHeader>
          <DialogTitle>
            {listingContext
              ? `Editar anúncio · ${platformLabel(listingContext.platform)}`
              : "Editar Produto"}
          </DialogTitle>
          <DialogDescription>
            {listingContext
              ? `Conta ${listingContext.accountName}${
                  listingContext.externalListingId
                    ? ` · ${listingContext.externalListingId}`
                    : ""
                } — Produto "${product.name}"`
              : `Atualize os dados do produto "${product.name}"`}
          </DialogDescription>
        </DialogHeader>
        {listingContext && (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200">
            <strong>Edição isolada por conta.</strong> Tudo o que você alterar
            aqui vai afetar <em>apenas este anúncio</em> da conta{" "}
            <strong>{listingContext.accountName}</strong>. O produto
            compartilhado e os anúncios de outras contas continuam intactos.
            Para limpar uma personalização e voltar a herdar do produto, deixe o
            campo igual ao valor original do produto.
          </div>
        )}
        <form
          onSubmit={handleSubmit(onSubmit, (formErrors) => {
            const first = Object.values(formErrors)[0] as
              { message?: string } | undefined;
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

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              {product?.mlCatalogProductId && (
                <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-xs text-muted-foreground">
                  <span>
                    Vinculado ao catálogo Mercado Livre:{" "}
                    <span className="font-medium">
                      {product.mlCatalogProductId}
                    </span>
                  </span>
                  <a
                    href={`https://www.mercadolivre.com.br/p/${encodeURIComponent(
                      product.mlCatalogProductId,
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-primary"
                  >
                    Ver no ML
                  </a>
                </div>
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
                    onWarning={(warning) => onToast(warning, "warning")}
                  />
                )}
              />
              {errors.imageUrl && (
                <p className="text-sm text-destructive">
                  {errors.imageUrl.message}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Faça upload de uma nova foto ou mantenha a atual. Máximo 20MB,
                formatos: JPG, PNG, WebP.
              </p>
            </div>
          </div>

          {/* Seção: Preços e Estoque */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground">
              Preços e Estoque
            </h3>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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

              <div className="space-y-2">
                <Label htmlFor="edit-location">Localização</Label>
                {locationOptions.length > 0 ? (
                  <Controller
                    name="locationId"
                    control={control}
                    render={({ field }) => (
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <LocationCombobox
                            id="edit-location"
                            options={locationOptions}
                            value={field.value ?? null}
                            onChange={(locId, fullPath) => {
                              field.onChange(locId);
                              // Mantém o campo legado `location` (texto) em sincronia.
                              setValue("location", fullPath);
                            }}
                          />
                        </div>
                        <LocationScanButton
                          options={locationOptions}
                          currentLocationId={field.value ?? null}
                          onToast={onToast}
                          onResolved={({ id, fullPath }) => {
                            // Mesmo par de escrituras do onChange do combobox (FK + texto).
                            field.onChange(id);
                            setValue("location", fullPath);
                          }}
                        />
                      </div>
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

              {/* BLOCO J — vínculo de lote. Vizinho de "Veículo de Origem"
                  porque é a mesma pergunta ("de onde veio esta peça?"), mas
                  com endpoint, confirmação e efeito próprios. Flag OFF ⇒ nem
                  é montado: nenhum campo novo, nenhum request novo. */}
              {SCRAP_RELINK_UI_ENABLED && (
                <ScrapLinkSection
                  productId={product.id}
                  onToast={onToast}
                  onChanged={onProductUpdated}
                />
              )}

              {/* Medidas (cm / kg) */}
              <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-4">
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
                  positions={compatibilityPositions}
                  onPositionsChange={setCompatibilityPositions}
                />
              )}
            </CollapsibleContent>
          </Collapsible>

          {/* PublicaÃ§Ã£o de anÃºncios multi-contas (escondida no modo "editar anúncio") */}
          <div className="space-y-4 rounded-lg border p-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {listingContext
                  ? "Configurações deste anúncio"
                  : "Publicar anúncios"}
              </p>
              <p className="text-xs text-muted-foreground">
                {listingContext
                  ? `Os ajustes abaixo serão aplicados apenas neste anúncio · ${platformLabel(
                      listingContext.platform,
                    )}.`
                  : "Crie anúncios nas contas selecionadas."}
              </p>
            </div>

            <div className="space-y-2">
              {!listingContext && (
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
                </div>
              )}
              {!listingContext && createMlListing && (
                <>
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

                  {/* Aumento percentual escalonado entre contas (por marketplace).
                      O flag viaja top-level no dispatch, então vale para ML,
                      Shopee e Magalu — escada independente em cada um. Mostra o
                      controle quando QUALQUER marketplace tem 2+ contas. */}
                  {(mlAccounts.length > 1 ||
                    shopeeAccounts.length > 1 ||
                    magaluAccounts.length > 1 ||
                    olxAccounts.length > 1 ||
                    facebookAccounts.length > 1) && (
                    <div className="mt-2 space-y-2 rounded-md border p-3">
                      <label className="flex items-center justify-between gap-2 text-sm font-medium">
                        <span>
                          Aumentar percentual nas demais contas (por
                          marketplace)
                        </span>
                        <Switch
                          checked={crossAccountIncrease}
                          onCheckedChange={setCrossAccountIncrease}
                        />
                      </label>
                      {crossAccountIncrease && (
                        <div className="space-y-1">
                          <Label
                            htmlFor="edit-cross-account-percent"
                            className="text-xs text-muted-foreground"
                          >
                            Percentual de aumento composto entre contas
                          </Label>
                          <div className="relative w-40">
                            <Input
                              id="edit-cross-account-percent"
                              type="number"
                              inputMode="decimal"
                              min={0}
                              max={100}
                              step="0.01"
                              value={crossAccountPercent}
                              onChange={(e) =>
                                setCrossAccountPercent(e.target.value)
                              }
                              placeholder="Ex.: 10"
                              className="pr-7"
                            />
                            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                              %
                            </span>
                          </div>
                          <p className="text-[11px] leading-relaxed text-muted-foreground">
                            Aplicado em cascata e por marketplace: em cada um
                            (Mercado Livre, Shopee, Magalu), a 1ª conta
                            selecionada mantém o preço base e cada conta
                            seguinte recebe este % sobre o preço da anterior.
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Categoria ML (movida pra dentro do switch para só aparecer
                      quando o usuário decide criar anúncio ML — padrão Shopee). */}
                  <div className="mt-2 space-y-2">
                    <div>
                      <Label htmlFor="edit-category">
                        Categoria ML (top-level)
                      </Label>
                      <Controller
                        name="category"
                        control={control}
                        render={({ field }) => {
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
                                  ML_CATEGORY_OPTIONS.find(
                                    (c) => c.value === val,
                                  );
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
                    </div>

                    <div>
                      <Label>Categoria no Mercado Livre</Label>
                      <Controller
                        name="mlCategory"
                        control={control}
                        render={({ field }) => {
                          const selected = [
                            ...mlSuggestedOptions,
                            ...mlOptions,
                          ].find((o) => o.id === (field.value || ""));
                          const isLoading =
                            mlSuggestedOptions.length === 0 &&
                            mlOptions.length === 0;
                          return (
                            <Popover
                              open={mlLeafSelectOpen}
                              onOpenChange={(isOpen) => {
                                setMlLeafSelectOpen(isOpen);
                                if (isOpen) void fetchMlCategories();
                              }}
                              modal
                            >
                              <PopoverTrigger asChild>
                                <Button
                                  type="button"
                                  variant="outline"
                                  role="combobox"
                                  aria-expanded={mlLeafSelectOpen}
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
                                  width: "var(--radix-popover-trigger-width)",
                                  maxHeight: 360,
                                }}
                              >
                                <Command>
                                  <CommandInput placeholder="Pesquisar categoria..." />
                                  <CommandList>
                                    <CommandEmpty>
                                      Nenhuma categoria encontrada.
                                    </CommandEmpty>
                                    {mlSuggestedOptions.length > 0 && (
                                      <CommandGroup heading="Sugeridas pelo título">
                                        {mlSuggestedOptions.map((opt) => (
                                          <CommandItem
                                            key={`ml-sug-${opt.id}`}
                                            value={`${opt.value} ${opt.id}`}
                                            onSelect={() => {
                                              field.onChange(opt.id);
                                              setMlLeafSelectOpen(false);
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
                                    {mlOptions.length > 0 && (
                                      <CommandGroup heading="Todas as categorias">
                                        {mlOptions.map((opt) => (
                                          <CommandItem
                                            key={`ml-all-${opt.id}`}
                                            value={`${opt.value} ${opt.id}`}
                                            onSelect={() => {
                                              field.onChange(opt.id);
                                              setMlLeafSelectOpen(false);
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
                        Obrigatório para publicar no Mercado Livre. Use o campo
                        de busca para filtrar a lista.
                      </p>
                    </div>

                    {mlCategoryWarning && (
                      <p
                        className="text-xs text-destructive"
                        role="alert"
                        data-testid="ml-category-warning"
                      >
                        {mlCategoryWarning}
                      </p>
                    )}

                    <Controller
                      name="attributes"
                      control={control}
                      render={({ field }) => (
                        <MLDynamicAttributesSection
                          categoryId={watchMlCategory || ""}
                          value={(field.value as any) || {}}
                          onChange={(next) => field.onChange(next as any)}
                          email={session?.user?.email || undefined}
                        />
                      )}
                    />
                  </div>
                </>
              )}

              {/* Configurações do Anúncio ML */}
              {(createMlListing ||
                (listingContext &&
                  listingContext.platform === "MERCADO_LIVRE")) && (
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
                          <SelectItem value="gold_premium">Premium</SelectItem>
                          <SelectItem value="gold_special">Clássico</SelectItem>
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
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

            {!listingContext && (
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
                                  width: "var(--radix-popover-trigger-width)",
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
                        Obrigatório para publicar no Shopee. Use o campo de
                        busca para filtrar a lista. A categoria será persistida
                        no produto.
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}

            {!listingContext && MAGALU_ENABLED && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Switch
                    id="edit-create-magalu-listing"
                    checked={createMagaluListing}
                    onCheckedChange={setCreateMagaluListing}
                  />
                  <Label
                    htmlFor="edit-create-magalu-listing"
                    className="cursor-pointer"
                  >
                    Criar anúncio no Magalu
                  </Label>
                </div>
                {createMagaluListing && (
                  <>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {magaluAccounts.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Conecte ao menos uma conta do Magalu.
                        </p>
                      ) : (
                        magaluAccounts.map((acc) => (
                          <label
                            key={acc.id}
                            className="flex items-center justify-between rounded-md border p-2 text-sm"
                          >
                            <span>{acc.accountName || acc.id}</span>
                            <Switch
                              checked={selectedMagaluAccounts.includes(acc.id)}
                              onCheckedChange={(checked) =>
                                setSelectedMagaluAccounts((prev) =>
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
                    <div className="mt-2 space-y-1">
                      <Label htmlFor="magaluCategory">
                        Categoria no Magalu
                      </Label>
                      <Controller
                        name="magaluCategory"
                        control={control}
                        render={({ field }) => {
                          // path "A/B/C" → breadcrumb "A > B > C" (igual ML/Shopee).
                          const fmt = (v: string) =>
                            v
                              .split("/")
                              .map((s) => s.trim())
                              .filter(Boolean)
                              .join(" > ");
                          const rawLabel =
                            magaluSelectedLabel ||
                            magaluOptions.find((o) => o.id === field.value)
                              ?.value ||
                            "";
                          const selectedLabel = rawLabel ? fmt(rawLabel) : "";
                          const term = magaluCategorySearch.trim();
                          return (
                            <div className="relative">
                              {selectedLabel && !magaluCategoryDropdownOpen && (
                                <div
                                  className="flex cursor-pointer items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-accent"
                                  onClick={() => {
                                    setMagaluCategoryDropdownOpen(true);
                                    setMagaluCategorySearch("");
                                  }}
                                >
                                  <span className="truncate">
                                    {selectedLabel}
                                  </span>
                                  <span className="ml-2 text-xs text-muted-foreground">
                                    Alterar
                                  </span>
                                </div>
                              )}
                              {(magaluCategoryDropdownOpen ||
                                !selectedLabel) && (
                                <>
                                  <Input
                                    placeholder="Buscar categoria do Magalu..."
                                    value={magaluCategorySearch}
                                    onChange={(e) =>
                                      setMagaluCategorySearch(e.target.value)
                                    }
                                    onBlur={() => {
                                      setTimeout(
                                        () =>
                                          setMagaluCategoryDropdownOpen(false),
                                        200,
                                      );
                                    }}
                                    autoFocus={magaluCategoryDropdownOpen}
                                  />
                                  {term && magaluOptions.length > 0 && (
                                    <div className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-background shadow-md">
                                      {magaluOptions.map((o) => (
                                        <button
                                          type="button"
                                          key={o.id}
                                          className={`w-full px-3 py-2 text-left text-sm hover:bg-accent ${
                                            o.id === field.value
                                              ? "bg-accent font-medium"
                                              : ""
                                          }`}
                                          onMouseDown={(e) => {
                                            e.preventDefault();
                                            field.onChange(o.id);
                                            setMagaluSelectedLabel(o.value);
                                            setMagaluCategorySearch("");
                                            setMagaluCategoryDropdownOpen(
                                              false,
                                            );
                                          }}
                                        >
                                          {fmt(o.value)}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                  {term &&
                                    !magaluCategoryLoading &&
                                    magaluOptions.length === 0 && (
                                      <div className="absolute z-50 mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground shadow-md">
                                        Nenhuma categoria encontrada
                                      </div>
                                    )}
                                  {magaluCategoryLoading && (
                                    <div className="absolute z-50 mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground shadow-md">
                                      Buscando…
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          );
                        }}
                      />
                      <p className="text-xs text-muted-foreground">
                        Opcional — se vazio, a categoria é resolvida
                        automaticamente no Magalu.
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}

            {!listingContext && OLX_ENABLED && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Switch
                    id="edit-create-olx-listing"
                    checked={createOlxListing}
                    onCheckedChange={setCreateOlxListing}
                  />
                  <Label
                    htmlFor="edit-create-olx-listing"
                    className="cursor-pointer"
                  >
                    Criar anúncio na OLX
                  </Label>
                </div>
                {createOlxListing && (
                  <>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {olxAccounts.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Conecte ao menos uma conta da OLX.
                        </p>
                      ) : (
                        olxAccounts.map((acc) => (
                          <label
                            key={acc.id}
                            className="flex items-center justify-between rounded-md border p-2 text-sm"
                          >
                            <span>{acc.accountName || acc.id}</span>
                            <Switch
                              checked={selectedOlxAccounts.includes(acc.id)}
                              onCheckedChange={(checked) =>
                                setSelectedOlxAccounts((prev) =>
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
                    <div className="mt-2 space-y-1">
                      <Label htmlFor="olxCategory">Categoria na OLX</Label>
                      <Controller
                        name="olxCategory"
                        control={control}
                        render={({ field }) => {
                          const fmt = (v: string) =>
                            v
                              .split("/")
                              .map((s) => s.trim())
                              .filter(Boolean)
                              .join(" > ");
                          const rawLabel =
                            olxSelectedLabel ||
                            olxOptions.find((o) => o.id === field.value)
                              ?.value ||
                            "";
                          const selectedLabel = rawLabel ? fmt(rawLabel) : "";
                          const term = olxCategorySearch.trim();
                          return (
                            <div className="relative">
                              {selectedLabel && !olxCategoryDropdownOpen && (
                                <div
                                  className="flex cursor-pointer items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-accent"
                                  onClick={() => {
                                    setOlxCategoryDropdownOpen(true);
                                    setOlxCategorySearch("");
                                  }}
                                >
                                  <span className="truncate">
                                    {selectedLabel}
                                  </span>
                                  <span className="ml-2 text-xs text-muted-foreground">
                                    Alterar
                                  </span>
                                </div>
                              )}
                              {(olxCategoryDropdownOpen || !selectedLabel) && (
                                <>
                                  <Input
                                    placeholder="Buscar categoria da OLX..."
                                    value={olxCategorySearch}
                                    onChange={(e) =>
                                      setOlxCategorySearch(e.target.value)
                                    }
                                    onBlur={() => {
                                      setTimeout(
                                        () => setOlxCategoryDropdownOpen(false),
                                        200,
                                      );
                                    }}
                                    autoFocus={olxCategoryDropdownOpen}
                                  />
                                  {term && olxOptions.length > 0 && (
                                    <div className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-background shadow-md">
                                      {olxOptions.map((o) => (
                                        <button
                                          type="button"
                                          key={o.id}
                                          className={`w-full px-3 py-2 text-left text-sm hover:bg-accent ${
                                            o.id === field.value
                                              ? "bg-accent font-medium"
                                              : ""
                                          }`}
                                          onMouseDown={(e) => {
                                            e.preventDefault();
                                            field.onChange(o.id);
                                            setOlxSelectedLabel(o.value);
                                            setOlxCategorySearch("");
                                            setOlxCategoryDropdownOpen(false);
                                          }}
                                        >
                                          {fmt(o.value)}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                  {term &&
                                    !olxCategoryLoading &&
                                    olxOptions.length === 0 && (
                                      <div className="absolute z-50 mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground shadow-md">
                                        Nenhuma categoria encontrada
                                      </div>
                                    )}
                                  {olxCategoryLoading && (
                                    <div className="absolute z-50 mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground shadow-md">
                                      Buscando…
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          );
                        }}
                      />
                      <p className="text-xs text-muted-foreground">
                        Opcional — se vazio, a categoria é resolvida
                        automaticamente na OLX.
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}

            {!listingContext && FACEBOOK_ENABLED && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Switch
                    id="edit-create-facebook-listing"
                    checked={createFacebookListing}
                    onCheckedChange={setCreateFacebookListing}
                  />
                  <Label
                    htmlFor="edit-create-facebook-listing"
                    className="cursor-pointer"
                  >
                    Criar anúncio no Facebook
                  </Label>
                </div>
                {createFacebookListing && (
                  <>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {facebookAccounts.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Conecte ao menos uma conta do Facebook.
                        </p>
                      ) : (
                        facebookAccounts.map((acc) => (
                          <label
                            key={acc.id}
                            className="flex items-center justify-between rounded-md border p-2 text-sm"
                          >
                            <span>{acc.accountName || acc.id}</span>
                            <Switch
                              checked={selectedFacebookAccounts.includes(
                                acc.id,
                              )}
                              onCheckedChange={(checked) =>
                                setSelectedFacebookAccounts((prev) =>
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
                    <div className="mt-2 space-y-1">
                      <Label htmlFor="facebookCategory">
                        Categoria no Facebook
                      </Label>
                      <Controller
                        name="facebookCategory"
                        control={control}
                        render={({ field }) => {
                          const fmt = (v: string) =>
                            v
                              .split("/")
                              .map((s) => s.trim())
                              .filter(Boolean)
                              .join(" > ");
                          const rawLabel =
                            facebookSelectedLabel ||
                            facebookOptions.find((o) => o.id === field.value)
                              ?.value ||
                            "";
                          const selectedLabel = rawLabel ? fmt(rawLabel) : "";
                          const term = facebookCategorySearch.trim();
                          return (
                            <div className="relative">
                              {selectedLabel &&
                                !facebookCategoryDropdownOpen && (
                                  <div
                                    className="flex cursor-pointer items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-accent"
                                    onClick={() => {
                                      setFacebookCategoryDropdownOpen(true);
                                      setFacebookCategorySearch("");
                                    }}
                                  >
                                    <span className="truncate">
                                      {selectedLabel}
                                    </span>
                                    <span className="ml-2 text-xs text-muted-foreground">
                                      Alterar
                                    </span>
                                  </div>
                                )}
                              {(facebookCategoryDropdownOpen ||
                                !selectedLabel) && (
                                <>
                                  <Input
                                    placeholder="Buscar categoria do Facebook..."
                                    value={facebookCategorySearch}
                                    onChange={(e) =>
                                      setFacebookCategorySearch(e.target.value)
                                    }
                                    onBlur={() => {
                                      setTimeout(
                                        () =>
                                          setFacebookCategoryDropdownOpen(
                                            false,
                                          ),
                                        200,
                                      );
                                    }}
                                    autoFocus={facebookCategoryDropdownOpen}
                                  />
                                  {term && facebookOptions.length > 0 && (
                                    <div className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-background shadow-md">
                                      {facebookOptions.map((o) => (
                                        <button
                                          type="button"
                                          key={o.id}
                                          className={`w-full px-3 py-2 text-left text-sm hover:bg-accent ${
                                            o.id === field.value
                                              ? "bg-accent font-medium"
                                              : ""
                                          }`}
                                          onMouseDown={(e) => {
                                            e.preventDefault();
                                            field.onChange(o.id);
                                            setFacebookSelectedLabel(o.value);
                                            setFacebookCategorySearch("");
                                            setFacebookCategoryDropdownOpen(
                                              false,
                                            );
                                          }}
                                        >
                                          {fmt(o.value)}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                  {term &&
                                    !facebookCategoryLoading &&
                                    facebookOptions.length === 0 && (
                                      <div className="absolute z-50 mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground shadow-md">
                                        Nenhuma categoria encontrada
                                      </div>
                                    )}
                                  {facebookCategoryLoading && (
                                    <div className="absolute z-50 mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground shadow-md">
                                      Buscando…
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          );
                        }}
                      />
                      <p className="text-xs text-muted-foreground">
                        Opcional — se vazio, a categoria é resolvida
                        automaticamente no Facebook.
                      </p>
                      {/* Mesmo motivo do modal de criação: o rótulo é tradução
                          nossa, o valor é o caminho da taxonomia do Google. */}
                      {watch("facebookCategory") ? (
                        <p className="text-[11px] text-muted-foreground/80">
                          Enviado à Meta:{" "}
                          <span className="font-mono">
                            {watch("facebookCategory")}
                          </span>
                        </p>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            )}
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
