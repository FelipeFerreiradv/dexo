"use client";

import * as React from "react";

import { getApiBaseUrl } from "@/lib/api";

/**
 * O que o Bitz PODE FAZER neste servidor: gravar voz e anexar arquivo.
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
 * Falha é FECHADA: sem resposta, `audio` fica `false` e `anexos` fica vazio —
 * nem microfone nem clipe aparecem. Melhor não oferecer do que oferecer um botão
 * que erra.
 *
 * ⭐ `anexos` é a lista de EXTENSÕES, e vem do servidor. Ele é quem sabe se há
 * modelo de visão configurado: `.xml` sempre cabe (ler NF-e não depende de
 * provedor), a foto só quando alguém puder enxergá-la. Uma lista chumbada aqui
 * divergiria da realidade no dia em que o cliente trocasse a rota de imagem, e o
 * lojista escolheria uma foto para receber erro.
 */
export interface BitzCapacidades {
  audio: boolean;
  /** Extensões aceitas pelo clipe (`[".jpg", ".png", …]`). Vazio ⇒ sem clipe. */
  anexos: string[];
  /**
   * O botão "o que eu sei da sua loja" deve aparecer? (Fase 11)
   *
   * ⭐ Só para o ADMINISTRADOR, e quem decide é o SERVIDOR — a mesma regra do
   * microfone e do clipe. Esconder no cliente nunca foi permissão: as rotas
   * `/ai/memorias` conferem `isAdmin` por conta própria e respondem 403 para
   * quem não é, independentemente do que este campo diga.
   */
  memorias: boolean;
}

const NENHUMA: BitzCapacidades = {
  audio: false,
  anexos: [],
  memorias: false,
};

let cache: BitzCapacidades | null = null;
let emVoo: Promise<void> | null = null;

/** Só para teste: esquece o que foi respondido nesta página. */
export function __resetCapacidadesCache() {
  cache = null;
  emVoo = null;
}

export function useBitzCapacidades(ativo: boolean): BitzCapacidades {
  const [capacidades, setCapacidades] = React.useState(cache ?? NENHUMA);

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
        cache = {
          audio: Boolean(data?.audio),
          // Só string, e só o que parece extensão. O `accept` do seletor de
          // arquivo é montado com isto, e lixo ali faz o navegador ignorar a
          // lista INTEIRA — o lojista veria "todos os arquivos".
          anexos: Array.isArray(data?.anexos)
            ? data.anexos.filter(
                (e: unknown): e is string =>
                  typeof e === "string" && /^\.[a-z0-9]{1,8}$/i.test(e),
              )
            : [],
          memorias: Boolean(data?.memorias),
        };
      } catch {
        // Falha fechada: segue sem microfone e sem clipe, e o chat continua.
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
