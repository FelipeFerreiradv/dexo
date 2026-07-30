/**
 * Geometria da SETA do editor (PR 7) — pura, sem fabric/DOM.
 *
 * A seta é um fabric.Path reconstruído a cada arrasto de endpoint (os
 * controls custom chamam arrowPathString de novo) — por isso a ponta NUNCA
 * distorce: escala/rotação ficam travadas no objeto e todo ajuste é
 * re-geração do path.
 */

export interface ArrowHead {
  /** Pontas das duas "pernas" do triângulo da cabeça. */
  hx1: number;
  hy1: number;
  hx2: number;
  hy2: number;
}

/** Comprimento da cabeça proporcional à espessura, com piso legível. */
export function arrowHeadLength(strokeWidth: number): number {
  return Math.max(18, strokeWidth * 4);
}

/** Pontos da cabeça: pernas a ±30° da direção, apontando para (x2,y2). */
export function arrowHeadPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  headLen: number,
): ArrowHead {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 6; // 30°
  return {
    hx1: x2 - headLen * Math.cos(angle - spread),
    hy1: y2 - headLen * Math.sin(angle - spread),
    hx2: x2 - headLen * Math.cos(angle + spread),
    hy2: y2 - headLen * Math.sin(angle + spread),
  };
}

/** Path SVG completo: haste + as duas pernas da cabeça (stroke-only). */
export function arrowPathString(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  strokeWidth: number,
): string {
  const r = (n: number) => Math.round(n * 100) / 100;
  const { hx1, hy1, hx2, hy2 } = arrowHeadPoints(
    x1,
    y1,
    x2,
    y2,
    arrowHeadLength(strokeWidth),
  );
  return (
    `M ${r(x1)} ${r(y1)} L ${r(x2)} ${r(y2)} ` +
    `M ${r(hx1)} ${r(hy1)} L ${r(x2)} ${r(y2)} L ${r(hx2)} ${r(hy2)}`
  );
}
