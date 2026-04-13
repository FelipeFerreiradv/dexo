import "dotenv/config";
import prisma from "../app/lib/prisma";

async function main() {
  const accs = await prisma.marketplaceAccount.findMany({
    where: { userId: "cmn5yc4rn0000vsasmwv9m8nc", platform: "MERCADO_LIVRE" },
    select: { id: true, accountName: true, externalUserId: true, expiresAt: true, status: true, createdAt: true },
  });
  const now = new Date();
  for (const a of accs) {
    const minsLeft = Math.round((a.expiresAt.getTime() - now.getTime()) / 60000);
    console.log(`${a.accountName.padEnd(25)} ext=${a.externalUserId} status=${a.status} expiresIn=${minsLeft}min  createdAt=${a.createdAt.toISOString()}`);
  }
  process.exit(0);
}
main();
