"use client";

import * as React from "react";
import { Mic, Paperclip, SendHorizontal } from "lucide-react";

import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MAX_MESSAGE_CHARS } from "./bitz-constants";

interface BitzComposerProps {
  onSend: (texto: string) => void;
  disabled?: boolean;
  /** Preenchido de fora quando o usuário clica numa sugestão. */
  value: string;
  onValueChange: (v: string) => void;
  autoFocus?: boolean;
}

/**
 * Composer do painel — o rodapé da referência: clipe à esquerda, campo no
 * meio, microfone à direita.
 *
 * Anexo e microfone já ocupam o lugar, DESABILITADOS com tooltip "em breve".
 * É deliberado: as Fases 7 (áudio) e 8 (anexos) entram sem mexer no layout, e
 * o usuário não descobre o botão do nada depois.
 *
 * Enter envia, Shift+Enter quebra linha — mesma convenção do
 * app/mensagens/components/reply-composer.tsx, para não haver dois
 * comportamentos de teclado no mesmo produto.
 */
export function BitzComposer({
  onSend,
  disabled,
  value,
  onValueChange,
  autoFocus,
}: BitzComposerProps) {
  const ref = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = () => {
    const texto = value.trim();
    if (!texto || disabled) return;
    onSend(texto);
    onValueChange("");
  };

  const restantes = MAX_MESSAGE_CHARS - value.length;

  return (
    <div className="border-border/60 bg-background/80 border-t p-3 backdrop-blur">
      <div
        className={cn(
          "border-border/60 bg-card/70 flex items-end gap-1.5 rounded-3xl border p-1.5",
          // O campo é o centro de gravidade da tela: ao receber foco ele ganha
          // a borda E um halo da cor da marca, em vez do anel genérico de
          // sistema. Sem `ring-offset`, para o halo abraçar a pílula.
          "focus-within:border-primary/60 focus-within:ring-primary/25 focus-within:ring-4",
          "shadow-sm transition motion-reduce:transition-none",
        )}
      >
        <EmBreve label="Anexar arquivo (em breve)">
          <Paperclip className="size-4" />
        </EmBreve>

        <Textarea
          ref={ref}
          value={value}
          onChange={(e) =>
            onValueChange(e.target.value.slice(0, MAX_MESSAGE_CHARS))
          }
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Pergunte alguma coisa…"
          disabled={disabled}
          aria-label="Mensagem para o Bitz"
          className={cn(
            "max-h-32 min-h-9 flex-1 resize-none border-0 bg-transparent px-1 py-1.5",
            "text-sm shadow-none focus-visible:ring-0",
          )}
        />

        {value.trim() ? (
          <button
            type="button"
            onClick={submit}
            disabled={disabled}
            aria-label="Enviar"
            className={cn(
              "bg-primary text-primary-foreground inline-flex size-9 shrink-0 items-center justify-center rounded-full",
              "hover:bg-primary/90 disabled:opacity-50 shadow-sm transition",
              "hover:scale-105 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100",
              "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
            )}
          >
            <SendHorizontal className="size-4" />
          </button>
        ) : (
          <EmBreve label="Falar com o Bitz (em breve)">
            <Mic className="size-4" />
          </EmBreve>
        )}
      </div>

      {restantes < 200 && (
        <p className="text-muted-foreground mt-1.5 text-right text-[11px]">
          {restantes} caracteres restantes
        </p>
      )}
    </div>
  );
}

/** Botão presente mas inativo — reserva o lugar das Fases 7 e 8. */
function EmBreve({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="button"
          aria-disabled="true"
          aria-label={label}
          tabIndex={-1}
          className="text-muted-foreground/50 inline-flex size-8 shrink-0 cursor-not-allowed items-center justify-center rounded-xl"
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
