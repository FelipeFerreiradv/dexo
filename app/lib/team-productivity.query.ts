import prisma from "./prisma";
import { Prisma } from "@prisma/client";
import type { ProductivityGroupRow } from "./team-productivity";

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
