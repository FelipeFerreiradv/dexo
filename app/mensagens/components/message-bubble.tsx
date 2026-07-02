"use client";

import * as React from "react";
import { AlertTriangle, Check, CheckCheck, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";

interface MessageBubbleProps {
  side: "incoming" | "outgoing";
  authorLabel: string;
  text: string;
  date: string;
  // Campos ADITIVOS do canal WhatsApp. Ausentes/undefined (ML/Shopee/Magalu)
  // ⇒ o render é EXATAMENTE o de antes.
  deliveryStatus?: string | null; // sent | delivered | read | failed | played
  errorCode?: string | null;
  media?: {
    url: string; // URL absoluta da rota autenticada
    type: string; // image | audio | document | video | sticker...
    mimeType?: string | null;
  } | null;
  // Headers de auth p/ baixar a mídia (a rota exige Bearer/email — <img> puro
  // não envia headers, então o download é via fetch → blob URL).
  mediaHeaders?: HeadersInit;
}

export function MessageBubble({
  side,
  authorLabel,
  text,
  date,
  deliveryStatus,
  errorCode,
  media,
  mediaHeaders,
}: MessageBubbleProps) {
  const isOutgoing = side === "outgoing";
  return (
    <div
      className={cn(
        "flex w-full",
        isOutgoing ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm shadow-sm md:max-w-[70%]",
          isOutgoing
            ? "rounded-tr-sm bg-primary text-primary-foreground"
            : "rounded-tl-sm bg-muted text-foreground",
        )}
      >
        <div
          className={cn(
            "mb-1 text-[10px] font-semibold uppercase tracking-[0.1em]",
            isOutgoing
              ? "text-primary-foreground/70"
              : "text-muted-foreground",
          )}
        >
          {authorLabel}
        </div>
        {media && (
          <AuthenticatedMedia media={media} headers={mediaHeaders} />
        )}
        <p className="whitespace-pre-wrap break-words leading-relaxed">{text}</p>
        <div
          className={cn(
            "mt-1 flex items-center justify-end gap-1 text-right text-[10px]",
            isOutgoing
              ? "text-primary-foreground/60"
              : "text-muted-foreground/80",
          )}
        >
          <span>{formatTimestamp(date)}</span>
          {isOutgoing && deliveryStatus && (
            <DeliveryTicks status={deliveryStatus} errorCode={errorCode} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Ticks de entrega estilo WhatsApp (só em bolhas OUTGOING do canal). */
function DeliveryTicks({
  status,
  errorCode,
}: {
  status: string;
  errorCode?: string | null;
}) {
  if (status === "failed") {
    return (
      <span
        className="inline-flex items-center gap-0.5 text-red-200"
        title={errorCode ? `Falha no envio (erro ${errorCode})` : "Falha no envio"}
      >
        <AlertTriangle className="h-3 w-3" />
        Falhou
      </span>
    );
  }
  if (status === "read" || status === "played") {
    return <CheckCheck className="h-3 w-3 text-sky-300" aria-label="Lida" />;
  }
  if (status === "delivered") {
    return <CheckCheck className="h-3 w-3" aria-label="Entregue" />;
  }
  return <Check className="h-3 w-3" aria-label="Enviada" />;
}

/**
 * Mídia recebida: a rota /whatsapp/media/:id é AUTENTICADA, então baixamos
 * via fetch (com os headers de auth) e exibimos por blob URL (revogada no
 * cleanup). Imagem inline; áudio com player; demais viram link de download.
 */
function AuthenticatedMedia({
  media,
  headers,
}: {
  media: { url: string; type: string; mimeType?: string | null };
  headers?: HeadersInit;
}) {
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(media.url, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        revoked = url;
        setObjectUrl(url);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [media.url, headers]);

  if (failed) {
    return (
      <div className="mb-2 rounded-lg bg-black/10 px-2 py-1.5 text-xs opacity-80">
        Não foi possível carregar a mídia.
      </div>
    );
  }
  if (!objectUrl) {
    return (
      <div className="mb-2 h-24 w-40 animate-pulse rounded-lg bg-black/10" />
    );
  }
  if (media.type === "image" || media.type === "sticker") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={objectUrl}
        alt="Imagem recebida"
        className="mb-2 max-h-64 w-auto rounded-lg"
      />
    );
  }
  if (media.type === "audio") {
    return <audio controls src={objectUrl} className="mb-2 max-w-full" />;
  }
  if (media.type === "video") {
    return (
      <video controls src={objectUrl} className="mb-2 max-h-64 rounded-lg" />
    );
  }
  return (
    <a
      href={objectUrl}
      download
      className="mb-2 inline-flex items-center gap-1.5 rounded-lg bg-black/10 px-2 py-1.5 text-xs underline-offset-2 hover:underline"
    >
      <Paperclip className="h-3.5 w-3.5" />
      Abrir anexo
    </a>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay =
    d.toDateString() === new Date().toDateString();
  if (sameDay) {
    return d.toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
