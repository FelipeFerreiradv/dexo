"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Barcode,
  Box,
  Calendar,
  Car,
  Clock,
  DollarSign,
  ExternalLink,
  FileText,
  History,
  Image as ImageIcon,
  MapPin,
  Package,
  Ruler,
  ScanLine,
  ShieldCheck,
  Tag,
  TrendingUp,
  User,
  Warehouse,
  Weight,
  ZoomIn,
} from "lucide-react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { ImageLightbox } from "./image-lightbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { MarketplaceListingPlatform } from "@/app/lib/marketplace-listing-links";
import { getApiBaseUrl } from "@/lib/api";
import {
  LISTING_PLATFORM_LABELS,
  LISTING_STATUS_LABELS,
} from "@/app/produtos/lib/listing-status-labels";

type Quality = "SUCATA" | "SEMINOVO" | "NOVO" | "RECONDICIONADO";

// Tipo permissivo (aceita null e undefined) para compatibilizar com a
// interface Product local de products-list.tsx e a interface global de
// app/interfaces/product.interface.ts. Apenas leitura.
interface ProductLike {
  id: string;
  sku: string;
  name: string;
  description?: string | null;
  price: number;
  stock: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  costPrice?: number | null;
  markup?: number | null;
  brand?: string | null;
  model?: string | null;
  year?: string | null;
  version?: string | null;
  category?: string | null;
  location?: string | null;
  locationId?: string | null;
  partNumber?: string | null;
  quality?: Quality | string | null;
  isSecurityItem?: boolean | null;
  isTraceable?: boolean | null;
  sourceVehicle?: string | null;
  imageUrl?: string | null;
  imageUrls?: string[] | null;
  heightCm?: number | null;
  widthCm?: number | null;
  lengthCm?: number | null;
  weightKg?: number | null;
  attributes?:
    | Record<string, { value_id?: string; value_name?: string }>
    | null;
  compatibilities?: Array<{
    brand: string;
    model: string;
    yearFrom?: number | null;
    yearTo?: number | null;
    version?: string | null;
  }> | null;
}

interface ProductDetailSheetProps {
  product: ProductLike | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

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
  chassis?: string;
}

interface CreatorSummary {
  id: string;
  name?: string;
  email: string;
}

interface ProductLocationSummary {
  id: string;
  code: string;
  description?: string;
}

interface ProductDetailResponse {
  product: ProductLike;
  detailedListings: DetailedListing[];
  recentStockChanges: StockChange[];
  scrapSummary?: ScrapSummary;
  creator?: CreatorSummary;
  productLocation?: ProductLocationSummary;
}

const QUALITY_LABELS: Record<string, string> = {
  SUCATA: "Sucata",
  SEMINOVO: "Seminovo",
  NOVO: "Novo",
  RECONDICIONADO: "Recondicionado",
};

const QUALITY_BADGE_CLASS: Record<string, string> = {
  NOVO: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-950/40 dark:text-emerald-200",
  SEMINOVO:
    "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/40 dark:text-sky-200",
  RECONDICIONADO:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/40 dark:text-amber-200",
  SUCATA:
    "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-500/60 dark:bg-orange-950/40 dark:text-orange-200",
};

const formatCurrency = (value: number) =>
  value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

const formatDateTime = (value: Date | string) =>
  new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });

function getStockBadgeClass(stock: number) {
  if (stock === 0)
    return "border-destructive/60 bg-destructive/10 text-destructive";
  if (stock <= 10)
    return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/40 dark:text-amber-200";
  return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-950/40 dark:text-emerald-200";
}

interface InfoCardProps {
  icon: React.ReactNode;
  label: string;
  value?: React.ReactNode;
  secondary?: React.ReactNode;
  fullWidth?: boolean;
}

function InfoCard({ icon, label, value, secondary, fullWidth }: InfoCardProps) {
  return (
    <div
      className={`rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur ${fullWidth ? "md:col-span-2" : ""}`}
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-2 text-base font-semibold text-foreground">
        {value ?? <span className="text-muted-foreground/70">—</span>}
      </div>
      {secondary ? (
        <p className="mt-1 text-sm text-muted-foreground">{secondary}</p>
      ) : null}
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-inner shadow-primary/10">
        {icon}
      </span>
      <div>
        <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          {subtitle ?? "Detalhes"}
        </p>
        <p className="text-sm font-semibold text-foreground">{title}</p>
      </div>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur">
      <div className="h-3 w-24 animate-pulse rounded bg-muted" />
      <div className="mt-3 h-5 w-32 animate-pulse rounded bg-muted" />
      <div className="mt-2 h-3 w-40 animate-pulse rounded bg-muted/60" />
    </div>
  );
}

export function ProductDetailSheet({
  product,
  open,
  onOpenChange,
}: ProductDetailSheetProps) {
  const { data: session } = useSession();
  const [detail, setDetail] = useState<ProductDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionEmail = session?.user?.email;
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Reset do lightbox quando o Sheet fechar
  useEffect(() => {
    if (!open) setLightboxIndex(null);
  }, [open]);

  useEffect(() => {
    if (!open || !product?.id || !sessionEmail) return;

    let cancelled = false;
    setDetail(null);
    setError(null);
    setLoading(true);

    (async () => {
      try {
        const res = await fetch(
          `${getApiBaseUrl()}/products/${encodeURIComponent(product.id)}`,
          { headers: { email: sessionEmail } },
        );
        if (cancelled) return;
        if (!res.ok) {
          setError("Não foi possível carregar os detalhes do produto.");
          return;
        }
        const json = (await res.json()) as ProductDetailResponse;
        if (!cancelled) setDetail(json);
      } catch {
        if (!cancelled)
          setError("Erro de conexão ao carregar detalhes do produto.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, product?.id, sessionEmail]);

  if (!product) return null;

  const merged = detail?.product ?? product;
  const qualityKey = (merged.quality ?? "") as string;
  const qualityLabel = QUALITY_LABELS[qualityKey];
  const qualityClass = QUALITY_BADGE_CLASS[qualityKey];
  const allImages = (() => {
    const seen = new Set<string>();
    const list: string[] = [];
    if (merged.imageUrl) {
      seen.add(merged.imageUrl);
      list.push(merged.imageUrl);
    }
    for (const url of merged.imageUrls ?? []) {
      if (url && !seen.has(url)) {
        seen.add(url);
        list.push(url);
      }
    }
    return list;
  })();
  const hasVehicularInfo = Boolean(
    merged.brand ||
      merged.model ||
      merged.year ||
      merged.version ||
      merged.sourceVehicle,
  );
  const hasDimensions = Boolean(
    merged.heightCm || merged.widthCm || merged.lengthCm || merged.weightKg,
  );
  const attributesEntries = merged.attributes
    ? Object.entries(merged.attributes).filter(
        ([, v]) => v && (v.value_name || v.value_id),
      )
    : [];
  const compatibilities = merged.compatibilities ?? [];
  const detailedListings = detail?.detailedListings ?? [];
  const recentStockChanges = detail?.recentStockChanges ?? [];
  const scrapSummary = detail?.scrapSummary;
  const productLocation = detail?.productLocation;
  const creator = detail?.creator;

  return (
    <>
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-hidden border-l border-border/60 bg-gradient-to-b from-background via-background to-muted p-0 shadow-2xl sm:max-w-[900px] lg:max-w-[1100px]"
      >
        <SheetTitle className="sr-only">
          Detalhes do produto {merged.name}
        </SheetTitle>
        <div className="relative flex h-full flex-col">
          <div className="relative isolate overflow-hidden border-b border-border/60 bg-gradient-to-r from-primary/12 via-primary/6 to-transparent pl-6 pr-12 pb-6 pt-6">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 w-48 bg-[radial-gradient(circle_at_top_left,theme(colors.primary/25),transparent_55%)] opacity-80"
            />
            <div className="relative z-10 flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                {merged.imageUrl ? (
                  <button
                    type="button"
                    onClick={() => setLightboxIndex(0)}
                    title="Ampliar imagem"
                    className="group relative size-16 shrink-0 overflow-hidden rounded-xl border border-border/60 bg-card shadow-inner transition-shadow hover:shadow-md"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={merged.imageUrl}
                      alt={merged.name}
                      className="absolute inset-0 size-full object-cover transition-transform group-hover:scale-105"
                    />
                    <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100">
                      <ZoomIn className="size-5 text-white drop-shadow" />
                    </span>
                  </button>
                ) : (
                  <span className="flex size-16 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-primary/10 text-primary shadow-inner shadow-primary/20">
                    <Package className="size-7" />
                  </span>
                )}
                <div className="space-y-2">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      Produto
                    </p>
                    <p className="text-xl font-semibold leading-tight text-foreground">
                      {merged.name}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-card/70 px-3 py-1 font-mono">
                      <Barcode className="size-3" />
                      {merged.sku}
                    </span>
                    {qualityLabel ? (
                      <Badge
                        variant="outline"
                        className={`text-[11px] font-medium uppercase tracking-[0.08em] ${qualityClass ?? "border-border/70"}`}
                      >
                        {qualityLabel}
                      </Badge>
                    ) : null}
                    <Badge
                      variant="outline"
                      className={`text-[11px] font-medium uppercase tracking-[0.08em] ${getStockBadgeClass(merged.stock)}`}
                    >
                      {merged.stock} un.
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-card/70 px-3 py-1">
                      <Clock className="size-3" />
                      Criado em {formatDateTime(merged.createdAt)}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-card/70 px-3 py-1">
                      <Clock className="size-3" />
                      Atualizado em {formatDateTime(merged.updatedAt)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex flex-col items-end gap-1 text-right">
                <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">
                  Valor de venda
                </p>
                <p className="text-3xl font-semibold leading-tight text-foreground">
                  {formatCurrency(Number(merged.price))}
                </p>
                {merged.costPrice !== undefined && merged.costPrice !== null ? (
                  <p className="text-xs text-muted-foreground">
                    Custo: {formatCurrency(Number(merged.costPrice))}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          <div className="flex-1 space-y-6 overflow-y-auto px-6 pb-8 pt-6">
            {error ? (
              <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            {/* Identificação */}
            <section className="space-y-3">
              <SectionHeader
                icon={<Tag className="size-4" />}
                title="Identificação"
              />
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <InfoCard
                  icon={<Barcode className="size-4" />}
                  label="SKU"
                  value={<span className="font-mono">{merged.sku}</span>}
                />
                <InfoCard
                  icon={<FileText className="size-4" />}
                  label="Código interno"
                  value={
                    <span className="font-mono text-xs">{merged.id}</span>
                  }
                />
                {merged.partNumber ? (
                  <InfoCard
                    icon={<Tag className="size-4" />}
                    label="Part number"
                    value={merged.partNumber}
                  />
                ) : null}
                {merged.category ? (
                  <InfoCard
                    icon={<Tag className="size-4" />}
                    label="Categoria"
                    value={merged.category}
                  />
                ) : null}
                {merged.description ? (
                  <InfoCard
                    icon={<FileText className="size-4" />}
                    label="Descrição"
                    value={
                      <span className="whitespace-pre-wrap break-words text-sm font-normal text-foreground/90">
                        {merged.description}
                      </span>
                    }
                    fullWidth
                  />
                ) : null}
              </div>
            </section>

            {/* Preços e estoque */}
            <section className="space-y-3">
              <SectionHeader
                icon={<DollarSign className="size-4" />}
                title="Preços e estoque"
              />
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                <InfoCard
                  icon={<DollarSign className="size-4" />}
                  label="Valor de venda"
                  value={formatCurrency(Number(merged.price))}
                />
                <InfoCard
                  icon={<DollarSign className="size-4" />}
                  label="Valor de compra"
                  value={
                    merged.costPrice !== undefined && merged.costPrice !== null
                      ? formatCurrency(Number(merged.costPrice))
                      : undefined
                  }
                />
                <InfoCard
                  icon={<TrendingUp className="size-4" />}
                  label="Markup"
                  value={
                    merged.markup !== undefined && merged.markup !== null
                      ? `${Number(merged.markup).toFixed(2)}%`
                      : undefined
                  }
                />
                <InfoCard
                  icon={<Box className="size-4" />}
                  label="Estoque"
                  value={
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-sm font-semibold ${getStockBadgeClass(merged.stock)}`}
                    >
                      {merged.stock} un.
                    </span>
                  }
                />
              </div>
            </section>

            {/* Identificação veicular do produto */}
            {hasVehicularInfo ? (
              <section className="space-y-3">
                <SectionHeader
                  icon={<Car className="size-4" />}
                  title="Marca e modelo do produto"
                />
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {merged.brand ? (
                    <InfoCard
                      icon={<Tag className="size-4" />}
                      label="Marca"
                      value={merged.brand}
                    />
                  ) : null}
                  {merged.model ? (
                    <InfoCard
                      icon={<Tag className="size-4" />}
                      label="Modelo"
                      value={merged.model}
                    />
                  ) : null}
                  {merged.year ? (
                    <InfoCard
                      icon={<Calendar className="size-4" />}
                      label="Ano"
                      value={merged.year}
                    />
                  ) : null}
                  {merged.version ? (
                    <InfoCard
                      icon={<Tag className="size-4" />}
                      label="Versão"
                      value={merged.version}
                    />
                  ) : null}
                  {merged.sourceVehicle ? (
                    <InfoCard
                      icon={<Car className="size-4" />}
                      label="Veículo de origem"
                      value={merged.sourceVehicle}
                      fullWidth
                    />
                  ) : null}
                </div>
              </section>
            ) : null}

            {/* Compatibilidades veiculares */}
            {compatibilities.length > 0 ? (
              <section className="space-y-3">
                <SectionHeader
                  icon={<Car className="size-4" />}
                  title="Compatibilidades veiculares"
                  subtitle={`${compatibilities.length} aplicaç${compatibilities.length === 1 ? "ão" : "ões"}`}
                />
                <div className="rounded-2xl border border-border/60 bg-card/80 shadow-sm backdrop-blur">
                  <div className="p-4">
                    <Table className="[&_th]:text-xs">
                      <TableHeader className="bg-muted/40">
                        <TableRow>
                          <TableHead>Marca</TableHead>
                          <TableHead>Modelo</TableHead>
                          <TableHead>Anos</TableHead>
                          <TableHead>Versão</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {compatibilities.map((c, idx) => (
                          <TableRow key={idx} className="hover:bg-muted/40">
                            <TableCell className="font-medium">
                              {c.brand}
                            </TableCell>
                            <TableCell>{c.model}</TableCell>
                            <TableCell className="text-muted-foreground">
                              {c.yearFrom || c.yearTo
                                ? `${c.yearFrom ?? "?"} → ${c.yearTo ?? "?"}`
                                : "—"}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {c.version ?? "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </section>
            ) : null}

            {/* Localização */}
            {(merged.location || productLocation) ? (
              <section className="space-y-3">
                <SectionHeader
                  icon={<MapPin className="size-4" />}
                  title="Localização"
                />
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {productLocation ? (
                    <InfoCard
                      icon={<Warehouse className="size-4" />}
                      label="Localização cadastrada"
                      value={productLocation.code}
                      secondary={productLocation.description}
                    />
                  ) : null}
                  {merged.location ? (
                    <InfoCard
                      icon={<MapPin className="size-4" />}
                      label="Referência"
                      value={merged.location}
                    />
                  ) : null}
                </div>
              </section>
            ) : null}

            {/* Origem veicular (sucata) */}
            {scrapSummary ? (
              <section className="space-y-3">
                <SectionHeader
                  icon={<Car className="size-4" />}
                  title="Origem veicular (sucata)"
                  subtitle="Veículo desmontado"
                />
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <InfoCard
                    icon={<Tag className="size-4" />}
                    label="Marca / Modelo"
                    value={`${scrapSummary.brand} ${scrapSummary.model}`}
                    secondary={
                      [scrapSummary.year, scrapSummary.version]
                        .filter(Boolean)
                        .join(" · ") || undefined
                    }
                  />
                  <InfoCard
                    icon={<Tag className="size-4" />}
                    label="Cor"
                    value={scrapSummary.color}
                  />
                  <InfoCard
                    icon={<FileText className="size-4" />}
                    label="Placa"
                    value={scrapSummary.plate}
                  />
                  <InfoCard
                    icon={<Barcode className="size-4" />}
                    label="Chassi"
                    value={
                      scrapSummary.chassis ? (
                        <span className="font-mono text-sm">
                          {scrapSummary.chassis}
                        </span>
                      ) : undefined
                    }
                  />
                </div>
              </section>
            ) : null}

            {/* Dimensões */}
            {hasDimensions ? (
              <section className="space-y-3">
                <SectionHeader
                  icon={<Ruler className="size-4" />}
                  title="Dimensões e peso"
                />
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  <InfoCard
                    icon={<Ruler className="size-4" />}
                    label="Altura"
                    value={merged.heightCm ? `${merged.heightCm} cm` : undefined}
                  />
                  <InfoCard
                    icon={<Ruler className="size-4" />}
                    label="Largura"
                    value={merged.widthCm ? `${merged.widthCm} cm` : undefined}
                  />
                  <InfoCard
                    icon={<Ruler className="size-4" />}
                    label="Comprimento"
                    value={merged.lengthCm ? `${merged.lengthCm} cm` : undefined}
                  />
                  <InfoCard
                    icon={<Weight className="size-4" />}
                    label="Peso"
                    value={
                      merged.weightKg ? `${Number(merged.weightKg)} kg` : undefined
                    }
                  />
                </div>
              </section>
            ) : null}

            {/* Flags + atributos */}
            {(merged.isSecurityItem ||
              merged.isTraceable ||
              attributesEntries.length > 0) ? (
              <section className="space-y-3">
                <SectionHeader
                  icon={<FileText className="size-4" />}
                  title="Informações adicionais"
                />

                {(merged.isSecurityItem || merged.isTraceable) ? (
                  <div className="flex flex-wrap gap-2">
                    {merged.isSecurityItem ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/40 dark:text-amber-200">
                        <ShieldCheck className="size-3" />
                        Item de segurança
                      </span>
                    ) : null}
                    {merged.isTraceable ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/40 dark:text-sky-200">
                        <ScanLine className="size-3" />
                        Rastreável
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {attributesEntries.length > 0 ? (
                  <div className="rounded-2xl border border-border/60 bg-card/80 shadow-sm backdrop-blur">
                    <div className="border-b border-border/60 px-4 py-3">
                      <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">
                        Ficha técnica
                      </p>
                      <p className="text-sm font-semibold text-foreground">
                        {attributesEntries.length} atributo
                        {attributesEntries.length === 1 ? "" : "s"} preenchido
                        {attributesEntries.length === 1 ? "" : "s"}
                      </p>
                    </div>
                    <div className="grid grid-cols-1 gap-x-6 gap-y-1 p-4 md:grid-cols-2">
                      {attributesEntries.map(([key, value]) => (
                        <div
                          key={key}
                          className="flex items-start justify-between gap-3 border-b border-border/40 py-2 last:border-b-0 md:last:border-b-0"
                        >
                          <span className="text-xs uppercase tracking-[0.06em] text-muted-foreground">
                            {key}
                          </span>
                          <span className="text-right text-sm font-medium text-foreground">
                            {value.value_name ?? value.value_id ?? "—"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

              </section>
            ) : null}

            {/* Imagens extras */}
            {allImages.length > 0 ? (
              <section className="space-y-3">
                <SectionHeader
                  icon={<ImageIcon className="size-4" />}
                  title="Imagens"
                  subtitle={`${allImages.length} foto${allImages.length === 1 ? "" : "s"}`}
                />
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
                  {allImages.map((url, idx) => (
                    <button
                      key={url}
                      type="button"
                      onClick={() => setLightboxIndex(idx)}
                      title="Ampliar imagem"
                      className="group relative aspect-square w-full overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm transition-shadow hover:shadow-md"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={url}
                        alt={`${merged.name} - imagem ${idx + 1}`}
                        className="absolute inset-0 size-full object-cover transition-transform group-hover:scale-105"
                      />
                      <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100">
                        <ZoomIn className="size-6 text-white drop-shadow" />
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {/* Marketplaces */}
            {loading && !detail ? (
              <section className="space-y-3">
                <SectionHeader
                  icon={<ExternalLink className="size-4" />}
                  title="Carregando dados completos…"
                />
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <CardSkeleton />
                  <CardSkeleton />
                </div>
              </section>
            ) : detailedListings.length > 0 ? (
              <section className="rounded-2xl border border-border/60 bg-card/80 shadow-sm backdrop-blur">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">
                      Marketplaces vinculados
                    </p>
                    <p className="text-sm font-semibold text-foreground">
                      {detailedListings.length} anúncio
                      {detailedListings.length === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                <div className="p-4">
                  <Table className="[&_th]:text-xs">
                    <TableHeader className="bg-muted/40">
                      <TableRow>
                        <TableHead>Plataforma</TableHead>
                        <TableHead>Conta</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Link</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detailedListings.map((l) => (
                        <TableRow key={l.id} className="hover:bg-muted/40">
                          <TableCell className="font-medium">
                            {LISTING_PLATFORM_LABELS[
                              l.platform as MarketplaceListingPlatform
                            ] ?? l.platform}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {l.accountName}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className="text-[11px] uppercase tracking-[0.06em]"
                            >
                              {LISTING_STATUS_LABELS[l.status]?.label ??
                                l.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            {l.permalink ? (
                              <a
                                href={l.permalink}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                              >
                                Abrir
                                <ExternalLink className="size-3" />
                              </a>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                —
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            ) : null}

            {/* Histórico de estoque */}
            {recentStockChanges.length > 0 ? (
              <section className="rounded-2xl border border-border/60 bg-card/80 shadow-sm backdrop-blur">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">
                      Histórico de estoque
                    </p>
                    <p className="text-sm font-semibold text-foreground">
                      Últimos {recentStockChanges.length} movimento
                      {recentStockChanges.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <History className="size-3" />
                    Movimentações
                  </span>
                </div>
                <div className="p-4">
                  <Table className="[&_th]:text-xs">
                    <TableHeader className="bg-muted/40">
                      <TableRow>
                        <TableHead>Data</TableHead>
                        <TableHead>Motivo</TableHead>
                        <TableHead>Movimento</TableHead>
                        <TableHead>De → Para</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recentStockChanges.map((s) => (
                        <TableRow key={s.id} className="hover:bg-muted/40">
                          <TableCell className="text-muted-foreground">
                            {formatDateTime(s.createdAt)}
                          </TableCell>
                          <TableCell>{s.reason || "—"}</TableCell>
                          <TableCell
                            className={
                              s.change > 0
                                ? "font-semibold text-emerald-600 dark:text-emerald-400"
                                : s.change < 0
                                  ? "font-semibold text-destructive"
                                  : "text-muted-foreground"
                            }
                          >
                            {s.change > 0 ? `+${s.change}` : s.change}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {s.previousStock} → {s.newStock}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            ) : null}

            {/* Auditoria */}
            <section className="space-y-3">
              <SectionHeader
                icon={<Clock className="size-4" />}
                title="Auditoria"
                subtitle="Criação e atualização"
              />
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <InfoCard
                  icon={<User className="size-4" />}
                  label="Criado por"
                  value={creator?.name ?? creator?.email}
                  secondary={creator?.name ? creator?.email : undefined}
                />
                <InfoCard
                  icon={<Calendar className="size-4" />}
                  label="Criado em"
                  value={formatDateTime(merged.createdAt)}
                />
                <InfoCard
                  icon={<Calendar className="size-4" />}
                  label="Atualizado em"
                  value={formatDateTime(merged.updatedAt)}
                />
                <InfoCard
                  icon={<FileText className="size-4" />}
                  label="ID interno"
                  value={
                    <span className="font-mono text-xs">{merged.id}</span>
                  }
                />
              </div>
            </section>
          </div>
        </div>
      </SheetContent>
    </Sheet>

    <ImageLightbox
      images={allImages}
      open={lightboxIndex !== null}
      onOpenChange={(o) => {
        if (!o) setLightboxIndex(null);
      }}
      initialIndex={lightboxIndex ?? 0}
      alt={merged.name}
    />
    </>
  );
}
