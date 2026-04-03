/**
 * Rotina segura de limpeza de produtos/anúncios Shopee importados recentemente.
 * Modo padrão: dry-run (não deleta nada). Use --execute para excluir.
 *
 * Critérios de seleção:
 * - userId alvo fixo
 * - price = 0 e stock = 0
 * - createdAt >= 2026-04-02 (data do lote)
 * - possui listing Shopee
 * - sem pedidos associados
 *
 * Para cada candidato:
 * - opcionalmente chama deleteItem no Shopee (tolera idempotência)
 * - remove ProductListing
 * - remove Product (compatibilities cascata pelo Prisma)
 *
 * Idempotente: reexecutar não falha, pois listings/produtos ausentes são ignorados.
 */

import { PrismaClient, Platform } from "@prisma/client";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { ShopeeOAuthService } from "@/app/marketplaces/services/shopee-oauth.service";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";

const prisma = new PrismaClient();
const USER_ID = "cmn5yc4rn0000vsasmwv9m8nc";
const THRESHOLD = new Date("2026-04-02T00:00:00Z");

async function main() {
  const execute = process.argv.includes("--execute");
  const verbose = process.argv.includes("--verbose");

  const candidates = await prisma.product.findMany({
    where: {
      userId: USER_ID,
      price: 0,
      stock: 0,
      createdAt: { gte: THRESHOLD },
      orderItems: { none: {} },
      listings: {
        some: {
          marketplaceAccount: { platform: Platform.SHOPEE },
        },
      },
    },
    select: {
      id: true,
      sku: true,
      name: true,
      createdAt: true,
      listings: {
        select: {
          id: true,
          externalListingId: true,
          marketplaceAccountId: true,
          marketplaceAccount: {
            select: {
              id: true,
              platform: true,
              accessToken: true,
              refreshToken: true,
              shopId: true,
            },
          },
        },
      },
    },
  });

  console.log(
    `[CLEANUP] Encontrados ${candidates.length} produtos candidatos (dry-run=${
      !execute
    })`,
  );

  if (!execute) {
    const sample = candidates.slice(0, 10).map((c) => c.sku);
    console.log("[CLEANUP] Amostra de SKUs:", sample);
    return;
  }

  for (const product of candidates) {
    for (const listing of product.listings) {
      const account = listing.marketplaceAccount;
      if (!account || account.platform !== Platform.SHOPEE) continue;
      let accessToken = account.accessToken;

      const itemId = parseInt(listing.externalListingId.split(":")[0], 10);
      const refreshIfNeeded = async (err: any) => {
        const status = err?.status;
        if (
          (status === 401 || status === 403) &&
          account.refreshToken &&
          account.shopId
        ) {
          const refreshed = await ShopeeOAuthService.refreshAccessToken(
            account.refreshToken,
            account.shopId,
          );
          await MarketplaceRepository.updateTokens(account.id, {
            accessToken: refreshed.access_token,
            refreshToken: refreshed.refresh_token,
            expiresAt: new Date(Date.now() + refreshed.expire_in * 1000),
          });
          accessToken = refreshed.access_token;
          return true;
        }
        return false;
      };

      try {
        await ShopeeApiService.deleteItem(
          accessToken!,
          account.shopId!,
          itemId,
        );
      } catch (err: any) {
        if (await refreshIfNeeded(err)) {
          try {
            await ShopeeApiService.deleteItem(
              accessToken!,
              account.shopId!,
              itemId,
            );
          } catch (e) {
            if (verbose) console.warn("[CLEANUP] deleteItem erro:", e);
          }
        } else if (verbose) {
          console.warn("[CLEANUP] deleteItem erro:", err);
        }
      }
    }

    // Remover listings e produto dentro de transação
    await prisma.$transaction([
      prisma.productListing.deleteMany({ where: { productId: product.id } }),
      prisma.product.delete({ where: { id: product.id } }),
    ]);
  }

  console.log("[CLEANUP] Exclusão concluída.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
