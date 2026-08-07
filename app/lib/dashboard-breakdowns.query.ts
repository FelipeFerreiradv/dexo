import prisma from "./prisma";
import { Prisma } from "@prisma/client";
import {
  MAX_CATEGORY_ROWS,
  type CategoryRow,
  type CategoryTotalsRow,
  type FinanceBucketRow,
  type PlatformEnumValue,
  type PlatformRow,
} from "./dashboard-breakdowns";

/**
 * EGRESS: leituras dos gráficos novos do Dashboard, todas agregadas NO BANCO
 * (GROUP BY + COUNT/SUM) em vez de puxar linha a linha para somar em JS —
 * mesmo padrão das outras rotas /dashboard/* e de team-productivity.query.ts.
 *
 * Convenções obrigatórias aqui (quebrar qualquer uma dá erro em produção):
 *  - `numeric` sai como `::text`. Sem o cast, `$queryRaw` devolve
 *    `Prisma.Decimal` e o JSON serializa como STRING, quebrando o contrato
 *    numérico que /orders-over-time estabeleceu.
 *  - todo `COUNT(*)` leva `::int`. Sem o cast vem `bigint` e o
 *    `JSON.stringify` do Fastify LANÇA ("Do not know how to serialize a
 *    BigInt") — 500 em produção.
 *  - enum comparado com parâmetro vai castado (`col::text`), porque o driver
 *    manda texto. Mesmo truque de `"level"::text` em team-productivity.query.ts.
 *  - todo valor externo entra BINDADO (`${}` / `Prisma.join`), nunca
 *    concatenado nem via `Prisma.raw`.
 *  - escopo multi-tenant em TODA query: `ma."userId"` / `r."userId"`.
 */

/** Filtro opcional de plataforma. Lista vazia = sem filtro (não usar Prisma.join com []). */
function platformClause(platforms: PlatformEnumValue[]): Prisma.Sql {
  return platforms.length > 0
    ? Prisma.sql`AND ma."platform"::text IN (${Prisma.join(platforms)})`
    : Prisma.empty;
}

/**
 * Pedidos cancelados ENTRAM na receita por padrão — é o que /orders-over-time,
 * /account-stats, /report.pdf e /product-metrics já fazem, e sair disso faria
 * os gráficos novos divergirem dos números exibidos na mesma tela. O recorte é
 * opt-in explícito via `?excludeCancelled=true`.
 */
function cancelledClause(excludeCancelled: boolean): Prisma.Sql {
  return excludeCancelled
    ? Prisma.sql`AND o."status"::text <> 'CANCELLED'`
    : Prisma.empty;
}

/**
 * Vendas por plataforma no período. `Order` não tem `userId` nem `platform`:
 * escopo de tenant E dimensão de plataforma saem os dois do JOIN com
 * `MarketplaceAccount` — mesmo plano de acesso de /orders-over-time
 * (MarketplaceAccount(userId) → Order(marketplaceAccountId, createdAt)).
 * Devolve no máximo uma linha por valor do enum `Platform`.
 */
export async function fetchOrdersByPlatform(
  userId: string,
  startDate: Date,
  endDate: Date,
  platforms: PlatformEnumValue[],
  excludeCancelled: boolean,
): Promise<PlatformRow[]> {
  return prisma.$queryRaw<PlatformRow[]>(Prisma.sql`
    SELECT ma."platform"::text AS "platform",
           COUNT(*)::int AS "orders",
           COALESCE(SUM(o."totalAmount"), 0)::text AS "revenue",
           COUNT(*) FILTER (WHERE o."status"::text = 'CANCELLED')::int
             AS "cancelledOrders",
           COALESCE(
             SUM(o."totalAmount") FILTER (WHERE o."status"::text = 'CANCELLED'),
             0
           )::text AS "cancelledRevenue"
    FROM "Order" o
    JOIN "MarketplaceAccount" ma ON ma."id" = o."marketplaceAccountId"
    WHERE ma."userId" = ${userId}
      AND COALESCE(o."soldAt", o."createdAt") >= ${startDate}
      AND COALESCE(o."soldAt", o."createdAt") <= ${endDate}
      ${platformClause(platforms)}
      ${cancelledClause(excludeCancelled)}
    GROUP BY ma."platform"
  `);
}

/**
 * Escopo comum das duas leituras de categoria. `OrderItem.productId` é NOT
 * NULL, então o JOIN com `Product` não descarta item nenhum — diferente de
 * /product-metrics, que filtra `listingId IS NOT NULL` e perde itens sem
 * anúncio vinculado.
 */
function categoryScope(
  userId: string,
  startDate: Date,
  endDate: Date,
  platforms: PlatformEnumValue[],
  excludeCancelled: boolean,
): Prisma.Sql {
  return Prisma.sql`
    FROM "OrderItem" oi
    JOIN "Order" o               ON o."id"  = oi."orderId"
    JOIN "MarketplaceAccount" ma ON ma."id" = o."marketplaceAccountId"
    JOIN "Product" p             ON p."id"  = oi."productId"
    WHERE ma."userId" = ${userId}
      AND COALESCE(o."soldAt", o."createdAt") >= ${startDate}
      AND COALESCE(o."soldAt", o."createdAt") <= ${endDate}
      ${platformClause(platforms)}
      ${cancelledClause(excludeCancelled)}
  `;
}

/**
 * Receita e unidades por categoria de produto.
 *
 * Por que `$queryRaw` e não `prisma.orderItem.groupBy`: `by:` só aceita campos
 * escalares do próprio model, e `category` mora em `Product` (atravessado por
 * `OrderItem.productId`); além disso `_sum` não aceita expressão, e aqui é
 * preciso `SUM(quantity * unitPrice)`. A alternativa em Prisma seria
 * `findMany` + reduce em JS — exatamente o que a convenção EGRESS proíbe.
 *
 * `Product.category` é texto livre: um tenant com dados sujos pode ter milhares
 * de valores distintos, daí o teto de linhas. Truncar não distorce o gráfico
 * porque a fatia "Outras" é derivada dos TOTAIS (função abaixo, sem LIMIT).
 */
export async function fetchRevenueByCategory(
  userId: string,
  startDate: Date,
  endDate: Date,
  platforms: PlatformEnumValue[],
  excludeCancelled: boolean,
): Promise<CategoryRow[]> {
  return prisma.$queryRaw<CategoryRow[]>(Prisma.sql`
    SELECT NULLIF(btrim(COALESCE(p."category", '')), '') AS "category",
           COALESCE(SUM(oi."quantity" * oi."unitPrice"), 0)::text AS "revenue",
           COALESCE(SUM(oi."quantity"), 0)::int AS "units"
    ${categoryScope(userId, startDate, endDate, platforms, excludeCancelled)}
    GROUP BY 1
    /* Ordena pela EXPRESSÃO, nunca pelo alias "revenue": o alias é ::text e
       ordenaria lexicograficamente ("9" acima de "100"), furando o top-N.
       Comentário de bloco (não "--") para não comer o ORDER BY caso o SQL
       chegue ao driver numa linha só. */
    ORDER BY COALESCE(SUM(oi."quantity" * oi."unitPrice"), 0) DESC, 1 ASC
    LIMIT ${MAX_CATEGORY_ROWS}
  `);
}

/**
 * Totais exatos do mesmo recorte, SEM LIMIT — é o que faz os percentuais
 * fecharem 100% mesmo quando a cauda de categorias foi truncada.
 * `orders` usa COUNT(DISTINCT) e fica só aqui: um pedido com itens de duas
 * categorias contaria nas duas se fosse por linha.
 */
export async function fetchRevenueByCategoryTotals(
  userId: string,
  startDate: Date,
  endDate: Date,
  platforms: PlatformEnumValue[],
  excludeCancelled: boolean,
): Promise<CategoryTotalsRow | null> {
  const rows = await prisma.$queryRaw<CategoryTotalsRow[]>(Prisma.sql`
    SELECT COALESCE(SUM(oi."quantity" * oi."unitPrice"), 0)::text AS "revenue",
           COALESCE(SUM(oi."quantity"), 0)::int AS "units",
           COUNT(DISTINCT o."id")::int AS "orders",
           COUNT(DISTINCT COALESCE(btrim(p."category"), ''))::int AS "categories"
    ${categoryScope(userId, startDate, endDate, platforms, excludeCancelled)}
  `);
  return rows[0] ?? null;
}

/**
 * Escopo das leituras financeiras. CANCELADA fica FORA — regra do módulo
 * financeiro (finance.routes.ts e finance-report.ts:106). NÃO confundir com a
 * regra de `Order`, que inclui cancelados: são dois domínios, cada um
 * internamente coerente.
 */
function receivableScope(
  userId: string,
  startDate: Date,
  endDate: Date,
  unidadeId?: string,
): Prisma.Sql {
  const unidadeClause = unidadeId
    ? Prisma.sql`AND r."unidadeId" = ${unidadeId}`
    : Prisma.empty;
  return Prisma.sql`
    FROM "Receivable" r
    WHERE r."userId" = ${userId}
      AND r."status"::text <> 'CANCELADA'
      AND r."createdAt" >= ${startDate}
      AND r."createdAt" <= ${endDate}
      ${unidadeClause}
  `;
}

/**
 * Buckets de situação replicando `effectiveStatus` (finance-report.ts:52-61)
 * LINHA A LINHA: PAGA → pago; VENCIDA, ou PENDENTE já passada do vencimento →
 * vencido; o resto → pendente. A comparação é `<` ESTRITA, igual à do TS.
 *
 * `now` vai BINDADO em vez de `now()` do Postgres: assim o resultado é
 * determinístico e o spec de reconciliação
 * (tests/dashboard-finance-reconciliation.spec.ts) consegue comparar os dois
 * caminhos com a mesma referência de tempo.
 */
function statusBuckets(now: Date): Prisma.Sql {
  return Prisma.sql`
    COUNT(*)::int AS "count",
    COALESCE(SUM(r."totalAmount"), 0)::text AS "total",
    COALESCE(
      SUM(r."totalAmount") FILTER (WHERE r."status"::text = 'PAGA'), 0
    )::text AS "pago",
    COALESCE(
      SUM(r."totalAmount") FILTER (
        WHERE r."status"::text = 'PENDENTE' AND r."dueDate" >= ${now}
      ), 0
    )::text AS "pendente",
    COALESCE(
      SUM(r."totalAmount") FILTER (
        WHERE r."status"::text = 'VENCIDA'
           OR (r."status"::text = 'PENDENTE' AND r."dueDate" < ${now})
      ), 0
    )::text AS "vencido"
  `;
}

/** Valor a receber lançado no período, por forma de pagamento (`null` incluso). */
export async function fetchReceivablesByPaymentMethod(
  userId: string,
  startDate: Date,
  endDate: Date,
  now: Date,
  unidadeId?: string,
): Promise<FinanceBucketRow[]> {
  return prisma.$queryRaw<FinanceBucketRow[]>(Prisma.sql`
    SELECT r."paymentMethod" AS "key",
           ${statusBuckets(now)}
    ${receivableScope(userId, startDate, endDate, unidadeId)}
    GROUP BY r."paymentMethod"
  `);
}

/**
 * Forma de venda: o `hasItems` de finance-report.ts:109-110 vira um EXISTS.
 * Conta a receber COM `ReceivableItem` = venda de balcão; sem itens = avulsa.
 * `ReceivableItem @@index([receivableId])` torna isso um semi-join por índice.
 */
export async function fetchReceivablesByChannel(
  userId: string,
  startDate: Date,
  endDate: Date,
  now: Date,
  unidadeId?: string,
): Promise<FinanceBucketRow[]> {
  return prisma.$queryRaw<FinanceBucketRow[]>(Prisma.sql`
    -- Bloco B: a PARCELA de uma venda de balcão não tem itens (a mercadoria
    -- saiu uma vez só, na conta-entrada) — mas continua sendo receita de
    -- balcão. Sem o OR, o saldo parcelado migraria para "avulso" e o canal
    -- Balcão apareceria sub-reportado. A coluna parentReceivableId é NULL em
    -- 100% das linhas existentes, então para os dados de hoje nada muda.
    -- Espelha aggregateFinanceReport (finance-report.ts) — os dois lados têm
    -- de mover juntos, senão o cadeado anti-drift do dashboard quebra.
    SELECT CASE WHEN EXISTS (
             SELECT 1 FROM "ReceivableItem" ri
             WHERE ri."receivableId" = r."id"
           ) OR r."parentReceivableId" IS NOT NULL
           THEN 'BALCAO' ELSE 'AVULSO' END AS "key",
           ${statusBuckets(now)}
    ${receivableScope(userId, startDate, endDate, unidadeId)}
    GROUP BY 1
  `);
}
