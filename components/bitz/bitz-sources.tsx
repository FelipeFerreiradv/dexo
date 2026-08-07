"use client";

import * as React from "react";
import { BookOpen, Info } from "lucide-react";

/**
 * De onde o Bitz tirou a resposta.
 *
 * O servidor preenche `sources[]` com o que REALMENTE consultou; aqui só
 * desenhamos. O modelo não escreve este bloco e por isso não consegue inventar
 * uma fonte nem esquecer de citar.
 *
 * A Fase 4 emite só fontes de conhecimento; as demais variantes chegam nas
 * Fases 5 e 6. Fonte de tipo desconhecido é IGNORADA em silêncio — versão nova
 * do servidor com front antigo não pode quebrar a tela.
 */
export interface BitzSource {
  kind?: string;
  docId?: string;
  docTitle?: string;
  heading?: string;
}

export function BitzSources({ sources }: { sources?: unknown[] }) {
  const conhecimento = React.useMemo(() => {
    const lista = (sources ?? []) as BitzSource[];
    const vistos = new Set<string>();
    const saida: Array<{ titulo: string; secao?: string }> = [];
    for (const s of lista) {
      if (s?.kind !== "conhecimento" || !s.docTitle) continue;
      // Cinco pedaços do mesmo documento viram UMA linha: o usuário quer saber
      // de onde veio, não em qual parágrafo.
      const chave = s.docTitle;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      saida.push({ titulo: s.docTitle, secao: s.heading });
    }
    return saida;
  }, [sources]);

  if (conhecimento.length === 0) return null;

  return (
    <div className="border-border/50 mt-2.5 border-t pt-2">
      <p className="text-muted-foreground mb-1 flex items-center gap-1 text-[11px] font-medium">
        <Info className="size-3" aria-hidden />
        Fontes
      </p>
      <ul className="space-y-0.5">
        {conhecimento.map((f) => (
          <li
            key={f.titulo}
            className="text-muted-foreground flex items-start gap-1.5 text-[11px] leading-snug"
          >
            <BookOpen className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span>
              {f.titulo}
              {f.secao ? ` — ${f.secao}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
