import "dotenv/config";
import http from "http";
import { AddressInfo } from "net";

/**
 * E2E SIMULADO da integração Facebook/Meta (Commerce Catalog), ponta-a-ponta,
 * SEM tocar na Graph API real nem no banco. Sobe um mock HTTP local imitando
 * graph.facebook.com e dirige o PIPELINE REAL de serviços por socket real:
 *
 *   1. OAuth  — consent URL real + exchangeCodeForToken (short→long) + /me
 *   2. Categoria — FacebookCategoryResolutionService.resolveCategory
 *   3. Payload — FacebookPayloadBuilderService.build (retailer_id=SKU, price,
 *                link via FB_PRODUCT_URL_BASE, images, google_product_category)
 *   4. Publicar — FacebookApiService.upsertItem → items_batch (CREATE, upsert)
 *   5. Status — checkBatchStatus (handle → finished)
 *   6. Estoque 0 → setAvailability 'out of stock' (UPDATE, item permanece)
 *   7. Refill    → setAvailability 'in stock'
 *   8. Remover   → deleteItem (DELETE)
 *
 * Por quê simulado: as credenciais reais da Meta exigem consent no domínio de
 * produção. Isto valida TODO o wiring/wire-format sem persistir no DB (parte
 * acoplada a DB coberta por unit tests). Roda: npx tsx scripts/facebook-e2e-sim.ts
 */

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  const CATALOG = "cat_sim_123";

  // Estado capturado pelo mock.
  const batches: any[] = []; // corpos de items_batch
  const authHeaders: string[] = [];
  let tokenGrants: string[] = [];
  let seq = 0;

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const path = url.pathname;
      const auth = (req.headers.authorization as string) || "";
      const json = (obj: any) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      if (path.endsWith("/oauth/access_token")) {
        // Short-lived (troca de code) OU long-lived (fb_exchange_token).
        const grant = url.searchParams.get("grant_type") || "code";
        tokenGrants.push(grant);
        return json({
          access_token:
            grant === "fb_exchange_token" ? "LONG_LIVED_TOKEN" : "SHORT_TOKEN",
          token_type: "bearer",
          expires_in: 5184000, // ~60d
        });
      }
      if (path.endsWith("/me")) {
        return json({ id: "act_9988", name: "Jotabé Autopeças" });
      }
      if (path.endsWith("/items_batch")) {
        authHeaders.push(auth);
        batches.push(raw ? JSON.parse(raw) : {});
        return json({ handles: [`h_${++seq}`] });
      }
      if (path.endsWith("/check_batch_request_status")) {
        const handle = url.searchParams.get("handle") || "";
        return json({ data: [{ handle, status: "finished" }] });
      }
      res.writeHead(404);
      res.end("not found");
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  // ⚠️ Aponta as constantes p/ o mock ANTES de importar os serviços (as
  // constantes leem process.env no import). FB_PRODUCT_URL_BASE injetada aqui.
  process.env.FACEBOOK_GRAPH_BASE_URL = base;
  process.env.FACEBOOK_DIALOG_BASE_URL = "https://www.facebook.com";
  process.env.FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID || "sim-app-id";
  process.env.FACEBOOK_APP_SECRET =
    process.env.FACEBOOK_APP_SECRET || "sim-app-secret";
  process.env.FACEBOOK_CATALOG_ID = CATALOG;
  process.env.FB_PRODUCT_URL_BASE = "https://loja.example.com/produto";

  const { FacebookOAuthService } =
    await import("../app/marketplaces/services/facebook-oauth.service");
  const { FacebookApiService } =
    await import("../app/marketplaces/services/facebook-api.service");
  const { FacebookPayloadBuilderService } =
    await import("../app/marketplaces/services/facebook-payload-builder.service");
  const { FacebookCategoryResolutionService } =
    await import("../app/marketplaces/services/facebook-category-resolution.service");

  // --- 1) URL de consent (dialog) ---
  section("1) URL de consent (Meta dialog)");
  const { authUrl } = FacebookOAuthService.generateAuthUrl("user-1");
  console.log(`  ${authUrl}`);
  check(
    "host = www.facebook.com",
    new URL(authUrl).host === "www.facebook.com",
  );
  check(
    "scope inclui catalog_management",
    (new URL(authUrl).searchParams.get("scope") || "").includes(
      "catalog_management",
    ),
  );

  // --- 2) Troca de code → long-lived + /me ---
  section("2) OAuth: exchange code → long-lived + /me");
  const tok = await FacebookOAuthService.exchangeCodeForToken("SIM_CODE");
  check("token final = long-lived", tok.accessToken === "LONG_LIVED_TOKEN");
  check(
    "2 grants (short + fb_exchange_token)",
    tokenGrants.includes("fb_exchange_token"),
    tokenGrants.join(","),
  );
  check("expiresAt no futuro (~60d)", tok.expiresAt.getTime() > Date.now());
  const me = await FacebookOAuthService.fetchMe(tok.accessToken);
  check("me.id capturado", me.id === "act_9988", String(me.id));

  // --- 3) Categoria (offline) ---
  section("3) Resolução de categoria (google_product_category)");
  const product = {
    sku: "ABC-123",
    name: "Retrovisor Moto Honda CG",
    description: "Retrovisor esquerdo",
    price: 199.9,
    brand: "Honda",
    itemCondition: "USADO",
    stock: 5,
    imageUrl: "https://img/1.jpg",
    imageUrls: ["https://img/2.jpg"],
  };
  const category = FacebookCategoryResolutionService.resolveCategory(product);
  check(
    "moto → Motorcycle Parts",
    category.includes("Motorcycle Parts"),
    category,
  );

  // --- 4) Payload ---
  section("4) Build do item de catálogo");
  const retailerId = FacebookPayloadBuilderService.buildRetailerId(product);
  const data = FacebookPayloadBuilderService.build(product, {
    googleProductCategory: category,
    availability: "in stock",
    quantity: product.stock,
  });
  check("retailer_id = SKU sanitizado", retailerId === "ABC-123", retailerId);
  check("price = '199.90 BRL'", data.price === "199.90 BRL", data.price);
  check(
    "link via FB_PRODUCT_URL_BASE",
    data.link === "https://loja.example.com/produto/ABC-123",
    data.link,
  );
  check("image_url principal", data.image_url === "https://img/1.jpg");
  check("condition = used", data.condition === "used");

  // --- 5) Publicar (CREATE upsert) + status ---
  section("5) Publicar (items_batch CREATE) + status");
  const pub = await FacebookApiService.upsertItem(
    tok.accessToken,
    retailerId,
    data,
  );
  const b0 = batches[batches.length - 1];
  check("item_type = PRODUCT_ITEM", b0.item_type === "PRODUCT_ITEM");
  check("method = CREATE", b0.requests[0].method === "CREATE");
  check("allow_upsert = true", b0.allow_upsert === true);
  check(
    "Authorization Bearer com o token",
    authHeaders[authHeaders.length - 1] === `Bearer ${tok.accessToken}`,
  );
  const handle = pub.handles?.[0] || "";
  const st = await FacebookApiService.checkBatchStatus(
    tok.accessToken,
    handle,
    {
      catalogId: CATALOG,
    },
  );
  check("status finished", st.data?.[0]?.status === "finished");

  // --- 6) Estoque 0 → out of stock (UPDATE, não delete) ---
  section("6) Estoque 0 → availability 'out of stock' (UPDATE)");
  await FacebookApiService.setAvailability(
    tok.accessToken,
    retailerId,
    "out of stock",
    {
      catalogId: CATALOG,
      quantity: 0,
    },
  );
  const b1 = batches[batches.length - 1];
  check("method = UPDATE (não DELETE)", b1.requests[0].method === "UPDATE");
  check(
    "availability = out of stock",
    b1.requests[0].data.availability === "out of stock",
  );
  check("quantity = 0", b1.requests[0].data.quantity_to_sell_on_facebook === 0);

  // --- 7) Refill → in stock ---
  section("7) Refill → availability 'in stock'");
  await FacebookApiService.setAvailability(
    tok.accessToken,
    retailerId,
    "in stock",
    {
      catalogId: CATALOG,
      quantity: 5,
    },
  );
  const b2 = batches[batches.length - 1];
  check(
    "availability = in stock",
    b2.requests[0].data.availability === "in stock",
  );

  // --- 8) Remover (DELETE) ---
  section("8) Remover item (DELETE)");
  await FacebookApiService.deleteItem(tok.accessToken, retailerId, {
    catalogId: CATALOG,
  });
  const b3 = batches[batches.length - 1];
  check("method = DELETE", b3.requests[0].method === "DELETE");
  check("retailer_id preservado", b3.requests[0].retailer_id === retailerId);

  server.close();

  section("Resultado");
  const total = 20;
  console.log(
    failures === 0
      ? `  ✓ TODOS OS CHECKS PASSARAM (${total})`
      : `  ✗ ${failures} CHECK(S) FALHARAM`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
