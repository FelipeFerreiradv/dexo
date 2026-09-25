// Predicado puro que separa o marcador local `PENDING_SHP_…` de um item_id
// real da Shopee. Ver app/marketplaces/lib/shopee-listing-placeholder.logic.ts.

import { describe, expect, it } from "vitest";

import {
  isShopeeListingPlaceholder,
  parseShopeeItemId,
} from "@/app/marketplaces/lib/shopee-listing-placeholder.logic";

// O MESMO parse que o sync de estoque usa para montar a chamada à Shopee —
// importado do módulo que o sync importa, e não uma cópia local que poderia
// divergir dele em silêncio.
const parseDoSync = parseShopeeItemId;

describe("parseShopeeItemId (o parse que o sync de estoque usa)", () => {
  it.each([
    ["22840012345", 22840012345],
    ["22840012345:777", 22840012345],
    [" 22840012345 ", 22840012345],
    ["12abc", 12],
    ["0:7", 0],
    ["-5", -5],
    // Raiz 10 fixa: `0x1A` NÃO vira 26 (hexadecimal).
    ["0x1A", 0],
  ])("%j ⇒ %d", (id, esperado) => {
    expect(parseShopeeItemId(id)).toBe(esperado);
  });

  it.each(["PENDING_SHP_1", "sem-id", "", ":123"])("%j ⇒ NaN", (id) => {
    expect(parseShopeeItemId(id)).toBeNaN();
  });
});

describe("isShopeeListingPlaceholder", () => {
  it.each([
    "PENDING_SHP_1727000000000",
    "PENDING_SHP_",
    "PENDING_REPUBLISH_22840012345",
    "PENDING_123",
  ])("marcador %s ⇒ true", (id) => {
    expect(isShopeeListingPlaceholder(id)).toBe(true);
  });

  it.each(["", "   ", "sem-id", "abc123", ":123", "0", "-5", "0:7"])(
    "id que não vira item_id positivo (%j) ⇒ true",
    (id) => {
      expect(isShopeeListingPlaceholder(id)).toBe(true);
    },
  );

  it("null/undefined ⇒ true (não há item_id para chamar)", () => {
    expect(isShopeeListingPlaceholder(null)).toBe(true);
    expect(isShopeeListingPlaceholder(undefined)).toBe(true);
  });

  it.each([
    "22840012345",
    "1",
    "22840012345:777",
    "22840012345:0",
    " 22840012345",
    "22840012345 ",
    "\t22840012345\n",
  ])("item_id real %j ⇒ false", (id) => {
    expect(isShopeeListingPlaceholder(id)).toBe(false);
  });

  it("aceita número (o id nunca é número no banco, mas o predicado é total)", () => {
    expect(isShopeeListingPlaceholder(22840012345)).toBe(false);
    expect(isShopeeListingPlaceholder(Number.NaN)).toBe(true);
  });

  it("⭐ nunca separa da regra do sync: todo id aceito vira item_id positivo no parse do sync", () => {
    const amostra = [
      "22840012345",
      "22840012345:777",
      " 22840012345 ",
      "PENDING_SHP_1",
      "sem-id",
      "",
      "0",
      "12abc",
    ];
    for (const id of amostra) {
      const n = parseDoSync(id);
      const chamaria = Number.isFinite(n) && n > 0;
      expect(isShopeeListingPlaceholder(id)).toBe(!chamaria);
    }
  });

  it("id com lixo DEPOIS dos dígitos segue como hoje (parseInt pega o prefixo) ⇒ false", () => {
    // Comportamento atual preservado: `12abc` já chamava a Shopee com 12.
    expect(isShopeeListingPlaceholder("12abc")).toBe(false);
  });
});
