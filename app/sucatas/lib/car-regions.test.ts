import { describe, it, expect } from "vitest";
import {
  inferCarRegion,
  computeScrapPaint,
  type ScrapPaintPart,
} from "./car-regions";

describe("inferCarRegion", () => {
  it("mapeia nomes reais de autopeças para a região correta", () => {
    expect(inferCarRegion({ name: "Motor 1.0" })).toBe("motor");
    expect(inferCarRegion({ name: "Câmbio automático" })).toBe("motor");
    expect(inferCarRegion({ name: "Capô" })).toBe("capo");
    expect(inferCarRegion({ name: "Para-brisa" })).toBe("para_brisa");
    expect(inferCarRegion({ name: "Farol direito" })).toBe("farol");
    expect(inferCarRegion({ name: "Lanterna traseira" })).toBe("lanterna");
    expect(inferCarRegion({ name: "Porta-malas" })).toBe("porta_malas");
    expect(inferCarRegion({ name: "Banco do motorista" })).toBe("cabine");
  });

  it("resolve a posição (dianteira/traseira) das famílias posicionais", () => {
    expect(inferCarRegion({ name: "Porta dianteira esquerda" })).toBe(
      "porta_diant",
    );
    expect(inferCarRegion({ name: "Porta traseira direita" })).toBe(
      "porta_tras",
    );
    expect(inferCarRegion({ name: "Parachoque traseiro" })).toBe(
      "para_choque_tras",
    );
    expect(inferCarRegion({ name: "Para-choque dianteiro" })).toBe(
      "para_choque_diant",
    );
    expect(inferCarRegion({ name: "Paralama traseiro" })).toBe(
      "para_lama_tras",
    );
    expect(inferCarRegion({ name: "Pneu traseiro" })).toBe("roda_tras");
    expect(inferCarRegion({ name: "Roda dianteira" })).toBe("roda_diant");
  });

  it("sem lado explícito, cai no membro dianteiro da família (default)", () => {
    expect(inferCarRegion({ name: "Porta" })).toBe("porta_diant");
    expect(inferCarRegion({ name: "Para-choque" })).toBe("para_choque_diant");
    expect(inferCarRegion({ name: "Cubo de roda" })).toBe("roda_diant");
  });

  it("desambigua radicais parecidos pela ordem de checagem", () => {
    // "capota" é teto, não capô.
    expect(inferCarRegion({ name: "Capota" })).toBe("teto");
    // "porta-malas" não é "porta".
    expect(inferCarRegion({ name: "Tampa do porta-malas" })).toBe(
      "porta_malas",
    );
    // "para-brisa" não é "vidro lateral" nem "para-choque".
    expect(inferCarRegion({ name: "Vidro do para-brisa" })).toBe("para_brisa");
    expect(inferCarRegion({ name: "Vidro lateral traseiro" })).toBe(
      "vidro_lateral",
    );
  });

  it("também infere a partir do partNumber quando o nome não indica", () => {
    expect(inferCarRegion({ name: "", partNumber: "MOTOR-X1" })).toBe("motor");
  });

  it("retorna null quando não há palavra-chave conhecida (conta no total)", () => {
    expect(inferCarRegion({ name: "Sensor de estacionamento" })).toBeNull();
    expect(inferCarRegion({ name: "Kit de reparo genérico" })).toBeNull();
    expect(inferCarRegion({ name: "" })).toBeNull();
    expect(inferCarRegion({})).toBeNull();
  });
});

describe("computeScrapPaint", () => {
  const part = (
    name: string,
    status: "IN_STOCK" | "SOLD",
  ): ScrapPaintPart => ({ name, status });

  it("conta vendidas/total, percentual e regiões acesas", () => {
    const parts: ScrapPaintPart[] = [
      part("Motor 1.0", "SOLD"),
      part("Porta dianteira esquerda", "SOLD"),
      part("Farol direito", "IN_STOCK"),
      part("Capô", "IN_STOCK"),
    ];
    const r = computeScrapPaint(parts);

    expect(r.totalCount).toBe(4);
    expect(r.soldCount).toBe(2);
    expect(r.percent).toBe(50);
    expect([...r.soldRegions].sort()).toEqual(["motor", "porta_diant"]);
    // Regiões de peças em estoque NÃO acendem.
    expect(r.soldRegions.has("farol")).toBe(false);
    expect(r.soldRegions.has("capo")).toBe(false);
  });

  it("100% quando todas as peças estão vendidas", () => {
    const parts: ScrapPaintPart[] = [
      part("Motor", "SOLD"),
      part("Teto", "SOLD"),
    ];
    expect(computeScrapPaint(parts).percent).toBe(100);
  });

  it("totalCount === 0 não quebra (percent 0, conjuntos vazios)", () => {
    const r = computeScrapPaint([]);
    expect(r).toMatchObject({
      soldCount: 0,
      totalCount: 0,
      percent: 0,
      unmappedCount: 0,
    });
    expect(r.soldRegions.size).toBe(0);
    expect(r.soldByRegion.size).toBe(0);
  });

  it("peça vendida sem região conta no percentual mas não acende região", () => {
    const parts: ScrapPaintPart[] = [
      part("Sensor de estacionamento", "SOLD"), // sem região
      part("Motor", "IN_STOCK"),
    ];
    const r = computeScrapPaint(parts);
    expect(r.soldCount).toBe(1);
    expect(r.percent).toBe(50); // independente do mapeamento
    expect(r.soldRegions.size).toBe(0);
    expect(r.unmappedCount).toBe(1);
  });

  it("agrega o nº de peças vendidas por região (soldByRegion)", () => {
    const parts: ScrapPaintPart[] = [
      part("Motor de arranque", "SOLD"),
      part("Bloco do motor", "SOLD"),
      part("Porta dianteira", "SOLD"),
    ];
    const r = computeScrapPaint(parts);
    expect(r.soldByRegion.get("motor")).toBe(2);
    expect(r.soldByRegion.get("porta_diant")).toBe(1);
  });
});
