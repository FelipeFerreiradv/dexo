// BLOCO J — o efeito colateral que a troca de sucata EXIGE.
//
// A armadilha central: depois do UPDATE, o produto já não aponta para a sucata
// de ORIGEM. A entrada por produtos do reconciliador resolve o lote A PARTIR do
// produto, então ela nunca alcançaria a origem — e `Scrap.status` é coluna
// PERSISTIDA (ao contrário do rótulo por peça, que se autocura). O lote ficaria
// "Esgotado" para sempre depois de perder a peça que o esgotava.
//
// É o mesmo bug que a Fase 3 corrigiu do lado do marketplace, chegando por
// outra porta. Este spec existe para que ele não entre por esta.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/marketplaces/services/scrap-status-reconcile.service", () => ({
  ScrapStatusReconcileService: {
    reconcileForScraps: vi.fn(),
    reconcileForProducts: vi.fn(),
    reconcileForReceivable: vi.fn(),
  },
}));

vi.mock("../app/lib/prisma", () => {
  const dec = (n: number) => ({ toNumber: () => n });
  const linha = (scrapId: string | null) => ({
    id: "p1",
    sku: "SKU1",
    skuNormalized: "sku1",
    name: "Peça",
    description: null,
    price: dec(10),
    stock: 1,
    costPrice: null,
    markup: null,
    brand: null,
    model: null,
    year: null,
    version: null,
    category: null,
    location: null,
    locationId: null,
    scrapId,
    partNumber: null,
    quality: null,
    imageUrl: "",
    imageUrls: [],
    attributes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    compatibilities: [],
  });
  const prisma: Record<string, unknown> = {
    product: {
      // Vínculo ATUAL do produto: sucata "s-antiga".
      findFirst: vi.fn(async () => linha("s-antiga")),
      update: vi.fn(async (args: { data: Record<string, unknown> }) =>
        linha((args.data.scrapId as string | null) ?? null),
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    scrap: { findFirst: vi.fn(async () => ({ id: "s-nova" })) },
    orderItem: { count: vi.fn(async () => 0) },
    receivableItem: { count: vi.fn(async () => 0) },
    productCompatibility: { deleteMany: vi.fn(), createMany: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (cb: (tx: unknown) => unknown) =>
    cb(prisma),
  );
  return { default: prisma };
});

import prisma from "../app/lib/prisma";
import { ProductUseCase } from "../app/usecases/product.usercase";
import { ScrapStatusReconcileService } from "../app/marketplaces/services/scrap-status-reconcile.service";

type AnyMock = ReturnType<typeof vi.fn>;
const prismaMock = prisma as unknown as {
  product: { findFirst: AnyMock; update: AnyMock };
  orderItem: { count: AnyMock };
  receivableItem: { count: AnyMock };
};
const reconcile = ScrapStatusReconcileService.reconcileForScraps as AnyMock;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("relinkScrap — os DOIS lotes são reconciliados", () => {
  it("trocar A→B reconcilia A e B, nessa ordem", async () => {
    const res = await new ProductUseCase().relinkScrap(
      "p1",
      "s-nova",
      "user-1",
    );

    expect(res.previousScrapId).toBe("s-antiga");
    expect(reconcile).toHaveBeenCalledTimes(1);
    const arg = reconcile.mock.calls[0][0];
    // A ORIGEM é a que o reconciliador por produtos jamais alcançaria.
    expect(arg.scrapIds).toEqual(["s-antiga", "s-nova"]);
    expect(arg.userId).toBe("user-1");
  });

  it("desvincular reconcilia só a origem — não existe destino", async () => {
    await new ProductUseCase().relinkScrap("p1", null, "user-1");
    expect(reconcile.mock.calls[0][0].scrapIds).toEqual(["s-antiga"]);
  });

  it("peça SEM sucata que ganha uma: reconcilia só o destino", async () => {
    prismaMock.product.findFirst.mockResolvedValueOnce({
      id: "p1",
      scrapId: null,
      price: { toNumber: () => 10 },
      imageUrls: [],
      compatibilities: [],
    });
    await new ProductUseCase().relinkScrap("p1", "s-nova", "user-1");
    expect(reconcile.mock.calls[0][0].scrapIds).toEqual(["s-nova"]);
  });

  it("mesmo vínculo ⇒ NADA acontece (sem update, sem reconcile)", async () => {
    // Um clique que não mudou nada não pode custar duas reconciliações com
    // advisory lock.
    const res = await new ProductUseCase().relinkScrap(
      "p1",
      "s-antiga",
      "user-1",
    );
    expect(res.previousScrapId).toBe("s-antiga");
    expect(prismaMock.product.update).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("produto de outro tenant: erro e NENHUMA reconciliação", async () => {
    prismaMock.product.findFirst.mockResolvedValueOnce(null);
    await expect(
      new ProductUseCase().relinkScrap("p1", "s-nova", "outro-user"),
    ).rejects.toThrow("não encontrado");
    expect(prismaMock.product.update).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("sem userId nem chega a consultar o banco", async () => {
    await expect(
      new ProductUseCase().relinkScrap("p1", "s-nova", ""),
    ).rejects.toThrow("Usuário não encontrado");
    expect(prismaMock.product.findFirst).not.toHaveBeenCalled();
  });
});

describe("getScrapLinkInfo — os números do aviso", () => {
  it("conta os dois canais e separa as vendas de balcão presas ao lote", async () => {
    prismaMock.orderItem.count.mockResolvedValueOnce(4);
    prismaMock.receivableItem.count
      .mockResolvedValueOnce(5) // total de balcão PAGA
      .mockResolvedValueOnce(2); // as que gravaram a sucata na linha
    prismaMock.product.findFirst.mockResolvedValueOnce({
      scrapId: "s-antiga",
      scrap: { id: "s-antiga", brand: "Fiat", model: "Uno", year: 2010 },
    });

    const info = await new ProductUseCase().getScrapLinkInfo("p1", "user-1");
    expect(info).toEqual({
      scrapId: "s-antiga",
      scrapLabel: "Fiat Uno 2010",
      marketplaceSales: 4,
      counterSales: 5,
      pinnedCounterSales: 2,
    });
  });

  it("produto inexistente ou de outro tenant ⇒ null (vira 404 na rota)", async () => {
    prismaMock.product.findFirst.mockResolvedValueOnce(null);
    expect(
      await new ProductUseCase().getScrapLinkInfo("p1", "user-1"),
    ).toBeNull();
  });

  it("peça sem sucata devolve rótulo nulo, não a string 'null'", async () => {
    prismaMock.product.findFirst.mockResolvedValueOnce({
      scrapId: null,
      scrap: null,
    });
    const info = await new ProductUseCase().getScrapLinkInfo("p1", "user-1");
    expect(info?.scrapId).toBeNull();
    expect(info?.scrapLabel).toBeNull();
  });
});
