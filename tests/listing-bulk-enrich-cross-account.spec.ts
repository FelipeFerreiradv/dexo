import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * enrichCrossAccountIncrease (POST /listings/bulk): congela os mapas de índice
 * por plataforma no overrideTemplate persistido do job. ML mantém a leniência
 * histórica (congela mesmo com 1 conta; idx 0 = sem efeito); os mapas
 * Shopee/Magalu novos só existem com 2+ contas da plataforma e kill-switch
 * desligado. Mocka os módulos pesados que o módulo de rotas importa (mesmo
 * padrão de product-routes-listing-price.spec.ts).
 */

vi.mock("../app/marketplaces/usecases/listing.usercase", () => ({
  ListingUseCase: {},
}));

vi.mock("../app/lib/prisma", () => ({
  default: {
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logInfo: vi.fn(),
    logWarning: vi.fn(),
    logError: vi.fn(),
    log: vi.fn(),
  },
}));

import { enrichCrossAccountIncrease } from "../app/routes/listing.routes";
import prisma from "../app/lib/prisma";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const mixedRequests = [
  { platform: "MERCADO_LIVRE" as const, accountId: "a" },
  { platform: "SHOPEE" as const, accountId: "s1" },
  { platform: "SHOPEE" as const, accountId: "s2" },
  { platform: "MAGALU" as const, accountId: "m1" },
  { platform: "MAGALU" as const, accountId: "m2" },
];

describe("enrichCrossAccountIncrease — mapas por plataforma", () => {
  it("congela os 3 mapas (ML lenient com 1 conta; Shopee/Magalu com 2+)", async () => {
    const out = await enrichCrossAccountIncrease("user-1", mixedRequests, {
      crossAccountIncrease: { enabled: true, percent: 10 },
    });
    expect(out).toEqual({
      crossAccountIncrease: {
        enabled: true,
        percent: 10,
        indexByAccountId: { a: 0 },
        shopeeIndexByAccountId: { s1: 0, s2: 1 },
        magaluIndexByAccountId: { m1: 0, m2: 1 },
      },
    });
  });

  it("congela também os mapas OLX/FB (sem eles o job publicava no preço base)", async () => {
    const out = await enrichCrossAccountIncrease(
      "user-1",
      [
        { platform: "OLX" as const, accountId: "o1" },
        { platform: "OLX" as const, accountId: "o2" },
        { platform: "FACEBOOK" as const, accountId: "f1" },
        { platform: "FACEBOOK" as const, accountId: "f2" },
      ],
      { crossAccountIncrease: { enabled: true, percent: 10 } },
    );
    // A prévia já mostrava a escada; sem estes mapas o job persistido publicava
    // tudo no preço base (o dispatcher só escalona a plataforma que tem mapa).
    expect(out?.crossAccountIncrease?.olxIndexByAccountId).toEqual({
      o1: 0,
      o2: 1,
    });
    expect(out?.crossAccountIncrease?.fbIndexByAccountId).toEqual({
      f1: 0,
      f2: 1,
    });
  });

  it("só 1 conta Shopee ⇒ mapa Shopee omitido (nada a escalonar)", async () => {
    const out = await enrichCrossAccountIncrease(
      "user-1",
      [
        { platform: "MERCADO_LIVRE" as const, accountId: "a" },
        { platform: "MERCADO_LIVRE" as const, accountId: "b" },
        { platform: "SHOPEE" as const, accountId: "s1" },
      ],
      { crossAccountIncrease: { enabled: true, percent: 10 } },
    );
    expect(out).toEqual({
      crossAccountIncrease: {
        enabled: true,
        percent: 10,
        indexByAccountId: { a: 0, b: 1 },
      },
    });
  });

  it("percent ausente ⇒ fallback à preferência do usuário (clamp 0..100 preservado)", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      crossAccountPriceIncreasePercent: 15,
    });
    const out = await enrichCrossAccountIncrease("user-1", mixedRequests, {
      crossAccountIncrease: { enabled: true } as never,
    });
    expect(out?.crossAccountIncrease?.percent).toBe(15);
    expect(out?.crossAccountIncrease?.shopeeIndexByAccountId).toEqual({
      s1: 0,
      s2: 1,
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { crossAccountPriceIncreasePercent: true },
    });
  });

  it("percent resolvido 0 ⇒ remove a flag (no-op, comportamento legado)", async () => {
    const out = await enrichCrossAccountIncrease("user-1", mixedRequests, {
      crossAccountIncrease: { enabled: true, percent: 0 },
    });
    expect(out).toBeNull();
  });

  it("template null ou flag desligada ⇒ retorna inalterado", async () => {
    expect(await enrichCrossAccountIncrease("user-1", mixedRequests, null)).toBeNull();
    const tpl = { titleSuffix: "X" };
    expect(
      await enrichCrossAccountIncrease("user-1", mixedRequests, tpl),
    ).toBe(tpl);
  });

  it("kill-switch ligado ⇒ só o mapa ML (jobs novos ficam ML-only)", async () => {
    vi.stubEnv("CROSS_ACCOUNT_STAGGER_MARKETPLACES_DISABLED", "1");
    const out = await enrichCrossAccountIncrease("user-1", mixedRequests, {
      crossAccountIncrease: { enabled: true, percent: 10 },
    });
    expect(out).toEqual({
      crossAccountIncrease: {
        enabled: true,
        percent: 10,
        indexByAccountId: { a: 0 },
      },
    });
  });
});
