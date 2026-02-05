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
import { MLListingsSkeleton } from "./ml-skeleton";

interface Listing {
  id: string;
  productId: string;
  externalListingId: string;
  externalSku: string | null;
  permalink: string | null;
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

export function MLListingsTab() {
  const { data: session } = useSession();
  const [listings, setListings] = useState<Listing[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        const response = await fetch(
          "http://localhost:3333/marketplace/ml/listings",
          {
            headers: {
              email: session.user.email,
            },
          },
        );

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
    [session?.user?.email],
  );

  useEffect(() => {
    if (session?.user?.email) {
      fetchListings();
    }
  }, [session?.user?.email, fetchListings]);

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
                    <TableCell>{getStatusBadge(listing.status)}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <a
                          href={
                            listing.permalink ||
                            `https://produto.mercadolivre.com.br/${listing.externalListingId}`
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink className="h-4 w-4" />
                          <span className="sr-only">Ver no ML</span>
                        </a>
                      </Button>
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
