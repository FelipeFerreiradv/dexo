"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Session } from "next-auth";
import { AlertTriangle, CircleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  MAX_DESCONECTADAS_NA_FAIXA,
  dispensaCobre,
  ehDaPaginaAtual,
  mensagemDaConta,
  resumoDasOcultas,
  rotaDaIntegracao,
  type AccountHealthProblem,
} from "@/app/lib/account-health-messages";
import { useAccountHealth } from "./use-account-health";

const CHAVE_DISPENSA = "dexo:conta-desconectada-dispensada:";

/** Quantos anúncios à venda havia quando o aviso foi dispensado. */
function lerDispensa(id: string): string | null {
  try {
    return window.localStorage.getItem(CHAVE_DISPENSA + id);
  } catch {
    return null;
  }
}

function gravarDispensa(id: string, anuncios: number) {
  try {
    window.localStorage.setItem(CHAVE_DISPENSA + id, String(anuncios));
  } catch {
    // Sem armazenamento (aba anônima, bloqueio): o aviso só volta a aparecer.
  }
}

/**
 * Faixa no topo da aplicação para conta de marketplace com problema.
 *
 * Sem conta com problema devolve `null` e o layout fica idêntico.
 * - PARADA: sempre aparece, não se dispensa (não importa pedido).
 * - DESCONECTADA: se dispensa até a situação piorar (mais anúncios à venda);
 *   no máximo 2 na faixa, o resto vira "e mais N" com link para Integrações —
 *   há empresa com 6 contas nessa situação, e empilhar tudo empurraria a tela
 *   de trabalho para baixo da dobra em toda página.
 * - Na página de integração de uma plataforma, as contas DELA saem da faixa (o
 *   bloco da aba já avisa); as de outras plataformas continuam.
 */
export function AccountHealthBanner({ session }: { session: Session | null }) {
  const email = session?.user?.email ?? null;
  const colaborador = Boolean((session?.user as any)?.parentUserId);
  const pathname = usePathname();
  const contas = useAccountHealth(email, { acompanhar: true });
  // Dispensadas NESTA sessão; as de sessões anteriores vêm do localStorage.
  const [dispensadasAgora, setDispensadasAgora] = useState<Map<string, number>>(
    new Map(),
  );

  const { paradas, desconectadas, ocultas, rotaDasOcultas } = useMemo(() => {
    const dispensada = (c: AccountHealthProblem) => {
      if (c.tipo !== "desconectada") return false;
      const agora = dispensadasAgora.get(c.id);
      const registro = agora != null ? String(agora) : lerDispensa(c.id);
      return dispensaCobre(registro, c.anunciosAVenda);
    };
    const visiveis = contas.filter(
      (c) => !ehDaPaginaAtual(c.platform, pathname) && !dispensada(c),
    );
    const todasDesconectadas = visiveis.filter((c) => c.tipo === "desconectada");
    return {
      paradas: visiveis.filter((c) => c.tipo === "parada"),
      desconectadas: todasDesconectadas.slice(0, MAX_DESCONECTADAS_NA_FAIXA),
      ocultas: Math.max(0, todasDesconectadas.length - MAX_DESCONECTADAS_NA_FAIXA),
      // Não existe página /integracoes: o link leva à integração da primeira
      // conta resumida.
      rotaDasOcultas: rotaDaIntegracao(
        todasDesconectadas[MAX_DESCONECTADAS_NA_FAIXA]?.platform ?? "",
      ),
    };
  }, [contas, dispensadasAgora, pathname]);

  if (!paradas.length && !desconectadas.length) return null;

  const dispensar = (c: AccountHealthProblem) => {
    gravarDispensa(c.id, c.anunciosAVenda);
    setDispensadasAgora((prev) => new Map(prev).set(c.id, c.anunciosAVenda));
  };

  return (
    <div className="flex flex-col gap-2 px-4 pt-4 md:px-6">
      {paradas.map((c) => (
        <LinhaDeConta key={c.id} conta={c} colaborador={colaborador} />
      ))}
      {desconectadas.map((c) => (
        <LinhaDeConta
          key={c.id}
          conta={c}
          colaborador={colaborador}
          onDispensar={() => dispensar(c)}
        />
      ))}
      {ocultas > 0 ? (
        <p className="px-1 text-sm text-muted-foreground">
          {resumoDasOcultas(ocultas)}{" "}
          <Link href={rotaDasOcultas} className="font-medium underline underline-offset-2">
            Ver contas
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function LinhaDeConta({
  conta,
  colaborador,
  onDispensar,
}: {
  conta: AccountHealthProblem;
  colaborador: boolean;
  onDispensar?: () => void;
}) {
  const msg = mensagemDaConta(conta, { colaborador });
  const parada = conta.tipo === "parada";

  return (
    <div
      role={parada ? "alert" : "status"}
      className={
        parada
          ? "flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 sm:flex-row sm:items-center"
          : "flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 sm:flex-row sm:items-center"
      }
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        {parada ? (
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
        ) : (
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
        )}
        <div className="min-w-0 text-sm">
          <p className="font-medium break-words">{msg.titulo}</p>
          {msg.detalhe ? (
            <p className="text-muted-foreground break-words">{msg.detalhe}</p>
          ) : null}
          {msg.acao?.tipo === "texto" ? (
            <p className="text-muted-foreground break-words">{msg.acao.texto}</p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 self-end sm:self-center">
        {msg.acao?.tipo === "link" ? (
          <Button asChild size="sm" variant={parada ? "destructive" : "outline"}>
            <Link href={msg.acao.href}>{msg.acao.rotulo}</Link>
          </Button>
        ) : null}
        {onDispensar ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={onDispensar}
            aria-label="Dispensar aviso"
            title="Dispensar (volta se houver mais anúncios à venda)"
          >
            <X className="size-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
