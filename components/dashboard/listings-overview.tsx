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
import { cn } from "@/lib/utils";
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

/**
 * Cor da série por conta. Antes era `hsl(idx * 57)`, que gerava vermelho, roxo
 * e azul-elétrico — cores fora da paleta da Dexo e que, no gráfico, sugeriam
 * "erro"/"alerta" onde só há contagem de anúncios. Agora sai dos tokens de
 * marca, que também acompanham o tema claro/escuro.
 */
/** Rótulos em PT-BR — o resto do painel não mostra enum cru ao usuário. */
const PLATFORM_LABEL: Record<string, string> = {
  MERCADO_LIVRE: "Mercado Livre",
  SHOPEE: "Shopee",
  MAGALU: "Magalu",
};

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Ativa",
  INACTIVE: "Inativa",
  ERROR: "Erro",
};

const STATUS_STYLE: Record<string, string> = {
  ACTIVE:
    "border border-primary/30 bg-primary/10 text-foreground",
  INACTIVE: "border border-border/60 bg-muted/40 text-muted-foreground",
  ERROR: "border border-destructive/30 bg-destructive/10 text-destructive",
  DEFAULT: "border border-border/60 bg-muted/40 text-muted-foreground",
};

const ACCOUNT_TOKENS = [
  "--color-chart-2",
  "--color-chart-3",
  "--color-chart-5",
  "--color-chart-4",
  "--color-chart-1",
] as const;

function colorForIndex(idx: number) {
  return `var(${ACCOUNT_TOKENS[idx % ACCOUNT_TOKENS.length]})`;
}

export function ListingsOverview({ stats }: { stats: ListingStats | null }) {
  const merged = useMemo(
    () =>
      mergeSeries(
        stats?.timeline.global ?? [],
        stats?.timeline.perAccount ?? {},
      ),
    [stats],
  );

  const accountIds = useMemo(
    () => Object.keys(stats?.timeline.perAccount ?? {}),
    [stats],
  );

  const perAccount = stats?.perAccount ?? [];
  const totalListings = stats?.totalListings ?? 0;
  const totalListingsActive = stats?.totalListingsActive ?? 0;

  // A timeline é indexada por id de conta; o nome legível está em perAccount.
  const nomePorConta = useMemo(
    () =>
      Object.fromEntries(
        (stats?.perAccount ?? []).map((a) => [a.accountId, a.accountName]),
      ) as Record<string, string>,
    [stats],
  );

  return (
    <Card className="h-full rounded-2xl border border-border/60 bg-card/90 shadow-[0_18px_60px_color-mix(in_srgb,var(--color-shadow-color)_10%,transparent)]">
      <CardHeader className="pb-3 pt-4 px-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
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
                    <TableCell className="max-w-[16rem] text-foreground">
                      <span
                        className="block truncate"
                        title={`${acc.accountName} · ${acc.platform}`}
                      >
                        {acc.accountName}
                      </span>
                      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                        {PLATFORM_LABEL[acc.platform] ?? acc.platform}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
                          STATUS_STYLE[acc.status] ?? STATUS_STYLE.DEFAULT,
                        )}
                      >
                        {STATUS_LABEL[acc.status] ?? acc.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-foreground">
                      {acc.totalListings.toLocaleString("pt-BR")}
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
                  // O tooltip mostrava o ID técnico da conta (um cuid). Agora
                  // mostra o nome que o usuário reconhece.
                  name={nomePorConta[accId] ?? accId}
                  stroke={colorForIndex(idx)}
                  strokeWidth={1.8}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Sem legenda, as linhas coloridas não diziam a que conta pertenciam. */}
        {accountIds.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-0.5 w-4 rounded-full"
                style={{ backgroundColor: "var(--color-primary)" }}
                aria-hidden
              />
              Total
            </span>
            {accountIds.map((accId, idx) => (
              <span key={accId} className="inline-flex items-center gap-1.5">
                <span
                  className="h-0.5 w-4 rounded-full"
                  style={{ backgroundColor: colorForIndex(idx) }}
                  aria-hidden
                />
                <span className="max-w-[13rem] truncate">
                  {nomePorConta[accId] ?? accId}
                </span>
              </span>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
import React from "react";
