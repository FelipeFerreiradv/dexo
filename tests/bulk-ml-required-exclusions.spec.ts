import { describe, it, expect } from "vitest";
import {
  withDisabledMlAccounts,
  countEffectiveItems,
} from "../app/produtos/components/bulk-review/per-product-types";
import {
  buildMlBlockedMap,
  buildMlUnresolvedMap,
  buildMlReviewCheckItems,
  mlRequiredCheckKey,
  mlCheckKeysDiverge,
  splitMlBlockedByKey,
  allMlProductsBlocked,
  mlBlockedBannerMessage,
  mlExcludedConfirmMessage,
  ML_ALL_BLOCKED_MESSAGE,
  ML_REQUIRED_UNRESOLVED_WARNING,
  type MlRequiredCheckResult,
} from "../app/produtos/components/ml-required-attributes-check.client";

/**
 * Anúncio em massa × atributos obrigatórios do ML: os produtos bloqueados saem
 * do ML pelo mecanismo que o dispatcher e a rota já entendem
 * (`perProductOverrides[pid].disabledMlAccountIds`). Lógica pura — a suíte não
 * tem jsdom, então o wizard só orquestra estas funções.
 */

describe("withDisabledMlAccounts", () => {
  it("W1: template null + bloqueado → só o skip das contas ML", () => {
    expect(withDisabledMlAccounts(null, ["p1"], ["a1", "a2"])).toEqual({
      perProductOverrides: { p1: { disabledMlAccountIds: ["a1", "a2"] } },
    });
  });

  it("W2: une sem duplicar e preserva entry.ml, Shopee e o resto do template", () => {
    const template = {
      priceRule: { type: "fixed", value: 10 },
      perProductOverrides: {
        p1: {
          ml: { categoryId: "MLB1", attributes: { SIDE: { value_id: "1" } } },
          shopee: { categoryId: "SHP_1" },
          disabledMlAccountIds: ["a2"],
          disabledShopeeAccountIds: ["s1"],
        },
        p2: { ml: { categoryId: "MLB2" } },
      },
    };
    const out = withDisabledMlAccounts(template, ["p1"], ["a1", "a2"]) as any;
    expect(out.priceRule).toEqual({ type: "fixed", value: 10 });
    expect(out.perProductOverrides.p1).toEqual({
      ml: { categoryId: "MLB1", attributes: { SIDE: { value_id: "1" } } },
      shopee: { categoryId: "SHP_1" },
      disabledMlAccountIds: ["a2", "a1"],
      disabledShopeeAccountIds: ["s1"],
    });
    expect(out.perProductOverrides.p2).toEqual({ ml: { categoryId: "MLB2" } });
    // Não muta o template de entrada.
    expect(template.perProductOverrides.p1.disabledMlAccountIds).toEqual(["a2"]);
  });

  it("W3: sem bloqueados ou sem contas ML → a MESMA referência (null continua null)", () => {
    const t = { titleSuffix: "x" };
    expect(withDisabledMlAccounts(t, [], ["a1"])).toBe(t);
    expect(withDisabledMlAccounts(t, ["p1"], [])).toBe(t);
    expect(withDisabledMlAccounts(null, [], ["a1"])).toBeNull();
    expect(withDisabledMlAccounts(null, ["p1"], [])).toBeNull();
  });

  it("W4: countEffectiveItems sobre o resultado desconta só os pares ML do bloqueado", () => {
    const out = withDisabledMlAccounts(null, ["p1"], ["a1", "a2"]) as any;
    const requests = [
      { platform: "MERCADO_LIVRE" as const, accountId: "a1" },
      { platform: "MERCADO_LIVRE" as const, accountId: "a2" },
      { platform: "SHOPEE" as const, accountId: "s1" },
    ];
    expect(
      countEffectiveItems(out.perProductOverrides, ["p1", "p2"], requests),
    ).toBe(4); // p1: só Shopee (1) + p2: tudo (3)
  });
});

const resultado = (
  key: string,
  over: Partial<MlRequiredCheckResult> = {},
): MlRequiredCheckResult => ({
  key,
  status: "ok",
  categoryId: "MLB1",
  blocking: [],
  warnings: [],
  message: null,
  ...over,
});

describe("mapas do wizard a partir da resposta", () => {
  it("só `blocked` com mensagem vira bloqueio; unknown/ok não excluem", () => {
    const res = new Map([
      ["p1", resultado("p1", { status: "blocked", message: "falta PN" })],
      ["p2", resultado("p2", { status: "unknown", unknownReason: "tags_unknown" })],
      ["p3", resultado("p3")],
      ["p4", resultado("p4", { status: "blocked", message: null })],
    ]);
    expect(buildMlBlockedMap(res)).toEqual({ p1: { message: "falta PN" } });
    expect(buildMlBlockedMap(res, { p1: "k1" })).toEqual({
      p1: { message: "falta PN", key: "k1" },
    });
    expect(buildMlBlockedMap(null)).toEqual({});
  });

  it("D4: unknown por categoria não resolvida vira aviso por linha", () => {
    const res = new Map([
      ["p1", resultado("p1", { status: "unknown", unknownReason: "category_unresolved" })],
      ["p2", resultado("p2", { status: "unknown", unknownReason: "tags_unknown" })],
    ]);
    expect(buildMlUnresolvedMap(res)).toEqual({ p1: ML_REQUIRED_UNRESOLVED_WARNING });
    expect(ML_REQUIRED_UNRESOLVED_WARNING).toBe(
      "Não foi possível validar os campos obrigatórios do Mercado Livre: sem categoria.",
    );
  });
});

describe("D8: chave avaliada × chave do envio (Revisão individual)", () => {
  it("a chave ignora a ordem das chaves da ficha e muda com categoria ou valor", () => {
    const a = mlRequiredCheckKey("MLB1", {
      SIDE: { value_id: "1", value_name: "Dir" },
      OEM: { value_name: "X" },
    });
    const b = mlRequiredCheckKey("MLB1", {
      OEM: { value_name: "X" },
      SIDE: { value_name: "Dir", value_id: "1" },
    });
    expect(a).toBe(b);
    expect(mlRequiredCheckKey("MLB2", { OEM: { value_name: "X" } })).not.toBe(
      mlRequiredCheckKey("MLB1", { OEM: { value_name: "X" } }),
    );
    expect(mlRequiredCheckKey("MLB1", { OEM: { value_name: "Y" } })).not.toBe(
      mlRequiredCheckKey("MLB1", { OEM: { value_name: "X" } }),
    );
    expect(mlRequiredCheckKey(undefined, undefined)).toBe(mlRequiredCheckKey("", {}));
  });

  it("itens da revisão: mesma categoria/ficha do dispatch, sem os excluídos do ML", () => {
    const { items, keys } = buildMlReviewCheckItems(["p1", "p2", "p3"], {
      p1: { includeMl: true, mlCategory: "MLB1", attributes: { SIDE: { value_id: "1" } } },
      p2: { includeMl: false, mlCategory: "MLB2", attributes: {} },
    });
    expect(items).toEqual([
      {
        key: "p1",
        productId: "p1",
        categoryId: "MLB1",
        attributeOverrides: { SIDE: { value_id: "1" } },
      },
      { key: "p3", productId: "p3" },
    ]);
    expect(Object.keys(keys)).toEqual(["p1", "p3"]);
  });

  it("diverge quando algo mudou entre a checagem e o envio", () => {
    const antes = { p1: "MLB1|{}", p2: "MLB2|{}" };
    expect(mlCheckKeysDiverge(antes, { p1: "MLB1|{}", p2: "MLB2|{}" })).toBe(false);
    expect(mlCheckKeysDiverge(antes, { p1: "MLB9|{}", p2: "MLB2|{}" })).toBe(true);
    expect(mlCheckKeysDiverge(antes, { p1: "MLB1|{}" })).toBe(true);
    expect(mlCheckKeysDiverge(antes, { p1: "MLB1|{}", p3: "MLB2|{}" })).toBe(true);
  });

  it("só exclui o bloqueado cuja chave bate; sem chave (modo rápido) sempre exclui", () => {
    const blocked = {
      p1: { message: "m1", key: "MLB1|{}" },
      p2: { message: "m2", key: "MLB2|{}" },
      p3: { message: "m3" },
    };
    expect(
      splitMlBlockedByKey(blocked, { p1: "MLB1|{}", p2: "MLB-NOVA|{}", p3: "x" }),
    ).toEqual({ excluded: ["p1", "p3"], stale: ["p2"] });
    expect(splitMlBlockedByKey(blocked, null)).toEqual({
      excluded: ["p1", "p2", "p3"],
      stale: [],
    });
    expect(splitMlBlockedByKey({}, null)).toEqual({ excluded: [], stale: [] });
  });
});

describe("mensagens do wizard (M11, M12, M14)", () => {
  it("textos exatos", () => {
    expect(mlBlockedBannerMessage(2)).toBe(
      "2 produto(s) não serão enviados ao Mercado Livre porque faltam campos obrigatórios da categoria. Os demais anúncios seguem normalmente.",
    );
    expect(ML_ALL_BLOCKED_MESSAGE).toBe(
      "Nenhum anúncio do Mercado Livre pode ser enviado: todos os produtos selecionados têm campos obrigatórios da categoria sem preencher. Corrija os produtos ou remova as contas do Mercado Livre.",
    );
    expect(mlExcludedConfirmMessage(3)).toBe(
      "3 anúncio(s) do Mercado Livre não serão enviados por falta de campos obrigatórios:",
    );
  });

  it("todos bloqueados só com lista não-vazia e todos presentes", () => {
    const b = { p1: { message: "x" }, p2: { message: "y" } };
    expect(allMlProductsBlocked(["p1", "p2"], b)).toBe(true);
    expect(allMlProductsBlocked(["p1", "p2", "p3"], b)).toBe(false);
    expect(allMlProductsBlocked([], b)).toBe(false);
  });
});
