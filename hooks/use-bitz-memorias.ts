"use client";

import * as React from "react";

import { getApiBaseUrl } from "@/lib/api";

/**
 * A memória da loja, para a tela "o que eu sei da sua loja". Fase 11.
 *
 * ⚠️ SEM CACHE DE MÓDULO, ao contrário de `use-bitz-capacidades`. A diferença é
 * o que cada um guarda: capacidade de servidor não muda entre dois cliques;
 * memória muda o tempo todo — o próprio lojista acabou de ensinar uma no chat ao
 * lado. Uma lista cacheada mostraria a loja de cinco minutos atrás e o botão de
 * apagar agiria sobre uma linha que talvez nem esteja mais ali.
 *
 * Aqui NÃO existe edição, só criar (pelo chat, com confirmação) e apagar. Regra
 * que mudou é memória nova; editar no lugar apagaria em silêncio o texto que
 * alguém leu e confirmou.
 */
export interface BitzMemoria {
  id: string;
  topico: string;
  topicoLabel: string;
  conteudo: string;
  createdAt: string;
}

type Estado = "ocioso" | "carregando" | "pronto" | "erro";

export function useBitzMemorias(ativo: boolean) {
  const [memorias, setMemorias] = React.useState<BitzMemoria[]>([]);
  const [estado, setEstado] = React.useState<Estado>("ocioso");
  const [erro, setErro] = React.useState<string | null>(null);
  /** Ids em processo de exclusão — o botão some enquanto a resposta não volta. */
  const [apagando, setApagando] = React.useState<string[]>([]);

  const carregar = React.useCallback(async () => {
    setEstado("carregando");
    setErro(null);
    try {
      const res = await fetch(`${getApiBaseUrl()}/ai/memorias`);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setErro(
          typeof data?.error === "string"
            ? data.error
            : "Não consegui carregar a memória agora.",
        );
        setEstado("erro");
        return;
      }
      setMemorias(Array.isArray(data?.memorias) ? data.memorias : []);
      setEstado("pronto");
    } catch {
      setErro("Não consegui carregar a memória agora.");
      setEstado("erro");
    }
  }, []);

  React.useEffect(() => {
    if (!ativo) return;
    void carregar();
  }, [ativo, carregar]);

  const apagar = React.useCallback(async (id: string) => {
    // Clique duplo no mesmo item não dispara dois DELETE. O segundo devolveria
    // 404 (a linha já não existe) e pintaria um erro para uma exclusão que deu
    // certo.
    let jaEstava = false;
    setApagando((atual) => {
      jaEstava = atual.includes(id);
      return jaEstava ? atual : [...atual, id];
    });
    if (jaEstava) return;

    try {
      const res = await fetch(
        `${getApiBaseUrl()}/ai/memorias/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!res.ok && res.status !== 404) {
        setErro("Não consegui apagar essa memória. Tenta de novo?");
        return;
      }
      // 404 também some da lista: a linha não existe mais, que é o que o
      // lojista queria. Deixá-la na tela seria mostrar algo que não está lá.
      setMemorias((atual) => atual.filter((m) => m.id !== id));
      setErro(null);
    } catch {
      setErro("Perdi a conexão. Confira se ela ainda está aí antes de repetir.");
    } finally {
      setApagando((atual) => atual.filter((x) => x !== id));
    }
  }, []);

  return { memorias, estado, erro, apagando, apagar, recarregar: carregar };
}
