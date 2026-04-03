/**
 * Script ad-hoc para apagar todos os anúncios de uma conta Shopee.
 * Uso:
 *   npx tsx scripts/delete-shopee-all.ts --user <userId> [--account <accountId>] [--dry-run]
 *
 * - Não expõe rota nem método público; roda só localmente/CLI.
 * - Requer variáveis SHOPEE_PARTNER_ID/KEY/BASE_URL já configuradas.
 */

import "dotenv/config";
import prisma from "../app/lib/prisma";
import { Platform } from "@prisma/client";
import { ShopeeApiService } from "../app/marketplaces/services/shopee-api.service";
import { ShopeeOAuthService } from "../app/marketplaces/services/shopee-oauth.service";

type Args = { user: string; account?: string; dryRun: boolean; max?: number };

function parseArgs(): Args {
  const arg = (flag: string) => {
    const idx = process.argv.indexOf(flag);
    return idx >= 0 ? process.argv[idx + 1] : undefined;
  };
  const user = arg("--user");
  const account = arg("--account");
  const dryRun = process.argv.includes("--dry-run");
  const max = arg("--max") ? Number(arg("--max")) : undefined;
  if (!user) {
    console.error("Informe --user <userId>");
    process.exit(1);
  }
  return { user, account, dryRun, max };
}

async function pickAccount(userId: string, accountId?: string) {
  if (accountId) {
    const acc = await prisma.marketplaceAccount.findFirst({
      where: { id: accountId, userId, platform: Platform.SHOPEE },
    });
    if (!acc) throw new Error("Conta Shopee não encontrada para este usuário");
    return acc;
  }
  const acc = await prisma.marketplaceAccount.findFirst({
    where: { userId, platform: Platform.SHOPEE },
    orderBy: { updatedAt: "desc" },
  });
  if (!acc) throw new Error("Nenhuma conta Shopee encontrada para este usuário");
  return acc;
}

async function main() {
  const { user, account: accountId, dryRun, max } = parseArgs();
  const account = await pickAccount(user, accountId);

  if (!account.accessToken || !account.shopId) {
    throw new Error("Conta Shopee sem accessToken ou shopId");
  }

  let accessToken = account.accessToken;
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
      await prisma.marketplaceAccount.update({
        where: { id: account.id },
        data: {
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token,
          expiresAt: new Date(Date.now() + refreshed.expire_in * 1000),
        },
      });
      accessToken = refreshed.access_token;
      return true;
    }
    return false;
  };

  // 1) Listar todos os itens (todos os status)
  const itemIds: number[] = [];
  // Focamos em statuses que realmente existem e interessam para remoção efetiva.
  // DELETED já está removido na Shopee; pular para acelerar.
  const statuses = ["NORMAL", "UNLIST", "BANNED", "REVIEWING"];
  const pageSize = 100;
  for (const status of statuses) {
    let offset = 0;
    let page = 1;
    while (true) {
      try {
        const list = await ShopeeApiService.getItemList(
          accessToken,
          account.shopId,
          {
            offset,
            page_size: pageSize,
            item_status: [status] as any,
            response_optional_fields: ["item_sku"],
          },
        );
        const items = list?.item || [];
        if (items.length > 0) {
          itemIds.push(...items.map((i: any) => i.item_id));
        }
        console.log(
          `[LIST] status=${status} page=${page} items=${items.length} has_next=${list?.has_next_page}`,
        );
        if (!list?.has_next_page) break;
        offset = list.next_offset || offset + pageSize;
        page++;
      } catch (error: any) {
        const refreshed = await refreshIfNeeded(error);
        if (refreshed) continue;
        throw error;
      }
    }
  }

  console.log(
    `[INFO] Encontrados ${itemIds.length} itens para deletar na conta ${account.accountName} (${account.id})`,
  );

  if (dryRun) {
    console.log("[DRY-RUN] Primeiros IDs:", itemIds.slice(0, 20));
    return;
  }

  // 2) Deletar um a um
  let deleted = 0;
  const errors: string[] = [];
  for (const [idx, id] of itemIds.entries()) {
    try {
      await ShopeeApiService.deleteItem(accessToken, account.shopId!, id);
      deleted++;
      if (deleted % 20 === 0) {
        console.log(
          `[DEL] ${deleted}/${itemIds.length} deletados (atual id=${id})`,
        );
      }
      if (max && deleted >= max) {
        console.log(
          `[STOP] limite de ${max} deleções atingido nesta execução.`,
        );
        break;
      }
    } catch (error: any) {
      const refreshed = await refreshIfNeeded(error);
      if (refreshed) {
        try {
          await ShopeeApiService.deleteItem(accessToken, account.shopId!, id);
          deleted++;
          continue;
        } catch (err) {
          errors.push(`Item ${id}: ${err instanceof Error ? err.message : err}`);
          continue;
        }
      }
      errors.push(
        `Item ${id}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  console.log(
    `[DONE] total=${itemIds.length} deleted=${deleted} failed=${itemIds.length - deleted}`,
  );
  if (errors.length) {
    console.log("[ERRORS] Alguns itens falharam:");
    errors.slice(0, 20).forEach((e) => console.log(" -", e));
    if (errors.length > 20) {
      console.log(` ... (${errors.length - 20} mais)`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
