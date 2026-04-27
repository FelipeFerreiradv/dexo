"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface MessageBubbleProps {
  side: "incoming" | "outgoing";
  authorLabel: string;
  text: string;
  date: string;
}

export function MessageBubble({
  side,
  authorLabel,
  text,
  date,
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
        <p className="whitespace-pre-wrap break-words leading-relaxed">{text}</p>
        <div
          className={cn(
            "mt-1 text-right text-[10px]",
            isOutgoing
              ? "text-primary-foreground/60"
              : "text-muted-foreground/80",
          )}
        >
          {formatTimestamp(date)}
        </div>
      </div>
    </div>
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
