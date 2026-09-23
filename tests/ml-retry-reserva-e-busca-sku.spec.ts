import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";

/**
 * Travas anti-duplicata da revisão de 23/09/2026:
 *  - reserva do botão e re-arme da edição nunca pegam a mesma linha que outro
 *    agente está publicando (consultas condicionais, uma só instrução);
 *  - a busca por seller_sku lê todas as páginas (até o teto) e LANÇA acima
 *    dele — "não achei na 1ª página" deixava de parecer "não existe";
 *  - a decisão da reconciliação confere status, campo de SKU e título.
 */

vi.mock("axios");
vi.mock("../app/lib/prisma", () => ({
  default: {
    productListing: { updateMany: vi.fn(async () => ({ count: 1 })) },
  },
}));

import prisma from "../app/lib/prisma";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import {
  MLApiService,
  ML_SELLER_SKU_SEARCH_MAX_PAGES,
  ML_SELLER_SKU_SEARCH_PAGE,
} from "../app/marketplaces/services/ml-api.service";
import {
  decideReconcile,
  pickReconciledItem,
} from "../app/marketplaces/lib/ml-reconcile.logic";

const NOW = new Date("2026-09-23T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.productListing.updateMany as any).mockResolvedValue({ count: 1 });
});

describe("reserva do botão (claimInteractiveRetry)", () => {
  it("só reserva linha com retry DESLIGADO e sem reserva vigente — uma instrução só", async () => {
    const r = await ListingRepository.claimInteractiveRetry("pl-1", 600_000, NOW);
    expect(r).toEqual(new Date(NOW.getTime() + 600_000));
    const arg = (prisma.productListing.updateMany as any).mock.calls[0][0];
    expect(arg.where).toEqual({
      id: "pl-1",
      retryEnabled: false,
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: NOW } }],
    });
    expect(arg.data).toEqual({ nextRetryAt: new Date(NOW.getTime() + 600_000) });
  });

  it("perdeu a corrida (count 0) ⇒ null", async () => {
    (prisma.productListing.updateMany as any).mockResolvedValue({ count: 0 });
    expect(await ListingRepository.claimInteractiveRetry("pl-1", 1000, NOW)).toBeNull();
  });

  it("liberar só desfaz a PRÓPRIA reserva (se ninguém gravou por cima)", async () => {
    const lease = new Date(NOW.getTime() + 1000);
    await ListingRepository.releaseInteractiveRetry("pl-1", lease);
    const arg = (prisma.productListing.updateMany as any).mock.calls[0][0];
    expect(arg.where).toEqual({ id: "pl-1", retryEnabled: false, nextRetryAt: lease });
    expect(arg.data).toEqual({ nextRetryAt: null });
  });
});

describe("re-arme da edição (rearmCorrectableMlPlaceholders)", () => {
  it("não pega linha reservada pelo botão (nextRetryAt no futuro)", async () => {
    await ListingRepository.rearmCorrectableMlPlaceholders("prod-1", 300_000, NOW);
    const arg = (prisma.productListing.updateMany as any).mock.calls[0][0];
    expect(arg.where.OR).toEqual([
      { nextRetryAt: null },
      { nextRetryAt: { lte: NOW } },
    ]);
    expect(arg.where.lastError).toEqual({ startsWith: "[TERMINAL][CORRIGIVEL]" });
    expect(arg.data).not.toHaveProperty("requestedCategoryId");
  });

  it("categoria trocada na correção ⇒ limpa a categoria da tentativa recusada", async () => {
    await ListingRepository.rearmCorrectableMlPlaceholders("prod-1", 300_000, NOW, {
      clearRequestedCategory: true,
    });
    const arg = (prisma.productListing.updateMany as any).mock.calls[0][0];
    expect(arg.data.requestedCategoryId).toBeNull();
  });
});

describe("busca por seller_sku paginada", () => {
  const pagina = (n: number, total: number, offset = 0) => ({
    data: {
      results: Array.from({ length: n }, (_, i) => `MLB${offset + i}`),
      paging: { total, limit: ML_SELLER_SKU_SEARCH_PAGE, offset },
    },
  });

  it("lê as páginas até o total e busca os detalhes em lotes de 20", async () => {
    (axios.get as any).mockImplementation(async (url: string, cfg: any) => {
      if (url.includes("/items/search")) {
        const off = cfg.params.offset;
        return off === 0 ? pagina(100, 130, 0) : pagina(30, 130, 100);
      }
      const ids = String(cfg.params.ids).split(",");
      return { data: ids.map((id) => ({ code: 200, body: { id, status: "active" } })) };
    });
    const itens = await MLApiService.findItemsBySellerSku("tok", "seller", "3398");
    expect(itens).toHaveLength(130);
    const buscas = (axios.get as any).mock.calls.filter((c: any[]) =>
      String(c[0]).includes("/items/search"),
    );
    expect(buscas.map((c: any[]) => c[1].params)).toEqual([
      { seller_sku: "3398", limit: 100, offset: 0 },
      { seller_sku: "3398", limit: 100, offset: 100 },
    ]);
  });

  it("acima do teto ⇒ LANÇA (quem chama não cria nada)", async () => {
    (axios.get as any).mockImplementation(async (url: string, cfg: any) =>
      url.includes("/items/search")
        ? pagina(100, 7328, cfg.params.offset)
        : { data: [] },
    );
    await expect(
      MLApiService.findItemsBySellerSku("tok", "seller", "1"),
    ).rejects.toThrow(/seller_sku_search_truncated/);
    const buscas = (axios.get as any).mock.calls.filter((c: any[]) =>
      String(c[0]).includes("/items/search"),
    );
    expect(buscas).toHaveLength(ML_SELLER_SKU_SEARCH_MAX_PAGES);
  });

  it("nenhum resultado ⇒ [] com uma chamada só", async () => {
    (axios.get as any).mockResolvedValue(pagina(0, 0));
    expect(await MLApiService.findItemsBySellerSku("tok", "seller", "X")).toEqual([]);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });
});

describe("decideReconcile", () => {
  const criado = new Date("2026-09-22T19:34:12.000Z");
  const item = (over: Record<string, unknown>) => ({
    id: "MLB1",
    status: "active",
    dateCreated: "2026-09-22T19:35:00.000Z",
    title: "Sensor MAF",
    ...over,
  });

  it("mesmo título ⇒ adota", () => {
    expect(
      decideReconcile([item({})], {
        placeholderCreatedAt: criado,
        sku: "3398",
        desiredTitle: "Sensor MAF",
      }),
    ).toEqual({ kind: "adopt", item: item({}) });
  });

  it("título diferente ⇒ ambíguo", () => {
    expect(
      decideReconcile([item({ title: "Farol Gol" })], {
        placeholderCreatedAt: criado,
        sku: "3398",
        desiredTitle: "Sensor MAF",
      }).kind,
    ).toBe("ambiguous");
  });

  it("encerrado ou antigo ⇒ nada a adotar", () => {
    const d = decideReconcile(
      [
        item({ id: "MLB_FECHADO", status: "closed" }),
        item({ id: "MLB_VELHO", dateCreated: "2026-07-01T00:00:00.000Z" }),
      ],
      { placeholderCreatedAt: criado, sku: "3398", desiredTitle: "Sensor MAF" },
    );
    expect(d.kind).toBe("none");
  });

  it("campo de SKU do item é outro código ⇒ não é deste produto", () => {
    expect(
      decideReconcile([item({ sellerCustomField: "9999" })], {
        placeholderCreatedAt: criado,
        sku: "3398",
      }).kind,
    ).toBe("none");
  });

  it("pickReconciledItem mantém o contrato (mais recente adotável)", () => {
    expect(
      pickReconciledItem(
        [item({ id: "A" }), item({ id: "B", dateCreated: "2026-09-22T19:36:00.000Z" })],
        criado,
      )?.id,
    ).toBe("B");
  });
});
