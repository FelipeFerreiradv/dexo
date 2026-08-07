"use client";

import * as React from "react";

import { getApiBaseUrl } from "@/lib/api";
import {
  NDJSON_ACCEPT,
  lerNdjson,
  type BitzStreamEvent,
} from "@/lib/ndjson-stream";

export interface BitzChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: unknown[];
  /** Preenchido quando a resposta veio degradada (provedor fora, cota, erro). */
  errorCode?: string | null;
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

  const reset = React.useCallback(() => {
    setMessages([]);
    setStreaming(null);
    conversationId.current = null;
  }, []);

  const send = React.useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || pending) return;

      setMessages((prev) => [...prev, { id: nextId(), role: "user", content }]);
      setPending(true);
      setStreaming(null);

      const responder = (
        texto: string,
        errorCode: string | null,
        sources: unknown[] = [],
      ) => {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            content: texto,
            sources,
            errorCode,
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

  return { messages, pending, streaming, send, reset };
}
