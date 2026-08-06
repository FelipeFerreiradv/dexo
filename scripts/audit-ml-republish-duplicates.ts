// PRIMEIRA linha de propósito: carrega o .env antes de o import do prisma ser
// avaliado. Ver o comentário em scripts/lib/load-env.ts.
import "./lib/load-env";

import fs from "node:fs";
import path from "node:path";

import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";

/**
 * Auditoria e limpeza dos anúncios duplicados pela republicação de item User
 * Product do Mercado Livre.
 *
 * O bug (corrigido em PR separado): toda edição de produto com anúncio UP
 * criava um anúncio novo e fechava o antigo SEM zerar o estoque. O painel do
 * ML soma a quantidade dos itens da família — inclusive dos fechados — então o
 * vendedor passava a ver o dobro de unidades. Quando a republicação morria no
 * meio, a linha ficava presa num placeholder `PENDING_REPUBLISH_*` e o anúncio
 * antigo virava órfão: vivo no ML, sem nenhuma linha no Dexo.
 *
 * O que faz por padrão: SÓ LÊ. SELECTs no banco e GETs na API do ML.
 * O que só faz com `--apply` + sub-ação: zera o estoque e fecha os órfãos, e
 * reconcilia as linhas presas em placeholder.
 *
 * Uso (SEMPRE via tsx direto — ver aviso abaixo):
 *
 *   # relatório de um tenant, só os placeholders presos
 *   .\node_modules\.bin\tsx.cmd scripts\audit-ml-republish-duplicates.ts \
 *     --email=cliente@exemplo.com
 *
 *   # + varredura no ML por SKU (acha o órfão que NÃO tem placeholder)
 *   .\node_modules\.bin\tsx.cmd scripts\audit-ml-republish-duplicates.ts \
 *     --email=cliente@exemplo.com --deep-scan
 *
 *   # aplicar (exige tenant E sub-ação explícita)
 *   .\node_modules\.bin\tsx.cmd scripts\audit-ml-republish-duplicates.ts \
 *     --user-id=<dataOwnerId> --deep-scan --apply --close-orphans --max-writes=20
 *
 * ⚠️ NUNCA chame por `npm run`: o npm engole as flags (inclusive o `--apply`) e
 *    o script roda em dry-run silencioso — ou pior, roda sem o filtro de tenant.
 *
 * ⚠️ Token: por padrão o script NÃO renova nada. `refreshAccessTokenForAccount`
 *    grava `status: "ERROR"` na conta do cliente quando o refresh falha, e o ML
 *    ROTACIONA o refresh_token a cada uso — um script rodando ao lado do
 *    servidor é exatamente a corrida que o mutex interno dele não cobre.
 *    Derrubar a integração de um cliente pagante numa auditoria é inaceitável:
 *    conta com token vencido é PULADA. Com `--allow-token-refresh` usamos o
 *    método CRU (`refreshAccessToken`), que não escreve no banco, e
 *    persistimos o par novo na hora — nunca tocando em `status`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Flags
// ─────────────────────────────────────────────────────────────────────────────

interface Flags {
  userId: string | null;
  email: string | null;
  sku: string | null;
  deepScan: boolean;
  apply: boolean;
  closeOrphans: boolean;
  fixPlaceholders: boolean;
  allowTokenRefresh: boolean;
  maxWrites: number;
  concurrency: number;
  delayMs: number;
  csv: string | null;
}

function parseFlags(argv: string[]): Flags {
  const valor = (nome: string): string | null => {
    const prefixo = `--${nome}=`;
    const achado = argv.find((a) => a.startsWith(prefixo));
    if (achado) return achado.slice(prefixo.length);
    // Aceita também `--nome valor`, o outro estilo em uso nos scripts da casa.
    const i = argv.indexOf(`--${nome}`);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      return argv[i + 1];
    }
    return null;
  };
  const tem = (nome: string): boolean =>
    argv.includes(`--${nome}`) || argv.some((a) => a.startsWith(`--${nome}=`));

  const num = (nome: string, padrao: number): number => {
    const v = valor(nome);
    return v && /^\d+$/.test(v) ? parseInt(v, 10) : padrao;
  };

  return {
    userId: valor("user-id"),
    email: valor("email"),
    sku: valor("sku"),
    deepScan: tem("deep-scan"),
    // Mesma regra do resto da casa: --dry-run VENCE --apply.
    apply: tem("apply") && !tem("dry-run"),
    closeOrphans: tem("close-orphans"),
    fixPlaceholders: tem("fix-placeholders"),
    allowTokenRefresh: tem("allow-token-refresh"),
    maxWrites: num("max-writes", 50),
    concurrency: num("concurrency", 4),
    delayMs: num("delay-ms", 150),
    csv: valor("csv"),
  };
}

/**
 * Aborta se o banco não for o de produção em São Paulo. Um `.env` de worktree
 * pode apontar para outra região e o script escreveria no lugar errado sem
 * nenhum aviso.
 */
function assertBanco(): void {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^:/?]+)/)?.[1] ?? "(não identificado)";
  if (!host.includes("sa-east-1")) {
    console.error(
      `[abortado] DATABASE_URL aponta para "${host}", que não é o banco de produção (sa-east-1).`,
    );
    process.exit(1);
  }
  console.log(`[banco] ${host}`);
}

/** `--apply` só roda com escopo de tenant E uma sub-ação nomeada. */
function assertEscopo(f: Flags): void {
  if (!f.apply) return;
  if (!f.userId && !f.email) {
    console.error(
      "[abortado] --apply exige --user-id ou --email. Nao existe apply global.",
    );
    process.exit(1);
  }
  if (!f.closeOrphans && !f.fixPlaceholders) {
    console.error(
      "[abortado] --apply exige uma sub-acao: --close-orphans e/ou --fix-placeholders.",
    );
    process.exit(1);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

type Veredito =
  | "VIVO_RECOMENDADO"
  | "ORFAO_FECHAR"
  | "PLACEHOLDER_PRESO"
  | "AMBIGUO"
  | "OK";

interface Conta {
  id: string;
  accountName: string;
  externalUserId: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  userId: string;
}

interface LinhaPlaceholder {
  userId: string;
  email: string | null;
  accountId: string;
  accountName: string;
  listingId: string;
  placeholder: string;
  oldMlb: string;
  status: string;
  updatedAt: Date;
  productId: string;
  sku: string;
  productName: string;
  oldTemLinha: number;
}

interface ItemMl {
  id: string;
  status: string;
  available_quantity: number | null;
  price: number | null;
  title: string | null;
  family_name: string | null;
  user_product_id: string | null;
  seller_custom_field: string | null;
  date_created: string | null;
}

interface LinhaSaida {
  dataOwnerId: string;
  email: string;
  accountId: string;
  accountName: string;
  groupKey: string;
  productId: string;
  sku: string;
  productName: string;
  estoqueLocal: string;
  precoLocal: string;
  externalListingId: string;
  mlStatus: string;
  mlAvailableQty: string;
  mlPrice: string;
  mlUserProductId: string;
  temLinhaDb: string;
  dbListingId: string;
  veredito: Veredito;
  acaoSugerida: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tenant e token
// ─────────────────────────────────────────────────────────────────────────────

async function resolverTenant(
  f: Flags,
): Promise<{ userId: string; email: string } | null> {
  if (!f.userId && !f.email) return null;
  const u = await prisma.user.findFirst({
    where: f.email ? { email: f.email } : { id: f.userId as string },
    select: { id: true, email: true, parentUserId: true },
  });
  if (!u) {
    console.error(`[abortado] tenant nao encontrado: ${f.email ?? f.userId}`);
    process.exit(1);
  }
  // Colaborador herda os dados do admin — o dono é sempre o parent.
  const ownerId = u.parentUserId ?? u.id;
  if (ownerId !== u.id) {
    const dono = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { email: true },
    });
    return { userId: ownerId, email: dono?.email ?? "(sem email)" };
  }
  return { userId: u.id, email: u.email ?? "(sem email)" };
}

/**
 * Devolve um token utilizável ou `null`. Nunca marca a conta como ERROR.
 */
async function obterToken(conta: Conta, f: Flags): Promise<string | null> {
  const folga = 60_000;
  if (conta.expiresAt.getTime() > Date.now() + folga) return conta.accessToken;

  if (!f.allowTokenRefresh || !conta.refreshToken) {
    console.warn(
      `  [pulado] conta ${conta.accountName}: token vencido. Abra a tela de anuncios do cliente (o app renova sozinho) e rode de novo, ou use --allow-token-refresh.`,
    );
    return null;
  }

  try {
    // Método CRU: não escreve no banco e não mexe em `status`.
    const novo = await MLOAuthService.refreshAccessToken(conta.refreshToken);
    // Persistir IMEDIATAMENTE: o ML rotaciona o refresh_token, e perder o novo
    // faria o próximo refresh do app tomar invalid_grant — aí sim a conta
    // seria marcada ERROR, pelo app.
    await prisma.marketplaceAccount.update({
      where: { id: conta.id },
      data: {
        accessToken: novo.accessToken,
        refreshToken: novo.refreshToken,
        expiresAt: new Date(Date.now() + novo.expiresIn * 1000),
      },
    });
    return novo.accessToken;
  } catch (err) {
    console.warn(
      `  [pulado] conta ${conta.accountName}: refresh falhou (${err instanceof Error ? err.message : String(err)}). Nada foi alterado na conta.`,
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Detecção
// ─────────────────────────────────────────────────────────────────────────────

/** Passo 1: linhas presas em placeholder de republicação. SQL puro. */
async function acharPlaceholdersPresos(
  userId: string | null,
): Promise<LinhaPlaceholder[]> {
  return prisma.$queryRawUnsafe<LinhaPlaceholder[]>(
    `SELECT p."userId", u.email, ma.id AS "accountId", ma."accountName",
            pl.id AS "listingId", pl."externalListingId" AS placeholder,
            split_part(pl."externalListingId", '_', 3) AS "oldMlb",
            pl.status, pl."updatedAt",
            p.id AS "productId", p.sku, p.name AS "productName",
            (SELECT count(*)::int FROM "ProductListing" x
              WHERE x."marketplaceAccountId" = pl."marketplaceAccountId"
                AND x."externalListingId" = split_part(pl."externalListingId", '_', 3)
            ) AS "oldTemLinha"
     FROM "ProductListing" pl
     JOIN "Product" p ON p.id = pl."productId"
     JOIN "MarketplaceAccount" ma ON ma.id = pl."marketplaceAccountId"
     LEFT JOIN "User" u ON u.id = p."userId"
     WHERE pl."externalListingId" LIKE 'PENDING\\_REPUBLISH\\_%'
       AND ($1::text IS NULL OR p."userId" = $1::text)
     ORDER BY pl."updatedAt" DESC`,
    userId,
  );
}

/**
 * Passo 3 (--deep-scan): os dois anúncios do mesmo SKU na mesma conta.
 *
 * É o único caminho que acha o caso mais comum — aquele em que a republicação
 * deu certo (fechou o antigo, criou o novo) e só ficou o estoque somando. Esse
 * NÃO tem placeholder e o MLB antigo não tem linha nenhuma, então é invisível
 * a qualquer SELECT.
 */
async function buscarItensPorSku(
  token: string,
  sellerId: string,
  sku: string,
): Promise<string[]> {
  const url = `https://api.mercadolibre.com/users/${sellerId}/items/search?seller_sku=${encodeURIComponent(sku)}&limit=50`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return [];
  const j = (await r.json()) as { results?: string[] };
  return (j.results ?? []).filter(Boolean);
}

async function detalharItens(
  token: string,
  ids: string[],
): Promise<Map<string, ItemMl>> {
  const out = new Map<string, ItemMl>();
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const attrs =
      "id,status,available_quantity,price,title,family_name,user_product_id,seller_custom_field,date_created";
    const r = await fetch(
      `https://api.mercadolibre.com/items?ids=${chunk.join(",")}&attributes=${attrs}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!r.ok) continue;
    const j = (await r.json()) as Array<{ body?: ItemMl } & Partial<ItemMl>>;
    for (const e of j) {
      const b = (e.body ?? e) as ItemMl;
      if (b?.id) out.set(b.id, b);
    }
  }
  return out;
}

/**
 * Classifica um grupo de itens do MESMO produto/conta.
 *
 * O "vivo" é, nesta ordem: o que a linha do banco aponta; senão o `active`;
 * senão o mais recente. Dois candidatos ativos COM linha => AMBIGUO, e
 * ambíguo nunca é tocado por --apply.
 */
function classificar(
  itens: ItemMl[],
  idsComLinha: Set<string>,
): Map<string, Veredito> {
  const vereditos = new Map<string, Veredito>();
  const vivos = itens.filter(
    (i) => i.status === "active" || i.status === "paused",
  );
  const comLinha = vivos.filter((i) => idsComLinha.has(i.id));

  let recomendado: ItemMl | null = null;
  if (comLinha.length === 1) {
    recomendado = comLinha[0];
  } else if (comLinha.length > 1) {
    for (const i of itens) vereditos.set(i.id, "AMBIGUO");
    return vereditos;
  } else if (vivos.length > 0) {
    recomendado = [...vivos].sort((a, b) =>
      String(b.date_created ?? "").localeCompare(String(a.date_created ?? "")),
    )[0];
  }

  for (const i of itens) {
    if (recomendado && i.id === recomendado.id) {
      vereditos.set(i.id, "VIVO_RECOMENDADO");
      continue;
    }
    const encerrado = i.status === "closed" || i.status === "inactive";
    const semEstoque = Number(i.available_quantity ?? 0) === 0;
    if (encerrado && semEstoque) {
      vereditos.set(i.id, "OK");
    } else {
      vereditos.set(i.id, "ORFAO_FECHAR");
    }
  }
  return vereditos;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ações (--apply)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mesma sequência do caminho de produção (SyncUseCase.closeOldUpListing):
 * zera o estoque, fecha, confere. A ordem importa — PUT em item já fechado
 * devolve `item.status.invalid`.
 */
async function fecharOrfao(
  token: string,
  itemId: string,
): Promise<{ ok: boolean; detalhe: string }> {
  try {
    await MLApiService.updateItem(token, itemId, { available_quantity: 0 });
    await MLApiService.updateItem(token, itemId, { status: "closed" });
    const depois = await MLApiService.getItemDetails(token, itemId);
    const st = String(depois?.status ?? "");
    const qty = Number(depois?.available_quantity ?? -1);
    const ok = (st === "closed" || st === "inactive") && qty === 0;
    return { ok, detalhe: `status=${st} qty=${qty}` };
  } catch (err) {
    return {
      ok: false,
      detalhe: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Saída
// ─────────────────────────────────────────────────────────────────────────────

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function escreverCsv(linhas: LinhaSaida[], destino: string): void {
  if (linhas.length === 0) return;
  const cols = Object.keys(linhas[0]) as Array<keyof LinhaSaida>;
  const corpo = [
    cols.join(","),
    ...linhas.map((l) => cols.map((c) => csvEscape(l[c])).join(",")),
  ].join("\n");
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, corpo, "utf8");
  console.log(`\n[csv] ${destino} (${linhas.length} linhas)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  assertBanco();
  assertEscopo(flags);

  const tenant = await resolverTenant(flags);
  const escopo = tenant ? `${tenant.email} [${tenant.userId}]` : "TODOS os tenants";
  console.log(
    `[modo] ${flags.apply ? "APPLY (ESCREVE)" : "READ-ONLY (nao escreve nada)"} | escopo: ${escopo}`,
  );
  if (flags.apply) {
    console.log(
      `[apply] sub-acoes: ${[
        flags.closeOrphans ? "close-orphans" : null,
        flags.fixPlaceholders ? "fix-placeholders" : null,
      ]
        .filter(Boolean)
        .join(", ")} | teto de escritas: ${flags.maxWrites}`,
    );
  }

  const saida: LinhaSaida[] = [];

  // ── Passo 1: placeholders presos ──────────────────────────────────────────
  const presos = await acharPlaceholdersPresos(tenant?.userId ?? null);
  console.log(`\n=== 1. LINHAS PRESAS EM PENDING_REPUBLISH_* — ${presos.length} ===`);
  if (presos.length === 0) {
    console.log("  (nenhuma)");
  } else {
    console.log(
      "  data       | status   | MLB antigo tem linha? | sku        | email",
    );
    for (const p of presos) {
      console.log(
        `  ${p.updatedAt.toISOString().slice(0, 10)} | ${String(p.status).padEnd(8)} | ${
          p.oldTemLinha > 0 ? "SIM (P2002/autodetect)" : "NAO (morte de processo)"
        } | ${String(p.sku).padEnd(10)} | ${p.email ?? "?"}`,
      );
      saida.push({
        dataOwnerId: p.userId,
        email: p.email ?? "",
        accountId: p.accountId,
        accountName: p.accountName,
        groupKey: `ph:${p.placeholder}`,
        productId: p.productId,
        sku: p.sku,
        productName: p.productName,
        estoqueLocal: "",
        precoLocal: "",
        externalListingId: p.oldMlb,
        mlStatus: "",
        mlAvailableQty: "",
        mlPrice: "",
        mlUserProductId: "",
        temLinhaDb: p.oldTemLinha > 0 ? "sim" : "nao",
        dbListingId: p.listingId,
        veredito: "PLACEHOLDER_PRESO",
        acaoSugerida:
          p.oldTemLinha > 0
            ? "linha duplicada: apagar o placeholder (--fix-placeholders)"
            : "reapontar a linha para o MLB antigo (--fix-placeholders)",
      });
    }
  }

  // ── Passo 2: pares com mais de uma linha (INFORMATIVO) ────────────────────
  const pares = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM (
       SELECT pl."productId" FROM "ProductListing" pl
       JOIN "Product" p ON p.id = pl."productId"
       WHERE ($1::text IS NULL OR p."userId" = $1::text)
       GROUP BY pl."productId", pl."marketplaceAccountId" HAVING count(*) > 1
     ) t`,
    tenant?.userId ?? null,
  );
  console.log(
    `\n=== 2. PARES (produto, conta) COM MAIS DE UMA LINHA — ${pares[0]?.n ?? 0} ===`,
  );
  console.log(
    "  INFORMATIVO. A maior parte vem do autodetect (uma linha por anuncio\n" +
      "  encontrado), NAO deste bug. Nunca e alvo de --apply.",
  );

  // ── Passo 3: deep-scan no ML ──────────────────────────────────────────────
  if (!flags.deepScan) {
    console.log(
      "\n=== 3. VARREDURA NO ML — pulada (use --deep-scan) ===\n" +
        "  Sem ela o relatorio NAO acha o caso mais comum: republicacao que deu\n" +
        "  certo e so deixou o anuncio antigo somando estoque. Aquele nao tem\n" +
        "  placeholder e o MLB antigo nao tem linha — e invisivel ao SQL.",
    );
  } else if (!tenant) {
    console.log("\n=== 3. VARREDURA NO ML — exige --user-id ou --email ===");
  } else {
    console.log("\n=== 3. VARREDURA NO ML (--deep-scan) ===");
    const contas = (await prisma.marketplaceAccount.findMany({
      where: { userId: tenant.userId, platform: "MERCADO_LIVRE" },
      select: {
        id: true,
        accountName: true,
        externalUserId: true,
        accessToken: true,
        refreshToken: true,
        expiresAt: true,
        userId: true,
      },
    })) as unknown as Conta[];

    let escritas = 0;

    for (const conta of contas) {
      const token = await obterToken(conta, flags);
      if (!token || !conta.externalUserId) continue;

      // Produtos com anúncio nesta conta (ou só o SKU pedido).
      const produtos = await prisma.$queryRawUnsafe<
        Array<{
          productId: string;
          sku: string;
          name: string;
          stock: number;
          price: string;
        }>
      >(
        `SELECT DISTINCT p.id AS "productId", p.sku, p.name, p.stock, p.price::text AS price
         FROM "ProductListing" pl JOIN "Product" p ON p.id = pl."productId"
         WHERE pl."marketplaceAccountId" = $1
           AND ($2::text IS NULL OR p.sku = $2::text)
         ORDER BY p.sku`,
        conta.id,
        flags.sku,
      );
      console.log(
        `  [${conta.accountName}] ${produtos.length} produtos com anuncio nesta conta`,
      );

      for (let i = 0; i < produtos.length; i += flags.concurrency) {
        const lote = produtos.slice(i, i + flags.concurrency);
        await Promise.all(
          lote.map(async (prod) => {
            const ids = await buscarItensPorSku(
              token,
              conta.externalUserId as string,
              prod.sku,
            );
            if (ids.length < 2) return; // só há um anúncio: nada a reconciliar

            const detalhes = await detalharItens(token, ids);
            const itens = [...detalhes.values()];

            const linhas = await prisma.productListing.findMany({
              where: {
                marketplaceAccountId: conta.id,
                externalListingId: { in: ids },
              },
              select: { id: true, externalListingId: true },
            });
            const idsComLinha = new Set(linhas.map((l) => l.externalListingId));
            const vereditos = classificar(itens, idsComLinha);

            // `up:` SÓ quando todos os itens compartilham o mesmo user
            // product. Medido no caso do relato: a republicação cria um UP
            // NOVO (MLBU4546798761 -> MLBU4546804381), então o que une os dois
            // é o SKU, não a família. Rotular de `up:` ali daria a impressão
            // errada de que compartilham pool de estoque.
            const ups = new Set(
              itens.map((it) => it.user_product_id).filter(Boolean),
            );
            const groupKey =
              ups.size === 1 ? `up:${[...ups][0]}` : `sku:${prod.sku}`;

            for (const it of itens) {
              const v = vereditos.get(it.id) ?? "OK";
              saida.push({
                dataOwnerId: tenant.userId,
                email: tenant.email,
                accountId: conta.id,
                accountName: conta.accountName,
                groupKey,
                productId: prod.productId,
                sku: prod.sku,
                productName: prod.name,
                estoqueLocal: String(prod.stock),
                precoLocal: prod.price,
                externalListingId: it.id,
                mlStatus: it.status,
                mlAvailableQty: String(it.available_quantity ?? ""),
                mlPrice: String(it.price ?? ""),
                mlUserProductId: it.user_product_id ?? "",
                temLinhaDb: idsComLinha.has(it.id) ? "sim" : "nao",
                dbListingId:
                  linhas.find((l) => l.externalListingId === it.id)?.id ?? "",
                veredito: v,
                acaoSugerida:
                  v === "ORFAO_FECHAR"
                    ? "zerar estoque e fechar (--close-orphans)"
                    : v === "AMBIGUO"
                      ? "revisar manualmente — nunca tocado por --apply"
                      : "",
              });
            }

            const orfaos = itens.filter(
              (it) => vereditos.get(it.id) === "ORFAO_FECHAR",
            );
            if (orfaos.length > 0) {
              console.log(
                `    sku=${prod.sku} grupo=${groupKey}: ${orfaos.length} orfao(s) — ${orfaos
                  .map(
                    (o) => `${o.id}(${o.status}, qtd=${o.available_quantity})`,
                  )
                  .join(", ")}`,
              );
            }

            if (flags.apply && flags.closeOrphans) {
              for (const o of orfaos) {
                if (escritas >= flags.maxWrites) {
                  console.warn(
                    `    [teto] --max-writes=${flags.maxWrites} atingido; parando as escritas.`,
                  );
                  return;
                }
                escritas++;
                const r = await fecharOrfao(token, o.id);
                console.log(
                  `    [apply] ${o.id} -> ${r.ok ? "encerrado com estoque 0" : `FALHOU (${r.detalhe})`}`,
                );
              }
            }

            if (flags.delayMs > 0) await sleep(flags.delayMs);
          }),
        );
      }
    }

    if (flags.apply && flags.fixPlaceholders) {
      console.log(
        "\n[apply] --fix-placeholders ainda nao implementado nesta versao: " +
          "as 24 linhas presas precisam de conferencia caso a caso no ML antes " +
          "de reapontar ou apagar. Rode o relatorio e trate manualmente.",
      );
    }
  }

  const destino =
    flags.csv ??
    path.join(
      process.cwd(),
      "scripts",
      "out",
      `ml-republish-duplicates-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
    );
  escreverCsv(saida, destino);

  if (!flags.apply) {
    console.log(
      "\nREAD-ONLY: nada foi alterado. Para aplicar, some --apply e uma sub-acao\n" +
        "(--close-orphans / --fix-placeholders), sempre com --user-id ou --email.",
    );
  }
}

main()
  .catch((err) => {
    console.error("Falha na auditoria:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // process.exit explícito: o pool do axios do MLApiService às vezes mantém
    // o event loop vivo depois do main retornar.
    process.exit(process.exitCode ?? 0);
  });
