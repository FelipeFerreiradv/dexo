import { describe, it, expect } from "vitest";
import { OlxPayloadBuilderService } from "../olx-payload-builder.service";

describe("OlxPayloadBuilderService.buildId — colisão e idempotência", () => {
  it("dois SKUs que colidem nos primeiros 19 chars produzem ids DIFERENTES", () => {
    // Ambos têm o mesmo prefixo sanitizado de 19+ chars, mas divergem depois.
    const skuA = "PREFIXO_IGUAL_LONGO_A";
    const skuB = "PREFIXO_IGUAL_LONGO_B";

    const idA = OlxPayloadBuilderService.buildId({ sku: skuA });
    const idB = OlxPayloadBuilderService.buildId({ sku: skuB });

    expect(idA).not.toBe(idB);
  });

  it("o mesmo SKU sempre produz o mesmo id (idempotência)", () => {
    const sku = "PREFIXO_IGUAL_LONGO_A";
    const id1 = OlxPayloadBuilderService.buildId({ sku });
    const id2 = OlxPayloadBuilderService.buildId({ sku });
    const id3 = OlxPayloadBuilderService.buildId({ sku });

    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
  });

  it("todos os ids gerados respeitam o charset e o tamanho máximo da OLX", () => {
    const skus = [
      "PREFIXO_IGUAL_LONGO_A",
      "PREFIXO_IGUAL_LONGO_B",
      "curto",
      "",
      "SKU/COM#CHARS!INVALIDOS_E_MUITO_LONGO",
      "ABC123",
    ];

    for (const sku of skus) {
      const id = OlxPayloadBuilderService.buildId({ sku });
      expect(id.length).toBeGreaterThanOrEqual(1);
      expect(id.length).toBeLessThanOrEqual(19);
      expect(id).toMatch(/^[A-Za-z0-9_{}-]{1,19}$/);
    }
  });

  it("SKU curto que já cabe em 19 chars é retornado sem alteração", () => {
    expect(OlxPayloadBuilderService.buildId({ sku: "ABC123" })).toBe("ABC123");
    expect(OlxPayloadBuilderService.buildId({ sku: "S1" })).toBe("S1");
  });

  it("fallback sem SKU gera id estável e único (não o literal 'sku')", () => {
    const id = OlxPayloadBuilderService.buildId({});
    // Não deve ser o literal antigo "sku" (que colidiria em todos os produtos sem SKU)
    expect(id).toMatch(/^sku_[0-9a-z]{4}$/);
    // Determinístico
    expect(OlxPayloadBuilderService.buildId({})).toBe(id);
  });

  it("dois SKUs que não excedem 19 chars nunca colidem entre si", () => {
    // SKUs distintos e curtos devem ser distintos (sem hash aplicado)
    const id1 = OlxPayloadBuilderService.buildId({ sku: "AAA" });
    const id2 = OlxPayloadBuilderService.buildId({ sku: "BBB" });
    expect(id1).not.toBe(id2);
  });
});
