import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * Schema descartável de NF-e num PostgreSQL LOCAL para specs de ponta a ponta.
 *
 * - Schema do Prisma gerado SEM contato com banco (`prisma migrate diff --from-empty`);
 *   nunca `db push` (apagaria os índices parciais de produção).
 * - FKs para modelos que o teste não cria (User, CompanyFiscalConfig…) ficam de fora.
 * - As tabelas dos DDLs de 18/09 vêm dos PRÓPRIOS DDLs, como em produção.
 * - Índices parciais que só existem no banco (docs/multi-cnpj-sql.md 3d/3e).
 *
 * Opt-in: NFE_TEST_DATABASE_URL=postgresql://…@127.0.0.1:<porta>/nfe_test
 */
export interface SchemaNfe {
  url: string;
  schema: string;
  admin: PrismaClient;
  destruir(): Promise<void>;
}

export function urlTestePostgres(): string | undefined {
  return process.env.NFE_TEST_DATABASE_URL;
}

export async function criarSchemaNfe(raw: string, prefixo = "nfe_e2e"): Promise<SchemaNfe> {
  const url = new URL(raw);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.includes("nfe_test")) {
    throw new Error("NFE_TEST_DATABASE_URL deve apontar a banco nfe_test em localhost");
  }
  const schema = `${prefixo}_${randomUUID().replace(/-/g, "")}`;
  url.searchParams.set("schema", schema);
  const admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);

  const diff = execFileSync("npx", ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"], { encoding: "utf8", shell: true, env: process.env });
  const doDdl = /"(NfeNumeroReserva|NfeNumeroTentativa|CompanyFiscalRespTec|NfeDevolucao|NfeDevolucaoItem)"/;
  const stmts = diff.split(/;\s*(?:\r?\n|$)/).map((s) => s.replace(/^\s*--[^\n]*\n/gm, "").trim()).filter((s) => s && !/FOREIGN KEY/.test(s) && !doDdl.test(s));
  for (const sql of stmts) await admin.$executeRawUnsafe(sql);
  await admin.$executeRawUnsafe(`CREATE UNIQUE INDEX "NfeSequence_cfcId_ambiente_serie_modelo_key" ON "NfeSequence"("companyFiscalConfigId","ambiente","serie","modelo") WHERE "companyFiscalConfigId" IS NOT NULL`);
  await admin.$executeRawUnsafe(`CREATE UNIQUE INDEX "NfeEmitida_cfcId_ambiente_serie_numero_modelo_key" ON "NfeEmitida"("companyFiscalConfigId","ambiente","serie","numero","modelo") WHERE "companyFiscalConfigId" IS NOT NULL AND "numero" > 0`);
  const ddl = readFileSync("prisma/ddl/2026-09-18-nfe-numeracao-v2.sql", "utf8").replace(/--[^\r\n]*/g, "");
  for (const sql of ddl.split(";").map((s) => s.trim()).filter((s) => s && !["BEGIN", "COMMIT"].includes(s))) await admin.$executeRawUnsafe(sql);

  return {
    url: url.toString(),
    schema,
    admin,
    async destruir() {
      await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.$disconnect();
    },
  };
}
