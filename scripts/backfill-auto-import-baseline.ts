/**
 * Backfill do baseline "só novos" (autoImportListingsSince) para todas as contas
 * ML/Shopee já conectadas no momento do deploy.
 *
 * Garante que os anúncios JÁ existentes dessas contas NÃO sejam auto-importados
 * para a Dexo — só os criados a partir de agora (honra a regra de produto "só
 * novos"). Sem este backfill, contas antigas ficam com autoImportListingsSince
 * = NULL e, por fail-safe, não importam nada (seguro, mas também não detectam os
 * anúncios novos delas até o baseline ser setado).
 *
 * Idempotente: só preenche onde ainda está NULL — rodar de novo é no-op.
 *
 * Uso:  npx tsx scripts/backfill-auto-import-baseline.ts
 */
import "dotenv/config";
import { Platform } from "@prisma/client";
import prisma from "../app/lib/prisma";

async function main() {
  const now = new Date();
  const result = await prisma.marketplaceAccount.updateMany({
    where: {
      autoImportListingsSince: null,
      platform: { in: [Platform.MERCADO_LIVRE, Platform.SHOPEE] },
    },
    data: { autoImportListingsSince: now },
  });

  console.log(
    `[backfill-baseline] ${result.count} conta(s) ML/Shopee receberam ` +
      `autoImportListingsSince=${now.toISOString()}.`,
  );
}

main()
  .catch((err) => {
    console.error("[backfill-baseline] Erro fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
