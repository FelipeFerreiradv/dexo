"use client";

// React explícito: o vitest transforma o JSX com o runtime clássico
// (React.createElement), então `tests/dashboard-insights-cards.spec.tsx` só
// renderiza este módulo se React estiver em escopo — mesmo motivo do import em
// components/dashboard/listings-overview.tsx.
import React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { InsightCard, InsightChip } from "./insight-card";
import {
  AXIS_TICK,
  GRID_STROKE,
  TOOLTIP_STYLE,
  fmtBRL,
  fmtBRLCompact,
  fmtInt,
  fmtPct,
  platformColor,
} from "./insight-theme";
import { useInsightQuery } from "./use-insight-query";

export interface PlatformItem {
  platform: string;
  label: string;
  orders: number;
  revenue: number;
  cancelledOrders: number;
  cancelledRevenue: number;
  share: number;
}

export interface SalesByPlatformResponse {
  range: { startDate: string; endDate: string; label: string; clamped: boolean };
  totals: {
    orders: number;
    revenue: number;
    cancelledOrders: number;
    cancelledRevenue: number;
  };
  byPlatform: PlatformItem[];
}

/**
 * Parte pura do card — recebe os dados por prop. É esta que os testes renderizam
 * com `renderToString`, sem rede e sem sessão.
 */
export function SalesByPlatformView({
  data,
}: {
  data: SalesByPlatformResponse;
}) {
  const items = data.byPlatform ?? [];

  return (
    <div className="space-y-3">
      <div className="h-[240px]">
        <ResponsiveContainer>
          <BarChart data={items} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid
              stroke={GRID_STROKE}
              strokeDasharray="3 3"
              vertical={false}
            />
            <XAxis
              dataKey="label"
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              dy={6}
            />
            <YAxis
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              tickMargin={8}
              width={72}
              tickFormatter={(v: number) => fmtBRLCompact(Number(v) || 0)}
            />
            <Tooltip
              {...TOOLTIP_STYLE}
              cursor={{ fill: "color-mix(in srgb, var(--color-muted) 40%, transparent)" }}
              formatter={(value: unknown) => [
                fmtBRL(Number(value) || 0),
                "Receita",
              ]}
            />
            <Bar dataKey="revenue" radius={[6, 6, 0, 0]} maxBarSize={72}>
              {items.map((item) => (
                <Cell
                  key={item.platform}
                  fill="currentColor"
                  style={{ color: platformColor(item.platform) }}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <ul className="grid gap-2 sm:grid-cols-3">
        {items.map((item) => (
          <li
            key={item.platform}
            className="rounded-xl border border-border/60 bg-background/40 px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: platformColor(item.platform) }}
                aria-hidden
              />
              <span className="text-xs font-semibold text-foreground">
                {item.label}
              </span>
            </div>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {fmtBRL(item.revenue)}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {fmtInt(item.orders)} pedidos · {fmtPct(item.share)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SalesByPlatformCard() {
  const q = useInsightQuery<SalesByPlatformResponse>(
    "/dashboard/sales-by-platform",
  );

  const totals = q.data?.totals;
  const semMovimento = !totals || totals.revenue === 0;

  return (
    <InsightCard
      eyebrow="Vendas · Marketplaces"
      title="Receita por plataforma"
      description="Pedidos dos marketplaces integrados no período."
      chips={
        totals ? (
          <>
            <InsightChip>{fmtBRL(totals.revenue)}</InsightChip>
            <InsightChip>{fmtInt(totals.orders)} pedidos</InsightChip>
          </>
        ) : null
      }
      preset={q.preset}
      onPresetChange={q.setPreset}
      customStart={q.customStart}
      onCustomStartChange={q.setCustomStart}
      customEnd={q.customEnd}
      onCustomEndChange={q.setCustomEnd}
      loading={q.loading}
      error={q.error}
      incomplete={q.incomplete}
      empty={semMovimento}
      emptyLabel="Nenhum pedido de marketplace no período."
    >
      {q.data ? <SalesByPlatformView data={q.data} /> : null}
    </InsightCard>
  );
}
