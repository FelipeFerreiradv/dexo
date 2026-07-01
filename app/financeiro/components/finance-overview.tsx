"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  Wallet,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatToBRL } from "@/components/ui/currency-input";
import { cn } from "@/lib/utils";
import { getApiBaseUrl } from "@/lib/api";

interface SummaryBucket {
  totalCount: number;
  totalAmount: number;
  overdueCount: number;
  overdueAmount: number;
  pendingAmount: number;
  paidAmount: number;
}
interface Summary {
  receivables: SummaryBucket;
  payables: SummaryBucket;
}

interface Props {
  refreshKey?: number;
  // undefined = todas (sem parâmetro = comportamento atual byte-a-byte);
  // "sem_unidade" = contas sem unidade; <id> = uma unidade.
  unidadeId?: string;
}

export function FinanceOverview({ refreshKey, unidadeId }: Props) {
  const { data: session } = useSession();
  const [summary, setSummary] = useState<Summary | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchSummary = useCallback(async () => {
    const email = session?.user?.email;
    if (!email) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const qs = unidadeId ? `?unidadeId=${encodeURIComponent(unidadeId)}` : "";
      const res = await fetch(`${getApiBaseUrl()}/finance/summary${qs}`, {
        headers: { email },
        signal: ctrl.signal,
      });
      if (!res.ok) return;
      const data = await res.json();
      setSummary(data.summary || data);
    } catch {
      // silent
    }
  }, [session?.user?.email, unidadeId]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary, refreshKey]);

  // Cores da paleta: Verde Operação = dinheiro entrando; vermelho = saindo;
  // âmbar = vencido/alerta. Spine + chip do ícone reforçam sem poluir.
  const cards = [
    {
      label: "A receber (pendente)",
      value: summary?.receivables.pendingAmount ?? 0,
      icon: ArrowDownCircle,
      accent: "text-[#2c5f4f] dark:text-emerald-400",
      chip: "bg-[#2c5f4f]/10",
      spine: "bg-[#2c5f4f]",
    },
    {
      label: "A receber (vencido)",
      value: summary?.receivables.overdueAmount ?? 0,
      icon: AlertTriangle,
      accent: "text-amber-600 dark:text-amber-400",
      chip: "bg-amber-500/10",
      spine: "bg-amber-500",
    },
    {
      label: "A pagar (pendente)",
      value: summary?.payables.pendingAmount ?? 0,
      icon: ArrowUpCircle,
      accent: "text-red-600 dark:text-red-400",
      chip: "bg-red-500/10",
      spine: "bg-red-500",
    },
    {
      label: "A pagar (vencido)",
      value: summary?.payables.overdueAmount ?? 0,
      icon: Wallet,
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
            <CardContent>
              <div className="flex items-baseline gap-1.5">
                <span className="font-mono text-xs text-muted-foreground">
                  R$
                </span>
                <span className="text-3xl leading-none tabular-nums [font-family:var(--font-fraunces)]">
                  {formatToBRL(c.value)}
                </span>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
