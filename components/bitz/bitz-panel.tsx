"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Maximize2, Minimize2, PenSquare, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useBitzChat } from "@/hooks/use-bitz-chat";
import { BitzComposer } from "./bitz-composer";
import { BitzEmptyState } from "./bitz-empty-state";
import { BitzMascot } from "./bitz-mascot";
import { BitzMessage, BitzStreaming, BitzThinking } from "./bitz-message";
import type { BitzPanelMode } from "./bitz-constants";

interface BitzPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: BitzPanelMode;
  onModeChange: (mode: BitzPanelMode) => void;
  userName?: string | null;
}

/**
 * Painel do Bitz.
 *
 * DOIS MODOS, e o full-screen está disponível em QUALQUER tela:
 *  - `docked`     — cartão ancorado no canto inferior direito (desktop).
 *                   Radix com `modal={false}`: sem trava de scroll e sem
 *                   bloquear clique fora, então dá para continuar trabalhando
 *                   na página com o Bitz aberto ao lado.
 *  - `fullscreen` — ocupa a viewport inteira, em desktop e em mobile.
 *                   `modal={true}`: trava de foco, Esc, scroll lock. É o modo
 *                   da referência de design e o padrão no celular.
 *
 * Por que primitivo do Radix e não `components/ui/dialog.tsx`: o DialogContent
 * da casa traz X embutido, régua dourada no ::before e `sm:max-w-lg`, que eu
 * teria que desfazer. Usando o primitivo direto ganho portal, foco e Esc de
 * graça SEM tocar em arquivo existente.
 *
 * Z-INDEX (mapeado no diagnóstico da Fase 0):
 *   toasts z-[100] > Radix/header z-50 > BITZ > busca da sidebar z-30
 *   - docked usa z-40: acima de todo conteúdo em árvore, abaixo de todo modal
 *     e de todo toast.
 *   - fullscreen usa z-50: ali ele É o modal da vez e precisa cobrir o header
 *     sticky. Continua abaixo dos toasts (z-[100]), que é o correto — um aviso
 *     de "produto salvo" tem que aparecer por cima.
 */
export function BitzPanel({
  open,
  onOpenChange,
  mode,
  onModeChange,
  userName,
}: BitzPanelProps) {
  const { messages, pending, streaming, send, reset } = useBitzChat();
  const [draft, setDraft] = React.useState("");
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const isFull = mode === "fullscreen";
  const vazio = messages.length === 0;

  // Autoscroll para o fim. Mesmo padrão de app/mensagens/.../chat-pane.tsx:165
  // — o projeto não tem primitivo `scroll-area`, e a convenção é overflow-y
  // com scrollTop manual.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending, streaming?.content]);

  const perguntar = (texto: string) => {
    setDraft("");
    void send(texto);
  };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={onOpenChange}
      modal={isFull}
    >
      <DialogPrimitive.Portal>
        {isFull && (
          <DialogPrimitive.Overlay
            className={cn(
              "fixed inset-0 z-50 bg-[#0e1f2a]/55 backdrop-blur-[2px]",
              "data-[state=open]:animate-in data-[state=closed]:animate-out",
              "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
              "motion-reduce:animate-none",
            )}
          />
        )}

        <DialogPrimitive.Content
          aria-describedby={undefined}
          onInteractOutside={(e) => {
            // No modo docado o clique fora é do usuário trabalhando na página,
            // não um pedido para fechar o chat.
            if (!isFull) e.preventDefault();
          }}
          className={cn(
            "bg-background text-foreground fixed flex flex-col overflow-hidden shadow-2xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "motion-reduce:animate-none",
            isFull
              ? "inset-0 z-50 rounded-none"
              : cn(
                  "z-40 rounded-3xl border",
                  "border-border/60",
                  // Mobile sem full-screen explícito ainda respira: quase toda
                  // a tela, mas livrando a faixa de toasts embaixo.
                  "inset-x-3 bottom-3 top-20",
                  // Desktop: cartão ancorado no canto.
                  "md:inset-auto md:right-6 md:bottom-6 md:top-auto",
                  "md:h-[min(46rem,calc(100svh-7rem))] md:w-[26.5rem]",
                ),
          )}
        >
          {/* Lavagem de gradiente — a leitura "glass" da referência, feita com
              os tokens da marca em vez do lavanda. Puramente decorativa. */}
          <div
            aria-hidden
            className="from-primary/10 pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b to-transparent"
          />

          <header className="border-border/60 relative flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
            <BitzMascot size={30} priority />
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="font-display text-foreground text-sm leading-tight font-semibold">
                Bitz
              </DialogPrimitive.Title>
              <p className="text-muted-foreground truncate text-[11px]">
                Assistente do Dexo
              </p>
            </div>

            {!vazio && (
              <IconBtn
                label="Nova conversa"
                onClick={() => {
                  reset();
                  setDraft("");
                }}
              >
                <PenSquare className="size-4" />
              </IconBtn>
            )}

            <IconBtn
              label={isFull ? "Reduzir" : "Expandir para tela cheia"}
              onClick={() => onModeChange(isFull ? "docked" : "fullscreen")}
            >
              {isFull ? (
                <Minimize2 className="size-4" />
              ) : (
                <Maximize2 className="size-4" />
              )}
            </IconBtn>

            <DialogPrimitive.Close asChild>
              <IconBtn label="Fechar">
                <X className="size-4" />
              </IconBtn>
            </DialogPrimitive.Close>
          </header>

          <div
            ref={scrollRef}
            className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
          >
            {/* Em tela cheia a conversa ganha uma coluna legível no centro em
                vez de esticar por 2000px de monitor. */}
            <div className={cn("mx-auto w-full", isFull && "max-w-3xl")}>
              {vazio ? (
                <BitzEmptyState nome={userName} onPergunta={perguntar} />
              ) : (
                <div className="flex flex-col gap-3 p-4">
                  {messages.map((m) => (
                    <BitzMessage key={m.id} message={m} />
                  ))}
                  {/* Enquanto o turno corre: o texto ao vivo quando já há
                      texto, o indicador de consulta quando o Bitz foi ao
                      banco, e os três pontinhos no resto do tempo. A bolha
                      definitiva substitui isto quando o quadro `fim` chega. */}
                  {pending &&
                    (streaming ? (
                      <BitzStreaming
                        content={streaming.content}
                        consultando={streaming.consultando}
                      />
                    ) : (
                      <BitzThinking />
                    ))}
                </div>
              )}
            </div>
          </div>

          <div className={cn("mx-auto w-full shrink-0", isFull && "max-w-3xl")}>
            <BitzComposer
              value={draft}
              onValueChange={setDraft}
              onSend={perguntar}
              disabled={pending}
              autoFocus={open}
            />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

const IconBtn = React.forwardRef<
  HTMLButtonElement,
  { label: string; children: React.ReactNode; onClick?: () => void }
>(function IconBtn({ label, children, onClick, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "text-muted-foreground hover:text-foreground hover:bg-muted inline-flex size-8 shrink-0 items-center justify-center rounded-xl",
        "transition motion-reduce:transition-none",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

export default BitzPanel;
