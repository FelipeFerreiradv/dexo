"use client";

// React explícito: o vitest transforma o JSX com o runtime clássico, então o
// spec de componente só consegue renderizar este módulo com React em escopo.
import React, { useState } from "react";
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

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { InsightCard, InsightChip } from "./insight-card";
import {
  AXIS_TICK,
  GRID_STROKE,
  TOOLTIP_STYLE,
  chartColor,
  fmtBRL,
  fmtBRLCompact,
  fmtInt,
  fmtPct,
  paletteColor,
  truncateLabel,
} from "./insight-theme";
import { useInsightQuery } from "./use-insight-query";

export interface CategoryItem {
  category: string;
  revenue: number;
  units: number;
  share: number;
  isOther: boolean;
}

export interface SalesByCategoryResponse {
  range: { startDate: string; endDate: string; label: string; clamped: boolean };
  totals: { revenue: number; units: number; orders: number; categories: number };
  items: CategoryItem[];
  truncated: boolean;
}

/** Só este card filtra por plataforma: categoria é a dimensão dos outros. */
const PLATFORM_OPTIONS = [
  { value: "all", label: "Todas as plataformas" },
  { value: "ml", label: "Mercado Livre" },
  { value: "shopee", label: "Shopee" },
  { value: "magalu", label: "Magalu" },
] as const;

export function SalesByCategoryView({
  data,
}: {
  data: SalesByCategoryResponse;
}) {
  const items = data.items ?? [];
  // Barras horizontais: nome de categoria é longo e ilegível no eixo X.
  const altura = Math.max(200, items.length * 34 + 24);

  return (
    <div className="space-y-3">
      <div style={{ height: altura }}>
        <ResponsiveContainer>
          <BarChart
            data={items}
            layout="vertical"
            margin={{ top: 4, right: 16, left: 0, bottom: 4 }}
          >
            <CartesianGrid
              stroke={GRID_STROKE}
              strokeDasharray="3 3"
              horizontal={false}
            />
            <XAxis
              type="number"
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => fmtBRLCompact(Number(v) || 0)}
            />
            <YAxis
              type="category"
              dataKey="category"
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={132}
              tickFormatter={(v: string) => truncateLabel(String(v))}
            />
            <Tooltip
              {...TOOLTIP_STYLE}
              cursor={{
                fill: "color-mix(in srgb, var(--color-muted) 40%, transparent)",
              }}
              formatter={(value: unknown) => [
                fmtBRL(Number(value) || 0),
                "Receita",
              ]}
            />
            <Bar dataKey="revenue" radius={[0, 6, 6, 0]} maxBarSize={26}>
              {items.map((item, i) => (
                <Cell
                  key={item.category}
                  fill="currentColor"
                  style={{
                    // "Outras" é uma soma, não uma categoria: fica em cinza
                    // para não competir com as fatias reais.
                    color: item.isOther
                      ? chartColor("--color-muted-foreground", 45)
                      : paletteColor(i),
                  }}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <ul className="space-y-1 text-xs text-muted-foreground">
        {items.slice(0, 3).map((item) => (
          <li key={item.category} className="flex justify-between gap-3">
            <span className="truncate text-foreground">{item.category}</span>
            <span className="shrink-0">
              {fmtInt(item.units)} un · {fmtPct(item.share)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SalesByCategoryCard() {
  // Filtro de plataforma é estado LOCAL do card e entra como query param — o
  // hook reage à mudança porque serializa `params` na chave do efeito.
  const [platform, setPlatform] = useState<string>("all");

  const q = useInsightQuery<SalesByCategoryResponse>(
    "/dashboard/sales-by-category",
    { platform: platform === "all" ? undefined : platform },
  );

  const totals = q.data?.totals;
  const semMovimento = !q.data || (q.data.items ?? []).length === 0;

  return (
    <InsightCard
      eyebrow="Vendas · Categorias"
      title="Receita por categoria de peça"
      description="Itens vendidos nos marketplaces, agrupados pela categoria do produto."
      chips={
        totals ? (
          <>
            <InsightChip>{fmtBRL(totals.revenue)}</InsightChip>
            <InsightChip>{fmtInt(totals.categories)} categorias</InsightChip>
          </>
        ) : null
      }
      filters={
        <Select value={platform} onValueChange={setPlatform}>
          <SelectTrigger
            className="h-8 w-full text-xs sm:w-[180px]"
            aria-label="Plataforma"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLATFORM_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
      emptyLabel="Nenhuma venda por categoria no período."
    >
      {q.data ? <SalesByCategoryView data={q.data} /> : null}
    </InsightCard>
  );
}
