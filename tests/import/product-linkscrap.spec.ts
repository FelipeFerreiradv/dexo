import { describe, it, expect, vi, beforeEach } from "vitest";

// A extensão ProductUpdate.scrapId tem de ser BYTE-COMPATÍVEL: update sem o
// campo gera exatamente o mesmo objeto Prisma de antes (nenhuma chave nova).
vi.mock("../../app/lib/prisma", () => {
  // mapPrismaToProduct espera Prisma.Decimal (com .toNumber()).
  const dec = (n: number) => ({ toNumber: () => n });
  const prisma: Record<string, unknown> = {
    product: {
      findFirst: vi.fn(async () => ({ id: "p1" })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => ({
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
        scrapId: (args.data.scrapId as string | null | undefined) ?? null,
        partNumber: null,
        quality: null,
        imageUrl: "",
        imageUrls: [],
        attributes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        compatibilities: [],
      })),
      updateMany: vi.fn(async () => ({ count: 2 })),
    },
    scrap: { findFirst: vi.fn(async () => ({ id: "s1" })) },
    productCompatibility: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
  };
  prisma.$transaction = vi.fn(async (cb: (tx: unknown) => unknown) =>
    cb(prisma),
  );
  return { default: prisma };
});

import prisma from "../../app/lib/prisma";
import { ProductRepositoryPrisma } from "../../app/repositories/product.repository";
import { ProductUseCase } from "../../app/usecases/product.usercase";

type AnyMock = ReturnType<typeof vi.fn>;
const prismaMock = prisma as unknown as {
  product: { findFirst: AnyMock; update: AnyMock; updateMany: AnyMock };
  scrap: { findFirst: AnyMock };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("linkScrap — byte-compat do repository.update", () => {
  it("update SEM scrapId não inclui a chave no objeto Prisma (idêntico ao de antes)", async () => {
    const repo = new ProductRepositoryPrisma();
    await repo.update("p1", { name: "Novo nome" }, "user-1");
    const args = prismaMock.product.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect("scrapId" in args.data).toBe(false);
    expect(args.data.name).toBe("Novo nome");
    // A guarda de tenant da sucata nem roda sem scrapId.
    expect(prismaMock.scrap.findFirst).not.toHaveBeenCalled();
  });

  it("update COM scrapId valida a posse da sucata e grava", async () => {
    const repo = new ProductRepositoryPrisma();
    await repo.update("p1", { scrapId: "s1" }, "user-1");
    expect(prismaMock.scrap.findFirst).toHaveBeenCalledWith({
      where: { id: "s1", userId: "user-1" },
      select: { id: true },
    });
    const args = prismaMock.product.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(args.data.scrapId).toBe("s1");
  });

  it("sucata de OUTRO tenant é rejeitada (guarda espelha o create)", async () => {
    prismaMock.scrap.findFirst.mockResolvedValueOnce(null);
    const repo = new ProductRepositoryPrisma();
    await expect(
      repo.update("p1", { scrapId: "s-de-outro" }, "user-1"),
    ).rejects.toThrow(/Vínculo de sucata inválido/);
    expect(prismaMock.product.update).not.toHaveBeenCalled();
  });

  it("scrapId null desvincula sem passar pela guarda", async () => {
    const repo = new ProductRepositoryPrisma();
    await repo.update("p1", { scrapId: null }, "user-1");
    expect(prismaMock.scrap.findFirst).not.toHaveBeenCalled();
    const args = prismaMock.product.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(args.data.scrapId).toBeNull();
  });
});

describe("ProductUseCase.linkScrap / linkScrapMany", () => {
  it("linkScrap delega ao repository.update (sem sync de marketplace)", async () => {
    const usecase = new ProductUseCase();
    const p = await usecase.linkScrap("p1", "s1", "user-1");
    expect(p.scrapId).toBe("s1");
    // Vai direto ao repo: 1 update, nenhum efeito colateral de listagem.
    expect(prismaMock.product.update).toHaveBeenCalledTimes(1);
  });

  it("linkScrapMany: guarda de tenant + updateMany escopado por userId", async () => {
    const usecase = new ProductUseCase();
    const res = await usecase.linkScrapMany("s1", ["p1", "p2", "p1"], "user-1");
    expect(res.count).toBe(2);
    const args = prismaMock.product.updateMany.mock.calls[0][0] as {
      where: { id: { in: string[] }; userId: string };
      data: { scrapId: string };
    };
    expect(args.where.userId).toBe("user-1"); // produto de outro tenant não é afetado
    expect(args.where.id.in).toEqual(["p1", "p2"]); // dedup
    expect(args.data.scrapId).toBe("s1");
  });

  it("linkScrapMany rejeita sucata de outro tenant e batch > 200", async () => {
    const usecase = new ProductUseCase();
    prismaMock.scrap.findFirst.mockResolvedValueOnce(null);
    await expect(
      usecase.linkScrapMany("s-x", ["p1"], "user-1"),
    ).rejects.toThrow(/Vínculo de sucata inválido/);

    const ids = Array.from({ length: 201 }, (_, i) => `p${i}`);
    await expect(usecase.linkScrapMany("s1", ids, "user-1")).rejects.toThrow(
      /Limite de 200/,
    );
  });
});
