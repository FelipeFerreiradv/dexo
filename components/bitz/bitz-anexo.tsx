"use client";

import * as React from "react";
import { ChevronDown, FileText, ImageIcon, Loader2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { AnexoLido } from "@/hooks/use-bitz-anexo";

/**
 * O cartão do anexo, entre a conversa e o campo de escrita.
 *
 * ⭐ O QUE ESTE CARTÃO EXISTE PARA FAZER: mostrar ao lojista o que o Bitz
 * ENTENDEU do arquivo, antes de a pergunta ser feita. Um modelo de visão lê
 * "8200 435 452" onde está escrito "8200 435 462" com a mesma confiança dos
 * dois jeitos. Se a leitura fosse invisível, o erro só apareceria três passos
 * depois, na peça errada separada no balcão.
 *
 * Por isso ele é EXPANSÍVEL e não um simples "arquivo.jpg ✓": fechado mostra
 * uma linha, aberto mostra tudo que vai junto da pergunta. Nada viaja escondido.
 */
export function BitzAnexo({
  anexo,
  lendo,
  onRemover,
}: {
  anexo: AnexoLido | null;
  lendo: boolean;
  onRemover: () => void;
}) {
  const [aberto, setAberto] = React.useState(false);

  // Anexo novo entra sempre fechado: o cartão aberto do anterior empurraria a
  // conversa para cima sem que ninguém tenha pedido.
  React.useEffect(() => {
    setAberto(false);
  }, [anexo?.nome, anexo?.leitura]);

  if (lendo) {
    return (
      <div className="px-3 pt-3">
        <p
          className="border-border/60 bg-card/70 text-muted-foreground flex items-center gap-2 rounded-2xl border px-3 py-2 text-xs"
          role="status"
        >
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          Lendo o arquivo…
        </p>
      </div>
    );
  }

  if (!anexo) return null;

  const Icone = anexo.tipo === "xml-nfe" ? FileText : ImageIcon;

  return (
    <div className="px-3 pt-3">
      <div className="border-border/60 bg-card/70 overflow-hidden rounded-2xl border">
        <div className="flex items-start gap-2 px-3 py-2">
          <Icone className="text-primary mt-0.5 size-4 shrink-0" />

          <div className="min-w-0 flex-1">
            <p className="text-foreground truncate text-xs font-medium">
              {anexo.nome}
            </p>
            {anexo.resumo && (
              <p className="text-muted-foreground mt-0.5 line-clamp-2 text-[11px] leading-snug">
                {anexo.resumo}
              </p>
            )}
          </div>

          {anexo.leitura && (
            <button
              type="button"
              onClick={() => setAberto((v) => !v)}
              aria-expanded={aberto}
              aria-label={
                aberto
                  ? "Esconder o que o Bitz leu"
                  : "Ver tudo que o Bitz leu deste arquivo"
              }
              className={cn(
                "text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-7 shrink-0",
                "items-center justify-center rounded-full transition",
                "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                "motion-reduce:transition-none",
              )}
            >
              <ChevronDown
                className={cn(
                  "size-4 transition-transform motion-reduce:transition-none",
                  aberto && "rotate-180",
                )}
              />
            </button>
          )}

          <button
            type="button"
            onClick={onRemover}
            aria-label="Remover anexo"
            className={cn(
              "text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-7 shrink-0",
              "items-center justify-center rounded-full transition",
              "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
              "motion-reduce:transition-none",
            )}
          >
            <X className="size-4" />
          </button>
        </div>

        {aberto && anexo.leitura && (
          <div className="border-border/60 border-t px-3 py-2">
            <p className="text-muted-foreground mb-1 font-mono text-[9px] tracking-[0.18em] uppercase">
              O que o Bitz leu
            </p>
            {/* `whitespace-pre-wrap`: a leitura vem em linhas, e amassá-las num
                parágrafo só esconderia os códigos que o lojista precisa
                conferir. Teto de altura para uma nota de 40 itens não empurrar
                a conversa para fora da tela. */}
            <p className="text-foreground max-h-40 overflow-y-auto text-[11px] leading-relaxed whitespace-pre-wrap">
              {anexo.leitura}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
