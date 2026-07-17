"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  ArrowDownCircle,
  Banknote,
  ShoppingCart,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatToBRL } from "@/components/ui/currency-input";
import { cn } from "@/lib/utils";
import { getApiBaseUrl } from "@/lib/api";
import { paymentMethodLabel } from "@/app/lib/payment-methods";
import {
  computePdvDayStats,
  type PdvSaleLike,
} from "../lib/pdv-stats";

// KPIs financeiros do PDV, no MESMO idioma visual do FinanceOverview
// (spine colorida + chip do ícone + número em Fraunces). Duas fontes:
//  - "hoje" (caixa, vendas, ticket, formas): calculado no client a partir
//    das vendas recentes já buscadas pela página (helper puro pdv-stats);
//  - acumulados (a receber / vencidas do balcão): GET /finance/summary
//    ?hasItems=true (bucket de receivables só com vendas balcão).

interface SummaryBucket {
  totalCount: number;
  totalAmount: number;
  overdueCount: number;
  overdueAmount: number;
  pendingAmount: number;
  paidAmount: number;
}

interface Props {
  sales: PdvSaleLike[];
  refreshKey?: number;
}

export function PdvOverview({ sales, refreshKey }: Props) {
  const { data: session } = useSession();
  const [balcao, setBalcao] = useState<SummaryBucket | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchSummary = useCallback(async () => {
    const email = session?.user?.email;
    if (!email) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/finance/summary?hasItems=true`,
        { headers: { email }, signal: ctrl.signal },
      );
      if (!res.ok) return;
      const data = await res.json();
      setBalcao(data.summary?.receivables ?? null);
    } catch {
      // silent — cards ficam em 0, mesma tolerância do FinanceOverview
    }
  }, [session?.user?.email]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary, refreshKey]);

  const stats = useMemo(() => computePdvDayStats(sales, new Date()), [sales]);

  const methodChips =
    stats.byMethodToday.length > 0
      ? stats.byMethodToday
          .slice(0, 3)
          .map(
            (m) =>
              `${m.code ? paymentMethodLabel(m.code) : "Sem forma"} ${formatToBRL(m.amount)}`,
          )
          .join(" · ")
      : "Sem recebimentos hoje";

  const cards = [
    {
      label: "Caixa de hoje",
      money: true,
      value: stats.receivedToday,
      sub: methodChips,
      icon: Banknote,
      accent: "text-[#2c5f4f] dark:text-emerald-400",
      chip: "bg-[#2c5f4f]/10",
      spine: "bg-[#2c5f4f]",
    },
    {
      label: "Vendas hoje",
      money: false,
      value: stats.salesTodayCount,
      sub: `Ticket médio R$ ${formatToBRL(stats.avgTicketToday)}`,
      icon: ShoppingCart,
      accent: "text-yellow-600 dark:text-yellow-400",
      chip: "bg-[#f2c419]/15",
      spine: "bg-[#f2c419]",
    },
    {
      label: "A receber (balcão)",
      money: true,
      value: balcao?.pendingAmount ?? 0,
      sub: "Vendas pendentes acumuladas",
      icon: ArrowDownCircle,
      accent: "text-[#2c5f4f] dark:text-emerald-400",
      chip: "bg-[#2c5f4f]/10",
      spine: "bg-[#2c5f4f]",
    },
    {
      label: "Vencidas (balcão)",
      money: true,
      value: balcao?.overdueAmount ?? 0,
      sub: `${balcao?.overdueCount ?? 0} venda(s) vencida(s)`,
      icon: AlertTriangle,
      accent: "text-amber-600 dark:text-amber-400",
      chip: "bg-amber-500/10",
      spine: "bg-amber-500",
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <Card
            key={c.label}
            className="relative overflow-hidden border border-border/60 bg-card/80 backdrop-blur"
          >
            <span
              className={cn("absolute inset-y-0 left-0 w-1", c.spine)}
              aria-hidden
            />
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {c.label}
              </CardTitle>
              <span
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full",
                  c.chip,
                )}
              >
                <Icon className={cn("h-4 w-4", c.accent)} />
              </span>
            </CardHeader>
            <CardContent className="space-y-1.5">
              <div className="flex items-baseline gap-1.5">
                {c.money ? (
                  <span className="font-mono text-xs text-muted-foreground">
                    R$
                  </span>
                ) : null}
                <span className="text-3xl leading-none tabular-nums [font-family:var(--font-fraunces)]">
                  {c.money ? formatToBRL(c.value) : c.value}
                </span>
              </div>
              <p className="truncate font-mono text-[10px] text-muted-foreground">
                {c.sub}
              </p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
