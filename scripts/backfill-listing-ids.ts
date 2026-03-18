import prisma from "../app/lib/prisma";

/**
 * Preenche listingId em OrderItem legados quando há exatamente um listing para o produto na mesma conta.
 * Regras:
 * - Considera somente OrderItems com listingId nulo
 * - Encontra a conta do pedido
 * - Busca listings do mesmo produto nessa conta; se houver exatamente 1, associa
 * - Se houver 0 ou >1 listings, não altera (para evitar vínculo errado)
 */
async function backfill() {
  const candidates = await prisma.orderItem.findMany({
    where: { listingId: null },
    include: {
      order: { select: { marketplaceAccountId: true } },
      product: { select: { id: true, sku: true, name: true } },
    },
  });

  let updated = 0;
  let skippedNoListing = 0;
  let skippedMany = 0;
  let createdPlaceholders = 0;

  for (const item of candidates) {
    const accountId = item.order.marketplaceAccountId;
    const listings = await prisma.productListing.findMany({
      where: {
        productId: item.productId,
        marketplaceAccountId: accountId,
      },
      select: { id: true },
    });

    if (listings.length === 1) {
      await prisma.orderItem.update({
        where: { id: item.id },
        data: { listingId: listings[0].id },
      });
      updated++;
    } else if (listings.length === 0) {
      if (process.env.BACKFILL_CREATE_PLACEHOLDERS === "true") {
        const placeholder = await prisma.productListing.create({
          data: {
            productId: item.productId,
            marketplaceAccountId: accountId,
            externalListingId: `LEGACY-${item.id}`,
            status: "legacy_placeholder",
          },
        });
        await prisma.orderItem.update({
          where: { id: item.id },
          data: { listingId: placeholder.id },
        });
        createdPlaceholders++;
      } else {
        skippedNoListing++;
      }
    } else {
      skippedMany++;
    }
  }

  return {
    total: candidates.length,
    updated,
    skippedNoListing,
    skippedMany,
    createdPlaceholders,
  };
}

backfill()
  .then((res) => {
    console.log("Backfill concluído", res);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
