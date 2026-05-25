import { describe, it, expect } from "vitest";
import { normalizeQuality, InvalidQualityError } from "./quality";

describe("normalizeQuality", () => {
  it("retorna undefined para undefined, null e string vazia", () => {
    expect(normalizeQuality(undefined)).toBeUndefined();
    expect(normalizeQuality(null)).toBeUndefined();
    expect(normalizeQuality("")).toBeUndefined();
    expect(normalizeQuality("   ")).toBeUndefined();
  });

  it("aceita os 4 valores canônicos do enum em UPPERCASE", () => {
    expect(normalizeQuality("SUCATA")).toBe("SUCATA");
    expect(normalizeQuality("SEMINOVO")).toBe("SEMINOVO");
    expect(normalizeQuality("NOVO")).toBe("NOVO");
    expect(normalizeQuality("RECONDICIONADO")).toBe("RECONDICIONADO");
  });

  it("normaliza case (lowercase/Mixed) para o valor do enum", () => {
    expect(normalizeQuality("seminovo")).toBe("SEMINOVO");
    expect(normalizeQuality("Seminovo")).toBe("SEMINOVO");
    expect(normalizeQuality("sucata")).toBe("SUCATA");
    expect(normalizeQuality("Recondicionado")).toBe("RECONDICIONADO");
  });

  it("trim espaços antes da validação", () => {
    expect(normalizeQuality("  SEMINOVO  ")).toBe("SEMINOVO");
    expect(normalizeQuality("\tNOVO\n")).toBe("NOVO");
  });

  it("rejeita 'USADO' (caso reportado) com mensagem listando os aceitos", () => {
    expect(() => normalizeQuality("USADO")).toThrow(InvalidQualityError);
    try {
      normalizeQuality("USADO");
    } catch (err) {
      expect((err as Error).message).toContain("USADO");
      expect((err as Error).message).toContain("SUCATA");
      expect((err as Error).message).toContain("SEMINOVO");
      expect((err as Error).message).toContain("NOVO");
      expect((err as Error).message).toContain("RECONDICIONADO");
    }
  });

  it("rejeita aliases comuns que poderiam ser ambíguos", () => {
    expect(() => normalizeQuality("USED")).toThrow(InvalidQualityError);
    expect(() => normalizeQuality("NEW")).toThrow(InvalidQualityError);
    expect(() => normalizeQuality("DESCONHECIDO")).toThrow(InvalidQualityError);
  });

  it("rejeita não-string com mensagem útil", () => {
    expect(() => normalizeQuality(123)).toThrow(InvalidQualityError);
    expect(() => normalizeQuality({})).toThrow(InvalidQualityError);
    expect(() => normalizeQuality([])).toThrow(InvalidQualityError);
    expect(() => normalizeQuality(true)).toThrow(InvalidQualityError);
  });
});
