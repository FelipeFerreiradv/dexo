import "dotenv/config";
import readline from "readline";
import axios from "axios";
import crypto from "crypto";
import { Platform, AccountStatus } from "@prisma/client";
import prisma from "../app/lib/prisma";

interface Args {
  accountName: string;
  appClientId: string;
  appClientSecret: string;
  userId: string;
  redirectUri: string;
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
    `${process.env.APP_BACKEND_URL ?? "http://localhost:3333"}/marketplace/ml/callback`;
  if (!accountName || !appClientId || !appClientSecret || !userId) {
    throw new Error(
      "Required: --account-name=, --app-client-id=, --app-client-secret=, --user-id=",
    );
  }
  return { accountName, appClientId, appClientSecret, userId, redirectUri };
}

const PKCE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

function genCodeVerifier(length = 128): string {
  let s = "";
  while (s.length < length) {
    s += PKCE_ALPHABET[crypto.randomInt(0, PKCE_ALPHABET.length)];
  }
  return s;
}

function s256(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const codeVerifier = genCodeVerifier();
  const codeChallenge = s256(codeVerifier);
  const state = crypto.randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: args.appClientId,
    redirect_uri: args.redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  const authUrl = `https://auth.mercadolivre.com.br/authorization?${params.toString()}`;

  console.log(`\n=== Conectando conta ML: ${args.accountName} ===`);
  console.log(`Client ID: ${args.appClientId}`);
  console.log(`Redirect: ${args.redirectUri}`);
  console.log(`\nPasso 1: abra esta URL no browser e autorize a conta certa:\n`);
  console.log(authUrl);
  console.log(
    `\nPasso 2: após autorizar, o ML vai redirecionar (pode dar erro 404, normal).`,
  );
  console.log(
    `         Copie a URL COMPLETA da barra do browser (deve ter ?code=...&state=...)`,
  );
  console.log(`         e cole abaixo.\n`);

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

  console.log(`\nTrocando code por tokens...`);
  const tokenResp = await axios.post<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    user_id: number | string;
    token_type?: string;
  }>(
    "https://api.mercadolibre.com/oauth/token",
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: args.appClientId,
      client_secret: args.appClientSecret,
      code,
      redirect_uri: args.redirectUri,
      code_verifier: codeVerifier,
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );

  const tokens = tokenResp.data;
  const externalUserId = String(tokens.user_id);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  console.log(
    `Tokens recebidos: external_user_id=${externalUserId}, expires_in=${tokens.expires_in}s`,
  );

  const existing = await prisma.marketplaceAccount.findUnique({
    where: {
      platform_externalUserId: {
        platform: Platform.MERCADO_LIVRE,
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
        platform: Platform.MERCADO_LIVRE,
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
      `[fatal] response data: ${JSON.stringify(err.response.data)}`,
    );
  }
  process.exit(1);
});
