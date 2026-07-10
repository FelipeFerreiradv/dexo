/**
 * PROBE (read-only, LGPD-safe) — descobre quais dados fiscais do comprador a
 * Shopee devolve em `get_order_detail`, para mapear o destinatário da NF-e.
 *
 * Roda na VPS (IP whitelistado na Shopee). Imprime SÓ a ESTRUTURA (nomes de
 * campo + "str(filled)"/"str(empty)"), NUNCA os valores do comprador.
 *
 * Uso (na VPS, a partir da raiz do repo):
 *   npx tsx scripts/prod-audit/probe-shopee-order-fiscal.ts
 *   npx tsx scripts/prod-audit/probe-shopee-order-fiscal.ts --order-sn=260410EC488U1C
 *   npx tsx scripts/prod-audit/probe-shopee-order-fiscal.ts --account-id=<id>
 *
 * Não grava nada. Só usa código já existente (ShopeeApiService/OAuth).
 */
import "dotenv/config";
import prisma from "../../app/lib/prisma";
import { ShopeeApiService } from "../../app/marketplaces/services/shopee-api.service";
import { ShopeeOAuthService } from "../../app/marketplaces/services/shopee-oauth.service";

function shape(o: any): any {
  if (o === null || o === undefined) return typeof o;
  if (Array.isArray(o)) return o.length ? [shape(o[0])] : [];
  if (typeof o === "object") {
    const r: any = {};
    for (const k of Object.keys(o)) r[k] = shape(o[k]);
    return r;
  }
  return typeof o === "string"
    ? o.length
      ? "str(filled)"
      : "str(empty)"
    : typeof o;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (n: string): string | undefined => {
    const p = args.find((a) => a.startsWith(`--${n}=`));
    return p ? p.slice(n.length + 3) : undefined;
  };
  return { orderSn: get("order-sn"), accountId: get("account-id") };
}

async function main() {
  const { orderSn, accountId } = parseArgs();
  const order = await prisma.order.findFirst({
    where: {
      marketplaceAccount: {
        platform: "SHOPEE",
        ...(accountId ? { id: accountId } : {}),
      },
      ...(orderSn ? { externalOrderId: orderSn } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      externalOrderId: true,
      marketplaceAccount: {
        select: {
          id: true,
          accountName: true,
          shopId: true,
          accessToken: true,
          refreshToken: true,
          expiresAt: true,
        },
      },
    },
  });
  if (!order?.marketplaceAccount?.shopId) {
    console.log("Nenhum pedido Shopee encontrado (ou conta sem shopId).");
    return;
  }
  const acc = order.marketplaceAccount;
  console.log(
    `Conta ${acc.accountName} shopId=${acc.shopId} | pedido ${order.externalOrderId}`,
  );

  let token = acc.accessToken;
  if (
    acc.refreshToken &&
    (!token ||
      (acc.expiresAt && acc.expiresAt.getTime() - Date.now() < 60_000))
  ) {
    try {
      token = (
        await ShopeeOAuthService.refreshAccessToken(
          acc.refreshToken,
          acc.shopId!,
        )
      ).access_token;
      console.log("(token refrescado)");
    } catch (e) {
      console.log("refresh falhou:", (e as any)?.message);
    }
  }

  // Campos opcionais relevantes p/ NF-e: endereço do destinatário + comprador +
  // dados de nota fiscal (quando a Shopee BR expõe).
  const fields = "recipient_address,buyer_username,buyer_user_id,invoice_data";
  const path = `/api/v2/order/get_order_detail?order_sn_list=${encodeURIComponent(
    order.externalOrderId,
  )}&response_optional_fields=${fields}`;

  try {
    const r = await (ShopeeApiService as any).makeAuthenticatedRequest(
      "GET",
      path,
      token,
      acc.shopId,
    );
    const od = r?.response?.order_list?.[0] ?? r;
    console.log(
      "\n=== ESTRUTURA do order_detail (LGPD: só nomes + preenchido/vazio) ===",
    );
    console.log(JSON.stringify(shape(od), null, 2));
  } catch (e) {
    console.log("ERRO:", (e as any)?.message);
    if ((e as any)?.response?.data) {
      console.log(
        "resp:",
        JSON.stringify((e as any).response.data).slice(0, 500),
      );
    }
  }
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
