"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
import {
  FACEBOOK_COMMERCE_MANAGER_HINT,
  resolveMarketplaceListingLinkState,
} from "@/app/lib/marketplace-listing-links";
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
import { ListingsPagination } from "@/app/integracoes/components/listings-pagination";
import { FacebookListingsSkeleton } from "./facebook-skeleton";

interface Listing {
  id: string;
  productId: string;
  externalListingId: string;
  externalSku: string | null;
  permalink: string | null;
  // Catálogo da conta dona do vínculo — vem do GET /facebook/listings e é o
  // que abre a peça no Commerce Manager.
  fbCatalogId?: string | null;
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
  /** Quantos vieram NESTA página. O total está em `pagination.total`. */
  count: number;
  listings: Listing[];
  /**
   * Teto e paginação (R7). Opcional no tipo por precaução: se um deploy antigo
   * responder sem o campo, a aba cai num estado de página única em vez de
   * quebrar — nunca em "nenhum anúncio".
   */
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/** Mesmo teto do servidor. Muda aqui e lá junto, ou a conta de páginas mente. */
const LISTINGS_POR_PAGINA = 50;

export function FacebookListingsTab() {
  const { data: session } = useSession();
  const [listings, setListings] = useState<Listing[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<
    Array<{ id: string; accountName: string }>
  >([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [page, setPage] = useState(1);
  /**
   * Bilhete da requisição em curso. Sem ele, duas buscas em voo (dois cliques
   * rápidos em "Próximo", ou um refresh por cima de uma troca de conta) são
   * aplicadas na ordem em que CHEGAM, não na ordem em que foram pedidas — e a
   * resposta velha sobrescreve a nova. O sintoma era cruel: lista vazia numa
   * conta que tem anúncios.
   */
  const requisicaoEmCurso = useRef(0);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: LISTINGS_POR_PAGINA,
    total: 0,
    totalPages: 1,
  });

  const fetchListings = useCallback(
    async (showRefreshState = false) => {
      if (!session?.user?.email) return;

      const bilhete = ++requisicaoEmCurso.current;

      if (showRefreshState) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      setError(null);

      try {
        const url = new URL(`${getApiBaseUrl()}/marketplace/facebook/listings`);
        if (selectedAccountId)
          url.searchParams.set("accountId", selectedAccountId);
        url.searchParams.set("page", String(page));
        url.searchParams.set("limit", String(LISTINGS_POR_PAGINA));

        const response = await fetch(url.toString(), {
          headers: { email: session.user.email },
        });

        if (!response.ok) {
          const data = await response.json();
          if (response.status === 404) {
            if (bilhete !== requisicaoEmCurso.current) return;
            setListings([]);
            return;
          }
          throw new Error(data.message || "Erro ao buscar anúncios");
        }

        const data: ListingsResponse = await response.json();
        // Chegou depois de outra requisição ter sido disparada: descarta.
        if (bilhete !== requisicaoEmCurso.current) return;
        setListings(data.listings);
        // Servidor sem paginação (deploy antigo): trata como página única com o
        // que veio, em vez de zerar o rodapé.
        setPagination(
          data.pagination ?? {
            page: 1,
            limit: LISTINGS_POR_PAGINA,
            total: data.listings.length,
            totalPages: 1,
          },
        );
        // Beco sem saída: se a página atual ficou além do fim (anúncios apagados
        // por outro caminho, ou refresh depois de uma limpeza), a tela mostraria
        // uma lista vazia com os botões travados e nenhuma forma de voltar.
        // Volta para a primeira — não há laço, porque a página 1 nunca reentra.
        if (data.listings.length === 0 && page > 1) {
          setPage(1);
        }
      } catch (err) {
        if (bilhete !== requisicaoEmCurso.current) return;
        setError(err instanceof Error ? err.message : "Erro desconhecido");
      } finally {
        // Só a requisição mais nova desliga o "carregando"; senão a resposta
        // velha destrava a tela enquanto a nova ainda está em voo.
        if (bilhete === requisicaoEmCurso.current) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [session?.user?.email, selectedAccountId, page],
  );

  useEffect(() => {
    if (session?.user?.email) {
      fetchListings();
    }
  }, [session?.user?.email, fetchListings]);

  useEffect(() => {
    const loadAccounts = async () => {
      if (!session?.user?.email) return;
      try {
        const res = await fetch(
          `${getApiBaseUrl()}/marketplace/facebook/accounts`,
          { headers: { email: session.user.email } },
        );
        if (res.ok) {
          const data = await res.json();
          setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
        }
      } catch {
        /* ignore errors silently */
      }
    };
    loadAccounts();
  }, [session?.user?.email]);

  const handleRefresh = () => {
    fetchListings(true);
  };

  const getStatusBadge = (status: string) => {
    switch (status.toLowerCase()) {
      case "active":
        return <Badge variant="default">Ativo</Badge>;
      case "paused":
        return <Badge variant="secondary">Indisponível</Badge>;
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
    return <FacebookListingsSkeleton />;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5" />
              Vínculos Produto-Catálogo
            </CardTitle>
            <CardDescription>
              Produtos do seu estoque vinculados a itens do catálogo do Facebook
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="rounded border px-2 py-1 text-sm"
              value={selectedAccountId}
              onChange={(e) => {
                // A página volta para 1 AQUI, no mesmo evento da troca de conta.
                // Num `useEffect` separado, os dois viajavam em commits
                // diferentes: a busca saía uma vez com a página antiga e outra
                // com a nova — duas requisições, e a velha podia chegar por
                // último e esvaziar a tela. No mesmo handler, o React agrupa as
                // duas escritas e sai UMA busca.
                setSelectedAccountId(e.target.value);
                setPage(1);
              }}
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
              Seus itens do catálogo do Facebook ainda não estão vinculados aos
              produtos do seu estoque. Publique produtos no catálogo a partir do
              seu estoque primeiro.
            </p>
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produto</TableHead>
                  <TableHead>SKU Facebook</TableHead>
                  <TableHead>ID Item</TableHead>
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
                        const linkListing = {
                          platform: "FACEBOOK" as const,
                          externalListingId: listing.externalListingId,
                          permalink: listing.permalink,
                          fbCatalogId: listing.fbCatalogId,
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
                              <span className="sr-only">
                                Anúncio indisponível
                              </span>
                            </Button>
                          );
                        }

                        return (
                          <Button variant="ghost" size="sm" asChild>
                            <a
                              href={linkState.href ?? "#"}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={FACEBOOK_COMMERCE_MANAGER_HINT}
                            >
                              <ExternalLink className="h-4 w-4" />
                              <span className="sr-only">Ver no Facebook</span>
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
          <ListingsPagination
            mostrando={listings.length}
            total={pagination.total}
            page={page}
            totalPages={pagination.totalPages}
            onPageChange={setPage}
            carregando={isLoading || isRefreshing}
          />
        )}
      </CardContent>
    </Card>
  );
}
