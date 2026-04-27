"use client";

import * as React from "react";
import { MessageCircle, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

import type { ConversationSummary } from "./messages-shell";

interface ConversationListProps {
  conversations: ConversationSummary[] | null;
  selectedItemId: string | null;
  onSelect: (itemId: string) => void;
  search: string;
  onSearchChange: (v: string) => void;
  error: string | null;
  className?: string;
}

export function ConversationList({
  conversations,
  selectedItemId,
  onSelect,
  search,
  onSearchChange,
  error,
  className,
}: ConversationListProps) {
  return (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-xl border border-border/70 bg-card",
        className,
      )}
    >
      <div className="border-b border-border/70 p-3">
        <div className="flex items-center gap-2 rounded-full border border-border/70 bg-muted/40 px-3 py-1.5 text-sm focus-within:border-ring">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Buscar conversas, anúncios..."
            type="search"
            className="h-6 flex-1 border-0 bg-transparent px-0 text-sm placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:outline-none dark:bg-transparent"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {conversations === null ? (
          <div className="space-y-2 p-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-destructive">{error}</div>
        ) : conversations.length === 0 ? (
          <EmptyConversations />
        ) : (
          <ul className="divide-y divide-border/60">
            {conversations.map((c) => (
              <ConversationRow
                key={c.externalItemId}
                conversation={c}
                active={c.externalItemId === selectedItemId}
                onClick={() => onSelect(c.externalItemId)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ConversationRow({
  conversation,
  active,
  onClick,
}: {
  conversation: ConversationSummary;
  active: boolean;
  onClick: () => void;
}) {
  const title = conversation.listingTitle ?? conversation.externalItemId;
  const lastText = conversation.lastQuestionText;
  const lastAt = conversation.lastQuestionAt
    ? formatRelative(conversation.lastQuestionAt)
    : "";
  const fallback = conversation.buyerNickname?.slice(0, 2).toUpperCase() ?? "??";

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active
            ? "bg-accent/50"
            : "hover:bg-accent/30",
        )}
      >
        <Avatar className="h-10 w-10 shrink-0">
          {conversation.listingThumbnail && (
            <AvatarImage src={conversation.listingThumbnail} alt={title} />
          )}
          <AvatarFallback className="bg-muted text-xs font-semibold">
            {fallback}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-sm font-medium text-foreground">
              {title}
            </div>
            <div className="shrink-0 text-[11px] text-muted-foreground">
              {lastAt}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p
              className={cn(
                "line-clamp-1 text-xs text-muted-foreground",
                conversation.unreadCount > 0 && "text-foreground font-medium",
              )}
            >
              {conversation.buyerNickname && (
                <span className="text-foreground/80">
                  {conversation.buyerNickname}:{" "}
                </span>
              )}
              {lastText || "—"}
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              {conversation.hasUnanswered && (
                <Badge
                  variant="outline"
                  className="h-5 border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
                >
                  Pendente
                </Badge>
              )}
              {conversation.unreadCount > 0 && (
                <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                  {conversation.unreadCount}
                </span>
              )}
            </div>
          </div>
        </div>
      </button>
    </li>
  );
}

function EmptyConversations() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <MessageCircle className="h-10 w-10 text-muted-foreground/40" />
      <div className="text-sm font-medium text-foreground">Nenhuma conversa</div>
      <p className="max-w-xs text-xs text-muted-foreground">
        Quando os compradores enviarem perguntas nos seus anúncios, elas vão
        aparecer aqui.
      </p>
    </div>
  );
}

function formatRelative(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diff < 60 * 1000) return "agora";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} min`;
  if (diff < day) return `${Math.floor(diff / 3_600_000)} h`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} d`;
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}
