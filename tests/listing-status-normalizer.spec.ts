import { describe, it, expect } from "vitest";
import { normalizeListingStatus } from "@/app/marketplaces/lib/listing-status";

describe("normalizeListingStatus", () => {
  describe("MERCADO_LIVRE (vocabulário fechado)", () => {
    it.each([
      ["active", "active"],
      ["paused", "paused"],
      ["closed", "closed"],
      ["inactive", "inactive"],
      ["under_review", "reviewing"], // canônico do bucket PENDING
      ["PAUSED", "paused"],
      ["  active  ", "active"],
    ])("%j → %j", (raw, expected) => {
      expect(normalizeListingStatus("MERCADO_LIVRE", raw)).toBe(expected);
    });

    // Fora do vocabulário fechado (payment_required, not_yet_active, etc.) →
    // null: gravar valor desconhecido faria o produto sumir dos filtros de
    // publicação e furaria o guard anti-duplicata.
    it.each(["payment_required", "not_yet_active", "status_novo_desconhecido"])(
      "%j (desconhecido) → null",
      (raw) => {
        expect(normalizeListingStatus("MERCADO_LIVRE", raw)).toBeNull();
      },
    );
  });

  describe("SHOPEE (mapa fechado, com grafias reais da API)", () => {
    it.each([
      ["NORMAL", "active"],
      ["UNLINKED", "pending"],
      ["UNLIST", "unlist"],
      ["BANNED", "banned"],
      ["REVIEWING", "reviewing"],
      ["DELETED", "deleted"],
      ["SELLER_DELETED", "seller_deleted"],
      ["SELLER_DELETE", "seller_deleted"], // grafia real da API v2
      ["SHOPEE_DELETE", "deleted"], // grafia real da API v2
      ["normal", "active"],
      ["unlist", "unlist"],
    ])("%j → %j", (raw, expected) => {
      expect(normalizeListingStatus("SHOPEE", raw)).toBe(expected);
    });

    it("valor desconhecido → null", () => {
      expect(normalizeListingStatus("SHOPEE", "ALGO_NOVO")).toBeNull();
    });
  });

  describe("MAGALU (mesmo vocabulário base do ML — pronto p/ follow-up)", () => {
    it.each([
      ["active", "active"],
      ["ACTIVE", "active"],
      ["paused", "paused"],
    ])("%j → %j", (raw, expected) => {
      expect(normalizeListingStatus("MAGALU", raw)).toBe(expected);
    });

    it("valor desconhecido → null", () => {
      expect(normalizeListingStatus("MAGALU", "enabled")).toBeNull();
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
