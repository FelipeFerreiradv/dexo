"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getPlatformLabel, platformBadgeClassName } from "../lib/order-badges";

export interface IngestionIssue {
  id: string;
  platform: string;
  externalOrderId: string;
  reason: string;
  /** Motivo em português claro, montado no backend. */
  motivo: string;
  detail: string | null;
  attempts: number;
  accountName: string | null;
  createdAt: string;
}

interface Props {
  issues: IngestionIssue[];
  onRetry: (id: string) => Promise<void>;
  retryingId: string | null;
}

/**
 * Aviso de "Pendências de importação".
 *
 * Aditivo por construção: sem pendência o componente devolve `null` e a tela
 * de Pedidos fica exatamente como era — sem badge, sem aba, sem mudança de
 * layout. Ele só aparece quando existe uma venda que o Dexo não conseguiu
 * transformar em pedido, que é justamente o caso que antes sumia em silêncio.
 *
 * O visual reaproveita o mesmo padrão da barra de ações em massa que já existe
 * logo abaixo (borda suave + fundo `muted`), para não introduzir vocabulário
 * visual novo.
 */
export function IngestionIssuesBanner({ issues, onRetry, retryingId }: Props) {
  const [aberto, setAberto] = useState(false);

  if (!issues.length) return null;

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="size-4 shrink-0 text-amber-600" />
        <span className="text-sm font-medium">
          {issues.length === 1
            ? "1 venda não virou pedido automaticamente"
            : `${issues.length} vendas não viraram pedido automaticamente`}
        </span>
        <span className="text-sm text-muted-foreground">
          — o estoque dessas vendas ainda não foi baixado.
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => setAberto((v) => !v)}
          aria-expanded={aberto}
        >
          {aberto ? (
            <>
              Ocultar <ChevronUp className="ml-1 size-4" />
            </>
          ) : (
            <>
              Ver detalhes <ChevronDown className="ml-1 size-4" />
            </>
          )}
        </Button>
      </div>

      {aberto ? (
        <ul className="mt-3 flex flex-col gap-2">
          {issues.map((issue) => (
            <li
              key={issue.id}
              className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/60 px-3 py-2 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="outline"
                    className={platformBadgeClassName(issue.platform)}
                  >
                    {getPlatformLabel(issue.platform)}
                  </Badge>
                  <span className="font-mono text-sm">
                    {issue.externalOrderId}
                  </span>
                  {issue.accountName ? (
                    <span className="text-xs text-muted-foreground">
                      {issue.accountName}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {issue.motivo}
                </p>
                {issue.detail ? (
                  <p className="mt-0.5 break-words text-xs text-muted-foreground/80">
                    {issue.detail}
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={retryingId === issue.id}
                onClick={() => onRetry(issue.id)}
              >
                <RefreshCw
                  className={`mr-1 size-4 ${
                    retryingId === issue.id ? "animate-spin" : ""
                  }`}
                />
                {retryingId === issue.id ? "Tentando..." : "Tentar novamente"}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
