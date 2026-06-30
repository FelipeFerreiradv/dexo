import "dotenv/config";
import readline from "readline";
import axios from "axios";
import crypto from "crypto";
import { Platform, AccountStatus } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { MAGALU_CONSTANTS } from "../app/marketplaces/magalu/magalu-constants";
import { MagaluOAuthService } from "../app/marketplaces/services/magalu-oauth.service";

/**
 * Conecta uma conta Magalu via CLI (mesmo fluxo do connect-ml-account.ts):
 * gera a URL de consentimento do ID Magalu, você autoriza no browser e cola a
 * URL de retorno (com ?code=...&state=...) de volta aqui.
 *
 * Diferenças vs ML: SEM PKCE; troca de code em JSON; o identificador externo é
 * o tenant_id extraído do JWT. As credenciais (--app-client-id/secret) são
 * gravadas na conta (appClientId/appClientSecret) para o refresh per-account.
 *
 * Uso:
 *   npx tsx scripts/connect-magalu-account.ts \
 *     --user-id=... --account-name="Jotabe Autopecas" \
 *     --app-client-id=... --app-client-secret=... \
 *     --redirect-uri=https://api.usedexo.com.br/marketplace/magalu/callback
 */

interface Args {
  accountName: string;
  appClientId: string;
  appClientSecret: string;
  userId: string;
  redirectUri: string;
  scopes: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const flag = `--${name}=`;
    const found = argv.find((a) => a.startsWith(flag));
    return found ? found.slice(flag.length) : undefined;
  };
  const accountName = get("account-name");
  const appClientId = get("app-client-id");
  const appClientSecret = get("app-client-secret");
  const userId = get("user-id") ?? process.env.IMPORT_USER_ID;
  const redirectUri =
    get("redirect-uri") ??
    `${process.env.APP_BACKEND_URL ?? "http://localhost:3333"}/marketplace/magalu/callback`;
  const scopes = get("scopes") ?? MAGALU_CONSTANTS.SCOPES;
  if (!accountName || !appClientId || !appClientSecret || !userId) {
    throw new Error(
      "Required: --account-name=, --app-client-id=, --app-client-secret=, --user-id=",
    );
  }
  return {
    accountName,
    appClientId,
    appClientSecret,
    userId,
    redirectUri,
    scopes,
  };
}

async function readLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const seg = token.split(".")[1];
    if (!seg) return null;
    return JSON.parse(Buffer.from(seg, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const state = crypto.randomBytes(16).toString("hex");

  // Replica EXATAMENTE a URL do widget oficial "Autorizar com o ID Magalu"
  // (script.js): /login + choose_tenants, SEM PKCE. O fluxo do seller usa
  // /login (browser), não o /oauth/authorize cru (que devolve JSON).
  const params = new URLSearchParams({
    client_id: args.appClientId,
    redirect_uri: args.redirectUri,
    response_type: "code",
    choose_tenants: "true",
    scope: args.scopes,
    state,
  });
  const authUrl = `${MAGALU_CONSTANTS.AUTH_URL}/login?${params.toString()}`;

  console.log(`\n=== Conectando conta Magalu: ${args.accountName} ===`);
  console.log(`Client ID: ${args.appClientId}`);
  console.log(`Redirect:  ${args.redirectUri}`);
  console.log(
    `\n(IMPORTANTE: o redirect-uri precisa estar cadastrado no app do ID Magalu, idêntico.)`,
  );
  console.log(`\nPasso 1: abra esta URL no browser e autorize a loja (tenant):\n`);
  console.log(authUrl);
  console.log(
    `\nPasso 2: após autorizar, a Magalu redireciona (pode dar 404/erro na página — normal).`,
  );
  console.log(
    `         Copie a URL COMPLETA da barra do browser (deve ter ?code=...&state=...) e cole abaixo.\n`,
  );

  const fullUrl = await readLine("Cole a URL completa: ");
  const u = new URL(fullUrl);
  const code = u.searchParams.get("code");
  const stateBack = u.searchParams.get("state");
  if (!code) throw new Error("URL não contém ?code=");
  if (stateBack !== state) {
    console.warn(
      `[warn] state divergente (esperado=${state}, recebido=${stateBack}) — prosseguindo mesmo assim`,
    );
  }

  console.log(`\nTrocando code por tokens (JSON em ${MAGALU_CONSTANTS.AUTH_URL}${MAGALU_CONSTANTS.OAUTH_TOKEN_ENDPOINT})...`);
  const tokenResp = await axios.post<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type?: string;
    scope?: string;
  }>(
    `${MAGALU_CONSTANTS.AUTH_URL}${MAGALU_CONSTANTS.OAUTH_TOKEN_ENDPOINT}`,
    {
      grant_type: "authorization_code",
      client_id: args.appClientId,
      client_secret: args.appClientSecret,
      code,
      redirect_uri: args.redirectUri,
    },
    { headers: { "Content-Type": "application/json" } },
  );

  const tokens = tokenResp.data;

  // Diagnóstico: imprime as claims do JWT para VALIDAR onde está o tenant_id
  // (ponto TBD da integração — confirme qual claim usar).
  const payload = decodeJwtPayload(tokens.access_token);
  console.log(
    `\n[diagnóstico] claims do access_token (JWT):\n${JSON.stringify(payload, null, 2)}`,
  );

  const externalUserId = MagaluOAuthService.extractTenantId(tokens.access_token);
  if (!externalUserId) {
    throw new Error(
      "Não foi possível extrair o tenant_id do JWT. Veja as claims acima e me diga qual campo guarda o tenant — ajusto o extractTenantId.",
    );
  }

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  console.log(
    `\nTokens recebidos: tenant_id (externalUserId)=${externalUserId}, expires_in=${tokens.expires_in}s, scope=${tokens.scope ?? "(n/d)"}`,
  );

  const existing = await prisma.marketplaceAccount.findUnique({
    where: {
      platform_externalUserId: {
        platform: Platform.MAGALU,
        externalUserId,
      },
    },
  });

  if (existing) {
    const updated = await prisma.marketplaceAccount.update({
      where: { id: existing.id },
      data: {
        userId: args.userId,
        accountName: args.accountName,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
        appClientId: args.appClientId,
        appClientSecret: args.appClientSecret,
        status: AccountStatus.ACTIVE,
      },
    });
    console.log(
      `[ok] atualizou conta ${updated.id} (${updated.accountName}) — status=ACTIVE`,
    );
  } else {
    const created = await prisma.marketplaceAccount.create({
      data: {
        userId: args.userId,
        platform: Platform.MAGALU,
        accountName: args.accountName,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
        externalUserId,
        appClientId: args.appClientId,
        appClientSecret: args.appClientSecret,
        status: AccountStatus.ACTIVE,
      },
    });
    console.log(
      `[ok] criou conta ${created.id} (${created.accountName}) — status=ACTIVE`,
    );
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  if (axios.isAxiosError(err) && err.response) {
    console.error(
      `[fatal] response status: ${err.response.status} data: ${JSON.stringify(err.response.data)}`,
    );
  }
  process.exit(1);
});
