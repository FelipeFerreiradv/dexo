// Sobe a árvore até achar o .env — permite rodar de dentro de um git worktree,
// que não tem .env próprio. Precisa vir antes do import do prisma.
import "./lib/load-env";
import { Platform } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import { ShopeeApiService } from "../app/marketplaces/services/shopee-api.service";
import { ShopeeAttributeCatalogService } from "../app/marketplaces/services/shopee-attribute-catalog.service";
import { applyOverridesToProduct } from "../app/marketplaces/services/listing-overrides.service";
import { buildShopeeAttributeList } from "../app/marketplaces/lib/shopee-attribute-mapper";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";

/**
 * backfill-shopee-attributes.ts
 *
 * Reenvia a ficha técnica dos anúncios Shopee JÁ publicados.
 *
 * Por que existe: até o mapper novo, o caminho de publicação Shopee conhecia 4
 * campos do produto em 17 chaves hardcoded e casava por nome exato. Medido nas
 * 3 categorias mais usadas em produção, isso preenchia 1 de 12 atributos
 * (categoria 102298, 1.161 anúncios), 2 de 11 (102416) e 1 de 13 (102532).
 * Anúncio de autopeça sem atributo perde a busca por veículo. Este script
 * corrige o que já está no ar; o mapper cuida do que for publicado daqui pra
 * frente.
 *
 * O `update_item` da Shopee SUBSTITUI a `attribute_list` inteira, então o
 * script mescla por `attribute_id` sobre o que o item já tem — o que o
 * vendedor ajustou no Seller Center é preservado.
 *
 * `--report` é o modo mais seguro e o primeiro passo recomendado: mede a
 * cobertura atual por categoria sem escrever nada. DRY-RUN é o padrão;
 * `--apply` é opt-in.
 *
 * Uso:
 *   npx tsx scripts/backfill-shopee-attributes.ts --report
 *   npx tsx scripts/backfill-shopee-attributes.ts --account=<accountId>
 *   npx tsx scripts/backfill-shopee-attributes.ts --category=102298
 *   npx tsx scripts/backfill-shopee-attributes.ts --item=<externalListingId>
 *   npx tsx scripts/backfill-shopee-attributes.ts --apply --category=102298 --limit=10
 */

const RATE_LIMIT_MS = 700;

interface Flags {
  accountId: string | null;
  categoryId: string | null;
  items: string[];
  apply: boolean;
  report: boolean;
  limit: number | null;
}

function parseFlags(argv: string[]): Flags {
  const get = (n: string) => {
    const p = `--${n}=`;
    const f = argv.find((a) => a.startsWith(p));
    return f ? f.slice(p.length) : undefined;
  };
  const has = (n: string) => argv.includes(`--${n}`);
  const limitRaw = get("limit");
  return {
    accountId: get("account") ?? null,
    categoryId: get("category") ?? null,
    items: (get("item") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // Escrita é OPT-IN.
    apply: has("apply"),
    report: has("report"),
    limit: limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const isDry = !flags.apply;
  console.log(
    `[shopee-attrs] modo=${flags.report ? "REPORT" : isDry ? "DRY-RUN" : "APPLY"}` +
      `${flags.accountId ? ` account=${flags.accountId}` : ""}` +
      `${flags.categoryId ? ` category=${flags.categoryId}` : ""}` +
      `${flags.items.length ? ` items=${flags.items.join(",")}` : ""}`,
  );

  const listings = await prisma.productListing.findMany({
    where: {
      marketplaceAccount: {
        platform: Platform.SHOPEE,
        status: "ACTIVE",
        ...(flags.accountId ? { id: flags.accountId } : {}),
      },
      status: { in: ["active", "ACTIVE", "NORMAL"] },
      ...(flags.items.length
        ? { externalListingId: { in: flags.items } }
        : { externalListingId: { not: { startsWith: "PENDING_" } } }),
      ...(flags.categoryId
        ? { product: { shopeeCategoryId: flags.categoryId } }
        : {}),
    },
    select: {
      id: true,
      productId: true,
      externalListingId: true,
      shopeeCategoryOverride: true,
      marketplaceAccount: {
        select: { id: true, accountName: true, accessToken: true, shopId: true },
      },
      product: { select: { sku: true, shopeeCategoryId: true } },
    },
    take: flags.limit ?? undefined,
    orderBy: { updatedAt: "desc" },
  });

  console.log(`[shopee-attrs] anúncios elegíveis: ${listings.length}`);
  if (listings.length === 0) {
    await prisma.$disconnect();
    return;
  }

  const produtoRepo = new ProductRepositoryPrisma();
  const porCategoria = new Map<
    number,
    { anuncios: number; totalAttrs: number; somaCobertura: number }
  >();
  let atualizados = 0;
  let falhas = 0;
  let semCategoria = 0;
  let semCatalogo = 0;

  for (const [i, l] of listings.entries()) {
    const acc = l.marketplaceAccount;
    const raw = l.shopeeCategoryOverride ?? l.product?.shopeeCategoryId ?? null;
    const categoryId = raw ? Number(String(raw).replace(/^SHP_/i, "")) : NaN;

    if (!Number.isFinite(categoryId) || typeof acc.shopId !== "number") {
      semCategoria++;
      continue;
    }

    try {
      const produto = await produtoRepo.findById(l.productId);
      if (!produto) {
        falhas++;
        continue;
      }

      const catalogo = await ShopeeAttributeCatalogService.getCategoryAttributes(
        "BR",
        categoryId,
        "pt-BR",
        {
          fetchLive: () =>
            ShopeeApiService.getCategoryAttributes(
              acc.accessToken,
              acc.shopId as number,
              categoryId,
              "pt-BR",
            ).then((r) => r.attribute_list as any),
        },
      );
      if (!catalogo?.attribute_list?.length) {
        semCatalogo++;
        continue;
      }

      const efetivo = applyOverridesToProduct(produto as any, l as any);
      const { attributeList: mapped, report } = buildShopeeAttributeList({
        product: efetivo as any,
        categoryAttrs: catalogo.attribute_list as any,
        pickSafeMandatoryValue: ListingUseCase.pickSafeMandatoryShopeeValue,
      });

      const agg = porCategoria.get(categoryId) ?? {
        anuncios: 0,
        totalAttrs: report.categoryAttrCount,
        somaCobertura: 0,
      };
      agg.anuncios++;
      agg.somaCobertura += report.coverage;
      porCategoria.set(categoryId, agg);

      console.log(
        `  [${i + 1}/${listings.length}] sku=${l.product?.sku} item=${l.externalListingId} cat=${categoryId}` +
          ` → ${report.emittedCount}/${report.categoryAttrCount} atributos` +
          `${report.fallbacks.length ? ` (${report.fallbacks.length} fallback)` : ""}`,
      );

      if (flags.report || isDry || mapped.length === 0) continue;

      // Merge com o que o item já tem: o update_item substitui a lista inteira.
      const itemId = Number(l.externalListingId);
      const atual = await ShopeeApiService.getItemBaseInfo(
        acc.accessToken,
        acc.shopId,
        itemId,
      );
      const porId = new Map<number, any>();
      for (const a of atual?.attribute_list ?? []) porId.set(a.attribute_id, a);
      for (const a of mapped) porId.set(a.attribute_id, a);

      await ShopeeApiService.updateItem(acc.accessToken, acc.shopId, {
        item_id: itemId,
        attribute_list: Array.from(porId.values()),
      } as any);
      atualizados++;
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      falhas++;
      console.error(
        `  [FALHA] item=${l.externalListingId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(`\n========== COBERTURA POR CATEGORIA ==========`);
  for (const [cat, agg] of [...porCategoria.entries()].sort(
    (a, b) => b[1].anuncios - a[1].anuncios,
  )) {
    const media = agg.anuncios > 0 ? agg.somaCobertura / agg.anuncios : 0;
    console.log(
      `  categoria ${cat}: ${agg.anuncios} anúncio(s), ${agg.totalAttrs} atributos, cobertura média ${(media * 100).toFixed(1)}%`,
    );
  }
  console.log(`=============================================`);
  console.log(`Sem categoria resolvida: ${semCategoria}`);
  console.log(`Sem catálogo disponível: ${semCatalogo}`);
  console.log(`Falhas:                  ${falhas}`);
  if (flags.report || isDry) {
    console.log(
      `\nNenhuma escrita feita. Para aplicar:\n  npx tsx scripts/backfill-shopee-attributes.ts --apply` +
        `${flags.categoryId ? ` --category=${flags.categoryId}` : ""} --limit=10`,
    );
  } else {
    console.log(`Anúncios atualizados:    ${atualizados}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[fatal]", err);
  await prisma.$disconnect().catch(() => {});
  process.exitCode = 1;
});
