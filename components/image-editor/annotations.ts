"use client";

/**
 * Anotações do editor (PR 7): texto (IText), seta (Path com controls custom
 * nos endpoints) e elipse — criação, estilo, camadas e (de)serialização de/
 * para `EditRecipeV1.layers`.
 *
 * CONVENÇÕES:
 * - Todo objeto ganha `dexoKind` ("base" | "text" | "arrow" | "ellipse").
 *   A imagem-base é marcada pelo hook; só os DEMAIS entram nas camadas.
 * - Coordenadas das camadas em px do CANVAS DE EXPORT (mesmo espaço do
 *   `base` da receita) — o restore reconstrói 1:1.
 * - SETA: escala/rotação TRAVADAS; ajustar = arrastar os endpoints, que
 *   re-geram o path (arrow-geometry) — a ponta nunca distorce. Os endpoints
 *   ficam guardados RELATIVOS a left/top (`dexoArrow`), então arrastar o
 *   corpo move tudo junto sem recalcular nada.
 */

import {
  Canvas,
  Control,
  Ellipse,
  FabricObject,
  IText,
  Path,
  Point,
  util,
} from "fabric";

import {
  type AnnotationLayerV1,
  type ArrowLayerV1,
  type EllipseLayerV1,
  type TextLayerV1,
  readAnnotationLayers,
} from "./recipe";
import { DEFAULT_FONT_FAMILY, ensureEditorFontsLoaded } from "./fonts";
import { arrowPathString } from "./tools/arrow-geometry";

export const ANNOTATION_PALETTE = [
  "#111111",
  "#ffffff",
  "#f2c419",
  "#e11d48",
  "#2563eb",
  "#16a34a",
] as const;

export type DexoKind = "base" | "text" | "arrow" | "ellipse";

type Tagged = FabricObject & {
  dexoKind?: DexoKind;
  dexoArrow?: { relX1: number; relY1: number; relX2: number; relY2: number };
};

export function kindOf(obj: FabricObject): DexoKind | undefined {
  return (obj as Tagged).dexoKind;
}

export function isAnnotation(obj: FabricObject): boolean {
  const k = kindOf(obj);
  return k === "text" || k === "arrow" || k === "ellipse";
}

export function listAnnotations(canvas: Canvas): Tagged[] {
  return canvas.getObjects().filter(isAnnotation) as Tagged[];
}

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fill: string;
  bold: boolean;
  textAlign: "left" | "center" | "right";
  /** Contorno branco/preto automático (stroke por baixo do fill). */
  outline: boolean;
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: 64,
  fill: "#111111",
  bold: false,
  textAlign: "center",
  outline: true,
};

/** Contorno contrasta com o fill: texto escuro ganha borda clara e vice-versa. */
export function outlineColorFor(fill: string): string {
  const hex = fill.replace("#", "");
  if (hex.length < 6) return "#ffffff";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance < 140 ? "#ffffff" : "#111111";
}

/** Texto apagado por completo vira camada-zumbi (chip "Texto: ", warning ML,
 *  linha na receita) — remove no fim da edição, padrão de editor. */
function attachEmptyTextCleanup(obj: IText): void {
  obj.on("editing:exited", () => {
    if (!obj.text || !obj.text.trim()) {
      const c = obj.canvas as Canvas | undefined;
      if (c) removeAnnotation(c, obj);
    }
  });
}

export async function addText(
  canvas: Canvas,
  style: TextStyle = DEFAULT_TEXT_STYLE,
): Promise<IText> {
  await ensureEditorFontsLoaded(); // desenhar antes = fallback que "pula" depois
  const obj = new IText("Texto", {
    left: canvas.getWidth() / 2,
    top: canvas.getHeight() / 2,
    originX: "center",
    originY: "center",
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fill: style.fill,
    fontWeight: style.bold ? "bold" : "normal",
    textAlign: style.textAlign,
    ...(style.outline
      ? {
          stroke: outlineColorFor(style.fill),
          strokeWidth: Math.max(2, Math.round(style.fontSize / 16)),
          paintFirst: "stroke" as const,
        }
      : {}),
  });
  (obj as Tagged).dexoKind = "text";
  attachEmptyTextCleanup(obj);
  canvas.add(obj);
  canvas.setActiveObject(obj);
  canvas.requestRenderAll();
  return obj;
}

export function applyTextStyle(
  canvas: Canvas,
  obj: IText,
  patch: Partial<TextStyle>,
): void {
  const current: TextStyle = {
    fontFamily: (obj.fontFamily as string) ?? DEFAULT_FONT_FAMILY,
    fontSize: obj.fontSize ?? 64,
    fill: (obj.fill as string) ?? "#111111",
    bold: obj.fontWeight === "bold",
    textAlign: (obj.textAlign as TextStyle["textAlign"]) ?? "center",
    outline: Boolean(obj.stroke),
  };
  const next = { ...current, ...patch };
  obj.set({
    fontFamily: next.fontFamily,
    fontSize: next.fontSize,
    fill: next.fill,
    fontWeight: next.bold ? "bold" : "normal",
    textAlign: next.textAlign,
    ...(next.outline
      ? {
          stroke: outlineColorFor(next.fill),
          strokeWidth: Math.max(2, Math.round(next.fontSize / 16)),
          paintFirst: "stroke" as const,
        }
      : { stroke: undefined, strokeWidth: 0 }),
  });
  obj.setCoords();
  canvas.requestRenderAll();
}

// ---------------------------------------------------------------------------
// Elipse (Shift durante o scale = círculo, comportamento nativo do fabric)
// ---------------------------------------------------------------------------

export function addEllipse(canvas: Canvas, stroke = "#e11d48"): Ellipse {
  const w = canvas.getWidth();
  const obj = new Ellipse({
    left: w / 2,
    top: canvas.getHeight() / 2,
    originX: "center",
    originY: "center",
    rx: Math.round(w * 0.18),
    ry: Math.round(w * 0.12),
    fill: "transparent",
    stroke,
    strokeWidth: Math.max(6, Math.round(w / 200)),
    strokeUniform: true, // escala não engrossa o traço
  });
  (obj as Tagged).dexoKind = "ellipse";
  canvas.add(obj);
  canvas.setActiveObject(obj);
  canvas.requestRenderAll();
  return obj;
}

// ---------------------------------------------------------------------------
// Seta
// ---------------------------------------------------------------------------

function arrowAbsEndpoints(obj: Tagged): {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
} {
  const d = obj.dexoArrow!;
  return {
    x1: (obj.left ?? 0) + d.relX1,
    y1: (obj.top ?? 0) + d.relY1,
    x2: (obj.left ?? 0) + d.relX2,
    y2: (obj.top ?? 0) + d.relY2,
  };
}

function rebuildArrowPath(
  obj: Path & Tagged,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  const width = obj.strokeWidth ?? 6;
  // adjustPosition=true: o fabric reposiciona left/top para os novos bounds,
  // mantendo o path no MESMO lugar absoluto do canvas.
  obj._setPath(arrowPathString(x1, y1, x2, y2, width), true);
  obj.dexoArrow = {
    relX1: x1 - (obj.left ?? 0),
    relY1: y1 - (obj.top ?? 0),
    relX2: x2 - (obj.left ?? 0),
    relY2: y2 - (obj.top ?? 0),
  };
  obj.setCoords();
  obj.canvas?.requestRenderAll();
}

function makeEndpointControl(which: 1 | 2): Control {
  return new Control({
    cursorStyle: "crosshair",
    actionName: "dexoArrowEndpoint",
    // O canvas lógico (1200+) encolhido via CSS deixa o hit-area default
    // (~24px de buffer) com ~7px REAIS no celular — e os endpoints são o
    // ÚNICO jeito de ajustar a seta. touchSize grande só afeta TOQUE
    // (mouse usa cornerSize); sizeX/Y maior deixa o quadradinho visível.
    sizeX: 36,
    sizeY: 36,
    touchSizeX: 110,
    touchSizeY: 110,
    positionHandler: (_dim, _finalMatrix, fabricObject) => {
      const obj = fabricObject as Path & Tagged;
      const abs = arrowAbsEndpoints(obj);
      const pt =
        which === 1 ? new Point(abs.x1, abs.y1) : new Point(abs.x2, abs.y2);
      const vpt = obj.canvas?.viewportTransform;
      return vpt ? util.transformPoint(pt, vpt) : pt;
    },
    actionHandler: (_eventData, transform, x, y) => {
      const obj = transform.target as Path & Tagged;
      if (!obj.dexoArrow) return false;
      const abs = arrowAbsEndpoints(obj);
      if (which === 1) rebuildArrowPath(obj, x, y, abs.x2, abs.y2);
      else rebuildArrowPath(obj, abs.x1, abs.y1, x, y);
      return true;
    },
  });
}

export function addArrow(canvas: Canvas, stroke = "#e11d48"): Path {
  const w = canvas.getWidth();
  const h = canvas.getHeight();
  const strokeWidth = Math.max(6, Math.round(w / 180));
  const x1 = w * 0.3;
  const y1 = h * 0.62;
  const x2 = w * 0.55;
  const y2 = h * 0.45;
  const obj = new Path(arrowPathString(x1, y1, x2, y2, strokeWidth), {
    stroke,
    strokeWidth,
    fill: "",
    strokeLineCap: "round",
    strokeLineJoin: "round",
    originX: "left",
    originY: "top",
    objectCaching: false,
    // Seta diagonal tem bbox enorme: sem pixel-find, clicar no "vazio" do
    // retângulo selecionaria a seta e roubaria o clique de camadas abaixo.
    perPixelTargetFind: true,
    // Ajuste é SÓ pelos endpoints — escala/rotação distorceriam a ponta.
    lockRotation: true,
    lockScalingX: true,
    lockScalingY: true,
    hasBorders: false,
  }) as Path & Tagged;
  obj.dexoKind = "arrow";
  obj.dexoArrow = {
    relX1: x1 - (obj.left ?? 0),
    relY1: y1 - (obj.top ?? 0),
    relX2: x2 - (obj.left ?? 0),
    relY2: y2 - (obj.top ?? 0),
  };
  obj.controls = {
    p1: makeEndpointControl(1),
    p2: makeEndpointControl(2),
  };
  canvas.add(obj);
  canvas.setActiveObject(obj);
  canvas.requestRenderAll();
  return obj;
}

// ---------------------------------------------------------------------------
// Camadas (painel): ordem, duplicar, excluir
// ---------------------------------------------------------------------------

export function annotationLabel(obj: FabricObject): string {
  const k = kindOf(obj);
  if (k === "text") {
    const t = (obj as IText).text ?? "";
    return `Texto: ${t.slice(0, 18)}${t.length > 18 ? "…" : ""}`;
  }
  if (k === "arrow") return "Seta";
  if (k === "ellipse") return "Círculo";
  return "Camada";
}

export function removeAnnotation(canvas: Canvas, obj: FabricObject): void {
  canvas.remove(obj);
  canvas.discardActiveObject();
  canvas.requestRenderAll();
}

export function duplicateAnnotation(
  canvas: Canvas,
  obj: FabricObject,
): void {
  const layer = serializeOne(obj as Tagged);
  if (!layer) return;
  const shifted: AnnotationLayerV1 =
    layer.kind === "arrow"
      ? { ...layer, x1: layer.x1 + 40, y1: layer.y1 + 40, x2: layer.x2 + 40, y2: layer.y2 + 40 }
      : { ...layer, left: layer.left + 40, top: layer.top + 40 };
  void restoreAnnotations(canvas, [shifted], { select: true });
}

export function moveAnnotation(
  canvas: Canvas,
  obj: FabricObject,
  direction: "up" | "down",
): void {
  if (direction === "up") canvas.bringObjectForward(obj);
  else canvas.sendObjectBackwards(obj);
  // A base fica SEMPRE no fundo — anotação nunca desce para trás dela.
  const base = canvas.getObjects().find((o) => kindOf(o) === "base");
  if (base) canvas.sendObjectToBack(base);
  canvas.requestRenderAll();
}

// ---------------------------------------------------------------------------
// (De)serialização de/para a receita
// ---------------------------------------------------------------------------

function serializeOne(obj: Tagged): AnnotationLayerV1 | null {
  const k = kindOf(obj);
  if (k === "text") {
    const t = obj as unknown as IText;
    const layer: TextLayerV1 = {
      kind: "text",
      text: t.text ?? "",
      left: t.left ?? 0,
      top: t.top ?? 0,
      angle: t.angle ?? 0,
      scaleX: t.scaleX ?? 1,
      scaleY: t.scaleY ?? 1,
      fontFamily: (t.fontFamily as string) ?? DEFAULT_FONT_FAMILY,
      fontSize: t.fontSize ?? 64,
      fill: (t.fill as string) ?? "#111111",
      ...(t.fontWeight === "bold" ? { fontWeight: "bold" as const } : {}),
      ...(t.textAlign
        ? { textAlign: t.textAlign as TextLayerV1["textAlign"] }
        : {}),
      ...(t.stroke
        ? { stroke: t.stroke as string, strokeWidth: t.strokeWidth ?? 2 }
        : {}),
      ...(t.flipX ? { flipX: true } : {}),
      ...(t.flipY ? { flipY: true } : {}),
    };
    return layer;
  }
  if (k === "arrow") {
    const abs = arrowAbsEndpoints(obj);
    const layer: ArrowLayerV1 = {
      kind: "arrow",
      ...abs,
      stroke: (obj.stroke as string) ?? "#e11d48",
      strokeWidth: obj.strokeWidth ?? 6,
    };
    return layer;
  }
  if (k === "ellipse") {
    const e = obj as unknown as Ellipse;
    const layer: EllipseLayerV1 = {
      kind: "ellipse",
      left: e.left ?? 0,
      top: e.top ?? 0,
      rx: (e.rx ?? 10) * (e.scaleX ?? 1),
      ry: (e.ry ?? 10) * (e.scaleY ?? 1),
      angle: e.angle ?? 0,
      stroke: (e.stroke as string) ?? "#e11d48",
      strokeWidth: e.strokeWidth ?? 6,
    };
    return layer;
  }
  return null;
}

/** Camadas atuais do canvas, na ordem de empilhamento (para a receita). */
export function serializeAnnotations(canvas: Canvas): AnnotationLayerV1[] {
  return listAnnotations(canvas)
    .map(serializeOne)
    .filter((l): l is AnnotationLayerV1 => l !== null);
}

/** Reconstrói camadas de uma receita reaberta (restore parcial tolerante). */
export async function restoreAnnotations(
  canvas: Canvas,
  rawLayers: unknown[],
  opts: { select?: boolean } = {},
): Promise<void> {
  const layers = readAnnotationLayers(rawLayers);
  if (layers.length === 0) return;
  const hasText = layers.some((l) => l.kind === "text");
  if (hasText) await ensureEditorFontsLoaded();

  let last: FabricObject | null = null;
  for (const layer of layers) {
    if (layer.kind === "text") {
      const t = new IText(layer.text, {
        left: layer.left,
        top: layer.top,
        originX: "center",
        originY: "center",
        angle: layer.angle,
        scaleX: layer.scaleX,
        scaleY: layer.scaleY,
        fontFamily: layer.fontFamily,
        fontSize: layer.fontSize,
        fill: layer.fill,
        fontWeight: layer.fontWeight ?? "normal",
        textAlign: layer.textAlign ?? "center",
        ...(layer.stroke
          ? {
              stroke: layer.stroke,
              strokeWidth: layer.strokeWidth ?? 2,
              paintFirst: "stroke" as const,
            }
          : {}),
      });
      t.set({ flipX: layer.flipX ?? false, flipY: layer.flipY ?? false });
      (t as Tagged).dexoKind = "text";
      attachEmptyTextCleanup(t);
      canvas.add(t);
      last = t;
    } else if (layer.kind === "arrow") {
      const obj = new Path(
        arrowPathString(layer.x1, layer.y1, layer.x2, layer.y2, layer.strokeWidth),
        {
          stroke: layer.stroke,
          strokeWidth: layer.strokeWidth,
          fill: "",
          strokeLineCap: "round",
          strokeLineJoin: "round",
          originX: "left",
          originY: "top",
          objectCaching: false,
          perPixelTargetFind: true,
          lockRotation: true,
          lockScalingX: true,
          lockScalingY: true,
          hasBorders: false,
        },
      ) as Path & Tagged;
      obj.dexoKind = "arrow";
      obj.dexoArrow = {
        relX1: layer.x1 - (obj.left ?? 0),
        relY1: layer.y1 - (obj.top ?? 0),
        relX2: layer.x2 - (obj.left ?? 0),
        relY2: layer.y2 - (obj.top ?? 0),
      };
      obj.controls = { p1: makeEndpointControl(1), p2: makeEndpointControl(2) };
      canvas.add(obj);
      last = obj;
    } else {
      const e = new Ellipse({
        left: layer.left,
        top: layer.top,
        originX: "center",
        originY: "center",
        rx: layer.rx,
        ry: layer.ry,
        angle: layer.angle,
        fill: "transparent",
        stroke: layer.stroke,
        strokeWidth: layer.strokeWidth,
        strokeUniform: true,
      });
      (e as Tagged).dexoKind = "ellipse";
      canvas.add(e);
      last = e;
    }
  }
  if (opts.select && last) canvas.setActiveObject(last);
  canvas.requestRenderAll();
}

/**
 * Remapeia as anotações quando o CANVAS muda de tamanho (troca de preset):
 * posições escalam por eixo; tamanhos (fonte/traço/raios em x-y) seguem os
 * fatores correspondentes. Sem isto, as camadas ficariam nas coordenadas do
 * canvas ANTIGO — fora do export e impossíveis de arrastar de volta.
 */
export function remapAnnotations(
  canvas: Canvas,
  oldSize: { width: number; height: number },
  newSize: { width: number; height: number },
): void {
  if (
    (oldSize.width === newSize.width && oldSize.height === newSize.height) ||
    oldSize.width <= 0 ||
    oldSize.height <= 0
  ) {
    return;
  }
  const fx = newSize.width / oldSize.width;
  const fy = newSize.height / oldSize.height;
  const fs = Math.min(fx, fy);
  for (const obj of listAnnotations(canvas)) {
    const k = kindOf(obj);
    if (k === "arrow") {
      const p = obj as Path & Tagged;
      const abs = arrowAbsEndpoints(p);
      p.set({
        strokeWidth: Math.max(2, Math.round((p.strokeWidth ?? 6) * fs)),
      });
      rebuildArrowPath(p, abs.x1 * fx, abs.y1 * fy, abs.x2 * fx, abs.y2 * fy);
    } else if (k === "ellipse") {
      const e = obj as unknown as Ellipse;
      e.set({
        left: (e.left ?? 0) * fx,
        top: (e.top ?? 0) * fy,
        rx: (e.rx ?? 10) * fx,
        ry: (e.ry ?? 10) * fy,
      });
      e.setCoords();
    } else if (k === "text") {
      obj.set({
        left: (obj.left ?? 0) * fx,
        top: (obj.top ?? 0) * fy,
        scaleX: (obj.scaleX ?? 1) * fs,
        scaleY: (obj.scaleY ?? 1) * fs,
      });
      obj.setCoords();
    }
  }
  canvas.requestRenderAll();
}

/** Base travada fora do modo "Mover peça": anotar não pode arrastar a peça. */
export function setBaseInteractive(canvas: Canvas, interactive: boolean): void {
  const base = canvas.getObjects().find((o) => kindOf(o) === "base");
  if (!base) return;
  if (base.selectable === interactive && base.evented === interactive) {
    return; // chamado a cada render do dialog — no-op sem mudança
  }
  base.set({ selectable: interactive, evented: interactive });
  if (!interactive && canvas.getActiveObject() === base) {
    canvas.discardActiveObject();
  }
  canvas.requestRenderAll();
}
