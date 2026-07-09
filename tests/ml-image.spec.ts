import { describe, it, expect } from "vitest";
import { Platform } from "@prisma/client";

import { toFullSizeMLImage, toFullSizeMLImages } from "@/app/lib/ml-image";
import { ListingAutodetectUseCase } from "@/app/marketplaces/usecases/listing-autodetect.usercase";

describe("toFullSizeMLImage", () => {
  it("troca a miniatura -I pela original -O e força https", () => {
    expect(
      toFullSizeMLImage(
        "http://http2.mlstatic.com/D_793779-MLB53145573445_012023-I.jpg",
      ),
    ).toBe("https://http2.mlstatic.com/D_793779-MLB53145573445_012023-O.jpg");
  });

  it("funciona para .webp e outras variantes (-V, -F)", () => {
    expect(
      toFullSizeMLImage("https://http2.mlstatic.com/D_697507-MLB1_062026-I.webp"),
    ).toBe("https://http2.mlstatic.com/D_697507-MLB1_062026-O.webp");
    expect(
      toFullSizeMLImage("https://http2.mlstatic.com/D_1-MLB2_012023-V.jpg"),
    ).toBe("https://http2.mlstatic.com/D_1-MLB2_012023-O.jpg");
  });

  it("é idempotente em URLs já originais (-O)", () => {
    const url = "https://http2.mlstatic.com/D_1-MLB2_012023-O.jpg";
    expect(toFullSizeMLImage(url)).toBe(url);
    expect(toFullSizeMLImage(toFullSizeMLImage(url))).toBe(url);
  });

  it("NÃO mexe em URLs de outros domínios", () => {
    expect(toFullSizeMLImage("http://img/x.jpg")).toBe("http://img/x.jpg");
    expect(toFullSizeMLImage("https://cdn.shopee.com/abc-I.jpg")).toBe(
      "https://cdn.shopee.com/abc-I.jpg",
    );
  });

  it("URL mlstatic sem variante fica inalterada (só https)", () => {
    expect(toFullSizeMLImage("http://http2.mlstatic.com/foto.jpg")).toBe(
      "https://http2.mlstatic.com/foto.jpg",
    );
  });

  it("vazio/nulo → null", () => {
    expect(toFullSizeMLImage(null)).toBeNull();
    expect(toFullSizeMLImage(undefined)).toBeNull();
    expect(toFullSizeMLImage("   ")).toBeNull();
  });

  it("toFullSizeMLImages mapeia a lista e descarta vazios", () => {
    expect(
      toFullSizeMLImages([
        "http://http2.mlstatic.com/D_1-MLB2_012023-I.jpg",
        "",
        null,
      ]),
    ).toEqual(["https://http2.mlstatic.com/D_1-MLB2_012023-O.jpg"]);
    expect(toFullSizeMLImages(undefined)).toEqual([]);
  });
});

const mlItem = (over: Record<string, unknown> = {}) =>
  ({
    id: "MLB1",
    title: "Peça",
    price: 10,
    available_quantity: 1,
    status: "active",
    permalink: "http://ml/x",
    date_created: "2026-06-01T00:00:00Z",
    seller_custom_field: "SKU-1",
    attributes: [],
    ...over,
  }) as any;

const account = { id: "acc1", userId: "u1" };

describe("normalizeMLItem — imagem", () => {
  it("prioriza pictures[0].secure_url (original) sobre o thumbnail (miniatura)", () => {
    const n = ListingAutodetectUseCase.normalizeMLItem(
      account,
      mlItem({
        thumbnail: "http://http2.mlstatic.com/D_1-MLB2_012023-I.jpg",
        pictures: [
          {
            id: "p1",
            url: "http://http2.mlstatic.com/D_1-MLB2_012023-O.jpg",
            secure_url: "https://http2.mlstatic.com/D_1-MLB2_012023-O.jpg",
          },
        ],
      }),
    );
    expect(n.platform).toBe(Platform.MERCADO_LIVRE);
    expect(n.imageUrl).toBe("https://http2.mlstatic.com/D_1-MLB2_012023-O.jpg");
  });

  it("importa a GALERIA inteira, na ordem do anúncio, em tamanho original", () => {
    const n = ListingAutodetectUseCase.normalizeMLItem(
      account,
      mlItem({
        thumbnail: "http://http2.mlstatic.com/D_1-MLB2_012023-I.jpg",
        pictures: [
          { id: "p1", url: "http://http2.mlstatic.com/D_1-MLB2_012023-I.jpg", secure_url: "" },
          { id: "p2", url: "", secure_url: "http://http2.mlstatic.com/D_3-MLB4_012023-V.webp" },
          { id: "p3", url: "https://http2.mlstatic.com/D_5-MLB6_012023-O.jpg", secure_url: "" },
        ],
      }),
    );
    expect(n.imageUrls).toEqual([
      "https://http2.mlstatic.com/D_1-MLB2_012023-O.jpg",
      "https://http2.mlstatic.com/D_3-MLB4_012023-O.webp",
      "https://http2.mlstatic.com/D_5-MLB6_012023-O.jpg",
    ]);
    // capa = primeira da galeria
    expect(n.imageUrl).toBe(n.imageUrls![0]);
  });

  it("sem pictures, cai no thumbnail JÁ convertido para tamanho original", () => {
    const n = ListingAutodetectUseCase.normalizeMLItem(
      account,
      mlItem({
        thumbnail: "http://http2.mlstatic.com/D_9-MLB8_012023-I.jpg",
        pictures: [],
      }),
    );
    expect(n.imageUrl).toBe("https://http2.mlstatic.com/D_9-MLB8_012023-O.jpg");
    expect(n.imageUrls).toEqual([]);
  });

  it("sem imagem alguma → null", () => {
    const n = ListingAutodetectUseCase.normalizeMLItem(
      account,
      mlItem({ thumbnail: "", pictures: [] }),
    );
    expect(n.imageUrl).toBeNull();
    expect(n.imageUrls).toEqual([]);
  });
});

describe("normalizeMagaluItem — galeria", () => {
  it("importa todas as referências de imagem; capa = primeira", () => {
    const n = ListingAutodetectUseCase.normalizeMagaluItem(account, {
      seller_sku: "SKU-1",
      title: "Farol",
      images: [
        { reference: "http://img/a.jpg" },
        { reference: "" },
        { reference: "http://img/b.jpg" },
      ],
    } as any);
    expect(n.imageUrls).toEqual(["http://img/a.jpg", "http://img/b.jpg"]);
    expect(n.imageUrl).toBe("http://img/a.jpg");
  });

  it("sem imagens → imageUrl null e galeria vazia", () => {
    const n = ListingAutodetectUseCase.normalizeMagaluItem(account, {
      seller_sku: "SKU-2",
    } as any);
    expect(n.imageUrl).toBeNull();
    expect(n.imageUrls).toEqual([]);
  });
});
