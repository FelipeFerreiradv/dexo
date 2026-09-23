import { describe, it, expect } from "vitest";
import {
  buildCompatDiagnostics,
  compatDiagnosticsNeedsResend,
} from "../app/marketplaces/lib/ml-compat-diagnostics";

describe("compatDiagnosticsNeedsResend (critério do backfill)", () => {
  it("assinatura do defeito de paginação (nada gravado, 1500 fetched) ⇒ reenviar", () => {
    expect(
      compatDiagnosticsNeedsResend({
        strategy: "none",
        persisted: 0,
        verified: true,
        unresolved: 1,
        unresolvedSample: [
          {
            brand: "Ford",
            model: "Fiesta",
            year: 2002,
            reason:
              "no catalog products for 2002 (0 of 1500 matched year; 1500 total fetched)",
          },
        ],
      }),
    ).toBe(true);
  });

  it("parcial (algum veículo não resolvido) ⇒ reenviar", () => {
    expect(
      compatDiagnosticsNeedsResend({ persisted: 8, unresolved: 2, verified: true }),
    ).toBe(true);
  });

  it("truncado ⇒ reenviar", () => {
    expect(
      compatDiagnosticsNeedsResend({
        persisted: 8,
        unresolved: 0,
        truncated: [{ brand: "Ford", model: "Ka", fetched: 50, total: 209 }],
      }),
    ).toBe(true);
  });

  it("categoria sem suporte ⇒ NÃO (reenviar não muda nada)", () => {
    expect(
      compatDiagnosticsNeedsResend({
        persisted: 0,
        unresolved: 0,
        unsupportedDomain: "MLB-VEHICLE_FRAMES",
      }),
    ).toBe(false);
  });

  it("tudo gravado ⇒ NÃO; sem diagnóstico ⇒ NÃO", () => {
    expect(
      compatDiagnosticsNeedsResend({ persisted: 57, unresolved: 0, verified: true }),
    ).toBe(false);
    expect(compatDiagnosticsNeedsResend(null)).toBe(false);
    expect(compatDiagnosticsNeedsResend([])).toBe(false);
  });
});
import { describeCompatDiagnostics } from "../app/produtos/lib/listing-compat-summary";

const NOW = new Date("2026-09-22T20:00:00.000Z");

const base = {
  requested: 3,
  persisted: 12,
  strategy: "catalog_products",
  verified: true,
  unresolved: [] as Array<{
    brand: string;
    model: string;
    year?: number | null;
    reason: string;
  }>,
};

describe("buildCompatDiagnostics", () => {
  it("mantém EXATAMENTE as chaves antigas quando não há posição/truncado", () => {
    expect(buildCompatDiagnostics(base, { now: NOW })).toEqual({
      requested: 3,
      persisted: 12,
      strategy: "catalog_products",
      verified: true,
      unresolved: 0,
      unresolvedSample: [],
      unsupportedDomain: undefined,
      at: NOW.toISOString(),
    });
  });

  it("origem do reenvio continua gravada", () => {
    expect(
      buildCompatDiagnostics(base, { origin: "product_sync", now: NOW }).origin,
    ).toBe("product_sync");
  });

  it("guarda o eco da posição (dropped = ML aceitou e jogou fora)", () => {
    const d = buildCompatDiagnostics(
      {
        ...base,
        positions: {
          requested: ["Dianteira", "Esquerda"],
          sent: [{ value_name: "Dianteira" }, { value_name: "Esquerda" }],
          unresolved: [],
          echo: "dropped",
        },
      },
      { now: NOW },
    );
    expect(d.positions).toEqual({
      requested: ["Dianteira", "Esquerda"],
      sent: ["Dianteira", "Esquerda"],
      unresolved: [],
      echo: "dropped",
    });
  });

  it("guarda até 5 pares truncados e 5 amostras não resolvidas", () => {
    const unresolved = Array.from({ length: 8 }, (_, i) => ({
      brand: "Ford",
      model: "Ka",
      year: 2000 + i,
      reason: "x",
    }));
    const truncated = Array.from({ length: 7 }, () => ({
      brand: "Ford",
      model: "Ka",
      fetched: 50,
      total: 209,
    }));
    const d = buildCompatDiagnostics(
      { ...base, unresolved, truncated },
      { now: NOW },
    );
    expect(d.unresolved).toBe(8);
    expect((d.unresolvedSample as unknown[]).length).toBe(5);
    expect((d.truncated as unknown[]).length).toBe(5);
  });
});

describe("describeCompatDiagnostics", () => {
  it("sem diagnóstico (anúncio antigo) não mostra nada", () => {
    expect(describeCompatDiagnostics(null)).toBeNull();
    expect(describeCompatDiagnostics(undefined)).toBeNull();
    expect(describeCompatDiagnostics("x")).toBeNull();
    expect(describeCompatDiagnostics([])).toBeNull();
  });

  it("confirmado no ML", () => {
    expect(
      describeCompatDiagnostics({ persisted: 57, verified: true, unresolved: 0 }),
    ).toEqual({
      tone: "ok",
      text: "Compatibilidade confirmada no Mercado Livre: 57 veículos.",
    });
  });

  it("singular", () => {
    expect(
      describeCompatDiagnostics({ persisted: 1, verified: true, unresolved: 0 })
        ?.text,
    ).toBe("Compatibilidade confirmada no Mercado Livre: 1 veículo.");
  });

  it("parcial: cita os que o catálogo do ML não tem", () => {
    const s = describeCompatDiagnostics({
      persisted: 8,
      verified: true,
      unresolved: 1,
      unresolvedSample: [{ brand: "Fiat", model: "Argo", year: 2017 }],
    });
    expect(s?.tone).toBe("warning");
    expect(s?.text).toBe(
      "Compatibilidade confirmada no Mercado Livre: 8 veículos · 1 não encontrado no catálogo do ML (ex.: Fiat Argo 2017).",
    );
  });

  it("nada gravado com veículos não achados é aviso", () => {
    const s = describeCompatDiagnostics({
      persisted: 0,
      verified: true,
      unresolved: 1,
      unresolvedSample: [{ brand: "Ford", model: "Fiesta", year: 2002 }],
    });
    expect(s).toEqual({
      tone: "warning",
      text: "Nenhum veículo foi encontrado no catálogo do Mercado Livre (ex.: Ford Fiesta 2002).",
    });
  });

  it("categoria sem suporte a compatibilidade", () => {
    expect(
      describeCompatDiagnostics({
        persisted: 0,
        verified: true,
        unsupportedDomain: "MLB-VEHICLE_FRAMES",
      }),
    ).toEqual({
      tone: "warning",
      text: "O Mercado Livre não aceita compatibilidade de veículos nesta categoria.",
    });
  });

  it("sem leitura de volta não afirma sucesso", () => {
    expect(
      describeCompatDiagnostics({ persisted: 0, verified: false })?.tone,
    ).toBe("muted");
  });

  it("posição descartada pelo ML vira aviso mesmo com veículos gravados", () => {
    const s = describeCompatDiagnostics({
      persisted: 20,
      verified: true,
      unresolved: 0,
      positions: { echo: "dropped" },
    });
    expect(s?.tone).toBe("warning");
    expect(s?.text).toContain("o ML descartou a posição (lado/eixo)");
  });

  it("truncado é sinalizado", () => {
    const s = describeCompatDiagnostics({
      persisted: 20,
      verified: true,
      unresolved: 0,
      truncated: [{ brand: "Ford", model: "Ka", fetched: 50, total: 209 }],
    });
    expect(s?.text).toContain("catálogo lido só em parte");
  });
});
