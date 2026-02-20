"use client";

import React from "react";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from "recharts";

type Item = { category: string; count: number };

export default function ProductsByCategory({ data }: { data: Item[] }) {
  const paletteVars = [
    "--color-primary",
    "--color-secondary",
    "--color-accent",
    "--color-muted",
    "--color-chart-5",
  ];
  const mixPercents = [72, 56, 40, 24, 64];

  if (!data || data.length === 0) {
    return <div className="text-sm text-muted-foreground">Sem dados</div>;
  }

  // compute slice colors and legend payload so legend markers match slices
  const sliceColors = data.map((_, i) => {
    const cssVar = paletteVars[i % paletteVars.length];
    const mix = mixPercents[i % mixPercents.length];
    return `color-mix(in srgb, var(${cssVar}) ${mix}%, var(--color-card) ${100 - mix}%)`;
  });

  const legendPayload = data.map((d, i) => ({
    value: d.category,
    type: "square",
    id: `legend-${i}`,
    color: sliceColors[i],
  }));

  return (
    <div
      className="rounded-lg border bg-card p-3 shadow-sm"
      style={{ width: "100%", height: 320, overflow: "hidden" }}
    >
      <div className="relative" style={{ height: 260 }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={data}
              dataKey="count"
              nameKey="category"
              innerRadius={48}
              outerRadius={80}
              paddingAngle={4}
            >
              {data.map((_, i) => (
                <Cell
                  key={`cell-${i}`}
                  fill="currentColor"
                  style={{ color: sliceColors[i] }}
                />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: any) =>
                value?.toLocaleString?.("pt-BR") ?? value
              }
            />
          </PieChart>
        </ResponsiveContainer>

        <div className="absolute left-1/2 -bottom-4 -translate-x-1/2 w-full px-6">
          <div className="mx-auto max-w-full flex flex-wrap justify-center gap-4">
            {data.map((d, i) => (
              <div key={`legend-item-${i}`} className="flex items-center gap-2">
                <span
                  style={{
                    display: "inline-block",
                    width: 12,
                    height: 12,
                    background: sliceColors[i],
                    borderRadius: 2,
                  }}
                />
                <span className="text-sm text-muted-foreground">
                  {d.category}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
