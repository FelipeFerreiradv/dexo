"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  Wallet,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatToBRL } from "@/components/ui/currency-input";
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
}

export function FinanceOverview({ refreshKey }: Props) {
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
      const res = await fetch(`${getApiBaseUrl()}/finance/summary`, {
        headers: { email },
        signal: ctrl.signal,
      });
      if (!res.ok) return;
      const data = await res.json();
      setSummary(data.summary || data);
    } catch {
      // silent
    }
  }, [session?.user?.email]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary, refreshKey]);

  const cards = [
    {
      label: "A receber (pendente)",
      value: summary?.receivables.pendingAmount ?? 0,
      icon: ArrowDownCircle,
      className: "text-green-600",
    },
    {
      label: "A receber (vencido)",
      value: summary?.receivables.overdueAmount ?? 0,
      icon: AlertTriangle,
      className: "text-amber-600",
    },
    {
      label: "A pagar (pendente)",
      value: summary?.payables.pendingAmount ?? 0,
      icon: ArrowUpCircle,
      className: "text-red-600",
    },
    {
      label: "A pagar (vencido)",
      value: summary?.payables.overdueAmount ?? 0,
      icon: Wallet,
      className: "text-amber-600",
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <Card
            key={c.label}
            className="border border-border/60 bg-card/80 backdrop-blur"
          >
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                {c.label}
              </CardTitle>
              <Icon className={`h-4 w-4 ${c.className}`} />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">
                R$ {formatToBRL(c.value)}
              </p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
