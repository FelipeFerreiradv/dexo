import { describe, expect, it } from "vitest";

import {
  arrowHeadLength,
  arrowHeadPoints,
  arrowPathString,
} from "../components/image-editor/tools/arrow-geometry";
import {
  type AnnotationLayerV1,
  isAnnotationLayerV1,
  readAnnotationLayers,
  shouldWarnMlAnnotations,
} from "../components/image-editor/recipe";

describe("arrow-geometry (pura)", () => {
  it("cabeça proporcional à espessura com piso legível", () => {
    expect(arrowHeadLength(1)).toBe(18); // piso
    expect(arrowHeadLength(10)).toBe(40); // 4x
  });

  it("pernas da cabeça a ±30° apontando para (x2,y2) — seta horizontal", () => {
    const { hx1, hy1, hx2, hy2 } = arrowHeadPoints(0, 0, 100, 0, 20);
    // Direção 0°: pernas recuam ~17.3px em x e abrem simétricas ±10px em y.
    expect(hx1).toBeCloseTo(100 - 20 * Math.cos(Math.PI / 6), 5);
    expect(hx2).toBeCloseTo(hx1, 5);
    expect(hy1).toBeCloseTo(-hy2, 5);
    expect(Math.abs(hy1)).toBeCloseTo(10, 5);
  });

  it("path completo: haste + duas pernas, tudo terminando no endpoint", () => {
    const d = arrowPathString(10, 20, 200, 80, 8);
    expect(d).toMatch(/^M 10 20 L 200 80 M .+ L 200 80 L .+$/);
  });

  it("seta vertical não degenera (atan2 cobre todos os quadrantes)", () => {
    const d = arrowPathString(50, 200, 50, 20, 6);
    expect(d).toContain("L 50 20");
    const { hy1, hy2 } = arrowHeadPoints(50, 200, 50, 20, 24);
    // Apontando para CIMA: as pernas ficam ABAIXO da ponta.
    expect(hy1).toBeGreaterThan(20);
    expect(hy2).toBeGreaterThan(20);
  });
});

describe("camadas de anotação da receita (V1)", () => {
  const text: AnnotationLayerV1 = {
    kind: "text",
    text: "MOTOR 1.6",
    left: 600,
    top: 200,
    angle: 0,
    scaleX: 1,
    scaleY: 1,
    fontFamily: "Inter",
    fontSize: 64,
    fill: "#f2c419",
    fontWeight: "bold",
    stroke: "#111111",
    strokeWidth: 4,
  };
  const arrow: AnnotationLayerV1 = {
    kind: "arrow",
    x1: 100,
    y1: 500,
    x2: 400,
    y2: 300,
    stroke: "#e11d48",
    strokeWidth: 8,
  };
  const ellipse: AnnotationLayerV1 = {
    kind: "ellipse",
    left: 700,
    top: 700,
    rx: 120,
    ry: 90,
    angle: 15,
    stroke: "#2563eb",
    strokeWidth: 6,
  };

  it("guard aceita as 3 formas e sobrevive a round-trip JSON", () => {
    for (const layer of [text, arrow, ellipse]) {
      expect(isAnnotationLayerV1(layer)).toBe(true);
      expect(isAnnotationLayerV1(JSON.parse(JSON.stringify(layer)))).toBe(true);
    }
  });

  it("guard rejeita lixo, kinds futuros e shapes truncados", () => {
    expect(isAnnotationLayerV1(null)).toBe(false);
    expect(isAnnotationLayerV1({ kind: "sticker" })).toBe(false);
    expect(isAnnotationLayerV1({ kind: "arrow", x1: 1 })).toBe(false);
    expect(isAnnotationLayerV1({ kind: "text" })).toBe(false);
  });

  it("readAnnotationLayers: restore PARCIAL — descarta só o ilegível", () => {
    const mixed = [text, { kind: "hologram" }, arrow, null, ellipse];
    const out = readAnnotationLayers(mixed);
    expect(out).toHaveLength(3);
    expect(out.map((l) => l.kind)).toEqual(["text", "arrow", "ellipse"]);
  });

  it("readAnnotationLayers tolera não-array", () => {
    expect(readAnnotationLayers(undefined as never)).toEqual([]);
    expect(readAnnotationLayers("x" as never)).toEqual([]);
  });
});

describe("warning ML (não-bloqueante)", () => {
  it("dispara SÓ com preset ML e pelo menos 1 anotação", () => {
    expect(shouldWarnMlAnnotations("ml-1200", 1)).toBe(true);
    expect(shouldWarnMlAnnotations("ml-1200", 0)).toBe(false);
    expect(shouldWarnMlAnnotations("shopee-1024", 3)).toBe(false);
    expect(shouldWarnMlAnnotations("original", 2)).toBe(false);
  });
});
