"use client";

import Link from "next/link";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type AccountStat = {
  id: string;
  code: string;
  account: string;
  platform: string;
  revenue: string;
  orders: string;
  status: "active" | "pending" | "error";
  accent?: "primary" | "accent" | "muted" | "warning";
  lastSync?: string;
};

interface CountryGridProps {
  items: AccountStat[];
  viewAllHref?: string;
}

export function CountryGrid({
  items,
  viewAllHref = "/integracoes/mercado-livre",
}: CountryGridProps) {
  return (
    <Card className="h-full rounded-2xl border border-border/60 bg-card/90 shadow-[0_18px_60px_color-mix(in_srgb,var(--color-shadow-color)_10%,transparent)]">
      <CardHeader className="flex flex-row items-center justify-between px-5 pb-2 pt-4">
        <div>
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
            Vendas por Conta
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full px-3 py-1"
          asChild
        >
          <Link href={viewAllHref}>Ver tudo</Link>
        </Button>
      </CardHeader>
      <CardContent className="grid gap-3 px-5 pb-5 [grid-template-columns:repeat(auto-fit,minmax(250px,1fr))]">
        {items.map((item) => (
          <div
            key={item.id}
            className="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/25 px-4 py-3 transition-colors hover:border-primary/30 hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "flex size-10 items-center justify-center rounded-full border border-border/50 text-sm font-semibold uppercase",
                  item.accent === "primary" && "bg-primary/15 text-primary",
                  item.accent === "accent" &&
                    "bg-accent/20 text-accent-foreground",
                  item.accent === "warning" &&
                    "bg-destructive/10 text-destructive",
                  item.accent === "muted" &&
                    "bg-muted/50 text-muted-foreground",
                )}
              >
                {item.code}
              </span>
              <div className="space-y-0.5">
                <p className="text-sm font-semibold text-foreground leading-tight">
                  {item.account}
                </p>
                <p className="text-xs text-muted-foreground">
                  {item.platform} • {item.orders} pedidos
                </p>
                {item.lastSync ? (
                  <p className="text-[11px] text-muted-foreground/80">
                    Última sync {item.lastSync}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              {item.revenue && item.revenue !== "-" ? (
                <span className="text-sm font-semibold text-foreground">
                  {item.revenue}
                </span>
              ) : null}
              <Badge
                variant="outline"
                className={cn(
                  "rounded-full px-2.5 py-1 text-[11px] font-semibold",
                  item.status === "active"
                    ? "border-primary/40 text-primary"
                    : item.status === "pending"
                      ? "border-accent/40 text-accent-foreground"
                      : "border-destructive/40 text-destructive",
                )}
              >
                {item.status === "active"
                  ? "Ativa"
                  : item.status === "pending"
                    ? "Aguardando"
                    : "Erro"}
              </Badge>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
