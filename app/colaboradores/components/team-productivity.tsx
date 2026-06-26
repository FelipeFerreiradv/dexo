"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  BoxIcon,
  DownloadIcon,
  PackageIcon,
  ShoppingBagIcon,
  StoreIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getApiBaseUrl } from "@/lib/api";

// Cores das séries (tokens do tema — a tela segue a identidade shadcn/Dexo; o
// visual editorial pesado é só do PDF). ML × Shopee são tokens distintos.
const ML_COLOR = "var(--color-primary)";
const SHOPEE_COLOR = "var(--color-accent)";
const PRODUTO_COLOR = "var(--color-muted-foreground)";

const nf = new Intl.NumberFormat("pt-BR");
const brlFmt = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
function brl(n: number): string {
  return brlFmt.format(n || 0);
}

type Anuncios = { total: number; ml: number; shopee: number; outro: number };

type ProductivityResponse = {
  range: { startDate: string; endDate: string; label: string };
  totals: { produtos: number; anuncios: Anuncios };
  byCollaborator: Array<{
    id: string;
    name: string | null;
    email: string;
    avatarUrl: string | null;
    produtos: number;
    anuncios: Anuncios;
    lastActivityAt: string | null;
  }>;
  timeseries: Array<{
    date: string;
    produtos: number;
    ml: number;
    shopee: number;
  }>;
  // Orçamentos por vendedor (BLOCO 1). Opcional (compat com respostas antigas).
  budgetsByVendedor?: Array<{
    id: string;
    name: string | null;
    email: string;
    isOwner: boolean;
    orcamentos: { count: number; valor: number };
    convertidos: { count: number; valor: number };
  }>;
  budgetTotals?: {
    orcamentos: { count: number; valor: number };
    convertidos: { count: number; valor: number };
  };
};

type PresetId = "today" | "7d" | "30d" | "month" | "custom";

const PRESETS: { id: PresetId; label: string }[] = [
  { id: "today", label: "Hoje" },
  { id: "7d", label: "7 dias" },
  { id: "30d", label: "30 dias" },
  { id: "month", label: "Este mês" },
  { id: "custom", label: "Personalizado" },
];

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function presetRange(id: PresetId): { start: string; end: string } | null {
  const now = new Date();
  const end = ymd(now);
  if (id === "today") return { start: end, end };
  if (id === "7d") {
    const s = new Date(now);
    s.setDate(s.getDate() - 6);
    return { start: ymd(s), end };
  }
  if (id === "30d") {
    const s = new Date(now);
    s.setDate(s.getDate() - 29);
    return { start: ymd(s), end };
  }
  if (id === "month") {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start: ymd(s), end };
  }
  return null; // custom
}

function shortDate(iso: string): string {
  // iso = "YYYY-MM-DD"
  const [, m, d] = iso.split("-");
  return d && m ? `${d}/${m}` : iso;
}

export type TeamProductivityPeriod = { startDate: string; endDate: string };

export function TeamProductivity({
  onPeriodChange,
}: {
  // Permite a um pai (botão de PDF, Entrega B) saber o período selecionado.
  onPeriodChange?: (p: TeamProductivityPeriod) => void;
}) {
  const { data: session } = useSession();
  const email = session?.user?.email ?? null;

  const [preset, setPreset] = useState<PresetId>("30d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const period = useMemo<TeamProductivityPeriod>(() => {
    if (preset === "custom") {
      return { startDate: customStart, endDate: customEnd };
    }
    const r = presetRange(preset);
    return { startDate: r?.start ?? "", endDate: r?.end ?? "" };
  }, [preset, customStart, customEnd]);

  useEffect(() => {
    onPeriodChange?.(period);
  }, [period, onPeriodChange]);

  const [data, setData] = useState<ProductivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchData = useCallback(async () => {
    if (!email) return;
    // No modo personalizado, espera as duas datas para não disparar incompleto.
    if (preset === "custom" && (!customStart || !customEnd)) {
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const params = new URLSearchParams();
      if (period.startDate) params.set("startDate", period.startDate);
      if (period.endDate) params.set("endDate", period.endDate);
      const apiBase = getApiBaseUrl();
      const res = await fetch(
        `${apiBase}/me/team/productivity?${params.toString()}`,
        { headers: { email } },
      );
      if (!res.ok) {
        if (res.status === 403) {
          setData(null);
          return;
        }
        throw new Error(`Erro ${res.status}`);
      }
      const json = (await res.json()) as ProductivityResponse;
      setData(json);
    } catch (err) {
      console.error("[TeamProductivity] fetch error", err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [email, period.startDate, period.endDate, preset, customStart, customEnd]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const [downloading, setDownloading] = useState(false);
  const handleDownloadPdf = useCallback(async () => {
    if (!email) return;
    if (preset === "custom" && (!customStart || !customEnd)) return;
    setDownloading(true);
    try {
      const params = new URLSearchParams();
      if (period.startDate) params.set("startDate", period.startDate);
      if (period.endDate) params.set("endDate", period.endDate);
      const apiBase = getApiBaseUrl();
      const res = await fetch(
        `${apiBase}/me/team/productivity/report.pdf?${params.toString()}`,
        { headers: { email } },
      );
      if (!res.ok) throw new Error(`Erro ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "produtividade-equipe-dexo.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      console.error("[TeamProductivity] pdf error", err);
    } finally {
      setDownloading(false);
    }
  }, [email, period.startDate, period.endDate, preset, customStart, customEnd]);

  const totals = data?.totals;
  const hasActivity =
    !!totals && (totals.produtos > 0 || totals.anuncios.total > 0);

  const maxAnuncios = useMemo(() => {
    if (!data) return 0;
    return data.byCollaborator.reduce(
      (acc, c) => Math.max(acc, c.anuncios.total),
      0,
    );
  }, [data]);

  return (
    <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
      <CardHeader className="gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Produtividade da equipe</CardTitle>
            <CardDescription>
              Produtos e anúncios criados por colaborador
              {data?.range?.label ? ` · ${data.range.label}` : ""}.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownloadPdf}
            disabled={downloading || loading}
            className="shrink-0"
          >
            <DownloadIcon className="mr-1.5 h-4 w-4" />
            {downloading ? "Gerando..." : "Gerar relatório (PDF)"}
          </Button>
        </div>

        {/* Seletor de período (presets + personalizado) */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPreset(p.id)}
                aria-pressed={preset === p.id}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                  preset === p.id
                    ? "border-primary/30 bg-primary/10 text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-muted/30 hover:text-foreground",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preset === "custom" && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:max-w-md">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  De
                </label>
                <Input
                  type="date"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Até
                </label>
                <Input
                  type="date"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {loading ? (
          <div className="py-10 text-center text-muted-foreground">
            Carregando produtividade...
          </div>
        ) : error ? (
          <div className="py-10 text-center text-sm text-destructive">
            Não foi possível carregar a produtividade. Tente novamente.
          </div>
        ) : !data || data.byCollaborator.length === 0 ? (
          <div className="py-10 text-center text-muted-foreground">
            Nenhum colaborador vinculado à sua conta.
          </div>
        ) : (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <KpiCard
                title="Produtos criados"
                value={totals!.produtos}
                icon={BoxIcon}
              />
              <KpiCard
                title="Anúncios criados"
                value={totals!.anuncios.total}
                icon={PackageIcon}
              />
              <KpiCard
                title="Anúncios ML"
                value={totals!.anuncios.ml}
                icon={StoreIcon}
                dotColor={ML_COLOR}
              />
              <KpiCard
                title="Anúncios Shopee"
                value={totals!.anuncios.shopee}
                icon={ShoppingBagIcon}
                dotColor={SHOPEE_COLOR}
              />
            </div>

            {!hasActivity ? (
              <div className="rounded-lg border border-dashed border-border/60 py-8 text-center text-sm text-muted-foreground">
                Sem atividade de criação no período selecionado.
              </div>
            ) : (
              <>
                {/* Ranking por colaborador */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">
                      Ranking por anúncios criados
                    </h3>
                    <Legendinha />
                  </div>
                  <div className="space-y-2">
                    {data.byCollaborator.map((c, idx) => {
                      const share =
                        totals!.anuncios.total > 0
                          ? (c.anuncios.total / totals!.anuncios.total) * 100
                          : 0;
                      const barW =
                        maxAnuncios > 0
                          ? (c.anuncios.total / maxAnuncios) * 100
                          : 0;
                      const mlW =
                        c.anuncios.total > 0
                          ? (c.anuncios.ml / c.anuncios.total) * 100
                          : 0;
                      const shopeeW =
                        c.anuncios.total > 0
                          ? (c.anuncios.shopee / c.anuncios.total) * 100
                          : 0;
                      const outroW = Math.max(0, 100 - mlW - shopeeW);
                      return (
                        <div
                          key={c.id}
                          className={cn(
                            "flex items-center gap-3 rounded-lg border border-border/50 p-3",
                            idx === 0 &&
                              c.anuncios.total > 0 &&
                              "border-primary/40 bg-primary/[0.04]",
                          )}
                        >
                          <Avatar c={c} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium">
                                  {c.name || c.email}
                                </div>
                                <div className="truncate text-xs text-muted-foreground">
                                  {nf.format(c.produtos)} produto(s) ·{" "}
                                  {share.toFixed(0)}% dos anúnc.
                                </div>
                              </div>
                              <div className="shrink-0 text-right">
                                <div className="text-sm font-semibold tabular-nums">
                                  {nf.format(c.anuncios.total)}
                                </div>
                                <div className="text-[11px] tabular-nums text-muted-foreground">
                                  ML {nf.format(c.anuncios.ml)} · SH{" "}
                                  {nf.format(c.anuncios.shopee)}
                                </div>
                              </div>
                            </div>
                            {/* Barra empilhada ML × Shopee × Outro */}
                            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted/40">
                              <div
                                className="flex h-full"
                                style={{ width: `${barW}%` }}
                              >
                                <span
                                  className="h-full"
                                  style={{
                                    width: `${mlW}%`,
                                    backgroundColor: ML_COLOR,
                                  }}
                                />
                                <span
                                  className="h-full"
                                  style={{
                                    width: `${shopeeW}%`,
                                    backgroundColor: SHOPEE_COLOR,
                                  }}
                                />
                                <span
                                  className="h-full"
                                  style={{
                                    width: `${outroW}%`,
                                    backgroundColor: PRODUTO_COLOR,
                                  }}
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Série temporal */}
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold">
                    Criação ao longo do período
                  </h3>
                  <div className="h-[260px] w-full">
                    <ResponsiveContainer>
                      <ComposedChart
                        data={data.timeseries}
                        margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                      >
                        <defs>
                          <linearGradient
                            id="tp-ml"
                            x1="0"
                            x2="0"
                            y1="0"
                            y2="1"
                          >
                            <stop
                              offset="0%"
                              stopColor={ML_COLOR}
                              stopOpacity={0.45}
                            />
                            <stop
                              offset="100%"
                              stopColor={ML_COLOR}
                              stopOpacity={0.03}
                            />
                          </linearGradient>
                          <linearGradient
                            id="tp-shopee"
                            x1="0"
                            x2="0"
                            y1="0"
                            y2="1"
                          >
                            <stop
                              offset="0%"
                              stopColor={SHOPEE_COLOR}
                              stopOpacity={0.45}
                            />
                            <stop
                              offset="100%"
                              stopColor={SHOPEE_COLOR}
                              stopOpacity={0.03}
                            />
                          </linearGradient>
                        </defs>
                        <CartesianGrid
                          stroke="color-mix(in srgb, var(--color-border) 68%, transparent)"
                          strokeDasharray="3 3"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="date"
                          tickFormatter={shortDate}
                          tick={{
                            fill: "var(--color-muted-foreground)",
                            fontSize: 11,
                          }}
                          axisLine={false}
                          tickLine={false}
                          minTickGap={20}
                          dy={6}
                        />
                        <YAxis
                          allowDecimals={false}
                          tick={{
                            fill: "var(--color-muted-foreground)",
                            fontSize: 11,
                          }}
                          axisLine={false}
                          tickLine={false}
                          width={36}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "var(--color-popover)",
                            color: "var(--color-popover-foreground)",
                            border: "1px solid var(--color-border)",
                            borderRadius: 12,
                          }}
                          labelFormatter={(l) => shortDate(String(l))}
                          formatter={(value: any) =>
                            nf.format(Number(value) || 0)
                          }
                        />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Area
                          type="monotone"
                          dataKey="ml"
                          name="ML"
                          stackId="anuncios"
                          stroke={ML_COLOR}
                          strokeWidth={2}
                          fill="url(#tp-ml)"
                        />
                        <Area
                          type="monotone"
                          dataKey="shopee"
                          name="Shopee"
                          stackId="anuncios"
                          stroke={SHOPEE_COLOR}
                          strokeWidth={2}
                          fill="url(#tp-shopee)"
                        />
                        <Line
                          type="monotone"
                          dataKey="produtos"
                          name="Produtos"
                          stroke={PRODUTO_COLOR}
                          strokeWidth={2}
                          strokeDasharray="5 5"
                          dot={false}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {/* Orçamentos por vendedor (BLOCO 1) — base p/ comissão. Aparece quando
            há orçamentos atribuídos no período (independe de produtividade). */}
        {!loading &&
          data?.budgetsByVendedor &&
          data.budgetsByVendedor.length > 0 && (
            <div className="mt-6 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold">
                  Orçamentos por vendedor
                </h4>
                {data.budgetTotals && (
                  <span className="text-xs text-muted-foreground">
                    {nf.format(data.budgetTotals.orcamentos.count)} orçamento(s)
                    · {nf.format(data.budgetTotals.convertidos.count)}{" "}
                    convertido(s)
                  </span>
                )}
              </div>
              <div className="overflow-x-auto rounded-xl border border-border/70">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">
                        Vendedor
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Orçamentos
                      </th>
                      <th className="px-3 py-2 text-right font-medium">Valor</th>
                      <th className="px-3 py-2 text-right font-medium">
                        Convertidos
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Valor convertido
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.budgetsByVendedor.map((v) => (
                      <tr key={v.id} className="border-t border-border/60">
                        <td className="px-3 py-2">
                          {v.name || v.email}
                          {v.isOwner ? (
                            <span className="ml-1 text-xs text-muted-foreground">
                              (admin)
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {nf.format(v.orcamentos.count)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {brl(v.orcamentos.valor)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {nf.format(v.convertidos.count)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {brl(v.convertidos.valor)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                Orçamentos criados no período por vendedor. &quot;Convertidos&quot;
                = viraram venda (Conta a Receber) — base usual para comissão.
              </p>
            </div>
          )}
      </CardContent>
    </Card>
  );
}

function KpiCard({
  title,
  value,
  icon: Icon,
  dotColor,
}: {
  title: string;
  value: number;
  icon: typeof BoxIcon;
  dotColor?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border/60 bg-card/90 p-3.5 sm:p-4">
      <div className="flex items-start justify-between gap-2 sm:gap-3">
        <div className="min-w-0 space-y-1 sm:space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground sm:text-sm">
            {dotColor ? (
              <span
                className="inline-block size-2 shrink-0 rounded-full"
                style={{ backgroundColor: dotColor }}
                aria-hidden
              />
            ) : null}
            <span className="leading-tight">{title}</span>
          </div>
          <div className="text-2xl font-semibold leading-none tracking-tight tabular-nums sm:text-3xl">
            {nf.format(value)}
          </div>
        </div>
        {/* Ícone só a partir de sm: — no retrato (≤640px) ele apertava o card. */}
        <div className="hidden size-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/40 text-muted-foreground sm:flex">
          <Icon className="size-5" />
        </div>
      </div>
    </div>
  );
}

function Avatar({
  c,
}: {
  c: { name: string | null; email: string; avatarUrl: string | null };
}) {
  return (
    <div className="h-9 w-9 shrink-0 overflow-hidden rounded-full border border-border/60 bg-muted/30">
      {c.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={c.avatarUrl}
          alt={c.name || c.email}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-xs font-semibold">
          {(c.name || c.email).slice(0, 2).toUpperCase()}
        </span>
      )}
    </div>
  );
}

function Legendinha() {
  return (
    <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <span
          className="inline-block size-2 rounded-full"
          style={{ backgroundColor: ML_COLOR }}
        />
        ML
      </span>
      <span className="inline-flex items-center gap-1">
        <span
          className="inline-block size-2 rounded-full"
          style={{ backgroundColor: SHOPEE_COLOR }}
        />
        Shopee
      </span>
    </div>
  );
}
