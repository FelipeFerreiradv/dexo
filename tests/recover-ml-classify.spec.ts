import { describe, it, expect } from "vitest";
import {
  classifyRecoverRow,
  type RecoverInput,
} from "../scripts/lib/recover-ml-classify";

/**
 * Classificação da recuperação de anúncios ML presos. Regra de ouro: nada que
 * possa duplicar anúncio é re-armado, e dado que só a pessoa corrige não é
 * re-armado às cegas.
 */

const base = (over: Partial<RecoverInput> = {}): RecoverInput => ({
  accountActive: true,
  liveLocal: null,
  remote: { status: "ok", adoptable: null, others: [] },
  preflight: { blocked: false, message: null },
  lastError:
    'Erro ao criar item: {"cause":[{"cause_id":369,"code":"body.required_fields"}]}',
  editedAfterError: false,
  ...over,
});

describe("classifyRecoverRow", () => {
  it("369 mascarado, sem bloqueio, nada no ML ⇒ publicavel", () => {
    expect(classifyRecoverRow(base()).classe).toBe("publicavel");
  });

  it("conta inativa vence tudo", () => {
    expect(
      classifyRecoverRow(base({ accountActive: false, liveLocal: { externalListingId: "MLB1", status: "active" } }))
        .classe,
    ).toBe("conta_inativa");
  });

  it("anúncio vivo local ⇒ ja_publicado (nunca re-arma)", () => {
    const d = classifyRecoverRow(
      base({ liveLocal: { externalListingId: "MLB5188503789", status: "active" } }),
    );
    expect(d.classe).toBe("ja_publicado");
    expect(d.motivo).toContain("MLB5188503789");
  });

  it("item criado no ML depois do pendente ⇒ adotar", () => {
    const d = classifyRecoverRow(
      base({ remote: { status: "ok", adoptable: { id: "MLB9", status: "active" }, others: [] } }),
    );
    expect(d.classe).toBe("adotar");
  });

  it("outro anúncio VIVO com o mesmo SKU ⇒ duplicidade_possivel (não publica)", () => {
    const d = classifyRecoverRow(
      base({
        remote: {
          status: "ok",
          adoptable: null,
          others: [{ id: "MLB7", status: "paused", title: "Farol Gol G5" }],
        },
      }),
    );
    expect(d.classe).toBe("duplicidade_possivel");
    expect(d.motivo).toMatch(/MLB7 \(paused\) "Farol Gol G5"/);
  });

  it("anúncio ENCERRADO com o mesmo SKU não impede", () => {
    expect(
      classifyRecoverRow(
        base({
          remote: { status: "ok", adoptable: null, others: [{ id: "MLB7", status: "closed" }] },
        }),
      ).classe,
    ).toBe("publicavel");
  });

  it.each(["search_failed", "not_checked"] as const)(
    "busca no ML %s ⇒ nao_verificado (sem conferir duplicidade não re-arma)",
    (status) => {
      expect(classifyRecoverRow(base({ remote: { status } })).classe).toBe("nao_verificado");
    },
  );

  it("sem SKU (não dá para buscar) segue a pré-validação", () => {
    expect(classifyRecoverRow(base({ remote: { status: "skipped" } })).classe).toBe(
      "publicavel",
    );
  });

  it("pré-validação bloqueia ⇒ precisa_cliente com a mensagem dela", () => {
    const d = classifyRecoverRow(
      base({ preflight: { blocked: true, message: 'O campo GTIN está com "2033029"' } }),
    );
    expect(d).toEqual({ classe: "precisa_cliente", motivo: 'O campo GTIN está com "2033029"' });
  });

  it.each([
    'O valor que você inseriu em "Número de registro/certificação INMETRO" está incorreto.',
    "A categoria MLB7863 do Mercado Livre exige o campo Número da Peça. Preencha…",
    "[TERMINAL][CORRIGIVEL] As medidas da embalagem parecem erradas (5401)",
    'Erro ao criar item: {"cause":[{"code":"item.pictures.invalid_size"}]}',
  ])("erro que a pré-validação não vê e produto NÃO editado ⇒ precisa_cliente: %s", (lastError) => {
    const d = classifyRecoverRow(base({ lastError }));
    expect(d.classe).toBe("precisa_cliente");
    expect(d.motivo.startsWith("[")).toBe(false);
  });

  it("mesmo erro, mas produto editado depois ⇒ publicavel (a pessoa pode ter corrigido)", () => {
    expect(
      classifyRecoverRow(
        base({
          lastError: 'O valor que você inseriu em "Número de registro/certificação INMETRO" está incorreto.',
          editedAfterError: true,
        }),
      ).classe,
    ).toBe("publicavel");
  });

  it("GTIN antigo sem bloqueio atual (corrigido) ⇒ publicavel", () => {
    expect(
      classifyRecoverRow(
        base({ lastError: 'O campo GTIN do produto está em formato inválido ("original").' }),
      ).classe,
    ).toBe("publicavel");
  });
});
