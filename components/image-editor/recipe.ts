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
  /** Camadas de anotação (texto/seta/elipse) — vazio no PR 6; o PR 7 gera. */
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
