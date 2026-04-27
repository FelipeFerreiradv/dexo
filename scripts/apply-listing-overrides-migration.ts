/**
 * Aplica a migration `add_listing_overrides` desativando lock_timeout e
 * statement_timeout. Necessário porque o Supabase pooler aplica timeouts
 * curtos por padrão e o ALTER TABLE em uma tabela com conexões ativas
 * acaba sendo cancelado.
 *
 * Uso: tsx scripts/apply-listing-overrides-migration.ts
 *
 * Marca a migration como applied no _prisma_migrations ao final.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { join } from "path";

const MIGRATION_NAME = "20260426120000_add_listing_overrides";

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log("[migration] Conectando ao banco...");

    // Desativa timeouts na sessão para permitir ALTER esperar pelo lock.
    await prisma.$executeRawUnsafe("SET lock_timeout = 0;");
    await prisma.$executeRawUnsafe("SET statement_timeout = 0;");
    console.log("[migration] lock_timeout e statement_timeout desativados.");

    // Verifica se as colunas já existem (idempotente).
    const existing = (await prisma.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'ProductListing'
         AND column_name = 'titleOverride'`,
    )) as Array<{ column_name: string }>;

    if (existing.length > 0) {
      console.log(
        "[migration] Colunas override já existem — pulando ALTER TABLE.",
      );
    } else {
      const sqlPath = join(
        process.cwd(),
        "prisma",
        "migrations",
        MIGRATION_NAME,
        "migration.sql",
      );
      const sql = readFileSync(sqlPath, "utf-8");
      console.log("[migration] Aplicando ALTER TABLE consolidado...");
      const start = Date.now();
      await prisma.$executeRawUnsafe(sql);
      console.log(
        `[migration] ALTER TABLE concluído em ${Date.now() - start}ms`,
      );
    }

    // Marca como applied no _prisma_migrations.
    const alreadyTracked = (await prisma.$queryRawUnsafe(
      `SELECT migration_name FROM "_prisma_migrations"
       WHERE migration_name = '${MIGRATION_NAME}' AND finished_at IS NOT NULL`,
    )) as Array<{ migration_name: string }>;

    if (alreadyTracked.length === 0) {
      console.log("[migration] Registrando como applied em _prisma_migrations...");
      await prisma.$executeRawUnsafe(
        `INSERT INTO "_prisma_migrations" (
          id, checksum, migration_name, started_at, finished_at, applied_steps_count
        ) VALUES (
          gen_random_uuid()::text,
          'manual-apply',
          '${MIGRATION_NAME}',
          NOW(),
          NOW(),
          1
        ) ON CONFLICT (id) DO NOTHING;`,
      );
    } else {
      console.log("[migration] Já registrada como applied.");
    }

    console.log("[migration] OK — migration aplicada com sucesso.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[migration] ERRO:", err);
  process.exit(1);
});
