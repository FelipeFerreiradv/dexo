import { afterEach, describe, expect, it, vi } from "vitest";

import {
  shouldReuseNumero,
  isNfeReemissaoRejeitadaEnabled,
  type ReuseDecisionInput,
} from "../../app/fiscal/domain/nfe-number-reuse";

/**
 * Núcleo da feature de reemissão: a decisão de REAPROVEITAR o número (rejeição
 * comum, número não consumido pela SEFAZ) vs RESERVAR um novo (rascunho novo,
 * denegada/duplicidade, ambiente trocado, flag off). É a regra fiscal mais
 * sensível — testada de forma isolada e exaustiva.
 */

// Base de uma nota REJEITADA reaproveitável: REJECTED, número positivo,
// ambiente HOMOLOGACAO, cStat 270 (rejeição de validação → categoria "rejeitada").
const base: ReuseDecisionInput = {
  status: "REJECTED",
  numero: 20,
  ambiente: "HOMOLOGACAO",
  cStatRejeicao: 270,
};

describe("shouldReuseNumero", () => {
  it("reaproveita: REJECTED + número>0 + mesmo ambiente + rejeição comum + flag on", () => {
    expect(shouldReuseNumero(base, "HOMOLOGACAO", true)).toBe(true);
  });

  it("NÃO reaproveita quando a flag está desligada (comportamento atual)", () => {
    expect(shouldReuseNumero(base, "HOMOLOGACAO", false)).toBe(false);
  });

  it("NÃO reaproveita rascunho novo (numero placeholder negativo) → reserva", () => {
    const draftNovo: ReuseDecisionInput = {
      status: "DRAFT",
      numero: -1,
      ambiente: "HOMOLOGACAO",
      cStatRejeicao: null,
    };
    expect(shouldReuseNumero(draftNovo, "HOMOLOGACAO", true)).toBe(false);
  });

  it("NÃO reaproveita REJECTED ainda sem número real (numero<=0)", () => {
    expect(
      shouldReuseNumero({ ...base, numero: -3 }, "HOMOLOGACAO", true),
    ).toBe(false);
    expect(shouldReuseNumero({ ...base, numero: 0 }, "HOMOLOGACAO", true)).toBe(
      false,
    );
  });

  it("NÃO reaproveita DENEGADA (cStat 110) — número consumido na SEFAZ", () => {
    expect(
      shouldReuseNumero({ ...base, cStatRejeicao: 110 }, "HOMOLOGACAO", true),
    ).toBe(false);
  });

  it("NÃO reaproveita DUPLICIDADE (204/218/539) — nota já autorizada", () => {
    for (const cStat of [204, 218, 539, 573]) {
      expect(
        shouldReuseNumero(
          { ...base, cStatRejeicao: cStat },
          "HOMOLOGACAO",
          true,
        ),
      ).toBe(false);
    }
  });

  it("NÃO reaproveita 'nao consta' (217) — conservador", () => {
    expect(
      shouldReuseNumero({ ...base, cStatRejeicao: 217 }, "HOMOLOGACAO", true),
    ).toBe(false);
  });

  it("NÃO reaproveita quando o ambiente mudou entre tentativas", () => {
    // Número reservado em HOMOLOGACAO, retry agora em PRODUCAO → reserva novo.
    expect(shouldReuseNumero(base, "PRODUCAO", true)).toBe(false);
  });

  it("NÃO reaproveita legado sem cStat persistido (null/undefined) — conservador", () => {
    expect(
      shouldReuseNumero({ ...base, cStatRejeicao: null }, "HOMOLOGACAO", true),
    ).toBe(false);
    expect(
      shouldReuseNumero(
        { ...base, cStatRejeicao: undefined },
        "HOMOLOGACAO",
        true,
      ),
    ).toBe(false);
  });

  it("NÃO reaproveita nota não-rejeitada (ex.: AUTHORIZED)", () => {
    expect(
      shouldReuseNumero({ ...base, status: "AUTHORIZED" }, "HOMOLOGACAO", true),
    ).toBe(false);
  });

  it("reaproveita várias faixas de rejeição comum (200-599 fora de duplicidade)", () => {
    for (const cStat of [225, 270, 280, 598]) {
      expect(
        shouldReuseNumero(
          { ...base, cStatRejeicao: cStat },
          "HOMOLOGACAO",
          true,
        ),
      ).toBe(true);
    }
  });
});

describe("isNfeReemissaoRejeitadaEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("true somente quando a env é exatamente 'true'", () => {
    vi.stubEnv("NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED", "true");
    expect(isNfeReemissaoRejeitadaEnabled()).toBe(true);
  });

  it("false quando ausente, vazia ou diferente de 'true'", () => {
    vi.stubEnv("NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED", "");
    expect(isNfeReemissaoRejeitadaEnabled()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED", "1");
    expect(isNfeReemissaoRejeitadaEnabled()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED", "false");
    expect(isNfeReemissaoRejeitadaEnabled()).toBe(false);
  });
});
