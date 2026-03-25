"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Search, Download, ChevronLeft, ChevronRight, Eye } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getApiBaseUrl } from "@/lib/api";
import { Input } from "@/components/ui/input";
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
  const searchParams = useSearchParams();
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
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [isDetailSheetOpen, setIsDetailSheetOpen] = useState(false);
  const [platformFilter, setPlatformFilter] = useState<string>("ALL");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchInput.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setPagination((prev) => (prev.page === 1 ? prev : { ...prev, page: 1 }));
  }, [debouncedSearch, platformFilter]);

  useEffect(() => {
    const param = searchParams?.get("search") ?? "";
    if (param && param !== searchInput) {
      setSearchInput(param);
      setDebouncedSearch(param.trim());
    }
  }, [searchInput, searchParams]);

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
      });
      const term = debouncedSearch.trim();
      if (term.length >= 2) {
        params.set("search", term);
      }
      if (platformFilter && platformFilter !== "ALL") {
        params.set("platform", platformFilter);
      }

      const apiBase = getApiBaseUrl();
      const response = await fetch(`${apiBase}/orders?${params}`, {
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
  }, [debouncedSearch, pagination.limit, pagination.page, platformFilter, session, showToast]);

  const fetchStats = useCallback(async () => {
    if (!session?.user?.email) {
      return;
    }
    try {
      const statsParams = new URLSearchParams();
      if (platformFilter && platformFilter !== "ALL") {
        statsParams.set("platform", platformFilter);
      }
      const qs = statsParams.toString();
      const response = await fetch(
        `${getApiBaseUrl()}/orders/stats${qs ? `?${qs}` : ""}`,
        {
          headers: {
            "Content-Type": "application/json",
            email: session.user.email,
          },
        },
      );
      if (!response.ok) throw new Error("Erro ao buscar estatísticas");

      const data = await response.json();
      const deliveredCount =
        (data.stats?.delivered ?? 0) +
        (data.stats?.shipped ?? 0) +
        (data.stats?.paid ?? 0); // consideramos pagos/expedidos como concluídos

      const totalRevenue =
        typeof data.stats?.totalRevenue === "number"
          ? data.stats.totalRevenue
          : Number(data.stats?.totalRevenue ?? 0);

      setStats({
        totalOrders: data.stats.total,
        pendingOrders: data.stats.pending,
        deliveredOrders: deliveredCount,
        totalRevenue,
      });
    } catch (error) {
      console.error("Erro ao buscar estatísticas:", error);
    }
  }, [session, platformFilter]);

  const handleImportOrders = async () => {
    if (!session?.user?.email) {
      showToast("Usuário não autenticado", "error");
      return;
    }
    try {
      setIsImporting(true);
      const response = await fetch(`${getApiBaseUrl()}/orders/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          email: session.user.email,
        },
        body: JSON.stringify({ deductStock: true, platform: "ALL" }),
      });

      if (!response.ok) throw new Error("Erro ao importar pedidos");

      const data = await response.json();
      showToast(
        `Importados ${data.imported} pedidos de todos os marketplaces`,
        "success",
      );
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

  const getPlatformLabel = (platform: string) => {
    switch (platform) {
      case "MERCADO_LIVRE":
        return "Mercado Livre";
      case "SHOPEE":
        return "Shopee";
      default:
        return platform;
    }
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
        <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
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

        <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
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

        <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
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

        <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
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
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="h-10 w-[300px] rounded-full border border-border/70 bg-muted/20 pl-8"
            />
          </div>
          <Select value={platformFilter} onValueChange={setPlatformFilter}>
            <SelectTrigger className="h-10 w-[180px]">
              <SelectValue placeholder="Plataforma" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Todos</SelectItem>
              <SelectItem value="MERCADO_LIVRE">Mercado Livre</SelectItem>
              <SelectItem value="SHOPEE">Shopee</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={handleImportOrders} disabled={isImporting}>
          {isImporting ? "Importando..." : "Importar Pedidos"}
        </Button>
      </div>

      {/* Orders Table */}
      <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
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
                      <TableCell className="font-mono text-sm">
                        {order.externalOrderId}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={
                            order.marketplaceAccount?.platform === "MERCADO_LIVRE"
                              ? "border-yellow-500/50 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400"
                              : order.marketplaceAccount?.platform === "SHOPEE"
                                ? "border-orange-500/50 bg-orange-500/10 text-orange-700 dark:text-orange-400"
                                : ""
                          }
                        >
                          {getPlatformLabel(
                            order.marketplaceAccount?.platform || "—",
                          )}
                        </Badge>
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
