"use client";

import { Eye } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { Order } from "@/app/interfaces/order.interface";
import {
  getPlatformLabel,
  getStatusBadge,
  platformBadgeClassName,
} from "../lib/order-badges";

interface OrdersTableViewProps {
  orders: Order[];
  onView: (order: Order) => void;
  /** Seleção em massa (etiquetas em lote) — só quando o módulo está ligado. */
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onToggleAll?: () => void;
  allSelected?: boolean;
}

/**
 * Tabela de pedidos — preserva exatamente as colunas/comportamento da versão
 * original (`orders-list.tsx`). Único acréscimo: o nome da conta
 * (`accountName`) como 2ª linha dentro da célula "Plataforma" (§9). Quando
 * `selectable`, ganha uma coluna de checkbox (etiquetas em lote).
 */
export function OrdersTableView({
  orders,
  onView,
  selectable,
  selectedIds,
  onToggleSelect,
  onToggleAll,
  allSelected,
}: OrdersTableViewProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {selectable ? (
            <TableHead className="w-[40px]">
              <Checkbox
                checked={!!allSelected}
                onCheckedChange={() => onToggleAll?.()}
                aria-label="Selecionar todos os pedidos da página"
              />
            </TableHead>
          ) : null}
          <TableHead>ID Externo</TableHead>
          <TableHead>Plataforma</TableHead>
          <TableHead>Cliente</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Total</TableHead>
          <TableHead>Data</TableHead>
          <TableHead className="w-[100px]">Ações</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((order) => (
          <TableRow key={order.id}>
            {selectable ? (
              <TableCell className="w-[40px]">
                <Checkbox
                  checked={!!selectedIds?.has(order.id)}
                  onCheckedChange={() => onToggleSelect?.(order.id)}
                  aria-label={`Selecionar pedido ${order.externalOrderId}`}
                />
              </TableCell>
            ) : null}
            <TableCell className="font-mono text-sm">
              {order.externalOrderId}
            </TableCell>
            <TableCell>
              <div className="flex flex-col gap-1">
                <Badge
                  variant="outline"
                  className={platformBadgeClassName(
                    order.marketplaceAccount?.platform,
                  )}
                >
                  {getPlatformLabel(order.marketplaceAccount?.platform || "—")}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {order.marketplaceAccount?.accountName || "—"}
                </span>
              </div>
            </TableCell>
            <TableCell>{order.customerName || "N/A"}</TableCell>
            <TableCell>{getStatusBadge(order.status)}</TableCell>
            <TableCell>
              R${" "}
              {order.totalAmount.toLocaleString("pt-BR", {
                minimumFractionDigits: 2,
              })}
            </TableCell>
            <TableCell>
              {new Date(order.createdAt).toLocaleDateString("pt-BR")}
            </TableCell>
            <TableCell>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onView(order)}
                aria-label={`Ver pedido ${order.externalOrderId}`}
              >
                <Eye className="size-4" />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
