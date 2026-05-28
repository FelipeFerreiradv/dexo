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
  liveError?: string;
}> {
  // Capturamos o erro do fetchLive ANTES dele ser engolido pelo service
  // (o catalog service silencia o erro do live e cai pra harvest/stale).
  // Sem isso, qualquer falha fica como "nenhuma fonte disponivel" generico
  // e e impossivel distinguir 403 escope vs categoria nao-folha vs categoria
  // obsoleta vs rate limit.
  let liveError: string | null = null;
  try {
    const resolution =
      await ShopeeAttributeCatalogService.getCategoryAttributes(
        REGION,
        categoryId,
        LOCALE,
        {
          fetchLive: async () => {
            try {
              return await ShopeeApiService.getCategoryAttributes(
                account.accessToken,
                account.shopId,
                categoryId,
                LOCALE,
              );
            } catch (err) {
              const status = (err as any)?.status;
              const message = err instanceof Error ? err.message : String(err);
              liveError = status ? `[${status}] ${message}` : message;
              throw err;
            }
          },
          harvest: () =>
            ListingUseCase.harvestShopeeAttrsFromAnyAccount(categoryId),
        },
      );
    if (!resolution || !resolution.attribute_list?.length) {
      // Tres casos distintos com diagnostico diferente:
      //   (a) liveError setado: live API throwou (ex: 403 escope, 400 categoria invalida)
      //   (b) resolution?.source === "live": live respondeu OK mas com [] —
      //       categoria pode ser nao-folha, obsoleta, ou simplesmente sem
      //       atributos. Importante NAO confundir com falha real porque o
      //       usuario nao consegue agir (re-rodar nao adianta).
      //   (c) caso geral (memory + DB + live + harvest todos vazios sem erro):
      //       mensagem antiga generica.
      let errorMsg: string;
      if (liveError) {
        errorMsg = `live falhou (${liveError}); harvest vazio; DB vazio`;
      } else if (resolution?.source === "live") {
        // Contar quantos produtos do usuario estao referenciando essa
        // categoria — info acionavel pro operador decidir se vale mudar
        // a categoria desses produtos pra uma folha valida.
        const productCount = await prisma.product.count({
          where: { shopeeCategoryId: String(categoryId) },
        });
        errorMsg =
          `live respondeu OK mas com 0 atributos (categoria provavelmente ` +
          `nao-folha, obsoleta ou sem schema). ` +
          `${productCount} produto(s) do DB usam essa shopeeCategoryId.`;
      } else {
        errorMsg = "nenhuma fonte disponível (DB vazio + live falhou + harvest vazio)";
      }
      return {
        categoryId,
        error: errorMsg,
        liveError: liveError ?? undefined,
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
      liveError: liveError ?? undefined,
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
