import "dotenv/config";
import prisma from "@/app/lib/prisma";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";
import { Platform } from "@prisma/client";

const USER_ID = "cml7fm1v80000vsd8x0sbzf2o";

async function run() {
  const accounts = await prisma.marketplaceAccount.findMany({
    where: { userId: USER_ID, platform: Platform.MERCADO_LIVRE },
  });

  for (const acc of accounts) {
    console.log(`Importando anúncios da conta ${acc.accountName || acc.id}...`);
    const res = await SyncUseCase.importMLItems(USER_ID, acc.id);
    console.log(
      `Conta ${acc.accountName || acc.id}: ${res.linkedItems} vinculados, ${res.unlinkedItems} não vinculados, total ${res.totalItems}`,
    );
  }
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
