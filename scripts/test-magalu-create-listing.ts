import "dotenv/config";
import axios from "axios";
import { Platform } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { MagaluOAuthService } from "../app/marketplaces/services/magalu-oauth.service";
import { MagaluApiService } from "../app/marketplaces/services/magalu-api.service";
import { MagaluPayloadBuilderService } from "../app/marketplaces/services/magalu-payload-builder.service";
import { MAGALU_CONSTANTS } from "../app/marketplaces/magalu/magalu-constants";

/**
 * Diagnóstico do caminho de ESCRITA da Magalu (criar SKU no portfólio).
 * Monta o payload a partir de um Product, manda o POST e imprime a resposta
 * CRUA da API (status + body) para validar/ajustar o contrato. NÃO persiste
 * ProductListing — é só sondagem. Uso:
 *   npx tsx scripts/test-magalu-create-listing.ts --user-id=... [--product-id=...] [--category-id=...] [--dry]
 */

function arg(name: string): string | undefined {
  const flag = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(flag));
  return found ? found.slice(flag.length) : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const userId = arg("user-id");
  if (!userId) throw new Error("Required: --user-id=");
  const categoryId = arg("category-id");
  const productId = arg("product-id");

  const account = await MarketplaceRepository.findFirstActiveByUserAndPlatform(
    userId,
    Platform.MAGALU,
  );
  if (!account) throw new Error("Nenhuma conta Magalu ativa para esse user");

  let token = account.accessToken;
  if (account.expiresAt < new Date()) {
    console.log("[token] expirado — renovando...");
    const r = await MagaluOAuthService.refreshAccessTokenForAccount(
      account.id,
      account.refreshToken,
    );
    await MarketplaceRepository.updateTokens(account.id, {
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
      expiresAt: new Date(Date.now() + r.expiresIn * 1000),
    });
    token = r.accessToken;
  }

  // Modo diagnóstico: GET em qualquer endpoint (ex.: --get=/seller/v1/portfolios/groups)
  const getPath = arg("get");
  if (getPath) {
    console.log(`[GET] ${MAGALU_CONSTANTS.API_URL}${getPath}`);
    try {
      const resp = await axios.get(`${MAGALU_CONSTANTS.API_URL}${getPath}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30000,
      });
      console.log(JSON.stringify(resp.data, null, 2).slice(0, 6000));
    } catch (e: any) {
      console.log("[ERRO] status:", e?.response?.status);
      console.log(
        "[ERRO] data:\n" + JSON.stringify(e?.response?.data, null, 2),
      );
    }
    await prisma.$disconnect();
    return;
  }

  const product = productId
    ? await prisma.product.findFirst({ where: { id: productId, userId } })
    : await prisma.product.findFirst({
        where: { userId, stock: { gt: 0 }, price: { gt: 0 } },
        orderBy: { updatedAt: "desc" },
      });
  if (!product) throw new Error("Produto não encontrado (precisa stock>0 e price>0)");

  console.log(
    `[produto] ${product.id} | "${product.name}" | sku=${product.sku} | stock=${product.stock} | price=${product.price}`,
  );

  const payload = MagaluPayloadBuilderService.build(product, categoryId);
  console.log("\n[payload enviado]:\n" + JSON.stringify(payload, null, 2));

  if (hasFlag("dry")) {
    console.log("\n[dry] não enviou (flag --dry). Confira o payload acima.");
    await prisma.$disconnect();
    return;
  }

  console.log("\n[POST] /seller/v1/portfolios/skus ...");
  try {
    const created = await MagaluApiService.createSku(token, payload);
    console.log("\n[OK] resposta:\n" + JSON.stringify(created, null, 2));
  } catch (e: any) {
    console.log("\n[ERRO] message:", e?.message);
    console.log("[ERRO] status:", e?.status);
    console.log(
      "[ERRO] responseData:\n" + JSON.stringify(e?.responseData, null, 2),
    );
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  process.exit(1);
});
