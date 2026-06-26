"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import {
  Search,
  Download,
  ChevronLeft,
  ChevronRight,
  Eye,
  LayoutGrid,
  List,
  Package,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { getApiBaseUrl } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { Order } from "@/app/interfaces/order.interface";
import { OrderSkeleton } from "./order-skeleton";
import { OrderDetailSheet } from "./order-detail-sheet";
import { OrdersFilters } from "./orders-filters";
import { OrdersTableView } from "./orders-table-view";
import { OrdersGalleryView } from "./orders-gallery-view";
import {
  OrdersGallerySkeleton,
  OrdersTableSkeleton,
} from "./orders-gallery-skeleton";
import { useOrdersView, type OrdersView } from "../hooks/use-orders-view";
import {
  DEFAULT_ORDER_FILTERS,
  countActiveOrderFilters,
  hasActiveOrderFilters,
  serializeOrderFilters,
  type OrderFiltersState,
} from "../lib/order-filters";

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
  const [filters, setFilters] = useState<OrderFiltersState>(
    DEFAULT_ORDER_FILTERS,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [isDetailSheetOpen, setIsDetailSheetOpen] = useState(false);
  const [view, setView] = useOrdersView("gallery");

  // Debounce da busca → filtros (mesma cadência de hoje, 250ms).
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = searchInput.trim();
      setFilters((prev) =>
        prev.search === next ? prev : { ...prev, search: next },
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Qualquer mudança de filtro volta para a página 1 (estende o que a lista já
  // fazia para busca/plataforma).
  useEffect(() => {
    setPagination((prev) => (prev.page === 1 ? prev : { ...prev, page: 1 }));
  }, [filters]);

  // Busca vinda da URL (?search=) preenche o campo (preservado do original).
  useEffect(() => {
    const param = searchParams?.get("search") ?? "";
    if (param && param !== searchInput) {
      setSearchInput(param);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

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

  const updateFilter = useCallback(function updateFilterValue<
    K extends keyof OrderFiltersState,
  >(key: K, value: OrderFiltersState[K]) {
    setFilters((prev) =>
      prev[key] === value ? prev : { ...prev, [key]: value },
    );
  }, []);

  const clearFilters = useCallback(() => {
    setSearchInput("");
    setFilters(DEFAULT_ORDER_FILTERS);
  }, []);

  const fetchOrders = useCallback(async () => {
    if (!session?.user?.email) {
      console.log("Session not ready for orders");
      return;
    }
    try {
      setIsLoading(true);
      const params = serializeOrderFilters(filters, {
        page: pagination.page,
        limit: pagination.limit,
      });

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
  }, [
    filters,
    pagination.limit,
    pagination.page,
    session?.user?.email,
    showToast,
  ]);

  const fetchStats = useCallback(async () => {
    if (!session?.user?.email) {
      return;
    }
    try {
      // Stats permanecem um retrato global, respeitando só o marketplace (como
      // hoje). Os demais filtros (data/preço/status/busca) afetam só a lista.
      const statsParams = new URLSearchParams();
      if (filters.marketplace) {
        statsParams.set("platform", filters.marketplace);
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
  }, [session?.user?.email, filters.marketplace]);

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

  const handleViewOrder = async (order: Order) => {
    // Abre o sheet imediatamente (o cabeçalho já vem na lista). A lista NÃO traz
    // os itens (egress enxuto), então recarrega o pedido COMPLETO via
    // GET /orders/:id e preenche os itens quando chegam. O sheet trata
    // order.items ausente (mostra "0 itens" por instantes). Sem perda de dados.
    setSelectedOrder(order);
    setIsDetailSheetOpen(true);
    const email = session?.user?.email;
    if (!email) return;
    try {
      const res = await fetch(`${getApiBaseUrl()}/orders/${order.id}`, {
        headers: { email },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.order) setSelectedOrder(data.order);
    } catch {
      /* mantém o pedido da lista (sem itens) se o refetch falhar */
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

  const filtersActive =
    hasActiveOrderFilters(filters) || searchInput.trim().length > 0;

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

      {/* Filtros */}
      <OrdersFilters
        filters={filters}
        searchInput={searchInput}
        onSearchInputChange={setSearchInput}
        onUpdateFilter={updateFilter}
        onClear={clearFilters}
        isFetching={isLoading}
        activeCount={countActiveOrderFilters(filters)}
      />

      {/* Toolbar: contagem + importar + alternância de visão */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {pagination.total} {pagination.total === 1 ? "pedido" : "pedidos"}
          {filtersActive ? " · filtros ativos" : ""}
        </p>
        <div className="flex items-center gap-2">
          <Button
            onClick={handleImportOrders}
            disabled={isImporting}
            variant="outline"
          >
            {isImporting ? "Importando..." : "Importar Pedidos"}
          </Button>
          <Tabs
            value={view}
            onValueChange={(value) => setView(value as OrdersView)}
          >
            <TabsList>
              <TabsTrigger value="gallery" aria-label="Visão em vitrine">
                <LayoutGrid className="size-4" />
              </TabsTrigger>
              <TabsTrigger value="table" aria-label="Visão em tabela">
                <List className="size-4" />
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* Miolo: vitrine ou tabela */}
      {isLoading ? (
        view === "gallery" ? (
          <OrdersGallerySkeleton />
        ) : (
          <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
            <CardContent className="pt-6">
              <OrdersTableSkeleton />
            </CardContent>
          </Card>
        )
      ) : orders.length === 0 ? (
        <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
          <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Package className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">
              {filtersActive
                ? "Nenhum pedido encontrado para os filtros aplicados."
                : "Nenhum pedido importado ainda."}
            </p>
            <p className="text-sm text-muted-foreground">
              {filtersActive
                ? "Ajuste ou limpe os filtros para ver mais resultados."
                : "Use “Importar Pedidos” para trazer pedidos dos marketplaces."}
            </p>
          </CardContent>
        </Card>
      ) : view === "gallery" ? (
        <OrdersGalleryView orders={orders} onView={handleViewOrder} />
      ) : (
        <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
          <CardContent className="pt-6">
            <OrdersTableView orders={orders} onView={handleViewOrder} />
          </CardContent>
        </Card>
      )}

      {/* Pagination */}
      {!isLoading && orders.length > 0 && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between px-2 py-2">
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
      <ToastViewport>
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`fixed bottom-4 right-4 p-4 rounded-md shadow-lg z-[100] ${
              toast.type === "success" ? "bg-green-500" : "bg-red-500"
            } text-white`}
          >
            {toast.message}
          </div>
        ))}
      </ToastViewport>
    </div>
  );
}
