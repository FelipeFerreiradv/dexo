"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Plus,
  Pencil,
  Loader2,
  ArrowRightLeft,
  RefreshCw,
  Car,
} from "lucide-react";
import { useSession } from "next-auth/react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { getApiBaseUrl } from "@/lib/api";
import { CreateScrapDialog } from "./create-scrap-dialog";
import {
  LOGISTICS_ORDER,
  LOGISTICS_CONFIG,
  type LogisticsStatus,
} from "../lib/logistics";

interface PipelineScrap {
  id: string;
  brand: string;
  model: string;
  year?: string;
  version?: string;
  color?: string;
  plate?: string;
  logisticsStatus: LogisticsStatus;
  productsCount?: number;
  // Demais campos (cost, fiscais, imageUrls...) vêm no objeto e são usados
  // pelo CreateScrapDialog ao editar.
  [key: string]: unknown;
}

interface PipelineStage {
  count: number;
  scraps: PipelineScrap[];
}

type PipelineData = Record<LogisticsStatus, PipelineStage>;

export function ScrapsPipeline() {
  const { data: session } = useSession();
  const email = session?.user?.email;

  const [data, setData] = useState<PipelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editScrap, setEditScrap] = useState<PipelineScrap | null>(null);

  // Os cards do Kanban vêm enxutos (sem fotos/notas/fiscais). Para editar,
  // recarrega o registro COMPLETO via GET /scraps/:id — senão salvar apagaria
  // imageUrls e os campos não exibidos. Só abre o modal após carregar.
  const openEdit = async (scrap: PipelineScrap) => {
    if (!email) return;
    try {
      const res = await fetch(`${getApiBaseUrl()}/scraps/${scrap.id}`, {
        headers: { email },
      });
      if (!res.ok) throw new Error("Erro ao carregar sucata");
      const full = await res.json();
      setEditScrap(full);
    } catch (error) {
      console.error("Erro ao carregar sucata para edição:", error);
      alert("Não foi possível carregar a sucata para edição. Tente novamente.");
    }
  };

  const fetchPipeline = useCallback(async () => {
    if (!email) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBaseUrl()}/scraps/pipeline`, {
        headers: { email },
      });
      if (!res.ok) throw new Error("Erro ao carregar o pipeline");
      const json = await res.json();
      setData(json.stages as PipelineData);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Erro ao carregar o pipeline",
      );
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [email]);

  useEffect(() => {
    fetchPipeline();
  }, [fetchPipeline]);

  const handleMove = async (id: string, target: LogisticsStatus) => {
    if (!email) return;
    setMovingId(id);
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/scraps/${id}/logistics-status`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", email },
          body: JSON.stringify({ logisticsStatus: target }),
        },
      );
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        alert(e.error || "Erro ao mover a sucata");
        return;
      }
      await fetchPipeline();
    } catch {
      alert("Erro de conexão ao mover a sucata");
    } finally {
      setMovingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Acompanhe onde cada veículo está no fluxo do pátio.
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchPipeline}
            disabled={loading}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`}
            />
            Atualizar
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Nova Sucata
          </Button>
        </div>
      </div>

      {error ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-destructive/40 bg-destructive/5 py-12 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={fetchPipeline}
          >
            Tentar novamente
          </Button>
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {LOGISTICS_ORDER.map((stage) => {
            const conf = LOGISTICS_CONFIG[stage];
            const StageIcon = conf.icon;
            const col = data?.[stage];
            return (
              <div
                key={stage}
                className="flex min-w-[280px] max-w-[340px] flex-1 flex-col rounded-lg border bg-muted/30"
              >
                <div className="flex items-center gap-2 border-b px-3 py-2.5">
                  <span
                    className={`flex h-7 w-7 items-center justify-center rounded-md ${conf.badgeClass}`}
                  >
                    <StageIcon className="h-4 w-4" />
                  </span>
                  <div className="flex-1">
                    <div className="text-sm font-semibold leading-tight">
                      {conf.label}
                    </div>
                    <div className="text-[11px] leading-tight text-muted-foreground">
                      {conf.description}
                    </div>
                  </div>
                  <Badge variant="secondary" className="tabular-nums">
                    {loading ? "…" : (col?.count ?? 0)}
                  </Badge>
                </div>

                <div className="flex-1 space-y-2 p-2">
                  {loading ? (
                    <>
                      <Skeleton className="h-24 w-full rounded-md" />
                      <Skeleton className="h-24 w-full rounded-md" />
                    </>
                  ) : !col || col.scraps.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-center text-xs text-muted-foreground">
                      <Car className="mb-2 h-6 w-6 text-muted-foreground/40" />
                      Nenhuma sucata
                    </div>
                  ) : (
                    <>
                      {col.scraps.map((scrap) => (
                        <PipelineCard
                          key={scrap.id}
                          scrap={scrap}
                          moving={movingId === scrap.id}
                          onEdit={() => openEdit(scrap)}
                          onMove={handleMove}
                        />
                      ))}
                      {col.count > col.scraps.length && (
                        <div className="px-1 pt-1 text-center text-[11px] text-muted-foreground">
                          Mostrando {col.scraps.length} de {col.count}. Veja
                          todas na aba Lista.
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

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
          fetchPipeline();
        }}
      />
    </div>
  );
}

function PipelineCard({
  scrap,
  moving,
  onEdit,
  onMove,
}: {
  scrap: PipelineScrap;
  moving: boolean;
  onEdit: () => void;
  onMove: (id: string, target: LogisticsStatus) => void;
}) {
  const subtitle = [scrap.year, scrap.version, scrap.color]
    .filter(Boolean)
    .join(" · ");
  const targets = LOGISTICS_ORDER.filter((s) => s !== scrap.logisticsStatus);

  return (
    <div className="rounded-md border bg-card p-3 shadow-sm">
      <Link
        href={`/sucatas/${scrap.id}`}
        className="text-sm font-medium leading-tight hover:underline"
      >
        {scrap.brand} {scrap.model}
      </Link>
      {subtitle && (
        <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {scrap.plate && (
          <Badge variant="outline" className="font-mono text-[11px]">
            {scrap.plate}
          </Badge>
        )}
        <span className="text-[11px] text-muted-foreground">
          {scrap.productsCount ?? 0} peça(s)
        </span>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onEdit}
        >
          <Pencil className="mr-1 h-3 w-3" />
          Editar
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={moving}
            >
              {moving ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <ArrowRightLeft className="mr-1 h-3 w-3" />
              )}
              Mover
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Mover para</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {targets.map((t) => {
              const TIcon = LOGISTICS_CONFIG[t].icon;
              return (
                <DropdownMenuItem
                  key={t}
                  onSelect={() => onMove(scrap.id, t)}
                >
                  <TIcon className="mr-2 h-4 w-4" />
                  {LOGISTICS_CONFIG[t].label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
