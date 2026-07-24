import "dotenv/config";
import axios from "axios";
import prisma from "../app/lib/prisma";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { ML_CONSTANTS } from "../app/marketplaces/mercado-livre/ml-constants";

/**
 * Sonda READ-ONLY dos endpoints de compatibilidade do Mercado Livre.
 *
 * Motivo: o painel do ML mostra "Compatibilidades" vazio em anúncios que o
 * sistema declarou publicados com sucesso. O código de escrita trata HTTP 200
 * como sucesso mesmo quando o ML responde `ids: []` (aceito e ignorado), e não
 * existe nenhuma LEITURA de compatibilidades no MLApiService — ou seja, hoje é
 * impossível saber o que ficou gravado. Antes de implementar o read-after-write
 * precisamos confirmar contra a API real:
 *
 *   1. Qual endpoint de LEITURA funciona (item legado vs User Product) e qual o
 *      shape exato da resposta — como distinguir "tem N veículos" de "vazio".
 *   2. Se GET /catalog_domains/MLB-CARS_AND_VANS ainda devolve as marcas (o log
 *      de produção mostra `brandsCache loaded: 0 brands`). Se vier populado, o
 *      bug é de parsing/cache nosso; se vier vazio, é contrato do ML.
 *   3. Se o `value_id` de uma marca vinda de catalog_domains é o MESMO da mesma
 *      marca vinda de top_values e o MESMO que aparece dentro dos produtos de
 *      products_search/chunks. Se os espaços de ID divergirem, o filtro por
 *      igualdade de value_id em resolveCompatibilityCatalogProducts é
 *      logicamente errado — é a hipótese para o "0 of 1500 matched brand+model".
 *   4. Quais atributos de lado/posição a categoria do anúncio expõe, e se o
 *      lado é atributo DO ITEM ou atributo POR VEÍCULO dentro da compat.
 *
 * NÃO ESCREVE NADA no ML nem no banco de dados de negócio. A única escrita
 * possível é a rotação do token OAuth (operação normal do sistema, feita apenas
 * quando o access_token está expirado). Nenhum access_token é impresso.
 *
 * Uso:
 *   tsx scripts/probe-ml-compat-read.ts --item=MLB1234567890
 *   tsx scripts/probe-ml-compat-read.ts --item=MLB123 --account-id=cmp...
 *   tsx scripts/probe-ml-compat-read.ts --item=MLB123 --brand=Volkswagen --model=Parati
 *
 * Flags:
 *   --item=MLB...        (obrigatório) anúncio a sondar
 *   --account-id=ID      conta ML específica; default = a conta dona do anúncio
 *   --brand=Nome         marca para o teste de espaço de IDs (default: Volkswagen)
 *   --model=Nome         modelo para o teste de espaço de IDs (default: Gol)
 *   --full               imprime bodies completos em vez de resumo + amostra
 */

const args = process.argv.slice(2);
const argValue = (name: string): string | null =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ??
  null;

const itemIdArg = argValue("item");
const accountIdArg = argValue("account-id");
const probeBrand = argValue("brand") ?? "Volkswagen";
const probeModel = argValue("model") ?? "Gol";
const full = args.includes("--full");

const DOMAIN = "MLB-CARS_AND_VANS";

function log(msg: string): void {
  console.log(msg);
}

function section(title: string): void {
  log("");
  log("=".repeat(78));
  log(title);
  log("=".repeat(78));
}

/** Serializa para inspeção humana, cortando quando não estamos em --full. */
function dump(data: unknown, maxChars = 2000): string {
  let text: string;
  try {
    text = JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
  if (text === undefined) return "undefined";
  if (full || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncado — rode com --full para o body inteiro; ${text.length} chars]`;
}

interface ProbeResult {
  ok: boolean;
  status: number | null;
  data: unknown;
  error?: string;
}

async function probeGet(
  label: string,
  url: string,
  token: string,
): Promise<ProbeResult> {
  log("");
  log(`--- GET ${url}`);
  try {
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000,
      validateStatus: () => true,
    });
    log(`    status: ${resp.status}`);
    log(`    body: ${dump(resp.data)}`);
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      data: resp.data,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`    FALHOU (rede/timeout): ${msg}`);
    return { ok: false, status: null, data: null, error: msg };
  }
}

async function probePost(
  label: string,
  url: string,
  body: unknown,
  token: string,
): Promise<ProbeResult> {
  log("");
  log(`--- POST ${url}`);
  log(`    body enviado: ${JSON.stringify(body)}`);
  try {
    const resp = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
      validateStatus: () => true,
    });
    log(`    status: ${resp.status}`);
    log(`    body: ${dump(resp.data)}`);
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      data: resp.data,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`    FALHOU (rede/timeout): ${msg}`);
    return { ok: false, status: null, data: null, error: msg };
  }
}

/** Normaliza igual ao ml-api.service (NFD + strip diacríticos + trim + lower). */
function normalize(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Resolve a conta ML e devolve um access_token válido. Refresca apenas se o
 * token estiver a menos de 60s de expirar (mesma regra do backfill).
 */
async function resolveToken(): Promise<{
  token: string;
  accountId: string;
  accountName: string;
} | null> {
  let account: {
    id: string;
    accountName: string | null;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  } | null = null;

  if (accountIdArg) {
    account = await prisma.marketplaceAccount.findFirst({
      where: { id: accountIdArg, platform: "MERCADO_LIVRE" },
      select: {
        id: true,
        accountName: true,
        accessToken: true,
        refreshToken: true,
        expiresAt: true,
      },
    });
    if (!account) {
      console.error(
        `[probe] Conta ML ${accountIdArg} não encontrada. Use --account-id de uma conta MERCADO_LIVRE.`,
      );
      return null;
    }
  } else {
    // Sem --account-id: descobre a conta dona do anúncio pelo ProductListing.
    const listing = await prisma.productListing.findFirst({
      where: {
        externalListingId: itemIdArg!,
        marketplaceAccount: { platform: "MERCADO_LIVRE" },
      },
      select: {
        marketplaceAccount: {
          select: {
            id: true,
            accountName: true,
            accessToken: true,
            refreshToken: true,
            expiresAt: true,
          },
        },
      },
    });
    if (!listing?.marketplaceAccount) {
      console.error(
        `[probe] Nenhum ProductListing com externalListingId=${itemIdArg} encontrado.`,
      );
      console.error(
        `[probe] Passe --account-id=ID explicitamente (o anúncio pode não estar vinculado no banco).`,
      );
      return null;
    }
    account = listing.marketplaceAccount;
  }

  let token = account.accessToken;
  if (new Date(account.expiresAt).getTime() <= Date.now() + 60_000) {
    log("[probe] access_token expirado — rotacionando (única escrita do script).");
    const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
      account.id,
      account.refreshToken,
    );
    await prisma.marketplaceAccount.update({
      where: { id: account.id },
      data: {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      },
    });
    token = refreshed.accessToken;
  }

  return {
    token,
    accountId: account.id,
    accountName: account.accountName ?? "(sem nome)",
  };
}

/**
 * Extrai (value_id, value_name) de um atributo de catalog product, tolerando
 * as duas formas que o ML usa (value_id/value_name direto ou values[0]).
 */
function attrValue(
  attrs: Array<{
    id?: string;
    value_id?: string | null;
    value_name?: string | null;
    values?: Array<{ id?: string | null; name?: string | null }>;
  }> | null
    | undefined,
  id: string,
): { id: string | null; name: string | null } {
  const attr = (attrs || []).find((a) => a?.id === id);
  if (!attr) return { id: null, name: null };
  if (attr.value_id || attr.value_name) {
    return { id: attr.value_id ?? null, name: attr.value_name ?? null };
  }
  const first = attr.values?.[0];
  return { id: first?.id ?? null, name: first?.name ?? null };
}

async function main(): Promise<void> {
  if (!itemIdArg) {
    console.error(
      "[probe] Faltou --item=MLB... (id do anúncio afetado). Nada foi consultado.",
    );
    process.exit(1);
  }

  const resolved = await resolveToken();
  if (!resolved) {
    await prisma.$disconnect();
    process.exit(1);
  }
  const { token, accountId, accountName } = resolved;

  log(`[probe] item=${itemIdArg}`);
  log(`[probe] conta=${accountName} (${accountId})`);
  log(`[probe] marca/modelo de teste=${probeBrand}/${probeModel}`);
  log(`[probe] NENHUMA escrita no ML. Tokens nunca são impressos.`);

  // ---------------------------------------------------------------------
  // 1. Metadados do item: user_product_id e category_id
  // ---------------------------------------------------------------------
  section("1. GET /items/{id} — user_product_id e category_id");
  const itemResp = await probeGet("item", `${ML_CONSTANTS.API_URL}/items/${itemIdArg}`, token);
  const itemData = itemResp.data as
    | {
        user_product_id?: string | null;
        category_id?: string | null;
        status?: string;
        attributes?: Array<{ id?: string; value_name?: string | null }>;
      }
    | null;
  const userProductId = itemData?.user_product_id ?? null;
  const categoryId = itemData?.category_id ?? null;
  const hasCompatAttr = (itemData?.attributes || []).find(
    (a) => a?.id === "HAS_COMPATIBILITIES",
  );

  log("");
  log(`>>> user_product_id: ${userProductId ?? "(nenhum — item legado)"}`);
  log(`>>> category_id: ${categoryId ?? "(desconhecido)"}`);
  log(`>>> status: ${itemData?.status ?? "?"}`);
  log(
    `>>> HAS_COMPATIBILITIES: ${hasCompatAttr?.value_name ?? "(atributo ausente)"}`,
  );

  // ---------------------------------------------------------------------
  // 2 e 3. Endpoints de LEITURA de compatibilidade
  // ---------------------------------------------------------------------
  section("2. GET /items/{id}/compatibilities — leitura (item legado)");
  const readItem = await probeGet(
    "compat-item",
    `${ML_CONSTANTS.API_URL}/items/${itemIdArg}/compatibilities`,
    token,
  );

  section("3. GET /user-products/{up}/compatibilities — leitura (User Product)");
  let readUp: ProbeResult | null = null;
  if (userProductId) {
    readUp = await probeGet(
      "compat-up",
      `${ML_CONSTANTS.API_URL}/user-products/${userProductId}/compatibilities`,
      token,
    );
  } else {
    log("");
    log("    (pulado — o item não tem user_product_id)");
  }

  // Candidatos alternativos, sondados só se os dois principais falharem.
  if (!readItem.ok && !(readUp?.ok ?? false)) {
    section("3b. Endpoints alternativos (os principais falharam)");
    await probeGet(
      "item-attr-compat",
      `${ML_CONSTANTS.API_URL}/items/${itemIdArg}?attributes=compatibilities`,
      token,
    );
    if (userProductId) {
      await probeGet(
        "user-product",
        `${ML_CONSTANTS.API_URL}/user-products/${userProductId}`,
        token,
      );
    }
  }

  // ---------------------------------------------------------------------
  // 4. catalog_domains — a fonte primária de marcas está viva?
  // ---------------------------------------------------------------------
  section("4. GET /catalog_domains/{domain} — fonte primária de marcas");
  const domainResp = await probeGet(
    "catalog-domains",
    `${ML_CONSTANTS.API_URL}/catalog_domains/${DOMAIN}`,
    token,
  );
  const domainData = domainResp.data as
    | {
        attributes?: Array<{
          id?: string;
          values?: Array<{ id?: string; name?: string }>;
        }>;
      }
    | null;
  const domainBrandAttr = (domainData?.attributes || []).find(
    (a) => a?.id === "BRAND",
  );
  const domainBrands = domainBrandAttr?.values ?? [];
  log("");
  log(`>>> atributos no domínio: ${(domainData?.attributes || []).map((a) => a?.id).join(", ") || "(nenhum)"}`);
  log(`>>> BRAND.values: ${domainBrands.length} marcas`);
  if (domainBrands.length > 0) {
    log(`>>> amostra: ${JSON.stringify(domainBrands.slice(0, 10))}`);
  }
  log(
    domainBrands.length === 0
      ? ">>> VAZIO — confirma o log de produção 'brandsCache loaded: 0 brands'. O fallback por top_values virou o caminho principal."
      : ">>> POPULADO — se em produção vem 0, o bug é de parsing/cache nosso, não de contrato do ML.",
  );

  const brandFromDomain = domainBrands.find(
    (v) => normalize(v?.name ?? "") === normalize(probeBrand),
  );
  log(
    `>>> "${probeBrand}" em catalog_domains: ${
      brandFromDomain ? `value_id=${brandFromDomain.id}` : "NÃO ENCONTRADA"
    }`,
  );

  // ---------------------------------------------------------------------
  // 5. top_values — a fonte de fallback (truncada?)
  // ---------------------------------------------------------------------
  section("5. POST .../attributes/BRAND/top_values — fonte de fallback");
  const brandTopResp = await probePost(
    "top-values-brand",
    `${ML_CONSTANTS.API_URL}/catalog_domains/${DOMAIN}/attributes/BRAND/top_values`,
    {},
    token,
  );
  const brandTopRaw = Array.isArray(brandTopResp.data)
    ? (brandTopResp.data as Array<{ id?: string; name?: string }>)
    : ((brandTopResp.data as { values?: Array<{ id?: string; name?: string }> })
        ?.values ?? []);
  log("");
  log(`>>> total de marcas em top_values: ${brandTopRaw.length}`);
  const brandFromTop = brandTopRaw.find(
    (v) => normalize(v?.name ?? "") === normalize(probeBrand),
  );
  log(
    `>>> "${probeBrand}" em top_values: ${
      brandFromTop ? `value_id=${brandFromTop.id}` : "NÃO ENCONTRADA"
    }`,
  );

  let modelTopRaw: Array<{ id?: string; name?: string }> = [];
  if (brandFromTop?.id) {
    section("5b. POST .../attributes/MODEL/top_values (filtrado por BRAND)");
    const modelTopResp = await probePost(
      "top-values-model",
      `${ML_CONSTANTS.API_URL}/catalog_domains/${DOMAIN}/attributes/MODEL/top_values`,
      { known_attributes: [{ id: "BRAND", value_id: brandFromTop.id }] },
      token,
    );
    modelTopRaw = Array.isArray(modelTopResp.data)
      ? (modelTopResp.data as Array<{ id?: string; name?: string }>)
      : ((modelTopResp.data as { values?: Array<{ id?: string; name?: string }> })
          ?.values ?? []);
    log("");
    log(`>>> total de modelos para ${probeBrand}: ${modelTopRaw.length}`);
    log(
      `>>> nomes: ${JSON.stringify(modelTopRaw.map((m) => m?.name).slice(0, 40))}`,
    );
    const modelHit = modelTopRaw.find(
      (v) => normalize(v?.name ?? "") === normalize(probeModel),
    );
    log(
      `>>> "${probeModel}" em top_values de MODEL: ${
        modelHit ? `value_id=${modelHit.id}` : "NÃO ENCONTRADO — modelo fora do top-N nunca resolve value_id"
      }`,
    );
  }

  // ---------------------------------------------------------------------
  // 6. O TESTE DECISIVO: os espaços de value_id batem?
  // ---------------------------------------------------------------------
  section("6. Espaços de value_id: catalog_domains vs top_values vs chunks");

  const chunkBody: Record<string, unknown> = {
    site_id: "MLB",
    domain_id: DOMAIN,
    limit: 10,
    offset: 0,
    open_attributes: [
      { id: "BRAND", value_name: probeBrand },
      { id: "MODEL", value_name: probeModel },
    ],
  };
  const chunkResp = await probePost(
    "chunks",
    `${ML_CONSTANTS.API_URL}/catalog_compatibilities/products_search/chunks`,
    chunkBody,
    token,
  );
  const chunkResults =
    (chunkResp.data as {
      results?: Array<{
        id?: string;
        attributes?: Array<{
          id?: string;
          value_id?: string | null;
          value_name?: string | null;
          values?: Array<{ id?: string | null; name?: string | null }>;
        }>;
      }>;
    })?.results ?? [];

  log("");
  log(`>>> produtos retornados: ${chunkResults.length}`);
  const brandIdsInProducts = new Set<string>();
  const modelIdsInProducts = new Set<string>();
  for (const p of chunkResults) {
    const b = attrValue(p.attributes, "BRAND");
    const m = attrValue(p.attributes, "MODEL");
    const y = attrValue(p.attributes, "VEHICLE_YEAR");
    if (b.id) brandIdsInProducts.add(b.id);
    if (m.id) modelIdsInProducts.add(m.id);
    log(
      `    ${p.id}: BRAND=${b.name}(${b.id}) MODEL=${m.name}(${m.id}) VEHICLE_YEAR=${JSON.stringify(y.name)}`,
    );
  }

  log("");
  log("### COMPARAÇÃO DE value_id PARA BRAND ###");
  log(`    catalog_domains : ${brandFromDomain?.id ?? "(ausente)"}`);
  log(`    top_values      : ${brandFromTop?.id ?? "(ausente)"}`);
  log(`    dentro dos produtos: ${JSON.stringify(Array.from(brandIdsInProducts))}`);

  const idsMatch = (a: string | null | undefined, set: Set<string>): string => {
    if (!a) return "N/A";
    return set.has(a) ? "BATE" : "NÃO BATE";
  };
  log("");
  log(
    `    catalog_domains vs produtos: ${idsMatch(brandFromDomain?.id, brandIdsInProducts)}`,
  );
  log(
    `    top_values      vs produtos: ${idsMatch(brandFromTop?.id, brandIdsInProducts)}`,
  );
  if (brandFromDomain?.id && brandFromTop?.id) {
    log(
      `    catalog_domains vs top_values: ${brandFromDomain.id === brandFromTop.id ? "MESMO ID" : "IDS DIFERENTES"}`,
    );
  }
  log("");
  log(
    ">>> CONCLUSÃO: se 'top_values vs produtos' der NÃO BATE, o filtro por igualdade de",
  );
  log(
    ">>> value_id em resolveCompatibilityCatalogProducts descarta 100% dos produtos quando",
  );
  log(">>> a marca veio de top_values. É a causa do '0 of 1500 matched brand+model'.");

  // ---------------------------------------------------------------------
  // 7. Atributos da categoria — alimenta o Bloco B (lado/posição)
  // ---------------------------------------------------------------------
  section("7. GET /categories/{id}/attributes — lado/posição");
  if (categoryId) {
    const catResp = await probeGet(
      "category-attrs",
      `${ML_CONSTANTS.API_URL}/categories/${categoryId}/attributes`,
      token,
    );
    const catAttrs = (catResp.data as Array<{
      id?: string;
      name?: string;
      value_type?: string;
      tags?: Record<string, unknown>;
      values?: Array<{ id?: string; name?: string }>;
    }>) ?? [];
    const SIDE_IDS = [
      "POSITION",
      "SIDE",
      "VEHICLE_SIDE",
      "MOUNTING_POSITION",
      "PART_POSITION",
    ];
    log("");
    log(`>>> total de atributos da categoria ${categoryId}: ${catAttrs.length}`);
    const sideAttrs = catAttrs.filter(
      (a) =>
        SIDE_IDS.includes(a?.id ?? "") ||
        /posi[cç][aã]o|lado/i.test(a?.name ?? ""),
    );
    if (sideAttrs.length === 0) {
      log(">>> NENHUM atributo de lado/posição nesta categoria.");
      log(
        ">>> Se o painel do ML mesmo assim pede o lado, ele é atributo POR VEÍCULO (compat), não do item.",
      );
    }
    for (const a of sideAttrs) {
      log("");
      log(`    id=${a.id} name=${a.name} value_type=${a.value_type}`);
      log(`    tags=${JSON.stringify(a.tags ?? {})}`);
      log(`    values=${JSON.stringify(a.values ?? [])}`);
    }
  } else {
    log("");
    log("    (pulado — não conseguimos o category_id do item)");
  }

  // ---------------------------------------------------------------------
  // Resumo final
  // ---------------------------------------------------------------------
  section("RESUMO");
  const compatDb = await prisma.productCompatibility.count({
    where: { product: { listings: { some: { externalListingId: itemIdArg } } } },
  });
  log(`item                         : ${itemIdArg}`);
  log(`user_product_id              : ${userProductId ?? "(nenhum)"}`);
  log(`category_id                  : ${categoryId ?? "(desconhecido)"}`);
  log(`compat no NOSSO banco        : ${compatDb} linha(s)`);
  log(
    `GET /items/../compatibilities : status ${readItem.status ?? "erro de rede"}`,
  );
  log(
    `GET /user-products/../compat  : ${readUp ? `status ${readUp.status ?? "erro de rede"}` : "(não aplicável)"}`,
  );
  log(`catalog_domains BRAND        : ${domainBrands.length} marcas`);
  log(`top_values BRAND             : ${brandTopRaw.length} marcas`);
  log(`top_values MODEL (${probeBrand}) : ${modelTopRaw.length} modelos`);
  log(
    `espaço de IDs (top_values)   : ${idsMatch(brandFromTop?.id, brandIdsInProducts)}`,
  );
  log("");
  log("Cole esta saída inteira na conversa. Nenhuma escrita foi feita no ML.");

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[probe] erro fatal:", err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});
