/**
 * Utilitários compartilhados pelos scripts de prod-audit.
 *
 * GARANTIA: Nenhum script nesta pasta deve executar create/update/delete.
 * Qualquer operação de escrita (inclusive upsert) deve ser revisada.
 */
import prisma from "../../app/lib/prisma";

export const DEFAULT_USER_ID = process.env.AUDIT_USER_ID
  ? process.env.AUDIT_USER_ID
  : "cmn5yc4rn0000vsasmwv9m8nc";

export function section(title: string) {
  const bar = "=".repeat(title.length + 4);
  console.log(`\n${bar}\n  ${title}\n${bar}`);
}

export function sub(label: string, value: unknown) {
  console.log(`  • ${label}: ${formatValue(value)}`);
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return v.toLocaleString("pt-BR");
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export function printTable(rows: Array<Record<string, unknown>>, limit = 20) {
  if (rows.length === 0) {
    console.log("  (vazio)");
    return;
  }
  const shown = rows.slice(0, limit);
  for (const row of shown) {
    console.log("  -", JSON.stringify(row));
  }
  if (rows.length > limit) {
    console.log(`  ... e mais ${rows.length - limit} linha(s).`);
  }
}

export type AuditOutcome = {
  name: string;
  findings: string[];
  errors: string[];
};

export function newOutcome(name: string): AuditOutcome {
  return { name, findings: [], errors: [] };
}

export function logFinding(outcome: AuditOutcome, msg: string) {
  outcome.findings.push(msg);
  console.log(`  ⚠ ${msg}`);
}

export function logError(outcome: AuditOutcome, msg: string) {
  outcome.errors.push(msg);
  console.error(`  ✗ ${msg}`);
}

export async function withPrisma<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

export { prisma };
