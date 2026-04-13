import prisma from "../app/lib/prisma";
const USER_ID = "cmn5yc4rn0000vsasmwv9m8nc";
async function main() {
  const user = await prisma.user.findUnique({ where: { id: USER_ID }, select: { id: true, email: true, name: true } });
  console.log("USER:", user);
  const accs = await prisma.marketplaceAccount.findMany({
    where: { userId: USER_ID, platform: "MERCADO_LIVRE" },
    select: { id: true, accountName: true, externalUserId: true, status: true, expiresAt: true, updatedAt: true },
  });
  console.log("ACCOUNTS:", JSON.stringify(accs, null, 2));
  const counts = await prisma.productListing.groupBy({
    by: ["marketplaceAccountId", "status"],
    where: { marketplaceAccount: { userId: USER_ID, platform: "MERCADO_LIVRE" } },
    _count: { _all: true },
  });
  console.log("LISTING COUNTS:", JSON.stringify(counts, null, 2));
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
