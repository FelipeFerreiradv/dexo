"use client";

import * as React from "react";
import {
  BarChart3,
  BookOpen,
  Globe,
  Info,
  Package,
  Scale,
  Sparkles,
} from "lucide-react";

import { linhasDoCard, type IconeDaFonte } from "./bitz-source-line";

/**
 * De onde o Bitz tirou a resposta.
 *
 * O servidor preenche `sources[]` com o que REALMENTE consultou; aqui só
 * desenhamos. O modelo não escreve este bloco e por isso não consegue inventar
 * uma fonte nem esquecer de citar.
 *
 * A lógica de "fonte vira linha" vive em `bitz-source-line.ts`, sem React —
 * é o que permite testá-la na suíte, que roda em `environment: "node"`.
 */
export type { BitzSource } from "./bitz-source-line";

const ICONES: Record<
  IconeDaFonte,
  React.ComponentType<{ className?: string }>
> = {
  livro: BookOpen,
  caixa: Package,
  grafico: BarChart3,
  balanca: Scale,
  globo: Globe,
  faisca: Sparkles,
};

export function BitzSources({ sources }: { sources?: unknown[] }) {
  const linhas = React.useMemo(() => linhasDoCard(sources), [sources]);

  if (linhas.length === 0) return null;

  return (
    <div className="border-border/50 mt-2.5 border-t pt-2">
      <p className="text-muted-foreground mb-1 flex items-center gap-1 text-[11px] font-medium">
        <Info className="size-3" aria-hidden />
        Fontes
      </p>
      <ul className="space-y-0.5">
        {linhas.map((f) => {
          const Icone = ICONES[f.icone];
          return (
            <li
              key={f.chave}
              className={`flex items-start gap-1.5 text-[11px] leading-snug ${
                f.destaque
                  ? "text-amber-600 dark:text-amber-500"
                  : "text-muted-foreground"
              }`}
            >
              <Icone className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span>{f.texto}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
