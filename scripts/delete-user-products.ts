import prisma from "../app/lib/prisma";

const TARGET_USER_ID = "cmn5yc4rn0000vsasmwv9m8nc";

async function main() {
  const [products, listings, orderItems, stockLogs, compatibilities] =
    await Promise.all([
      prisma.product.count({ where: { userId: TARGET_USER_ID } }),
      prisma.productListing.count({ where: { product: { userId: TARGET_USER_ID } } }),
      prisma.orderItem.count({ where: { product: { userId: TARGET_USER_ID } } }),
      prisma.stockLog.count({ where: { product: { userId: TARGET_USER_ID } } }),
      prisma.productCompatibility.count({ where: { product: { userId: TARGET_USER_ID } } }),
    ]);

  console.log("Resumo antes da exclusão:");
  console.log({ products, listings, orderItems, stockLogs, compatibilities });

  await prisma.$transaction([
    prisma.orderItem.deleteMany({ where: { product: { userId: TARGET_USER_ID } } }),
    prisma.productListing.deleteMany({ where: { product: { userId: TARGET_USER_ID } } }),
    prisma.stockLog.deleteMany({ where: { product: { userId: TARGET_USER_ID } } }),
    prisma.productCompatibility.deleteMany({ where: { product: { userId: TARGET_USER_ID } } }),
    prisma.product.deleteMany({ where: { userId: TARGET_USER_ID } }),
  ]);

  const [productsAfter, listingsAfter, orderItemsAfter, stockLogsAfter, compatibilitiesAfter] =
    await Promise.all([
      prisma.product.count({ where: { userId: TARGET_USER_ID } }),
      prisma.productListing.count({ where: { product: { userId: TARGET_USER_ID } } }),
      prisma.orderItem.count({ where: { product: { userId: TARGET_USER_ID } } }),
      prisma.stockLog.count({ where: { product: { userId: TARGET_USER_ID } } }),
      prisma.productCompatibility.count({ where: { product: { userId: TARGET_USER_ID } } }),
    ]);

  console.log("Resumo após a exclusão:");
  console.log({
    products: productsAfter,
    listings: listingsAfter,
    orderItems: orderItemsAfter,
    stockLogs: stockLogsAfter,
    compatibilities: compatibilitiesAfter,
  });
}

main()
  .catch((error) => {
    console.error("Falha ao excluir produtos do usuário", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
