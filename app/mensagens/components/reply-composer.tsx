"use client";

import * as React from "react";
import { Send } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface ReplyComposerProps {
  placeholder?: string;
  onSubmit: (text: string) => Promise<void>;
}

const MAX_LEN = 2000;

export function ReplyComposer({
  placeholder = "Digite uma mensagem...",
  onSubmit,
}: ReplyComposerProps) {
  const [text, setText] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const canSend = text.trim().length > 0 && text.length <= MAX_LEN && !sending;

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_LEN) {
      setError(`Limite de ${MAX_LEN} caracteres excedido.`);
      return;
    }
    setSending(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao enviar resposta");
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={2}
          maxLength={MAX_LEN + 200}
          disabled={sending}
          className="min-h-11 resize-none"
        />
        <Button
          type="button"
          size="icon"
          onClick={handleSubmit}
          disabled={!canSend}
          aria-label="Enviar resposta"
          className="h-10 w-10 shrink-0"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex items-center justify-between gap-2 px-1">
        <span
          className={cn(
            "text-[11px]",
            error ? "text-destructive" : "text-muted-foreground/80",
          )}
        >
          {error ?? "Enter envia · Shift+Enter quebra linha"}
        </span>
        <span
          className={cn(
            "text-[11px] tabular-nums",
            text.length > MAX_LEN
              ? "text-destructive"
              : "text-muted-foreground/80",
          )}
        >
          {text.length}/{MAX_LEN}
        </span>
      </div>
    </div>
  );
}
