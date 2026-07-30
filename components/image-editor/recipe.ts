/**
 * EditRecipeV1 — a receita PURA e serializável de uma edição (PR 6).
 *
 * POR QUE EXISTE: o save do editor exporta pixels achatados; sem a receita,
 * reabrir a imagem para ajustar seria impossível (os layers já viraram
 * bitmap). A receita registra o SUFICIENTE para reconstruir o estado do
 * canvas a partir dos arquivos-fonte — é o que `ProductImageEdit.recipe`
 * guarda e o que o restore não-destrutivo (PR 8) consome.
 *
 * Módulo 100% puro (sem fabric, sem DOM) — testável em ambiente node.
 */

import type { BackgroundMode } from "./presets";

export interface EditRecipeBaseTransform {
  /** Posição do CENTRO da imagem-base no canvas, em px do canvas de export. */
  left: number;
  top: number;
  scaleX: number;
  scaleY: number;
  /** Graus, sentido horário (convenção do fabric). */
  angle: number;
  flipX?: boolean;
  flipY?: boolean;
}

// ---------------------------------------------------------------------------
// Camadas de anotação (PR 7). Todas as coordenadas em PX DO CANVAS DE EXPORT
// (mesmo espaço do `base`), para o restore reconstruir 1:1.
// ---------------------------------------------------------------------------

export interface TextLayerV1 {
  kind: "text";
  text: string;
  left: number;
  top: number;
  angle: number;
  scaleX: number;
  scaleY: number;
  fontFamily: string;
  fontSize: number;
  fill: string;
  fontWeight?: "bold" | "normal";
  textAlign?: "left" | "center" | "right";
  /** Contorno (stroke + paintFirst:"stroke" no fabric). */
  stroke?: string;
  strokeWidth?: number;
  /** Espelhamento: o fabric converte scale negativa em flip no transform. */
  flipX?: boolean;
  flipY?: boolean;
}

export interface ArrowLayerV1 {
  kind: "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
}

export interface EllipseLayerV1 {
  kind: "ellipse";
  /** Centro da elipse. */
  left: number;
  top: number;
  rx: number;
  ry: number;
  angle: number;
  stroke: string;
  strokeWidth: number;
}

export type AnnotationLayerV1 = TextLayerV1 | ArrowLayerV1 | EllipseLayerV1;

export function isAnnotationLayerV1(value: unknown): value is AnnotationLayerV1 {
  if (!value || typeof value !== "object") return false;
  const l = value as { kind?: unknown };
  if (l.kind === "text") {
    const t = value as Partial<TextLayerV1>;
    return typeof t.text === "string" && typeof t.left === "number";
  }
  if (l.kind === "arrow") {
    const a = value as Partial<ArrowLayerV1>;
    return (
      typeof a.x1 === "number" &&
      typeof a.y1 === "number" &&
      typeof a.x2 === "number" &&
      typeof a.y2 === "number"
    );
  }
  if (l.kind === "ellipse") {
    const e = value as Partial<EllipseLayerV1>;
    return typeof e.rx === "number" && typeof e.ry === "number";
  }
  return false;
}

/** Filtra camadas legíveis de uma receita (lixo/versões futuras são
 *  descartados em silêncio — restore parcial > restore nenhum). */
export function readAnnotationLayers(layers: unknown[]): AnnotationLayerV1[] {
  return (Array.isArray(layers) ? layers : []).filter(isAnnotationLayerV1);
}

/** Warning ML (não-bloqueante): a política do Mercado Livre proíbe textos,
 *  logos e promoções SOBRE a foto principal do anúncio. */
export function shouldWarnMlAnnotations(
  presetId: string,
  annotationCount: number,
): boolean {
  return presetId === "ml-1200" && annotationCount > 0;
}

export interface EditRecipeV1 {
  version: 1;
  presetId: string;
  canvas: { width: number; height: number };
  /** Basename da imagem-base (o arquivo aberto no editor). */
  source: { fileName: string; width: number; height: number };
  /** Basename do recorte PNG usado como base, quando a edição partiu dele. */
  cutoutFileName?: string;
  background: { mode: BackgroundMode; color?: string };
  /** Margem: % do lado menor do canvas que a peça ocupa no auto-ajuste. */
  paddingPct: number;
  base: EditRecipeBaseTransform;
  /** Camadas de anotação (texto/seta/elipse) — ver AnnotationLayerV1. */
  layers: unknown[];
}

export interface BuildRecipeInput {
  presetId: string;
  canvas: { width: number; height: number };
  source: { fileName: string; width: number; height: number };
  cutoutFileName?: string;
  background: { mode: BackgroundMode; color?: string };
  paddingPct: number;
  base: EditRecipeBaseTransform;
  layers?: unknown[];
}

export function buildRecipeV1(input: BuildRecipeInput): EditRecipeV1 {
  return {
    version: 1,
    presetId: input.presetId,
    canvas: { ...input.canvas },
    source: { ...input.source },
    ...(input.cutoutFileName ? { cutoutFileName: input.cutoutFileName } : {}),
    background: { ...input.background },
    paddingPct: input.paddingPct,
    base: { ...input.base },
    layers: input.layers ?? [],
  };
}

/** Type guard defensivo para receitas vindas do backend (reabrir edição). */
export function isEditRecipeV1(value: unknown): value is EditRecipeV1 {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<EditRecipeV1>;
  return (
    r.version === 1 &&
    typeof r.presetId === "string" &&
    !!r.canvas &&
    typeof r.canvas.width === "number" &&
    typeof r.canvas.height === "number" &&
    !!r.source &&
    typeof r.source.fileName === "string" &&
    !!r.base &&
    typeof r.base.left === "number" &&
    typeof r.base.scaleX === "number"
  );
}

/**
 * Transform inicial da imagem-base: centralizada, escalada para ocupar
 * `paddingPct`% do encaixe "contain" no canvas. Puro — o hook do fabric só
 * aplica o resultado.
 */
export function initialBaseTransform(
  canvas: { width: number; height: number },
  source: { width: number; height: number },
  paddingPct: number,
): EditRecipeBaseTransform {
  const safePct = Math.min(100, Math.max(10, paddingPct)) / 100;
  const fit = Math.min(
    canvas.width / Math.max(1, source.width),
    canvas.height / Math.max(1, source.height),
  );
  const scale = fit * safePct;
  return {
    left: canvas.width / 2,
    top: canvas.height / 2,
    scaleX: scale,
    scaleY: scale,
    angle: 0,
  };
}
