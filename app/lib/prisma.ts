import { PrismaClient } from "@prisma/client";

// Pool do Prisma configurável por env, com os MESMOS defaults de antes
// (15 conexões / 30s de espera) — sem env setada, comportamento idêntico.
//
// Contexto (incidente 2026-07-23): connection_limit=15 foi calibrado para o
// Pool Size antigo do Supavisor (15). Com o Pool Size do Supabase em 40, a
// API pode receber mais folga via PRISMA_CONNECTION_LIMIT sem redeploy de
// código. Cuidado: o .env é compartilhado pelos 4 processos pm2 (api,
// frontend, sync-orders, catalog-stats) — a soma dos limites deve caber no
// Pool Size do Supavisor com margem (ex.: limit 25 com Pool Size 40).
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    console.error(
      `[prisma] ${name}="${raw}" inválido (esperado inteiro 1-100); usando ${fallback}.`,
    );
    return fallback;
  }
  return parsed;
}

const connectionLimit = positiveIntEnv("PRISMA_CONNECTION_LIMIT", 15);
const poolTimeout = positiveIntEnv("PRISMA_POOL_TIMEOUT", 30);

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL
        ? `${process.env.DATABASE_URL}${process.env.DATABASE_URL.includes("?") ? "&" : "?"}connection_limit=${connectionLimit}&pool_timeout=${poolTimeout}`
        : undefined,
    },
  },
});

export default prisma;
