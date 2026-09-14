/**
 * Audit: oversell cross-canal (READ-ONLY, CROSS-TENANT)
 *
 * POR QUE EXISTE
 *
 * Uma peca de 1 unidade (SKU 33996) foi vendida na Shopee em 01/08/2026 e DE
 * NOVO no Mercado Livre em 10/09. A baixa local funcionou e as tres Shopee
 * foram zeradas em segundos; os dois anuncios do ML estavam `under_review` e o
 * sync os pulou retornando SUCESSO, deixando `available_quantity: 1` intacto
 * por 39 dias.
 *
 * O defeito foi corrigido no gate do ML, mas o PASSIVO ja criado nao se
 * conserta sozinho: sao anuncios fora do ar hoje que voltam vendaveis assim que
 * alguem os reativa. Este script mede esse passivo e os vetores vizinhos.
 *
 * GARANTIA: nenhuma escrita. Nenhum create/update/delete/upsert, nenhuma
 * chamada de API de marketplace. So SELECT.
 *
 * A FONTE DA VERDADE do bloco 1 e o `SyncLog.payload.remoteAvailableQuantity`,
 * que veio da API do ML no momento do sync — nao e inferencia nossa. Por isso
 * ele e o unico bloco que autoriza correcao; os demais sao contexto.
 *
 * NAO INFERIMOS VENDA A PARTIR DE ANUNCIO PAUSADO. Anuncio pausado significa
 * anuncio fora do ar, e nada mais (modo ferias, pausa manual, pausa do ML). Foi
 * essa inferencia que, em 21-22/05/2026, fez o scripts/balcao-stock-fix.ts
 * sumir com 120 unidades reais do catalogo.
 *
 * USO
 *   tsx scripts/prod-audit/audit-oversell-cross-canal.ts
 *   tsx scripts/prod-audit/audit-oversell-cross-canal.ts --email a@b.com
 *   tsx scripts/prod-audit/audit-oversell-cross-canal.ts --dias 14
 *
 * Saida: scripts/out/oversell-cross-canal.json e .md
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import {
  prisma,
  section,
  sub,
  printTable,
  newOutcome,
  logFinding,
  withPrisma,
  type AuditOutcome,
} from "./shared";

const OUT_DIR = join(process.cwd(), "scripts", "out");

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf("--" + nome);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Colaborador herda do admin: o dono dos dados e sempre parentUserId ?? id. */
async function resolverTenant(email?: string): Promise<string | null> {
  if (!email) return null;
  const u = await prisma.user.findUnique({
    where: { email },
    select: { id: true, parentUserId: true },
  });
  if (!u) throw new Error("Usuario nao encontrado: " + email);
  return u.parentUserId ?? u.id;
}

type AnuncioEmRisco = {
  tenant: string;
  externalListingId: string;
  platform: string;
  skipReason: string;
  quantidadeRemota: number;
  productId: string;
  sku: string | null;
  stockLocal: number;
  reservedStock: number;
  disponivel: number;
  precoBRL: number;
  vistoEm: string;
};

export async function auditOversellCrossCanal(
  opts: { tenant?: string | null; dias?: number } = {},
): Promise<AuditOutcome> {
  const outcome = newOutcome("oversell-cross-canal");
  const dias = opts.dias ?? 7;
  const tenant = opts.tenant ?? null;

  section(
    "OVERSELL CROSS-CANAL — " +
      (tenant ? "tenant " + tenant : "TODOS os tenants") +
      ", janela " +
      dias +
      "d",
  );

  // ─── BLOCO 1 — o achado acionavel ──────────────────────────────────────────
  // Ultimo estado conhecido de cada anuncio do ML segundo a propria API do ML.
  // `closed` sai: e terminal, o ML recusa a escrita e o anuncio nao volta ao ar
  // sozinho. Ele e contado a parte, como risco secundario de republicacao.
  const emRisco = await prisma.$queryRawUnsafe<AnuncioEmRisco[]>(
    `
    WITH ultimo AS (
      SELECT DISTINCT ON (sl.payload->>'externalListingId')
             sl.payload->>'externalListingId' AS item,
             sl.payload->>'skipReason'        AS skip,
             (sl.payload->>'remoteAvailableQuantity')::int AS qtd,
             sl."createdAt"                   AS visto_em
      FROM "SyncLog" sl
      WHERE sl.type = 'STOCK_UPDATE'
        AND sl.payload->>'skipReason' IS NOT NULL
        AND sl."createdAt" > now() - ($1 || ' days')::interval
      ORDER BY sl.payload->>'externalListingId', sl."createdAt" DESC
    )
    SELECT u.email                        AS tenant,
           ultimo.item                    AS "externalListingId",
           ma.platform::text              AS platform,
           ultimo.skip                    AS "skipReason",
           ultimo.qtd                     AS "quantidadeRemota",
           p.id                           AS "productId",
           p.sku                          AS sku,
           p.stock                        AS "stockLocal",
           p."reservedStock"              AS "reservedStock",
           (p.stock - p."reservedStock")  AS disponivel,
           COALESCE(p.price, 0)::float8   AS "precoBRL",
           ultimo.visto_em::text          AS "vistoEm"
    FROM ultimo
    JOIN "ProductListing" pl ON pl."externalListingId" = ultimo.item
    JOIN "Product" p         ON p.id = pl."productId"
    JOIN "MarketplaceAccount" ma ON ma.id = pl."marketplaceAccountId"
    JOIN "User" u            ON u.id = ma."userId"
    WHERE ultimo.qtd > 0
      AND ultimo.skip <> 'ml_status_closed'
      AND (p.stock - p."reservedStock") <= 0
      AND ($2::text IS NULL OR p."userId" = $2::text)
    ORDER BY u.email, ultimo.qtd DESC
  `,
    String(dias),
    tenant,
  );

  sub(
    "anuncios em RISCO VIVO (fora do ar, com quantidade remota > 0)",
    emRisco.length,
  );
  const unidades = emRisco.reduce((s, r) => s + r.quantidadeRemota, 0);
  const exposicao = emRisco.reduce((s, r) => s + r.precoBRL, 0);
  const produtosDistintos = new Set(emRisco.map((r) => r.productId)).size;
  const tenantsAfetados = new Set(emRisco.map((r) => r.tenant)).size;
  sub("unidades fantasma", unidades);
  sub("exposicao (R$)", exposicao.toFixed(2));
  sub("produtos distintos", produtosDistintos);
  sub("tenants afetados", tenantsAfetados);

  if (emRisco.length > 0) {
    logFinding(
      outcome,
      emRisco.length +
        " anuncio(s) fora do ar mantem quantidade vendavel de peca que nao existe (R$ " +
        exposicao.toFixed(2) +
        ")",
    );
    const porTenant = new Map<
      string,
      { anuncios: number; unidades: number; reais: number }
    >();
    for (const r of emRisco) {
      const cur = porTenant.get(r.tenant) ?? {
        anuncios: 0,
        unidades: 0,
        reais: 0,
      };
      cur.anuncios += 1;
      cur.unidades += r.quantidadeRemota;
      cur.reais += r.precoBRL;
      porTenant.set(r.tenant, cur);
    }
    printTable(
      [...porTenant.entries()]
        .sort((a, b) => b[1].anuncios - a[1].anuncios)
        .map(([t, v]) => ({
          tenant: t,
          anuncios: v.anuncios,
          unidades: v.unidades,
          reais: Number(v.reais.toFixed(2)),
        })),
      40,
    );
  }

  // ─── BLOCO 2 — risco secundario: closed com quantidade remota ──────────────
  const closedComQtd = await prisma.$queryRawUnsafe<
    { n: bigint; unidades: bigint }[]
  >(
    `
    WITH ultimo AS (
      SELECT DISTINCT ON (sl.payload->>'externalListingId')
             sl.payload->>'externalListingId' AS item,
             sl.payload->>'skipReason' AS skip,
             (sl.payload->>'remoteAvailableQuantity')::int AS qtd
      FROM "SyncLog" sl
      WHERE sl.type='STOCK_UPDATE' AND sl.payload->>'skipReason' IS NOT NULL
        AND sl."createdAt" > now() - ($1 || ' days')::interval
      ORDER BY sl.payload->>'externalListingId', sl."createdAt" DESC
    )
    SELECT count(*)::bigint AS n, COALESCE(sum(ultimo.qtd),0)::bigint AS unidades
    FROM ultimo
    JOIN "ProductListing" pl ON pl."externalListingId" = ultimo.item
    JOIN "Product" p ON p.id = pl."productId"
    WHERE ultimo.qtd > 0 AND ultimo.skip = 'ml_status_closed'
      AND ($2::text IS NULL OR p."userId" = $2::text)
  `,
    String(dias),
    tenant,
  );
  const nClosed = Number(closedComQtd[0]?.n ?? 0);
  sub(
    "anuncios CLOSED com quantidade remota (risco so em republicacao)",
    nClosed + " anuncios / " + Number(closedComQtd[0]?.unidades ?? 0) + " unidades",
  );

  // ─── BLOCO 3 — pedidos sem baixa ───────────────────────────────────────────
  // O filtro `items.some.productId` NAO e detalhe: sem ele a contagem sobe de
  // 15 para 666 em producao (14/09/2026), porque 651 sao pedidos que nunca
  // vincularam a um produto do catalogo — nesses nao ha o que baixar, e a
  // quarentena (OrderIngestionIssue) ja e o mecanismo que cuida deles. Contar
  // os dois juntos daria um numero alarmante e falso.
  const semBaixa = await prisma.order.count({
    where: {
      stockDeductedAt: null,
      status: { not: "CANCELLED" },
      createdAt: { gte: new Date(Date.now() - 90 * 864e5) },
      items: { some: { productId: { not: null } } },
      ...(tenant ? { marketplaceAccount: { userId: tenant } } : {}),
    },
  });
  sub("pedidos com produto vinculado e SEM stockDeductedAt (90d)", semBaixa);
  if (semBaixa > 0) {
    logFinding(
      outcome,
      semBaixa +
        " pedido(s) com produto vinculado sem baixa de estoque registrada",
    );
  }

  // ─── BLOCO 4 — venda aberta sem reserva ────────────────────────────────────
  const semReserva = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `
    SELECT count(DISTINCT ri."productId")::bigint AS n
    FROM "Receivable" r
    JOIN "ReceivableItem" ri ON ri."receivableId" = r.id
    JOIN "Product" p ON p.id = ri."productId"
    WHERE r.status IN ('PENDENTE','VENCIDA')
      AND ri."productId" IS NOT NULL
      AND p."reservedStock" = 0
      AND ($1::text IS NULL OR r."userId" = $1::text)
  `,
    tenant,
  );
  const nSemReserva = Number(semReserva[0]?.n ?? 0);
  sub("produtos em venda ABERTA sem reservedStock", nSemReserva);
  if (nSemReserva > 0) {
    logFinding(
      outcome,
      nSemReserva +
        " produto(s) comprometidos em venda aberta sem reserva gravada (rodar backfill-reserved-stock)",
    );
  }

  // ─── BLOCO 5 — fila de propagacao presa ────────────────────────────────────
  const presos = await (prisma as any).stockSyncJob.count({
    where: {
      status: "PENDING",
      nextRunAt: { lt: new Date(Date.now() - 864e5) },
    },
  });
  sub("StockSyncJob PENDING ha mais de 24h", presos);
  if (presos > 0) logFinding(outcome, presos + " job(s) de propagacao presos");

  // ─── BLOCO 6 — o padrao exato do Caso A ────────────────────────────────────
  // Duas vendas do MESMO produto, em canais diferentes, sem StockLog POSITIVO
  // entre elas: a segunda venda saiu de um estoque que a primeira ja consumira.
  const duasVendas = await prisma.$queryRawUnsafe<
    {
      tenant: string;
      sku: string | null;
      productId: string;
      primeira: string;
      segunda: string;
      canal1: string;
      canal2: string;
    }[]
  >(
    `
    WITH vendas AS (
      SELECT oi."productId", o."soldAt", ma.platform::text AS canal, ma."userId"
      FROM "Order" o
      JOIN "OrderItem" oi ON oi."orderId" = o.id
      JOIN "MarketplaceAccount" ma ON ma.id = o."marketplaceAccountId"
      WHERE o."soldAt" > now() - interval '120 days' AND oi."productId" IS NOT NULL
    ),
    pares AS (
      SELECT v1."productId", v1."soldAt" AS primeira, v2."soldAt" AS segunda,
             v1.canal AS canal1, v2.canal AS canal2, v1."userId"
      FROM vendas v1
      JOIN vendas v2 ON v2."productId" = v1."productId"
                    AND v2."soldAt" > v1."soldAt" AND v2.canal <> v1.canal
    )
    SELECT u.email AS tenant, p.sku, p.id AS "productId",
           pares.primeira::text AS primeira, pares.segunda::text AS segunda,
           pares.canal1, pares.canal2
    FROM pares
    JOIN "Product" p ON p.id = pares."productId"
    JOIN "User" u ON u.id = pares."userId"
    WHERE p.stock <= 0
      AND NOT EXISTS (
        SELECT 1 FROM "StockLog" sl
        WHERE sl."productId" = pares."productId"
          AND sl.change > 0
          AND sl."createdAt" BETWEEN pares.primeira AND pares.segunda
      )
      AND ($1::text IS NULL OR p."userId" = $1::text)
    ORDER BY pares.segunda DESC
    LIMIT 200
  `,
    tenant,
  );
  sub(
    "mesma peca vendida em DOIS canais sem reposicao entre as vendas",
    duasVendas.length,
  );
  if (duasVendas.length > 0) {
    logFinding(
      outcome,
      duasVendas.length +
        " caso(s) do padrao exato do SKU 33996 (venda dupla cross-canal)",
    );
    printTable(duasVendas, 25);
  }

  // ─── BLOCO 7 — falhas DURAS de propagacao (contexto, fora de escopo) ───────
  const falhas = await prisma.$queryRawUnsafe<{ motivo: string; n: bigint }[]>(
    `
    SELECT CASE
             WHEN message LIKE '%status is abnormal%' THEN 'Shopee: item com status anormal'
             WHEN message LIKE '%ParseUint%'          THEN 'Shopee: ParseUint NaN'
             WHEN message LIKE '%placeholder%'        THEN 'ML: anuncio local placeholder'
             WHEN message LIKE '%Magalu%'             THEN 'Magalu: HTTP'
             WHEN message LIKE '%Cannot update item%' THEN 'ML: Cannot update item'
             ELSE 'outro'
           END AS motivo,
           count(*)::bigint AS n
    FROM "SystemLog"
    WHERE action = 'STOCK_SYNC_FAILED' AND "createdAt" > now() - interval '60 days'
    GROUP BY 1 ORDER BY 2 DESC
  `,
  );
  const totalFalhas = falhas.reduce((s, f) => s + Number(f.n), 0);
  sub("falhas DURAS de propagacao (60d, toda a base)", totalFalhas);
  printTable(
    falhas.map((f) => ({ motivo: f.motivo, ocorrencias: Number(f.n) })),
    10,
  );

  // ─── Relatorio ─────────────────────────────────────────────────────────────
  mkdirSync(OUT_DIR, { recursive: true });
  const relatorio = {
    geradoEm: new Date().toISOString(),
    escopo: tenant ?? "TODOS",
    janelaDias: dias,
    resumo: {
      anunciosEmRiscoVivo: emRisco.length,
      unidadesFantasma: unidades,
      exposicaoBRL: Number(exposicao.toFixed(2)),
      produtosDistintos,
      tenantsAfetados,
      closedComQuantidade: nClosed,
      pedidosSemBaixa: semBaixa,
      vendaAbertaSemReserva: nSemReserva,
      jobsPresos: presos,
      vendaDuplaCrossCanal: duasVendas.length,
      falhasDuras60d: totalFalhas,
    },
    anunciosEmRisco: emRisco,
    vendaDuplaCrossCanal: duasVendas,
    falhasDuras: falhas.map((f) => ({
      motivo: f.motivo,
      ocorrencias: Number(f.n),
    })),
  };

  const base = join(OUT_DIR, "oversell-cross-canal");
  writeFileSync(base + ".json", JSON.stringify(relatorio, null, 2), "utf8");

  const porTenantMd = [
    ...emRisco
      .reduce((m, r) => {
        const c = m.get(r.tenant) ?? { a: 0, u: 0, v: 0 };
        c.a += 1;
        c.u += r.quantidadeRemota;
        c.v += r.precoBRL;
        m.set(r.tenant, c);
        return m;
      }, new Map<string, { a: number; u: number; v: number }>())
      .entries(),
  ]
    .sort((x, y) => y[1].a - x[1].a)
    .map(([t, c]) => "| " + t + " | " + c.a + " | " + c.u + " | " + c.v.toFixed(2) + " |");

  const md = [
    "# Oversell cross-canal — " + (tenant ?? "todos os tenants"),
    "",
    "Gerado em " + relatorio.geradoEm + " · janela de " + dias + " dias",
    "",
    "## Resumo",
    "",
    "| Indicador | Valor |",
    "|---|---|",
    "| Anuncios em risco vivo | " + emRisco.length + " |",
    "| Unidades fantasma | " + unidades + " |",
    "| Exposicao | R$ " + exposicao.toFixed(2) + " |",
    "| Produtos distintos | " + produtosDistintos + " |",
    "| Tenants afetados | " + tenantsAfetados + " |",
    "| Closed com quantidade (secundario) | " + nClosed + " |",
    "| Pedidos sem baixa (90d) | " + semBaixa + " |",
    "| Venda aberta sem reserva | " + nSemReserva + " |",
    "| Jobs de propagacao presos | " + presos + " |",
    "| Venda dupla cross-canal | " + duasVendas.length + " |",
    "| Falhas duras de propagacao (60d) | " + totalFalhas + " |",
    "",
    "## Anuncios em risco, por tenant",
    "",
    "| Tenant | Anuncios | Unidades | R$ |",
    "|---|---|---|---|",
    ...porTenantMd,
  ].join("\n");
  writeFileSync(base + ".md", md, "utf8");

  console.log("\n  Relatorio: " + base + ".json e " + base + ".md");
  return outcome;
}

if (require.main === module) {
  const email = arg("email");
  const dias = arg("dias") ? Number(arg("dias")) : 7;
  withPrisma(async () =>
    auditOversellCrossCanal({ tenant: await resolverTenant(email), dias }),
  )
    .then((o) => process.exit(o.findings.length > 0 ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
