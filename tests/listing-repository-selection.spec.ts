import { describe, it, expect, vi, afterEach } from "vitest";

import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import prisma from "@/app/lib/prisma";

/**
 * Um par (produto, conta) pode ter VÁRIAS linhas de ProductListing — o
 * autodetect cria uma por anúncio, e a base tem milhares de pares assim.
 * `findByProductAndAccount` era um findFirst SEM orderBy: devolvia uma linha
 * arbitrária, e o createMLListing chegou a reusar a linha de um anúncio VIVO
 * em vez do placeholder do candidato (flagrado no piloto de reabilitação:
 * marcou retry num anúncio ativo — o cron recriaria = duplicata no ML).
 *
 * Contrato novo: preferir o placeholder PENDING_ mais recente; senão, a linha
 * mais recente. Determinístico.
 */

const row = (id: string, externalListingId: string) =>
  ({ id, externalListingId }) as any;

describe("ListingRepository.findByProductAndAccount — seleção determinística", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefere o placeholder PENDING_ mesmo quando há linha real mais recente", async () => {
    // findMany devolve orderBy createdAt desc: a linha real (anúncio vivo) é
    // a mais recente, o placeholder é mais antigo — cenário exato do piloto.
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([
      row("l-real-nova", "MLB4897260131"),
      row("l-real-velha", "MLB7021506612"),
      row("l-placeholder", "PENDING_1778336697276"),
    ] as any);

    const found = await ListingRepository.findByProductAndAccount("p1", "a1");

    expect(found?.id).toBe("l-placeholder");
  });

  it("sem placeholder, devolve a linha mais recente", async () => {
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([
      row("l-nova", "MLB2"),
      row("l-velha", "MLB1"),
    ] as any);

    const found = await ListingRepository.findByProductAndAccount("p1", "a1");

    expect(found?.id).toBe("l-nova");
  });

  it("ordena por createdAt desc na query (determinismo vem do banco)", async () => {
    const spy = vi
      .spyOn(prisma.productListing, "findMany")
      .mockResolvedValue([] as any);

    await ListingRepository.findByProductAndAccount("p1", "a1");

    expect(spy.mock.calls[0][0]).toMatchObject({
      where: { productId: "p1", marketplaceAccountId: "a1" },
      orderBy: { createdAt: "desc" },
    });
  });

  it("devolve null quando o par não tem linhas", async () => {
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([] as any);

    expect(await ListingRepository.findByProductAndAccount("p1", "a1")).toBe(
      null,
    );
  });
});

describe("ListingRepository.findLiveByProductAndAccount", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("busca só anúncio vivo (active/paused) com id real, select mínimo", async () => {
    const spy = vi
      .spyOn(prisma.productListing, "findFirst")
      .mockResolvedValue(null);

    await ListingRepository.findLiveByProductAndAccount("p1", "a1");

    const arg = spy.mock.calls[0][0] as any;
    expect(arg.where).toMatchObject({
      productId: "p1",
      marketplaceAccountId: "a1",
      status: { in: ["active", "paused"] },
      NOT: { externalListingId: { startsWith: "PENDING_" } },
    });
    // closed NÃO entra: recriar anúncio encerrado é republicação legítima.
    expect(arg.where.status.in).not.toContain("closed");
    expect(arg.select).toEqual({
      id: true,
      externalListingId: true,
      status: true,
    });
  });
});

describe("ListingRepository.findRetryStateById", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("relê o candidato pelo id com select mínimo (o par pode ter várias linhas)", async () => {
    const spy = vi
      .spyOn(prisma.productListing, "findUnique")
      .mockResolvedValue({ id: "l1", retryEnabled: false } as any);

    const found = await ListingRepository.findRetryStateById("l1");

    expect(spy.mock.calls[0][0]).toMatchObject({
      where: { id: "l1" },
      select: { id: true, retryEnabled: true },
    });
    expect(found?.retryEnabled).toBe(false);
  });
});
