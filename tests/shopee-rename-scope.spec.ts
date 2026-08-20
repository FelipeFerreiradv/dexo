// O rename automático do nome da loja não pode escapar da Shopee.
//
// Por que isto merece teste próprio: `MarketplaceAccount` é UMA tabela para os
// cinco canais, e a auto-cura roda dentro de um GET que qualquer tenant dispara.
// Um `updateMany` com o WHERE errado renomearia contas de Mercado Livre, Magalu,
// OLX ou Facebook em massa, em silêncio.
//
// E isso teria consequência REAL, não só cosmética: em
// `listing.usercase.ts` a moeda do anúncio do Mercado Livre é decidida lendo o
// VALOR de `accountName` — `includes("MLA") || includes("Argentina")` escolhe
// entre ARS e BRL. Renomear uma conta ML por acidente mudaria a moeda de
// anúncios publicados. Daí o triplo cadeado no WHERE (id + plataforma + nome
// esperado) e daí este spec.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    marketplaceAccount: { updateMany: vi.fn(), findMany: vi.fn() },
  } as any,
}));

vi.mock("@/app/lib/prisma", () => ({
  default: prismaMock,
  prisma: prismaMock,
}));

import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.marketplaceAccount.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.marketplaceAccount.findMany.mockResolvedValue([]);
});

describe("renameShopeeAccountIfUnchanged — alcance da escrita", () => {
  it("o WHERE prende a escrita a UMA conta, da Shopee, com o nome esperado", async () => {
    await MarketplaceRepository.renameShopeeAccountIfUnchanged(
      "acc-1",
      "Shopee Shop 1547916297",
      "SHOPEE JOTABE AUTOPECAS",
    );

    const arg = prismaMock.marketplaceAccount.updateMany.mock.calls[0][0];

    // Os três cadeados, um a um.
    expect(arg.where.id).toBe("acc-1");
    expect(arg.where.platform).toBe("SHOPEE");
    expect(arg.where.accountName).toBe("Shopee Shop 1547916297");

    // Sem WHERE aberto: nada de renomear "todas as contas do tenant".
    expect(Object.keys(arg.where).sort()).toEqual([
      "accountName",
      "id",
      "platform",
    ]);
  });

  it("só o rótulo é escrito — token, status e vínculo fiscal ficam intactos", async () => {
    await MarketplaceRepository.renameShopeeAccountIfUnchanged(
      "acc-1",
      "Shopee Shop 1",
      "SHOPEE Loja",
    );

    const arg = prismaMock.marketplaceAccount.updateMany.mock.calls[0][0];
    expect(arg.data).toEqual({ accountName: "SHOPEE Loja" });
  });

  it("devolve 0 quando ninguém casou (alguém renomeou antes)", async () => {
    prismaMock.marketplaceAccount.updateMany.mockResolvedValue({ count: 0 });

    const n = await MarketplaceRepository.renameShopeeAccountIfUnchanged(
      "acc-1",
      "Shopee Shop 1",
      "SHOPEE Loja",
    );

    expect(n).toBe(0);
  });
});

// A outra metade do egress: o que o BANCO devolve, não só o que a API entrega.
// Sem `select`, cada leitura destas rotas trazia `accessToken`,
// `refreshToken` e `appClientSecret` do Postgres para serem descartados no
// passo seguinte — 1,7 KB por conta no Magalu, 2.166 leituras por dia.
describe("findAllPublicByUserIdAndPlatform — lê só o que a tela desenha", () => {
  it("o SELECT é explícito e não inclui nenhuma credencial", async () => {
    await MarketplaceRepository.findAllPublicByUserIdAndPlatform(
      "owner-1",
      "SHOPEE" as any,
    );

    const arg = prismaMock.marketplaceAccount.findMany.mock.calls[0][0];

    expect(arg.select).toBeDefined();
    for (const secreto of [
      "accessToken",
      "refreshToken",
      "appClientId",
      "appClientSecret",
    ]) {
      expect(arg.select[secreto]).toBeUndefined();
    }
  });

  it("traz a base e os campos que OLX e Facebook editam", async () => {
    await MarketplaceRepository.findAllPublicByUserIdAndPlatform(
      "owner-1",
      "OLX" as any,
    );

    const arg = prismaMock.marketplaceAccount.findMany.mock.calls[0][0];
    expect(Object.keys(arg.select).sort()).toEqual([
      "accountName",
      "fbCatalogId",
      "fbProductUrlBase",
      "id",
      "olxSellerPhone",
      "olxSellerZipcode",
      "status",
    ]);
  });

  it("mantém o filtro de tenant, plataforma e conta ATIVA", async () => {
    // O irmão completo filtra assim; o enxuto não pode divergir, senão a lista
    // passaria a mostrar conta desativada.
    await MarketplaceRepository.findAllPublicByUserIdAndPlatform(
      "owner-1",
      "MAGALU" as any,
    );

    const arg = prismaMock.marketplaceAccount.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      userId: "owner-1",
      platform: "MAGALU",
      status: "ACTIVE",
    });
    expect(arg.orderBy).toEqual({ createdAt: "asc" });
  });
});
