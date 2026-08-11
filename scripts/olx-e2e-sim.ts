import "dotenv/config";
import http from "http";
import { AddressInfo } from "net";

/**
 * E2E SIMULADO da integração OLX, ponta-a-ponta, SEM tocar na OLX real nem no
 * banco. Sobe um mock HTTP local imitando auth.olx.com.br + apps.olx.com.br e
 * dirige o PIPELINE REAL de serviços por socket real:
 *
 *   1. OAuth  — consent URL real + exchangeCodeForTokens + basic_user_info
 *   2. Categoria — OlxCategoryResolutionService.resolveCategoryId
 *   3. Payload — OlxPayloadBuilderService.build (id=SKU, price int, images…)
 *   4. Publicar — OlxApiService.upsertAd → PUT /autoupload/import (insert)
 *   5. Status — pollImportUntilDone → captura list_id + url (id real do anúncio)
 *   6. Estoque 0 → despublicar — OlxApiService.deleteAd + poll (operation delete)
 *
 * Por quê simulado: a OLX só aceita o redirect de produção (o consent não roda
 * em localhost). Isto valida TODO o wiring/wire-format com as creds REAIS do
 * .env. NÃO persiste MarketplaceAccount/ProductListing (parte acoplada a DB,
 * coberta por unit tests).
 */

function mask(v?: string): string {
  if (!v) return "(vazio)";
  return v.length <= 8 ? "****" : `${v.slice(0, 4)}…${v.slice(-4)}`;
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  const realAuthUrl = process.env.OLX_AUTH_URL || "https://auth.olx.com.br";
  const clientId = process.env.OLX_CLIENT_ID || "";
  const clientSecret = process.env.OLX_CLIENT_SECRET || "";
  const redirectUri =
    process.env.OLX_REDIRECT_URI ||
    "https://usedexo.com.br/integracoes/olx/callback";
  const scopes = process.env.OLX_SCOPES || "basic_user_info autoupload";

  section("Config OLX (.env)");
  console.log(`  OLX_CLIENT_ID     : ${mask(clientId)}`);
  console.log(`  OLX_CLIENT_SECRET : ${mask(clientSecret)}`);
  console.log(`  OLX_REDIRECT_URI  : ${redirectUri}`);
  if (!clientId || !clientSecret) {
    console.error("\nOLX_CLIENT_ID/OLX_CLIENT_SECRET ausentes — abortando.");
    process.exit(1);
  }

  // --- 1) URL de consent REAL (clicável) ---
  const consentUrl = new URL("/oauth", realAuthUrl);
  consentUrl.searchParams.set("response_type", "code");
  consentUrl.searchParams.set("client_id", clientId);
  consentUrl.searchParams.set("redirect_uri", redirectUri);
  consentUrl.searchParams.set("scope", scopes);
  consentUrl.searchParams.set("state", "SIM_STATE");

  section("1) URL de consent (abrir logado como JOTABÉ AUTOPEÇAS)");
  console.log(`  ${consentUrl.toString()}`);
  check("host = auth.olx.com.br", consentUrl.host === "auth.olx.com.br");
  check(
    "redirect_uri = URL registrada",
    consentUrl.searchParams.get("redirect_uri") === redirectUri,
  );
  check("scope inclui autoupload", scopes.includes("autoupload"));

  // --- Mock OLX (token + user_info + autoupload import + status poll) ---
  let tokenReqBody: Record<string, string> = {};
  let userInfoReqBody: any = null;
  let putBody: any = null; // último PUT /autoupload/import
  const imports = new Map<string, any[]>(); // token → ad_list
  let seq = 0;

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const json = (o: any) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(o));
      };

      if (req.method === "POST" && req.url === "/oauth/token") {
        tokenReqBody = Object.fromEntries(new URLSearchParams(raw));
        return json({
          access_token: "SIM_ACCESS_TOKEN_abc123",
          token_type: "Bearer",
        });
      }
      if (req.method === "POST" && req.url === "/oauth_api/basic_user_info") {
        try {
          userInfoReqBody = JSON.parse(raw || "{}");
        } catch {
          userInfoReqBody = null;
        }
        return json({
          user_name: "JOTABÉ AUTOPEÇAS",
          user_email: "jotabeautopecas@gmail.com",
        });
      }
      if (req.method === "PUT" && req.url === "/autoupload/import") {
        try {
          putBody = JSON.parse(raw || "{}");
        } catch {
          putBody = null;
        }
        const token = `imp-${++seq}`;
        imports.set(token, putBody?.ad_list ?? []);
        return json({ token, statusCode: 0, statusMessage: "OK" });
      }
      if (req.method === "POST" && req.url?.startsWith("/autoupload/import/")) {
        const token = decodeURIComponent(req.url.split("/").pop() || "");
        const adList = imports.get(token) ?? [];
        const ads: Record<string, any> = {};
        for (const ad of adList) {
          ads[ad.id] =
            ad.operation === "delete"
              ? { status: "accepted", operation: "delete" }
              : {
                  status: "accepted",
                  operation: "insert",
                  list_id: `OLX-${ad.id}-777`,
                  url: `https://www.olx.com.br/vi/${ad.id}`,
                };
        }
        return json({ autoupload_status: "done", ads });
      }
      res.writeHead(404).end();
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const mockBase = `http://127.0.0.1:${port}`;

  // Repontar hosts ANTES de importar (OLX_CONSTANTS lê env no import).
  process.env.OLX_AUTH_URL = mockBase;
  process.env.OLX_API_URL = mockBase;

  const { OlxOAuthService } =
    await import("../app/marketplaces/services/olx-oauth.service");
  const { OlxApiService } =
    await import("../app/marketplaces/services/olx-api.service");
  const { OlxCategoryResolutionService } =
    await import("../app/marketplaces/services/olx-category-resolution.service");
  const { OlxPayloadBuilderService } =
    await import("../app/marketplaces/services/olx-payload-builder.service");

  // --- OAuth wire (contra mock, creds reais no corpo) ---
  section("2) Troca code → token + basic_user_info (wire real)");
  const { accessToken } =
    await OlxOAuthService.exchangeCodeForTokens("SIM_AUTH_CODE");
  check("access_token recebido", accessToken === "SIM_ACCESS_TOKEN_abc123");
  check(
    "grant_type = authorization_code",
    tokenReqBody.grant_type === "authorization_code",
  );
  check(
    "client_id/secret enviados = reais",
    tokenReqBody.client_id === clientId &&
      tokenReqBody.client_secret === clientSecret,
  );
  check(
    "redirect_uri enviado = registrado",
    tokenReqBody.redirect_uri === redirectUri,
  );
  const info = await OlxOAuthService.fetchBasicUserInfo(accessToken);
  check(
    "basic_user_info: token no CORPO (sem Bearer)",
    userInfoReqBody?.access_token === accessToken,
  );
  check(
    "user_email retornado",
    info.user_email === "jotabeautopecas@gmail.com",
  );

  // --- Produto de teste (autopeça) ---
  const product = {
    sku: "FAROL-GOL2010-DIR",
    name: "Farol Dianteiro Direito Gol G4 2010 Original",
    description: "Farol dianteiro direito, lado do passageiro, testado e OK.",
    price: 189.9,
    brand: "Volkswagen",
    model: "Gol G4",
    year: "2010",
    quality: "USADO",
    imageUrl: "https://cdn.dexo.com.br/farol-gol-1.jpg",
    imageUrls: ["https://cdn.dexo.com.br/farol-gol-2.jpg"],
  };

  section("3) Resolução de categoria");
  const categoryId = OlxCategoryResolutionService.resolveCategoryId(product);
  check(
    "peça de carro → default 2101 (Carros, vans e utilitários)",
    categoryId === 2101,
    String(categoryId),
  );
  check(
    "veículo no nome resolve (moto → 2103)",
    OlxCategoryResolutionService.resolveCategoryId({
      name: "Retrovisor Moto Honda CG",
    }) === 2103,
  );
  check(
    "olxCategoryId explícito vence",
    OlxCategoryResolutionService.resolveCategoryId({
      ...product,
      olxCategoryId: 2103,
    }) === 2103,
  );

  section("4) Montagem do payload (OlxAd)");
  const ad = OlxPayloadBuilderService.build(product, {
    categoryId: categoryId!,
    phone: process.env.OLX_SELLER_PHONE || "21999998888",
    zipcode: process.env.OLX_SELLER_ZIPCODE || "20000000",
    params: OlxCategoryResolutionService.buildAdParams(product, categoryId!),
  });
  check(
    "id = SKU sanitizado (≤19)",
    ad.id === "FAROL-GOL2010-DIR" && ad.id.length <= 19,
    ad.id,
  );
  check("price INTEIRO (sem decimais)", ad.price === 190, String(ad.price));
  check("category setada", ad.category === 2101);
  check("Phone só dígitos", /^\d{10,11}$/.test(ad.Phone), ad.Phone);
  check("images coletadas", (ad.images?.length ?? 0) === 2);
  check(
    "params reais: condition=2 (usado) + parts_name_cars=4",
    (ad.params as any)?.condition === "2" &&
      (ad.params as any)?.parts_name_cars === "4",
  );

  // --- 5) Publicar (insert) + status ---
  section("5) Publicar anúncio (PUT /autoupload/import insert) + poll status");
  const pub = await OlxApiService.upsertAd(accessToken, ad);
  check(
    "access_token no CORPO do PUT (sem Bearer)",
    putBody?.access_token === accessToken,
  );
  check("operation = insert", putBody?.ad_list?.[0]?.operation === "insert");
  check("statusCode 0 + token retornado", pub.statusCode === 0 && !!pub.token);
  const pubStatus = await OlxApiService.pollImportUntilDone(
    accessToken,
    pub.token!,
    { intervalMs: 10, maxAttempts: 5 },
  );
  const entry = pubStatus?.ads?.[ad.id];
  check("autoupload_status = done", pubStatus?.autoupload_status === "done");
  check("anúncio accepted", entry?.status === "accepted");
  check("list_id (id REAL OLX) capturado", !!entry?.list_id, entry?.list_id);
  check("url pública capturada", !!entry?.url, entry?.url);

  // --- 6) Estoque 0 → despublicar (delete) ---
  section("6) Estoque 0 → despublicar (PUT delete) + poll");
  const del = await OlxApiService.deleteAd(accessToken, ad.id);
  check(
    "operation = delete (mesmo id)",
    putBody?.ad_list?.[0]?.operation === "delete" &&
      putBody?.ad_list?.[0]?.id === ad.id,
  );
  check("statusCode 0 + token retornado", del.statusCode === 0 && !!del.token);
  const delStatus = await OlxApiService.pollImportUntilDone(
    accessToken,
    del.token!,
    { intervalMs: 10, maxAttempts: 5 },
  );
  check("delete accepted", delStatus?.ads?.[ad.id]?.status === "accepted");
  check(
    "operation refletida = delete",
    delStatus?.ads?.[ad.id]?.operation === "delete",
  );

  server.close();
  section(
    `Resultado E2E: ${failures === 0 ? "PASS ✅" : `FAIL ❌ (${failures})`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro na simulação E2E OLX:", e);
  process.exit(1);
});
