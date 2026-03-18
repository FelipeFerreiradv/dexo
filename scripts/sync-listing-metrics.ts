import { Platform } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { ShopeeApiService } from "../app/marketplaces/services/shopee-api.service";

export async function syncMercadoLivre() {
  const accounts = await prisma.marketplaceAccount.findMany({
    where: { platform: Platform.MERCADO_LIVRE },
    select: { id: true, accessToken: true, externalUserId: true, accountName: true },
  });

  for (const account of accounts) {
    if (!account.accessToken) {
      console.warn(`[sync] Conta ML ${account.accountName} sem accessToken, pulando`);
      continue;
    }

    const listings = await prisma.productListing.findMany({
      where: {
        marketplaceAccountId: account.id,
        externalListingId: {
          not: undefined,
          not: { startsWith: "PENDING_" },
        },
      },
      select: { id: true, externalListingId: true },
    });

    const ids = listings
      .map((l) => l.externalListingId)
      .filter((id): id is string => Boolean(id));

    const visitsMap: Record<string, number> = {};
    const ratingMap: Record<string, { reviews?: number; rating?: number }> = {};

    for (const id of ids) {
      if (id.startsWith("LEGACY-")) continue; // não há visitas/reviews para placeholders
      try {
        const visits = await MLApiService.getItemsVisits(account.accessToken, [id]);
        Object.assign(visitsMap, visits);
      } catch (err) {
        console.error(`[sync] Falha ao buscar visitas para ${id}`, err);
      }

      try {
        const summary = await MLApiService.getItemReviewSummary(account.accessToken, id);
        ratingMap[id] = {
          reviews: summary.totalReviews,
          rating: summary.ratingAverage,
        };
      } catch (err) {
        console.warn(
          `[sync] Reviews não disponíveis para ${id}`,
          err instanceof Error ? err.message : err,
        );
      }

      // pequena pausa para evitar rate limit
      await new Promise((resolve) => setTimeout(resolve, 220));
    }

    let updated = 0;
    for (const listing of listings) {
      const views = visitsMap[listing.externalListingId ?? ""];
      const reviewData = ratingMap[listing.externalListingId ?? ""];
      if (views === undefined && !reviewData) continue;

      await prisma.productListing.update({
        where: { id: listing.id },
        data: {
          viewsCount: views ?? undefined,
          reviewsCount: reviewData?.reviews ?? undefined,
          ratingAverage: reviewData?.rating ?? undefined,
          metricsUpdatedAt: new Date(),
        },
      });
      updated++;
    }

    console.log(`[sync] Conta ML ${account.accountName}: ${updated} listings atualizados`);
  }
}

export async function syncShopee() {
  const accounts = await prisma.marketplaceAccount.findMany({
    where: { platform: Platform.SHOPEE },
    select: { id: true, accessToken: true, shopId: true, accountName: true },
  });

  for (const account of accounts) {
    if (!account.accessToken || !account.shopId) {
      console.warn(
        `[sync] Conta Shopee ${account.accountName} sem accessToken ou shopId, pulando`,
      );
      continue;
    }

    const listings = await prisma.productListing.findMany({
      where: {
        marketplaceAccountId: account.id,
        externalListingId: {
          not: undefined,
          not: { startsWith: "PENDING_" },
        },
      },
      select: { id: true, externalListingId: true },
    });

    let updated = 0;
    for (const listing of listings) {
      const externalId = listing.externalListingId;
      if (!externalId || externalId.startsWith("LEGACY-")) continue;
      if (!/^[0-9]+$/.test(externalId)) {
        console.warn(`[sync] Shopee listing ${externalId} não é numérico, pulando`);
        continue;
      }

      try {
        const detail = await ShopeeApiService.getItemDetail(
          account.accessToken,
          account.shopId,
          Number(externalId),
        );

        const rating = (detail as any).item_rating;
        const ratingAverage = rating?.rating_star ?? undefined;
        const reviewsCount =
          rating?.rating_total ??
          (Array.isArray(rating?.rating_count)
            ? rating.rating_count.reduce((sum: number, val: number) => sum + (val || 0), 0)
            : undefined);

        const viewsCount = (detail as any).view_count ?? undefined;

        await prisma.productListing.update({
          where: { id: listing.id },
          data: {
            ratingAverage,
            reviewsCount,
            viewsCount,
            metricsUpdatedAt: new Date(),
          },
        });
        updated++;
      } catch (err) {
        console.error(
          `[sync] Falha ao buscar métricas Shopee para ${externalId}:`,
          err instanceof Error ? err.message : err,
        );
      }

      // pequena pausa para evitar rate limit
      await new Promise((resolve) => setTimeout(resolve, 220));
    }

    console.log(`[sync] Conta Shopee ${account.accountName}: ${updated} listings atualizados`);
  }
}

export async function syncAllListingsMetrics() {
  await syncMercadoLivre();
  await syncShopee();
}

if (require.main === module) {
  syncAllListingsMetrics()
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
