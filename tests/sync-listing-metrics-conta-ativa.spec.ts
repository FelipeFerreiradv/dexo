import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Rotina de métricas (visitas/avaliações) do dexo-sync-orders.
 *
 * Medido em produção (16/09/2026): varria contas ERROR/INACTIVE com token
 * morto e fazia 2 chamadas por anúncio que voltavam 401, cada uma logada com o
 * AxiosError inteiro (token incluído). Travado aqui:
 *  - só contas ACTIVE entram na consulta;
 *  - token recusado relê a conta UMA vez e, se não mudou, para a conta;
 *  - token renovado no banco no meio do ciclo é aproveitado;
 *  - nenhum log carrega o token.
 */

const TOKEN = "APP_USR-1111111111111111-091612-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1";

const prismaMock = vi.hoisted(() => ({
  marketplaceAccount: { findMany: vi.fn(), findUnique: vi.fn() },
  productListing: { findMany: vi.fn(), update: vi.fn() },
}));
vi.mock("../app/lib/prisma", () => ({ default: prismaMock }));
vi.mock("@/app/lib/prisma", () => ({ default: prismaMock }));

const mlMock = vi.hoisted(() => ({
  getItemsVisits: vi.fn(),
  getItemReviewSummary: vi.fn(),
}));
vi.mock("../app/marketplaces/services/ml-api.service", () => ({
  MLApiService: mlMock,
}));
vi.mock("../app/marketplaces/services/shopee-api.service", () => ({
  ShopeeApiService: { getItemDetail: vi.fn() },
}));

import { syncMercadoLivre, syncShopee } from "../scripts/sync-listing-metrics";

function listings(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `l${i}`,
    externalListingId: `MLB${1000 + i}`,
  }));
}

function authError() {
  return new Error("invalid access token");
}

describe("sync-listing-metrics", () => {
  let logs: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    logs = [];
    const grab = (...a: unknown[]) => {
      logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(grab);
    vi.spyOn(console, "warn").mockImplementation(grab);
    vi.spyOn(console, "error").mockImplementation(grab);
    prismaMock.productListing.update.mockResolvedValue({});
  });

  async function run(p: Promise<unknown>) {
    await vi.runAllTimersAsync();
    return p;
  }

  it("ML e Shopee consultam só contas ACTIVE", async () => {
    prismaMock.marketplaceAccount.findMany.mockResolvedValue([]);
    await run(syncMercadoLivre());
    await run(syncShopee());
    const wheres = prismaMock.marketplaceAccount.findMany.mock.calls.map((c) => c[0].where);
    expect(wheres).toHaveLength(2);
    for (const w of wheres) expect(w.status).toBe("ACTIVE");
  });

  it("token recusado e sem token novo no banco: para a conta com UMA linha de log", async () => {
    prismaMock.marketplaceAccount.findMany.mockResolvedValue([
      { id: "a1", accessToken: TOKEN, externalUserId: "1", accountName: "CONTA-1" },
    ]);
    prismaMock.productListing.findMany.mockResolvedValue(listings(50));
    prismaMock.marketplaceAccount.findUnique.mockResolvedValue({ accessToken: TOKEN, status: "ACTIVE" });
    mlMock.getItemsVisits.mockRejectedValue(authError());
    mlMock.getItemReviewSummary.mockRejectedValue(authError());

    await run(syncMercadoLivre());

    // 1ª chamada falha, relê a conta (mesmo token), 2ª falha => para.
    expect(mlMock.getItemsVisits.mock.calls.length).toBeLessThanOrEqual(2);
    expect(prismaMock.marketplaceAccount.findUnique).toHaveBeenCalledTimes(1);
    expect(logs.filter((l) => l.includes("token recusado"))).toHaveLength(2);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("token renovado no banco durante o ciclo: segue com o token novo", async () => {
    const NOVO = "APP_USR-2222222222222222-091612-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-1";
    prismaMock.marketplaceAccount.findMany.mockResolvedValue([
      { id: "a1", accessToken: TOKEN, externalUserId: "1", accountName: "CONTA-1" },
    ]);
    prismaMock.productListing.findMany.mockResolvedValue(listings(3));
    prismaMock.marketplaceAccount.findUnique.mockResolvedValue({ accessToken: NOVO, status: "ACTIVE" });
    mlMock.getItemsVisits.mockImplementation(async (tok: string, [id]: string[]) => {
      if (tok !== NOVO) throw authError();
      return { [id]: 7 };
    });
    mlMock.getItemReviewSummary.mockResolvedValue({ totalReviews: 1, ratingAverage: 5 });

    await run(syncMercadoLivre());

    const tokensUsados = mlMock.getItemsVisits.mock.calls.map((c) => c[0]);
    expect(tokensUsados.slice(1).every((t) => t === NOVO)).toBe(true);
    expect(prismaMock.productListing.update).toHaveBeenCalledTimes(3);
    expect(logs.join("\n")).not.toContain("interrompida");
  });

  it("erro que não é de token (ex.: 429) não para a conta", async () => {
    prismaMock.marketplaceAccount.findMany.mockResolvedValue([
      { id: "a1", accessToken: TOKEN, externalUserId: "1", accountName: "CONTA-1" },
    ]);
    prismaMock.productListing.findMany.mockResolvedValue(listings(4));
    mlMock.getItemsVisits.mockImplementation(async (_t: string, [id]: string[]) => ({ [id]: 1 }));
    mlMock.getItemReviewSummary.mockRejectedValue(new Error("too_many_requests"));

    await run(syncMercadoLivre());

    expect(mlMock.getItemsVisits).toHaveBeenCalledTimes(4);
    expect(prismaMock.marketplaceAccount.findUnique).not.toHaveBeenCalled();
  });
});
