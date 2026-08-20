import type { MarketplaceListingPlatform } from "@/app/lib/marketplace-listing-links";

/**
 * Cache do `GET /listings/status?productId=`.
 *
 * Morava dentro de `marketplace-listings-dialog.tsx`. Saiu de lá quando a lista
 * de anúncios passou a ser renderizada em dois lugares (o modal "Anúncios
 * publicados" e a seção "Anúncios deste produto" dentro do modal de edição):
 * um componente de UI não é lugar de guardar estado compartilhado, e quem só
 * precisa invalidar o cache não deveria arrastar o dialog inteiro para o bundle.
 */
export type ApiListing = {
  id: string;
  platform: MarketplaceListingPlatform | string | null;
  accountId: string | null;
  accountName: string | null;
  status: string | null;
  externalListingId: string | null;
  permalink: string | null;
  /**
   * Só vem preenchido nas linhas do Facebook (`GET /listings/status`). É o
   * catálogo da conta, destino do "Ver anúncio" no Commerce Manager.
   */
  fbCatalogId?: string | null;
  lastError: string | null;
  retryAttempts?: number | null;
  retryEnabled?: boolean | null;
  nextRetryAt?: string | null;
  updatedAt: string | null;
};

/**
 * 30s de TTL: o usuário costuma abrir/fechar a lista várias vezes em sequência
 * (especialmente alternando entre ML e Shopee do mesmo produto), e isso evita
 * refetchs duplicados sem risco de mostrar dado velho.
 */
const LISTINGS_STATUS_TTL_MS = 30_000;

const listingsStatusCache = new Map<
  string,
  { data: ApiListing[]; expiresAt: number }
>();

export function readListingsCache(productId: string): ApiListing[] | null {
  const entry = listingsStatusCache.get(productId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    listingsStatusCache.delete(productId);
    return null;
  }
  return entry.data;
}

export function writeListingsCache(productId: string, data: ApiListing[]) {
  listingsStatusCache.set(productId, {
    data,
    expiresAt: Date.now() + LISTINGS_STATUS_TTL_MS,
  });
}

/**
 * Invalida o cache de listings de um produto. Chamado de fora quando o
 * produto/anúncio muda (save no EditProductDialog). Sem argumento, limpa tudo.
 */
export function invalidateListingsStatusCache(productId?: string | null) {
  if (productId) {
    listingsStatusCache.delete(productId);
  } else {
    listingsStatusCache.clear();
  }
}
