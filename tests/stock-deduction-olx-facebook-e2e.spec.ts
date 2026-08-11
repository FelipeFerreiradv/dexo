import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

// ──────────────────────────────────────────────────────────
// BLOCO T-D — baixa de estoque por venda, ponta a ponta, com o MESMO produto
// anunciado em ML + OLX + FACEBOOK ao mesmo tempo.
//
// O elo coberto aqui é o laço de `SyncUseCase.syncProductStock`:
//
//   venda zera o estoque
//     → StockSyncRetryService / firePostEffects
//     → SyncUseCase.syncProductStock(produto)   ← daqui pra baixo é o que se prova
//         ├─ MERCADO_LIVRE : pausa/zera a quantidade do anúncio
//         ├─ OLX           : deleteAd (a OLX não tem estoque per-SKU)
//         └─ FACEBOOK      : setAvailability("out of stock")
//
// Os specs por plataforma (`sync-olx-stock`, `sync-facebook-stock`) montam um
// produto com UM listing só — nenhum deles prova que as três plataformas são
// atendidas na MESMA passada, nem que a falha/kill-switch de uma não contamina
// as outras. É exatamente essa fronteira que este arquivo cobre.
// ──────────────────────────────────────────────────────────

vi.mock("@/app/lib/prisma", () => ({
  default: {
    product: { findUnique: vi.fn() },
    productListing: { findUnique: vi.fn() },
    syncLog: { create: vi.fn(), count: vi.fn() },
    systemLog: { findFirst: vi.fn(), create: vi.fn() },
    marketplaceAccount: { findUnique: vi.fn() },
  },
}));

import prisma from "@/app/lib/prisma";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { OlxApiService } from "@/app/marketplaces/services/olx-api.service";
import { FacebookApiService } from "@/app/marketplaces/services/facebook-api.service";

/** Roda `fn` com as variáveis de ambiente dadas, restaurando no fim. */
async function comEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
) {
  const anterior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    anterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(anterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// O SKU é o MESMO externalListingId na OLX e no Facebook (as duas usam o SKU do
// vendedor como id do anúncio, igual à Magalu). É por isso que o caso 4 existe.
const SKU = "FAROL-77";

const listingMl = {
  id: "l-ml",
  externalListingId: "MLB123",
  status: "active",
  marketplaceAccount: {
    id: "acc-ml",
    platform: Platform.MERCADO_LIVRE,
    accessToken: "tok-ml",
    accountName: "Conta ML",
  },
};

const listingOlx = {
  id: "l-olx",
  externalListingId: SKU,
  status: "active",
  marketplaceAccount: {
    id: "acc-olx",
    platform: Platform.OLX,
    accessToken: "tok-olx",
    accountName: "Conta OLX",
  },
};

const listingFb = {
  id: "l-fb",
  externalListingId: SKU,
  status: "active",
  marketplaceAccount: {
    id: "acc-fb",
    platform: Platform.FACEBOOK,
    accessToken: "tok-fb",
    accountName: "Conta FB",
    // Catálogo por conta é obrigatório no Facebook: sem ele o sync nem tenta.
    fbCatalogId: "cat-fb",
  },
};

/** Produto anunciado nas três plataformas. `listings` é ordenável por caso. */
function produto(stock: number, listings: any[] = [listingMl, listingOlx, listingFb]) {
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
    listings,
  };
}

const porPlataforma = (results: any[], platform: Platform) =>
  results.find((r) => r.platform === platform);

beforeEach(() => {
  vi.clearAllMocks();

  // Prisma: só o que o caminho de baixa toca.
  (prisma as any).product.findUnique.mockResolvedValue(produto(0));
  (prisma as any).productListing.findUnique.mockResolvedValue(null);
  (prisma as any).syncLog.create.mockResolvedValue({});
  (prisma as any).syncLog.count.mockResolvedValue(0);
  (prisma as any).systemLog.findFirst.mockResolvedValue(null);
  (prisma as any).systemLog.create.mockResolvedValue({});
  (prisma as any).marketplaceAccount.findUnique.mockResolvedValue(null);

  // ML: anúncio ATIVO com 3 unidades no remoto (o estado real antes da venda).
  vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
    id: "MLB123",
    status: "active",
    available_quantity: 3,
  } as any);
  vi.spyOn(MLApiService, "updateItem").mockResolvedValue({} as any);
  vi.spyOn(MLApiService, "updateItemStock").mockResolvedValue({} as any);

  // OLX: statusCode 0 = aceito.
  vi.spyOn(OlxApiService, "deleteAd").mockResolvedValue({
    statusCode: 0,
  } as any);
  vi.spyOn(OlxApiService, "submitImport").mockResolvedValue({
    statusCode: 0,
  } as any);
  vi.spyOn(OlxApiService, "pollImportUntilDone").mockResolvedValue(null as any);

  // Facebook: 200 + handles; poll null = lote sem erro.
  vi.spyOn(FacebookApiService, "setAvailability").mockResolvedValue({
    handles: ["h1"],
  } as any);
  vi.spyOn(FacebookApiService, "pollBatchUntilDone").mockResolvedValue(
    null as any,
  );

  // Os DOIS: o ramo FACEBOOK grava por `updateStatus` e o ramo OLX por
  // `updateListing`. Esquecer um deles faz o teste bater no Prisma real.
  vi.spyOn(ListingRepository, "updateStatus").mockResolvedValue({} as any);
  vi.spyOn(ListingRepository, "updateListing").mockResolvedValue({} as any);
  vi.spyOn(ListingRepository, "updateStatusLean").mockResolvedValue({} as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("T-D — baixa de estoque com ML + OLX + FACEBOOK no mesmo produto", () => {
  it("CASO 1: venda que ZERA o estoque atende as três plataformas na MESMA execução", async () => {
    const results = await SyncUseCase.syncProductStock("prod-1");

    // ML: anúncio remoto ATIVO + estoque local 0 ⇒ o código PAUSA o anúncio.
    // (Não é `updateItemStock(...,0)`: o ML rejeita quantidade 0 por API, então
    // a baixa vira status=paused. Ver observações.)
    expect(MLApiService.updateItem).toHaveBeenCalledWith("tok-ml", "MLB123", {
      status: "paused",
    });
    expect(MLApiService.updateItemStock).not.toHaveBeenCalled();

    // OLX: não existe API de estoque per-SKU — zerar = despublicar o anúncio.
    expect(OlxApiService.deleteAd).toHaveBeenCalledWith("tok-olx", SKU);
    expect(OlxApiService.submitImport).not.toHaveBeenCalled();

    // Facebook: o item PERMANECE no catálogo, só muda a disponibilidade — e no
    // catálogo DA CONTA (fbCatalogId), nunca no global do .env.
    expect(FacebookApiService.setAvailability).toHaveBeenCalledWith(
      "tok-fb",
      SKU,
      "out of stock",
      { quantity: 0, catalogId: "cat-fb" },
    );

    // Uma única passada devolve exatamente um resultado por listing, todos ok.
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
    expect(results.some((r) => r.error)).toBe(false);
  });

  it("CASO 1b: ML em status fora dos gates (not_yet_active) ⇒ aí sim quantidade 0", async () => {
    // Prova que o ramo de quantidade continua existindo: só não é o que roda
    // quando o anúncio está ativo (que é o cenário de venda real).
    (MLApiService.getItemDetails as any).mockResolvedValue({
      id: "MLB123",
      status: "not_yet_active",
      available_quantity: 3,
    });

    await SyncUseCase.syncProductStock("prod-1");

    expect(MLApiService.updateItemStock).toHaveBeenCalledWith(
      "tok-ml",
      "MLB123",
      0,
    );
    expect(MLApiService.updateItem).not.toHaveBeenCalled();
  });

  it("CASO 2: falha da OLX não impede ML nem Facebook (erro fica contido no resultado dela)", async () => {
    (OlxApiService.deleteAd as any).mockRejectedValue(
      new Error("OLX indisponível (503)"),
    );

    const results = await SyncUseCase.syncProductStock("prod-1");

    // As outras duas foram atendidas apesar do tombo da OLX.
    expect(MLApiService.updateItem).toHaveBeenCalledTimes(1);
    expect(FacebookApiService.setAvailability).toHaveBeenCalledTimes(1);

    const olx = porPlataforma(results, Platform.OLX);
    expect(olx.success).toBe(false);
    expect(olx.error).toContain("503");
    // O erro NÃO pode contaminar o resultado das outras: se ele fosse propagado
    // ao chamador, a fila de estoque re-tentaria ML e Facebook já sincronizados.
    expect(porPlataforma(results, Platform.MERCADO_LIVRE).success).toBe(true);
    expect(porPlataforma(results, Platform.FACEBOOK).success).toBe(true);
  });

  it("CASO 2b: exceção que ESCAPA de uma plataforma é contida pelo try/catch por listing (as seguintes rodam)", async () => {
    // O Facebook fica no MEIO da lista: se o laço não tivesse try/catch por
    // listing, o ML (último) nunca seria chamado — é isso que discrimina.
    (prisma as any).product.findUnique.mockResolvedValue(
      produto(0, [listingOlx, listingFb, listingMl]),
    );
    (FacebookApiService.setAvailability as any).mockRejectedValue(
      new Error("Meta 500"),
    );
    // O catch interno do Facebook grava SyncLog; com o banco fora, a exceção
    // atravessa `syncFacebookProductStock` e só o laço pode segurá-la.
    (prisma as any).syncLog.create.mockImplementation(async (args: any) =>
      args?.data?.marketplaceAccountId === "acc-fb"
        ? Promise.reject(new Error("pool esgotado"))
        : {},
    );

    const results = await SyncUseCase.syncProductStock("prod-1");

    expect(OlxApiService.deleteAd).toHaveBeenCalledTimes(1);
    expect(MLApiService.updateItem).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(3);

    const fb = porPlataforma(results, Platform.FACEBOOK);
    expect(fb.success).toBe(false);
    // Mesmo vindo do catch do laço (e não do catch da plataforma), o resultado
    // preserva a identidade do listing — sem isso a fila não sabe o que falhou.
    expect(fb.listingId).toBe("l-fb");
  });

  it("CASO 3: OLX_INTEGRATION_DISABLED=1 ⇒ OLX vira skip explícito e ML/Facebook seguem sincronizando", async () => {
    await comEnv({ OLX_INTEGRATION_DISABLED: "1" }, async () => {
      const results = await SyncUseCase.syncProductStock("prod-1");

      // Nenhuma chamada outbound para a OLX.
      expect(OlxApiService.deleteAd).not.toHaveBeenCalled();
      expect(OlxApiService.submitImport).not.toHaveBeenCalled();

      const olx = porPlataforma(results, Platform.OLX);
      // No-op EXPLÍCITO (success + skipReason), não um silêncio: é o que o
      // operador vê para saber que a flag realmente parou a plataforma.
      expect(olx.success).toBe(true);
      expect(olx.skipped).toBe(true);
      expect(olx.skipReason).toBe("integration_disabled");

      // O ponto do caso: o kill-switch de UMA plataforma não pode desligar as
      // que já estão em produção.
      expect(MLApiService.updateItem).toHaveBeenCalledWith(
        "tok-ml",
        "MLB123",
        { status: "paused" },
      );
      expect(FacebookApiService.setAvailability).toHaveBeenCalledTimes(1);
      expect(porPlataforma(results, Platform.MERCADO_LIVRE).success).toBe(true);
      expect(porPlataforma(results, Platform.FACEBOOK).skipped).toBeUndefined();
    });
  });

  it("CASO 3b: FACEBOOK_INTEGRATION_DISABLED=1 desliga só o Facebook (OLX e ML intactos)", async () => {
    await comEnv({ FACEBOOK_INTEGRATION_DISABLED: "1" }, async () => {
      const results = await SyncUseCase.syncProductStock("prod-1");

      expect(FacebookApiService.setAvailability).not.toHaveBeenCalled();
      expect(porPlataforma(results, Platform.FACEBOOK).skipReason).toBe(
        "integration_disabled",
      );
      // A flag é lida por plataforma: a OLX (que compartilha o mesmo SKU) segue.
      expect(OlxApiService.deleteAd).toHaveBeenCalledWith("tok-olx", SKU);
      expect(porPlataforma(results, Platform.OLX).skipped).toBeUndefined();
      expect(MLApiService.updateItem).toHaveBeenCalledTimes(1);
    });
  });

  it("CASO 4: todo resultado carrega listingId + platform — é o que desambigua OLX de Facebook", async () => {
    const results = await SyncUseCase.syncProductStock("prod-1");

    expect(results.map((r) => [r.listingId, r.platform])).toEqual([
      ["l-ml", Platform.MERCADO_LIVRE],
      ["l-olx", Platform.OLX],
      ["l-fb", Platform.FACEBOOK],
    ]);

    // OLX e Facebook usam o MESMO externalListingId (o SKU). Casar o job da
    // fila por externalListingId casaria o anúncio errado; o par
    // (listingId, platform) é o único identificador que discrimina.
    const olx = porPlataforma(results, Platform.OLX);
    const fb = porPlataforma(results, Platform.FACEBOOK);
    expect(olx.externalListingId).toBe(fb.externalListingId);
    expect(olx.listingId).not.toBe(fb.listingId);
  });

  it("CASO 4b: o resultado do kill-switch também vem identificado (é outro objeto no código)", async () => {
    // O ramo do kill-switch monta um SyncResult próprio, sem passar pelo
    // `{...result, listingId, platform}` do final do laço: se alguém esquecer
    // os campos lá, só este caso pega.
    await comEnv(
      { OLX_INTEGRATION_DISABLED: "1", FACEBOOK_INTEGRATION_DISABLED: "1" },
      async () => {
        const results = await SyncUseCase.syncProductStock("prod-1");
        const olx = porPlataforma(results, Platform.OLX);
        const fb = porPlataforma(results, Platform.FACEBOOK);
        expect(olx.listingId).toBe("l-olx");
        expect(olx.externalListingId).toBe(SKU);
        expect(fb.listingId).toBe("l-fb");
        expect(fb.platform).toBe(Platform.FACEBOOK);
      },
    );
  });
});
