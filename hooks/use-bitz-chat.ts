"use client";

import * as React from "react";

import { getApiBaseUrl } from "@/lib/api";

export interface BitzChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: unknown[];
  /** Preenchido quando a resposta veio degradada (provedor fora, cota, erro). */
  errorCode?: string | null;
}

let seq = 0;
const nextId = () => `local-${++seq}`;

/**
 * Estado de uma conversa com o Bitz.
 *
 * Otimista na pergunta e pessimista na resposta: a mensagem do usuário aparece
 * na hora, e a do Bitz só quando o servidor responde. Se a requisição falhar
 * por completo (rede caiu), entra uma bolha de erro — o chat nunca fica mudo.
 */
export function useBitzChat() {
  const [messages, setMessages] = React.useState<BitzChatMessage[]>([]);
  const [pending, setPending] = React.useState(false);
  const conversationId = React.useRef<string | null>(null);

  const reset = React.useCallback(() => {
    setMessages([]);
    conversationId.current = null;
  }, []);

  const send = React.useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || pending) return;

      setMessages((prev) => [...prev, { id: nextId(), role: "user", content }]);
      setPending(true);

      try {
        const res = await fetch(`${getApiBaseUrl()}/ai/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: content,
            conversationId: conversationId.current ?? undefined,
          }),
        });

        if (!res.ok) {
          // 403 (gate), 429 (rate limit) e 400 (validação) caem aqui. O
          // backend nunca devolve 5xx por causa de IA.
          const fallback =
            res.status === 429
              ? "Você está enviando mensagens muito rápido. Espera alguns segundos."
              : "Não consegui responder agora. Tenta de novo em instantes.";
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: "assistant",
              content: fallback,
              errorCode: `http_${res.status}`,
            },
          ]);
          return;
        }

        const data = await res.json();
        if (data?.conversationId) conversationId.current = data.conversationId;

        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            content:
              data?.message?.content ??
              "Não consegui responder agora. Tenta de novo em instantes.",
            sources: data?.message?.sources ?? [],
            errorCode: data?.degraded ? "degraded" : null,
          },
        ]);
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            content:
              "Não consegui falar com o servidor. Verifica sua conexão e tenta de novo.",
            errorCode: "network",
          },
        ]);
      } finally {
        setPending(false);
      }
    },
    [pending],
  );

  return { messages, pending, send, reset };
}
