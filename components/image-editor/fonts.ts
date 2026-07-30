"use client";

/**
 * Fontes do editor (PR 7) — 3 famílias SIL OFL-1.1, embarcadas via
 * @fontsource (npm, licença auditável por pacote; zero requisição externa
 * em runtime). Os imports de CSS entram SÓ no chunk do editor (este módulo
 * é importado pelo dialog, que é dynamic import atrás da flag).
 *
 * GATE: canvas NÃO reflui texto quando a fonte chega depois — desenhar antes
 * do load renderiza com fallback e "pula" depois. `ensureEditorFontsLoaded`
 * é aguardado antes de criar texto E antes do export.
 */

import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/roboto-condensed/latin-400.css";
import "@fontsource/roboto-condensed/latin-700.css";
import "@fontsource/archivo-black/latin-400.css";

export const EDITOR_FONTS = [
  { family: "Inter", label: "Inter (limpa)" },
  { family: "Roboto Condensed", label: "Roboto Condensed (estreita)" },
  { family: "Archivo Black", label: "Archivo Black (impacto)" },
] as const;

export const DEFAULT_FONT_FAMILY = EDITOR_FONTS[0].family;

let loadPromise: Promise<void> | null = null;

export function ensureEditorFontsLoaded(): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) {
    return Promise.resolve();
  }
  if (!loadPromise) {
    loadPromise = Promise.all(
      EDITOR_FONTS.flatMap((f) => [
        document.fonts.load(`16px "${f.family}"`),
        document.fonts.load(`bold 16px "${f.family}"`),
      ]),
    )
      .then(() => undefined)
      .catch(() => undefined); // fonte que falhou cai no fallback do browser
  }
  return loadPromise;
}
