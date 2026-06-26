import prisma from "./prisma";
import { Prisma } from "@prisma/client";
import type {
  ProductivityGroupRow,
  BudgetVendedorRow,
} from "./team-productivity";

/**
 * EGRESS: agrega a produtividade NO BANCO (GROUP BY userId, action, dia,
 * marketplace + COUNT) em vez de puxar todas as linhas de `SystemLog` do
 * período para contar em memória — mesmo padrão das rotas /dashboard/*.
 * Isola a linha do SERVIÇO (dedupe): `resourceId IS NOT NULL` + `level = INFO`
 * descartam a linha do middleware de logging e tentativas falhas. `to_char` em
 * UTC bate com o `toISOString` do builder de timeseries (createdAt é UTC).
 * `details->>'marketplace'` é normalizado depois por `canonPlatform`.
 */
export async function fetchProductivityGroups(
  userIds: string[],
  startDate: Date,
  endDate: Date,
): Promise<ProductivityGroupRow[]> {
  if (userIds.length === 0) return [];
  return prisma.$queryRaw<ProductivityGroupRow[]>(Prisma.sql`
    SELECT "userId",
           "action",
           to_char("createdAt", 'YYYY-MM-DD') AS "day",
           "details"->>'marketplace' AS "marketplace",
           COUNT(*)::int AS "count"
    FROM "SystemLog"
    WHERE "userId" IN (${Prisma.join(userIds)})
      AND "action" IN ('CREATE_PRODUCT', 'CREATE_LISTING')
      AND "resourceId" IS NOT NULL
      AND "level"::text = 'INFO'
      AND "createdAt" >= ${startDate}
      AND "createdAt" <= ${endDate}
    GROUP BY "userId", "action", to_char("createdAt", 'YYYY-MM-DD'),
             "details"->>'marketplace'
  `);
}

/**
 * EGRESS: agrega os orçamentos por vendedor NO BANCO (GROUP BY vendedorId +
 * COUNT/SUM, com FILTER p/ os convertidos). Escopo: orçamentos do admin
 * (`userId = adminId`) com vendedor atribuído, no período por `createdAt`.
 * `totalAmount` é Decimal → `::float8` para virar number em JS.
 */
export async function fetchBudgetStatsByVendedor(
  adminId: string,
  startDate: Date,
  endDate: Date,
): Promise<BudgetVendedorRow[]> {
  return prisma.$queryRaw<BudgetVendedorRow[]>(Prisma.sql`
    SELECT "vendedorId",
           COUNT(*)::int AS "count",
           COALESCE(SUM("totalAmount"), 0)::float8 AS "totalValue",
           COUNT(*) FILTER (WHERE "status"::text = 'CONVERTIDO')::int
             AS "convertedCount",
           COALESCE(
             SUM("totalAmount") FILTER (WHERE "status"::text = 'CONVERTIDO'),
             0
           )::float8 AS "convertedValue"
    FROM "Budget"
    WHERE "userId" = ${adminId}
      AND "vendedorId" IS NOT NULL
      AND "createdAt" >= ${startDate}
      AND "createdAt" <= ${endDate}
    GROUP BY "vendedorId"
  `);
}
