import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify from "fastify";

/**
 * POST /listings/bulk/:jobId/retry-failed não reprocessa as linhas que
 * falharam por atributo obrigatório do ML (code ML_REQUIRED_ATTRIBUTES_MISSING):
 * a falha é definitiva e reprocessar só repetiria o bloqueio. Linhas sem
 * `code` (jobs antigos, outras falhas) seguem como sempre.
 */

vi.mock("../app/marketplaces/usecases/listing.usercase", () => ({
  ListingUseCase: {},
}));

vi.mock("../app/marketplaces/services/listing-dispatcher.service", () => ({
  ListingDispatcher: {
    dispatch: vi.fn(),
    dispatchBatch: vi.fn(async () => ({ success: 0, failed: 0 })),
  },
}));

vi.mock("../app/marketplaces/repositories/bulk-listing-job.repository", () => ({
  BulkListingJobRepository: {
    findByIdAndUser: vi.fn(),
    create: vi.fn(async (d: any) => ({ id: "job-novo", ...d })),
    markRunning: vi.fn(),
    appendResult: vi.fn(),
    markFinal: vi.fn(),
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logError: vi.fn(),
    logWarning: vi.fn(),
    logInfo: vi.fn(),
    log: vi.fn(),
  },
}));

vi.mock("../app/lib/prisma", () => ({
  default: {
    product: { findMany: vi.fn() },
    productListing: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

import { listingRoutes } from "../app/routes/listing.routes";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";
import { BulkListingJobRepository } from "../app/marketplaces/repositories/bulk-listing-job.repository";

const fakeUser = {
  id: "user-1",
  email: "test@example.com",
  name: "Test",
  dataOwnerId: "user-1",
} as any;

const job = (results: any[]) => ({
  id: "job-1",
  results,
  requests: [
    { platform: "MERCADO_LIVRE", accountId: "ml-1", categoryId: undefined },
    { platform: "SHOPEE", accountId: "shp-1" },
  ],
  overrideTemplate: null,
});

describe("POST /listings/bulk/:jobId/retry-failed — obrigatórios do ML", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = fastify();
    await app.register(listingRoutes, { prefix: "/listings" });
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(fakeUser);
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(fakeUser);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const retry = () =>
    app.inject({
      method: "POST",
      url: "/listings/bulk/job-1/retry-failed",
      headers: { email: "test@example.com" },
    });

  it("pula as linhas terminais por obrigatório e reprocessa as demais", async () => {
    (BulkListingJobRepository.findByIdAndUser as any).mockResolvedValue(
      job([
        {
          productId: "p1",
          platform: "MERCADO_LIVRE",
          accountId: "ml-1",
          success: false,
          code: "ML_REQUIRED_ATTRIBUTES_MISSING",
        },
        { productId: "p2", platform: "SHOPEE", accountId: "shp-1", success: false },
      ]),
    );
    const res = await retry();
    expect(res.statusCode, res.payload).toBe(202);
    const criado = (BulkListingJobRepository.create as any).mock.calls[0][0];
    expect(criado.productIds).toEqual(["p2"]);
    expect(criado.requests.map((r: any) => r.platform)).toEqual(["SHOPEE"]);
  });

  it("só falhas terminais por obrigatório → nada para reprocessar (400)", async () => {
    (BulkListingJobRepository.findByIdAndUser as any).mockResolvedValue(
      job([
        {
          productId: "p1",
          platform: "MERCADO_LIVRE",
          accountId: "ml-1",
          success: false,
          code: "ML_REQUIRED_ATTRIBUTES_MISSING",
        },
        { productId: "p3", platform: "MERCADO_LIVRE", accountId: "ml-1", success: true },
      ]),
    );
    const res = await retry();
    expect(res.statusCode).toBe(400);
    expect(BulkListingJobRepository.create).not.toHaveBeenCalled();
  });

  it("linhas sem `code` (jobs antigos) seguem reprocessadas como sempre", async () => {
    (BulkListingJobRepository.findByIdAndUser as any).mockResolvedValue(
      job([
        { productId: "p1", platform: "MERCADO_LIVRE", accountId: "ml-1", success: false },
      ]),
    );
    const res = await retry();
    expect(res.statusCode).toBe(202);
    expect((BulkListingJobRepository.create as any).mock.calls[0][0].productIds).toEqual([
      "p1",
    ]);
  });
});
