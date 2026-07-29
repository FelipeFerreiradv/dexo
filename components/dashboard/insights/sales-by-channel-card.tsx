"use client";

// React explícito: o vitest transforma o JSX com o runtime clássico, então o
// spec de componente só consegue renderizar este módulo com React em escopo.
import React from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { InsightCard, InsightChip } from "./insight-card";
import {
  CHANNEL_COLOR,
  TOOLTIP_STYLE,
  fmtBRL,
  fmtInt,
  fmtPct,
} from "./insight-theme";
import { useInsightQuery } from "./use-insight-query";

export interface ChannelItem {
  channel: "BALCAO" | "AVULSO";
  label: string;
  total: number;
  pago: number;
  pendente: number;
  vencido: number;
  count: number;
  share: number;
}

export interface SalesByChannelResponse {
  range: { startDate: string; endDate: string; label: string; clamped: boolean };
  totals: {
    total: number;
    pago: number;
    pendente: number;
    vencido: number;
    count: number;
  };
  items: ChannelItem[];
}

export function SalesByChannelView({ data }: { data: SalesByChannelResponse }) {
  const items = data.items ?? [];
  const balcao = items.find((i) => i.channel === "BALCAO");
  const avulso = items.find((i) => i.channel === "AVULSO");

  // Uma única linha empilhada: a leitura aqui é a PROPORÇÃO entre dois valores,
  // não a comparação de várias barras.
  const chartData = [
    {
      name: "Formas de venda",
      balcao: balcao?.total ?? 0,
      avulso: avulso?.total ?? 0,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="h-[96px]">
        <ResponsiveContainer>
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 8, right: 8, left: 8, bottom: 8 }}
          >
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="name" hide />
            <Tooltip
              {...TOOLTIP_STYLE}
              cursor={false}
              formatter={(value: unknown, name: unknown) => [
                fmtBRL(Number(value) || 0),
                name === "balcao" ? "Venda balcão" : "A receber avulso",
              ]}
            />
            <Bar
              dataKey="balcao"
              stackId="canal"
              fill="currentColor"
              style={{ color: CHANNEL_COLOR.BALCAO }}
              radius={[8, 0, 0, 8]}
              maxBarSize={44}
            />
            <Bar
              dataKey="avulso"
              stackId="canal"
              fill="currentColor"
              style={{ color: CHANNEL_COLOR.AVULSO }}
              radius={[0, 8, 8, 0]}
              maxBarSize={44}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <ul className="grid gap-2 sm:grid-cols-2">
        {items.map((item) => (
          <li
            key={item.channel}
            className="rounded-xl border border-border/60 bg-background/40 px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: CHANNEL_COLOR[item.channel] }}
                aria-hidden
              />
              <span className="text-xs font-semibold text-foreground">
                {item.label}
              </span>
            </div>
            <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {fmtPct(item.share)}
            </p>
            <p className="truncate text-[11px] tabular-nums text-muted-foreground">
              {fmtBRL(item.total)} · {fmtInt(item.count)} contas
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SalesByChannelCard() {
  const q = useInsightQuery<SalesByChannelResponse>(
    "/dashboard/sales-by-channel",
  );

  const totals = q.data?.totals;
  const semMovimento = !totals || totals.total === 0;

  return (
    <InsightCard
      eyebrow="Financeiro · Origem"
      title="Balcão × a receber avulso"
      description="Divisão do valor a receber: venda com itens (balcão) ou conta lançada avulsa."
      chips={totals ? <InsightChip>{fmtBRL(totals.total)}</InsightChip> : null}
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
      emptyLabel="Nenhuma conta a receber lançada no período."
    >
      {q.data ? <SalesByChannelView data={q.data} /> : null}
    </InsightCard>
  );
}
