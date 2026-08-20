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
import {
  readListingsCache,
  writeListingsCache,
  type ApiListing,
} from "@/app/produtos/lib/listings-status-cache";

export type { ApiListing };

export type ProductListingsRef = {
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

/**
 * Anúncio ainda não publicado. Todos os `update*ListingFields` do backend fazem
 * early-return quando o `externalListingId` começa com `PENDING_` — oferecer
 * "Editar anúncio" nessas linhas é oferecer um botão que não faz nada.
 */
function isPending(listing: ApiListing): boolean {
  return !!listing.externalListingId?.startsWith("PENDING_");
}

/**
 * Busca os anúncios de um produto.
 *
 * `platform: null` = todos os canais (é o que a seção dentro do modal de edição
 * usa); com plataforma, filtra — o `GET` sempre traz tudo e o cache guarda tudo,
 * o filtro é local.
 *
 * `live` dispara o refresh contra os marketplaces (deadline de 8s no backend).
 * O modal "Anúncios publicados" quer isso; o modal de edição de produto NÃO —
 * ele abre muito mais vezes, e pagar um refresh remoto a cada abertura seria
 * egress sem contrapartida.
 */
export function useProductListings(params: {
  enabled: boolean;
  productId: string | null | undefined;
  platform: MarketplaceListingPlatform | null;
  live?: boolean;
}) {
  const { enabled, productId, platform, live = false } = params;
  const { data: session } = useSession();
  const email = session?.user?.email ?? null;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listings, setListings] = useState<ApiListing[]>([]);

  useEffect(() => {
    if (!enabled || !productId || !email) return;

    let cancelled = false;
    const controller = new AbortController();

    const filtrar = (all: ApiListing[]) =>
      platform ? all.filter((l) => l && l.platform === platform) : all;

    // Hidrata instantaneamente do cache (sem flicker de "Carregando…"); mesmo
    // assim refaz o fetch em background para garantir freshness.
    const cached = readListingsCache(productId);
    if (cached) {
      setListings(filtrar(cached));
      setLoading(false);
      setError(null);
    }

    const load = async () => {
      if (!cached) {
        setLoading(true);
        setError(null);
      }
      try {
        const response = await fetch(
          `${getApiBaseUrl()}/listings/status?productId=${encodeURIComponent(
            productId,
          )}${live ? "&live=1" : ""}`,
          { headers: { email }, signal: controller.signal },
        );

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = (await response.json()) as { listings?: ApiListing[] };
        if (cancelled) return;

        const all = data.listings ?? [];
        writeListingsCache(productId, all);
        setListings(filtrar(all));
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
  }, [enabled, productId, platform, email, live]);

  useEffect(() => {
    if (!enabled) {
      setListings([]);
      setError(null);
      setLoading(false);
    }
  }, [enabled]);

  return { listings, loading, error };
}

interface ProductListingsListProps {
  product: ProductListingsRef | null;
  /** `null` = mostra todos os canais. */
  platform: MarketplaceListingPlatform | null;
  listings: ApiListing[];
  loading: boolean;
  error: string | null;
  onEditListing?: (ctx: ListingEditContext) => void;
  /** Rodapé opcional ("Editar dados do produto…") — só o dialog usa. */
  footer?: React.ReactNode;
  /** Texto do estado vazio; cada host tem o seu. */
  emptyMessage?: string;
  emptyHint?: React.ReactNode;
}

/**
 * A lista de anúncios de um produto — uma fonte só, dois hosts.
 *
 * Renderiza SEM `<Dialog>` de propósito: o modal "Anúncios publicados" põe a
 * casca em volta, e o modal de edição de produto embute direto (dois
 * `DialogContent` aninhados empilhariam portais e focus-traps do Radix).
 */
export function ProductListingsList({
  product,
  platform,
  listings,
  loading,
  error,
  onEditListing,
  footer,
  emptyMessage,
  emptyHint,
}: ProductListingsListProps) {
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

  const handleEditListingClick = (listing: ApiListing) => {
    if (!onEditListing) return;
    const plat = (listing.platform ??
      platform) as MarketplaceListingPlatform | null;
    if (!plat) return;
    onEditListing({
      listingId: listing.id,
      accountName: listing.accountName?.trim() || "Conta sem nome",
      platform: plat,
      externalListingId: listing.externalListingId,
      status: listing.status ?? "",
    });
  };

  return (
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
          <span>
            {emptyMessage ?? "Nenhum anúncio publicado nessa plataforma."}
          </span>
          {emptyHint}
        </div>
      )}

      {!loading && !error && listings.length > 0 && (
        <ul className="space-y-2">
          {listings.map((listing) => {
            const statusInfo = getListingStatusBadge(listing.status);
            const rowPlatform = (listing.platform ??
              platform) as MarketplaceListingPlatform;
            const linkState = resolveMarketplaceListingLinkState({
              platform: rowPlatform,
              marketplaceAccountId: listing.accountId,
              externalListingId: listing.externalListingId,
              permalink: listing.permalink,
              fbCatalogId: listing.fbCatalogId,
              shopId: listing.externalListingId
                ? (shopIdByExternalId.get(listing.externalListingId) ?? null)
                : null,
              status: listing.status,
              updatedAt: listing.updatedAt,
            });

            const accountLabel =
              listing.accountName?.trim() || "Conta sem nome";
            const externalId = listing.externalListingId?.trim();
            const pending = isPending(listing);

            return (
              <li
                key={listing.id}
                className="flex flex-col gap-3 rounded-lg border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Sem filtro de plataforma a conta sozinha não diz o canal. */}
                    {!platform && rowPlatform && (
                      <Badge variant="outline">
                        {LISTING_PLATFORM_LABELS[rowPlatform] ?? rowPlatform}
                      </Badge>
                    )}
                    <span className="text-sm font-medium">{accountLabel}</span>
                    <Badge variant={statusInfo.variant}>
                      {statusInfo.label}
                    </Badge>
                  </div>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {pending
                      ? "Aguardando publicação"
                      : externalId || "Sem ID externo"}
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

                  {onEditListing &&
                    (pending ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span tabIndex={0}>
                            <Button variant="outline" size="sm" disabled>
                              <Pencil className="mr-1.5 size-3" />
                              Editar anúncio
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>
                          Este anúncio ainda não foi publicado no marketplace.
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleEditListingClick(listing)}
                      >
                        <Pencil className="mr-1.5 size-3" />
                        Editar anúncio
                      </Button>
                    ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && !error && listings.length > 0 && footer}
    </div>
  );
}
