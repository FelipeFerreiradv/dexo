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
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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

    const queries: { sql: string; values: unknown[] }[] =
      db.$executeRaw.mock.calls.map((call: any[]) => {
        const [strings, ...values] = call;
        return { sql: (strings as TemplateStringsArray).join("?"), values };
      });

    // O que vale para AS DUAS: array_replace, escopo de tenant, e a
    // idempotência via WHERE pela URL antiga.
    for (const q of queries) {
      expect(q.sql).toContain("array_replace");
      expect(q.sql).toContain('= ANY("imageUrls")');
      expect(q.values).toContain("u1");
    }

    const produto = queries.find((q) => q.sql.includes('"Product"'))!;
    const sucata = queries.find((q) => q.sql.includes('"Scrap"'))!;
    expect(produto).toBeDefined();
    expect(sucata).toBeDefined();

    // A SUCATA continua exatamente como sempre foi: tabela pequena, 0,05 ms
    // por chamada, sem índice e sem precisar de um.
    expect(sucata.values).toEqual([OLD, NEW, "u1", OLD]);
    expect(sucata.sql).not.toContain("@>");

    // O PRODUTO ganhou a condição `@>`, que é o que torna a busca indexável
    // pelo GIN `Product_imageUrls_idx`. O `= ANY` foi mantido de propósito (já
    // conferido acima, no laço) — as duas são equivalentes para URL não-nula,
    // então o predicado é estritamente não-restritivo. Detalhes e a guarda
    // completa em tests/image-bg-swap-gin.spec.ts.
    expect(produto.sql).toContain('"imageUrls" @> ARRAY[?]');
    expect(produto.values).toEqual([OLD, NEW, "u1", OLD, OLD]);
  });

  it("overrides de anúncio: RMW com CAS pelo valor lido (edição concorrente não é sobrescrita)", async () => {
    const db = makeDb({
      productListing: {
        findMany: vi.fn().mockResolvedValue([
          { id: "l1", imageUrlsOverride: [OLD, "outra"] },
          { id: "l2", imageUrlsOverride: ["nao-tem"] },
          { id: "l3", imageUrlsOverride: "lixo-nao-array" },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });

    const counts = await swapImageUrlReferences({
      userId: "u1",
      oldUrl: OLD,
      newUrl: NEW,
      db,
    });

    expect(db.productListing.updateMany).toHaveBeenCalledTimes(1);
    expect(db.productListing.updateMany).toHaveBeenCalledWith({
      // O `equals` do valor LIDO é o CAS: se o usuário editou o override no
      // meio (sweep roda até 12min depois), o update não casa e nada é
      // sobrescrito.
      where: { id: "l1", imageUrlsOverride: { equals: [OLD, "outra"] } },
      data: { imageUrlsOverride: [NEW, "outra"] },
    });
    expect(counts.listingOverrides).toBe(1);
  });

  it("CAS perdido (usuário editou no meio): conta zero e não sobrescreve", async () => {
    const db = makeDb({
      productListing: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "l1", imageUrlsOverride: [OLD] }]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });
    const counts = await swapImageUrlReferences({
      userId: "u1",
      oldUrl: OLD,
      newUrl: NEW,
      db,
    });
    expect(counts.listingOverrides).toBe(0);
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
