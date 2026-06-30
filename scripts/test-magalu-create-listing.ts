import "dotenv/config";
import axios from "axios";
import { Platform } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { MagaluOAuthService } from "../app/marketplaces/services/magalu-oauth.service";
import { MagaluApiService } from "../app/marketplaces/services/magalu-api.service";
import { MagaluPayloadBuilderService } from "../app/marketplaces/services/magalu-payload-builder.service";
import { MagaluCategoryResolutionService } from "../app/marketplaces/services/magalu-category-resolution.service";
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
        headers: {
          Authorization: `Bearer ${token}`,
          // alguns endpoints (ex.: /skus/:sku/validation-info) exigem o tenant.
          "X-Tenant-Id": account.externalUserId,
        },
        timeout: 30000,
      });
      console.log(JSON.stringify(resp.data, null, 2).slice(0, 20000));
    } catch (e: any) {
      console.log("[ERRO] status:", e?.response?.status);
      console.log(
        "[ERRO] data:\n" + JSON.stringify(e?.response?.data, null, 2),
      );
    }
    await prisma.$disconnect();
    return;
  }

  // Descoberta de categoria: lista candidatos (★ = no domínio Veículos e Peças)
  // para popular o de-para magalu-category-map.ts. Ex.: --find-category="tampa reservatorio"
  const findCat = arg("find-category");
  if (findCat) {
    const cats = await MagaluApiService.searchCategories(token, {
      name: findCat,
    });
    const hint = MAGALU_CONSTANTS.CATEGORY_ROOT_HINT.toLowerCase();
    console.log(`[find-category] "${findCat}" — ${cats.length} resultado(s):`);
    for (const c of cats) {
      const inDomain = String((c as any).path ?? "")
        .toLowerCase()
        .startsWith(hint);
      console.log(
        `  ${inDomain ? "★" : " "} ${c.id}  ${(c as any).path ?? (c as any).name ?? ""}`,
      );
    }
    await prisma.$disconnect();
    return;
  }

  const nameLike = arg("name-like");
  const product = productId
    ? await prisma.product.findFirst({ where: { id: productId, userId } })
    : await prisma.product.findFirst({
        where: {
          userId,
          stock: { gt: 0 },
          price: { gt: 0 },
          ...(nameLike
            ? { name: { contains: nameLike, mode: "insensitive" } }
            : {}),
        },
        orderBy: { updatedAt: "desc" },
      });
  if (!product) throw new Error("Produto não encontrado (precisa stock>0 e price>0)");

  console.log(
    `[produto] ${product.id} | "${product.name}" | sku=${product.sku} | stock=${product.stock} | price=${product.price}`,
  );

  // group.id é definido pelo seller (agrupa variações) — usamos o SKU por padrão.
  const groupId = arg("group-id") ?? product.sku;
  let channelId = arg("channel-id");
  if (!channelId) {
    const chans = await MagaluApiService.getChannels(token);
    channelId = chans[0]?.id;
    console.log(
      `[channel auto] ${channelId ?? "(nenhum)"} (${chans[0]?.name ?? ""})`,
    );
  }
  if (!channelId) throw new Error("Sem channel id (passe --channel-id)");

  // Modo: só setar estoque + preço de um SKU já existente (PATCH/atualizar).
  if (hasFlag("set-stock-price")) {
    console.log(`\n[setStock] sku=${product.sku} qty=${product.stock} ...`);
    try {
      await MagaluApiService.setStock(token, product.sku, product.stock, channelId, {
        create: true,
      });
      console.log("[stock OK]");
    } catch (e: any) {
      console.log("[stock ERRO]", e?.status, JSON.stringify(e?.responseData));
    }
    const priceReais = Number(product.price);
    console.log(`\n[setPrice] sku=${product.sku} price=R$${priceReais} ...`);
    try {
      await MagaluApiService.setPrice(token, product.sku, priceReais, channelId, {
        create: true,
      });
      console.log("[price OK]");
    } catch (e: any) {
      console.log("[price ERRO]", e?.status, JSON.stringify(e?.responseData));
    }
    await prisma.$disconnect();
    return;
  }

  // Resolução de categoria (best-effort) — exercita o módulo. --no-category pula.
  let catFields: {
    categoryId?: string;
    attributes?: Array<{ name: string; value: string }>;
    datasheet?: Array<{ name: string; value: string }>;
  } = { categoryId };
  if (!hasFlag("no-category")) {
    try {
      const cid =
        categoryId ??
        (await MagaluCategoryResolutionService.resolveCategoryId(token, product));
      if (cid) {
        const f = await MagaluCategoryResolutionService.buildCategoryFields(
          token,
          cid,
          product,
        );
        catFields = {
          categoryId: cid,
          attributes: f.attributes,
          datasheet: f.datasheet,
        };
        console.log(
          `\n[categoria] id=${cid}\n  attributes=${JSON.stringify(f.attributes)}\n  datasheet=${JSON.stringify(f.datasheet)}\n  missing=[${f.missing.join(", ")}]`,
        );
      } else {
        console.log("\n[categoria] nenhuma encontrada para o nome do produto");
      }
    } catch (e: any) {
      console.log(
        "\n[categoria] resolução falhou (precisa do escopo open:portfolio-categories-seller:read?):",
        e?.status ?? e?.message,
      );
    }
  }

  const payload = MagaluPayloadBuilderService.build(product, {
    groupId,
    channelId,
    ...catFields,
  });
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
