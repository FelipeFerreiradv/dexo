"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import {
  ArrowLeft,
  Package,
  ShieldCheck,
  ScanLine,
  AlertTriangle,
  Box,
  Tag,
  MapPin,
  Ruler,
  Weight,
  ImageIcon,
  Car,
  History,
  ExternalLink,
  Loader2,
} from "lucide-react";

import { getApiBaseUrl } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface DetailedListing {
  id: string;
  platform: string;
  accountName: string;
  marketplaceAccountId: string;
  externalListingId: string;
  status: string;
  permalink?: string;
  shopId?: number;
  createdAt: string;
  updatedAt: string;
}

interface StockChange {
  id: string;
  change: number;
  reason: string;
  previousStock: number;
  newStock: number;
  createdAt: string;
}

interface ScrapSummary {
  id: string;
  brand: string;
  model: string;
  year?: string;
  version?: string;
  color?: string;
  plate?: string;
}

interface Compatibility {
  brand: string;
  model: string;
  yearFrom?: number | null;
  yearTo?: number | null;
  version?: string | null;
}

interface ProductData {
  id: string;
  sku: string;
  name: string;
  description?: string;
  stock: number;
  price: number;
  createdAt: string;
  updatedAt: string;
  costPrice?: number;
  markup?: number;
  brand?: string;
  model?: string;
  year?: string;
  version?: string;
  category?: string;
  location?: string;
  partNumber?: string;
  quality?: string;
  isSecurityItem?: boolean;
  isTraceable?: boolean;
  sourceVehicle?: string;
  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightKg?: number;
  imageUrl?: string;
  imageUrls?: string[];
  scrapId?: string;
  compatibilities?: Compatibility[];
}

interface ProductDetailResponse {
  product: ProductData;
  detailedListings: DetailedListing[];
  recentStockChanges: StockChange[];
  scrapSummary?: ScrapSummary;
}

const QUALITY_LABELS: Record<string, string> = {
  SUCATA: "Sucata",
  SEMINOVO: "Seminovo",
  NOVO: "Novo",
  RECONDICIONADO: "Recondicionado",
};

const STATUS_LABELS: Record<string, { label: string; variant: "success" | "warning" | "destructive" | "secondary" }> = {
  active: { label: "Ativo", variant: "success" },
  normal: { label: "Ativo", variant: "success" },
  paused: { label: "Pausado", variant: "warning" },
  unlist: { label: "Pausado", variant: "warning" },
  pending: { label: "Pendente", variant: "secondary" },
  reviewing: { label: "Em revisão", variant: "secondary" },
  closed: { label: "Fechado", variant: "destructive" },
  deleted: { label: "Excluído", variant: "destructive" },
  seller_deleted: { label: "Excluído", variant: "destructive" },
  inactive: { label: "Inativo", variant: "destructive" },
  error: { label: "Erro", variant: "destructive" },
  banned: { label: "Banido", variant: "destructive" },
};

const PLATFORM_LABELS: Record<string, string> = {
  MERCADO_LIVRE: "Mercado Livre",
  SHOPEE: "Shopee",
};

const priceFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatPrice(price: number) {
  return priceFormatter.format(price);
}

function formatDate(dateString: string) {
  return dateFormatter.format(new Date(dateString));
}

function formatDateTime(dateString: string) {
  return dateTimeFormatter.format(new Date(dateString));
}

function getStockBadgeVariant(stock: number) {
  if (stock === 0) return "destructive" as const;
  if (stock <= 10) return "warning" as const;
  return "success" as const;
}

function getAllImages(product: ProductData): string[] {
  const seen = new Set<string>();
  const images: string[] = [];
  if (product.imageUrl) {
    seen.add(product.imageUrl);
    images.push(product.imageUrl);
  }
  if (product.imageUrls) {
    for (const url of product.imageUrls) {
      if (url && !seen.has(url)) {
        seen.add(url);
        images.push(url);
      }
    }
  }
  return images;
}

function InfoRow({ label, value }: { label: string; value?: string | number | null }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <span className="text-sm font-medium text-right">{value}</span>
    </div>
  );
}

export function ProductDetail({ productId }: { productId: string }) {
  const { data: session } = useSession();
  const [data, setData] = useState<ProductDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!session?.user?.email) return;

    let cancelled = false;

    async function fetchProduct() {
      try {
        const res = await fetch(
          `${getApiBaseUrl()}/products/${encodeURIComponent(productId)}`,
          { headers: { email: session!.user!.email! } },
        );

        if (cancelled) return;

        if (res.status === 404) {
          setNotFound(true);
          setLoading(false);
          return;
        }

        if (!res.ok) throw new Error("Erro ao buscar produto");

        const json = await res.json();
        setData(json);
      } catch {
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchProduct();
    return () => { cancelled = true; };
  }, [productId, session]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (notFound || !data) {
    return (
      <div className="space-y-8">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/produtos">
            <ArrowLeft className="mr-2 size-4" />
            Voltar para produtos
          </Link>
        </Button>
        <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
          <Package className="size-16 text-muted-foreground/40" />
          <h2 className="text-xl font-semibold">Produto não encontrado</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            Este produto pode ter sido removido ou o link é inválido.
          </p>
        </div>
      </div>
    );
  }

  const { product, detailedListings, recentStockChanges, scrapSummary } = data;
  const images = getAllImages(product);
  const hasActiveListings = detailedListings.some(
    (l) => l.status === "active" || l.status === "normal",
  );
  const isOutOfStock = product.stock === 0;
  const allListingsClosed = detailedListings.length > 0 && detailedListings.every(
    (l) => ["closed", "deleted", "seller_deleted", "inactive"].includes(l.status),
  );

  return (
    <div className="space-y-6">
      {/* Back button */}
      <Button variant="ghost" size="sm" asChild>
        <Link href="/produtos">
          <ArrowLeft className="mr-2 size-4" />
          Voltar para produtos
        </Link>
      </Button>

      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          {images.length > 0 ? (
            <div className="relative size-20 shrink-0 overflow-hidden rounded-lg border bg-muted">
              <img
                src={images[0]}
                alt={product.name}
                className="absolute inset-0 h-full w-full object-cover"
              />
            </div>
          ) : (
            <div className="flex size-20 shrink-0 items-center justify-center rounded-lg border bg-muted">
              <ImageIcon className="size-8 text-muted-foreground/40" />
            </div>
          )}

          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold leading-tight sm:text-2xl">
              {product.name}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{product.sku}</Badge>
              <Badge variant={getStockBadgeVariant(product.stock)}>
                {product.stock} un.
              </Badge>
              {product.quality && (
                <Badge variant="secondary">
                  {QUALITY_LABELS[product.quality] || product.quality}
                </Badge>
              )}
              {product.isTraceable && (
                <Badge variant="secondary">
                  <ScanLine className="mr-1 size-3" />
                  Rastreável
                </Badge>
              )}
              {product.isSecurityItem && (
                <Badge variant="secondary">
                  <ShieldCheck className="mr-1 size-3" />
                  Item de segurança
                </Badge>
              )}
            </div>
            {/* Status alerts */}
            {(isOutOfStock || allListingsClosed) && (
              <div className="flex flex-wrap gap-2 pt-1">
                {isOutOfStock && (
                  <div className="inline-flex items-center gap-1.5 rounded-md bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive">
                    <AlertTriangle className="size-3" />
                    Sem estoque
                  </div>
                )}
                {allListingsClosed && (
                  <div className="inline-flex items-center gap-1.5 rounded-md bg-yellow-500/10 px-2.5 py-1 text-xs font-medium text-yellow-600 dark:text-yellow-400">
                    <AlertTriangle className="size-3" />
                    Todos os anúncios inativos
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="text-right">
          <p className="text-2xl font-bold">{formatPrice(product.price)}</p>
          {product.costPrice !== undefined && (
            <p className="text-sm text-muted-foreground">
              Custo: {formatPrice(product.costPrice)}
            </p>
          )}
          {product.markup !== undefined && (
            <p className="text-sm text-muted-foreground">
              Markup: {product.markup}%
            </p>
          )}
        </div>
      </div>

      {/* Cards grid */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Commercial summary */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Tag className="size-4" />
              Resumo Comercial
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            <InfoRow label="Preço de venda" value={formatPrice(product.price)} />
            {product.costPrice !== undefined && (
              <InfoRow label="Preço de custo" value={formatPrice(product.costPrice)} />
            )}
            {product.markup !== undefined && (
              <InfoRow label="Markup" value={`${product.markup}%`} />
            )}
            <InfoRow label="Estoque" value={`${product.stock} un.`} />
            <InfoRow label="Qualidade" value={product.quality ? (QUALITY_LABELS[product.quality] || product.quality) : undefined} />
          </CardContent>
        </Card>

        {/* Catalog / Identification */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Box className="size-4" />
              Catálogo e Identificação
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            <InfoRow label="SKU" value={product.sku} />
            <InfoRow label="Part Number" value={product.partNumber} />
            <InfoRow label="Marca" value={product.brand} />
            <InfoRow label="Modelo" value={product.model} />
            <InfoRow label="Ano" value={product.year} />
            <InfoRow label="Versão" value={product.version} />
            <InfoRow label="Categoria" value={product.category} />
          </CardContent>
        </Card>

        {/* Logistics */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MapPin className="size-4" />
              Logística
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            <InfoRow label="Localização" value={product.location} />
            {(product.heightCm || product.widthCm || product.lengthCm) && (
              <div className="flex items-start justify-between gap-4 py-2">
                <span className="text-sm text-muted-foreground shrink-0 flex items-center gap-1">
                  <Ruler className="size-3" />
                  Dimensões
                </span>
                <span className="text-sm font-medium text-right">
                  {[
                    product.heightCm && `${product.heightCm}cm (A)`,
                    product.widthCm && `${product.widthCm}cm (L)`,
                    product.lengthCm && `${product.lengthCm}cm (C)`,
                  ]
                    .filter(Boolean)
                    .join(" × ")}
                </span>
              </div>
            )}
            {product.weightKg !== undefined && (
              <div className="flex items-start justify-between gap-4 py-2">
                <span className="text-sm text-muted-foreground shrink-0 flex items-center gap-1">
                  <Weight className="size-3" />
                  Peso
                </span>
                <span className="text-sm font-medium text-right">
                  {product.weightKg} kg
                </span>
              </div>
            )}
            {product.isSecurityItem && (
              <InfoRow label="Item de segurança" value="Sim" />
            )}
            {product.isTraceable && (
              <InfoRow label="Rastreável" value="Sim" />
            )}
          </CardContent>
        </Card>

        {/* Source / Scrap */}
        {(product.sourceVehicle || scrapSummary) && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Car className="size-4" />
                Origem / Sucata
              </CardTitle>
            </CardHeader>
            <CardContent className="divide-y">
              {product.sourceVehicle && (
                <InfoRow label="Veículo de origem" value={product.sourceVehicle} />
              )}
              {scrapSummary && (
                <>
                  <InfoRow label="Sucata" value={`${scrapSummary.brand} ${scrapSummary.model}`} />
                  {scrapSummary.year && <InfoRow label="Ano da sucata" value={scrapSummary.year} />}
                  {scrapSummary.color && <InfoRow label="Cor" value={scrapSummary.color} />}
                  {scrapSummary.plate && <InfoRow label="Placa" value={scrapSummary.plate} />}
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Images */}
        {images.length > 0 && (
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ImageIcon className="size-4" />
                Imagens ({images.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {images.map((url, i) => (
                  <a
                    key={i}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group relative aspect-square overflow-hidden rounded-lg border bg-muted transition-shadow hover:shadow-md"
                  >
                    <img
                      src={url}
                      alt={`${product.name} - imagem ${i + 1}`}
                      className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
                    />
                  </a>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Compatibilities */}
        {product.compatibilities && product.compatibilities.length > 0 && (
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Car className="size-4" />
                Compatibilidades ({product.compatibilities.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 pr-4 font-medium">Marca</th>
                      <th className="pb-2 pr-4 font-medium">Modelo</th>
                      <th className="pb-2 pr-4 font-medium">Ano</th>
                      <th className="pb-2 font-medium">Versão</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {product.compatibilities.map((c, i) => (
                      <tr key={i}>
                        <td className="py-2 pr-4">{c.brand}</td>
                        <td className="py-2 pr-4">{c.model}</td>
                        <td className="py-2 pr-4">
                          {c.yearFrom && c.yearTo
                            ? `${c.yearFrom} – ${c.yearTo}`
                            : c.yearFrom || c.yearTo || "—"}
                        </td>
                        <td className="py-2">{c.version || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Listings */}
        {detailedListings.length > 0 && (
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Package className="size-4" />
                Anúncios Vinculados ({detailedListings.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {detailedListings.map((listing) => {
                  const statusInfo = STATUS_LABELS[listing.status] || {
                    label: listing.status,
                    variant: "secondary" as const,
                  };
                  return (
                    <div
                      key={listing.id}
                      className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">
                            {PLATFORM_LABELS[listing.platform] || listing.platform}
                          </span>
                          <Badge variant={statusInfo.variant}>
                            {statusInfo.label}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {listing.accountName} · {listing.externalListingId}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Atualizado em {formatDateTime(listing.updatedAt)}
                        </p>
                      </div>
                      {listing.permalink && (
                        <Button variant="outline" size="sm" asChild>
                          <a
                            href={listing.permalink}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="mr-1.5 size-3" />
                            Ver anúncio
                          </a>
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Stock history */}
        {recentStockChanges.length > 0 && (
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="size-4" />
                Histórico de Estoque (últimas {recentStockChanges.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 pr-4 font-medium">Data</th>
                      <th className="pb-2 pr-4 font-medium">Alteração</th>
                      <th className="pb-2 pr-4 font-medium">Estoque</th>
                      <th className="pb-2 font-medium">Motivo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {recentStockChanges.map((log) => (
                      <tr key={log.id}>
                        <td className="py-2 pr-4 whitespace-nowrap">
                          {formatDateTime(log.createdAt)}
                        </td>
                        <td className="py-2 pr-4">
                          <span
                            className={
                              log.change > 0
                                ? "text-green-600 dark:text-green-400"
                                : "text-red-600 dark:text-red-400"
                            }
                          >
                            {log.change > 0 ? `+${log.change}` : log.change}
                          </span>
                        </td>
                        <td className="py-2 pr-4">
                          {log.previousStock} → {log.newStock}
                        </td>
                        <td className="py-2 text-muted-foreground">
                          {log.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Description (full width at the bottom) */}
      {product.description && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Descrição</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {product.description}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Meta */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span>Criado em {formatDate(product.createdAt)}</span>
        <span>·</span>
        <span>Atualizado em {formatDate(product.updatedAt)}</span>
      </div>
    </div>
  );
}
