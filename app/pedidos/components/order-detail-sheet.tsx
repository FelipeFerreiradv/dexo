"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { X, Package, User, Calendar, DollarSign } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
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

  const getStatusBadge = (status: string) => {
    const variants: Record<
      string,
      "default" | "secondary" | "destructive" | "outline"
    > = {
      PENDING: "secondary",
      PAID: "default",
      SHIPPED: "outline",
      DELIVERED: "default",
      CANCELLED: "destructive",
    };
    return <Badge variant={variants[status] || "default"}>{status}</Badge>;
  };

  if (!order) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[600px] sm:w-[800px]">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Package className="size-5" />
            Pedido {order.externalOrderId}
          </SheetTitle>
          <SheetDescription>
            Detalhes completos do pedido importado
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 mt-6">
          {/* Order Info */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <User className="size-4" />
                Cliente
              </div>
              <div className="font-medium">{order.customerName || "N/A"}</div>
              {order.customerEmail && (
                <div className="text-sm text-muted-foreground">
                  {order.customerEmail}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Calendar className="size-4" />
                Data do Pedido
              </div>
              <div className="font-medium">
                {new Date(order.createdAt).toLocaleString("pt-BR")}
              </div>
            </div>
          </div>

          {/* Status and Total */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="text-sm text-muted-foreground">Status</div>
              <div className="flex items-center gap-2">
                {getStatusBadge(order.status)}
                <Select
                  onValueChange={(value) =>
                    handleStatusUpdate(value as OrderStatus)
                  }
                  disabled={isUpdating}
                >
                  <SelectTrigger className="w-[140px]">
                    <SelectValue placeholder="Alterar" />
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
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <DollarSign className="size-4" />
                Total
              </div>
              <div className="text-2xl font-bold">
                R${" "}
                {order.totalAmount.toLocaleString("pt-BR", {
                  minimumFractionDigits: 2,
                })}
              </div>
            </div>
          </div>

          {/* Marketplace Account */}
          {order.marketplaceAccount && (
            <div className="space-y-2">
              <div className="text-sm text-muted-foreground">Marketplace</div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">
                  {order.marketplaceAccount.platform}
                </Badge>
                <span className="text-sm">
                  {order.marketplaceAccount.accountName}
                </span>
              </div>
            </div>
          )}

          {/* Order Items */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Itens do Pedido</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produto</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Quantidade</TableHead>
                  <TableHead>Preço Unitário</TableHead>
                  <TableHead>Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.items?.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">
                      {item.product?.name || "Produto não encontrado"}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {item.product?.sku || "N/A"}
                    </TableCell>
                    <TableCell>{item.quantity}</TableCell>
                    <TableCell>
                      R${" "}
                      {item.unitPrice.toLocaleString("pt-BR", {
                        minimumFractionDigits: 2,
                      })}
                    </TableCell>
                    <TableCell>
                      R${" "}
                      {(item.quantity * item.unitPrice).toLocaleString(
                        "pt-BR",
                        { minimumFractionDigits: 2 },
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Timestamps */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-muted-foreground">Criado em</div>
              <div>{new Date(order.createdAt).toLocaleString("pt-BR")}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Última atualização</div>
              <div>{new Date(order.updatedAt).toLocaleString("pt-BR")}</div>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
