"use client";

import React from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Area,
} from "recharts";

type Item = { date: string; orders: number; totalAmount?: number };

function formatDateLabel(date: any) {
  try {
    const d = new Date(date as string);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  } catch {
    return date;
  }
}

export default function OrdersOverTime({ data }: { data: Item[] }) {
  const strokeVar = "--color-primary";

  if (!data || data.length === 0) {
    return <div className="text-sm text-muted-foreground">Sem dados</div>;
  }

  return (
    <div
      className="rounded-lg border bg-card p-3 shadow-sm"
      style={{ width: "100%", height: 260, color: `var(${strokeVar})` }}
    >
      <ResponsiveContainer>
        <LineChart
          data={data}
          margin={{ top: 8, right: 12, left: 0, bottom: 6 }}
        >
          <defs>
            <linearGradient id="ordersGradient" x1="0" x2="0" y1="0" y2="1">
              <stop
                offset="0%"
                stopColor={`var(${strokeVar})`}
                stopOpacity={0.18}
              />
              <stop
                offset="60%"
                stopColor={`var(${strokeVar})`}
                stopOpacity={0.06}
              />
              <stop
                offset="100%"
                stopColor={`var(${strokeVar})`}
                stopOpacity={0.02}
              />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.04)" />
          <XAxis dataKey="date" tickFormatter={formatDateLabel} />
          <YAxis allowDecimals={false} />
          <Tooltip
            formatter={(v: any) => v?.toLocaleString?.("pt-BR") ?? v}
            labelFormatter={formatDateLabel}
          />
          <Area
            type="monotone"
            dataKey="orders"
            stroke="none"
            fill="url(#ordersGradient)"
          />
          <Line
            type="monotone"
            dataKey="orders"
            stroke="currentColor"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
