"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  AlertCircle,
  ExternalLink,
  Loader2,
  Pencil,
  PackageOpen,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  FACEBOOK_COMMERCE_MANAGER_HINT,
  resolveMarketplaceListingLinkState,
  type MarketplaceListingPlatform,
} from "@/app/lib/marketplace-listing-links";
import { getApiBaseUrl } from "@/lib/api";
import {
  LISTING_PLATFORM_LABELS,
  formatListingDateTime,
  getListingStatusBadge,
} from "@/app/produtos/lib/listing-status-labels";

type ApiListing = {
  id: string;
  platform: MarketplaceListingPlatform | string | null;
  accountId: string | null;
  accountName: string | null;
  status: string | null;
  externalListingId: string | null;
  permalink: string | null;
  // Só vem preenchido nas linhas do Facebook (GET /listings/status). É o
  // catálogo da conta, destino do "Ver anúncio" no Commerce Manager.
  fbCatalogId?: string | null;
  lastError: string | null;
  retryAttempts?: number | null;
  retryEnabled?: boolean | null;
  nextRetryAt?: string | null;
  updatedAt: string | null;
};

// Cache em escopo de módulo: o usuário costuma abrir/fechar o modal de
// listings várias vezes em sequência (especialmente quando alterna entre
// ML e Shopee do mesmo produto). 30s de TTL evita refetchs duplicados sem
// risco de mostrar dados muito antigos.
const LISTINGS_STATUS_TTL_MS = 30_000;
const listingsStatusCache = new Map<
  string,
  { data: ApiListing[]; expiresAt: number }
>();
function readListingsCache(productId: string): ApiListing[] | null {
  const entry = listingsStatusCache.get(productId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    listingsStatusCache.delete(productId);
    return null;
  }
  return entry.data;
}
function writeListingsCache(productId: string, data: ApiListing[]) {
  listingsStatusCache.set(productId, {
    data,
    expiresAt: Date.now() + LISTINGS_STATUS_TTL_MS,
  });
}
/**
 * Invalida o cache de listings para um produto. Chamado de fora quando
 * o produto/listings sofre alteração (save no EditProductDialog).
 */
export function invalidateListingsStatusCache(productId?: string | null) {
  if (productId) {
    listingsStatusCache.delete(productId);
  } else {
    listingsStatusCache.clear();
  }
}

type ProductRef = {
  id: string;
  sku?: string;
  name: string;
  listings?: Array<{
    marketplaceAccountId?: string | null;
    externalListingId?: string | null;
    shopId?: number | null;
  } | null> | null;
};

export interface ListingEditContext {
  listingId: string;
  accountName: string;
  platform: MarketplaceListingPlatform;
  externalListingId: string | null;
  status: string;
}

interface MarketplaceListingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductRef | null;
  platform: MarketplaceListingPlatform | null;
  onEditProduct: () => void;
  onEditListing?: (ctx: ListingEditContext) => void;
  onToast?: (message: string, type: "success" | "error" | "warning") => void;
}

export function MarketplaceListingsDialog({
  open,
  onOpenChange,
  product,
  platform,
  onEditProduct,
  onEditListing,
  onToast: _onToast,
}: MarketplaceListingsDialogProps) {
  const { data: session } = useSession();
  const email = session?.user?.email ?? null;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listings, setListings] = useState<ApiListing[]>([]);

  const platformLabel = platform ? LISTING_PLATFORM_LABELS[platform] : "";

  const shopIdByExternalId = useMemo(() => {
    const map = new Map<string, number>();
    for (const listing of product?.listings ?? []) {
      if (
        listing &&
        listing.externalListingId &&
        typeof listing.shopId === "number"
      ) {
        map.set(listing.externalListingId, listing.shopId);
      }
    }
    return map;
  }, [product]);

  useEffect(() => {
    if (!open || !product?.id || !platform || !email) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    // Hidrata instantaneamente do cache (sem flicker de "Carregando…").
    // Mesmo assim faz refetch em background para garantir freshness.
    const cached = readListingsCache(product.id);
    if (cached) {
      const filteredCached = cached.filter((l) => l && l.platform === platform);
      setListings(filteredCached);
      setLoading(false);
      setError(null);
    }

    const load = async () => {
      if (!cached) {
        setLoading(true);
      }
      if (!cached) setError(null);
      try {
        const response = await fetch(
          `${getApiBaseUrl()}/listings/status?productId=${encodeURIComponent(
            product.id,
          )}&live=1`,
          {
            headers: { email },
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = (await response.json()) as { listings?: ApiListing[] };

        if (cancelled) return;

        const all = data.listings ?? [];
        writeListingsCache(product.id, all);
        const filtered = all.filter((l) => l && l.platform === platform);
        setListings(filtered);
      } catch (err) {
        if (cancelled || (err as Error).name === "AbortError") return;
        // Se já tinha dados do cache, mantém o que está e não mostra erro.
        if (!cached) {
          setError("Não foi possível carregar os anúncios deste produto.");
          setListings([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, product?.id, platform, email]);

  useEffect(() => {
    if (!open) {
      setListings([]);
      setError(null);
      setLoading(false);
    }
  }, [open]);

  const handleEditListingClick = (listing: ApiListing) => {
    if (!onEditListing || !platform) return;
    const ctx: ListingEditContext = {
      listingId: listing.id,
      accountName: listing.accountName?.trim() || "Conta sem nome",
      platform,
      externalListingId: listing.externalListingId,
      status: listing.status ?? "",
    };
    onOpenChange(false);
    onEditListing(ctx);
  };

  const handleEditProductClick = () => {
    onOpenChange(false);
    onEditProduct();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {platformLabel
              ? `Anúncios publicados no ${platformLabel}`
              : "Anúncios publicados"}
          </DialogTitle>
          {product && (
            <DialogDescription>
              {product.sku ? `${product.sku} · ` : ""}
              {product.name}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-3">
          {loading && (
            <div className="flex items-center justify-center gap-2 rounded-lg border bg-muted/40 p-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Carregando anúncios…
            </div>
          )}

          {!loading && error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4" />
              <div>{error}</div>
            </div>
          )}

          {!loading && !error && listings.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              <PackageOpen className="size-6 opacity-60" />
              <span>Nenhum anúncio publicado nessa plataforma.</span>
            </div>
          )}

          {!loading && !error && listings.length > 0 && (
            <ul className="space-y-2">
              {listings.map((listing) => {
                const statusInfo = getListingStatusBadge(listing.status);
                const linkState = resolveMarketplaceListingLinkState({
                  platform: (listing.platform as MarketplaceListingPlatform) ?? platform!,
                  marketplaceAccountId: listing.accountId,
                  externalListingId: listing.externalListingId,
                  permalink: listing.permalink,
                  fbCatalogId: listing.fbCatalogId,
                  shopId:
                    listing.externalListingId
                      ? shopIdByExternalId.get(listing.externalListingId) ?? null
                      : null,
                  status: listing.status,
                  updatedAt: listing.updatedAt,
                });

                const accountLabel =
                  listing.accountName?.trim() || "Conta sem nome";
                const externalId = listing.externalListingId?.trim();

                return (
                  <li
                    key={listing.id}
                    className="flex flex-col gap-3 rounded-lg border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">
                          {accountLabel}
                        </span>
                        <Badge variant={statusInfo.variant}>
                          {statusInfo.label}
                        </Badge>
                      </div>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {externalId || "Sem ID externo"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Atualizado em {formatListingDateTime(listing.updatedAt)}
                      </p>
                      {listing.lastError && (
                        <p className="text-xs text-destructive">
                          {listing.lastError}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {linkState.isOpenable && linkState.href ? (
                        <Button variant="outline" size="sm" asChild>
                          <a
                            href={linkState.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={
                              listing.platform === "FACEBOOK"
                                ? FACEBOOK_COMMERCE_MANAGER_HINT
                                : undefined
                            }
                          >
                            <ExternalLink className="mr-1.5 size-3" />
                            Ver anúncio
                          </a>
                        </Button>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span tabIndex={0}>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled
                                aria-label={
                                  linkState.disabledReason ??
                                  "Anúncio indisponível"
                                }
                              >
                                <ExternalLink className="mr-1.5 size-3" />
                                Ver anúncio
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent sideOffset={6}>
                            {linkState.disabledReason ??
                              "Anúncio indisponível para abertura."}
                          </TooltipContent>
                        </Tooltip>
                      )}

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleEditListingClick(listing)}
                      >
                        <Pencil className="mr-1.5 size-3" />
                        Editar anúncio
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {!loading && !error && listings.length > 0 && (
            <div className="flex justify-end pt-1">
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs text-muted-foreground"
                onClick={handleEditProductClick}
              >
                Editar dados do produto (afeta todos os anúncios)
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
