/**
 * Sync de atributos de categoria Shopee para o catálogo persistente.
 *
 * Uso:
 *   npm run shopee:sync-attrs                          # todas categorias em uso (Product.shopeeCategoryId distinct)
 *   npm run shopee:sync-attrs -- --category=102291    # uma categoria específica
 *   npm run shopee:sync-attrs -- --account=<acctId>   # força usar uma conta específica
 *
 * Rate-limit: 700ms entre chamadas (conservador vs limite Shopee ~100/min).
 * Idempotente — pode ser rodado múltiplas vezes; o upsert sobrescreve linhas
 * existentes com TTL renovado.
 *
 * Exit code != 0 se qualquer categoria falhar — útil para CI/cron.
 */

import "dotenv/config";
import prisma from "@/app/lib/prisma";
import { Platform } from "@prisma/client";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { ShopeeAttributeCatalogService } from "@/app/marketplaces/services/shopee-attribute-catalog.service";
import { ListingUseCase } from "@/app/marketplaces/usecases/listing.usercase";

const RATE_LIMIT_MS = 700;
const REGION = "BR";
const LOCALE = "pt-BR";

function parseArgs(): { categoryId?: number; accountId?: string } {
  const out: { categoryId?: number; accountId?: string } = {};
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, "").split("=");
    if (k === "category" && v) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out.categoryId = n;
    } else if (k === "account" && v) {
      out.accountId = v;
    }
  }
  return out;
}

async function pickActiveAccount(forceId?: string) {
  if (forceId) {
    const acct = await prisma.marketplaceAccount.findUnique({
      where: { id: forceId },
    });
    if (!acct || acct.platform !== Platform.SHOPEE || acct.status !== "ACTIVE") {
      throw new Error(
        `Conta ${forceId} não encontrada, não é Shopee, ou não está ACTIVE`,
      );
    }
    return acct;
  }
  const acct = await prisma.marketplaceAccount.findFirst({
    where: { platform: Platform.SHOPEE, status: "ACTIVE" },
  });
  if (!acct) {
    throw new Error("Nenhuma conta Shopee ativa encontrada");
  }
  return acct;
}

async function listCategoriesToSync(
  categoryFilter?: number,
): Promise<number[]> {
  if (categoryFilter) return [categoryFilter];
  const rows = await prisma.product.findMany({
    where: { shopeeCategoryId: { not: null } },
    select: { shopeeCategoryId: true },
    distinct: ["shopeeCategoryId"],
  });
  const ids = new Set<number>();
  for (const r of rows) {
    if (!r.shopeeCategoryId) continue;
    const n = Number(r.shopeeCategoryId);
    if (Number.isFinite(n) && n > 0) ids.add(n);
  }
  return [...ids].sort((a, b) => a - b);
}

async function syncOne(
  categoryId: number,
  account: { accessToken: string; shopId: number; id: string },
): Promise<{
  categoryId: number;
  source?: string;
  attrCount?: number;
  mandatoryCount?: number;
  error?: string;
}> {
  // Limpa memória do serviço para forçar lookup completo, mas
  // mantemos o fluxo idêntico ao runtime (memory → DB → live → harvest).
  try {
    const resolution =
      await ShopeeAttributeCatalogService.getCategoryAttributes(
        REGION,
        categoryId,
        LOCALE,
        {
          fetchLive: async () => {
            return ShopeeApiService.getCategoryAttributes(
              account.accessToken,
              account.shopId,
              categoryId,
              LOCALE,
            );
          },
          harvest: () =>
            ListingUseCase.harvestShopeeAttrsFromAnyAccount(categoryId),
        },
      );
    if (!resolution || !resolution.attribute_list?.length) {
      return {
        categoryId,
        error: "nenhuma fonte disponível (DB vazio + live falhou + harvest vazio)",
      };
    }
    const mandatoryCount = resolution.attribute_list.filter(
      (a: any) => a?.is_mandatory,
    ).length;
    return {
      categoryId,
      source: resolution.source,
      attrCount: resolution.attribute_list.length,
      mandatoryCount,
    };
  } catch (err) {
    return {
      categoryId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  const args = parseArgs();
  const account = await pickActiveAccount(args.accountId);
  console.log(
    `[shopee:sync-attrs] usando conta ${account.id} (shopId=${account.shopId}) — ${account.accountName ?? "sem nome"}`,
  );

  const categories = await listCategoriesToSync(args.categoryId);
  if (categories.length === 0) {
    console.warn(
      "[shopee:sync-attrs] nenhuma categoria a sincronizar (Product.shopeeCategoryId vazio)",
    );
    return;
  }
  console.log(
    `[shopee:sync-attrs] ${categories.length} categoria(s) a sincronizar`,
  );

  const okList: typeof results = [];
  const failList: typeof results = [];
  const results: Array<Awaited<ReturnType<typeof syncOne>>> = [];

  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i];
    const result = await syncOne(cat, {
      accessToken: account.accessToken!,
      shopId: Number(account.shopId),
      id: account.id,
    });
    results.push(result);
    if (result.error) {
      console.warn(
        `[shopee:sync-attrs]   ✗ ${cat} — ${result.error}`,
      );
      failList.push(result);
    } else {
      console.log(
        `[shopee:sync-attrs]   ✓ ${cat} — ${result.attrCount} attrs (${result.mandatoryCount} mandatory) [source=${result.source}]`,
      );
      okList.push(result);
    }

    if (i < categories.length - 1) {
      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    }
  }

  console.log(
    `\n[shopee:sync-attrs] DONE — ${okList.length}/${categories.length} sucesso, ${failList.length} falha(s)`,
  );

  if (failList.length > 0) {
    console.log(`\n[shopee:sync-attrs] categorias com falha:`);
    for (const r of failList) {
      console.log(`  - ${r.categoryId}: ${r.error}`);
    }
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[shopee:sync-attrs] erro fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
