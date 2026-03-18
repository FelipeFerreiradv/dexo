"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import {
  Package,
  User,
  Calendar,
  DollarSign,
  Clock,
  Store,
} from "lucide-react";

import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { Order, OrderStatus } from "@/app/interfaces/order.interface";

interface OrderDetailSheetProps {
  order: Order | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOrderUpdate: () => void;
}

const statusStyles: Record<OrderStatus, string> = {
  PENDING:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/40 dark:text-amber-200",
  PAID:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-950/40 dark:text-emerald-200",
  SHIPPED:
    "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/40 dark:text-sky-200",
  DELIVERED:
    "border-primary/60 bg-primary/10 text-primary",
  CANCELLED:
    "border-destructive/60 bg-destructive/10 text-destructive",
};

const formatCurrency = (value: number) =>
  value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

const formatDateTime = (value: Date | string) =>
  new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });

export function OrderDetailSheet({
  order,
  open,
  onOpenChange,
  onOrderUpdate,
}: OrderDetailSheetProps) {
  const [isUpdating, setIsUpdating] = useState(false);
  const { data: session } = useSession();

  const handleStatusUpdate = async (newStatus: OrderStatus) => {
    if (!order || !session?.user?.email) return;

    try {
      setIsUpdating(true);
      const response = await fetch(
        `http://localhost:3333/orders/${order.id}/status`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            email: session.user.email,
          },
          body: JSON.stringify({ status: newStatus }),
        },
      );

      if (!response.ok) throw new Error("Erro ao atualizar status");

      onOrderUpdate();
      onOpenChange(false);
    } catch (error) {
      console.error("Erro ao atualizar status:", error);
    } finally {
      setIsUpdating(false);
    }
  };

  const renderStatusBadge = (status: OrderStatus) => (
    <Badge variant="outline" className={statusStyles[status] || "border-border/70"}>
      {status}
    </Badge>
  );

  if (!order) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-hidden border-l border-border/60 bg-gradient-to-b from-background via-background to-muted p-0 shadow-2xl sm:max-w-[900px] lg:max-w-[1100px]"
      >
        <div className="relative flex h-full flex-col">
          <div className="relative isolate overflow-hidden border-b border-border/60 bg-gradient-to-r from-primary/12 via-primary/6 to-transparent pl-6 pr-12 pb-6 pt-6">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 w-48 bg-[radial-gradient(circle_at_top_left,theme(colors.primary/25),transparent_55%)] opacity-80"
            />

            <div className="relative z-10 flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-inner shadow-primary/20">
                    <Package className="size-5" />
                  </span>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      Pedido
                    </p>
                    <p className="text-xl font-semibold leading-tight text-foreground">
                      {order.externalOrderId}
                    </p>
                  </div>
                </div>

                <p className="text-sm text-muted-foreground">
                  Detalhes completos do pedido importado
                </p>

                <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-card/70 px-3 py-1">
                    <Clock className="size-3" />
                    Criado em {formatDateTime(order.createdAt)}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-card/70 px-3 py-1">
                    <Clock className="size-3" />
                    Última atualização {formatDateTime(order.updatedAt)}
                  </span>
                </div>
              </div>

              <div className="flex flex-col items-end gap-3 text-right">
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {renderStatusBadge(order.status)}
                  <Select
                    defaultValue={order.status}
                    onValueChange={(value) =>
                      handleStatusUpdate(value as OrderStatus)
                    }
                    disabled={isUpdating}
                  >
                    <SelectTrigger className="min-w-[170px] border-border/70 bg-card/80 shadow-sm">
                      <SelectValue placeholder="Alterar status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PENDING">PENDING</SelectItem>
                      <SelectItem value="PAID">PAID</SelectItem>
                      <SelectItem value="SHIPPED">SHIPPED</SelectItem>
                      <SelectItem value="DELIVERED">DELIVERED</SelectItem>
                      <SelectItem value="CANCELLED">CANCELLED</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">
                    Total do Pedido
                  </p>
                  <p className="text-3xl font-semibold leading-tight text-foreground">
                    {formatCurrency(order.totalAmount)}
                  </p>
                </div>
              </div>
            </div>

            {order.marketplaceAccount ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-primary/50 bg-primary/10 text-xs font-medium uppercase tracking-[0.08em] text-primary"
                >
                  {order.marketplaceAccount.platform}
                </Badge>
                <span className="rounded-full border border-border/60 bg-card/70 px-3 py-1 text-xs text-muted-foreground">
                  {order.marketplaceAccount.accountName}
                </span>
              </div>
            ) : null}
          </div>

          <div className="flex-1 space-y-6 overflow-y-auto px-6 pb-8 pt-6">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <User className="size-4" />
                  Cliente
                </div>
                <div className="mt-2 text-base font-semibold text-foreground">
                  {order.customerName || "N/A"}
                </div>
                {order.customerEmail ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {order.customerEmail}
                  </p>
                ) : null}
              </div>

              <div className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Calendar className="size-4" />
                  Data do Pedido
                </div>
                <div className="mt-2 text-base font-semibold text-foreground">
                  {formatDateTime(order.createdAt)}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  ID externo: {order.externalOrderId}
                </p>
              </div>

              <div className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Store className="size-4" />
                  Marketplace
                </div>
                <div className="mt-2 text-base font-semibold text-foreground">
                  {order.marketplaceAccount?.platform ?? "Não informado"}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {order.marketplaceAccount?.accountName ??
                    "Conta não vinculada"}
                </p>
              </div>

              <div className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <DollarSign className="size-4" />
                  Resumo
                </div>
                <div className="mt-2 text-base font-semibold text-foreground">
                  {formatCurrency(order.totalAmount)}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {order.items?.length ?? 0}{" "}
                  {order.items?.length === 1 ? "item" : "itens"} no pedido
                </p>
              </div>
            </div>

            <section className="rounded-2xl border border-border/60 bg-card/80 shadow-sm backdrop-blur">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">
                    Itens do Pedido
                  </p>
                  <p className="text-sm font-semibold text-foreground">
                    {order.items?.length
                      ? `${order.items.length} ${
                          order.items.length === 1 ? "item" : "itens"
                        }`
                      : "Nenhum item cadastrado"}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className="bg-muted/40 text-[11px] font-medium text-muted-foreground"
                >
                  SKU · Quantidade · Total
                </Badge>
              </div>

              <div className="p-4">
                {order.items?.length ? (
                  <Table className="[&_th]:text-xs">
                    <TableHeader className="bg-muted/40">
                      <TableRow>
                        <TableHead>Produto</TableHead>
                        <TableHead>SKU</TableHead>
                        <TableHead>Quantidade</TableHead>
                        <TableHead>Preço Unitário</TableHead>
                        <TableHead>Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {order.items.map((item) => (
                        <TableRow key={item.id} className="hover:bg-muted/40">
                          <TableCell className="font-medium text-foreground">
                            {item.product?.name || "Produto não encontrado"}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {item.product?.sku || "N/A"}
                          </TableCell>
                          <TableCell>{item.quantity}</TableCell>
                          <TableCell>{formatCurrency(item.unitPrice)}</TableCell>
                          <TableCell>
                            {formatCurrency(item.quantity * item.unitPrice)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <div className="flex items-center gap-2 rounded-xl border border-dashed border-border/70 bg-muted/40 p-4 text-sm text-muted-foreground">
                    <Package className="size-4" />
                    Nenhum item vinculado a este pedido.
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
