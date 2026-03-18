"use client";

import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type Direction = "up" | "down" | "flat";

export type ProductRow = {
  id?: string;
  name: string;
  sku?: string;
  stock: string;
  sales: string;
  growth: string;
  reviews: string;
  views: string;
  direction?: Direction;
};

interface TopProductsTableProps {
  rows: ProductRow[];
}

export function TopProductsTable({ rows }: TopProductsTableProps) {
  return (
    <Card className="h-full rounded-2xl border border-border/60 bg-card/90 shadow-[0_18px_60px_color-mix(in_srgb,var(--color-shadow-color)_10%,transparent)]">
      <CardHeader className="flex flex-row items-center justify-between px-5 pb-3 pt-4">
        <div>
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
            MovimentaÃ§Ã£o de estoque
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full px-3 py-1"
          asChild
        >
          <a href="/produtos">Ver tudo</a>
        </Button>
      </CardHeader>
      <CardContent className="px-4 pb-5">
        <div className="overflow-x-auto rounded-xl border border-border/60">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                <TableHead className="w-[24%]">Produto</TableHead>
                <TableHead className="w-[14%] text-right">Estoque</TableHead>
                <TableHead className="w-[14%] text-right">Vendas</TableHead>
                <TableHead className="w-[14%] text-right">Crescimento</TableHead>
                <TableHead className="w-[16%] text-right">AvaliaÃ§Ãµes</TableHead>
                <TableHead className="w-[16%] text-right">VisualizaÃ§Ãµes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.id ?? `${row.name}-${row.sku ?? ""}`}
                  className="border-border/50 text-sm transition-colors hover:bg-muted/30"
                >
                  <TableCell className="font-medium text-foreground">
                    <div className="flex flex-col">
                      <span>{row.name}</span>
                      {row.sku ? (
                        <span className="text-xs text-muted-foreground">
                          SKU {row.sku}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-foreground">
                    {row.stock}
                  </TableCell>
                  <TableCell className="text-right text-foreground">
                    {row.sales}
                  </TableCell>
                  <TableCell className="text-right">
                    <DirectionPill
                      value={row.growth}
                      direction={row.direction ?? "flat"}
                    />
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {row.reviews}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {row.views}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function DirectionPill({
  value,
  direction,
}: {
  value: string;
  direction: Direction;
}) {
  const isUp = direction === "up";
  const isFlat = direction === "flat";
  const Icon = isFlat ? Minus : isUp ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "inline-flex min-w-[86px] items-center justify-end gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold",
        isFlat && "border-border/60 bg-muted/40 text-muted-foreground",
        isUp && "border-primary/25 bg-primary/10 text-primary",
        !isUp &&
          !isFlat &&
          "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <Icon className="size-3.5" />
      <span>{value}</span>
    </span>
  );
}

