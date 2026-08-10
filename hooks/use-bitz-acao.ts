"use client";

import * as React from "react";

import { getApiBaseUrl } from "@/lib/api";

/**
 * O clique que executa. Fase 9.
 *
 * ⭐ ESTE HOOK É O ÚNICO CAMINHO DE ESCRITA DO BITZ NO NAVEGADOR, e ele manda
 * só um ID. O que vai ser executado está gravado no servidor desde que a
 * proposta nasceu; o corpo desta requisição é VAZIO de propósito.
 *
 * Se o payload viajasse até aqui e voltasse no clique, `POST /ai/acoes/:id/
 * confirmar` seria uma rota de escrita genérica com nome de confirmação — e
 * qualquer um poderia mandar `{ preco: 1 }` junto do "confirmo".
 */
export type EstadoDaAcao =
  | "pendente"
  | "enviando"
  | "confirmada"
  | "cancelada"
  | "erro";

/** O que o cartão desenha. Espelha `AiAcaoPreview` do servidor. */
export interface BitzAcaoCampo {
  campo: string;
  de?: string | null;
  para: string;
}

export interface BitzAcaoItem {
  nome: string;
  preco: string;
  estoque: string;
  /** Marca, modelo, ano, categoria, part number — tudo que também vai ao banco. */
  detalhe?: string;
  aviso?: string;
}

export interface BitzAcaoPreview {
  titulo: string;
  alvo?: string;
  campos: BitzAcaoCampo[];
  aviso?: string;
  /** As linhas de um LOTE (Fase 10). Ausente nas ações de um registro só. */
  itens?: BitzAcaoItem[];
}

/** O que aconteceu num lote confirmado. Melhor-esforço com relatório. */
export interface BitzAcaoRelatorio {
  criadas: number;
  total: number;
  falhas: Array<{ nome: string; motivo: string }>;
}

export interface BitzAcao {
  id: string;
  tipo: string;
  preview: BitzAcaoPreview;
  expiraEm: string;
  /**
   * ⭐ A DECISÃO JÁ TOMADA, guardada na MENSAGEM e não no cartão.
   *
   * ⚠️ Conserto de um achado: o `DialogPrimitive.Content` do Radix DESMONTA ao
   * fechar o painel, levando junto o `useState` do cartão. Fechar e reabrir o
   * Bitz devolvia um cartão já executado ao estado "Confira antes de confirmar",
   * com o botão ativo — e o lojista, em dúvida se o preço tinha mudado, clicava
   * de novo. (A idempotência do servidor impedia a segunda escrita, mas ele não
   * tinha como saber disso.)
   *
   * A lista de mensagens sobrevive à remontagem porque vive no `useBitzChat`,
   * um nível acima. É lá que a decisão passa a morar.
   */
  decidida?: "confirmada" | "cancelada";
  /**
   * ⭐ O RELATÓRIO DO LOTE, depois de confirmado. Guardado na MENSAGEM pelo
   * mesmo motivo da decisão: o cartão desmonta quando o painel fecha, e
   * "28 de 30 cadastradas" é justamente o que o lojista precisa reler.
   */
  relatorio?: BitzAcaoRelatorio;
}

/** Aceita só o que tem a forma certa — o resto some sem quebrar o chat. */
export function lerAcoes(bruto: unknown): BitzAcao[] {
  if (!Array.isArray(bruto)) return [];
  return bruto.filter((a: any): a is BitzAcao => {
    return (
      !!a &&
      typeof a.id === "string" &&
      !!a.preview &&
      typeof a.preview.titulo === "string" &&
      Array.isArray(a.preview.campos)
    );
  });
}

export function useBitzAcao(
  acaoId: string,
  opts?: {
    /** Decisão já registrada na mensagem — sobrevive ao fechar/reabrir. */
    decidida?: "confirmada" | "cancelada";
    /** Sobe a decisão para a mensagem, que é quem sobrevive à remontagem. */
    aoDecidir?: (
      id: string,
      status: "confirmada" | "cancelada",
      relatorio?: BitzAcaoRelatorio,
    ) => void;
  },
) {
  const [estado, setEstado] = React.useState<EstadoDaAcao>(
    opts?.decidida ?? "pendente",
  );
  const [erro, setErro] = React.useState<string | null>(null);
  /** Impede duas requisições do mesmo clique duplo antes da primeira voltar. */
  const emVooRef = React.useRef(false);

  const chamar = React.useCallback(
    async (caminho: "confirmar" | "cancelar") => {
      if (emVooRef.current) return;
      emVooRef.current = true;
      setErro(null);
      setEstado("enviando");

      try {
        const res = await fetch(
          `${getApiBaseUrl()}/ai/acoes/${encodeURIComponent(acaoId)}/${caminho}`,
          {
            method: "POST",
            // ⭐ SEM CORPO. O que executa está no banco.
          },
        );
        const data = await res.json().catch(() => null);

        if (!res.ok || !data?.ok) {
          setErro(
            typeof data?.error === "string"
              ? data.error
              : "Não consegui concluir. Nada foi alterado.",
          );
          setEstado("erro");
          return;
        }

        const decidido = caminho === "confirmar" ? "confirmada" : "cancelada";
        // ⚠️ CONFIRMAÇÃO QUE JÁ TINHA ACONTECIDO, sem relatório para mostrar.
        // Acontece quando a PRIMEIRA resposta se perdeu (4G caindo, timeout do
        // proxy) e o lojista clicou de novo. Num LOTE isso importa: as peças
        // que falharam não vêm no retry, e um "Feito." liso afirmaria sucesso
        // pleno sobre um lote que pode ter falhado em parte.
        if (caminho === "confirmar" && data.jaEstava && !data.relatorio) {
          setErro(
            "Esta ação já tinha sido executada antes — a resposta anterior se perdeu no caminho. Confira o resultado na tela do sistema.",
          );
        }
        setEstado(decidido);
        // Sobe para a mensagem ANTES de qualquer remontagem possível.
        opts?.aoDecidir?.(acaoId, decidido, data?.relatorio);
      } catch {
        // ⚠️ Rede caiu DEPOIS de o servidor ter executado? Pode ter acontecido.
        // Por isso a mensagem não afirma que nada mudou: ela manda conferir. A
        // idempotência do servidor garante que clicar de novo não duplica.
        setErro(
          "Perdi a conexão antes de saber o resultado. Confira na tela do sistema antes de tentar de novo.",
        );
        setEstado("erro");
      } finally {
        emVooRef.current = false;
      }
    },
    [acaoId, opts],
  );

  // Decisão que chegou de fora (outra aba, ou a mensagem já carregada) vence o
  // estado local "pendente" — nunca o contrário.
  React.useEffect(() => {
    if (opts?.decidida) setEstado(opts.decidida);
  }, [opts?.decidida]);

  return {
    estado,
    erro,
    confirmar: () => chamar("confirmar"),
    cancelar: () => chamar("cancelar"),
  };
}
