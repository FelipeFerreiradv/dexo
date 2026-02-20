import prisma from "../app/lib/prisma";

async function main() {
  const accounts = await prisma.marketplaceAccount.findMany({
    where: { platform: "MERCADO_LIVRE" },
  });
  console.log(
    "ML accounts:",
    accounts.map((a) => ({
      id: a.id,
      externalUserId: a.externalUserId,
      status: a.status,
      userId: a.userId,
    })),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
