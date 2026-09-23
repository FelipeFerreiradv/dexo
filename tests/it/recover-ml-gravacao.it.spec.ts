import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { ehBancoDeTesteLocal } from "./banco-local";

/**
 * INTEGRAÇÃO com Postgres REAL — gravação condicional do `--apply` do script
 * de recuperação (scripts/lib/recover-ml-apply.ts).
 *
 * A premissa da trava é que QUALQUER escrita na linha muda o `updatedAt` —
 * inclusive os `updateMany` das reservas (cron, criação, botão). Com mock isso
 * nunca foi provado; aqui é. Mesmas regras de ambiente e o mesmo comando do
 * ml-publicacao-concorrencia.it.spec.ts (só banco local "dexo_it"; rodar com
 * --no-file-parallelism).
 */

const IT_URL = process.env.DEXO_IT_DATABASE_URL ?? "";
const LOCAL_OK = ehBancoDeTesteLocal(IT_URL);
if (LOCAL_OK) {
  process.env.DATABASE_URL = IT_URL;
  process.env.DIRECT_URL = IT_URL;
  process.env.ML_API_URL = "http://127.0.0.1:9";
  process.env.ML_AUTH_URL = "http://127.0.0.1:9";
  process.env.HTTP_PROXY = "http://127.0.0.1:9";
  process.env.HTTPS_PROXY = "http://127.0.0.1:9";
  process.env.NO_PROXY = "127.0.0.1,localhost";
}

describe.skipIf(!LOCAL_OK)(
  "IT (Postgres real) — gravação condicional do script de recuperação",
  () => {
    let prisma: any;
    let ListingRepository: any;
    let gravarSeIntacta: any;
    let seq = 0;

    beforeAll(async () => {
      // O client só vai para `prisma` DEPOIS de conferir o banco: o afterAll
      // roda mesmo quando o beforeAll lança, e limparia o banco recusado.
      const cliente = (await import("../../app/lib/prisma")).default;
      const [{ current_database: banco }] = await cliente.$queryRaw`SELECT current_database()`;
      if (!/dexo_it/.test(banco)) {
        await cliente.$disconnect();
        throw new Error(`banco inesperado: ${banco}`);
      }
      prisma = cliente;
      ListingRepository = (await import("../../app/marketplaces/repositories/listing.repository"))
        .ListingRepository;
      gravarSeIntacta = (await import("../../scripts/lib/recover-ml-apply")).gravarSeIntacta;
    });

    async function limpar() {
      await prisma.productListing.deleteMany({ where: { product: { sku: { startsWith: "REC-" } } } });
      await prisma.product.deleteMany({ where: { sku: { startsWith: "REC-" } } });
      await prisma.marketplaceAccount.deleteMany({ where: { accountName: { startsWith: "REC IT" } } });
      await prisma.user.deleteMany({ where: { email: { endsWith: "@rec-it.test" } } });
    }

    beforeEach(limpar);
    afterAll(async () => {
      if (prisma) {
        await limpar();
        await prisma.$disconnect();
      }
    });

    /** Uma linha "presa" como o dry-run a leria, e o updatedAt lido. */
    async function linhaLida(over: Record<string, unknown> = {}) {
      seq += 1;
      const user = await prisma.user.create({
        data: { email: `rec-${Date.now()}-${seq}@rec-it.test`, password: "x" },
      });
      const acc = await prisma.marketplaceAccount.create({
        data: {
          userId: user.id,
          platform: "MERCADO_LIVRE",
          accountName: `REC IT ${seq}`,
          accessToken: "t",
          refreshToken: "r",
          expiresAt: new Date(Date.now() + 3600_000),
          status: "ACTIVE",
          externalUserId: `rec-${Date.now()}-${seq}`,
        },
      });
      const product = await prisma.product.create({
        data: { userId: user.id, sku: `REC-${seq}`, name: "Peça", price: 10 },
      });
      const l = await prisma.productListing.create({
        data: {
          productId: product.id,
          marketplaceAccountId: acc.id,
          externalListingId: `PENDING_${Date.now()}_${seq}`,
          status: "error",
          retryEnabled: false,
          lastError: "Erro ao criar item: {...}",
          ...over,
        },
      });
      // O que o dry-run leu (mesma precisão de milissegundo do banco).
      const lida = await prisma.productListing.findUnique({ where: { id: l.id } });
      await new Promise((r) => setTimeout(r, 15));
      return { l, lidoEm: lida.updatedAt as Date };
    }

    const REARME = () => ({
      status: "error",
      lastError: null,
      retryEnabled: true,
      retryAttempts: 0,
      nextRetryAt: new Date(Date.now() + 5 * 60_000),
    });

    it("linha intacta ⇒ grava", async () => {
      const { l, lidoEm } = await linhaLida();
      expect(await gravarSeIntacta(prisma, l.id, lidoEm, REARME())).toBe(true);
      const depois = await prisma.productListing.findUnique({ where: { id: l.id } });
      expect(depois.retryEnabled).toBe(true);
    });

    it("o cron reservou a linha (updateMany do claim) no meio ⇒ NÃO grava", async () => {
      const { l, lidoEm } = await linhaLida({
        retryEnabled: true,
        nextRetryAt: new Date(Date.now() - 1000),
      });
      expect(await ListingRepository.claimRetryCandidate(l.id, 600_000, { markPublishing: true }))
        .toBeInstanceOf(Date);
      expect(await gravarSeIntacta(prisma, l.id, lidoEm, REARME())).toBe(false);
    });

    it("uma publicação reservou a linha (updateMany da reserva) no meio ⇒ NÃO grava", async () => {
      const { l, lidoEm } = await linhaLida();
      expect(await ListingRepository.claimInteractiveRetry(l.id, 600_000)).toBeInstanceOf(Date);
      expect(await gravarSeIntacta(prisma, l.id, lidoEm, REARME())).toBe(false);
    });

    it("a linha assumida de um agendamento no meio ⇒ NÃO grava", async () => {
      const { l, lidoEm } = await linhaLida({
        retryEnabled: true,
        nextRetryAt: new Date(Date.now() + 60_000),
      });
      expect(await ListingRepository.takeOverScheduledRetry(l.id, 600_000)).toBeInstanceOf(Date);
      expect(await gravarSeIntacta(prisma, l.id, lidoEm, REARME())).toBe(false);
    });

    it("a linha virou anúncio (id real) no meio ⇒ NÃO grava, mesmo com o updatedAt forjado igual", async () => {
      const { l, lidoEm } = await linhaLida();
      await prisma.productListing.update({
        where: { id: l.id },
        data: { externalListingId: "MLB123456", status: "active", updatedAt: lidoEm },
      });
      expect(await gravarSeIntacta(prisma, l.id, lidoEm, REARME())).toBe(false);
      const depois = await prisma.productListing.findUnique({ where: { id: l.id } });
      expect(depois.status).toBe("active");
    });

    it("atualização comum (update) no meio ⇒ NÃO grava", async () => {
      const { l, lidoEm } = await linhaLida();
      await ListingRepository.updateListing(l.id, { lastError: "outro erro" });
      expect(await gravarSeIntacta(prisma, l.id, lidoEm, REARME())).toBe(false);
    });

    it("sem a leitura (updatedAt ausente) ⇒ NÃO grava", async () => {
      const { l } = await linhaLida();
      expect(await gravarSeIntacta(prisma, l.id, undefined, REARME())).toBe(false);
    });
  },
);
