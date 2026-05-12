import "dotenv/config";
import axios from "axios";
import prisma from "../app/lib/prisma";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";

/**
 * Backfill de imagens em produtos a partir das pictures dos anúncios
 * vinculados no Mercado Livre.
 *
 * Cenário: produtos foram importados sem imagens, mas têm anúncios ML
 * publicados que contêm as fotos. Este script copia `pictures[*].secure_url`
 * do primeiro listing ML que retornar fotos para o produto local
 * (`product.imageUrl` + `product.imageUrls`).
 *
 * Uso:
 *   tsx scripts/backfill-product-images-from-listings.ts             (user default)
 *   tsx scripts/backfill-product-images-from-listings.ts --user=ID   (outro user)
 *   tsx scripts/backfill-product-images-from-listings.ts --dry-run   (preview)
 *
 * Salvaguardas:
 *  - Só processa produtos SEM imagens (imageUrl null/vazio E imageUrls vazio).
 *    Produtos que já têm foto não são alterados.
 *  - Itera todos os listings ML ativos ou pausados do produto até o primeiro
 *    que retornar pelo menos 1 picture.
 *  - Refresca token ML automaticamente se expirado.
 *  - Em --dry-run não persiste nada; apenas loga o que seria feito.
 */

const DEFAULT_USER_ID = "cmn5yc4rn0000vsasmwv9m8nc";
const ML_API = "https://api.mercadolibre.com";
const MAX_IMAGES = 10; // ML aceita até 12; deixamos margem razoável.

const args = process.argv.slice(2);
const userId =
  args.find((a) => a.startsWith("--user="))?.split("=")[1] ?? DEFAULT_USER_ID;
const dryRun = args.includes("--dry-run");

interface AccountTokenLite {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

const tokenCache = new Map<string, string>();

async function getValidToken(account: AccountTokenLite): Promise<string> {
  const cached = tokenCache.get(account.id);
  if (cached) return cached;

  const now = Date.now();
  if (new Date(account.expiresAt).getTime() > now + 60_000) {
    tokenCache.set(account.id, account.accessToken);
    return account.accessToken;
  }

  const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
    account.id,
    account.refreshToken,
  );
  await prisma.marketplaceAccount.update({
    where: { id: account.id },
    data: {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
    },
  });
  tokenCache.set(account.id, refreshed.accessToken);
  return refreshed.accessToken;
}

async function fetchMlPictures(
  itemId: string,
  token: string,
): Promise<string[]> {
  const r = await axios.get<{
    pictures?: Array<{ secure_url?: string; url?: string }>;
  }>(`${ML_API}/items/${itemId}`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { attributes: "id,pictures" },
    timeout: 20_000,
  });
  const pics = r.data?.pictures ?? [];
  return pics
    .map((p) => p.secure_url ?? p.url ?? "")
    .filter((u): u is string => typeof u === "string" && u.length > 0)
    .slice(0, MAX_IMAGES);
}

async function main(): Promise<void> {
  console.log(
    `[backfill-images] userId=${userId} dryRun=${dryRun} maxImagesPerProduct=${MAX_IMAGES}`,
  );

  // Pega todos os produtos do user. Filtramos "sem imagens" em memória porque
  // checar `imageUrls = []` no Prisma exige `equals: []` (com Json type) ou
  // `isEmpty: true` (array native) — varia entre versões; em memória é robusto.
  const products = await prisma.product.findMany({
    where: { userId },
    include: {
      listings: {
        where: {
          marketplaceAccount: { platform: "MERCADO_LIVRE" },
          externalListingId: { startsWith: "MLB" },
        },
        include: { marketplaceAccount: true },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      },
    },
  });

  const targets = products.filter((p) => {
    const hasImageUrl = !!(p.imageUrl && p.imageUrl.trim().length > 0);
    const hasImageUrls = Array.isArray(p.imageUrls) && p.imageUrls.length > 0;
    return !hasImageUrl && !hasImageUrls;
  });

  console.log(
    `[backfill-images] produtos do user: ${products.length} | sem imagens: ${targets.length}`,
  );

  if (targets.length === 0) {
    console.log("[backfill-images] nada a fazer.");
    await prisma.$disconnect();
    return;
  }

  let updated = 0;
  let skippedNoListing = 0;
  let skippedNoPictures = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const product = targets[i];
    const prefix = `  [${i + 1}/${targets.length}] sku=${product.sku ?? "?"} id=${product.id}`;

    if (product.listings.length === 0) {
      console.log(`${prefix}: sem anúncios ML vinculados — skip`);
      skippedNoListing++;
      continue;
    }

    let pictures: string[] = [];
    let usedListingId: string | null = null;
    let lastWarn: string | null = null;

    for (const listing of product.listings) {
      try {
        const token = await getValidToken(listing.marketplaceAccount);
        const pics = await fetchMlPictures(listing.externalListingId, token);
        if (pics.length > 0) {
          pictures = pics;
          usedListingId = listing.externalListingId;
          break;
        }
        lastWarn = `${listing.externalListingId} retornou 0 pictures`;
      } catch (e) {
        const msg =
          (e as { response?: { data?: { message?: string } } }).response?.data
            ?.message ??
          (e instanceof Error ? e.message : String(e));
        lastWarn = `${listing.externalListingId}: ${msg}`;
      }
    }

    if (pictures.length === 0) {
      console.log(
        `${prefix}: nenhum anúncio retornou pictures (${lastWarn ?? "sem info"}) — skip`,
      );
      skippedNoPictures++;
      continue;
    }

    if (dryRun) {
      console.log(
        `${prefix}: [dry-run] would set ${pictures.length} imagens via ${usedListingId}`,
      );
      updated++;
      continue;
    }

    try {
      await prisma.product.update({
        where: { id: product.id },
        data: {
          imageUrl: pictures[0],
          imageUrls: pictures,
        },
      });
      console.log(
        `${prefix}: ✓ ${pictures.length} imagens via ${usedListingId}`,
      );
      updated++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`${prefix}: falha ao persistir: ${msg}`);
      failed++;
    }
  }

  console.log("");
  console.log("=== Resumo ===");
  console.log(
    `  Atualizados${dryRun ? " (dry-run)" : ""}:       ${updated}`,
  );
  console.log(`  Skip (sem listing ML):     ${skippedNoListing}`);
  console.log(`  Skip (sem pictures no ML): ${skippedNoPictures}`);
  console.log(`  Falhas:                    ${failed}`);
  console.log(`  Total processado:          ${targets.length}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[backfill-images] erro fatal:", e);
  await prisma.$disconnect();
  process.exit(1);
});
