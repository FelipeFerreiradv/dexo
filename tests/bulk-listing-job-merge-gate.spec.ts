import { beforeEach, describe, expect, it, vi } from "vitest";

const { events, tx, database } = vi.hoisted(() => {
  const hoistedEvents: string[] = [];
  const hoistedTx = {
    $executeRaw: vi.fn(async () => {
      hoistedEvents.push("gate");
      return 1;
    }),
    product: { findMany: vi.fn() },
    bulkListingJob: { create: vi.fn() },
  };
  return {
    events: hoistedEvents,
    tx: hoistedTx,
    database: {
      $transaction: vi.fn(
        async (
          run: (client: typeof hoistedTx) => unknown,
          _options?: { maxWait?: number; timeout?: number },
        ) => run(hoistedTx),
      ),
    },
  };
});

vi.mock("@/app/lib/prisma", () => ({ default: database }));

import { CATALOG_PRODUCT_MERGE_LOCK_KEY } from "@/app/marketplaces/lib/catalog-merge-lock";
import { BulkListingJobRepository } from "@/app/marketplaces/repositories/bulk-listing-job.repository";

const input = {
  userId: "tenant-1",
  productIds: ["p-2", "p-1"],
  requests: [{ platform: "MERCADO_LIVRE" as const, accountId: "account-1" }],
};

describe("BulkListingJob catalog merge gate", () => {
  beforeEach(() => {
    events.length = 0;
    vi.clearAllMocks();
    tx.product.findMany.mockImplementation(async () => {
      events.push("validate-products");
      return [{ id: "p-1" }, { id: "p-2" }];
    });
    tx.bulkListingJob.create.mockImplementation(async (payload: any) => {
      events.push("create-job");
      return { id: "job-1", ...payload.data };
    });
  });

  it("takes the shared gate and revalidates tenant ownership before create", async () => {
    await BulkListingJobRepository.create(input);

    expect(events).toEqual(["gate", "validate-products", "create-job"]);
    expect(tx.$executeRaw.mock.calls[0]).toContain(
      CATALOG_PRODUCT_MERGE_LOCK_KEY,
    );
    expect(tx.product.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["p-1", "p-2"] }, userId: "tenant-1" },
      select: { id: true },
    });
    expect(database.$transaction.mock.calls[0][1]).toEqual({
      maxWait: 20_000,
      timeout: 60_000,
    });
  });

  it("refuses a job if a donor disappeared while waiting for the merge", async () => {
    tx.product.findMany.mockImplementationOnce(async () => {
      events.push("validate-products");
      return [{ id: "p-1" }];
    });

    await expect(BulkListingJobRepository.create(input)).rejects.toThrow(
      /não existem mais ou pertencem a outro estoque/i,
    );
    expect(tx.bulkListingJob.create).not.toHaveBeenCalled();
  });
});
