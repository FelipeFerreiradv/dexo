"use client";

import { useEffect, useState, useCallback } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRightLeft,
  Car,
  ImageIcon,
  Loader2,
  Wallet,
  TrendingUp,
  Package,
  Boxes,
  Hash,
  Gauge,
  ShieldCheck,
  ScanLine,
  History,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { getApiBaseUrl } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { RoiGauge } from "@/components/charts/roi-gauge";
import {
  LOGISTICS_ORDER,
  LOGISTICS_CONFIG,
  type LogisticsStatus,
} from "../lib/logistics";

interface ScrapPart {
  id: string;
  name: string;
  sku: string;
  partNumber?: string;
  price: number;
  stock: number;
  status: "IN_STOCK" | "SOLD";
  quality?: string;
  isSecurityItem: boolean;
  isTraceable: boolean;
  soldQuantity: number;
}

interface ScrapFinancials {
  investment: number;
  realizedRevenue: { marketplace: number; counter: number; total: number };
  potentialRevenue: number;
  roi: number | null;
}

interface ScrapHistoryEvent {
  fromStatus: LogisticsStatus | null;
  toStatus: LogisticsStatus;
  createdAt: string;
}

interface ScrapDetailData {
  id: string;
  brand: string;
  model: string;
  year?: string;
  version?: string;
  color?: string;
  plate?: string;
  chassis?: string;
  lot?: string;
  supplierCnpj?: string;
  paymentMethod?: string;
  cost?: number;
  extraCosts?: number;
  locationCode?: string;
  imageUrls: string[];
  status: string;
  logisticsStatus: LogisticsStatus;
  notes?: string;
  productsCount?: number;
  createdAt: string;
  updatedAt: string;
  financials?: ScrapFinancials;
  products?: ScrapPart[];
  history?: ScrapHistoryEvent[];
}

const moneyFmt = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
});
const priceFmt = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const dateFmt = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const money = (n?: number) => moneyFmt.format(n ?? 0);
const price = (n?: number) => priceFmt.format(n ?? 0);
const formatDate = (s: string) => dateFmt.format(new Date(s));

const QUALITY_LABELS: Record<string, string> = {
  SUCATA: "Sucata",
  SEMINOVO: "Seminovo",
  NOVO: "Novo",
  RECONDICIONADO: "Recondicionado",
};

const DAY_MS = 86_400_000;
function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const days = Math.floor(ms / DAY_MS);
  if (days >= 1) return `${days} dia${days > 1 ? "s" : ""}`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `${hours}h`;
}

function HealthCard({
  title,
  value,
  caption,
  icon: Icon,
  accent,
}: {
  title: string;
  value: string;
  caption?: string;
  icon: typeof Wallet;
  accent?: string;
}) {
  return (
    <Card className="border-border/60 bg-card/90">
      <CardContent className="space-y-3 p-5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-muted-foreground">
            {title}
          </span>
          <div className="flex size-9 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-muted-foreground">
            <Icon className="size-4" />
          </div>
        </div>
        <div
          className={cn(
            "text-2xl font-semibold leading-none tracking-tight",
            accent,
          )}
        >
          {value}
        </div>
        {caption ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {caption}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function InfoRow({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string | number | null;
  mono?: boolean;
}) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-right text-sm font-medium",
          mono && "font-mono",
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function ScrapDetail({ scrapId }: { scrapId: string }) {
  const { data: session } = useSession();
  const email = session?.user?.email;

  const [data, setData] = useState<ScrapDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [moving, setMoving] = useState(false);
  const [partFilter, setPartFilter] = useState<"ALL" | "IN_STOCK" | "SOLD">(
    "ALL",
  );

  const load = useCallback(async () => {
    if (!email) return;
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/scraps/${encodeURIComponent(scrapId)}?include=financials,products,history`,
        { headers: { email } },
      );
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) throw new Error("Erro ao buscar lote");
      const json = await res.json();
      setData(json);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [email, scrapId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleMove = async (target: LogisticsStatus) => {
    if (!email || !data) return;
    setMoving(true);
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/scraps/${data.id}/logistics-status`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", email },
          body: JSON.stringify({ logisticsStatus: target }),
        },
      );
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        alert(e.error || "Erro ao mover o lote");
        return;
      }
      await load();
    } catch {
      alert("Erro de conexão ao mover o lote");
    } finally {
      setMoving(false);
    }
  };

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
          <Link href="/sucatas">
            <ArrowLeft className="mr-2 size-4" />
            Voltar para sucatas
          </Link>
        </Button>
        <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
          <Car className="size-16 text-muted-foreground/40" />
          <h2 className="text-xl font-semibold">Lote não encontrado</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            Esta sucata pode ter sido removida ou o link é inválido.
          </p>
        </div>
      </div>
    );
  }

  const stage = LOGISTICS_CONFIG[data.logisticsStatus];
  const StageIcon = stage?.icon ?? Car;
  const subtitle = [data.year, data.version, data.color]
    .filter(Boolean)
    .join(" · ");
  const image = data.imageUrls?.[0];
  const fin = data.financials;
  const targets = LOGISTICS_ORDER.filter((s) => s !== data.logisticsStatus);
  const parts = data.products ?? [];
  const filteredParts = parts.filter((p) =>
    partFilter === "ALL" ? true : p.status === partFilter,
  );

  // Linha do tempo do histórico de estágios (diferencial F).
  const historyEvents = (data.history ?? [])
    .map((e) => ({ ...e, ts: new Date(e.createdAt).getTime() }))
    .sort((a, b) => a.ts - b.ts);
  const createdTs = new Date(data.createdAt).getTime();
  const timeline = historyEvents.map((e, i) => {
    const prevTs = i === 0 ? createdTs : historyEvents[i - 1].ts;
    const fromConf = e.fromStatus ? LOGISTICS_CONFIG[e.fromStatus] : undefined;
    const toConf = LOGISTICS_CONFIG[e.toStatus];
    return {
      key: i,
      label: fromConf
        ? `${fromConf.label} → ${toConf?.label ?? e.toStatus}`
        : (toConf?.label ?? e.toStatus),
      dateLabel: formatDate(e.createdAt),
      stayLabel:
        fromConf && e.ts > prevTs
          ? `${formatDuration(e.ts - prevTs)} em ${fromConf.label}`
          : null,
    };
  });
  const lastEvent = historyEvents[historyEvents.length - 1];
  const currentStageLabel =
    LOGISTICS_CONFIG[data.logisticsStatus]?.label ?? data.logisticsStatus;
  const nowTs = Date.now();
  const historySummary =
    lastEvent && lastEvent.toStatus === "DISMANTLED"
      ? `Desmembrado em ${formatDuration(lastEvent.ts - createdTs)} desde o cadastro.`
      : `${formatDuration(nowTs - createdTs)} desde o cadastro · ${formatDuration(
          nowTs - (lastEvent ? lastEvent.ts : createdTs),
        )} no estágio atual (${currentStageLabel}).`;

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href="/sucatas">
          <ArrowLeft className="mr-2 size-4" />
          Voltar para sucatas
        </Link>
      </Button>

      {/* Header / identificação rápida */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          {image ? (
            <div className="relative size-24 shrink-0 overflow-hidden rounded-lg border bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image}
                alt={`${data.brand} ${data.model}`}
                className="absolute inset-0 h-full w-full object-cover"
              />
            </div>
          ) : (
            <div className="flex size-24 shrink-0 items-center justify-center rounded-lg border bg-muted">
              <Car className="size-9 text-muted-foreground/40" />
            </div>
          )}

          <div className="space-y-2">
            <h1 className="text-xl font-semibold leading-tight sm:text-2xl">
              {data.brand} {data.model}
            </h1>
            {subtitle ? (
              <p className="text-sm text-muted-foreground">{subtitle}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={stage?.badgeClass}>
                <StageIcon className="mr-1 size-3" />
                {stage?.label ?? data.logisticsStatus}
              </Badge>
              {data.plate ? (
                <Badge variant="outline" className="font-mono">
                  {data.plate}
                </Badge>
              ) : null}
              <span
                className={cn(
                  "text-xs font-medium",
                  stage?.available
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-amber-600 dark:text-amber-400",
                )}
              >
                {stage?.available
                  ? "Disponível para retirada de peças"
                  : "Ainda em trânsito"}
              </span>
            </div>
            {data.chassis ? (
              <p className="text-xs text-muted-foreground">
                Chassi: <span className="font-mono">{data.chassis}</span>
              </p>
            ) : null}
          </div>
        </div>

        {/* Transição de estágio */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={moving}>
              {moving ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <ArrowRightLeft className="mr-2 size-4" />
              )}
              Mover estágio
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Mover para</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {targets.map((t) => {
              const TIcon = LOGISTICS_CONFIG[t].icon;
              return (
                <DropdownMenuItem key={t} onSelect={() => handleMove(t)}>
                  <TIcon className="mr-2 size-4" />
                  {LOGISTICS_CONFIG[t].label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Cards de saúde financeira */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <HealthCard
          title="Investimento"
          value={money(fin?.investment)}
          caption="Custo de compra + custos extras"
          icon={Wallet}
        />
        <HealthCard
          title="Receita Realizada"
          value={money(fin?.realizedRevenue.total)}
          caption={
            fin
              ? `Marketplace ${money(fin.realizedRevenue.marketplace)} · Balcão ${money(fin.realizedRevenue.counter)}`
              : undefined
          }
          icon={TrendingUp}
          accent="text-emerald-600 dark:text-emerald-400"
        />
        <HealthCard
          title="Potencial de Venda"
          value={money(fin?.potentialRevenue)}
          caption="Peças ainda em estoque"
          icon={Package}
        />
        <Card className="border-border/60 bg-card/90">
          <CardContent className="p-3">
            <div className="flex items-center justify-between px-2 pt-1">
              <span className="text-sm font-medium text-muted-foreground">
                Performance
              </span>
              <div className="flex size-9 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-muted-foreground">
                <Gauge className="size-4" />
              </div>
            </div>
            <RoiGauge roi={fin?.roi ?? null} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Identificação / lote */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Hash className="size-4" />
              Identificação do lote
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            <InfoRow label="Placa" value={data.plate} mono />
            <InfoRow label="Chassi" value={data.chassis} mono />
            <InfoRow label="Lote" value={data.lot} />
            <InfoRow label="CNPJ do fornecedor" value={data.supplierCnpj} mono />
            <InfoRow label="Localização" value={data.locationCode} />
            <InfoRow label="Forma de pagamento" value={data.paymentMethod} />
          </CardContent>
        </Card>

        {/* Composição do investimento */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wallet className="size-4" />
              Composição do investimento
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            <InfoRow label="Custo de compra" value={money(data.cost)} />
            <InfoRow
              label="Custos extras (transporte/guincho)"
              value={money(data.extraCosts)}
            />
            <InfoRow
              label="Investimento total"
              value={money(fin?.investment)}
            />
            <InfoRow
              label="Receita realizada"
              value={money(fin?.realizedRevenue.total)}
            />
            <InfoRow
              label="Resultado (receita − investimento)"
              value={
                fin
                  ? money(fin.realizedRevenue.total - fin.investment)
                  : undefined
              }
            />
          </CardContent>
        </Card>
      </div>

      {/* Lista de peças (inventário inteligente) */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className="size-4" />
              Peças do lote ({data.productsCount ?? parts.length})
            </CardTitle>
            {parts.length > 0 ? (
              <div className="flex items-center gap-0.5 rounded-lg border p-0.5">
                {(
                  [
                    ["ALL", "Todas"],
                    ["IN_STOCK", "Em estoque"],
                    ["SOLD", "Vendidas"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    variant={partFilter === value ? "default" : "ghost"}
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => setPartFilter(value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          {parts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center text-sm text-muted-foreground">
              <Package className="mb-2 size-8 text-muted-foreground/40" />
              Nenhuma peça cadastrada para este lote ainda.
            </div>
          ) : filteredParts.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Nenhuma peça nesta situação.
            </div>
          ) : (
            <div className="min-w-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Peça</th>
                    <th className="pb-2 pr-4 font-medium">SKU</th>
                    <th className="pb-2 pr-4 font-medium">Part Number</th>
                    <th className="pb-2 pr-4 font-medium">Qualidade</th>
                    <th className="pb-2 pr-4 font-medium">Preço</th>
                    <th className="pb-2 pr-4 font-medium">Estoque</th>
                    <th className="pb-2 pr-4 font-medium">Vendidas</th>
                    <th className="pb-2 font-medium">Situação</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filteredParts.map((p) => (
                    <tr key={p.id}>
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-1.5 font-medium">
                          <span>{p.name}</span>
                          {p.isSecurityItem ? (
                            <ShieldCheck
                              className="size-3.5 text-amber-600 dark:text-amber-400"
                              aria-label="Item de segurança"
                            />
                          ) : null}
                          {p.isTraceable ? (
                            <ScanLine
                              className="size-3.5 text-muted-foreground"
                              aria-label="Rastreável"
                            />
                          ) : null}
                        </div>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">{p.sku}</td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        {p.partNumber || "—"}
                      </td>
                      <td className="py-2 pr-4">
                        {p.quality ? (
                          <Badge variant="secondary">
                            {QUALITY_LABELS[p.quality] ?? p.quality}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 pr-4">{price(p.price)}</td>
                      <td className="py-2 pr-4">{p.stock}</td>
                      <td className="py-2 pr-4">{p.soldQuantity || "—"}</td>
                      <td className="py-2">
                        <Badge
                          variant={
                            p.status === "IN_STOCK" ? "success" : "secondary"
                          }
                        >
                          {p.status === "IN_STOCK" ? "Em estoque" : "Vendido"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Histórico de movimentação (diferencial F) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="size-4" />
            Histórico de movimentação
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{historySummary}</p>
          {timeline.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma transição de estágio registrada ainda (o histórico passa a
              ser gravado a cada movimentação).
            </p>
          ) : (
            <ol className="relative space-y-4 border-l pl-5">
              {timeline.map((t) => (
                <li key={t.key} className="relative">
                  <span className="absolute -left-[23px] top-1 size-2.5 rounded-full border-2 border-background bg-primary" />
                  <div className="text-sm font-medium">{t.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {t.dateLabel}
                    {t.stayLabel ? ` · ${t.stayLabel}` : ""}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {/* Imagens */}
      {data.imageUrls && data.imageUrls.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ImageIcon className="size-4" />
              Imagens ({data.imageUrls.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {data.imageUrls.map((url, i) => (
                <a
                  key={i}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group relative aspect-square overflow-hidden rounded-lg border bg-muted transition-shadow hover:shadow-md"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt={`${data.brand} ${data.model} - imagem ${i + 1}`}
                    className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
                  />
                </a>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Meta */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Criado em {formatDate(data.createdAt)}</span>
        <span>·</span>
        <span>Atualizado em {formatDate(data.updatedAt)}</span>
      </div>
    </div>
  );
}
