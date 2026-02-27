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

interface Listing {
  id: string;
  productId: string;
  externalListingId: string;
  externalSku: string | null;
  status: string;
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

export function ShopeeListingsTab() {
  const { data: session } = useSession();
  const [listings, setListings] = useState<Listing[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<
    Array<{ id: string; accountName: string; shopId?: number }>
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
        const url = new URL(
          "http://localhost:3333/marketplace/shopee/listings",
        );
        if (selectedAccountId) url.searchParams.set("accountId", selectedAccountId);

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

  // Carregar listings iniciais
  useEffect(() => {
    fetchListings();
  }, [fetchListings]);

  // Carregar contas para filtro
  useEffect(() => {
    const loadAccounts = async () => {
      if (!session?.user?.email) return;
      try {
        const res = await fetch(
          "http://localhost:3333/marketplace/shopee/accounts",
          { headers: { email: session.user.email } },
        );
        if (res.ok) {
          const data = await res.json();
          setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
        }
      } catch (err) {
        /* ignore */
      }
    };
    loadAccounts();
  }, [session?.user?.email]);

  // Status badge
  const getStatusBadge = (status: string) => {
    const statusConfig = {
      active: { variant: "default" as const, label: "Ativo" },
      paused: { variant: "secondary" as const, label: "Pausado" },
      closed: { variant: "destructive" as const, label: "Encerrado" },
      NORMAL: { variant: "default" as const, label: "Ativo" },
      DELETED: { variant: "destructive" as const, label: "Deletado" },
      BANNED: { variant: "destructive" as const, label: "Banido" },
      UNLIST: { variant: "secondary" as const, label: "Deslistado" },
    };

    const config = statusConfig[status as keyof typeof statusConfig] || {
      variant: "outline" as const,
      label: status,
    };

    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <RefreshCw className="h-8 w-8 animate-spin" />
          <span className="ml-2">Carregando anúncios...</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5" />
                Anúncios no Shopee
              </CardTitle>
              <CardDescription>
                Lista de produtos vinculados à sua conta do Shopee
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
                onClick={() => fetchListings(true)}
                disabled={isRefreshing}
              >
                {isRefreshing ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {listings.length === 0 ? (
            <div className="text-center py-8">
              <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium text-muted-foreground mb-2">
                Nenhum anúncio encontrado
              </h3>
              <p className="text-sm text-muted-foreground">
                Conecte sua conta do Shopee e importe seus anúncios para
                começar.
              </p>
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Produto</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Estoque</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Criado em</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listings.map((listing) => (
                    <TableRow key={listing.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Link2 className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <div className="font-medium">
                              {listing.product?.name ||
                                "Produto não encontrado"}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              ID: {listing.externalListingId}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {listing.externalSku || listing.product?.sku || "-"}
                      </TableCell>
                      <TableCell>{listing.product?.stock ?? "-"}</TableCell>
                      <TableCell>{getStatusBadge(listing.status)}</TableCell>
                      <TableCell>
                        {new Date(listing.createdAt).toLocaleDateString(
                          "pt-BR",
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
