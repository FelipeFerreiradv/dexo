"use client";

import * as React from "react";

import { getApiBaseUrl } from "@/lib/api";
import {
  avaliar,
  dispensar,
  SEM_ALERTA,
  type ContagemDeAlertas,
} from "@/components/bitz/bitz-alerta-catraca";

/**
 * O que está quebrado na operação agora — os números que acendem o badge.
 *
 * ⚠️ ESTE HOOK RODA COM O PAINEL FECHADO, em toda página, e é a única coisa do
 * Bitz que faz isso além da sonda de entitlement. Duas defesas contra virar
 * gordura de egress:
 *
 *  1. CACHE COM VALIDADE, module-level. O `use-bitz-capacidades` guarda para
 *     sempre porque a capacidade do servidor não muda; aqui muda, então a marca
 *     do tempo entra. Cinco minutos: teto de UMA consulta por aba a cada cinco
 *     minutos, por mais que o lojista navegue.
 *  2. A rota é DUAS CONTAGENS, sem uma linha de dado (0,3 ms de banco medidos na
 *     loja com mais pendências).
 *
 * Falha é FECHADA: sem resposta, nenhum badge. Um ponto vermelho que aparece
 * porque a rede oscilou é pior que ponto nenhum.
 */

const VALIDADE_MS = 5 * 60 * 1000;

let cache: { em: number; dados: ContagemDeAlertas } | null = null;
let emVoo: Promise<void> | null = null;

/** Só para teste: esquece o que foi respondido nesta página. */
export function __resetAlertasCache() {
  cache = null;
  emVoo = null;
}

export interface BitzAlertas {
  /** Vale interromper? Já passou pela catraca de dispensa. */
  avisar: boolean;
  /** Os números crus, para o texto do aviso. */
  contagem: ContagemDeAlertas;
  /** O usuário viu. Some agora e só volta se algum número subir. */
  marcarVisto: () => void;
}

export function useBitzAlertas(
  ativo: boolean,
  usuarioId: string,
): BitzAlertas {
  const [contagem, setContagem] = React.useState<ContagemDeAlertas>(
    cache?.dados ?? SEM_ALERTA,
  );
  const [avisar, setAvisar] = React.useState(false);

  React.useEffect(() => {
    if (!ativo || !usuarioId) return;

    let vivo = true;

    const aplicar = (dados: ContagemDeAlertas) => {
      if (!vivo) return;
      setContagem(dados);
      setAvisar(avaliar(usuarioId, dados));
    };

    if (cache && Date.now() - cache.em < VALIDADE_MS) {
      aplicar(cache.dados);
      return () => {
        vivo = false;
      };
    }

    // Duas montagens rápidas (navegação) não podem virar duas requisições.
    emVoo ??= (async () => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/ai/alertas`);
        if (!res.ok) return;
        const d = await res.json();
        // `null` é a resposta do servidor para "este ator não vê esta página",
        // e vira zero aqui: o badge não pode contar o que a pessoa não abre.
        cache = {
          em: Date.now(),
          dados: {
            pedidosTravados: numero(d?.pedidosTravados),
            contasCaidas: numero(d?.contasCaidas),
          },
        };
      } catch {
        // Falha fechada: segue sem badge.
      } finally {
        emVoo = null;
      }
    })();

    void emVoo.then(() => {
      if (cache) aplicar(cache.dados);
    });

    return () => {
      vivo = false;
    };
  }, [ativo, usuarioId]);

  const marcarVisto = React.useCallback(() => {
    dispensar(usuarioId, contagem);
    setAvisar(false);
  }, [usuarioId, contagem]);

  return { avisar, contagem, marcarVisto };
}

function numero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0
    ? Math.trunc(v)
    : 0;
}
