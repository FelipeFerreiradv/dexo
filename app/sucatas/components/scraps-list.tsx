"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Search,
  Plus,
  Pencil,
  Trash2,
  Car,
  ChevronLeft,
  ChevronRight,
  Filter,
} from "lucide-react";
import { useSession } from "next-auth/react";

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
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getApiBaseUrl } from "@/lib/api";
import { CreateScrapDialog } from "./create-scrap-dialog";

type ScrapStatus = "AVAILABLE" | "IN_USE" | "DEPLETED" | "ARCHIVED";

interface Scrap {
  id: string;
  brand: string;
  model: string;
  year?: string;
  version?: string;
  color?: string;
  plate?: string;
  chassis?: string;
  cost?: number;
  paymentMethod?: string;
  locationId?: string;
  locationCode?: string;
  status: ScrapStatus;
  productsCount?: number;
  createdAt: string;
  updatedAt: string;
}

const STATUS_CONFIG: Record<
  ScrapStatus,
  {
    label: string;
    variant: "default" | "secondary" | "destructive" | "outline";
  }
> = {
  AVAILABLE: { label: "Disponível", variant: "default" },
  IN_USE: { label: "Em uso", variant: "secondary" },
  DEPLETED: { label: "Esgotada", variant: "destructive" },
  ARCHIVED: { label: "Arquivada", variant: "outline" },
};

export function ScrapsList() {
  const { data: session } = useSession();
  const [scraps, setScraps] = useState<Scrap[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  // Modal states
  const [createOpen, setCreateOpen] = useState(false);
  const [editScrap, setEditScrap] = useState<Scrap | null>(null);

  const fetchScraps = useCallback(async () => {
    if (!session?.user?.email) return;
    setLoading(true);
    try {
      const apiBase = getApiBaseUrl();
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (statusFilter && statusFilter !== "ALL")
        params.set("status", statusFilter);
      params.set("page", String(page));
      params.set("limit", "10");

      const res = await fetch(`${apiBase}/scraps?${params.toString()}`, {
        headers: { email: session.user.email },
      });
      if (!res.ok) throw new Error("Erro ao buscar sucatas");
      const data = await res.json();
      setScraps(data.scraps || []);
      setTotal(data.pagination?.total || 0);
      setTotalPages(data.pagination?.totalPages || 1);
    } catch (error) {
      console.error("Erro ao buscar sucatas:", error);
      setScraps([]);
    } finally {
      setLoading(false);
    }
  }, [session?.user?.email, search, statusFilter, page]);

  useEffect(() => {
    fetchScraps();
  }, [fetchScraps]);

  // Debounce search
  useEffect(() => {
    const id = setTimeout(() => setPage(1), 300);
    return () => clearTimeout(id);
  }, [search, statusFilter]);

  const handleDelete = async (id: string) => {
    if (!session?.user?.email) return;
    try {
      const apiBase = getApiBaseUrl();
      const res = await fetch(`${apiBase}/scraps/${id}`, {
        method: "DELETE",
        headers: { email: session.user.email },
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Erro ao excluir sucata");
        return;
      }
      fetchScraps();
    } catch (error) {
      console.error("Erro ao excluir sucata:", error);
    }
  };

  const formatCost = (value?: number) => {
    if (value === undefined || value === null) return "—";
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(value);
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-lg">Sucatas cadastradas</CardTitle>
              <CardDescription>
                {total} sucata{total !== 1 ? "s" : ""} encontrada
                {total !== 1 ? "s" : ""}
              </CardDescription>
            </div>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Nova Sucata
            </Button>
          </div>

          <div className="flex flex-col gap-3 pt-2 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Buscar por marca, modelo, placa, chassi ou lote..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-[180px]">
                <Filter className="mr-2 h-4 w-4" />
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Todos os status</SelectItem>
                <SelectItem value="AVAILABLE">Disponível</SelectItem>
                <SelectItem value="IN_USE">Em uso</SelectItem>
                <SelectItem value="DEPLETED">Esgotada</SelectItem>
                <SelectItem value="ARCHIVED">Arquivada</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>

        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-sm text-muted-foreground">
                Carregando sucatas...
              </div>
            </div>
          ) : scraps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Car className="mb-4 h-12 w-12 text-muted-foreground/50" />
              <h3 className="text-lg font-medium">Nenhuma sucata encontrada</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {search || statusFilter !== "ALL"
                  ? "Tente alterar os filtros de busca."
                  : "Cadastre sua primeira sucata para começar."}
              </p>
              {!search && statusFilter === "ALL" && (
                <Button className="mt-4" onClick={() => setCreateOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Cadastrar sucata
                </Button>
              )}
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Veículo</TableHead>
                      <TableHead>Placa</TableHead>
                      <TableHead>Custo</TableHead>
                      <TableHead>Localização</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-center">Produtos</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {scraps.map((scrap) => {
                      const statusConf = STATUS_CONFIG[scrap.status];
                      return (
                        <TableRow key={scrap.id}>
                          <TableCell>
                            <div>
                              <div className="font-medium">
                                {scrap.brand} {scrap.model}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {[scrap.year, scrap.version, scrap.color]
                                  .filter(Boolean)
                                  .join(" · ") || "—"}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            {scrap.plate ? (
                              <Badge variant="outline" className="font-mono">
                                {scrap.plate}
                              </Badge>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                          <TableCell>{formatCost(scrap.cost)}</TableCell>
                          <TableCell>{scrap.locationCode || "—"}</TableCell>
                          <TableCell>
                            <Badge variant={statusConf.variant}>
                              {statusConf.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-center">
                            {scrap.productsCount ?? 0}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setEditScrap(scrap)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button variant="ghost" size="icon">
                                    <Trash2 className="h-4 w-4 text-destructive" />
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>
                                      Excluir sucata
                                    </AlertDialogTitle>
                                    <AlertDialogDescription>
                                      Tem certeza que deseja excluir a sucata{" "}
                                      <strong>
                                        {scrap.brand} {scrap.model}
                                      </strong>
                                      ? Produtos vinculados serão desvinculados
                                      automaticamente.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>
                                      Cancelar
                                    </AlertDialogCancel>
                                    <AlertDialogAction
                                      onClick={() => handleDelete(scrap.id)}
                                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                    >
                                      Excluir
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile cards */}
              <div className="grid gap-3 md:hidden">
                {scraps.map((scrap) => {
                  const statusConf = STATUS_CONFIG[scrap.status];
                  return (
                    <div
                      key={scrap.id}
                      className="rounded-lg border p-4 space-y-2"
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="font-medium">
                            {scrap.brand} {scrap.model}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {[scrap.year, scrap.version, scrap.color]
                              .filter(Boolean)
                              .join(" · ") || "—"}
                          </div>
                        </div>
                        <Badge variant={statusConf.variant}>
                          {statusConf.label}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-4 text-sm text-muted-foreground">
                        {scrap.plate && (
                          <span className="font-mono">{scrap.plate}</span>
                        )}
                        <span>{formatCost(scrap.cost)}</span>
                        <span>{scrap.productsCount ?? 0} produto(s)</span>
                      </div>
                      <div className="flex items-center justify-end gap-1 pt-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditScrap(scrap)}
                        >
                          <Pencil className="mr-1 h-3 w-3" />
                          Editar
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="sm">
                              <Trash2 className="mr-1 h-3 w-3 text-destructive" />
                              Excluir
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                Excluir sucata
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                Tem certeza que deseja excluir a sucata{" "}
                                <strong>
                                  {scrap.brand} {scrap.model}
                                </strong>
                                ?
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancelar</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleDelete(scrap.id)}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                Excluir
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-4">
                  <div className="text-sm text-muted-foreground">
                    Página {page} de {totalPages}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page <= 1}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setPage((p) => Math.min(totalPages, p + 1))
                      }
                      disabled={page >= totalPages}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <CreateScrapDialog
        open={createOpen || !!editScrap}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
            setEditScrap(null);
          }
        }}
        editData={editScrap}
        onSuccess={() => {
          setCreateOpen(false);
          setEditScrap(null);
          fetchScraps();
        }}
      />
    </>
  );
}
