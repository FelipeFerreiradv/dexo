import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// `ProductUseCase.pauseListings` com `pularPlataformas`.
//
// ⚠️⚠️ ESTE ARQUIVO EXISTE PORQUE UMA MUTAÇÃO SOBREVIVEU.
// Em `ai-anuncio-situacao.spec.ts` o `ProductUseCase` inteiro é dublê, então
// provava-se que o Bitz PEDE para pular a OLX — e nada provava que o usecase
// OBEDECE. Apagar o filtro deixava a suíte verde, e o clique de confirmação
// chamaria `deleteAd` na OLX: o anúncio destruído, exatamente o que a regra "o
// Bitz não apaga" existe para impedir.
//
// Aqui o dublê é a camada de baixo, e o filtro roda de verdade.
// ===========================================================================

const listingsMock = vi.fn();
vi.mock("../app/lib/prisma", () => ({
  default: {
    productListing: { findMany: (...a: any[]) => listingsMock(...a) },
  },
}));

const findByIdMock = vi.fn();
vi.mock("../app/repositories/product.repository", () => ({
  ProductRepositoryPrisma: class {
    findById = (...a: any[]) => findByIdMock(...a);
  },
}));

const updateListingStatusMock = vi.fn();
vi.mock("../app/marketplaces/usecases/listing.usercase", () => ({
  ListingUseCase: {
    updateListingStatus: (...a: any[]) => updateListingStatusMock(...a),
  },
}));

import { ProductUseCase } from "../app/usecases/product.usercase";

const anuncio = (id: string, platform: string, externo = `EXT-${id}`) => ({
  id,
  externalListingId: externo,
  marketplaceAccountId: `acc-${platform}`,
  marketplaceAccount: { platform },
});

/** Quais anúncios (ids) foram de fato mandados mudar de situação. */
const idsChamados = () => updateListingStatusMock.mock.calls.map((c) => c[0]);

beforeEach(() => {
  findByIdMock.mockReset().mockResolvedValue({ id: "p1", sku: "4821" });
  listingsMock.mockReset();
  updateListingStatusMock
    .mockReset()
    .mockResolvedValue({ success: true, alreadyInState: false });
});

describe("⭐⭐ pularPlataformas protege o anúncio que não pode ser pausado", () => {
  it("com [OLX], o anúncio da OLX NÃO recebe chamada nenhuma", async () => {
    listingsMock.mockResolvedValue([
      anuncio("l-ml", "MERCADO_LIVRE"),
      anuncio("l-olx", "OLX"),
      anuncio("l-shopee", "SHOPEE"),
    ]);

    await new ProductUseCase().pauseListings("p1", "t1", "paused", {
      pularPlataformas: ["OLX" as any],
    });

    // ⚠️ Na OLX `updateListingStatus` chama `OlxApiService.deleteAd`. Um único
    // vazamento aqui e o anúncio some do canal, sem volta.
    expect(idsChamados()).toEqual(["l-ml", "l-shopee"]);
    expect(idsChamados()).not.toContain("l-olx");
  });

  it("peça SÓ na OLX não gera chamada nenhuma", async () => {
    listingsMock.mockResolvedValue([anuncio("l-olx", "OLX")]);

    const r = await new ProductUseCase().pauseListings("p1", "t1", "paused", {
      pularPlataformas: ["OLX" as any],
    });

    expect(updateListingStatusMock).not.toHaveBeenCalled();
    expect(r.success).toBe(true);
    expect(r.listingResults).toEqual([]);
  });
});

describe("⭐ sem a opção, o comportamento é o de sempre", () => {
  it("SEM `pularPlataformas` a OLX entra — é o que a TELA faz", async () => {
    listingsMock.mockResolvedValue([
      anuncio("l-ml", "MERCADO_LIVRE"),
      anuncio("l-olx", "OLX"),
    ]);

    await new ProductUseCase().pauseListings("p1", "t1", "paused");

    // A tela de Produtos e a baixa de estoque continuam pausando TUDO. Este
    // teste é o que impede a opção nova de virar mudança de comportamento.
    expect(idsChamados()).toEqual(["l-ml", "l-olx"]);
  });

  it("lista vazia de exclusão também não muda nada", async () => {
    listingsMock.mockResolvedValue([anuncio("l-olx", "OLX")]);
    await new ProductUseCase().pauseListings("p1", "t1", "active", {
      pularPlataformas: [],
    });
    expect(idsChamados()).toEqual(["l-olx"]);
  });

  it("o filtro de PENDING_ continua valendo junto com o de plataforma", async () => {
    listingsMock.mockResolvedValue([
      anuncio("l-pend", "MERCADO_LIVRE", "PENDING_xyz"),
      anuncio("l-ml", "MERCADO_LIVRE"),
      anuncio("l-olx", "OLX"),
    ]);

    await new ProductUseCase().pauseListings("p1", "t1", "paused", {
      pularPlataformas: ["OLX" as any],
    });

    expect(idsChamados()).toEqual(["l-ml"]);
  });
});
