import { describe, expect, it } from "vitest";
import {
  ESTADOS_CONSUMIDOS,
  ESTADOS_RESERVA,
  ESTADOS_REUSAVEIS,
  ESTADOS_VIVOS,
  TRANSICOES,
  TransicaoInvalidaError,
  assertTransicao,
  isEstadoReserva,
  podeTransicionar,
  type EstadoReserva,
} from "../../../app/fiscal/numeracao/estados";
import * as tipos from "../../../app/fiscal/numeracao/tipos";

// Matriz COMPLETA 11×11: cada par (de, para) tem expectativa explícita.
const PERMITIDAS: Record<EstadoReserva, EstadoReserva[]> = {
  RESERVADO: ["EM_TRANSMISSAO", "ABANDONADO", "INUTILIZADO", "CONSUMIDO_EXTERNO"],
  REJEITADO: ["EM_TRANSMISSAO", "ABANDONADO", "INUTILIZADO", "CONSUMIDO_EXTERNO"],
  EM_TRANSMISSAO: [
    "AUTORIZADO",
    "REJEITADO",
    "RESERVADO",
    "INCERTO",
    "DENEGADO",
    "INUTILIZADO",
    "CONSUMIDO_EXTERNO",
    "BLOQUEADO",
  ],
  INCERTO: ["AUTORIZADO", "RESERVADO", "DENEGADO", "INUTILIZADO", "CONSUMIDO_EXTERNO", "BLOQUEADO", "INCERTO"],
  AUTORIZADO: ["CANCELADO", "ABANDONADO"],
  BLOQUEADO: [],
  CANCELADO: [],
  DENEGADO: [],
  INUTILIZADO: [],
  CONSUMIDO_EXTERNO: [],
  ABANDONADO: ["INUTILIZADO"],
};

const MATRIZ = ESTADOS_RESERVA.flatMap((de) =>
  ESTADOS_RESERVA.map((para) => [de, para, PERMITIDAS[de].includes(para)] as const),
);

describe("estados da reserva", () => {
  it("11 estados, sem repetição, iguais ao CHECK do DDL", () => {
    expect(ESTADOS_RESERVA).toHaveLength(11);
    expect(new Set(ESTADOS_RESERVA).size).toBe(11);
    expect([...ESTADOS_RESERVA].sort()).toEqual(
      [
        "ABANDONADO",
        "AUTORIZADO",
        "BLOQUEADO",
        "CANCELADO",
        "CONSUMIDO_EXTERNO",
        "DENEGADO",
        "EM_TRANSMISSAO",
        "INCERTO",
        "INUTILIZADO",
        "REJEITADO",
        "RESERVADO",
      ].sort(),
    );
  });

  it("reexporta os conjuntos de ./tipos (mesma referência, sem duplicar)", () => {
    expect(ESTADOS_REUSAVEIS).toBe(tipos.ESTADOS_REUSAVEIS);
    expect(ESTADOS_VIVOS).toBe(tipos.ESTADOS_VIVOS);
    expect(ESTADOS_CONSUMIDOS).toBe(tipos.ESTADOS_CONSUMIDOS);
  });

  it("TRANSICOES tem uma entrada por estado e só aponta para estados válidos", () => {
    expect(Object.keys(TRANSICOES).sort()).toEqual([...ESTADOS_RESERVA].sort());
    for (const destinos of Object.values(TRANSICOES)) {
      for (const d of destinos) expect(isEstadoReserva(d)).toBe(true);
    }
  });

  it("isEstadoReserva", () => {
    expect(isEstadoReserva("INCERTO")).toBe(true);
    expect(isEstadoReserva("incerto")).toBe(false);
    expect(isEstadoReserva("LIBERADO")).toBe(false);
    expect(isEstadoReserva(null)).toBe(false);
    expect(isEstadoReserva(3)).toBe(false);
  });
});

describe("matriz de transições (121 pares)", () => {
  it.each(MATRIZ)("%s → %s = %s", (de, para, permitido) => {
    expect(podeTransicionar(de, para)).toBe(permitido);
    if (permitido) {
      expect(() => assertTransicao(de, para)).not.toThrow();
    } else {
      expect(() => assertTransicao(de, para)).toThrow(TransicaoInvalidaError);
    }
  });
});

describe("proibições que protegem contra número queimado ou duplicado", () => {
  it.each([
    ["INCERTO", "ABANDONADO"],
    ["EM_TRANSMISSAO", "ABANDONADO"],
    ["INCERTO", "REJEITADO"],
    ["INCERTO", "EM_TRANSMISSAO"],
    ["EM_TRANSMISSAO", "EM_TRANSMISSAO"],
    ["AUTORIZADO", "RESERVADO"],
    ["AUTORIZADO", "REJEITADO"],
    ["CANCELADO", "AUTORIZADO"],
    ["DENEGADO", "RESERVADO"],
    ["INUTILIZADO", "RESERVADO"],
    ["CONSUMIDO_EXTERNO", "RESERVADO"],
    ["ABANDONADO", "RESERVADO"],
    ["ABANDONADO", "EM_TRANSMISSAO"],
    ["BLOQUEADO", "AUTORIZADO"],
    ["BLOQUEADO", "RESERVADO"],
    ["RESERVADO", "AUTORIZADO"],
    ["REJEITADO", "INCERTO"],
  ])("%s → %s é proibida", (de, para) => {
    expect(podeTransicionar(de, para)).toBe(false);
  });

  it("estados consumidos não voltam a ser reusáveis", () => {
    for (const de of ESTADOS_CONSUMIDOS) {
      for (const para of ESTADOS_REUSAVEIS) {
        expect(podeTransicionar(de, para)).toBe(false);
      }
    }
  });

  it("nenhum estado vai para EM_TRANSMISSAO sem ser reusável", () => {
    for (const de of ESTADOS_RESERVA) {
      expect(podeTransicionar(de, "EM_TRANSMISSAO")).toBe((ESTADOS_REUSAVEIS as readonly string[]).includes(de));
    }
  });

  it("ABANDONADO só pode ser inutilizado (sem pool de reuso)", () => {
    expect(TRANSICOES.ABANDONADO).toEqual(["INUTILIZADO"]);
  });
});

describe("assertTransicao", () => {
  it("erro carrega código, de e para", () => {
    try {
      assertTransicao("INCERTO", "ABANDONADO");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TransicaoInvalidaError);
      const e = err as TransicaoInvalidaError;
      expect(e.code).toBe("NUMERACAO_TRANSICAO_INVALIDA");
      expect(e.de).toBe("INCERTO");
      expect(e.para).toBe("ABANDONADO");
      expect(e.message).toContain("INCERTO → ABANDONADO");
    }
  });

  it("estados desconhecidos lançam", () => {
    expect(() => assertTransicao("LIBERADO", "RESERVADO")).toThrow(TransicaoInvalidaError);
    expect(() => assertTransicao("RESERVADO", undefined)).toThrow(TransicaoInvalidaError);
  });
});
