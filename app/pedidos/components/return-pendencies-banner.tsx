"use client";

import { useState } from "react";
import { PackageX, ChevronDown, ChevronUp, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getPlatformLabel, platformBadgeClassName } from "../lib/order-badges";

export interface ReturnPendency {
  id: string;
  platform: string;
  externalOrderId: string;
  reason: string;
  /** Motivo em português claro, montado no backend. */
  motivo: string;
  detail: string | null;
  /** `true` quando o marketplace parou de dar informação nova. */
  precisaAcao?: boolean;
  accountName: string | null;
  createdAt: string;
}

interface Props {
  pendencies: ReturnPendency[];
  onResolve: (id: string, outcome: "RECEBIDA" | "NAO_RECEBIDA") => Promise<void>;
  resolvingId: string | null;
}

/**
 * Aviso de "Devoluções a confirmar".
 *
 * A pergunta que o sistema não sabia fazer: quando o marketplace encerra uma
 * venda como devolução, a peça pode estar com o comprador, em trânsito de
 * volta, ou extraviada — e antes o Dexo devolvia a unidade ao estoque em todos
 * os casos, reabrindo o anúncio de uma peça que a loja não tem. Agora o estoque
 * fica parado aqui até alguém dizer onde a peça está.
 *
 * Aditivo por construção: sem pendência o componente devolve `null` e a tela de
 * Pedidos fica exatamente como era. Reaproveita o vocabulário visual do irmão
 * (`IngestionIssuesBanner`) para não introduzir padrão novo — muda só a cor,
 * porque a AÇÃO é diferente: ali é "tentar de novo", aqui é uma decisão sobre
 * uma peça física, e ela mexe em estoque.
 */
export function ReturnPendenciesBanner({
  pendencies,
  onResolve,
  resolvingId,
}: Props) {
  const [aberto, setAberto] = useState(false);

  if (!pendencies.length) return null;

  return (
    <div className="rounded-lg border border-sky-500/40 bg-sky-500/5 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <PackageX className="size-4 shrink-0 text-sky-600" />
        <span className="text-sm font-medium">
          {pendencies.length === 1
            ? "1 peça em devolução aguardando confirmação"
            : `${pendencies.length} peças em devolução aguardando confirmação`}
        </span>
        <span className="text-sm text-muted-foreground">
          — o estoque delas continua baixado até você confirmar o recebimento.
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
          {pendencies.map((p) => (
            <li
              key={p.id}
              className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/60 px-3 py-2 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="outline"
                    className={platformBadgeClassName(p.platform)}
                  >
                    {getPlatformLabel(p.platform)}
                  </Badge>
                  <span className="font-mono text-sm">{p.externalOrderId}</span>
                  {p.accountName ? (
                    <span className="text-xs text-muted-foreground">
                      {p.accountName}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {p.motivo}
                  {p.precisaAcao ? (
                    <span className="ml-1 font-medium">
                      O marketplace não tem mais novidade sobre esta devolução.
                    </span>
                  ) : null}
                </p>
                {p.detail ? (
                  <p className="mt-0.5 break-words text-xs text-muted-foreground/80">
                    {p.detail}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={resolvingId === p.id}
                  onClick={() => onResolve(p.id, "RECEBIDA")}
                >
                  <Check className="mr-1 size-4" />
                  A peça voltou
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={resolvingId === p.id}
                  onClick={() => onResolve(p.id, "NAO_RECEBIDA")}
                >
                  <X className="mr-1 size-4" />
                  Não voltou
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
