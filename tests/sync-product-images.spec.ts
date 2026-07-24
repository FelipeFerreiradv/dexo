import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "@/app/lib/prisma";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";

/**
 * Trocar as fotos de um produto e salvar não refletia em anúncio nenhum — em
 * nenhuma das 3 plataformas. No ML o ponto de envio existia como um
 * `console.log` da intenção; o resto do encanamento (limpeza de override,
 * effectiveProduct.imageUrls) já estava pronto.
 *
 * As imagens vão num PUT SEPARADO, depois do principal: preço e estoque já
 * subiram e não podem ser derrubados por uma galeria que o ML recuse.
 */

describe("SyncUseCase.syncMLProductData → imagens", () => {
  beforeEach(() => {
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
    vi.spyOn(prisma.productListing, "findFirst").mockResolvedValue(null as any);
    process.env.PRODUCT_SYNC_FULL_FIELDS_ENABLED = "true";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PRODUCT_SYNC_FULL_FIELDS_ENABLED;
  });

  const itemAtivo = {
    id: "MLB-100",
    status: "active",
    available_quantity: 5,
    price: 99,
    title: "Farol",
    pictures: [{ secure_url: "https://cdn/old-1.jpg" }],
  };

  const produtoBase = {
    id: "prod-1",
    sku: "SKU-1",
    name: "Farol dianteiro",
    description: "Desc",
    price: 99,
    stock: 5,
  };

  const conta = { id: "acc-1", accessToken: "tok", userId: "u1" };

  it("sobe as imagens novas e manda pictures num PUT separado", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(itemAtivo as any);
    const upload = vi
      .spyOn(MLApiService, "uploadPictureFromUrl")
      .mockImplementation(async (_tok: string, url: string) => ({
        id: `PIC-${url.slice(-5)}`,
      }));
    const update = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue(itemAtivo as any);

    await (SyncUseCase as any).syncMLProductData(
      { ...produtoBase, imageUrls: ["https://cdn/a.jpg", "https://cdn/b.jpg"] },
      "MLB-100",
      conta,
    );

    expect(upload).toHaveBeenCalledTimes(2);

    const chamadaImagens = update.mock.calls.find(
      ([, , payload]: any[]) => payload && "pictures" in payload,
    );
    expect(chamadaImagens).toBeTruthy();
    expect((chamadaImagens as any[])[2].pictures).toHaveLength(2);

    // Preço/estoque continuam num PUT próprio, sem pictures misturado.
    const chamadaPrincipal = update.mock.calls.find(
      ([, , payload]: any[]) => payload && "price" in payload,
    );
    expect(chamadaPrincipal).toBeTruthy();
    expect((chamadaPrincipal as any[])[2]).not.toHaveProperty("pictures");
  });

  it("não gasta chamada quando a galeria já está igual", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
      ...itemAtivo,
      pictures: [{ secure_url: "https://cdn/a.jpg" }],
    } as any);
    const upload = vi.spyOn(MLApiService, "uploadPictureFromUrl");
    vi.spyOn(MLApiService, "updateItem").mockResolvedValue(itemAtivo as any);

    await (SyncUseCase as any).syncMLProductData(
      { ...produtoBase, imageUrls: ["https://cdn/a.jpg"] },
      "MLB-100",
      conta,
    );

    expect(upload).not.toHaveBeenCalled();
  });

  it("ML rejeitar a imagem NÃO derruba preço e estoque", async () => {
    // A regressão que importa: antes, um erro no payload principal com
    // blockedThisRound vazio fazia throw e matava o sync inteiro.
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(itemAtivo as any);
    vi.spyOn(MLApiService, "uploadPictureFromUrl").mockResolvedValue({
      id: "PIC-1",
    } as any);
    const update = vi
      .spyOn(MLApiService, "updateItem")
      .mockImplementation(async (_t: string, _id: string, payload: any) => {
        if (payload && "pictures" in payload) {
          throw new Error("item.pictures.invalid");
        }
        return itemAtivo as any;
      });

    const r = await (SyncUseCase as any).syncMLProductData(
      { ...produtoBase, imageUrls: ["https://cdn/a.jpg"] },
      "MLB-100",
      conta,
    );

    expect(r.success).toBe(true);
    expect(r.newPrice).toBe(99);
    expect(r.newStock).toBe(5);
    expect(update).toHaveBeenCalled();
  });

  it("flag desligada: nenhuma imagem é enviada (comportamento atual)", async () => {
    delete process.env.PRODUCT_SYNC_FULL_FIELDS_ENABLED;
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(itemAtivo as any);
    const upload = vi.spyOn(MLApiService, "uploadPictureFromUrl");
    const update = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue(itemAtivo as any);

    await (SyncUseCase as any).syncMLProductData(
      { ...produtoBase, imageUrls: ["https://cdn/a.jpg"] },
      "MLB-100",
      conta,
    );

    expect(upload).not.toHaveBeenCalled();
    for (const call of update.mock.calls) {
      expect((call as any[])[2]).not.toHaveProperty("pictures");
    }
  });

  it("produto sem imagem não dispara upload", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(itemAtivo as any);
    const upload = vi.spyOn(MLApiService, "uploadPictureFromUrl");
    vi.spyOn(MLApiService, "updateItem").mockResolvedValue(itemAtivo as any);

    await (SyncUseCase as any).syncMLProductData(
      { ...produtoBase, imageUrls: [] },
      "MLB-100",
      conta,
    );

    expect(upload).not.toHaveBeenCalled();
  });
});

describe("SyncUseCase.syncMLProductData → dimensões e peso", () => {
  beforeEach(() => {
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
    vi.spyOn(prisma.productListing, "findFirst").mockResolvedValue(null as any);
    process.env.PRODUCT_SYNC_FULL_FIELDS_ENABLED = "true";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PRODUCT_SYNC_FULL_FIELDS_ENABLED;
  });

  const itemAtivo = {
    id: "MLB-200",
    status: "active",
    available_quantity: 2,
    price: 50,
    title: "Peça",
    pictures: [],
  };

  const conta = { id: "acc-1", accessToken: "tok", userId: "u1" };
  const produto = {
    id: "prod-2",
    sku: "SKU-2",
    name: "Peça",
    description: "Desc",
    price: 50,
    stock: 2,
    heightCm: 10,
    widthCm: 20,
    lengthCm: 30,
    weightKg: 1.5,
  };

  it("envia SELLER_PACKAGE_* como atributos", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(itemAtivo as any);
    const update = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue(itemAtivo as any);

    await (SyncUseCase as any).syncMLProductData(produto, "MLB-200", conta);

    const principal = update.mock.calls.find(
      ([, , p]: any[]) => p && "price" in p,
    );
    const attrs = (principal as any[])[2].attributes ?? [];
    const ids = attrs.map((a: any) => a.id);
    expect(ids).toContain("SELLER_PACKAGE_HEIGHT");
    expect(ids).toContain("SELLER_PACKAGE_WIDTH");
    expect(ids).toContain("SELLER_PACKAGE_LENGTH");
    expect(ids).toContain("SELLER_PACKAGE_WEIGHT");
  });

  it("ignora medida zerada ou ausente", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(itemAtivo as any);
    const update = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue(itemAtivo as any);

    await (SyncUseCase as any).syncMLProductData(
      { ...produto, heightCm: 0, weightKg: null },
      "MLB-200",
      conta,
    );

    const principal = update.mock.calls.find(
      ([, , p]: any[]) => p && "price" in p,
    );
    const ids = ((principal as any[])[2].attributes ?? []).map(
      (a: any) => a.id,
    );
    expect(ids).not.toContain("SELLER_PACKAGE_HEIGHT");
    expect(ids).not.toContain("SELLER_PACKAGE_WEIGHT");
    expect(ids).toContain("SELLER_PACKAGE_WIDTH");
  });

  it("não sobrescreve dimensão já vinda da ficha técnica do operador", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(itemAtivo as any);
    const update = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue(itemAtivo as any);

    await (SyncUseCase as any).syncMLProductData(
      {
        ...produto,
        attributes: {
          SELLER_PACKAGE_HEIGHT: { value_name: "99 cm" },
        },
      },
      "MLB-200",
      conta,
    );

    const principal = update.mock.calls.find(
      ([, , p]: any[]) => p && "price" in p,
    );
    const alturas = ((principal as any[])[2].attributes ?? []).filter(
      (a: any) => a.id === "SELLER_PACKAGE_HEIGHT",
    );
    expect(alturas).toHaveLength(1);
    expect(alturas[0].value_name).toBe("99 cm");
  });

  it("flag desligada: nenhuma dimensão entra no payload", async () => {
    delete process.env.PRODUCT_SYNC_FULL_FIELDS_ENABLED;
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(itemAtivo as any);
    const update = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue(itemAtivo as any);

    await (SyncUseCase as any).syncMLProductData(produto, "MLB-200", conta);

    const principal = update.mock.calls.find(
      ([, , p]: any[]) => p && "price" in p,
    );
    const ids = ((principal as any[])[2].attributes ?? []).map(
      (a: any) => a.id,
    );
    expect(ids).not.toContain("SELLER_PACKAGE_HEIGHT");
  });
});
