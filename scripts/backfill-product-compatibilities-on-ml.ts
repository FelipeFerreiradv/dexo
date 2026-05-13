import "dotenv/config";
import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";

/**
 * Reenvia as compatibilidades veiculares (brand/model/year) cadastradas
 * no produto local para os anúncios ML vinculados. Resolve casos onde o
 * ML mostra o anúncio em "Inativos por descumprir políticas" porque a
 * ficha técnica de compatibilidades nunca foi populada (ou ficou
 * incompleta) durante a criação.
 *
 * Uso:
 *   tsx scripts/backfill-product-compatibilities-on-ml.ts             (user default)
 *   tsx scripts/backfill-product-compatibilities-on-ml.ts --user=ID   (outro user)
 *   tsx scripts/backfill-product-compatibilities-on-ml.ts --dry-run   (preview)
 *   tsx scripts/backfill-product-compatibilities-on-ml.ts --only-missing  (só envia
 *       para anúncios cujo HAS_COMPATIBILITIES não é "Sim" — pula os que já têm)
 *
 * Como funciona:
 *  1. Busca produtos do user que têm pelo menos 1 ProductCompatibility cadastrada.
 *  2. Para cada produto, itera os ProductListings ML ativos.
 *  3. Reenvia via MLApiService.setItemCompatibilitiesByAttributes — mesma
 *     função usada durante a criação (que já foi validada em produção,
 *     com pipeline brand→value_id → top_values → PUT
 *     /user-products/{up}/compatibilities { create: { products: [...] } }).
 *  4. O ML, ao receber compatibilidades válidas, automaticamente reativa o
 *     anúncio caso ele estivesse pausado por falta de ficha técnica.
 *
 * Idempotente: re-enviar para anúncios que já têm a compat correta é no-op
 * pelo lado do ML. Use --only-missing se quiser pular esses por economia.
 */

const DEFAULT_USER_ID = "cmnq8opbl0000vsiw19duv1i0";

const args = process.argv.slice(2);
const userId =
  args.find((a) => a.startsWith("--user="))?.split("=")[1] ?? DEFAULT_USER_ID;
const dryRun = args.includes("--dry-run");
const onlyMissing = args.includes("--only-missing");

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

/**
 * Verifica se o item ML já tem HAS_COMPATIBILITIES="Sim" — usado pelo
 * modo --only-missing para evitar reprocessar anúncios saudáveis.
 */
async function itemAlreadyHasCompatibilities(
  itemId: string,
  token: string,
): Promise<boolean> {
  try {
    const item = await MLApiService.getItemDetails(token, itemId);
    const attrs = (item as { attributes?: Array<{ id: string; value_name?: string }> })
      .attributes;
    if (!Array.isArray(attrs)) return false;
    const hasCompat = attrs.find((a) => a.id === "HAS_COMPATIBILITIES");
    if (!hasCompat) return false;
    return (hasCompat.value_name || "").toLowerCase().startsWith("sim");
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log(
    `[backfill-compat] userId=${userId} dryRun=${dryRun} onlyMissing=${onlyMissing}`,
  );

  const products = await prisma.product.findMany({
    where: {
      userId,
      compatibilities: { some: {} },
    },
    include: {
      compatibilities: true,
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

  console.log(
    `[backfill-compat] produtos do user com compatibilidades cadastradas: ${products.length}`,
  );

  const productsWithListings = products.filter((p) => p.listings.length > 0);
  console.log(
    `[backfill-compat] desses, com pelo menos 1 anúncio ML: ${productsWithListings.length}`,
  );

  if (productsWithListings.length === 0) {
    console.log("[backfill-compat] nada a fazer.");
    await prisma.$disconnect();
    return;
  }

  let listingsOk = 0;
  let listingsSkippedAlreadyOk = 0;
  let listingsFailed = 0;
  let totalCompatSent = 0;

  for (let i = 0; i < productsWithListings.length; i++) {
    const product = productsWithListings[i];
    const prefix = `[${i + 1}/${productsWithListings.length}] sku=${product.sku ?? "?"} (${product.compatibilities.length} compats locais)`;

    const vehicles = product.compatibilities.map((c) => ({
      brand: c.brand,
      model: c.model,
      yearFrom: c.yearFrom,
      yearTo: c.yearTo,
    }));

    if (vehicles.length === 0) {
      console.log(`  ${prefix}: sem compats efetivas — skip`);
      continue;
    }

    for (const listing of product.listings) {
      const lprefix = `  ${prefix} listing=${listing.externalListingId} (status=${listing.status})`;
      try {
        const token = await getValidToken(listing.marketplaceAccount);

        if (onlyMissing) {
          const already = await itemAlreadyHasCompatibilities(
            listing.externalListingId,
            token,
          );
          if (already) {
            console.log(`${lprefix}: HAS_COMPATIBILITIES=Sim — skip`);
            listingsSkippedAlreadyOk++;
            continue;
          }
        }

        if (dryRun) {
          console.log(
            `${lprefix}: [dry-run] would send ${vehicles.length} compat entries`,
          );
          listingsOk++;
          totalCompatSent += vehicles.length;
          continue;
        }

        const result = await MLApiService.setItemCompatibilitiesByAttributes(
          token,
          listing.externalListingId,
          vehicles,
        );

        if (result.success) {
          console.log(
            `${lprefix}: ✓ ${result.createdCount} compat enviadas (de ${vehicles.length} tentativas)`,
          );
          listingsOk++;
          totalCompatSent += result.createdCount;
        } else {
          const err = result.errors.length > 0 ? result.errors.join("; ") : "sem detalhes";
          console.warn(`${lprefix}: ✗ falhou — ${err}`);
          listingsFailed++;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`${lprefix}: ✗ exception — ${msg}`);
        listingsFailed++;
      }
    }
  }

  console.log("");
  console.log("=== Resumo ===");
  console.log(`  Produtos com compats locais:           ${products.length}`);
  console.log(`  Produtos com pelo menos 1 listing ML:  ${productsWithListings.length}`);
  console.log(`  Listings OK${dryRun ? " (dry-run)" : ""}:                ${listingsOk}`);
  if (onlyMissing) {
    console.log(`  Listings skip (já tinham compat):       ${listingsSkippedAlreadyOk}`);
  }
  console.log(`  Listings com falha:                     ${listingsFailed}`);
  console.log(`  Total compat entries enviadas:          ${totalCompatSent}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[backfill-compat] erro fatal:", e);
  await prisma.$disconnect();
  process.exit(1);
});
