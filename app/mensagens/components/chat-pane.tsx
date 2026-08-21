"use client";

import * as React from "react";
import {
  ArrowLeft,
  ExternalLink,
  MessageCircle,
  RefreshCw,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

import type { ConversationSummary } from "./messages-shell";
import { MessageBubble } from "./message-bubble";
import { ReplyComposer } from "./reply-composer";
import { marcarConversaLida } from "../lib/mark-read";

interface ChatPaneProps {
  apiBase: string;
  headers: HeadersInit;
  accountId: string;
  conversation: ConversationSummary | null;
  onBack: () => void;
  onAfterRead: (itemId: string) => void;
  onAfterAnswer: () => void;
  className?: string;
}

interface QuestionDto {
  id: string;
  externalQuestionId: string;
  text: string;
  status: string;
  dateCreated: string;
  buyerNickname: string | null;
  readAt: string | null;
  // Chat Magalu/WhatsApp: CUSTOMER | SELLER. Nulo em Q&A (ML/Shopee), que usa `answer`.
  authorType: string | null;
  answer: {
    text: string;
    dateCreated: string;
    status: string;
  } | null;
  // Campos ADITIVOS do canal WhatsApp (ausentes/undefined nos demais canais —
  // Magalu/ML/Shopee seguem renderizando exatamente como antes).
  deliveryStatus?: string | null; // sent | delivered | read | failed | played
  errorCode?: string | null;
  mediaType?: string | null;
  mediaMimeType?: string | null;
  mediaUrl?: string | null; // rota autenticada relativa (/whatsapp/media/:id)
}

/** Espera antes da única retentativa de marcar-como-lida (falha transitória). */
const RETRY_READ_MS = 1_500;

interface ListingDto {
  id: string;
  permalink: string | null;
  titleOverride: string | null;
  product: { name: string; sku: string; imageUrl: string | null } | null;
}

export function ChatPane({
  apiBase,
  headers,
  accountId,
  conversation,
  onBack,
  onAfterRead,
  onAfterAnswer,
  className,
}: ChatPaneProps) {
  const [data, setData] = React.useState<{
    questions: QuestionDto[];
    listing: ListingDto | null;
    // Presente só em conversas WhatsApp: estado da janela de 24h etc.
    whatsapp?: {
      contactWaId: string;
      contactName: string | null;
      windowExpiresAt: string | null;
    } | null;
  } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const itemId = conversation?.externalItemId ?? null;
  // Magalu é um CHAT (N mensagens), não Q&A: render por authorType + envio de
  // mensagem na conversa (em vez de resposta a uma pergunta específica).
  const isMagalu = conversation?.accountPlatform === "MAGALU";
  // WhatsApp segue o MESMO modo chat do Magalu; `isChat` agrupa os dois nos
  // pontos que hoje são binários — para Magalu o comportamento é idêntico.
  const isWhatsApp = conversation?.accountPlatform === "WHATSAPP";
  const isChat = isMagalu || isWhatsApp;

  // Em modo "Todas as contas" o accountId global é "all" — read/sync/answer
  // precisam da conta REAL da conversa (vem no DTO). Quando o filtro é uma
  // conta específica, conversation.marketplaceAccountId === accountId, então
  // o comportamento é idêntico ao legado. Fallback no accountId por robustez.
  const effectiveAccountId =
    conversation?.marketplaceAccountId || accountId;

  // Não lidas como PRIMITIVO. O objeto `conversation` é recriado a cada poll de
  // 30 s da lista; depender dele fazia o efeito de leitura re-executar sem que
  // nada tivesse mudado — e, com AbortController, isso cancelaria o request em
  // voo a cada ciclo. Com o número, o efeito só roda quando ele muda de fato.
  const unreadCount = conversation?.unreadCount ?? 0;

  const loadConversation = React.useCallback(
    async (signal?: AbortSignal) => {
      if (!effectiveAccountId || !itemId) return;
      setLoading(true);
      try {
        const res = await fetch(
          `${apiBase}/messages/conversations/${encodeURIComponent(itemId)}?accountId=${effectiveAccountId}`,
          { headers, signal },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          questions: QuestionDto[];
          listing: ListingDto | null;
          whatsapp?: {
            contactWaId: string;
            contactName: string | null;
            windowExpiresAt: string | null;
          } | null;
        };
        setData(json);
        setError(null);
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        console.error("chat: failed to load", err);
        setError("Não foi possível carregar a conversa.");
      } finally {
        setLoading(false);
      }
    },
    [effectiveAccountId, apiBase, headers, itemId],
  );

  // Aborta request anterior se trocar rapidamente entre conversas — evita pintar
  // dados de outra thread em cima da conversa atual.
  React.useEffect(() => {
    setData(null);
    setError(null);
    if (!itemId) return;
    const controller = new AbortController();
    void loadConversation(controller.signal);
    return () => controller.abort();
  }, [itemId, loadConversation]);

  // Marca como lida ao abrir.
  //
  // NUNCA otimista: `onAfterRead` (que zera o badge na lista e avisa a sidebar)
  // só é chamado depois de uma resposta 2xx. Antes, o request era
  // fire-and-forget — 401/404/5xx caíam no caminho de sucesso, o número sumia da
  // tela e voltava no poll seguinte. Era exatamente o "some e volta" relatado.
  // Falhando, o badge continua mostrando a verdade do servidor em vez de mentir.
  React.useEffect(() => {
    if (!itemId || !effectiveAccountId || unreadCount === 0) return;

    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const tentar = async (tentativa: number): Promise<void> => {
      const r = await marcarConversaLida({
        apiBase,
        accountId: effectiveAccountId,
        itemId,
        headers,
        signal: controller.signal,
      });
      if (r.confirmada) {
        onAfterRead(itemId);
        return;
      }
      if (r.motivo === "abortada") return;
      // Uma tentativa extra cobre a falha transitória (blip de rede, token
      // renovando). Depois disso desiste: badge verdadeiro > badge zerado.
      if (tentativa === 0) {
        retryTimer = setTimeout(() => void tentar(1), RETRY_READ_MS);
        return;
      }
      console.warn(
        `chat: mark-read falhou (${r.motivo}); badge mantém o valor do servidor`,
        r.detalhe,
      );
    };

    void tentar(0);

    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [effectiveAccountId, apiBase, headers, itemId, unreadCount, onAfterRead]);

  React.useEffect(() => {
    if (data && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [data]);

  const handleSync = async () => {
    if (!effectiveAccountId || !itemId || syncing) return;
    setSyncing(true);
    try {
      await fetch(
        `${apiBase}/messages/conversations/${encodeURIComponent(itemId)}/sync?accountId=${effectiveAccountId}`,
        { method: "POST", headers },
      );
      await loadConversation();
    } catch (err) {
      console.error("chat: sync failed", err);
      setError("Falha ao sincronizar a conversa.");
    } finally {
      setSyncing(false);
    }
  };

  // Envia resposta/mensagem. Chat (Magalu/WhatsApp) manda `itemId` (mensagem na
  // conversa); ML manda `questionId` (resposta à pergunta). A rota despacha.
  const submitReply = async (text: string, questionId?: string) => {
    const payload = isChat
      ? { accountId: effectiveAccountId, itemId, text }
      : { accountId: effectiveAccountId, questionId, text };
    const res = await fetch(`${apiBase}/messages/answers`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error ?? "Erro ao enviar mensagem");
    }
    // Dispara o refresh da lista em paralelo com o reload do chat — não há
    // dependência entre eles, esperar sequencialmente é desperdício.
    onAfterAnswer();
    await loadConversation();
  };

  if (!conversation || !itemId) {
    return (
      <div
        className={cn(
          "flex h-full flex-col items-center justify-center rounded-xl border border-border/70 bg-card p-12 text-center",
          className,
        )}
      >
        <MessageCircle className="h-12 w-12 text-muted-foreground/40" />
        <div className="mt-3 text-sm font-medium text-foreground">
          Selecione uma conversa
        </div>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
          Escolha um anúncio à esquerda para ver as perguntas e responder.
        </p>
      </div>
    );
  }

  const title =
    data?.listing?.titleOverride ??
    data?.listing?.product?.name ??
    conversation.listingTitle ??
    (isChat ? conversation.buyerNickname : null) ??
    itemId;
  const sku = data?.listing?.product?.sku ?? conversation.productSku ?? null;
  const permalink = data?.listing?.permalink ?? conversation.listingPermalink ?? null;
  const thumbnail =
    data?.listing?.product?.imageUrl ?? conversation.listingThumbnail ?? null;

  const oldestUnanswered = data?.questions.find((q) => q.status === "UNANSWERED") ?? null;

  // Janela de 24h do WhatsApp: aberta se a expiração (última msg do cliente
  // + 24h, calculada no backend) ainda está no futuro.
  const waWindowExpiresAt = data?.whatsapp?.windowExpiresAt
    ? new Date(data.whatsapp.windowExpiresAt)
    : null;
  const waWindowOpen =
    Boolean(waWindowExpiresAt) &&
    !Number.isNaN(waWindowExpiresAt!.getTime()) &&
    waWindowExpiresAt!.getTime() > Date.now();

  return (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-xl border border-border/70 bg-card",
        className,
      )}
    >
      <div className="flex items-start gap-3 border-b border-border/70 p-3">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={onBack}
          className="h-8 w-8 md:hidden"
          aria-label="Voltar"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Avatar className="h-10 w-10 shrink-0">
          {thumbnail && <AvatarImage src={thumbnail} alt={title} />}
          <AvatarFallback className="bg-muted text-xs font-semibold">
            {(conversation.buyerNickname ?? "??").slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">
            {title}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            {conversation.buyerNickname && (
              <span>
                {isChat ? "Cliente" : "Comprador"}:{" "}
                {conversation.buyerNickname}
              </span>
            )}
            {sku && <span>· SKU {sku}</span>}
            {!isChat && <span>· {itemId}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {permalink && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              asChild
              className="h-8 w-8"
              aria-label="Abrir anúncio"
            >
              <a href={permalink} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          )}
          {/* WhatsApp não tem pull (histórico é 100% webhook) — sem sync. */}
          {!isWhatsApp && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={handleSync}
              disabled={syncing}
              className="h-8 w-8"
              aria-label="Atualizar"
            >
              <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} />
            </Button>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {loading && !data ? (
          <>
            <Skeleton className="ml-0 h-16 w-2/3 rounded-lg" />
            <Skeleton className="ml-auto h-12 w-1/2 rounded-lg" />
            <Skeleton className="ml-0 h-16 w-3/4 rounded-lg" />
          </>
        ) : error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : data && data.questions.length > 0 ? (
          data.questions.map((q) =>
            q.authorType ? (
              // Chat (Magalu/WhatsApp): uma mensagem por linha; lado por autor.
              // Os props extras são ADITIVOS: ausentes (Magalu) ⇒ render igual.
              <MessageBubble
                key={q.id}
                side={q.authorType === "SELLER" ? "outgoing" : "incoming"}
                authorLabel={
                  q.authorType === "SELLER"
                    ? "Você"
                    : (q.buyerNickname ?? "Cliente")
                }
                text={q.text}
                date={q.dateCreated}
                deliveryStatus={q.deliveryStatus}
                errorCode={q.errorCode}
                media={
                  q.mediaUrl
                    ? {
                        url: `${apiBase}${q.mediaUrl}`,
                        type: q.mediaType ?? "document",
                        mimeType: q.mediaMimeType ?? null,
                      }
                    : null
                }
                mediaHeaders={headers}
              />
            ) : (
              // ML/Shopee (Q&A): pergunta do comprador + resposta do vendedor.
              <React.Fragment key={q.id}>
                <MessageBubble
                  side="incoming"
                  authorLabel={q.buyerNickname ?? "Comprador"}
                  text={q.text}
                  date={q.dateCreated}
                />
                {q.answer && (
                  <MessageBubble
                    side="outgoing"
                    authorLabel="Você"
                    text={q.answer.text}
                    date={q.answer.dateCreated}
                  />
                )}
              </React.Fragment>
            ),
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <MessageCircle className="h-10 w-10 text-muted-foreground/30" />
            <p className="mt-2 text-sm text-muted-foreground">
              Nenhuma pergunta nesta conversa.
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-border/70 p-3">
        {isWhatsApp ? (
          // WhatsApp: texto livre só com a janela de 24h ABERTA (Cloud API).
          // Fechada ⇒ banner + composer bloqueado (o backend também valida).
          !data ? null : waWindowOpen ? (
            <ReplyComposer
              placeholder="Escreva uma mensagem..."
              onSubmit={(text) => submitReply(text)}
            />
          ) : (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-center text-xs text-amber-700 dark:text-amber-400">
              A janela de atendimento de 24h fechou. Você poderá responder
              quando o cliente enviar uma nova mensagem.
            </div>
          )
        ) : isMagalu ? (
          // Chat: o vendedor pode mandar mensagem a qualquer momento.
          <ReplyComposer
            placeholder="Escreva uma mensagem..."
            onSubmit={(text) => submitReply(text)}
          />
        ) : oldestUnanswered ? (
          <ReplyComposer
            placeholder="Escreva uma resposta..."
            onSubmit={(text) => submitReply(text, oldestUnanswered.id)}
          />
        ) : (
          <div className="rounded-lg bg-muted/40 px-3 py-2 text-center text-xs text-muted-foreground">
            Todas as perguntas desta conversa já foram respondidas.
          </div>
        )}
      </div>
    </div>
  );
}
