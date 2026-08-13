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
  /**
   * Contador que, ao mudar, PÕE O FOCO NO CAMPO COM O CURSOR NO FIM.
   *
   * ⭐ Existe por causa do "Corrigir" do cartão (P3.1): sem ele o texto aparece
   * no campo mas o foco fica no botão, e o lojista tem de clicar no campo antes
   * de continuar a frase — o toque a mais que o botão existe para poupar.
   *
   * É um CONTADOR e não um booleano porque duas correções seguidas precisam
   * disparar duas vezes; um booleano só mudaria de valor na primeira.
   */
  focarNoFim?: number;
  /**
   * Abre a gravação de voz (Fase 7).
   *
   * ⭐ `undefined` mantém o microfone como placeholder "em breve", e é assim
   * que o botão SOME para quem não tem áudio disponível — quem roteou o áudio
   * para um modelo que não transcreve, por exemplo. Botão que sempre falha é
   * pior que botão nenhum: o lojista grava, espera e leva um erro.
   */
  onMicrofone?: () => void;
  /**
   * Recebe o arquivo escolhido no clipe (Fase 8).
   *
   * ⭐ `undefined` — ou `aceita` vazio — mantém o clipe como placeholder "em
   * breve", pela mesma regra do microfone: botão que sempre falha é pior que
   * botão nenhum. Quem não tem modelo de visão configurado ainda recebe `.xml`,
   * porque ler NF-e não depende de provedor.
   */
  onArquivo?: (arquivo: File) => void;
  /** Extensões que o seletor oferece. Vem do SERVIDOR, via /ai/capacidades. */
  aceita?: string[];
  /** Já existe um anexo em cima da mesa — muda o convite do campo. */
  temAnexo?: boolean;
  /**
   * Uma leitura de anexo está em andamento: o ENVIO espera, a digitação não.
   *
   * ⚠️ Não é preciosismo. Sem isto, mandar a pergunta enquanto o cartão dizia
   * "Lendo o arquivo…" fazia a pergunta subir SEM o anexo, em silêncio — e a
   * leitura, que já tinha custado uma das 15 do dia, ia para o lixo. O lojista
   * levava um "não vi foto nenhuma" sem entender por quê, e repetir quinze
   * vezes zerava a cota sem uma única resposta útil.
   *
   * O campo continua liberado de propósito: travar o texto no meio da digitação
   * seria trocar um problema por outro.
   */
  aguardandoAnexo?: boolean;
}

/**
 * Composer do painel — o rodapé da referência: clipe à esquerda, campo no
 * meio, microfone à direita.
 *
 * Os dois botões nasceram na Fase 1 como placeholder "em breve", e as Fases 7
 * (áudio) e 8 (anexos) só os ligaram — o layout nunca mudou, e o lojista não
 * descobriu botão do nada. Cada um continua caindo no placeholder quando o
 * servidor não sabe fazer aquilo.
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
  focarNoFim,
  onMicrofone,
  onArquivo,
  aceita,
  temAnexo,
  aguardandoAnexo,
}: BitzComposerProps) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const arquivoRef = React.useRef<HTMLInputElement>(null);
  const podeAnexar = !!onArquivo && !!aceita?.length;

  React.useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // ⚠️ O CURSOR VAI PARA O FIM, e isso é o ponto. `focus()` sozinho pode devolver
  // a seleção anterior — que num campo recém-preenchido de fora é a posição 0, e
  // o lojista digitaria a correção ANTES da frase, produzindo uma pergunta
  // embaralhada. `focarNoFim` na lista, e não `value`: o efeito só pode disparar
  // quando alguém PEDIU o foco, nunca a cada tecla digitada.
  React.useEffect(() => {
    if (!focarNoFim) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focarNoFim]);

  const submit = () => {
    const texto = value.trim();
    // `aguardandoAnexo` barra o envio aqui TAMBÉM, e não só no botão: o Enter
    // não passa pelo botão.
    if (!texto || disabled || aguardandoAnexo) return;
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
        {podeAnexar ? (
          <>
            {/* O <input type="file"> fica escondido e o botão o aciona: o
                controle nativo não aceita estilo, e um <label> estilizado
                perderia o foco por teclado. `sr-only` e não `display:none` —
                escondido de verdade, o input sai da ordem de tabulação e
                leitores de tela deixam de anunciá-lo. */}
            <input
              ref={arquivoRef}
              type="file"
              accept={aceita!.join(",")}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const f = e.target.files?.[0];
                // ⚠️ Zerar o valor é obrigatório: sem isso, escolher O MESMO
                // arquivo duas vezes seguidas (trocar a foto, se arrepender e
                // voltar) não dispara `change` de novo, e o clipe fica mudo.
                e.target.value = "";
                if (f) onArquivo!(f);
              }}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => arquivoRef.current?.click()}
                  disabled={disabled}
                  aria-label="Anexar arquivo"
                  className={cn(
                    "text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-8 shrink-0",
                    "items-center justify-center rounded-xl transition disabled:opacity-50",
                    "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                    "motion-reduce:transition-none",
                  )}
                >
                  <Paperclip className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                Anexar foto da peça ou XML de NF-e
              </TooltipContent>
            </Tooltip>
          </>
        ) : (
          <EmBreve label="Anexar arquivo (em breve)">
            <Paperclip className="size-4" />
          </EmBreve>
        )}

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
          placeholder={
            temAnexo ? "Pergunte sobre o arquivo…" : "Pergunte alguma coisa…"
          }
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
            disabled={disabled || aguardandoAnexo}
            aria-label={
              aguardandoAnexo ? "Aguardando a leitura do arquivo" : "Enviar"
            }
            title={
              aguardandoAnexo ? "Espere o Bitz terminar de ler o arquivo" : undefined
            }
            className={cn(
              "bg-primary text-primary-foreground inline-flex size-9 shrink-0 items-center justify-center rounded-full",
              "hover:bg-primary/90 disabled:opacity-50 shadow-sm transition",
              "hover:scale-105 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100",
              "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
            )}
          >
            <SendHorizontal className="size-4" />
          </button>
        ) : onMicrofone ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onMicrofone}
                disabled={disabled}
                aria-label="Falar com o Bitz"
                className={cn(
                  "text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-9 shrink-0",
                  "items-center justify-center rounded-full transition disabled:opacity-50",
                  "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                  "motion-reduce:transition-none",
                )}
              >
                <Mic className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Falar com o Bitz</TooltipContent>
          </Tooltip>
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
