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
  NEUTRAL_BAR,
  TOOLTIP_STYLE,
  categoryLeaf,
  categoryParent,
  fmtBRL,
  fmtBRLCompact,
  fmtInt,
  fmtPct,
  rankColor,
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

  // O eixo recebe a FOLHA da hierarquia. Quando duas folhas coincidem (ex.:
  // "Faróis" em dois ramos), o nível de cima entra como desempate.
  const dados = items.map((item, i) => {
    const folha = categoryLeaf(item.category);
    const homonima = items.some(
      (outro, j) => j !== i && categoryLeaf(outro.category) === folha,
    );
    const pai = categoryParent(item.category);
    return {
      ...item,
      rotulo: homonima && pai ? `${pai} › ${folha}` : folha,
      caminho: item.category,
    };
  });

  // Barra + respiro. Altura por item em vez de fixa: com 3 categorias o card
  // não fica com metade vazia, com 11 as barras não se espremem.
  const altura = Math.max(180, dados.length * 38 + 16);

  return (
    <div className="space-y-3">
      <div style={{ height: altura }}>
        <ResponsiveContainer>
          <BarChart
            data={dados}
            layout="vertical"
            margin={{ top: 4, right: 12, left: 4, bottom: 4 }}
            barCategoryGap="22%"
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
              dataKey="rotulo"
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              // Estreito no celular, confortável a partir do tablet.
              width={116}
              tickFormatter={(v: string) => truncateLabel(String(v), 18)}
            />
            <Tooltip
              {...TOOLTIP_STYLE}
              cursor={{
                fill: "color-mix(in srgb, var(--color-muted) 40%, transparent)",
              }}
              // O caminho completo aparece aqui — é onde ele cabe sem estourar
              // o eixo, e é o que responde "qual categoria exatamente é essa?".
              labelFormatter={(_rotulo: unknown, payload: any) =>
                payload?.[0]?.payload?.caminho ?? String(_rotulo)
              }
              formatter={(value: unknown, _n: unknown, item: any) => [
                `${fmtBRL(Number(value) || 0)} · ${fmtInt(
                  item?.payload?.units ?? 0,
                )} un · ${fmtPct(item?.payload?.share ?? 0)}`,
                "Receita",
              ]}
            />
            <Bar dataKey="revenue" radius={[0, 6, 6, 0]} maxBarSize={24}>
              {dados.map((item, i) => (
                <Cell
                  key={item.category}
                  fill="currentColor"
                  style={{
                    // "Outras" é uma soma, não uma categoria: sai da escala de
                    // ranking e fica neutra para não competir com as reais.
                    color: item.isOther ? NEUTRAL_BAR : rankColor(i, dados.length),
                  }}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <ul className="space-y-1.5 border-t border-border/60 pt-3 text-xs">
        {dados.slice(0, 3).map((item) => (
          <li key={item.category} className="flex items-baseline gap-3">
            <span
              className="min-w-0 flex-1 truncate text-foreground"
              title={item.caminho}
            >
              {item.rotulo}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
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
