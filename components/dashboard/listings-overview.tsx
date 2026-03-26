"use client";

import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type ListingStats = {
  totalListings: number;
  totalListingsActive: number;
  perAccount: Array<{
    accountId: string;
    accountName: string;
    platform: string;
    status: string;
    totalListings: number;
  }>;
  timeline: {
    global: Array<{ date: string; count: number }>;
    perAccount: Record<string, Array<{ date: string; count: number }>>;
  };
};

type MergedPoint = {
  date: string;
  global?: number;
  [key: `acc_${string}`]: number | undefined;
};

function mergeSeries(
  global: Array<{ date: string; count: number }>,
  perAccount: Record<string, Array<{ date: string; count: number }>>,
): MergedPoint[] {
  const dates = new Set<string>();
  global.forEach((p) => dates.add(p.date));
  Object.values(perAccount).forEach((series) =>
    series.forEach((p) => dates.add(p.date)),
  );

  const result: Record<string, MergedPoint> = {};
  Array.from(dates).forEach((date) => {
    result[date] = { date };
  });

  global.forEach((p) => {
    result[p.date].global = p.count;
  });

  Object.entries(perAccount).forEach(([accId, series]) => {
    const key = `acc_${accId}` as const;
    series.forEach((p) => {
      result[p.date][key] = p.count;
    });
  });

  return Object.values(result).sort((a, b) => a.date.localeCompare(b.date));
}

function colorForIndex(idx: number) {
  const hue = (idx * 57) % 360;
  return `hsl(${hue} 70% 50%)`;
}

export function ListingsOverview({ stats }: { stats: ListingStats | null }) {
  const merged = useMemo(
    () =>
      mergeSeries(stats?.timeline.global ?? [], stats?.timeline.perAccount ?? {}),
    [stats],
  );

  const accountIds = useMemo(
    () => Object.keys(stats?.timeline.perAccount ?? {}),
    [stats],
  );

  const perAccount = stats?.perAccount ?? [];
  const totalListings = stats?.totalListings ?? 0;
  const totalListingsActive = stats?.totalListingsActive ?? 0;

  return (
    <Card className="h-full rounded-2xl border border-border/60 bg-card/90 shadow-[0_18px_60px_color-mix(in_srgb,var(--color-shadow-color)_10%,transparent)]">
      <CardHeader className="pb-3 pt-4 px-5">
        <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
          Anúncios
        </p>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/30 px-3 py-1 font-semibold text-foreground">
            Total: {totalListings}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/30 px-3 py-1 font-semibold text-foreground">
            Em contas ativas: {totalListingsActive}
          </span>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-5 space-y-4">
        <div className="overflow-x-auto rounded-xl border border-border/60">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                <TableHead>Conta</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Ativa</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {perAccount.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="text-center text-muted-foreground"
                  >
                    Sem anúncios cadastrados
                  </TableCell>
                </TableRow>
              ) : (
                perAccount.map((acc) => (
                  <TableRow
                    key={acc.accountId}
                    className="border-border/60 text-sm transition-colors hover:bg-muted/30"
                  >
                    <TableCell className="text-foreground">
                      {acc.accountName} · {acc.platform}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {acc.status}
                    </TableCell>
                    <TableCell className="text-right text-foreground">
                      {acc.totalListings}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {acc.status === "ACTIVE" ? "Sim" : "Não"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="h-64 rounded-xl border border-border/60 bg-background/40 px-2 py-3">
          <ResponsiveContainer>
            <LineChart
              data={merged}
              margin={{ top: 8, right: 12, left: 6, bottom: 0 }}
            >
              <CartesianGrid
                stroke="color-mix(in srgb, var(--color-border) 68%, transparent)"
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="date"
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                minTickGap={12}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                tickMargin={10}
                width={56}
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
              />
              <Line
                type="monotone"
                dataKey="global"
                name="Total"
                stroke="var(--color-primary)"
                strokeWidth={2.4}
                dot={false}
              />
              {accountIds.map((accId, idx) => (
                <Line
                  key={accId}
                  type="monotone"
                  dataKey={`acc_${accId}`}
                  name={accId}
                  stroke={colorForIndex(idx)}
                  strokeWidth={1.8}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
