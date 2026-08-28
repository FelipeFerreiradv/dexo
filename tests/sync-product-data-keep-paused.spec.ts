import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

// ──────────────────────────────────────────────────────────
// A ÚLTIMA PORTA: editar o produto não pode devolver o anúncio ao ar.
//
// `syncProductData` roda em TODA edição de produto — trocar o preço, corrigir
// o título, subir uma foto. Na OLX e no Facebook esse caminho reenviava o
// anúncio inteiro com `availability` derivado só do estoque, então um lojista
// com a reabertura DESLIGADA via o anúncio voltar ao ar por ter mexido no
// cadastro. Nada a ver com cancelamento; mesma consequência.
//
// As duas plataformas exigem tratamentos DIFERENTES, e a diferença é da API:
//
//  · OLX  — `submitImport` É a publicação. Não existe "atualizar sem publicar",
//           então a única saída honesta é não sincronizar enquanto o anúncio
//           estiver fora do ar. É o que o Mercado Livre já faz com item pausado
//           (`status === "active" && stock > 0` no syncMLProductData).
//
//  · META — `upsertItem` atualiza título, descrição e fotos SEM tornar o item
//           comprável. Então aqui dá para fazer o certo pelos dois lados: a
//           edição chega ao catálogo e a disponibilidade fica segura.
//
// Os controles negativos são o que dá valor ao arquivo: com a preferência
// LIGADA os dois canais têm de continuar exatamente como sempre foram.
// ──────────────────────────────────────────────────────────

vi.mock("@/app/lib/prisma", () => ({
  default: {
    product: { findUnique: vi.fn() },
    productListing: { findUnique: vi.fn() },
    productCompatibility: { findMany: vi.fn() },
    marketplaceAccount: { findUnique: vi.fn() },
    syncLog: { create: vi.fn(), count: vi.fn() },
    systemLog: { findFirst: vi.fn(), create: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

import prisma from "@/app/lib/prisma";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";
import { OlxApiService } from "@/app/marketplaces/services/olx-api.service";
import { FacebookApiService } from "@/app/marketplaces/services/facebook-api.service";
import { FacebookPayloadBuilderService } from "@/app/marketplaces/services/facebook-payload-builder.service";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";

const SKU = "FAROL-77";
const OWNER = "tenant-1";
const ACCOUNT_OLX = "acc-olx";
const ACCOUNT_FB = "acc-fb";

const contaOlx = {
  id: ACCOUNT_OLX,
  userId: OWNER,
  platform: Platform.OLX,
  accessToken: "tok-olx",
  accountName: "Conta OLX",
  olxSellerPhone: "11999999999",
  olxSellerZipcode: "01001000",
};

const contaFb = {
  id: ACCOUNT_FB,
  userId: OWNER,
  platform: Platform.FACEBOOK,
  accessToken: "tok-fb",
  accountName: "Conta FB",
  fbCatalogId: "cat-fb",
  // Sem isto o `build` da Meta lança antes de chegar ao `upsertItem`, e os
  // casos passariam pelo motivo errado: a asserção sobre o payload é feita no
  // construtor, que é chamado ANTES da falha.
  fbProductUrlBase: "https://loja.example/p",
};

function produto(stock = 1) {
  return {
    id: "prod-1",
    name: "Farol Direito Gol 2012",
    sku: SKU,
    stock,
    price: 250,
    brand: "VW",
    model: "Gol",
    year: "2012",
    quality: "SUCATA",
    imageUrl: "https://img.example/1.jpg",
    imageUrls: ["https://img.example/1.jpg"],
    olxCategoryId: 555,
  };
}

/** `status` do anúncio na Dexo — `paused` = fomos nós que o tiramos do ar. */
function comAnuncio(status: string, id = "l-1") {
  (prisma as any).productListing.findUnique.mockResolvedValue({
    id,
    status,
    externalListingId: SKU,
  });
}

/** `pref` indefinido = usuário ausente do resultado (fail-open). */
function comPreferencia(pref?: boolean | null) {
  (prisma as any).user.findMany.mockResolvedValue(
    pref === undefined
      ? []
      : [{ id: OWNER, reopenListingsOnSaleCancel: pref, parent: null }],
  );
}

beforeEach(() => {
  vi.clearAllMocks();

  (prisma as any).product.findUnique.mockResolvedValue(produto());
  (prisma as any).productCompatibility.findMany.mockResolvedValue([]);
  (prisma as any).syncLog.create.mockResolvedValue({});
  (prisma as any).syncLog.count.mockResolvedValue(0);
  (prisma as any).systemLog.findFirst.mockResolvedValue(null);
  (prisma as any).systemLog.create.mockResolvedValue({});

  vi.spyOn(OlxApiService, "deleteAd").mockResolvedValue({ statusCode: 0 } as any);
  vi.spyOn(OlxApiService, "submitImport").mockResolvedValue({
    statusCode: 0,
  } as any);
  vi.spyOn(OlxApiService, "pollImportUntilDone").mockResolvedValue(null as any);

  vi.spyOn(FacebookApiService, "upsertItem").mockResolvedValue({
    handles: ["h1"],
  } as any);
  vi.spyOn(FacebookApiService, "pollBatchUntilDone").mockResolvedValue(
    null as any,
  );

  vi.spyOn(ListingRepository, "updateStatus").mockResolvedValue({} as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── OLX ──────────────────────────────────────────────────────────────

describe("Edição de produto na OLX — anúncio fora do ar", () => {
  beforeEach(() => {
    (prisma as any).marketplaceAccount.findUnique.mockResolvedValue(contaOlx);
  });

  const editar = () =>
    SyncUseCase.syncProductData("prod-1", SKU, ACCOUNT_OLX);

  it("DESLIGADA + anúncio pausado: não republica", async () => {
    comAnuncio("paused");
    comPreferencia(false);

    const res = await editar();

    expect(OlxApiService.submitImport).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect((res as any).skipReason).toBe("olx_reopen_disabled_by_preference");
  });

  it("CONTROLE NEGATIVO — LIGADA: sincroniza, como sempre fez", async () => {
    comAnuncio("paused");
    comPreferencia(true);

    await editar();

    expect(OlxApiService.submitImport).toHaveBeenCalledTimes(1);
  });

  it("anúncio ATIVO: sincroniza mesmo com a preferência desligada", async () => {
    // A guarda protege o que NÓS tiramos do ar. Um anúncio no ar continua
    // recebendo as edições normalmente.
    comAnuncio("active");
    comPreferencia(false);

    await editar();

    expect(OlxApiService.submitImport).toHaveBeenCalledTimes(1);
  });

  it("estoque ZERO continua despublicando — o veto é unidirecional", async () => {
    (prisma as any).product.findUnique.mockResolvedValue(produto(0));
    comAnuncio("active");
    comPreferencia(false);

    await editar();

    expect(OlxApiService.deleteAd).toHaveBeenCalledTimes(1);
  });

  it("FAIL-OPEN: preferência ilegível ⇒ sincroniza", async () => {
    comAnuncio("paused");
    comPreferencia(undefined);

    await editar();

    expect(OlxApiService.submitImport).toHaveBeenCalledTimes(1);
  });
});

// ── Facebook ─────────────────────────────────────────────────────────

describe("Edição de produto no Facebook — anúncio fora do ar", () => {
  beforeEach(() => {
    (prisma as any).marketplaceAccount.findUnique.mockResolvedValue(contaFb);
  });

  const editar = () => SyncUseCase.syncProductData("prod-1", SKU, ACCOUNT_FB);

  /** O que foi pedido ao construtor do payload da Meta. */
  function payload() {
    const spy = FacebookPayloadBuilderService.build as any;
    return spy.mock.calls[0]?.[1];
  }

  it("DESLIGADA + pausado: os DADOS sobem, a disponibilidade fica segura", async () => {
    const spy = vi.spyOn(FacebookPayloadBuilderService, "build");
    comAnuncio("paused");
    comPreferencia(false);

    const res = await editar();

    // O item continua sendo atualizado — a edição do lojista não se perde.
    expect(FacebookApiService.upsertItem).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(payload()).toMatchObject({
      availability: "out of stock",
      quantity: 0,
    });
    expect(res.success).toBe(true);
  });

  it("CONTROLE NEGATIVO — LIGADA: volta para `in stock` com a quantidade real", async () => {
    vi.spyOn(FacebookPayloadBuilderService, "build");
    comAnuncio("paused");
    comPreferencia(true);

    await editar();

    expect(payload()).toMatchObject({ availability: "in stock", quantity: 1 });
  });

  it("anúncio ATIVO: `in stock`, mesmo com a preferência desligada", async () => {
    vi.spyOn(FacebookPayloadBuilderService, "build");
    comAnuncio("active");
    comPreferencia(false);

    await editar();

    expect(payload()).toMatchObject({ availability: "in stock", quantity: 1 });
  });

  it("estoque ZERO continua `out of stock`", async () => {
    vi.spyOn(FacebookPayloadBuilderService, "build");
    (prisma as any).product.findUnique.mockResolvedValue(produto(0));
    comAnuncio("active");
    comPreferencia(false);

    await editar();

    expect(payload()).toMatchObject({ availability: "out of stock" });
  });

  it("FAIL-OPEN: preferência ilegível ⇒ `in stock`", async () => {
    vi.spyOn(FacebookPayloadBuilderService, "build");
    comAnuncio("paused");
    comPreferencia(undefined);

    await editar();

    expect(payload()).toMatchObject({ availability: "in stock" });
  });
});

// ── Egress ───────────────────────────────────────────────────────────

describe("EGRESS — a preferência não vira consulta por anúncio", () => {
  it("dois anúncios do mesmo produto compartilham a leitura", async () => {
    // Regra 5 da casa. `syncProductListings` chama este método uma vez por
    // anúncio do MESMO produto — logo do mesmo dono. O memo é criado lá e
    // repassado; aqui simulamos as duas chamadas do laço.
    (prisma as any).marketplaceAccount.findUnique.mockResolvedValue(contaOlx);
    comAnuncio("paused");
    comPreferencia(false);

    const memo = new Map<string, boolean>();
    await SyncUseCase.syncProductData("prod-1", SKU, ACCOUNT_OLX, memo);
    await SyncUseCase.syncProductData("prod-1", SKU, ACCOUNT_OLX, memo);

    expect((prisma as any).user.findMany).toHaveBeenCalledTimes(1);
    expect(OlxApiService.submitImport).not.toHaveBeenCalled();
  });

  it("anúncio que não está pausado não gera consulta nenhuma", async () => {
    (prisma as any).marketplaceAccount.findUnique.mockResolvedValue(contaOlx);
    comAnuncio("active");
    comPreferencia(false);

    await SyncUseCase.syncProductData("prod-1", SKU, ACCOUNT_OLX);

    expect((prisma as any).user.findMany).not.toHaveBeenCalled();
  });
});
