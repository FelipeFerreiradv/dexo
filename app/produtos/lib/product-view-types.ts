import type {
  MarketplaceListingLinkInput,
  MarketplaceListingPlatform,
} from "@/app/lib/marketplace-listing-links";

// Tipos da forma de produto usada pela LISTA do frontend (payload de
// `GET /products`). Extraídos 1:1 de `products-list.tsx` para serem compartilhados
// entre o container, a visão Lista e a visão Catálogo, sem mudança de comportamento.
// IMPORTANTE: é diferente do `Product` de domínio em
// `app/interfaces/product.interface.ts` (datas como `Date`, `listings` como
// `ProductListingSummary`). Aqui as datas vêm como `string` (JSON) e `listings`
// é a forma de `marketplace-listing-links`.

export type MarketplacePlatform = MarketplaceListingPlatform;

export type ProductListing = MarketplaceListingLinkInput & {
  accountIds: string[];
  categoryId?: string;
};

export type Quality = "SUCATA" | "SEMINOVO" | "NOVO" | "RECONDICIONADO";

export interface Product {
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
  createdFromMarketplace?: boolean;
  originPlatform?:
    | "MERCADO_LIVRE"
    | "SHOPEE"
    | "MAGALU"
    | "OLX"
    | "FACEBOOK"
    | null;
  productLocation?: {
    id: string;
    code: string;
    description?: string | null;
  } | null;
  listings?: ProductListing[];
}

export type ProductPauseState =
  | "all-active"
  | "all-paused"
  | "mixed"
  | "no-actionable";
