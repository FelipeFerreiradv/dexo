"use client";

import { useId, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { cn } from "@/lib/utils";

type Point = { date: string; orders: number; totalAmount?: number };

type RangeOption = {
  id: string;
  label: string;
  days: number;
};

const rangeOptions: RangeOption[] = [
  { id: "90d", label: "Últimos 3 meses", days: 90 },
  { id: "30d", label: "Últimos 30 dias", days: 30 },
  { id: "7d", label: "Últimos 7 dias", days: 7 },
];

interface HeroAreaChartProps {
  data: Point[];
  title?: string;
  subtitle?: string;
}

const monthFormatter = new Intl.DateTimeFormat("en", { month: "short" });
const numberFormatter = new Intl.NumberFormat("pt-BR");

function formatMonthLabel(value: string) {
  try {
    return monthFormatter.format(new Date(value));
  } catch {
    return value;
  }
}

function aggregateMonthly(points: Point[]) {
  const bucket = new Map<
    string,
    { timestamp: number; sales: number; target: number }
  >();

  points.forEach((point, idx) => {
    const date = new Date(point.date);
    const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
    const key = monthStart.toISOString();
    const sales = point.totalAmount ?? point.orders ?? 0;
    const target = sales * 0.92 + 140 * (1 + (idx % 3));

    if (!bucket.has(key)) {
      bucket.set(key, {
        timestamp: monthStart.getTime(),
        sales,
        target,
      });
    } else {
      const current = bucket.get(key)!;
      current.sales += sales;
      current.target += target;
    }
  });

  return Array.from(bucket.entries())
    .sort((a, b) => a[1].timestamp - b[1].timestamp)
    .map(([key, value]) => ({
      monthKey: key,
      label: formatMonthLabel(key),
      sales: value.sales,
      target: value.target,
    }));
}

export function HeroAreaChart({
  data,
  title = "Performance mensal",
  subtitle,
}: HeroAreaChartProps) {
  const [range, setRange] = useState<RangeOption>(rangeOptions[0]);
  const gradientId = useId();
  const salesColor = "var(--color-primary)";
  const targetColor = "var(--color-accent)";

  const sorted = useMemo(
    () =>
      [...(data || [])].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
      ),
    [data],
  );

  const filtered = useMemo(() => {
    if (!sorted.length) return [];
    const slice = sorted.slice(-range.days);
    return slice.length ? slice : sorted;
  }, [sorted, range.days]);

  const monthly = useMemo(() => aggregateMonthly(filtered), [filtered]);
  const maxValue =
    monthly.length > 0
      ? Math.max(
          ...monthly.map((p) => Math.max(p.sales || 0, p.target || 0) || 0),
        ) * 1.12
      : 0;

  return (
    <div className="relative overflow-hidden rounded-2xl h-full border border-border/60 bg-card/90 shadow-[0_18px_60px_color-mix(in_srgb,var(--color-shadow-color)_10%,transparent)]">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-5">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
            {title}
          </p>
          {subtitle ? (
            <p className="text-sm font-semibold text-foreground">{subtitle}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 rounded-xl border border-border/60 bg-card/70 p-1.5 shadow-[0_12px_32px_color-mix(in_srgb,var(--color-shadow-color)_12%,transparent)]">
          {rangeOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setRange(option)}
              className={cn(
                "relative overflow-hidden rounded-lg px-3.5 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                option.id === range.id
                  ? "border border-primary/30 bg-primary/10 text-foreground shadow-[0_10px_32px_color-mix(in_srgb,var(--color-shadow-color)_16%,transparent)]"
                  : "border border-transparent text-muted-foreground hover:border-border/60 hover:bg-muted/30 hover:text-foreground",
              )}
              aria-pressed={option.id === range.id}
            >
              <span
                className={cn(
                  "absolute inset-0 scale-0 bg-gradient-to-br from-primary/15 via-primary/5 to-transparent opacity-0 transition",
                  option.id === range.id && "scale-100 opacity-100",
                )}
                aria-hidden
              />
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-2 pb-3 pt-4">
        <div className="h-[280px] md:h-[330px]">
          <ResponsiveContainer>
            <LineChart
              data={monthly}
              margin={{ top: 8, right: 12, left: 6, bottom: 0 }}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={salesColor} stopOpacity={0.22} />
                  <stop
                    offset="100%"
                    stopColor={salesColor}
                    stopOpacity={0.02}
                  />
                </linearGradient>
              </defs>

              <CartesianGrid
                stroke="color-mix(in srgb, var(--color-border) 68%, transparent)"
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                dy={8}
                minTickGap={12}
              />
              <YAxis
                domain={[0, maxValue || "auto"]}
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                tickMargin={10}
                width={64}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--color-popover)",
                  color: "var(--color-popover-foreground)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 12,
                  boxShadow:
                    "0 18px 48px color-mix(in srgb, var(--color-shadow-color) 16%, transparent)",
                }}
                labelStyle={{
                  color: "var(--color-muted-foreground)",
                  fontWeight: 500,
                }}
                formatter={(value: any, name: string) =>
                  `${name === "sales" ? "Vendas" : "Meta"} ${numberFormatter.format(
                    Number(value) || 0,
                  )}`
                }
              />

              <Line
                type="monotone"
                dataKey="sales"
                stroke={salesColor}
                strokeWidth={2.6}
                dot={false}
                activeDot={{
                  r: 4.6,
                  fill: "var(--color-background)",
                  strokeWidth: 2,
                  stroke: salesColor,
                }}
              />
              <Line
                type="monotone"
                dataKey="target"
                stroke={targetColor}
                strokeWidth={2.2}
                strokeDasharray="6 6"
                dot={false}
                activeDot={{
                  r: 4,
                  fill: "var(--color-background)",
                  strokeWidth: 2,
                  stroke: targetColor,
                }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border/70 px-6 py-4 text-xs text-muted-foreground">
        <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/25 px-3 py-1 font-medium text-foreground">
          <span
            className="size-2.5 rounded-full"
            style={{ backgroundColor: salesColor }}
          />
          Vendas
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/25 px-3 py-1 font-medium text-foreground">
          <span
            className="size-2.5 rounded-full"
            style={{ backgroundColor: targetColor }}
          />
          Meta
        </div>
        <span className="rounded-full border border-border/60 bg-muted/30 px-3 py-1">
          {monthly.length ? `${monthly.length} pontos agregados` : "Sem dados"}
        </span>
      </div>
    </div>
  );
}
