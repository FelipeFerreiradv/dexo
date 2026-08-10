"use client";

import * as React from "react";

import { getApiBaseUrl } from "@/lib/api";
import {
  NDJSON_ACCEPT,
  lerNdjson,
  type BitzStreamEvent,
} from "@/lib/ndjson-stream";
import { lerAcoes, type BitzAcao } from "@/hooks/use-bitz-acao";

/** O que foi anexado a uma pergunta. Só o rótulo — a leitura já foi ao servidor. */
export interface BitzMensagemAnexo {
  nome: string;
  tipo: "imagem" | "xml-nfe";
}

export interface BitzChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: unknown[];
  /** Preenchido quando a resposta veio degradada (provedor fora, cota, erro). */
  errorCode?: string | null;
  /**
   * Anexos que acompanharam ESTA pergunta, para a bolha mostrar o clipe.
   *
   * ⚠️ Só nome e tipo. A leitura já viajou no corpo da requisição e está gravada
   * junto da mensagem no servidor; repeti-la na bolha encheria a conversa de
   * texto que o lojista acabou de conferir no cartão.
   */
  anexos?: BitzMensagemAnexo[];
  /**
   * Propostas de escrita deste turno (Fase 9). Viram cartões abaixo da bolha.
   *
   * ⭐ NADA FOI ESCRITO ainda. Elas ficam presas à mensagem que as gerou de
   * propósito: o cartão precisa continuar visível junto da frase do Bitz que o
   * explicou, e não flutuando no rodapé como se fosse de outra pergunta.
   */
  acoes?: BitzAcao[];
}

/** O que o composer entrega junto da pergunta. */
export interface BitzAnexoParaEnviar {
  nome: string;
  tipo: "imagem" | "xml-nfe";
  leitura: string;
}

/** O que está sendo escrito agora. `null` quando não há turno em andamento. */
export interface BitzStreamingState {
  /** Texto recebido até agora. PRÉVIA — o conteúdo final vem no quadro `fim`. */
  content: string;
  /** Consultas em andamento, para o painel dizer o que o Bitz está fazendo. */
  consultando: string[];
}

let seq = 0;
const nextId = () => `local-${++seq}`;

const ERRO_GENERICO =
  "Não consegui responder agora. Tenta de novo em instantes.";

/**
 * Estado de uma conversa com o Bitz.
 *
 * Otimista na pergunta e pessimista na resposta: a mensagem do usuário aparece
 * na hora, e a do Bitz só quando o servidor responde. Se a requisição falhar
 * por completo (rede caiu), entra uma bolha de erro — o chat nunca fica mudo.
 *
 * ⭐ SOBRE O STREAMING. O texto que chega em pedaços é PRÉVIA e vive em
 * `streaming`; ele nunca vira mensagem. A mensagem do assistente é montada uma
 * vez só, a partir do quadro `fim`, que é a mesma carga que o caminho JSON
 * devolve e é o que foi gravado no banco. Por isso a bolha não pode terminar
 * diferente do que ficou salvo — nem quando a conexão cai no meio, nem quando o
 * modelo narra antes de consultar.
 *
 * Servidor sem streaming (ou proxy que não deixa passar) cai sozinho no caminho
 * JSON: a decisão é pelo `content-type` da resposta, não por configuração.
 */
export function useBitzChat() {
  const [messages, setMessages] = React.useState<BitzChatMessage[]>([]);
  const [pending, setPending] = React.useState(false);
  const [streaming, setStreaming] = React.useState<BitzStreamingState | null>(
    null,
  );
  const conversationId = React.useRef<string | null>(null);

  /**
   * ⭐ Registra a decisão de um cartão NA MENSAGEM.
   *
   * ⚠️ É aqui que ela precisa morar: o `DialogPrimitive.Content` do Radix
   * DESMONTA ao fechar o painel, e leva junto o estado local do cartão. A lista
   * de mensagens vive um nível acima e sobrevive — sem isto, fechar e reabrir o
   * Bitz devolvia um cartão já executado ao estado "confirme aqui", com o botão
   * ativo.
   */
  const decidirAcao = React.useCallback(
    (
      acaoId: string,
      status: "confirmada" | "cancelada",
      relatorio?: BitzAcao["relatorio"],
    ) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.acoes?.some((a) => a.id === acaoId)
            ? {
                ...m,
                acoes: m.acoes.map((a) =>
                  a.id === acaoId
                    ? {
                        ...a,
                        decidida: status,
                        ...(relatorio ? { relatorio } : {}),
                      }
                    : a,
                ),
              }
            : m,
        ),
      );
    },
    [],
  );

  const reset = React.useCallback(() => {
    setMessages([]);
    setStreaming(null);
    conversationId.current = null;
  }, []);

  const send = React.useCallback(
    async (text: string, anexos?: BitzAnexoParaEnviar[]) => {
      const content = text.trim();
      if (!content || pending) return;

      // Só o que TEM leitura viaja. Um anexo que falhou não pode ir junto
      // fingindo que o Bitz leu alguma coisa.
      const comLeitura = (anexos ?? []).filter((a) => a?.leitura?.trim());

      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "user",
          content,
          ...(comLeitura.length
            ? {
                anexos: comLeitura.map((a) => ({ nome: a.nome, tipo: a.tipo })),
              }
            : {}),
        },
      ]);
      setPending(true);
      setStreaming(null);

      const responder = (
        texto: string,
        errorCode: string | null,
        sources: unknown[] = [],
        acoes: BitzAcao[] = [],
      ) => {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            content: texto,
            sources,
            errorCode,
            // Ausente quando não houve proposta: a bolha de uma consulta
            // continua exatamente como era.
            ...(acoes.length ? { acoes } : {}),
          },
        ]);
      };

      try {
        const res = await fetch(`${getApiBaseUrl()}/ai/chat`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // O servidor decide: se souber transmitir, transmite; se não,
            // responde o JSON de sempre e o `else` abaixo cuida.
            accept: NDJSON_ACCEPT,
          },
          body: JSON.stringify({
            message: content,
            conversationId: conversationId.current ?? undefined,
            // Ausente quando não há anexo: o corpo volta a ser byte a byte o
            // mesmo de antes da Fase 8.
            ...(comLeitura.length
              ? {
                  anexos: comLeitura.map((a) => ({
                    nome: a.nome,
                    leitura: a.leitura,
                  })),
                }
              : {}),
          }),
        });

        if (!res.ok) {
          // 403 (gate), 429 (rate limit) e 400 (validação) caem aqui. O
          // backend nunca devolve 5xx por causa de IA.
          responder(
            res.status === 429
              ? "Você está enviando mensagens muito rápido. Espera alguns segundos."
              : ERRO_GENERICO,
            `http_${res.status}`,
          );
          return;
        }

        const ehStream =
          !!res.body &&
          (res.headers.get("content-type") ?? "").includes(NDJSON_ACCEPT);

        if (!ehStream) {
          const data = await res.json();
          if (data?.conversationId)
            conversationId.current = data.conversationId;
          responder(
            data?.message?.content ?? ERRO_GENERICO,
            data?.degraded ? "degraded" : null,
            data?.message?.sources ?? [],
            lerAcoes(data?.acoes),
          );
          return;
        }

        let terminou = false;
        setStreaming({ content: "", consultando: [] });

        await lerNdjson(res.body!, (evento: BitzStreamEvent) => {
          switch (evento.type) {
            case "conversa":
              conversationId.current = evento.conversationId;
              break;
            case "consultando":
              setStreaming((s) => ({
                content: s?.content ?? "",
                consultando: evento.tools ?? [],
              }));
              break;
            case "texto":
              setStreaming((s) => ({
                content: (s?.content ?? "") + evento.delta,
                consultando: [],
              }));
              break;
            case "reinicio":
              // O que veio até aqui era preâmbulo de uma consulta, não a
              // resposta. Some da tela antes de o número aparecer.
              setStreaming((s) => ({
                content: "",
                consultando: s?.consultando ?? [],
              }));
              break;
            case "fim":
              terminou = true;
              if (evento.conversationId) {
                conversationId.current = evento.conversationId;
              }
              responder(
                evento.message?.content ?? ERRO_GENERICO,
                evento.degraded ? "degraded" : null,
                evento.message?.sources ?? [],
                lerAcoes(evento.acoes),
              );
              break;
            default:
              // Quadro que este front não conhece. Ignorar é o certo: o
              // contrato garante que o `fim` sempre vem.
              break;
          }
        });

        // Conexão fechou sem `fim`: houve resposta pela metade, e ela NÃO vira
        // mensagem. Prometer uma resposta truncada como se fosse a completa é
        // pior do que dizer que a conexão caiu.
        if (!terminou) {
          responder(
            "A conexão caiu no meio da resposta. Pergunta de novo, por favor.",
            "stream_interrompido",
          );
        }
      } catch {
        responder(
          "Não consegui falar com o servidor. Verifica sua conexão e tenta de novo.",
          "network",
        );
      } finally {
        setStreaming(null);
        setPending(false);
      }
    },
    [pending],
  );

  return { messages, pending, streaming, send, reset, decidirAcao };
}
