import prisma from "../app/lib/prisma";
const USER_ID = "cmn5yc4rn0000vsasmwv9m8nc";
async function main() {
  const total = await prisma.product.count({ where: { userId: USER_ID } });
  const withAll = await prisma.product.count({
    where: {
      userId: USER_ID,
      heightCm: { not: null }, widthCm: { not: null }, lengthCm: { not: null }, weightKg: { not: null },
    },
  });
  const withNone = await prisma.product.count({
    where: { userId: USER_ID, heightCm: null, widthCm: null, lengthCm: null, weightKg: null },
  });
  // Listings ativos linkados a produto com/sem dimensões
  const listingsActive = await prisma.productListing.count({
    where: { status: "active", marketplaceAccount: { userId: USER_ID, platform: "MERCADO_LIVRE" } },
  });
  const listingsWithDims = await prisma.productListing.count({
    where: {
      status: "active",
      marketplaceAccount: { userId: USER_ID, platform: "MERCADO_LIVRE" },
      product: { heightCm: { not: null }, widthCm: { not: null }, lengthCm: { not: null }, weightKg: { not: null } },
    },
  });
  console.log({ products: { total, withAll, withNone }, listings: { active: listingsActive, comDimensoesNoProduto: listingsWithDims } });
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
