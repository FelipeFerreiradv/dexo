import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Commit 5 (C6/C7) — matching mais forte, sem inventar vínculo.
//
// Três furos reais na cadeia anterior:
//
// 1. Listing pendurado em conta antiga. A desconexão da Shopee é "soft" quando
//    há pedidos (zera tokens, marca INACTIVE) e os ProductListing continuam
//    apontando para a conta velha. O listingMap é chaveado por
//    `${marketplaceAccountId}_${externalListingId}` ⇒ erra 100% das vezes. O ML
//    já tinha conserto para isso (listing-ownership-repair); a Shopee não.
//
// 2. Escopo por `account.userId` cru. Conta conectada por colaborador ⇒ o
//    produto existe e não é encontrado ⇒ a venda não baixa estoque.
//
// 3. Nenhum resgate por part number, mesmo com o campo indexado no Product.
//
// O que NÃO se faz aqui: matching por título/similaridade. Vincular o produto
// errado gera baixa no item errado, que é pior do que não vincular.
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { SystemLogService } from "@/app/services/system-log.service";
import prisma from "@/app/lib/prisma";

const chamar = (items: any[], userId = "colaborador-1") =>
  (OrderUseCase as any).mapShopeeOrderItems(
    items,
    userId,
    "acc-nova",
    new Map(),
  );

const ITEM = {
  item_id: 58211905844,
  item_sku: "3060",
  model_quantity_purchased: 1,
  model_original_price: 28.99,
};

let flagAnterior: string | undefined;

beforeEach(() => {
  flagAnterior = process.env.SHOPEE_ORDER_MATCH_FALLBACK_DISABLED;
  delete process.env.SHOPEE_ORDER_MATCH_FALLBACK_DISABLED;

  // Colaborador cujo dono dos dados é o admin.
  vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
    parentUserId: "dono-1",
  } as any);
  vi.spyOn(prisma.productListing, "findFirst").mockResolvedValue(null as any);
  vi.spyOn(prisma.product, "findFirst").mockResolvedValue(null as any);
  vi.spyOn(prisma.product, "findMany").mockResolvedValue([] as any);
  vi.spyOn(ListingRepository, "reassignAccount").mockResolvedValue({} as any);
  vi.spyOn(ListingRepository, "upsertFromOrderFallback").mockResolvedValue({
    id: "listing-novo",
  } as any);
  vi.spyOn(SystemLogService, "logListingOwnershipRepaired").mockResolvedValue(
    undefined as any,
  );
});

afterEach(() => {
  if (flagAnterior === undefined) {
    delete process.env.SHOPEE_ORDER_MATCH_FALLBACK_DISABLED;
  } else {
    process.env.SHOPEE_ORDER_MATCH_FALLBACK_DISABLED = flagAnterior;
  }
  vi.restoreAllMocks();
});

describe("listing pendurado em outra conta do MESMO tenant", () => {
  it("vincula pelo listing da conta antiga e reaponta para a conta ativa", async () => {
    vi.spyOn(prisma.productListing, "findFirst").mockResolvedValue({
      id: "listing-antigo",
      productId: "prod-1",
      marketplaceAccountId: "acc-antiga",
      product: { id: "prod-1", userId: "dono-1" },
    } as any);

    const r = await chamar([ITEM]);

    expect(r.linkedCount).toBe(1);
    expect(r.items[0]).toMatchObject({
      productId: "prod-1",
      listingId: "listing-antigo",
      quantity: 1,
    });
    expect(ListingRepository.reassignAccount).toHaveBeenCalledWith(
      "listing-antigo",
      "acc-nova",
    );
    // Correção no catálogo do cliente: este log LEVA userId de propósito.
    expect(SystemLogService.logListingOwnershipRepaired).toHaveBeenCalledWith(
      "dono-1",
      "listing-antigo",
      expect.objectContaining({ newAccountId: "acc-nova" }),
    );
  });

  it("busca restrita ao tenant e a outras contas (nunca a própria, nunca alheia)", async () => {
    await chamar([ITEM]);

    expect(prisma.productListing.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          externalListingId: "58211905844",
          marketplaceAccountId: { not: "acc-nova" },
          marketplaceAccount: { platform: "SHOPEE", userId: "dono-1" },
        }),
      }),
    );
  });

  it("falha ao reapontar não impede a venda de ser vinculada", async () => {
    vi.spyOn(prisma.productListing, "findFirst").mockResolvedValue({
      id: "listing-antigo",
      productId: "prod-1",
      marketplaceAccountId: "acc-antiga",
      product: { id: "prod-1", userId: "dono-1" },
    } as any);
    vi.spyOn(ListingRepository, "reassignAccount").mockRejectedValue(
      new Error("conflito"),
    );

    const r = await chamar([ITEM]);

    expect(r.linkedCount).toBe(1);
  });
});

describe("escopo por dataOwnerId", () => {
  it("procura o SKU pelo DONO dos dados, não pelo userId da conta", async () => {
    await chamar([ITEM], "colaborador-1");

    expect(prisma.product.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { skuNormalized: "3060", userId: "dono-1" },
      }),
    );
  });

  it("produto de OUTRO tenant nunca casa", async () => {
    vi.spyOn(prisma.product, "findFirst").mockImplementation(
      async ({ where }: any) =>
        where.userId === "dono-1" ? ({ id: "prod-1" } as any) : null,
    );
    vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
      parentUserId: "outro-dono",
    } as any);

    const r = await chamar([ITEM], "colaborador-1");

    expect(r.linkedCount).toBe(0);
    expect(r.unlinked[0].reason).toBe("PRODUCT_NOT_FOUND");
  });
});

describe("fallback por part number", () => {
  it("vincula quando há exatamente UM candidato", async () => {
    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      { id: "prod-pn" },
    ] as any);

    const r = await chamar([ITEM]);

    expect(r.linkedCount).toBe(1);
    expect(r.items[0].productId).toBe("prod-pn");
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "dono-1", partNumberNormalized: "3060" },
      }),
    );
  });

  it("NÃO vincula quando há mais de um candidato (ambiguidade)", async () => {
    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      { id: "prod-a" },
      { id: "prod-b" },
    ] as any);

    const r = await chamar([ITEM]);

    // Baixar no produto errado é pior do que não baixar.
    expect(r.linkedCount).toBe(0);
    expect(r.unlinked[0].reason).toBe("PRODUCT_NOT_FOUND");
  });

  it("só é consultado depois que o SKU falhou", async () => {
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue({
      id: "prod-sku",
    } as any);

    const r = await chamar([ITEM]);

    expect(r.items[0].productId).toBe("prod-sku");
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });
});

describe("kill-switch SHOPEE_ORDER_MATCH_FALLBACK_DISABLED", () => {
  it("com 1, volta à cadeia anterior: nem cross-account, nem part number", async () => {
    process.env.SHOPEE_ORDER_MATCH_FALLBACK_DISABLED = "1";
    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      { id: "prod-pn" },
    ] as any);

    const r = await chamar([ITEM]);

    expect(prisma.productListing.findFirst).not.toHaveBeenCalled();
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    // E o escopo volta a ser o userId cru da conta.
    expect(prisma.product.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { skuNormalized: "3060", userId: "colaborador-1" },
      }),
    );
    expect(r.linkedCount).toBe(0);
  });
});

describe("C7 — isMarketplaceAuthError reconhece o erro real da Shopee", () => {
  const casa = (msg: string) =>
    (OrderUseCase as any).isMarketplaceAuthError(new Error(msg));

  it("casa 'Invalid access_token' (underscore) mesmo sem status HTTP", () => {
    // Formato real devolvido pela API em 29/07/2026.
    expect(casa("Invalid access_token, please have a check.")).toBe(true);
  });

  it("continua casando o formato do ML (com espaço)", () => {
    expect(casa("invalid access token")).toBe(true);
  });

  it("não casa erro que não é de autenticação", () => {
    expect(casa("Erro ao listar pedidos Shopee: internal error")).toBe(false);
  });
});
