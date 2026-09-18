import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NfeXmlBuilderService } from "../../../app/fiscal/generators/nfe-xml-builder.service";
import { CASOS_EMISSAO } from "./__fixtures__/casos-emissao";

// GOLDEN F0 — payload JSON da Focus (NfeXmlBuilderService.build) em 1549bc4.
// Trava o formato exato que vai no corpo do POST (JSON.stringify do payload),
// inclusive o `numero_nota` que a Focus ignora (R6). Qualquer mudança com as
// flags novas desligadas tem de deixar estes arquivos byte-idênticos.
// Atualizar golden (`-u`) só com a mudança de comportamento aprovada.

describe("golden F0 — payload Focus V1 (NfeXmlBuilderService.build)", () => {
  const builder = new NfeXmlBuilderService();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-17T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  for (const caso of CASOS_EMISSAO) {
    it(caso.nome, async () => {
      vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", caso.freteFlag);
      const payload = builder.build(caso.draft(), caso.config(), caso.numero);
      await expect(JSON.stringify(payload, null, 2)).toMatchFileSnapshot(
        `./__snapshots__/focus-${caso.nome}.json`,
      );
    });
  }

  it("determinismo: dois builds do mesmo caso são idênticos", () => {
    vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", "true");
    const [caso] = CASOS_EMISSAO.filter((c) => c.nome === "frete-flag-ligada");
    const a = JSON.stringify(builder.build(caso.draft(), caso.config(), caso.numero));
    const b = JSON.stringify(builder.build(caso.draft(), caso.config(), caso.numero));
    expect(a).toBe(b);
  });
});
