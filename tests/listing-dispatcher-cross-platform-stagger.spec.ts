import { describe, it, expect, afterEach, vi } from "vitest";

import { ListingDispatcher } from "../app/marketplaces/services/listing-dispatcher.service";

/**
 * Escalonamento de preço entre contas para Shopee/Magalu (paridade com ML).
 *
 * Cada plataforma tem escada 0-based PRÓPRIA (mapas independentes no
 * crossAccountIncrease); Shopee/Magalu nunca leem o mapa ML e vice-versa.
 * O kill-switch CROSS_ACCOUNT_STAGGER_MARKETPLACES_DISABLED=1 reverte os
 * builders ao comportamento ML-only anterior. Os cenários legados (só ML)
 * continuam cobertos por tests/listing-dispatcher.spec.ts, que NÃO muda.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ListingDispatcher.buildCrossAccountOverride — mapas por plataforma", () => {
  const mixed = [
    { platform: "MERCADO_LIVRE" as const, accountId: "a" },
    { platform: "SHOPEE" as const, accountId: "s1" },
    { platform: "MERCADO_LIVRE" as const, accountId: "b" },
    { platform: "SHOPEE" as const, accountId: "s2" },
    { platform: "MAGALU" as const, accountId: "m1" },
    { platform: "MAGALU" as const, accountId: "m2" },
  ];

  it("requests mistos ⇒ 3 mapas independentes, cada um 0-based na sua plataforma", () => {
    expect(ListingDispatcher.buildCrossAccountOverride(mixed, 10)).toEqual({
      crossAccountIncrease: {
        enabled: true,
        percent: 10,
        indexByAccountId: { a: 0, b: 1 },
        shopeeIndexByAccountId: { s1: 0, s2: 1 },
        magaluIndexByAccountId: { m1: 0, m2: 1 },
      },
    });
  });

  it("2 contas Shopee + 1 ML ⇒ template só com o mapa Shopee (ML sem mapa = idx 0 = preço base)", () => {
    const reqs = [
      { platform: "MERCADO_LIVRE" as const, accountId: "a" },
      { platform: "SHOPEE" as const, accountId: "s1" },
      { platform: "SHOPEE" as const, accountId: "s2" },
    ];
    expect(ListingDispatcher.buildCrossAccountOverride(reqs, 10)).toEqual({
      crossAccountIncrease: {
        enabled: true,
        percent: 10,
        shopeeIndexByAccountId: { s1: 0, s2: 1 },
      },
    });
  });

  it("1 conta de cada plataforma ⇒ null (nenhuma escada possível)", () => {
    const reqs = [
      { platform: "MERCADO_LIVRE" as const, accountId: "a" },
      { platform: "SHOPEE" as const, accountId: "s1" },
      { platform: "MAGALU" as const, accountId: "m1" },
    ];
    expect(ListingDispatcher.buildCrossAccountOverride(reqs, 10)).toBeNull();
  });

  it("percent <= 0 ⇒ null mesmo com contas suficientes", () => {
    expect(ListingDispatcher.buildCrossAccountOverride(mixed, 0)).toBeNull();
    expect(ListingDispatcher.buildCrossAccountOverride(mixed, -5)).toBeNull();
  });

  it("conta repetida na mesma plataforma conta uma vez só (dedupe preservado)", () => {
    const reqs = [
      { platform: "SHOPEE" as const, accountId: "s1" },
      { platform: "SHOPEE" as const, accountId: "s1" },
      { platform: "SHOPEE" as const, accountId: "s2" },
    ];
    expect(ListingDispatcher.buildCrossAccountOverride(reqs, 10)).toEqual({
      crossAccountIncrease: {
        enabled: true,
        percent: 10,
        shopeeIndexByAccountId: { s1: 0, s2: 1 },
      },
    });
  });

  describe("kill-switch CROSS_ACCOUNT_STAGGER_MARKETPLACES_DISABLED=1", () => {
    it("requests mistos ⇒ resultado byte-idêntico ao legado (só mapa ML)", () => {
      vi.stubEnv("CROSS_ACCOUNT_STAGGER_MARKETPLACES_DISABLED", "1");
      expect(ListingDispatcher.buildCrossAccountOverride(mixed, 10)).toEqual({
        crossAccountIncrease: {
          enabled: true,
          percent: 10,
          indexByAccountId: { a: 0, b: 1 },
        },
      });
    });

    it("2 Shopee + 1 ML ⇒ null (como antes da feature)", () => {
      vi.stubEnv("CROSS_ACCOUNT_STAGGER_MARKETPLACES_DISABLED", "1");
      const reqs = [
        { platform: "MERCADO_LIVRE" as const, accountId: "a" },
        { platform: "SHOPEE" as const, accountId: "s1" },
        { platform: "SHOPEE" as const, accountId: "s2" },
      ];
      expect(ListingDispatcher.buildCrossAccountOverride(reqs, 10)).toBeNull();
    });
  });
});
