"use client";

import * as React from "react";

import { getApiBaseUrl } from "@/lib/api";

/**
 * O que o Bitz PODE FAZER neste servidor — hoje, só `audio`.
 *
 * ⭐ POR QUE NÃO ENTROU NO `/ai/entitlement`. Aquela sonda roda em TODA página,
 * para todo usuário, só para decidir se o mascote aparece. Esta informação só
 * interessa a quem ABRIU o chat, e mandá-la junto seria bytes a mais em toda
 * navegação para nada — exatamente o tipo de gordura que a auditoria de egress
 * da casa existe para impedir.
 *
 * ⚠️ UMA CONSULTA POR CARREGAMENTO DE PÁGINA, no máximo. O cache é
 * module-level de propósito: o painel abre e fecha dezenas de vezes por dia, e
 * a capacidade do servidor não muda entre um clique e outro. Um `useState` por
 * instância refaria a chamada a cada abertura.
 *
 * Falha é FECHADA: sem resposta, `audio` fica `false` e o microfone não
 * aparece. Melhor não oferecer do que oferecer um botão que erra.
 */
let cache: { audio: boolean } | null = null;
let emVoo: Promise<void> | null = null;

/** Só para teste: esquece o que foi respondido nesta página. */
export function __resetCapacidadesCache() {
  cache = null;
  emVoo = null;
}

export function useBitzCapacidades(ativo: boolean) {
  const [capacidades, setCapacidades] = React.useState(cache ?? { audio: false });

  React.useEffect(() => {
    // Só busca quando o painel está aberto — antes disso ninguém precisa.
    if (!ativo) return;
    if (cache) {
      setCapacidades(cache);
      return;
    }

    let vivo = true;

    // Duas aberturas rápidas não podem virar duas requisições.
    emVoo ??= (async () => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/ai/capacidades`);
        if (!res.ok) return;
        const data = await res.json();
        cache = { audio: Boolean(data?.audio) };
      } catch {
        // Falha fechada: segue sem microfone, e o chat inteiro continua.
      } finally {
        emVoo = null;
      }
    })();

    void emVoo.then(() => {
      if (vivo && cache) setCapacidades(cache);
    });

    return () => {
      vivo = false;
    };
  }, [ativo]);

  return capacidades;
}
