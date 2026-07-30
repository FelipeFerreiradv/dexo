import { describe, expect, it } from "vitest";

import {
  buildRecipeV1,
  initialBaseTransform,
  isEditRecipeV1,
} from "../components/image-editor/recipe";
import {
  DEFAULT_PADDING_PCT,
  EDITOR_PRESETS,
  presetExportSize,
  resolvePreset,
} from "../components/image-editor/presets";
import {
  beginPinch,
  clampZoom,
  pinchZoom,
  wheelZoom,
} from "../components/image-editor/pointer-math";

describe("presets do editor", () => {
  it("preset desconhecido cai no default (ML 1200×1200)", () => {
    expect(resolvePreset("nao-existe").id).toBe("ml-1200");
  });

  it("export do preset fixo usa as dimensões do preset; 'original' usa a fonte", () => {
    const ml = resolvePreset("ml-1200");
    expect(presetExportSize(ml, { width: 800, height: 600 })).toEqual({
      width: 1200,
      height: 1200,
    });
    const original = resolvePreset("original");
    expect(presetExportSize(original, { width: 1440, height: 1080 })).toEqual({
      width: 1440,
      height: 1080,
    });
  });

  it("todos os presets fixos cabem no teto de 1600px do pipeline", () => {
    for (const p of EDITOR_PRESETS) {
      if (p.width && p.height) {
        expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(1600);
      }
    }
  });
});

describe("EditRecipeV1", () => {
  it("buildRecipeV1 produz receita serializável e válida", () => {
    const recipe = buildRecipeV1({
      presetId: "ml-1200",
      canvas: { width: 1200, height: 1200 },
      source: { fileName: "abc.png", width: 1490, height: 1600 },
      cutoutFileName: "abc.png",
      background: { mode: "white" },
      paddingPct: DEFAULT_PADDING_PCT,
      base: { left: 600, top: 600, scaleX: 0.66, scaleY: 0.66, angle: 0 },
    });
    expect(recipe.version).toBe(1);
    expect(isEditRecipeV1(recipe)).toBe(true);
    // Round-trip JSON sem perda (é o que vai para ProductImageEdit.recipe).
    expect(isEditRecipeV1(JSON.parse(JSON.stringify(recipe)))).toBe(true);
    expect(recipe.layers).toEqual([]);
  });

  it("isEditRecipeV1 rejeita lixo e versões futuras", () => {
    expect(isEditRecipeV1(null)).toBe(false);
    expect(isEditRecipeV1({})).toBe(false);
    expect(isEditRecipeV1({ version: 2 })).toBe(false);
    expect(isEditRecipeV1("recipe")).toBe(false);
  });

  it("initialBaseTransform centraliza e escala pelo encaixe contain × margem", () => {
    // Canvas 1200×1200, fonte 1600×1200 (paisagem): contain = 1200/1600 = 0.75.
    const t = initialBaseTransform(
      { width: 1200, height: 1200 },
      { width: 1600, height: 1200 },
      88,
    );
    expect(t.left).toBe(600);
    expect(t.top).toBe(600);
    expect(t.scaleX).toBeCloseTo(0.75 * 0.88, 5);
    expect(t.scaleY).toBe(t.scaleX);
    expect(t.angle).toBe(0);
  });

  it("initialBaseTransform clampa margens absurdas (10–100%)", () => {
    const tiny = initialBaseTransform(
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
      1,
    );
    expect(tiny.scaleX).toBeCloseTo(0.1, 5);
    const over = initialBaseTransform(
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
      250,
    );
    expect(over.scaleX).toBeCloseTo(1, 5);
  });
});

describe("pointer-math (pinch/zoom)", () => {
  it("clampZoom respeita os limites 0.2–8", () => {
    expect(clampZoom(0.01)).toBe(0.2);
    expect(clampZoom(50)).toBe(8);
    expect(clampZoom(1.5)).toBe(1.5);
  });

  it("pinch: afastar os dedos 2x dobra o zoom a partir do inicial", () => {
    const a = { id: 1, x: 100, y: 100 };
    const b = { id: 2, x: 200, y: 100 };
    const state = beginPinch(a, b, 1);
    const zoomed = pinchZoom(state, { ...a, x: 50 }, { ...b, x: 250 });
    expect(zoomed).toBeCloseTo(2, 5);
  });

  it("wheel: delta negativo aproxima, positivo afasta, sempre clampado", () => {
    expect(wheelZoom(1, -400)).toBeGreaterThan(1);
    expect(wheelZoom(1, 400)).toBeLessThan(1);
    expect(wheelZoom(8, -10_000)).toBe(8);
  });
});
