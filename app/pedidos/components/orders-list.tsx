"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { Search, Download, ChevronLeft, ChevronRight, Eye } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import type { Order, OrderFindResult } from "@/app/interfaces/order.interface";
import { OrderSkeleton } from "./order-skeleton";
import { OrderDetailSheet } from "./order-detail-sheet";

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface OrderStats {
  totalOrders: number;
  pendingOrders: number;
  deliveredOrders: number;
  totalRevenue: number;
}

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "warning";
}

export function OrdersList() {
  const { data: session, status } = useSession();
  const [orders, setOrders] = useState<Order[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 0,
  });
  const [stats, setStats] = useState<OrderStats>({
    totalOrders: 0,
    pendingOrders: 0,
    deliveredOrders: 0,
    totalRevenue: 0,
  });
  const [search, setSearch] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [isDetailSheetOpen, setIsDetailSheetOpen] = useState(false);

  const showToast = useCallback(
    (message: string, type: "success" | "error") => {
      const id = crypto.randomUUID();
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
      }, 5000);
    },
    [],
  );

  const fetchOrders = useCallback(async () => {
    if (!session?.user?.email) {
      console.log("Session not ready for orders");
      return;
    }
    try {
      setIsLoading(true);
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        limit: pagination.limit.toString(),
        ...(search && { search }),
      });

      const response = await fetch(`http://localhost:3333/orders?${params}`, {
        headers: {
          "Content-Type": "application/json",
          email: session.user.email,
        },
      });
      if (!response.ok) throw new Error("Erro ao buscar pedidos");

      const data = await response.json();
      setOrders(data.orders);
      setPagination({
        page: data.page,
        limit: data.limit,
        total: data.total,
        totalPages: data.totalPages,
      });
    } catch (error) {
      console.error("Erro ao buscar pedidos:", error);
      showToast("Erro ao carregar pedidos", "error");
    } finally {
      setIsLoading(false);
    }
  }, [pagination.page, pagination.limit, search, session, showToast]);

  const fetchStats = useCallback(async () => {
    if (!session?.user?.email) {
      return;
    }
    try {
      const response = await fetch("http://localhost:3333/orders/stats", {
        headers: {
          "Content-Type": "application/json",
          email: session.user.email,
        },
      });
      if (!response.ok) throw new Error("Erro ao buscar estatísticas");

      const data = await response.json();
      setStats({
        totalOrders: data.stats.total,
        pendingOrders: data.stats.pending,
        deliveredOrders: data.stats.delivered,
        totalRevenue: 0, // TODO: calcular receita total
      });
    } catch (error) {
      console.error("Erro ao buscar estatísticas:", error);
    }
  }, [session]);

  const handleImportOrders = async () => {
    if (!session?.user?.email) {
      showToast("Usuário não autenticado", "error");
      return;
    }
    try {
      setIsImporting(true);
      const response = await fetch("http://localhost:3333/orders/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          email: session.user.email,
        },
        body: JSON.stringify({ deductStock: true }),
      });

      if (!response.ok) throw new Error("Erro ao importar pedidos");

      const data = await response.json();
      showToast(`Importados ${data.imported} pedidos`, "success");
      fetchOrders();
      fetchStats();
    } catch (error) {
      console.error("Erro ao importar pedidos:", error);
      showToast("Erro ao importar pedidos", "error");
    } finally {
      setIsImporting(false);
    }
  };

  const handleViewOrder = (order: Order) => {
    setSelectedOrder(order);
    setIsDetailSheetOpen(true);
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

  useEffect(() => {
    if (status === "authenticated" && session?.user?.email) {
      fetchStats();
    }
  }, [fetchStats, session, status]);

  useEffect(() => {
    if (status === "authenticated" && session?.user?.email) {
      fetchOrders();
    }
  }, [fetchOrders, session, status]);

  if (status === "loading") {
    return <OrderSkeleton />;
  }

  if (status === "unauthenticated") {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-muted-foreground">
            Você precisa estar logado para acessar esta página.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Statistics Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Total de Pedidos
            </CardTitle>
            <Download className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalOrders}</div>
            <p className="text-xs text-muted-foreground">Pedidos importados</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Pedidos Pendentes
            </CardTitle>
            <Search className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.pendingOrders}</div>
            <p className="text-xs text-muted-foreground">
              Aguardando processamento
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Pedidos Entregues
            </CardTitle>
            <Eye className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.deliveredOrders}</div>
            <p className="text-xs text-muted-foreground">
              Finalizados com sucesso
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Receita Total</CardTitle>
            <Download className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              R${" "}
              {stats.totalRevenue.toLocaleString("pt-BR", {
                minimumFractionDigits: 2,
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Valor total dos pedidos
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
            <Input
              placeholder="Buscar pedidos..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 w-[300px]"
            />
          </div>
        </div>
        <Button onClick={handleImportOrders} disabled={isImporting}>
          {isImporting ? "Importando..." : "Importar Pedidos"}
        </Button>
      </div>

      {/* Orders Table */}
      <Card>
        <CardHeader>
          <CardTitle>Pedidos</CardTitle>
          <CardDescription>
            Lista de todos os pedidos importados dos marketplaces
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <OrderSkeleton />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID Externo</TableHead>
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
                      <TableCell className="font-mono text-sm">
                        {order.externalOrderId}
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
                          onClick={() => handleViewOrder(order)}
                        >
                          <Eye className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              {pagination.totalPages > 1 && (
                <div className="flex items-center justify-between px-2 py-4">
                  <div className="flex-1 text-sm text-muted-foreground">
                    Mostrando {orders.length} de {pagination.total} pedidos
                  </div>
                  <div className="flex items-center space-x-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setPagination((prev) => ({
                          ...prev,
                          page: prev.page - 1,
                        }))
                      }
                      disabled={pagination.page === 1}
                    >
                      <ChevronLeft className="size-4" />
                      Anterior
                    </Button>
                    <span className="text-sm">
                      Página {pagination.page} de {pagination.totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setPagination((prev) => ({
                          ...prev,
                          page: prev.page + 1,
                        }))
                      }
                      disabled={pagination.page === pagination.totalPages}
                    >
                      Próximo
                      <ChevronRight className="size-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Order Detail Sheet */}
      <OrderDetailSheet
        order={selectedOrder}
        open={isDetailSheetOpen}
        onOpenChange={setIsDetailSheetOpen}
        onOrderUpdate={() => {
          fetchOrders();
          fetchStats();
        }}
      />

      {/* Toasts */}
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`fixed bottom-4 right-4 p-4 rounded-md shadow-lg ${
            toast.type === "success" ? "bg-green-500" : "bg-red-500"
          } text-white`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
