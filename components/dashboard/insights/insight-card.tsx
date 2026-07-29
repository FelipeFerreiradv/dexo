"use client";

import type { ReactNode } from "react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { REPORT_PRESETS, type ReportPresetId } from "@/lib/report-period";

/**
 * Casca compartilhada dos cards de insight: cabeçalho, filtro de período
 * próprio e os estados de carregando / erro / vazio. O conteúdo (o gráfico em
 * si) entra como children — assim cada card cuida só do seu recharts.
 */
export interface InsightCardProps {
  eyebrow: string;
  title: string;
  /** Linha de contexto — usar para dizer QUAL número o card mede. */
  description?: string;
  /** Chips de resumo (total, nº de pedidos...) à direita do título. */
  chips?: ReactNode;
  /** Filtro extra do card (ex.: plataforma), ao lado do seletor de período. */
  filters?: ReactNode;
  preset: ReportPresetId;
  onPresetChange: (p: ReportPresetId) => void;
  customStart: string;
  onCustomStartChange: (v: string) => void;
  customEnd: string;
  onCustomEndChange: (v: string) => void;
  loading: boolean;
  error: boolean;
  incomplete: boolean;
  empty: boolean;
  emptyLabel?: string;
  children: ReactNode;
}

export function InsightCard({
  eyebrow,
  title,
  description,
  chips,
  filters,
  preset,
  onPresetChange,
  customStart,
  onCustomStartChange,
  customEnd,
  onCustomEndChange,
  loading,
  error,
  incomplete,
  empty,
  emptyLabel = "Sem movimento no período selecionado",
  children,
}: InsightCardProps) {
  return (
    <Card className="h-full rounded-2xl border border-border/60 bg-card/90 shadow-[0_18px_60px_color-mix(in_srgb,var(--color-shadow-color)_10%,transparent)]">
      <CardHeader className="gap-3 px-5 pb-3 pt-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              {eyebrow}
            </p>
            <p className="text-sm font-semibold text-foreground">{title}</p>
            {description ? (
              <p className="text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {chips ? (
            <div className="flex flex-wrap gap-2 text-xs">{chips}</div>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Select
            value={preset}
            onValueChange={(v) => onPresetChange(v as ReportPresetId)}
          >
            <SelectTrigger
              className="h-8 w-full text-xs sm:w-[150px]"
              aria-label="Período"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPORT_PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {preset === "custom" ? (
            <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
              <Input
                type="date"
                aria-label="Data inicial"
                value={customStart}
                max={customEnd || undefined}
                onChange={(e) => onCustomStartChange(e.target.value)}
                className="h-8 text-xs sm:w-[140px]"
              />
              <Input
                type="date"
                aria-label="Data final"
                value={customEnd}
                min={customStart || undefined}
                onChange={(e) => onCustomEndChange(e.target.value)}
                className="h-8 text-xs sm:w-[140px]"
              />
            </div>
          ) : null}

          {filters}
        </div>
      </CardHeader>

      <CardContent className="px-4 pb-5">
        {incomplete ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Escolha as datas inicial e final.
          </div>
        ) : loading ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-[220px] w-full rounded-xl" />
          </div>
        ) : error ? (
          <div className="py-12 text-center text-sm text-destructive">
            Não foi possível carregar. Tente novamente.
          </div>
        ) : empty ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {emptyLabel}
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

/** Chip de resumo do cabeçalho (mesmo visual dos chips de listings-overview). */
export function InsightChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/30 px-3 py-1 font-semibold text-foreground">
      {children}
    </span>
  );
}
