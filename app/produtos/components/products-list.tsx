"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  Filter,
  Loader2,
  Megaphone,
  Package,
  Pause,
  PauseCircle,
  Pencil,
  Play,
  QrCode,
  Search,
  Trash2,
} from "lucide-react";
import { useSession } from "next-auth/react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  MARKETPLACE_LISTING_PLATFORMS,
  resolveMarketplaceListingLinkState,
  type MarketplaceListingLinkInput,
  type MarketplaceListingPlatform,
} from "@/app/lib/marketplace-listing-links";
import { getApiBaseUrl } from "@/lib/api";
import { generateLabelsPdf } from "@/app/produtos/lib/labels-pdf";
import {
  DEFAULT_PRODUCT_FILTERS,
  ProductFilterMarketplace,
  ProductFilterPublicationStatus,
  ProductFilterQuality,
  ProductFiltersState,
  ProductPublishedCategoryOption,
  ProductFilterStockStatus,
  filterPublishedCategories,
  getCompatibleListingCategoryValue,
  hasActiveProductFilters,
  serializeProductFilters,
} from "@/app/produtos/lib/product-filters";
import {
  BulkListingWizard,
  type BulkListingProduct,
} from "./bulk-listing-wizard";
import { CreateProductDialog } from "./create-product-dialog";
import {
  EditProductDialog,
  type EditProductDialogListingContext,
} from "./edit-product-dialog";
import { ImportExportProducts } from "./import-export-products";
import { ImportNfeXml } from "./import-nfe-xml";
import { MarketplaceListingsDialog } from "./marketplace-listings-dialog";
import { ProductDetailSheet } from "./product-detail-sheet";
import { ImageLightbox } from "./image-lightbox";
import { ProductSkeleton } from "./product-skeleton";
import {
  BulkDeleteResultModal,
  type BulkDeleteProductResultView,
} from "./bulk-delete-result-modal";

const BULK_DELETE_CHUNK_SIZE = 50;

interface BulkDeleteResponseBody {
  results: BulkDeleteProductResultView[];
  summary: { total: number; deleted: number; failed: number };
}

type MarketplacePlatform = MarketplaceListingPlatform;
type ProductListing = MarketplaceListingLinkInput & {
  accountIds: string[];
  categoryId?: string;
};
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
  costPrice?: number | null;
  markup?: number | null;
  brand?: string | null;
  model?: string | null;
  year?: string | null;
  version?: string | null;
  category?: string | null;
  location?: string | null;
  locationId?: string | null;
  locationPath?: string | null; // caminho completo (read-only, vem enriquecido do backend)
  partNumber?: string | null;
  quality?: Quality | null;
  isSecurityItem?: boolean;
  isTraceable?: boolean;
  sourceVehicle?: string | null;
  imageUrl?: string | null;
  imageUrls?: string[] | null;
  mlCategoryId?: string | null;
  shopeeCategoryId?: string | null;
  productLocation?: {
    id: string;
    code: string;
    description?: string | null;
  } | null;
  listings?: ProductListing[];
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "warning";
}

interface LocationOption {
  id: string;
  code: string;
  description?: string;
  fullPath: string;
  maxCapacity: number;
  productsCount: number;
  isFull: boolean;
}

interface ProductFilterOptionsResponse {
  brands: string[];
  publishedCategories: ProductPublishedCategoryOption[];
}

const SELECT_ALL_VALUE = "all";
const STATIC_FILTER_CACHE_TTL_MS = 15_000;

type TimedCacheEntry<T> = {
  data: T;
  expiresAt: number;
};

const MARKETPLACE_ICONS: Record<
  MarketplacePlatform,
  { label: string; src: string }
> = {
  MERCADO_LIVRE: {
    label: "Mercado Livre",
    src: "/marketplaces/mercado-livre.svg",
  },
  SHOPEE: {
    label: "Shopee",
    src: "/marketplaces/shopee.svg",
  },
};

const PUBLICATION_STATUS_OPTIONS: Array<{
  value: ProductFilterPublicationStatus;
  label: string;
}> = [
  { value: "ACTIVE", label: "Ativo" },
  { value: "PAUSED", label: "Pausado" },
  { value: "PENDING", label: "Pendente" },
  { value: "ERROR", label: "Erro" },
  { value: "CLOSED", label: "Encerrado" },
  { value: "NO_LISTING", label: "Sem anúncio" },
];

const STOCK_STATUS_OPTIONS: Array<{
  value: ProductFilterStockStatus;
  label: string;
}> = [
  { value: "IN_STOCK", label: "Com estoque" },
  { value: "OUT_OF_STOCK", label: "Sem estoque" },
  { value: "LOW_STOCK", label: "Estoque baixo" },
];

const MARKETPLACE_OPTIONS: Array<{
  value: ProductFilterMarketplace;
  label: string;
}> = [
  { value: "BOTH", label: "Todos os canais" },
  { value: "MERCADO_LIVRE", label: "Mercado Livre" },
  { value: "SHOPEE", label: "Shopee" },
];

const QUALITY_OPTIONS: Array<{
  value: ProductFilterQuality;
  label: string;
}> = [
  { value: "SUCATA", label: "Sucata" },
  { value: "SEMINOVO", label: "Seminovo" },
  { value: "NOVO", label: "Novo" },
  { value: "RECONDICIONADO", label: "Recondicionado" },
];

const locationOptionsCache = new Map<
  string,
  TimedCacheEntry<LocationOption[]>
>();
const locationOptionsInFlight = new Map<string, Promise<LocationOption[]>>();
const productFilterOptionsCache = new Map<
  string,
  TimedCacheEntry<ProductFilterOptionsResponse>
>();
const productFilterOptionsInFlight = new Map<
  string,
  Promise<ProductFilterOptionsResponse>
>();
const productFilterOptionsCacheEpoch = new Map<string, number>();

function getCachedValue<T>(
  cache: Map<string, TimedCacheEntry<T>>,
  key: string,
) {
  const entry = cache.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return entry.data;
}

function setCachedValue<T>(
  cache: Map<string, TimedCacheEntry<T>>,
  key: string,
  data: T,
) {
  cache.set(key, {
    data,
    expiresAt: Date.now() + STATIC_FILTER_CACHE_TTL_MS,
  });

  return data;
}

function invalidateProductFilterOptionsCache(email?: string | null) {
  if (!email) return;
  productFilterOptionsCache.delete(email);
  productFilterOptionsInFlight.delete(email);
  productFilterOptionsCacheEpoch.set(
    email,
    (productFilterOptionsCacheEpoch.get(email) ?? 0) + 1,
  );
}

function getCacheEpoch(cache: Map<string, number>, key: string) {
  return cache.get(key) ?? 0;
}

async function loadLocationOptions(email: string, force = false) {
  if (!force) {
    const cached = getCachedValue(locationOptionsCache, email);
    if (cached) return cached;

    const inFlight = locationOptionsInFlight.get(email);
    if (inFlight) return inFlight;
  }

  const request = (async () => {
    const response = await fetch(`${getApiBaseUrl()}/locations/select`, {
      headers: { email },
    });

    if (!response.ok) {
      throw new Error("Erro ao carregar localizações");
    }

    const data = await response.json();
    return setCachedValue(
      locationOptionsCache,
      email,
      Array.isArray(data.locations) ? data.locations : [],
    );
  })().finally(() => {
    if (locationOptionsInFlight.get(email) === request) {
      locationOptionsInFlight.delete(email);
    }
  });

  locationOptionsInFlight.set(email, request);
  return request;
}

async function loadProductFilterOptions(email: string, force = false) {
  const requestEpoch = force
    ? getCacheEpoch(productFilterOptionsCacheEpoch, email) + 1
    : getCacheEpoch(productFilterOptionsCacheEpoch, email);

  if (force) {
    productFilterOptionsCacheEpoch.set(email, requestEpoch);
  }

  if (!force) {
    const cached = getCachedValue(productFilterOptionsCache, email);
    if (cached) return cached;

    const inFlight = productFilterOptionsInFlight.get(email);
    if (inFlight) return inFlight;
  }

  const request = (async () => {
    const response = await fetch(`${getApiBaseUrl()}/products/filter-options`, {
      headers: { email },
    });

    if (!response.ok) {
      throw new Error("Erro ao carregar opções de filtro");
    }

    const data = (await response.json()) as ProductFilterOptionsResponse;
    const normalizedData = {
      brands: Array.isArray(data.brands) ? data.brands : [],
      publishedCategories: Array.isArray(data.publishedCategories)
        ? data.publishedCategories
        : [],
    };

    if (getCacheEpoch(productFilterOptionsCacheEpoch, email) === requestEpoch) {
      setCachedValue(productFilterOptionsCache, email, normalizedData);
    }

    return normalizedData;
  })().finally(() => {
    if (productFilterOptionsInFlight.get(email) === request) {
      productFilterOptionsInFlight.delete(email);
    }
  });

  productFilterOptionsInFlight.set(email, request);
  return request;
}

type ProductPauseState =
  | "all-active"
  | "all-paused"
  | "mixed"
  | "no-actionable";

// Considera "ativo" os mesmos statuses que ACTIVE_LISTING_STATUSES de
// app/lib/marketplace-listing-links.ts ("active" e "normal"). "paused"/"unlist"
// contam como pausado. Outros (closed, under_review, error) caem em no-actionable.
function computeProductPauseState(
  listings: Product["listings"],
): ProductPauseState {
  if (!listings || listings.length === 0) return "no-actionable";

  const publishable = listings.filter(
    (l) =>
      l.externalListingId && !l.externalListingId.startsWith("PENDING_"),
  );

  if (publishable.length === 0) return "no-actionable";

  let active = 0;
  let paused = 0;
  for (const l of publishable) {
    const s = l.status?.toLowerCase();
    if (s === "active" || s === "normal") active++;
    else if (s === "paused" || s === "unlist") paused++;
  }

  if (active === publishable.length) return "all-active";
  if (paused === publishable.length) return "all-paused";
  if (active > 0 && paused > 0) return "mixed";

  return "no-actionable";
}

function PauseListingsButton({
  product,
  state,
  isPausing,
  onTogglePause,
}: {
  product: Product;
  state: ProductPauseState;
  isPausing: boolean;
  onTogglePause: (product: Product, status: "active" | "paused") => void;
}) {
  if (state === "no-actionable") return null;

  if (state === "mixed") {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Pausar/Despausar anúncios"
            disabled={isPausing}
          >
            {isPausing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <PauseCircle className="size-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onTogglePause(product, "paused")}>
            <Pause className="mr-2 size-4" />
            Pausar todos
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onTogglePause(product, "active")}>
            <Play className="mr-2 size-4" />
            Despausar todos
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const targetStatus: "active" | "paused" =
    state === "all-active" ? "paused" : "active";
  const Icon = state === "all-active" ? Pause : Play;
  const title = state === "all-active" ? "Pausar anúncios" : "Despausar anúncios";
  const confirmLabel = state === "all-active" ? "Pausar" : "Despausar";
  const description =
    state === "all-active"
      ? `Pausar todos os anúncios publicados de "${product.name}"? Eles ficarão invisíveis nos marketplaces até serem despausados.`
      : `Reativar todos os anúncios publicados de "${product.name}"? Eles voltarão a aparecer nos marketplaces.`;

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          title={title}
          disabled={isPausing}
        >
          {isPausing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Icon className="size-4" />
          )}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{`${confirmLabel} anúncios?`}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={() => onTogglePause(product, targetStatus)}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MarketplaceBadges({
  listings,
  size = "md",
  onOpenListings,
}: {
  listings?: Product["listings"];
  size?: "sm" | "md";
  onOpenListings?: (platform: MarketplacePlatform) => void;
}) {
  const groupedByPlatform = useMemo(() => {
    const map = new Map<
      MarketplacePlatform,
      { count: number; anyOpenable: boolean }
    >();

    for (const listing of listings ?? []) {
      if (!listing) continue;
      const platform = listing.platform as MarketplacePlatform | undefined;
      if (!platform || !MARKETPLACE_LISTING_PLATFORMS.includes(platform)) {
        continue;
      }
      const current = map.get(platform) ?? { count: 0, anyOpenable: false };
      current.count += 1;
      if (
        !current.anyOpenable &&
        resolveMarketplaceListingLinkState(listing).isOpenable
      ) {
        current.anyOpenable = true;
      }
      map.set(platform, current);
    }

    return MARKETPLACE_LISTING_PLATFORMS.flatMap((platform) => {
      const entry = map.get(platform);
      return entry ? [{ platform, ...entry }] : [];
    });
  }, [listings]);

  if (groupedByPlatform.length === 0) return null;

  const imgClass = size === "sm" ? "h-4 w-auto" : "h-5 w-auto";
  const chipClass =
    size === "sm"
      ? "inline-flex items-center gap-1 rounded-full border bg-muted/60 px-2 py-[2px]"
      : "inline-flex items-center gap-1 rounded-full border bg-muted/60 px-2.5 py-1";
  const interactiveClass =
    "transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";
  const dimmedClass = "opacity-60";

  return (
    <div className="flex items-center gap-2">
      {groupedByPlatform.map(({ platform, count, anyOpenable }) => {
        const icon = MARKETPLACE_ICONS[platform];
        const title =
          count > 1
            ? `${count} anúncios publicados no ${icon.label}`
            : `Anúncio publicado no ${icon.label}`;

        return (
          <button
            key={platform}
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpenListings?.(platform);
            }}
            className={`${chipClass} ${interactiveClass} ${
              anyOpenable ? "" : dimmedClass
            }`}
            title={title}
            aria-label={title}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={icon.src} alt={icon.label} className={imgClass} />
            {count > 1 && (
              <span className="text-xs font-medium leading-none text-muted-foreground">
                {count}
              </span>
            )}
            <span className="sr-only">{icon.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ProductsList() {
  const { data: session, status } = useSession();
  const [products, setProducts] = useState<Product[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 0,
  });
  const [searchInput, setSearchInput] = useState("");
  const [filters, setFilters] = useState<ProductFiltersState>(
    DEFAULT_PRODUCT_FILTERS,
  );
  const [brandOptions, setBrandOptions] = useState<string[]>([]);
  const [publishedCategoryOptions, setPublishedCategoryOptions] = useState<
    ProductPublishedCategoryOption[]
  >([]);
  const [locationOptions, setLocationOptions] = useState<LocationOption[]>([]);
  const [isLoadingFilterOptions, setIsLoadingFilterOptions] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isGeneratingLabels, setIsGeneratingLabels] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [bulkDeleteProgress, setBulkDeleteProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [bulkDeleteResult, setBulkDeleteResult] = useState<{
    open: boolean;
    results: BulkDeleteProductResultView[];
    summary: { total: number; deleted: number; failed: number };
    productNames: Record<string, string>;
  } | null>(null);
  const [pausingIds, setPausingIds] = useState<Set<string>>(() => new Set());
  const [isBulkPausing, setIsBulkPausing] = useState(false);
  const [bulkPauseProgress, setBulkPauseProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [bulkListingOpen, setBulkListingOpen] = useState(false);
  const [isBulkListing, setIsBulkListing] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingListingContext, setEditingListingContext] =
    useState<EditProductDialogListingContext | null>(null);
  const [listingsDialog, setListingsDialog] = useState<{
    product: Product;
    platform: MarketplaceListingPlatform;
  } | null>(null);
  const [viewProduct, setViewProduct] = useState<Product | null>(null);
  const [lightboxProduct, setLightboxProduct] = useState<{
    images: string[];
    alt: string;
  } | null>(null);

  const openProductLightbox = (product: Product) => {
    const seen = new Set<string>();
    const images: string[] = [];
    if (product.imageUrl) {
      seen.add(product.imageUrl);
      images.push(product.imageUrl);
    }
    for (const url of product.imageUrls ?? []) {
      if (url && !seen.has(url)) {
        seen.add(url);
        images.push(url);
      }
    }
    if (images.length === 0) return;
    setLightboxProduct({ images, alt: product.name });
  };
  const locationOptionsRequestIdRef = useRef(0);
  const filterOptionsRequestIdRef = useRef(0);
  const productsRequestIdRef = useRef(0);
  const productsAbortControllerRef = useRef<AbortController | null>(null);
  const pageSizeRef = useRef(10);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((prev) => {
        const nextSearch = searchInput.trim();
        return prev.search === nextSearch
          ? prev
          : { ...prev, search: nextSearch };
      });
    }, 250);

    return () => clearTimeout(timer);
  }, [searchInput]);

  const showToast = useCallback(
    (message: string, type: "success" | "error" | "warning") => {
      const id = crypto.randomUUID();
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
      }, 4000);
    },
    [],
  );

  const fetchLocationOptions = useCallback(
    async (force = false) => {
      const email = session?.user?.email;
      if (!email) return;

      const requestId = locationOptionsRequestIdRef.current + 1;
      locationOptionsRequestIdRef.current = requestId;

      try {
        const options = await loadLocationOptions(email, force);
        if (requestId !== locationOptionsRequestIdRef.current) {
          return;
        }

        startTransition(() => {
          setLocationOptions(options);
        });
      } catch (error) {
        console.error("Erro ao carregar localizações para filtros:", error);
      }
    },
    [session?.user?.email],
  );

  useEffect(() => {
    fetchLocationOptions();
  }, [fetchLocationOptions]);

  const fetchFilterOptions = useCallback(
    async (force = false) => {
      const email = session?.user?.email;
      if (status === "loading") return;
      if (!email) {
        setIsLoadingFilterOptions(false);
        return;
      }

      const requestId = filterOptionsRequestIdRef.current + 1;
      filterOptionsRequestIdRef.current = requestId;

      setIsLoadingFilterOptions(true);
      try {
        const data = await loadProductFilterOptions(email, force);
        if (requestId !== filterOptionsRequestIdRef.current) {
          return;
        }

        startTransition(() => {
          setBrandOptions(data.brands);
          setPublishedCategoryOptions(data.publishedCategories);
        });
      } catch (error) {
        console.error("Erro ao carregar opcoes de filtro de produtos:", error);
      } finally {
        if (requestId === filterOptionsRequestIdRef.current) {
          setIsLoadingFilterOptions(false);
        }
      }
    },
    [session?.user?.email, status],
  );

  useEffect(() => {
    fetchFilterOptions();
  }, [fetchFilterOptions]);

  const fetchProducts = useCallback(
    async (
      page: number = 1,
      activeFilters: ProductFiltersState = DEFAULT_PRODUCT_FILTERS,
    ) => {
      const email = session?.user?.email;
      if (status === "loading") return;
      if (!email) {
        setIsBootstrapping(false);
        return;
      }

      const requestId = productsRequestIdRef.current + 1;
      productsRequestIdRef.current = requestId;
      productsAbortControllerRef.current?.abort();
      const controller = new AbortController();
      productsAbortControllerRef.current = controller;

      setIsFetching(true);
      try {
        const params = serializeProductFilters(activeFilters, {
          page,
          limit: pageSizeRef.current,
        });
        const response = await fetch(`${getApiBaseUrl()}/products?${params}`, {
          headers: { email },
          signal: controller.signal,
        });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Erro ao buscar produtos");
        }

        if (
          controller.signal.aborted ||
          requestId !== productsRequestIdRef.current
        ) {
          return;
        }

        startTransition(() => {
          setProducts(data.products);
          setPagination(data.pagination);
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        showToast(
          error instanceof Error ? error.message : "Erro ao buscar produtos",
          "error",
        );
      } finally {
        if (requestId === productsRequestIdRef.current) {
          setIsFetching(false);
          setIsBootstrapping(false);
        }

        if (productsAbortControllerRef.current === controller) {
          productsAbortControllerRef.current = null;
        }
      }
    },
    [session?.user?.email, showToast, status],
  );

  useEffect(() => {
    fetchProducts(1, filters);
  }, [fetchProducts, filters]);

  useEffect(() => {
    return () => {
      productsAbortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const visibleIds = new Set(products.map((product) => product.id));
    setSelectedIds((prev) => prev.filter((id) => visibleIds.has(id)));
  }, [products]);

  const availablePublishedCategories = useMemo(
    () =>
      filterPublishedCategories(
        publishedCategoryOptions,
        filters.marketplace || undefined,
      ),
    [publishedCategoryOptions, filters.marketplace],
  );

  const isPublishedCategoryDisabled =
    isLoadingFilterOptions || availablePublishedCategories.length === 0;

  const publishedCategoryPlaceholder = isLoadingFilterOptions
    ? "Carregando categorias publicadas"
    : availablePublishedCategories.length > 0
      ? filters.marketplace === "MERCADO_LIVRE"
        ? "Todas as categorias do Mercado Livre"
        : filters.marketplace === "SHOPEE"
          ? "Todas as categorias da Shopee"
          : filters.marketplace === "BOTH"
            ? "Todas as categorias dos dois canais"
            : "Todas as categorias publicadas"
      : "Nenhuma categoria publicada";

  const publishedCategoryAllLabel =
    filters.marketplace === "MERCADO_LIVRE"
      ? "Todas as categorias do Mercado Livre"
      : filters.marketplace === "SHOPEE"
        ? "Todas as categorias da Shopee"
        : filters.marketplace === "BOTH"
          ? "Todas as categorias dos dois canais"
          : "Todas as categorias publicadas";

  useEffect(() => {
    const compatibleListingCategory = getCompatibleListingCategoryValue(
      filters.listingCategory,
      publishedCategoryOptions,
      filters.marketplace || undefined,
    );

    if (compatibleListingCategory === filters.listingCategory) {
      return;
    }

    setFilters((prev) =>
      prev.listingCategory === compatibleListingCategory
        ? prev
        : { ...prev, listingCategory: compatibleListingCategory },
    );
  }, [filters.listingCategory, filters.marketplace, publishedCategoryOptions]);

  const updateFilter = useCallback(function updateFilterValue<
    K extends keyof ProductFiltersState,
  >(key: K, value: ProductFiltersState[K]) {
    setFilters((prev) =>
      prev[key] === value ? prev : { ...prev, [key]: value },
    );
  }, []);

  const clearFilters = () => {
    setSearchInput("");
    setFilters(DEFAULT_PRODUCT_FILTERS);
    setSelectedIds([]);
  };

  const handlePageChange = (newPage: number) => {
    setSelectedIds([]);
    fetchProducts(newPage, filters);
  };

  const handlePageSizeChange = (newSize: number) => {
    if (!Number.isFinite(newSize) || newSize <= 0) return;
    pageSizeRef.current = newSize;
    setPagination((prev) => ({ ...prev, limit: newSize, page: 1 }));
    setSelectedIds([]);
    fetchProducts(1, filters);
  };

  const handleDelete = async (id: string) => {
    const productName =
      products.find((p) => p.id === id)?.name ?? id;
    const previousProducts = products;
    const previousPagination = pagination;
    // Optimistic remove apenas até confirmar o resultado do servidor.
    setProducts((prev) => prev.filter((product) => product.id !== id));
    setPagination((prev) => ({ ...prev, total: Math.max(0, prev.total - 1) }));

    try {
      const response = await fetch(`${getApiBaseUrl()}/products/${id}`, {
        method: "DELETE",
        headers: {
          email: session?.user?.email || "",
        },
      });

      if (response.status === 409) {
        // Política estrita: produto NÃO foi removido porque algum anúncio
        // não pôde ser encerrado. Restaura UI e mostra o modal de
        // relatório com o produto único — permitindo reintentar.
        setProducts(previousProducts);
        setPagination(previousPagination);
        const data = (await response.json().catch(() => ({}))) as {
          message?: string;
          listingResults?: BulkDeleteProductResultView["listingResults"];
        };
        setBulkDeleteResult({
          open: true,
          results: [
            {
              productId: id,
              deleted: false,
              message:
                data.message ??
                "Anúncio não pôde ser encerrado no marketplace.",
              listingResults: data.listingResults ?? [],
            },
          ],
          summary: { total: 1, deleted: 0, failed: 1 },
          productNames: { [id]: productName },
        });
        return;
      }

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        setProducts(previousProducts);
        setPagination(previousPagination);
        throw new Error(
          data.error || data.message || "Erro ao excluir produto",
        );
      }

      showToast("Produto excluído com sucesso!", "success");
      invalidateProductFilterOptionsCache(session?.user?.email);
      fetchFilterOptions(true);
      if (previousProducts.length === 1 && pagination.page > 1) {
        fetchProducts(pagination.page - 1, filters);
      }
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Erro ao excluir produto",
        "error",
      );
    }
  };

  const handleTogglePause = async (
    product: Product,
    status: "active" | "paused",
  ) => {
    const id = product.id;
    const previousProducts = products;

    // Otimista: atualiza listings publicáveis para o novo status. Listings
    // PENDING_/sem externalListingId ficam intactos (espelha o filtro do backend).
    setProducts((prev) =>
      prev.map((p) =>
        p.id === id
          ? {
              ...p,
              listings: (p.listings ?? []).map((l) => {
                const publishable =
                  l.externalListingId &&
                  !l.externalListingId.startsWith("PENDING_");
                return publishable ? { ...l, status } : l;
              }),
            }
          : p,
      ),
    );
    setPausingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });

    try {
      const response = await fetch(
        `${getApiBaseUrl()}/products/${id}/listings-status`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            email: session?.user?.email || "",
          },
          body: JSON.stringify({ status }),
        },
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setProducts(previousProducts);
        throw new Error(
          data?.message || data?.error || "Erro ao alterar status",
        );
      }

      // Mensagem agregada vem do backend: "X pausado(s), Y já estava(m), Z falha(s)".
      const failed = (data?.listingResults ?? []).filter(
        (r: { paused: boolean }) => !r.paused,
      ).length;
      showToast(
        data?.message ?? "Status atualizado.",
        failed > 0 ? "warning" : "success",
      );
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Erro ao alterar status",
        "error",
      );
    } finally {
      setPausingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  /**
   * Dispara o endpoint agregado POST /products/bulk-delete, fazendo
   * chunking de BULK_DELETE_CHUNK_SIZE em BULK_DELETE_CHUNK_SIZE quando
   * houver mais IDs do que o limite por chamada. Devolve a resposta
   * consolidada (results + summary) já no shape esperado pelo modal.
   */
  const runBulkDelete = useCallback(
    async (
      ids: string[],
      nameById: Record<string, string>,
    ): Promise<BulkDeleteResponseBody | null> => {
      if (ids.length === 0) return null;
      const email = session?.user?.email || "";
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += BULK_DELETE_CHUNK_SIZE) {
        chunks.push(ids.slice(i, i + BULK_DELETE_CHUNK_SIZE));
      }

      const allResults: BulkDeleteProductResultView[] = [];
      let totalDeleted = 0;
      let totalFailed = 0;

      for (const chunk of chunks) {
        const response = await fetch(`${getApiBaseUrl()}/products/bulk-delete`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            email,
          },
          body: JSON.stringify({ ids: chunk }),
        });

        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as {
            error?: string;
            message?: string;
          };
          throw new Error(
            data.message ||
              data.error ||
              `Erro ao excluir produtos (HTTP ${response.status})`,
          );
        }

        const body = (await response.json()) as BulkDeleteResponseBody;
        allResults.push(...body.results);
        totalDeleted += body.summary.deleted;
        totalFailed += body.summary.failed;

        setBulkDeleteProgress((prev) =>
          prev
            ? { ...prev, done: Math.min(prev.done + chunk.length, prev.total) }
            : prev,
        );
      }

      // Atualiza estado local removendo apenas os produtos efetivamente
      // deletados; os que falharam continuam na lista (alinha com a
      // política estrita do backend).
      const deletedIds = new Set(
        allResults.filter((r) => r.deleted).map((r) => r.productId),
      );
      if (deletedIds.size > 0) {
        setProducts((prev) =>
          prev.filter((product) => !deletedIds.has(product.id)),
        );
        setPagination((prev) => ({
          ...prev,
          total: Math.max(0, prev.total - deletedIds.size),
        }));
        setSelectedIds((prev) => prev.filter((id) => !deletedIds.has(id)));
        invalidateProductFilterOptionsCache(session?.user?.email);
        fetchFilterOptions(true);
      }

      return {
        results: allResults,
        summary: {
          total: ids.length,
          deleted: totalDeleted,
          failed: totalFailed,
        },
      };
    },
    [session?.user?.email, fetchFilterOptions],
  );

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) {
      showToast("Selecione pelo menos um produto para excluir.", "warning");
      return;
    }

    const ids = [...selectedIds];
    const nameById: Record<string, string> = {};
    products.forEach((p) => {
      nameById[p.id] = p.name;
    });

    setIsBulkDeleting(true);
    setBulkDeleteProgress({ done: 0, total: ids.length });

    try {
      const body = await runBulkDelete(ids, nameById);
      if (!body) return;

      if (body.summary.failed === 0) {
        showToast(
          `${body.summary.deleted} produto(s) excluído(s) com sucesso!`,
          "success",
        );
      } else {
        setBulkDeleteResult({
          open: true,
          results: body.results,
          summary: body.summary,
          productNames: nameById,
        });
      }
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Erro ao excluir produtos",
        "error",
      );
    } finally {
      setIsBulkDeleting(false);
      setBulkDeleteProgress(null);
    }
  };

  /**
   * Reintenta apenas os produtos que falharam, mantendo o modal aberto e
   * atualizando os results in-place. Usado pelo botão "Reintentar" do
   * BulkDeleteResultModal — tanto para bulk quanto para individual.
   */
  const handleBulkRetry = useCallback(
    async (failedIds: string[]) => {
      if (failedIds.length === 0) return;
      const nameById = bulkDeleteResult?.productNames ?? {};

      setIsBulkDeleting(true);
      setBulkDeleteProgress({ done: 0, total: failedIds.length });

      try {
        const body = await runBulkDelete(failedIds, nameById);
        if (!body) return;

        setBulkDeleteResult((prev) => {
          if (!prev) return prev;
          // Substitui os resultados anteriores dos IDs retentados pelos novos.
          const retriedIndex = new Map(
            body.results.map((r) => [r.productId, r]),
          );
          const merged = prev.results.map((r) =>
            retriedIndex.get(r.productId) ?? r,
          );
          const deleted = merged.filter((r) => r.deleted).length;
          const failed = merged.filter((r) => !r.deleted).length;
          return {
            ...prev,
            results: merged,
            summary: { total: merged.length, deleted, failed },
          };
        });

        if (body.summary.failed === 0) {
          showToast(
            `${body.summary.deleted} produto(s) excluído(s) na nova tentativa.`,
            "success",
          );
        }
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : "Erro ao reintentar",
          "error",
        );
      } finally {
        setIsBulkDeleting(false);
        setBulkDeleteProgress(null);
      }
    },
    [bulkDeleteResult?.productNames, runBulkDelete],
  );

  const handleBulkPauseToggle = async (status: "active" | "paused") => {
    if (selectedIds.length === 0) {
      showToast(
        "Selecione pelo menos um produto para alterar.",
        "warning",
      );
      return;
    }

    const ids = [...selectedIds];
    const nameById = new Map(products.map((p) => [p.id, p.name]));
    const email = session?.user?.email || "";

    setIsBulkPausing(true);
    setBulkPauseProgress({ done: 0, total: ids.length });

    const succeeded: string[] = [];
    const failed: { id: string; name: string; message: string }[] = [];

    const concurrency = Math.min(4, ids.length);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= ids.length) return;
        const id = ids[index];
        try {
          const response = await fetch(
            `${getApiBaseUrl()}/products/${id}/listings-status`,
            {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
                email,
              },
              body: JSON.stringify({ status }),
            },
          );
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            failed.push({
              id,
              name: nameById.get(id) ?? id,
              message:
                data?.message || data?.error || "Erro ao alterar status",
            });
          } else {
            succeeded.push(id);
          }
        } catch (error) {
          failed.push({
            id,
            name: nameById.get(id) ?? id,
            message:
              error instanceof Error
                ? error.message
                : "Erro ao alterar status",
          });
        } finally {
          setBulkPauseProgress((prev) =>
            prev ? { ...prev, done: prev.done + 1 } : prev,
          );
        }
      }
    };

    await Promise.all(
      Array.from({ length: concurrency }, () => worker()),
    );

    if (succeeded.length > 0) {
      // Otimista: atualiza listings publicáveis dos produtos afetados.
      const succeededSet = new Set(succeeded);
      setProducts((prev) =>
        prev.map((p) =>
          succeededSet.has(p.id)
            ? {
                ...p,
                listings: (p.listings ?? []).map((l) => {
                  const publishable =
                    l.externalListingId &&
                    !l.externalListingId.startsWith("PENDING_");
                  return publishable ? { ...l, status } : l;
                }),
              }
            : p,
        ),
      );
    }

    const verb = status === "paused" ? "pausado(s)" : "reativado(s)";
    if (failed.length === 0) {
      showToast(`${succeeded.length} produto(s) ${verb}.`, "success");
    } else if (succeeded.length === 0) {
      showToast(
        failed[0]?.message
          ? `Erro ao alterar produtos: ${failed[0].message}`
          : "Erro ao alterar produtos",
        "error",
      );
    } else {
      showToast(
        `${succeeded.length} ${verb}, ${failed.length} falharam.`,
        "warning",
      );
      if (failed[0]?.message) {
        showToast(`"${failed[0].name}": ${failed[0].message}`, "error");
      }
    }

    setIsBulkPausing(false);
    setBulkPauseProgress(null);
  };

  const handleEditClick = (product: Product) => {
    setEditingProduct(product);
    setIsEditDialogOpen(true);
  };

  const formatPrice = (price: number) =>
    new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(price);

  const formatDate = (dateString: string) =>
    new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(new Date(dateString));

  const getStockBadgeVariant = (stock: number) => {
    if (stock === 0) return "destructive";
    if (stock <= 10) return "warning";
    return "success";
  };

  const selectionCount = selectedIds.length;
  const allSelected = products.length > 0 && selectionCount === products.length;
  const isIndeterminate =
    selectionCount > 0 && selectionCount < products.length;
  const activeFilters = hasActiveProductFilters(filters);

  const toggleSelectAll = (checked: boolean | "indeterminate") => {
    if (checked === true) {
      setSelectedIds(products.map((product) => product.id));
      return;
    }

    setSelectedIds([]);
  };

  const toggleSelectOne = (id: string, checked: boolean | "indeterminate") => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked === true) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return Array.from(next);
    });
  };

  const handleGenerateLabels = async () => {
    if (selectedIds.length === 0) {
      showToast(
        "Selecione pelo menos um produto para gerar etiquetas.",
        "warning",
      );
      return;
    }

    const selectedProducts = products.filter((product) =>
      selectedIds.includes(product.id),
    );

    if (selectedProducts.length === 0) {
      showToast(
        "Os itens selecionados não estão na página atual. Selecione novamente.",
        "warning",
      );
      setSelectedIds([]);
      return;
    }

    setIsGeneratingLabels(true);
    try {
      await generateLabelsPdf({
        products: selectedProducts.map((product) => ({
          id: product.id,
          sku: product.sku,
          name: product.name,
          partNumber: product.partNumber ?? null,
        })),
        userName: session?.user?.name,
      });
      showToast("PDF de etiquetas gerado com sucesso!", "success");
    } catch (error) {
      console.error("Erro ao gerar etiquetas", error);
      showToast(
        error instanceof Error ? error.message : "Erro ao gerar etiquetas",
        "error",
      );
    } finally {
      setIsGeneratingLabels(false);
    }
  };

  // Mesmo limiar (>= 2) que normalizeProductFilters usa para enviar a busca ao
  // backend: só trocamos a mensagem quando há de fato uma pesquisa textual.
  const hasActiveSearch = filters.search.trim().length >= 2;
  const emptyStateTitle = activeFilters
    ? "Nenhum produto encontrado"
    : "Nenhum produto cadastrado";
  const emptyStateMessage = hasActiveSearch
    ? "Nenhum produto corresponde à sua pesquisa. Tente outras palavras."
    : activeFilters
      ? "Nenhum produto corresponde aos filtros aplicados. Ajuste os critérios ou limpe os filtros para ampliar o catálogo."
      : "Comece adicionando seu primeiro produto ao catálogo.";

  const bulkListingProducts: BulkListingProduct[] = useMemo(
    () =>
      products
        .filter((p) => selectedIds.includes(p.id))
        .map((p) => ({
          id: p.id,
          sku: p.sku,
          name: p.name,
          price: typeof p.price === "number" ? p.price : Number(p.price) || 0,
          costPrice:
            typeof p.costPrice === "number"
              ? p.costPrice
              : p.costPrice
                ? Number(p.costPrice)
                : null,
          imageUrl: p.imageUrl ?? null,
          imageUrls: Array.isArray(p.imageUrls) ? p.imageUrls : null,
          mlCategoryId: p.mlCategoryId ?? null,
          shopeeCategoryId: p.shopeeCategoryId ?? null,
          compatibilitiesCount: null,
        })),
    [products, selectedIds],
  );

  return (
    <div className="space-y-6">
      <BulkListingWizard
        open={bulkListingOpen}
        onOpenChange={(o) => {
          setBulkListingOpen(o);
          if (!o) setIsBulkListing(false);
        }}
        selectedProducts={bulkListingProducts}
        email={session?.user?.email ?? ""}
        onJobStarted={() => setIsBulkListing(true)}
        onJobFinished={() => {
          setIsBulkListing(false);
        }}
        onShowToast={showToast}
      />

      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`rounded-lg px-4 py-3 text-sm font-medium shadow-lg animate-in slide-in-from-right-full ${
              toast.type === "success"
                ? "bg-green-100 text-green-800 dark:bg-green-900/80 dark:text-green-200"
                : "bg-destructive text-white"
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>

      <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-5 w-5" />
            Filtros
          </CardTitle>
          <CardDescription>
            Refine o catálogo por busca, período, publicação, estoque, preço e
            atributos do produto.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-2 xl:col-span-2">
              <label className="text-sm font-medium">Buscar</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Nome ou SKU..."
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  className="h-10 rounded-full border border-border/70 bg-muted/20 pl-9"
                />
                {isFetching && (
                  <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                )}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                Status da publicação
              </label>
              <Select
                value={filters.publicationStatus || SELECT_ALL_VALUE}
                onValueChange={(value) =>
                  updateFilter(
                    "publicationStatus",
                    value === SELECT_ALL_VALUE
                      ? ""
                      : (value as ProductFiltersState["publicationStatus"]),
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Todos os status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SELECT_ALL_VALUE}>
                    Todos os status
                  </SelectItem>
                  {PUBLICATION_STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Estoque</label>
              <Select
                value={filters.stockStatus || SELECT_ALL_VALUE}
                onValueChange={(value) =>
                  updateFilter(
                    "stockStatus",
                    value === SELECT_ALL_VALUE
                      ? ""
                      : (value as ProductFiltersState["stockStatus"]),
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Todos os estoques" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SELECT_ALL_VALUE}>
                    Todos os estoques
                  </SelectItem>
                  {STOCK_STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Criado de</label>
              <Input
                type="date"
                value={filters.createdFrom}
                onChange={(event) =>
                  updateFilter("createdFrom", event.target.value)
                }
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Criado até</label>
              <Input
                type="date"
                value={filters.createdTo}
                onChange={(event) =>
                  updateFilter("createdTo", event.target.value)
                }
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Preço mínimo</label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="0,00"
                value={filters.priceMin}
                onChange={(event) =>
                  updateFilter("priceMin", event.target.value)
                }
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Preço máximo</label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="0,00"
                value={filters.priceMax}
                onChange={(event) =>
                  updateFilter("priceMax", event.target.value)
                }
              />
            </div>

            <div className="hidden">
              <label className="text-sm font-medium">Categoria publicada</label>
              <Input
                placeholder="Categoria da peça"
                value={filters.listingCategory}
                onChange={(event) =>
                  updateFilter("listingCategory", event.target.value)
                }
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Categoria publicada</label>
              <Select
                value={filters.listingCategory || SELECT_ALL_VALUE}
                onValueChange={(value) =>
                  updateFilter(
                    "listingCategory",
                    value === SELECT_ALL_VALUE ? "" : value,
                  )
                }
                disabled={isPublishedCategoryDisabled}
              >
                <SelectTrigger>
                  <SelectValue placeholder={publishedCategoryPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SELECT_ALL_VALUE}>
                    {publishedCategoryAllLabel}
                  </SelectItem>
                  {availablePublishedCategories.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="hidden">
              <label className="text-sm font-medium">Marca</label>
              <Input
                placeholder="Marca"
                value={filters.brand}
                onChange={(event) => updateFilter("brand", event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Marca</label>
              <Select
                value={filters.brand || SELECT_ALL_VALUE}
                onValueChange={(value) =>
                  updateFilter("brand", value === SELECT_ALL_VALUE ? "" : value)
                }
                disabled={brandOptions.length === 0}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      brandOptions.length > 0
                        ? "Todas as marcas"
                        : "Nenhuma marca disponivel"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SELECT_ALL_VALUE}>
                    Todas as marcas
                  </SelectItem>
                  {brandOptions.map((brand) => (
                    <SelectItem key={brand} value={brand}>
                      {brand}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Qualidade</label>
              <Select
                value={filters.quality || SELECT_ALL_VALUE}
                onValueChange={(value) =>
                  updateFilter(
                    "quality",
                    value === SELECT_ALL_VALUE
                      ? ""
                      : (value as ProductFiltersState["quality"]),
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Todas as qualidades" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SELECT_ALL_VALUE}>
                    Todas as qualidades
                  </SelectItem>
                  {QUALITY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Marketplace</label>
              <Select
                value={filters.marketplace || SELECT_ALL_VALUE}
                onValueChange={(value) =>
                  updateFilter(
                    "marketplace",
                    value === SELECT_ALL_VALUE
                      ? ""
                      : (value as ProductFiltersState["marketplace"]),
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Sem filtro de canal" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SELECT_ALL_VALUE}>
                    Sem filtro de canal
                  </SelectItem>
                  {MARKETPLACE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 xl:col-span-2">
              <label className="text-sm font-medium">Localização</label>
              <Select
                value={filters.locationId || SELECT_ALL_VALUE}
                onValueChange={(value) =>
                  updateFilter(
                    "locationId",
                    value === SELECT_ALL_VALUE ? "" : value,
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Todas as localizações" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SELECT_ALL_VALUE}>
                    Todas as localizações
                  </SelectItem>
                  {locationOptions.map((location) => (
                    <SelectItem key={location.id} value={location.id}>
                      {location.fullPath}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm text-muted-foreground">
              {pagination.total}{" "}
              {activeFilters ? "resultado(s) encontrados" : "produto(s)"}
            </span>
            <Button
              variant="outline"
              onClick={clearFilters}
              disabled={!activeFilters && searchInput.trim().length === 0}
            >
              Limpar filtros
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Produtos</CardTitle>
              <CardDescription>
                Gerencie o catálogo de produtos do seu estoque central
              </CardDescription>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <ImportExportProducts
                email={session?.user?.email}
                onProductsImported={() => {
                  fetchProducts(1, filters);
                  invalidateProductFilterOptionsCache(session?.user?.email);
                  fetchFilterOptions(true);
                }}
                onToast={showToast}
              />
              {process.env.NEXT_PUBLIC_NFE_IMPORT_ENABLED === "true" && (
                <ImportNfeXml
                  email={session?.user?.email}
                  onProductCreated={() => {
                    fetchProducts(1, filters);
                    invalidateProductFilterOptionsCache(session?.user?.email);
                    fetchFilterOptions(true);
                  }}
                  onToast={showToast}
                />
              )}
              <CreateProductDialog
                onProductCreated={() => {
                  fetchProducts(1, filters);
                  invalidateProductFilterOptionsCache(session?.user?.email);
                  fetchFilterOptions(true);
                }}
                onToast={showToast}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isBootstrapping ? (
            <ProductSkeleton />
          ) : (
            <div className="space-y-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Checkbox
                    aria-label="Selecionar todos os produtos desta página"
                    checked={
                      allSelected
                        ? true
                        : isIndeterminate
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={toggleSelectAll}
                    disabled={isBulkDeleting || isBulkPausing}
                  />
                  <span className="whitespace-nowrap">Selecionar todos</span>
                  {selectionCount > 0 && (
                    <Badge variant="outline" className="font-normal">
                      {selectionCount} selecionado(s)
                    </Badge>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleGenerateLabels}
                    disabled={
                      selectionCount === 0 ||
                      isGeneratingLabels ||
                      isBulkDeleting ||
                      isBulkListing
                    }
                    className="gap-2"
                  >
                    <QrCode className="size-4" />
                    {isGeneratingLabels ? "Gerando..." : "Gerar etiquetas"}
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setBulkListingOpen(true)}
                    disabled={
                      selectionCount === 0 ||
                      isGeneratingLabels ||
                      isBulkDeleting ||
                      isBulkListing ||
                      isBulkPausing
                    }
                    className="gap-2"
                  >
                    <Megaphone className="size-4" />
                    {isBulkListing ? "Anunciando..." : "Anunciar em massa"}
                  </Button>

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          selectionCount === 0 ||
                          isBulkDeleting ||
                          isGeneratingLabels ||
                          isBulkListing ||
                          isBulkPausing
                        }
                        className="gap-2"
                      >
                        <Pause className="size-4" />
                        {isBulkPausing && bulkPauseProgress
                          ? `Pausando... ${bulkPauseProgress.done}/${bulkPauseProgress.total}`
                          : "Pausar selecionados"}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {`Pausar anúncios de ${selectionCount} produto(s)?`}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          Os anúncios publicados serão pausados nos
                          marketplaces e ficarão invisíveis até serem
                          despausados. Itens já pausados são ignorados.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleBulkPauseToggle("paused")}
                        >
                          {`Pausar ${selectionCount}`}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          selectionCount === 0 ||
                          isBulkDeleting ||
                          isGeneratingLabels ||
                          isBulkListing ||
                          isBulkPausing
                        }
                        className="gap-2"
                      >
                        <Play className="size-4" />
                        {isBulkPausing && bulkPauseProgress
                          ? `Despausando... ${bulkPauseProgress.done}/${bulkPauseProgress.total}`
                          : "Despausar selecionados"}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {`Despausar anúncios de ${selectionCount} produto(s)?`}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          Os anúncios pausados voltarão a aparecer nos
                          marketplaces. Itens já ativos são ignorados.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleBulkPauseToggle("active")}
                        >
                          {`Despausar ${selectionCount}`}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          selectionCount === 0 ||
                          isBulkDeleting ||
                          isGeneratingLabels ||
                          isBulkListing ||
                          isBulkPausing
                        }
                        className="gap-2 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                        {isBulkDeleting
                          ? `Excluindo... ${bulkDeleteProgress?.done ?? 0}/${
                              bulkDeleteProgress?.total ?? 0
                            }`
                          : "Excluir selecionados"}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {`Excluir ${selectionCount} produto(s)?`}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          Esta ação é irreversível. Os anúncios associados em
                          marketplaces serão fechados quando possível. Produtos
                          com pedidos vinculados não serão excluídos.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={handleBulkDelete}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          {`Excluir ${selectionCount}`}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>

              <div
                className={`space-y-4 transition-opacity ${
                  isFetching ? "opacity-60" : ""
                }`}
              >
                {products.length > 0 ? (
                  <>
                    <div className="hidden rounded-md border sm:block">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-12">
                              <Checkbox
                                aria-label="Selecionar todos os produtos desta página"
                                checked={
                                  allSelected
                                    ? true
                                    : isIndeterminate
                                      ? "indeterminate"
                                      : false
                                }
                                onCheckedChange={toggleSelectAll}
                                disabled={isBulkDeleting || isBulkPausing}
                              />
                            </TableHead>
                            <TableHead>Imagem</TableHead>
                            <TableHead>SKU</TableHead>
                            <TableHead>Nome</TableHead>
                            <TableHead className="hidden md:table-cell">
                              Marketplaces
                            </TableHead>
                            <TableHead className="hidden md:table-cell">
                              Preço
                            </TableHead>
                            <TableHead>Estoque</TableHead>
                            <TableHead className="hidden lg:table-cell">
                              Localização
                            </TableHead>
                            <TableHead className="hidden lg:table-cell">
                              Criado em
                            </TableHead>
                            <TableHead className="text-right">Ações</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {products.map((product) => (
                            <TableRow
                              key={product.id}
                              data-state={
                                selectedIds.includes(product.id)
                                  ? "selected"
                                  : undefined
                              }
                              className="cursor-pointer"
                            >
                              <TableCell>
                                <Checkbox
                                  aria-label={`Selecionar ${product.name}`}
                                  checked={selectedIds.includes(product.id)}
                                  onCheckedChange={(checked) =>
                                    toggleSelectOne(product.id, checked)
                                  }
                                  disabled={isBulkDeleting || isBulkPausing}
                                />
                              </TableCell>
                              <TableCell>
                                {product.imageUrl ? (
                                  <button
                                    type="button"
                                    onClick={() => openProductLightbox(product)}
                                    title="Ampliar imagem"
                                    className="group relative h-24 w-24 overflow-hidden rounded border bg-transparent transition-shadow hover:shadow-md"
                                  >
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                      src={product.imageUrl}
                                      alt={product.name}
                                      loading="lazy"
                                      decoding="async"
                                      className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
                                      onError={(event) => {
                                        event.currentTarget.style.display =
                                          "none";
                                      }}
                                    />
                                  </button>
                                ) : (
                                  <div className="flex h-24 w-24 items-center justify-center rounded border bg-muted">
                                    <Package className="h-12 w-12 text-muted-foreground" />
                                  </div>
                                )}
                              </TableCell>
                              <TableCell className="font-mono text-sm">
                                {product.sku}
                              </TableCell>
                              <TableCell className="font-medium">
                                <div>
                                  <p>{product.name}</p>
                                  {product.description && (
                                    <p
                                      className="text-xs text-muted-foreground"
                                      title={product.description}
                                    >
                                      {product.description.length > 80
                                        ? `${product.description.slice(0, 80)}...`
                                        : product.description}
                                    </p>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="hidden md:table-cell">
                                <MarketplaceBadges
                                  listings={product.listings}
                                  onOpenListings={(platform) =>
                                    setListingsDialog({ product, platform })
                                  }
                                />
                              </TableCell>
                              <TableCell className="hidden md:table-cell">
                                {formatPrice(product.price)}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant={getStockBadgeVariant(product.stock)}
                                >
                                  {product.stock} un.
                                </Badge>
                              </TableCell>
                              <TableCell className="hidden text-muted-foreground lg:table-cell">
                                {product.locationPath ??
                                  product.productLocation?.code ??
                                  product.location ??
                                  "—"}
                              </TableCell>
                              <TableCell className="hidden text-muted-foreground lg:table-cell">
                                {formatDate(product.createdAt)}
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="flex justify-end gap-1">
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    title="Ver detalhes"
                                    onClick={() => setViewProduct(product)}
                                  >
                                    <Eye className="size-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    title="Editar"
                                    onClick={() => handleEditClick(product)}
                                  >
                                    <Pencil className="size-4" />
                                  </Button>

                                  <PauseListingsButton
                                    product={product}
                                    state={computeProductPauseState(
                                      product.listings,
                                    )}
                                    isPausing={pausingIds.has(product.id)}
                                    onTogglePause={handleTogglePause}
                                  />

                                  <AlertDialog>
                                    <AlertDialogTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        title="Excluir"
                                      >
                                        <Trash2 className="size-4 text-destructive" />
                                      </Button>
                                    </AlertDialogTrigger>
                                    <AlertDialogContent>
                                      <AlertDialogHeader>
                                        <AlertDialogTitle>
                                          Excluir produto?
                                        </AlertDialogTitle>
                                        <AlertDialogDescription>
                                          {`Tem certeza que deseja excluir o produto "${product.name}"? Esta ação é irreversível.`}
                                        </AlertDialogDescription>
                                      </AlertDialogHeader>
                                      <AlertDialogFooter>
                                        <AlertDialogCancel>
                                          Cancelar
                                        </AlertDialogCancel>
                                        <AlertDialogAction
                                          onClick={() =>
                                            handleDelete(product.id)
                                          }
                                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                        >
                                          Excluir
                                        </AlertDialogAction>
                                      </AlertDialogFooter>
                                    </AlertDialogContent>
                                  </AlertDialog>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>

                    <div className="space-y-3 sm:hidden">
                      {products.map((product) => (
                        <div
                          key={product.id}
                          className="space-y-3 rounded-lg border bg-card p-4"
                        >
                          <div className="flex items-start gap-3">
                            <Checkbox
                              aria-label={`Selecionar ${product.name}`}
                              className="mt-1"
                              checked={selectedIds.includes(product.id)}
                              onCheckedChange={(checked) =>
                                toggleSelectOne(product.id, checked)
                              }
                              disabled={isBulkDeleting || isBulkPausing}
                            />
                            {product.imageUrl ? (
                              <button
                                type="button"
                                onClick={() => openProductLightbox(product)}
                                title="Ampliar imagem"
                                className="group relative h-32 w-32 flex-shrink-0 overflow-hidden rounded border bg-transparent transition-shadow hover:shadow-md"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={product.imageUrl}
                                  alt={product.name}
                                  loading="lazy"
                                  decoding="async"
                                  className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
                                  onError={(event) => {
                                    event.currentTarget.style.display = "none";
                                  }}
                                />
                              </button>
                            ) : (
                              <div className="flex h-32 w-32 flex-shrink-0 items-center justify-center rounded border bg-muted">
                                <Package className="h-16 w-16 text-muted-foreground" />
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1 space-y-1">
                                  <p className="truncate font-medium">
                                    {product.name}
                                  </p>
                                  <p className="font-mono text-xs text-muted-foreground">
                                    {product.sku}
                                  </p>
                                  <MarketplaceBadges
                                    listings={product.listings}
                                    size="sm"
                                    onOpenListings={(platform) =>
                                      setListingsDialog({ product, platform })
                                    }
                                  />
                                  {(product.locationPath ||
                                    product.location ||
                                    product.productLocation?.code) && (
                                    <p className="text-xs text-muted-foreground">
                                      {product.locationPath ??
                                        product.productLocation?.code ??
                                        product.location}
                                    </p>
                                  )}
                                </div>
                                <Badge
                                  variant={getStockBadgeVariant(product.stock)}
                                >
                                  {product.stock} un.
                                </Badge>
                              </div>
                              {product.description && (
                                <p
                                  className="mt-2 text-sm text-muted-foreground"
                                  title={product.description}
                                >
                                  {product.description.length > 120
                                    ? `${product.description.slice(0, 120)}...`
                                    : product.description}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center justify-between border-t pt-2">
                            <span className="text-lg font-semibold">
                              {formatPrice(product.price)}
                            </span>
                            <div className="flex gap-1">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                title="Ver detalhes"
                                onClick={() => setViewProduct(product)}
                              >
                                <Eye className="size-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => handleEditClick(product)}
                              >
                                <Pencil className="size-4" />
                              </Button>

                              <PauseListingsButton
                                product={product}
                                state={computeProductPauseState(
                                  product.listings,
                                )}
                                isPausing={pausingIds.has(product.id)}
                                onTogglePause={handleTogglePause}
                              />

                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="icon-sm">
                                    <Trash2 className="size-4 text-destructive" />
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>
                                      Excluir produto?
                                    </AlertDialogTitle>
                                    <AlertDialogDescription>
                                      {`Tem certeza que deseja excluir o produto "${product.name}"? Esta ação é irreversível.`}
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>
                                      Cancelar
                                    </AlertDialogCancel>
                                    <AlertDialogAction
                                      onClick={() => handleDelete(product.id)}
                                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                    >
                                      Excluir
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {pagination.total > 0 && (
                      <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
                        <div className="flex items-center gap-3">
                          <p className="text-sm text-muted-foreground">
                            Página {pagination.page} de{" "}
                            {Math.max(1, pagination.totalPages)}
                          </p>
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-muted-foreground">
                              Itens por página
                            </span>
                            <Select
                              value={String(pagination.limit)}
                              onValueChange={(value) =>
                                handlePageSizeChange(Number(value))
                              }
                            >
                              <SelectTrigger className="h-8 w-20">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="10">10</SelectItem>
                                <SelectItem value="20">20</SelectItem>
                                <SelectItem value="50">50</SelectItem>
                                <SelectItem value="100">100</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                        {pagination.totalPages > 1 && (
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={pagination.page === 1}
                              onClick={() =>
                                handlePageChange(pagination.page - 1)
                              }
                            >
                              <ChevronLeft className="size-4" />
                              Anterior
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={
                                pagination.page === pagination.totalPages
                              }
                              onClick={() =>
                                handlePageChange(pagination.page + 1)
                              }
                            >
                              Próxima
                              <ChevronRight className="size-4" />
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <div className="flex size-16 items-center justify-center rounded-full bg-muted">
                      <Package className="size-8 text-muted-foreground" />
                    </div>
                    <h3 className="mt-4 text-lg font-semibold">
                      {emptyStateTitle}
                    </h3>
                    <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                      {emptyStateMessage}
                    </p>
                  </div>
                )}
              </div>

              {isFetching && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Atualizando resultados...
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {editingProduct && (
        <EditProductDialog
          product={editingProduct}
          open={isEditDialogOpen}
          onOpenChange={(open) => {
            setIsEditDialogOpen(open);
            if (!open) {
              setEditingProduct(null);
              setEditingListingContext(null);
            }
          }}
          onProductUpdated={() => {
            fetchProducts(pagination.page, filters);
            invalidateProductFilterOptionsCache(session?.user?.email);
            fetchFilterOptions(true);
          }}
          onToast={showToast}
          listingContext={editingListingContext}
        />
      )}

      <MarketplaceListingsDialog
        open={!!listingsDialog}
        onOpenChange={(open) => {
          if (!open) setListingsDialog(null);
        }}
        product={listingsDialog?.product ?? null}
        platform={listingsDialog?.platform ?? null}
        onEditProduct={() => {
          if (listingsDialog?.product) {
            setEditingListingContext(null);
            handleEditClick(listingsDialog.product);
            setListingsDialog(null);
          }
        }}
        onEditListing={(ctx) => {
          if (listingsDialog?.product) {
            setEditingListingContext(ctx);
            handleEditClick(listingsDialog.product);
            setListingsDialog(null);
          }
        }}
        onToast={showToast}
      />

      <ProductDetailSheet
        product={viewProduct}
        open={!!viewProduct}
        onOpenChange={(open) => {
          if (!open) setViewProduct(null);
        }}
      />

      <ImageLightbox
        images={lightboxProduct?.images ?? []}
        open={!!lightboxProduct}
        onOpenChange={(open) => {
          if (!open) setLightboxProduct(null);
        }}
        alt={lightboxProduct?.alt}
      />

      {bulkDeleteResult && (
        <BulkDeleteResultModal
          open={bulkDeleteResult.open}
          onOpenChange={(open) => {
            if (open) {
              setBulkDeleteResult((prev) => (prev ? { ...prev, open } : prev));
            } else {
              setBulkDeleteResult(null);
            }
          }}
          results={bulkDeleteResult.results}
          summary={bulkDeleteResult.summary}
          productNames={bulkDeleteResult.productNames}
          onRetry={handleBulkRetry}
          isRetrying={isBulkDeleting}
        />
      )}
    </div>
  );
}
