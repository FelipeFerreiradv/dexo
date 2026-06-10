import React, { Fragment } from "react";
import { cn } from "@/lib/utils";

/**
 * Destaca os trechos de `text` que casam com `tokens` (tokens já normalizados
 * por `tokenize`: minúsculos e sem acento). Como a busca é acento-insensível e
 * o texto renderizado mantém o acento, mapeamos os offsets do texto normalizado
 * de volta ao original, char a char.
 *
 * Nunca usa dangerouslySetInnerHTML. Qualquer falha de mapeamento cai no
 * fallback de texto puro — a função jamais lança.
 */

interface Range {
  start: number;
  end: number;
}

/**
 * "Dobra" o texto (remove acento + minúsculo) preservando, para cada char
 * normalizado, o índice do char original que o originou.
 */
function buildFoldMap(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = text[i]
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase();
    for (let j = 0; j < f.length; j++) {
      folded += f[j];
      map.push(i);
    }
  }
  return { folded, map };
}

function computeRanges(text: string, tokens: string[]): Range[] {
  const { folded, map } = buildFoldMap(text);
  const ranges: Range[] = [];

  for (const token of tokens) {
    if (!token) continue;
    let from = 0;
    let idx = folded.indexOf(token, from);
    while (idx !== -1) {
      const start = map[idx];
      const end = map[idx + token.length - 1] + 1;
      ranges.push({ start, end });
      from = idx + token.length;
      idx = folded.indexOf(token, from);
    }
  }

  // Mescla intervalos sobrepostos/adjacentes.
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

interface Segment {
  text: string;
  highlight: boolean;
}

function computeSegments(text: string, tokens: string[]): Segment[] {
  const ranges = computeRanges(text, tokens);
  if (ranges.length === 0) return [{ text, highlight: false }];

  const segments: Segment[] = [];
  let cursor = 0;
  for (const { start, end } of ranges) {
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), highlight: false });
    }
    segments.push({ text: text.slice(start, end), highlight: true });
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), highlight: false });
  }
  return segments;
}

export function HighlightText({
  text,
  tokens,
  className,
}: {
  text: string;
  tokens: string[];
  className?: string;
}) {
  if (!text || !tokens || tokens.length === 0) {
    return <>{text}</>;
  }

  let segments: Segment[];
  try {
    segments = computeSegments(text, tokens);
  } catch {
    return <>{text}</>;
  }

  return (
    <>
      {segments.map((seg, i) =>
        seg.highlight ? (
          <mark
            key={i}
            className={cn(
              "rounded bg-yellow-200 px-0.5 text-foreground dark:bg-yellow-500/30",
              className,
            )}
          >
            {seg.text}
          </mark>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </>
  );
}
