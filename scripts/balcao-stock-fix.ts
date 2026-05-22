/**
 * balcao-stock-fix.ts
 *
 * Detecta produtos vendidos "no balcão" (offline) cujo estoque local ainda
 * está > 0 mas todos os anúncios ML estão inativos (paused/closed/etc.).
 *
 * Lógica do negócio (declarada pelo usuário): muitas vendas são feitas no
 * balcão; o usuário inativa o anúncio no ML, mas a venda não passa pela API
 * do ML — então o estoque local fica errado.
 *
 * Critério CONSERVADOR para detectar candidato:
 *   1. Product.stock > 0
 *   2. Tem pelo menos 1 ProductListing ML **dentro do escopo de conta** (--ml-account
 *      restringe; sem flag = todas contas ML ACTIVE do user)
 *   3. NÃO tem nenhuma ProductListing Shopee com status "active" no DB
 *      (se tem Shopee ativa, pode estar vendendo lá — não mexe; Shopee não respeita
 *      o filtro --ml-account, sempre considera todas)
 *   4. TODAS as ProductListings ML **dentro do escopo** têm `status` REAL (via API ML)
 *      em paused/closed/inactive/deleted (qualquer não-active, não-under_review,
 *      não-payment_required)
 *
 * Por que --ml-account: quando uma conta ML está em "modo feiras" (todos os anúncios
 * paused manualmente, sem ser por venda balcão), restringir a análise à conta normal
 * evita falsos positivos. Ex.: --ml-account=JOTABÊ ignora completamente a conta
 * JOTABEDESMONTE durante a inferência.
 *
 * Por que --status-source=all: quando o DB tem ProductListings com marketplaceAccountId
 * apontando pra uma conta mas o MLB de fato pertence a outra (problema de atribuição
 * na importação inicial), o lookup de status fica "unknown" se buscarmos só da conta
 * do escopo. Com --status-source=all, busca status de TODAS as contas ML ACTIVE — o MLB
 * resolve de onde quer que ele esteja realmente listado. A decisão de candidatura
 * continua restrita ao --ml-account.
 *
 * Por que --scope-by=physical: o --ml-account filtra por TAG do DB (marketplaceAccountId).
 * Como essa tag pode estar errada (anúncio físico na DESMONTE mas tagueado JOTABÊ), um
 * anúncio em "modo feiras" (paused) da DESMONTE pode vazar pra decisão JOTABÊ pela tag
 * errada. Com --scope-by=physical, o escopo usa a conta REAL retornada pela API (requer
 * --status-source=all pra ter os dados). Assim qualquer anúncio fisicamente na DESMONTE
 * sai da decisão, independente da tag. É o critério mais correto.
 *
 * Por que --feiras-account (RECOMENDADO): em vez de descartar a conta de feiras inteira
 * (--scope-by=physical descarta closed/active dela também), descarta SÓ os anúncios
 * `paused` fisicamente nessa conta — que é o único status ambíguo do modo feiras. Mantém:
 *   - closed (em qualquer conta) = vendido → conta como inativo (sinal de balcão)
 *   - active/under_review (qualquer conta) = ainda à venda → bloqueia o decremento
 *   - paused na conta de feiras = ignorado (nem ativo, nem inativo)
 * Produto cujas únicas listings eram feiras-paused é pulado (skippedAllFeirasPaused).
 * Busca status de todas as contas automaticamente. Ex.: --feiras-account=JOTABEDESMONTE
 *
 * Por que --require-closed: `paused` é sinal mais fraco que `closed` (pode ser pausa
 * manual com a peça ainda em estoque, ou ML auto-pausando em qty 0). Com --require-closed,
 * só vira candidato quem tem pelo menos um anúncio `closed`/`inactive`/`deleted` (encerramento
 * definitivo). Candidatos que dependem só de `paused` são segurados (skippedPausedOnly) pra
 * revisão manual. É a opção mais conservadora.
 *
 * Ação (--apply):
 *   - prisma.product.update stock=0
 *   - prisma.stockLog.create reason="Venda balcão (inferida) ..."
 *   - StockSyncJob upsert p/ cada listing (TODAS as listings do produto, não só as do
 *     escopo — o decremento físico se propaga pra todos os marketplaces)
 *
 * Default = DRY-RUN. --apply para gravar.
 *
 * Uso:
 *   npx tsx scripts/balcao-stock-fix.ts                                              # dry-run, todas ML
 *   npx tsx scripts/balcao-stock-fix.ts --ml-account=JOTABÊ                          # decisão só JOTABÊ
 *   npx tsx scripts/balcao-stock-fix.ts --ml-account=JOTABÊ --status-source=all      # decisão JOTABÊ, status de todas
 *   npx tsx scripts/balcao-stock-fix.ts --user-id=<id>
 *   npx tsx scripts/balcao-stock-fix.ts --feiras-account=JOTABEDESMONTE              # regra modo-feiras
 *   npx tsx scripts/balcao-stock-fix.ts --feiras-account=JOTABEDESMONTE --require-closed  # + só sinal forte
 *   npx tsx scripts/balcao-stock-fix.ts --apply                                       # APLICA
 *   npx tsx scripts/balcao-stock-fix.ts --apply --feiras-account=JOTABEDESMONTE --require-closed
 *   npx tsx scripts/balcao-stock-fix.ts --apply --limit=10                            # só 10 (teste)
 */
import "dotenv/config";
import path from "path";
import fs from "fs";
import { Platform } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";

const DEFAULT_USER = "cmn5yc4rn0000vsasmwv9m8nc";
const OUT_DIR = path.resolve(__dirname, "out");
const ML_INACTIVE_STATUSES = new Set([
  "paused",
  "closed",
  "inactive",
  "deleted",
]);
const ML_ACTIVE_STATUSES = new Set(["active", "under_review", "payment_required"]);

/** Detecta erro de auth ML (401/403 ou mensagem de token inválido). */
function isMlAuthError(error: unknown): boolean {
  const status =
    (error as any)?.status ?? (error as any)?.response?.status ?? null;
  if (status === 401 || status === 403) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /unauthorized|invalid access token|token expired|forbidden/i.test(msg);
}

/**
 * Lista os MLBs do vendedor com REFRESH automático do token em caso de 401.
 * Mesmo padrão do `getRecentMLOrdersWithRefresh` do sync loop: tenta; se der
 * erro de auth e houver refreshToken, renova via MLOAuthService, persiste com
 * MarketplaceRepository.updateTokens e tenta de novo. Retorna os ids E o token
 * que funcionou (pra reusar no getItemsDetails subsequente).
 */
async function listSellerItemsWithRefresh(acc: {
  id: string;
  accessToken: string;
  refreshToken: string | null;
  externalUserId: string;
  accountName: string;
}): Promise<{ ids: string[]; accessToken: string }> {
  try {
    const ids = await MLApiService.getSellerItemIds(
      acc.accessToken,
      acc.externalUserId,
    );
    return { ids, accessToken: acc.accessToken };
  } catch (err) {
    if (!isMlAuthError(err) || !acc.refreshToken) throw err;
    console.log(
      `[balcao] token de ${acc.accountName} expirado (401) — renovando via OAuth refresh…`,
    );
    const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
      acc.id,
      acc.refreshToken,
    );
    await MarketplaceRepository.updateTokens(acc.id, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
    });
    console.log(`[balcao] ✓ token de ${acc.accountName} renovado e persistido.`);
    const ids = await MLApiService.getSellerItemIds(
      refreshed.accessToken,
      acc.externalUserId,
    );
    return { ids, accessToken: refreshed.accessToken };
  }
}

function parseFlags() {
  const argv = process.argv.slice(2);
  const get = (n: string) => {
    const f = `--${n}=`;
    const x = argv.find((a) => a.startsWith(f));
    return x ? x.slice(f.length) : undefined;
  };
  const limitRaw = get("limit");
  const statusSourceRaw = get("status-source");
  const statusSource: "scope" | "all" =
    statusSourceRaw === "all" ? "all" : "scope";
  const scopeByRaw = get("scope-by");
  const scopeBy: "db-tag" | "physical" =
    scopeByRaw === "physical" ? "physical" : "db-tag";
  return {
    userId: get("user-id") ?? DEFAULT_USER,
    apply: argv.includes("--apply"),
    limit: limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null,
    mlAccount: get("ml-account"), // restringe escopo de DECISÃO (accountName ou id)
    statusSource, // "scope" (default) ou "all" — define de quais contas buscar status via API
    scopeBy, // "db-tag" (default) ou "physical" — usa conta REAL da API (não a tag do DB)
    feirasAccount: get("feiras-account"), // conta em modo feiras: ignora SÓ seus anúncios paused
    requireClosed: argv.includes("--require-closed"), // só candidatos com >=1 closed/inactive/deleted
  };
}

async function main(): Promise<void> {
  const flags = parseFlags();
  const isDry = !flags.apply;
  console.log(
    `[balcao] userId=${flags.userId} apply=${flags.apply}${flags.mlAccount ? ` ml-account=${flags.mlAccount}` : ""} ${isDry ? "(DRY-RUN, nada gravado)" : "(VAI GRAVAR)"}`,
  );

  // 1) Contas ML ACTIVE (filtradas por --ml-account se fornecido)
  const mlAccts = await prisma.marketplaceAccount.findMany({
    where: {
      userId: flags.userId,
      status: "ACTIVE",
      platform: Platform.MERCADO_LIVRE,
      ...(flags.mlAccount
        ? {
            OR: [
              { accountName: flags.mlAccount },
              { id: flags.mlAccount },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      accessToken: true,
      refreshToken: true,
      externalUserId: true,
      accountName: true,
    },
  });
  console.log(`[balcao] contas ML ACTIVE no escopo: ${mlAccts.length}`);
  if (flags.mlAccount && mlAccts.length === 0) {
    console.warn(
      `[balcao] nenhuma conta ML ACTIVE bate com "${flags.mlAccount}" (accountName ou id). Aborto.`,
    );
    await prisma.$disconnect();
    return;
  }
  if (mlAccts.length === 0) {
    console.log("[balcao] nada a fazer.");
    await prisma.$disconnect();
    return;
  }
  const scopeAccountNames = new Set(mlAccts.map((a) => a.accountName));
  console.log(
    `[balcao] escopo de decisão: ${Array.from(scopeAccountNames).join(", ")}`,
  );

  // 1.5) Contas de RESOLUÇÃO DE STATUS (de quais contas buscar status via API).
  // Se --status-source=all OU --feiras-account, busca de todas as contas ML ACTIVE
  // do user (resolve ProductListing com marketplaceAccountId errado no DB E permite
  // saber a conta física pra aplicar a regra de feiras). Default = scope.
  let statusFetchAccounts = mlAccts;
  const needAllAccounts = flags.statusSource === "all" || !!flags.feirasAccount;
  if (needAllAccounts) {
    statusFetchAccounts = await prisma.marketplaceAccount.findMany({
      where: {
        userId: flags.userId,
        status: "ACTIVE",
        platform: Platform.MERCADO_LIVRE,
      },
      select: {
        id: true,
        accessToken: true,
        refreshToken: true,
        externalUserId: true,
        accountName: true,
      },
    });
    console.log(
      `[balcao] ${flags.feirasAccount ? "feiras-account" : "status-source=all"} → buscando status de ${statusFetchAccounts.length} conta(s) ML: ${statusFetchAccounts.map((a) => a.accountName).join(", ")}`,
    );
  } else {
    console.log(
      `[balcao] status-source=scope → status só das contas no escopo`,
    );
  }

  // 1.6) Resolve o accountName da conta de feiras (aceita accountName ou id).
  let feirasAccountName: string | null = null;
  if (flags.feirasAccount) {
    const match = statusFetchAccounts.find(
      (a) => a.accountName === flags.feirasAccount || a.id === flags.feirasAccount,
    );
    if (!match) {
      console.warn(
        `[balcao] --feiras-account="${flags.feirasAccount}" não bate com nenhuma conta ML ACTIVE. Aborto.`,
      );
      await prisma.$disconnect();
      return;
    }
    feirasAccountName = match.accountName;
    console.log(
      `[balcao] MODO FEIRAS: anúncios paused fisicamente na conta "${feirasAccountName}" serão IGNORADOS na decisão (nem ativo, nem inativo).`,
    );
  }

  // 2) Para cada conta de fetch, busca todos MLBs + status real via API
  // map: mlb -> { status, accountId, accountName }
  const mlbStatus = new Map<
    string,
    { status: string; accountId: string; accountName: string }
  >();
  for (const acc of statusFetchAccounts) {
    if (!acc.accessToken || !acc.externalUserId) {
      console.warn(`[balcao] conta ${acc.accountName} sem credenciais — pulada`);
      continue;
    }
    console.log(
      `\n[balcao] >> ${acc.accountName}: listando MLBs do vendedor…`,
    );
    let itemIds: string[] = [];
    let workingToken = acc.accessToken; // pode mudar se houve refresh
    try {
      const r = await listSellerItemsWithRefresh(acc);
      itemIds = r.ids;
      workingToken = r.accessToken;
    } catch (err) {
      console.error(
        `[balcao] erro listando MLBs de ${acc.accountName}: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }
    console.log(`[balcao]    encontrou ${itemIds.length} MLBs`);

    if (itemIds.length === 0) continue;
    console.log(
      `[balcao] >> ${acc.accountName}: buscando status REAL de ${itemIds.length} anúncios via API…`,
    );
    try {
      const details = await MLApiService.getItemsDetails(
        workingToken,
        itemIds,
      );
      console.log(`[balcao]    detalhes recebidos: ${details.length}`);
      for (const d of details) {
        mlbStatus.set(d.id, {
          status: d.status,
          accountId: acc.id,
          accountName: acc.accountName,
        });
      }
    } catch (err) {
      console.error(
        `[balcao] erro buscando detalhes de ${acc.accountName}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  console.log(`\n[balcao] total MLBs com status real: ${mlbStatus.size}`);

  // Distribuição de status
  const statusDist = new Map<string, number>();
  for (const v of mlbStatus.values()) {
    statusDist.set(v.status, (statusDist.get(v.status) ?? 0) + 1);
  }
  console.log(`[balcao] distribuição de status real ML:`);
  for (const [s, c] of Array.from(statusDist.entries()).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${s.padEnd(20)} ${c}`);
  }

  // 3) Products do user com stock > 0 e suas listings.
  // Carregamento EM LOTES por cursor (id) — uma findMany única com ~20k produtos
  // + todas as listings aninhadas estoura o statement_timeout do Supabase sob
  // carga. Lotes de 2000 mantêm cada query pequena. Retry leve por lote.
  console.log(`\n[balcao] carregando Products stock>0 (em lotes)…`);
  const productSelect = {
    id: true,
    sku: true,
    name: true,
    stock: true,
    listings: {
      select: {
        id: true,
        externalListingId: true,
        status: true,
        marketplaceAccount: {
          select: { platform: true, accountName: true },
        },
      },
    },
  } as const;
  type ProductRow = Awaited<
    ReturnType<typeof prisma.product.findMany<{ select: typeof productSelect }>>
  >[number];
  const products: ProductRow[] = [];
  const PRODUCT_CHUNK = 2000;
  let cursorId: string | undefined = undefined;
  while (true) {
    let batch: ProductRow[] | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        batch = await prisma.product.findMany({
          where: { userId: flags.userId, stock: { gt: 0 } },
          select: productSelect,
          orderBy: { id: "asc" },
          take: PRODUCT_CHUNK,
          ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
        });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[balcao] lote de produtos falhou (tentativa ${attempt}/3): ${msg.slice(0, 120)}`,
        );
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    if (!batch || batch.length === 0) break;
    products.push(...batch);
    if (batch.length % 2000 === 0)
      console.log(`[balcao]   …${products.length} produtos carregados`);
    if (batch.length < PRODUCT_CHUNK) break;
    cursorId = batch[batch.length - 1].id;
  }
  console.log(`[balcao] Products com stock>0: ${products.length}`);

  // 4) Classifica
  type Candidate = {
    productId: string;
    sku: string;
    name: string;
    stock: number;
    mlbListings: Array<{
      mlb: string;
      statusReal: string;
      account: string; // tag do DB
      physicalAccount: string | null; // conta real (API), null se status unknown
    }>;
  };
  const candidates: Candidate[] = [];
  let noListings = 0;
  let noMlListings = 0;
  let hasShopeeActive = 0;
  let hasMlActive = 0;
  let mlbStatusUnknown = 0;
  // Quantos produtos só seriam candidatos pela tag do DB mas têm a decisão
  // baseada exclusivamente em listings fisicamente fora do escopo (ex.: tag
  // JOTABÊ mas anúncio físico na DESMONTE). Só conta quando scope-by=physical.
  let excludedByPhysicalScope = 0;
  // Modo feiras: listings paused descartadas + produtos pulados porque TODAS
  // as suas listings eram feiras-paused (ambíguo, sem sinal confiável).
  let droppedFeirasPausedListings = 0;
  let skippedAllFeirasPaused = 0;
  // --require-closed: produtos que seriam candidatos mas só têm paused (sem
  // nenhum closed/inactive/deleted) — sinal mais fraco, segurados pra revisão.
  let skippedPausedOnly = 0;

  for (const p of products) {
    if (p.listings.length === 0) {
      noListings++;
      continue;
    }
    // Shopee ativa no DB? (qualquer string contendo "active" / "linked")
    const shopeeActive = p.listings.some((l) => {
      if (l.marketplaceAccount.platform !== Platform.SHOPEE) return false;
      const s = (l.status ?? "").toLowerCase();
      // tratar status DB como "ativa" se for active, linked_*, ou similar
      return (
        s === "active" ||
        s.startsWith("active") ||
        s.startsWith("linked_") ||
        s === "" // sem status declarado → conservador, considera "ativa"
      );
    });
    if (shopeeActive) {
      hasShopeeActive++;
      continue;
    }

    // Todas listings ML do produto (antes do filtro de escopo).
    const allMlListings = p.listings.filter(
      (l) => l.marketplaceAccount.platform === Platform.MERCADO_LIVRE,
    );

    // Determina a conta EFETIVA de cada listing para fins de escopo:
    //  - scope-by=physical: usa a conta REAL retornada pela API (mlbStatus);
    //    fallback pra tag do DB se status unknown.
    //  - scope-by=db-tag (default): usa a tag do DB direto.
    // Listings cuja conta efetiva não está no escopo são ignoradas na decisão.
    const effectiveAccountOf = (l: (typeof allMlListings)[number]): string => {
      if (flags.scopeBy === "physical") {
        const real = mlbStatus.get(l.externalListingId);
        return real?.accountName ?? l.marketplaceAccount.accountName;
      }
      return l.marketplaceAccount.accountName;
    };

    const mlListings = flags.mlAccount
      ? allMlListings.filter((l) => scopeAccountNames.has(effectiveAccountOf(l)))
      : allMlListings;

    if (mlListings.length === 0) {
      noMlListings++;
      // Se sem --ml-account ele nunca chega aqui (allMlListings já não-vazio).
      // Com escopo físico, pode ter sido excluído justamente por todas as
      // listings serem fisicamente de outra conta.
      if (
        flags.scopeBy === "physical" &&
        flags.mlAccount &&
        allMlListings.length > 0
      ) {
        excludedByPhysicalScope++;
      }
      continue;
    }

    // Modo feiras: descarta listings que estão `paused` E fisicamente na conta
    // de feiras. Esse status é ambíguo (pode ser só "escondido" durante a feira,
    // não vendido), então não conta nem como ativo nem como inativo. closed e
    // active na conta de feiras CONTINUAM valendo (vendido / ainda à venda).
    let effectiveListings = mlListings;
    if (feirasAccountName) {
      const before = mlListings.length;
      effectiveListings = mlListings.filter((l) => {
        const real = mlbStatus.get(l.externalListingId);
        return !(
          real?.accountName === feirasAccountName && real?.status === "paused"
        );
      });
      droppedFeirasPausedListings += before - effectiveListings.length;
      if (effectiveListings.length === 0) {
        // Todas as listings do produto eram feiras-paused → sem sinal confiável.
        skippedAllFeirasPaused++;
        continue;
      }
    }

    let anyActive = false;
    let anyUnknown = false;
    const mlbStatuses: Candidate["mlbListings"] = [];
    for (const l of effectiveListings) {
      const real = mlbStatus.get(l.externalListingId);
      if (!real) {
        anyUnknown = true;
        mlbStatuses.push({
          mlb: l.externalListingId,
          statusReal: "<unknown>",
          account: l.marketplaceAccount.accountName,
          physicalAccount: null,
        });
        continue;
      }
      mlbStatuses.push({
        mlb: l.externalListingId,
        statusReal: real.status,
        account: l.marketplaceAccount.accountName,
        physicalAccount: real.accountName,
      });
      if (ML_ACTIVE_STATUSES.has(real.status)) anyActive = true;
    }
    if (anyUnknown) {
      mlbStatusUnknown++;
      continue;
    }
    if (anyActive) {
      hasMlActive++;
      continue;
    }
    // --require-closed: exige pelo menos um sinal definitivo de encerramento
    // (closed/inactive/deleted). Candidatos que só têm `paused` (sinal fraco,
    // pode ser pausa manual com peça ainda em estoque) são segurados.
    if (flags.requireClosed) {
      const hasDefinitiveEnd = mlbStatuses.some(
        (m) =>
          m.statusReal === "closed" ||
          m.statusReal === "inactive" ||
          m.statusReal === "deleted",
      );
      if (!hasDefinitiveEnd) {
        skippedPausedOnly++;
        continue;
      }
    }
    // Todos inativos + sem Shopee ativa → candidato
    candidates.push({
      productId: p.id,
      sku: p.sku,
      name: p.name,
      stock: p.stock,
      mlbListings: mlbStatuses,
    });
  }

  console.log(`\n========== ANÁLISE BALCÃO ==========`);
  if (flags.mlAccount) {
    console.log(
      `Escopo de decisão ML: ${Array.from(scopeAccountNames).join(", ")}`,
    );
  }
  console.log(
    `Fonte de status: ${statusFetchAccounts.length} conta(s) — ${statusFetchAccounts.map((a) => a.accountName).join(", ")}`,
  );
  console.log(`Critério de escopo: ${flags.scopeBy}`);
  if (feirasAccountName) {
    console.log(`Modo feiras: ignorando paused fisicamente em "${feirasAccountName}"`);
  }
  console.log(
    `Products com stock>0:                       ${products.length}`,
  );
  console.log(
    `  sem nenhuma listing:                      ${noListings}`,
  );
  console.log(
    `  sem ML dentro do escopo:                  ${noMlListings}`,
  );
  if (flags.scopeBy === "physical" && flags.mlAccount) {
    console.log(
      `    └─ excluídos por escopo FÍSICO:        ${excludedByPhysicalScope} (tag DB no escopo, mas anúncio físico fora)`,
    );
  }
  console.log(
    `  com Shopee ACTIVE no DB:                  ${hasShopeeActive}`,
  );
  console.log(
    `  com ML ativo (status real via API):       ${hasMlActive}`,
  );
  if (feirasAccountName) {
    console.log(
      `  pulados (só tinham feiras-paused):        ${skippedAllFeirasPaused}`,
    );
  }
  if (flags.requireClosed) {
    console.log(
      `  pulados (--require-closed, só paused):    ${skippedPausedOnly}`,
    );
  }
  console.log(
    `  com MLB sem status real (skipped):        ${mlbStatusUnknown}`,
  );
  console.log(
    `  *** candidatos venda balcão:              ${candidates.length}`,
  );
  if (feirasAccountName) {
    console.log(
      `  (listings feiras-paused descartadas:      ${droppedFeirasPausedListings})`,
    );
  }
  console.log(`========================================\n`);

  if (candidates.length > 0) {
    console.log(`Amostra (top 20):`);
    for (const c of candidates.slice(0, 20)) {
      console.log(
        `  sku=${c.sku.padEnd(12)} stock=${c.stock} "${c.name.slice(0, 60)}"`,
      );
      for (const l of c.mlbListings) {
        const physNote =
          l.physicalAccount && l.physicalAccount !== l.account
            ? ` [tag=${l.account}, físico=${l.physicalAccount}]`
            : ` (${l.account})`;
        console.log(`    ${l.mlb} status=${l.statusReal}${physNote}`);
      }
    }
    if (candidates.length > 20)
      console.log(`  … (+${candidates.length - 20} mais)`);
  }

  // Salva relatório
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(
    OUT_DIR,
    `balcao-${isDry ? "dryrun" : "apply"}-${ts}.json`,
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        userId: flags.userId,
        dryRun: isDry,
        mlAccountFilter: flags.mlAccount ?? null,
        mlScopeAccountNames: Array.from(scopeAccountNames),
        statusSource: flags.statusSource,
        statusFetchAccountNames: statusFetchAccounts.map((a) => a.accountName),
        scopeBy: flags.scopeBy,
        feirasAccount: feirasAccountName,
        requireClosed: flags.requireClosed,
        statusDistribution: Object.fromEntries(statusDist),
        counts: {
          productsStockGt0: products.length,
          noListings,
          noMlListings,
          excludedByPhysicalScope,
          hasShopeeActive,
          hasMlActive,
          skippedAllFeirasPaused,
          droppedFeirasPausedListings,
          skippedPausedOnly,
          mlbStatusUnknown,
          candidates: candidates.length,
        },
        candidates,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`[report] ${outPath}`);

  if (isDry) {
    const args: string[] = ["--apply"];
    if (flags.mlAccount) args.push(`--ml-account=${flags.mlAccount}`);
    if (flags.statusSource === "all") args.push(`--status-source=all`);
    if (flags.scopeBy === "physical") args.push(`--scope-by=physical`);
    if (flags.feirasAccount) args.push(`--feiras-account=${flags.feirasAccount}`);
    if (flags.requireClosed) args.push(`--require-closed`);
    if (flags.limit !== null) args.push(`--limit=${flags.limit}`);
    console.log(
      `\n[balcao] DRY-RUN. Para aplicar:\n  npx tsx scripts/balcao-stock-fix.ts ${args.join(" ")}`,
    );
    await prisma.$disconnect();
    return;
  }

  // 5) Apply
  const targets = flags.limit !== null ? candidates.slice(0, flags.limit) : candidates;
  console.log(
    `\n[balcao] APLICANDO decremento em ${targets.length}${flags.limit !== null ? ` (limitado por --limit)` : ""}…`,
  );
  let applied = 0;
  let failed = 0;
  const REASON =
    "Venda balcão (inferida) — anúncios ML inativos sem canal de venda ativo";

  for (const c of targets) {
    try {
      await prisma.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<
            { id: string; stock: number }[]
          >`SELECT id, stock FROM "Product" WHERE id = ${c.productId} FOR UPDATE`;
          const cur = locked[0];
          if (!cur || cur.stock <= 0) return;
          const previous = cur.stock;
          await tx.product.update({
            where: { id: c.productId },
            data: { stock: 0 },
          });
          await tx.stockLog.create({
            data: {
              productId: c.productId,
              change: -previous,
              reason: REASON,
              previousStock: previous,
              newStock: 0,
            },
          });
          // Sync job pra cada listing
          const listings = await tx.productListing.findMany({
            where: { productId: c.productId },
            include: { marketplaceAccount: { select: { platform: true } } },
          });
          for (const listing of listings) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock_sync_job:" + listing.id}))`;
            await tx.stockSyncJob.upsert({
              where: {
                listingId_status: {
                  listingId: listing.id,
                  status: "PENDING",
                },
              },
              create: {
                productId: c.productId,
                listingId: listing.id,
                platform: listing.marketplaceAccount.platform,
                targetStock: 0,
                status: "PENDING",
              },
              update: {
                targetStock: 0,
                attempts: 0,
                nextRunAt: new Date(),
                lastError: null,
              },
            });
          }
        },
        { timeout: 60_000, maxWait: 20_000 },
      );
      applied++;
      console.log(
        `  [stock] sku=${c.sku} ${c.stock} → 0  "${c.name.slice(0, 50)}"`,
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(
        `  [stock][FAIL] sku=${c.sku}: ${m.slice(0, 160)}`,
      );
      failed++;
    }
  }

  console.log(`\n========== RESUMO BALCÃO ==========`);
  console.log(`Candidatos analisados:    ${targets.length}`);
  console.log(`Aplicados com sucesso:    ${applied}`);
  console.log(`Falhas:                   ${failed}`);
  console.log(`====================================`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});
