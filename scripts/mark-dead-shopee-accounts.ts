/**
 * mark-dead-shopee-accounts.ts
 *
 * Marca como ERROR as contas Shopee cuja autorização morreu de vez.
 *
 * Existe para o passivo: a auto-desativação (shopee-oauth.service.ts) só age no
 * próximo refresh que falhar, então as contas que já estavam mortas antes do
 * deploy ficariam ACTIVE até o sync tentar de novo. Este script antecipa isso.
 *
 * SEGURANÇA — o desenho importa aqui, porque `status: ERROR` REMOVE a conta do
 * laço de sync (sync-orders-and-metrics-loop.ts filtra por ACTIVE) e um falso
 * positivo pararia a ingestão de um vendedor que funciona:
 *
 *   1. Não trabalha com lista fixa. Para CADA candidata, chama a Shopee AGORA e
 *      só marca se a resposta for um código terminal confirmado. Conta que
 *      voltou a funcionar entre o levantamento e a execução não é tocada.
 *   2. Se o refresh der certo, PERSISTE o token novo (repara) em vez de marcar.
 *      Sem isso a Shopee rotacionaria o refresh token e o guardado viraria lixo.
 *   3. Dry-run por default; só escreve com --apply.
 *   4. Aborta se o banco não for o de São Paulo.
 *
 * Uso:
 *   npx tsx scripts/mark-dead-shopee-accounts.ts            # dry-run
 *   npx tsx scripts/mark-dead-shopee-accounts.ts --apply
 */
import "dotenv/config";

import axios from "axios";
import prisma from "../app/lib/prisma";
import { ShopeeOAuthService } from "../app/marketplaces/services/shopee-oauth.service";
import { SHOPEE_CONSTANTS } from "../app/marketplaces/shopee/shopee-constants";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";

/** Mesmos códigos da auto-desativação — ver TERMINAL_AUTH_ERRORS. */
const TERMINAIS = new Set(["shop_no_linked", "refresh_token_expired"]);

function arg(name: string, fallback: string): string {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function assertBanco(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("sa-east-1")) {
    throw new Error(
      `DATABASE_URL não aponta para São Paulo (sa-east-1). Abortando por segurança.`,
    );
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  assertBanco();

  console.log("=".repeat(74));
  console.log(`Contas Shopee com autorização morta — ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log("=".repeat(74));

  // Só entra quem está vencido há MAIS de `minDias`.
  //
  // "expirou" sozinho não significa nada: o access token da Shopee dura ~4 h e
  // é renovado sob demanda, então a qualquer momento há contas perfeitamente
  // saudáveis com `expiresAt` no passado — na primeira execução deste script
  // eram 8, todas com refresh funcionando. Sondá-las seria mexer em conta boa
  // sem motivo. As mortas de verdade estavam vencidas há 7 a 50 dias, então o
  // corte separa os dois grupos com folga.
  const minDias = Number(arg("min-days", "2"));
  const limite = new Date(Date.now() - minDias * 86_400_000);
  console.log(`\nCorte: vencidas há mais de ${minDias} dia(s).`);

  const candidatas = await prisma.marketplaceAccount.findMany({
    where: {
      platform: "SHOPEE",
      status: "ACTIVE",
      expiresAt: { lt: limite },
    },
    select: {
      id: true,
      accountName: true,
      shopId: true,
      refreshToken: true,
      expiresAt: true,
      user: { select: { email: true } },
    },
    orderBy: { expiresAt: "asc" },
  });

  console.log(`\nCandidatas (ACTIVE + token vencido): ${candidatas.length}\n`);

  const partnerId = parseInt(SHOPEE_CONSTANTS.PARTNER_ID!);
  let marcadas = 0;
  let reparadas = 0;
  let intocadas = 0;

  for (const c of candidatas) {
    const dias = ((Date.now() - c.expiresAt.getTime()) / 86_400_000).toFixed(1);
    const rotulo = `${c.accountName} (${c.user.email}, venceu há ${dias}d)`;

    if (c.shopId == null) {
      console.log(`  ~ ${rotulo}\n      sem shopId — pulando`);
      intocadas++;
      continue;
    }

    // Verificação AO VIVO, no momento da escrita.
    const ts = Math.floor(Date.now() / 1000);
    const apiPath = "/api/v2/auth/access_token/get";
    const sign = ShopeeOAuthService.generateSignature({
      partner_id: partnerId,
      api_path: apiPath,
      timestamp: ts,
    });
    const url = `${SHOPEE_CONSTANTS.API_URL}${apiPath}?partner_id=${partnerId}&timestamp=${ts}&sign=${sign}`;

    let code: string | undefined;
    let sucesso: Record<string, any> | undefined;
    try {
      const r = await axios.post(
        url,
        { refresh_token: c.refreshToken, shop_id: c.shopId, partner_id: partnerId },
        {
          headers: { "Content-Type": "application/json" },
          timeout: SHOPEE_CONSTANTS.REQUEST_TIMEOUT,
          validateStatus: () => true,
        },
      );
      if (r.data?.access_token) sucesso = r.data;
      else code = r.data?.error;
    } catch (e) {
      console.log(
        `  ~ ${rotulo}\n      erro de transporte (${e instanceof Error ? e.message : e}) — NÃO marcando`,
      );
      intocadas++;
      continue;
    }

    if (sucesso) {
      // Voltou a funcionar. Persistir é obrigatório: a Shopee já rotacionou o
      // refresh token, então o que está no banco acabou de virar lixo.
      console.log(`  ✓ ${rotulo}\n      REFRESH FUNCIONOU — conta viva`);
      if (apply) {
        await MarketplaceRepository.updateTokens(c.id, {
          accessToken: sucesso.access_token,
          refreshToken: sucesso.refresh_token,
          expiresAt: ShopeeOAuthService.calculateExpiryDate(sucesso.expire_in),
        });
        console.log("      token novo persistido (conta reparada)");
      } else {
        console.log("      [dry-run] persistiria o token novo");
      }
      reparadas++;
      continue;
    }

    if (!code || !TERMINAIS.has(code)) {
      console.log(
        `  ~ ${rotulo}\n      erro NÃO terminal (${code ?? "sem código"}) — NÃO marcando`,
      );
      intocadas++;
      continue;
    }

    console.log(`  ✗ ${rotulo}\n      ${code} — autorização morta`);
    if (apply) {
      // UPDATE explícito, uma conta por vez, com o id exato verificado agora.
      const n = await prisma.$executeRaw`
        UPDATE "MarketplaceAccount"
           SET "status" = 'ERROR', "updatedAt" = NOW()
         WHERE "id" = ${c.id}
           AND "platform" = 'SHOPEE'
           AND "status" = 'ACTIVE'
      `;
      console.log(`      UPDATE aplicado (${n} linha)`);
    } else {
      console.log(`      [dry-run] marcaria status=ERROR`);
    }
    marcadas++;
  }

  console.log(
    `\nResumo: ${marcadas} marcadas ERROR | ${reparadas} reparadas | ${intocadas} intocadas`,
  );
  if (!apply) console.log("Nada foi escrito. Rode com --apply para aplicar.");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("erro:", e);
  await prisma.$disconnect();
  process.exit(1);
});
