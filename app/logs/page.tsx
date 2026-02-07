"use client";

import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
// import { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from "@/components/ui/pagination";
import {
  CalendarIcon,
  SearchIcon,
  FilterIcon,
  DownloadIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

interface SystemLog {
  id: string;
  userId?: string;
  user?: {
    id: string;
    name?: string;
    email: string;
  };
  action: string;
  resource?: string;
  resourceId?: string;
  level: "INFO" | "WARNING" | "ERROR";
  message: string;
  ipAddress?: string;
  userAgent?: string;
  details?: any;
  createdAt: string;
}

interface LogsResponse {
  logs: SystemLog[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

interface StatsResponse {
  totalLogs: number;
  logsByLevel: Record<string, number>;
  logsByAction: Record<string, number>;
  logsByResource: Record<string, number>;
  recentActivity: Array<{
    date: string;
    count: number;
  }>;
}

export default function LogsPage() {
  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [filters, setFilters] = useState<{
    userId?: string;
    action?: string;
    resource?: string;
    level?: string;
    search?: string;
    startDate?: string;
    endDate?: string;
  }>({
    userId: undefined,
    action: undefined,
    resource: undefined,
    level: undefined,
    search: undefined,
    startDate: undefined,
    endDate: undefined,
  });

  // Buscar logs
  const fetchLogs = async (page = 1) => {
    try {
      setLoading(true);
      const queryParams = new URLSearchParams({
        page: page.toString(),
        limit: "20",
        ...Object.fromEntries(
          Object.entries(filters).filter(
            ([_, value]) => value !== undefined && value !== "",
          ),
        ),
      });

      const response = await fetch(`/api/system-logs?${queryParams}`);
      if (response.ok) {
        const data: LogsResponse = await response.json();
        setLogs(data.logs);
        setCurrentPage(data.pagination.page);
        setTotalPages(data.pagination.totalPages);
      }
    } catch (error) {
      console.error("Erro ao buscar logs:", error);
    } finally {
      setLoading(false);
    }
  };

  // Buscar estatísticas
  const fetchStats = async () => {
    try {
      const response = await fetch("/api/system-logs/stats");
      if (response.ok) {
        const data: StatsResponse = await response.json();
        setStats(data);
      }
    } catch (error) {
      console.error("Erro ao buscar estatísticas:", error);
    }
  };

  // Efeito inicial
  useEffect(() => {
    fetchStats();
    fetchLogs();
  }, []);

  // Efeito para filtros
  useEffect(() => {
    fetchLogs(1);
  }, [filters]);

  // Manipular mudança de página
  const handlePageChange = (page: number) => {
    fetchLogs(page);
  };

  // Manipular filtros
  const handleFilterChange = (key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value || undefined }));
  };

  // Limpar filtros
  const clearFilters = () => {
    setFilters({
      userId: undefined,
      action: undefined,
      resource: undefined,
      level: undefined,
      search: undefined,
      startDate: undefined,
      endDate: undefined,
    });
  };

  // Formatar data
  const formatDate = (dateString: string) => {
    return format(new Date(dateString), "dd/MM/yyyy HH:mm:ss", {
      locale: ptBR,
    });
  };

  // Obter cor do badge baseado no nível
  const getLevelBadgeVariant = (level: string) => {
    switch (level) {
      case "ERROR":
        return "destructive";
      case "WARNING":
        return "secondary";
      default:
        return "default";
    }
  };

  // Obter texto amigável para ações
  const getActionLabel = (action: string) => {
    const actionLabels: Record<string, string> = {
      LOGIN: "Login",
      LOGOUT: "Logout",
      CREATE_PRODUCT: "Criar Produto",
      UPDATE_PRODUCT: "Atualizar Produto",
      DELETE_PRODUCT: "Excluir Produto",
      CREATE_ORDER: "Criar Pedido",
      SYNC_STOCK: "Sincronizar Estoque",
      CONNECT_MARKETPLACE: "Conectar Marketplace",
      DISCONNECT_MARKETPLACE: "Desconectar Marketplace",
      CREATE_LISTING: "Criar Anúncio",
      USER_ACTIVITY: "Atividade do Usuário",
      SYSTEM_ERROR: "Erro do Sistema",
    };
    return actionLabels[action] || action;
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Logs do Sistema</h1>
          <p className="text-muted-foreground">
            Monitore todas as atividades e eventos da plataforma
          </p>
        </div>
        <Button variant="outline" size="sm">
          <DownloadIcon className="h-4 w-4 mr-2" />
          Exportar
        </Button>
      </div>

      {/* Estatísticas */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                Total de Logs
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {stats.totalLogs.toLocaleString()}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Erros</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600">
                {stats.logsByLevel.ERROR || 0}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Avisos</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-yellow-600">
                {stats.logsByLevel.WARNING || 0}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                Atividades Hoje
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">
                {stats.recentActivity.find(
                  (a) => a.date === new Date().toISOString().split("T")[0],
                )?.count || 0}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filtros */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FilterIcon className="h-5 w-5" />
            Filtros
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Buscar</label>
              <div className="relative">
                <SearchIcon className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Mensagem, usuário..."
                  value={filters.search}
                  onChange={(e) => handleFilterChange("search", e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Ação</label>
              <Select
                value={filters.action}
                onValueChange={(value) => handleFilterChange("action", value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Todas as ações" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LOGIN">Login</SelectItem>
                  <SelectItem value="CREATE_PRODUCT">Criar Produto</SelectItem>
                  <SelectItem value="UPDATE_PRODUCT">
                    Atualizar Produto
                  </SelectItem>
                  <SelectItem value="DELETE_PRODUCT">
                    Excluir Produto
                  </SelectItem>
                  <SelectItem value="SYNC_STOCK">
                    Sincronizar Estoque
                  </SelectItem>
                  <SelectItem value="CREATE_LISTING">Criar Anúncio</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Nível</label>
              <Select
                value={filters.level}
                onValueChange={(value) => handleFilterChange("level", value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Todos os níveis" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="INFO">Info</SelectItem>
                  <SelectItem value="WARNING">Aviso</SelectItem>
                  <SelectItem value="ERROR">Erro</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Recurso</label>
              <Select
                value={filters.resource}
                onValueChange={(value) => handleFilterChange("resource", value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Todos os recursos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Product">Produto</SelectItem>
                  <SelectItem value="User">Usuário</SelectItem>
                  <SelectItem value="Sync">Sincronização</SelectItem>
                  <SelectItem value="MarketplaceAccount">
                    Marketplace
                  </SelectItem>
                  <SelectItem value="ProductListing">Anúncio</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex gap-2 mt-4">
            <Button variant="outline" onClick={clearFilters}>
              Limpar Filtros
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Timeline de Logs */}
      <Card>
        <CardHeader>
          <CardTitle>Logs Recentes</CardTitle>
          <CardDescription>
            Últimas atividades registradas no sistema
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-8">Carregando...</div>
          ) : logs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Nenhum log encontrado
            </div>
          ) : (
            <>
              <div className="relative">
                {/* Linha vertical da timeline */}
                <div className="absolute left-6 top-0 bottom-0 w-0.5 bg-border"></div>

                <div className="space-y-6">
                  {logs.map((log, index) => (
                    <div
                      key={log.id}
                      className="relative flex items-start gap-4"
                    >
                      {/* Ponto da timeline */}
                      <div
                        className={`relative z-10 flex h-12 w-12 items-center justify-center rounded-full border-2 ${
                          log.level === "ERROR"
                            ? "border-red-500 bg-red-50"
                            : log.level === "WARNING"
                              ? "border-yellow-500 bg-yellow-50"
                              : "border-blue-500 bg-blue-50"
                        }`}
                      >
                        <div
                          className={`h-3 w-3 rounded-full ${
                            log.level === "ERROR"
                              ? "bg-red-500"
                              : log.level === "WARNING"
                                ? "bg-yellow-500"
                                : "bg-blue-500"
                          }`}
                        ></div>
                      </div>

                      {/* Conteúdo do log */}
                      <div className="flex-1 min-w-0 pb-6">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="font-mono text-sm text-muted-foreground">
                            {formatDate(log.createdAt)}
                          </span>
                          <Badge
                            variant={getLevelBadgeVariant(log.level)}
                            className="text-xs"
                          >
                            {log.level}
                          </Badge>
                          <Badge variant="outline" className="text-xs">
                            {getActionLabel(log.action)}
                          </Badge>
                          {log.resource && (
                            <Badge variant="secondary" className="text-xs">
                              {log.resource}
                            </Badge>
                          )}
                        </div>

                        <div className="space-y-1">
                          <p className="text-sm font-medium">
                            {log.user?.name || log.user?.email || "Sistema"}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {log.message}
                          </p>
                          {log.details && (
                            <details className="text-xs text-muted-foreground">
                              <summary className="cursor-pointer hover:text-foreground">
                                Ver detalhes
                              </summary>
                              <pre className="mt-2 whitespace-pre-wrap bg-muted p-2 rounded text-xs">
                                {JSON.stringify(log.details, null, 2)}
                              </pre>
                            </details>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Paginação Simples */}
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-6 pt-6 border-t">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      currentPage > 1 && handlePageChange(currentPage - 1)
                    }
                    disabled={currentPage <= 1}
                  >
                    <ChevronLeftIcon className="h-4 w-4" />
                    Anterior
                  </Button>

                  <span className="text-sm text-muted-foreground">
                    Página {currentPage} de {totalPages}
                  </span>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      currentPage < totalPages &&
                      handlePageChange(currentPage + 1)
                    }
                    disabled={currentPage >= totalPages}
                  >
                    Próximo
                    <ChevronRightIcon className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
