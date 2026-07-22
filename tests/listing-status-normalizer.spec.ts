import { describe, it, expect } from "vitest";
import { normalizeListingStatus } from "@/app/marketplaces/lib/listing-status";

describe("normalizeListingStatus", () => {
  describe("MERCADO_LIVRE (passthrough lowercase)", () => {
    it.each([
      ["active", "active"],
      ["paused", "paused"],
      ["closed", "closed"],
      ["under_review", "under_review"],
      ["inactive", "inactive"],
      ["PAUSED", "paused"],
      ["  active  ", "active"],
      ["status_novo_desconhecido", "status_novo_desconhecido"],
    ])("%j → %j", (raw, expected) => {
      expect(normalizeListingStatus("MERCADO_LIVRE", raw)).toBe(expected);
    });
  });

  describe("SHOPEE (mapa do import, exceto vazio)", () => {
    it.each([
      ["NORMAL", "active"],
      ["UNLINKED", "pending"],
      ["UNLIST", "unlist"],
      ["BANNED", "banned"],
      ["DELETED", "deleted"],
      ["SELLER_DELETED", "seller_deleted"],
      ["REVIEWING", "reviewing"],
      ["normal", "active"],
      ["unlist", "unlist"],
    ])("%j → %j", (raw, expected) => {
      expect(normalizeListingStatus("SHOPEE", raw)).toBe(expected);
    });
  });

  describe("MAGALU (passthrough lowercase — pronto p/ follow-up)", () => {
    it.each([
      ["active", "active"],
      ["ACTIVE", "active"],
      ["paused", "paused"],
    ])("%j → %j", (raw, expected) => {
      expect(normalizeListingStatus("MAGALU", raw)).toBe(expected);
    });
  });

  describe("entrada sem status confiável → null (caller não escreve)", () => {
    it.each([
      ["MERCADO_LIVRE", ""],
      ["MERCADO_LIVRE", "   "],
      ["MERCADO_LIVRE", null],
      ["MERCADO_LIVRE", undefined],
      ["SHOPEE", ""],
      ["SHOPEE", null],
      ["MAGALU", undefined],
    ] as const)("%s + %j → null", (platform, raw) => {
      expect(normalizeListingStatus(platform, raw)).toBeNull();
    });

    // Divergência INTENCIONAL vs a closure do import Shopee
    // (sync.usercase.ts normalizeShopeeStatus): lá vazio → "active" porque a
    // criação da row exige status NOT NULL; aqui vazio → null porque o
    // espelho nunca deve sobrescrever um status real com default inventado.
    it("Shopee vazio: espelho devolve null, não 'active'", () => {
      expect(normalizeListingStatus("SHOPEE", "")).toBeNull();
    });
  });
});
