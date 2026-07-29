"use client";

// React explícito: o vitest transforma o JSX com o runtime clássico, então o
// spec de componente só consegue renderizar este módulo com React em escopo.
import React from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { InsightCard, InsightChip } from "./insight-card";
import {
  TOOLTIP_STYLE,
  fmtBRL,
  fmtInt,
  fmtPct,
  paletteColor,
} from "./insight-theme";
import { useInsightQuery } from "./use-insight-query";

export interface PaymentMethodItem {
  method: string | null;
  label: string;
  total: number;
  pago: number;
  pendente: number;
  vencido: number;
  count: number;
  share: number;
}

export interface SalesByPaymentMethodResponse {
  range: { startDate: string; endDate: string; label: string; clamped: boolean };
  totals: {
    total: number;
    pago: number;
    pendente: number;
    vencido: number;
    count: number;
  };
  items: PaymentMethodItem[];
}

export function SalesByPaymentMethodView({
  data,
}: {
  data: SalesByPaymentMethodResponse;
}) {
  const items = data.items ?? [];

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="h-[200px] w-full sm:w-1/2">
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={items}
              dataKey="total"
              nameKey="label"
              innerRadius={48}
              outerRadius={80}
              paddingAngle={items.length > 1 ? 3 : 0}
              stroke="none"
            >
              {items.map((item, i) => (
                <Cell
                  key={item.method ?? `sem-metodo-${i}`}
                  fill="currentColor"
                  style={{ color: paletteColor(i) }}
                />
              ))}
            </Pie>
            <Tooltip
              {...TOOLTIP_STYLE}
              formatter={(value: unknown, name: unknown) => [
                fmtBRL(Number(value) || 0),
                String(name),
              ]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Legenda em HTML: o <Legend> do recharts quebra feio com muitos itens. */}
      <ul className="w-full space-y-2 sm:w-1/2">
        {items.map((item, i) => (
          <li
            key={item.method ?? `sem-metodo-${i}`}
            className="flex items-center justify-between gap-3 text-xs"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: paletteColor(i) }}
                aria-hidden
              />
              <span className="truncate text-foreground">{item.label}</span>
            </span>
            <span className="shrink-0 text-muted-foreground">
              {fmtBRL(item.total)} · {fmtPct(item.share)}
            </span>
          </li>
        ))}
        <li className="border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
          {fmtInt(data.totals.count)} contas · {fmtBRL(data.totals.pago)}{" "}
          já recebido
        </li>
      </ul>
    </div>
  );
}

export function SalesByPaymentMethodCard() {
  const q = useInsightQuery<SalesByPaymentMethodResponse>(
    "/dashboard/sales-by-payment-method",
  );

  const totals = q.data?.totals;
  const semMovimento = !totals || totals.total === 0;

  return (
    <InsightCard
      eyebrow="Financeiro · Recebimentos"
      title="Valor por forma de pagamento"
      description="Contas a receber lançadas no período (não inclui pedidos de marketplace)."
      chips={
        totals ? <InsightChip>{fmtBRL(totals.total)}</InsightChip> : null
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
      emptyLabel="Nenhuma conta a receber lançada no período."
    >
      {q.data ? <SalesByPaymentMethodView data={q.data} /> : null}
    </InsightCard>
  );
}
