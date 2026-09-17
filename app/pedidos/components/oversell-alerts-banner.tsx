"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getPlatformLabel } from "../lib/order-badges";

export interface OversellAlert {
  id: string;
  orderId: string;
  externalOrderId: string;
  platform: string;
  accountName: string | null;
  createdAt: string;
  itens: { productId: string; sku: string | null; nome: string }[];
}

/** Por usuário: no mesmo navegador (balcão, suporte) outra empresa não herda. */
export function chaveDaDispensa(email: string | null | undefined): string {
  return `dexo:oversell-dispensado-ate:${email ?? "anonimo"}`;
}

/** Alertas mais novos que o último "dispensar" (compara pelo createdAt). */
export function alertasNaoDispensados(
  alertas: OversellAlert[],
  dispensadoAteIso: string | null,
): OversellAlert[] {
  if (!dispensadoAteIso) return alertas;
  const limite = new Date(dispensadoAteIso).getTime();
  if (Number.isNaN(limite)) return alertas;
  return alertas.filter((a) => new Date(a.createdAt).getTime() > limite);
}

export function tituloDoAviso(n: number): string {
  return n === 1
    ? "1 venda dos últimos 7 dias caiu sobre peça sem estoque."
    : `${n} vendas dos últimos 7 dias caíram sobre peça sem estoque.`;
}

function diaMes(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Sao_Paulo",
  }).format(d);
}

interface Props {
  alertas: OversellAlert[];
  onViewOrder: (orderId: string) => void;
  email: string | null | undefined;
}

/**
 * Venda que caiu sobre peça sem estoque (a baixa pediu mais do que havia).
 *
 * Sem alerta devolve `null` e a tela de Pedidos fica como era. "Dispensar"
 * esconde os alertas atuais neste navegador; um alerta NOVO volta a aparecer.
 */
export function OversellAlertsBanner({ alertas, onViewOrder, email }: Props) {
  const [dispensadoAte, setDispensadoAte] = useState<string | null>(null);

  useEffect(() => {
    try {
      setDispensadoAte(window.localStorage.getItem(chaveDaDispensa(email)));
    } catch {
      setDispensadoAte(null);
    }
  }, [email]);

  const visiveis = useMemo(
    () => alertasNaoDispensados(alertas, dispensadoAte),
    [alertas, dispensadoAte],
  );

  if (!visiveis.length) return null;

  const dispensar = () => {
    const maisNovo = visiveis.reduce(
      (acc, a) => (a.createdAt > acc ? a.createdAt : acc),
      visiveis[0].createdAt,
    );
    try {
      window.localStorage.setItem(chaveDaDispensa(email), maisNovo);
    } catch {
      // Sem armazenamento: some agora e volta no próximo carregamento.
    }
    setDispensadoAte(maisNovo);
  };

  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">{tituloDoAviso(visiveis.length)}</p>
          <p className="text-muted-foreground">
            Confira se a peça existe antes de enviar.
          </p>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8 shrink-0"
          onClick={dispensar}
          aria-label="Dispensar"
          title="Dispensar"
        >
          <X className="size-4" />
        </Button>
      </div>

      <ul className="mt-2 flex flex-col gap-2">
        {visiveis.map((a) => (
          <li
            key={a.id}
            className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/60 px-3 py-2 sm:flex-row sm:items-center"
          >
            <div className="min-w-0 flex-1 text-sm">
              <p className="break-words">
                {diaMes(a.createdAt)} · {getPlatformLabel(a.platform)}{" "}
                <span className="font-mono">#{a.externalOrderId}</span>
              </p>
              {a.itens.map((i) => (
                <p key={i.productId} className="break-words text-muted-foreground">
                  {i.nome}
                  {i.sku ? ` (SKU ${i.sku})` : ""}
                </p>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onViewOrder(a.orderId)}
            >
              Ver pedido
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
