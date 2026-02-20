"use client";

import React from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from "recharts";

type Item = { range: string; count: number };

export default function StockDistribution({ data }: { data: Item[] }) {
  const colorVar = "--color-primary";

  if (!data || data.length === 0) {
    return <div className="text-sm text-muted-foreground">Sem dados</div>;
  }

  const mixPercents = [72, 52, 40, 28, 60];

  return (
    <div
      className="rounded-lg border bg-card p-3 shadow-sm"
      style={{ width: "100%", height: 240, color: `var(${colorVar})` }}
    >
      <ResponsiveContainer>
        <BarChart data={data} margin={{ left: 0, right: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.04)" />
          <XAxis dataKey="range" tick={{ fontSize: 12 }} />
          <YAxis allowDecimals={false} />
          <Tooltip formatter={(v: any) => v?.toLocaleString?.("pt-BR") ?? v} />
          <Bar dataKey="count" radius={[6, 6, 6, 6]}>
            {data.map((_, i) => {
              const mix = mixPercents[i % mixPercents.length];
              const mixExpr = `color-mix(in srgb, var(${colorVar}) ${mix}%, var(--color-card) ${100 - mix}%)`;
              return (
                <Cell
                  key={`cell-${i}`}
                  fill="currentColor"
                  style={{ color: mixExpr }}
                />
              );
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
