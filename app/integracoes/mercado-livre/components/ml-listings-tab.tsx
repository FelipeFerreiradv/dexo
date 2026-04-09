"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import {
  Package,
  Link2,
  ExternalLink,
  AlertCircle,
  RefreshCw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { getApiBaseUrl } from "@/lib/api";
import { resolveMarketplaceListingLinkState } from "@/app/lib/marketplace-listing-links";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { MLListingsSkeleton } from "./ml-skeleton";

interface Listing {
  id: string;
  productId: string;
  externalListingId: string;
  externalSku: string | null;
  permalink: string | null;
  status: string;
  lastError?: string | null;
  createdAt: string;
  product?: {
    name: string;
    sku: string;
    stock: number;
  };
}

interface ListingsResponse {
  success: boolean;
  count: number;
  listings: Listing[];
}

export function MLListingsTab() {
  const { data: session } = useSession();
  const [listings, setListings] = useState<Listing[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<
    Array<{ id: string; accountName: string }>
  >([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");

  // Buscar listings
  const fetchListings = useCallback(
    async (showRefreshState = false) => {
      if (!session?.user?.email) return;

      if (showRefreshState) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      setError(null);

      try {
        const url = new URL(`${getApiBaseUrl()}/marketplace/ml/listings`);
        if (selectedAccountId)
          url.searchParams.set("accountId", selectedAccountId);

        const response = await fetch(url.toString(), {
          headers: {
            email: session.user.email,
          },
        });

        if (!response.ok) {
          const data = await response.json();
          // Se não encontrou conta, não é erro - apenas não tem conexão
          if (response.status === 404) {
            setListings([]);
            return;
          }
          throw new Error(data.message || "Erro ao buscar anúncios");
        }

        const data: ListingsResponse = await response.json();
        setListings(data.listings);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Erro desconhecido");
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [session?.user?.email, selectedAccountId],
  );

  useEffect(() => {
    if (session?.user?.email) {
      fetchListings();
    }
  }, [session?.user?.email, fetchListings]);

  // Carregar contas para filtro
  useEffect(() => {
    const loadAccounts = async () => {
      if (!session?.user?.email) return;
      try {
        const res = await fetch(`${getApiBaseUrl()}/marketplace/ml/accounts`, {
          headers: { email: session.user.email },
        });
        if (res.ok) {
          const data = await res.json();
          setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
        }
      } catch (err) {
        /* ignore errors silently */
      }
    };
    loadAccounts();
  }, [session?.user?.email]);

  const handleRefresh = () => {
    fetchListings(true);
  };

  // Formatar status do listing
  const getStatusBadge = (status: string) => {
    switch (status.toLowerCase()) {
      case "active":
        return <Badge variant="default">Ativo</Badge>;
      case "paused":
        return <Badge variant="secondary">Pausado</Badge>;
      case "pending":
        return <Badge variant="outline">Pendente</Badge>;
      case "error":
        return <Badge variant="destructive">Erro</Badge>;
      case "closed":
        return <Badge variant="outline">Fechado</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  if (isLoading) {
    return <MLListingsSkeleton />;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5" />
              Vínculos Produto-Anúncio
            </CardTitle>
            <CardDescription>
              Produtos do seu estoque vinculados a anúncios do Mercado Livre
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="rounded border px-2 py-1 text-sm"
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
            >
              <option value="">Todas as contas</option>
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.accountName || acc.id}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
              />
              Atualizar
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {listings.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Package className="h-12 w-12 text-muted-foreground/50" />
            <h3 className="mt-4 text-lg font-medium">
              Nenhum vínculo encontrado
            </h3>
            <p className="mt-2 max-w-sm text-sm text-muted-foreground">
              Seus anúncios do Mercado Livre ainda não estão vinculados aos
              produtos do seu estoque. Use a aba de Sincronização para importar
              e vincular anúncios.
            </p>
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produto</TableHead>
                  <TableHead>SKU ML</TableHead>
                  <TableHead>ID Anúncio</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listings.map((listing) => (
                  <TableRow key={listing.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">
                          {listing.product?.name || "Produto não encontrado"}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          SKU: {listing.product?.sku || "-"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1 py-0.5 text-xs">
                        {listing.externalSku || "-"}
                      </code>
                    </TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1 py-0.5 text-xs">
                        {listing.externalListingId}
                      </code>
                    </TableCell>
                    <TableCell>
                      {getStatusBadge(listing.status)}
                      {listing.lastError ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {listing.lastError.slice(0, 120)}
                          {listing.lastError.length > 120 ? "…" : ""}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      {(() => {
                        // Reuse the same open/disabled rules used in product listings.
                        const linkListing = {
                          platform: "MERCADO_LIVRE" as const,
                          externalListingId: listing.externalListingId,
                          permalink: listing.permalink,
                          status: listing.status,
                        };
                        const linkState =
                          resolveMarketplaceListingLinkState(linkListing);

                        if (!linkState.isOpenable) {
                          return (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled
                              title={linkState.disabledReason ?? undefined}
                            >
                              <AlertCircle className="h-4 w-4 text-muted-foreground/70" />
                              <span className="sr-only">Anúncio pausado</span>
                            </Button>
                          );
                        }

                        return (
                          <Button variant="ghost" size="sm" asChild>
                            <a
                              href={linkState.href ?? "#"}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <ExternalLink className="h-4 w-4" />
                              <span className="sr-only">Ver no ML</span>
                            </a>
                          </Button>
                        );
                      })()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {listings.length > 0 && (
          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <div className="flex items-center gap-1">
              <AlertCircle className="h-4 w-4" />
              <span>
                {listings.length}{" "}
                {listings.length === 1
                  ? "vínculo encontrado"
                  : "vínculos encontrados"}
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
