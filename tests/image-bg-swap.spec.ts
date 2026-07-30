import { describe, expect, it, vi } from "vitest";

import { swapImageUrlReferences } from "../app/marketplaces/services/image-bg-swap";

const OLD = "http://test.local/uploads/aaa.webp";
const NEW = "http://test.local/uploads/aaa.png";

function makeDb(overrides: Partial<Record<string, any>> = {}) {
  return {
    product: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
    productListing: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    ...overrides,
  } as any;
}

describe("swapImageUrlReferences", () => {
  it("troca imageUrl escopado por userId (nunca via ProductUseCase.update)", async () => {
    const db = makeDb();
    await swapImageUrlReferences({ userId: "u1", oldUrl: OLD, newUrl: NEW, db });

    expect(db.product.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", imageUrl: OLD },
      data: { imageUrl: NEW },
    });
  });

  it("usa array_replace nos String[] de Product e Scrap, com os valores certos", async () => {
    const db = makeDb();
    await swapImageUrlReferences({ userId: "u1", oldUrl: OLD, newUrl: NEW, db });

    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
    for (const call of db.$executeRaw.mock.calls) {
      const [strings, ...values] = call;
      const sql = (strings as TemplateStringsArray).join("?");
      expect(sql).toContain("array_replace");
      // Escopo de tenant + idempotência via WHERE pela URL antiga.
      expect(sql).toContain('= ANY("imageUrls")');
      expect(values).toEqual([OLD, NEW, "u1", OLD]);
    }
    const tables = db.$executeRaw.mock.calls.map((c: any[]) =>
      (c[0] as TemplateStringsArray).join(""),
    );
    expect(tables.some((s: string) => s.includes('"Product"'))).toBe(true);
    expect(tables.some((s: string) => s.includes('"Scrap"'))).toBe(true);
  });

  it("overrides de anúncio: só atualiza listings que contêm a URL antiga", async () => {
    const db = makeDb({
      productListing: {
        findMany: vi.fn().mockResolvedValue([
          { id: "l1", imageUrlsOverride: [OLD, "outra"] },
          { id: "l2", imageUrlsOverride: ["nao-tem"] },
          { id: "l3", imageUrlsOverride: "lixo-nao-array" },
        ]),
        update: vi.fn().mockResolvedValue({}),
      },
    });

    const counts = await swapImageUrlReferences({
      userId: "u1",
      oldUrl: OLD,
      newUrl: NEW,
      db,
    });

    expect(db.productListing.update).toHaveBeenCalledTimes(1);
    expect(db.productListing.update).toHaveBeenCalledWith({
      where: { id: "l1" },
      data: { imageUrlsOverride: [NEW, "outra"] },
    });
    expect(counts.listingOverrides).toBe(1);
  });

  it("idempotente: nada referencia a URL antiga => zero updates de override", async () => {
    const db = makeDb({
      product: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      $executeRaw: vi.fn().mockResolvedValue(0),
    });
    const counts = await swapImageUrlReferences({
      userId: "u1",
      oldUrl: OLD,
      newUrl: NEW,
      db,
    });
    expect(counts).toEqual({
      productImageUrl: 0,
      productImageUrls: 0,
      scrapImageUrls: 0,
      listingOverrides: 0,
    });
  });
});
