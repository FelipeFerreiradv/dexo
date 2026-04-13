/**
 * Executa todos os audits read-only em sequência e grava um relatório
 * em `./audit-reports/audit-<timestamp>.md`.
 *
 * Exit codes:
 *  0 — todos limpos
 *  1 — algum audit retornou finding
 *  2 — algum audit crashou
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { DEFAULT_USER_ID, withPrisma, type AuditOutcome } from "./shared";
import { auditStockIntegrity } from "./audit-stock-integrity";
import { auditListingsHealth } from "./audit-listings-health";
import { auditOrdersLinkage } from "./audit-orders-linkage";
import { auditProductsIntegrity } from "./audit-products-integrity";
import { auditTokens } from "./audit-tokens";
import { auditSystemLogs } from "./audit-system-logs";

type Runner = (userId?: string) => Promise<AuditOutcome>;

const RUNNERS: Array<[string, Runner]> = [
  ["tokens", auditTokens],
  ["products-integrity", auditProductsIntegrity],
  ["listings-health", auditListingsHealth],
  ["orders-linkage", auditOrdersLinkage],
  ["stock-integrity", auditStockIntegrity],
  ["system-logs", auditSystemLogs],
];

async function main() {
  const userId = DEFAULT_USER_ID;
  const results: Array<{
    name: string;
    outcome?: AuditOutcome;
    crash?: string;
  }> = [];

  for (const [name, runner] of RUNNERS) {
    try {
      const outcome = await runner(userId);
      results.push({ name, outcome });
    } catch (err: any) {
      results.push({ name, crash: err?.stack ?? String(err) });
      console.error(`  ✗ ${name} crashou:`, err);
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(process.cwd(), "audit-reports");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `audit-${ts}.md`);

  const lines: string[] = [];
  lines.push(`# Prod Audit Report`);
  lines.push("");
  lines.push(`- Timestamp: ${new Date().toISOString()}`);
  lines.push(`- User: ${userId}`);
  lines.push("");

  let totalFindings = 0;
  let totalCrashes = 0;

  for (const r of results) {
    lines.push(`## ${r.name}`);
    lines.push("");
    if (r.crash) {
      totalCrashes++;
      lines.push("**CRASH**");
      lines.push("");
      lines.push("```");
      lines.push(r.crash);
      lines.push("```");
      lines.push("");
      continue;
    }
    const outcome = r.outcome!;
    if (outcome.findings.length === 0) {
      lines.push("OK — nenhum problema detectado.");
      lines.push("");
      continue;
    }
    totalFindings += outcome.findings.length;
    for (const f of outcome.findings) {
      lines.push(`- ⚠ ${f}`);
    }
    lines.push("");
  }

  lines.unshift("");
  lines.unshift(
    `**Resumo:** ${totalFindings} finding(s), ${totalCrashes} crash(es)`,
  );

  writeFileSync(file, lines.join("\n"), "utf8");
  console.log(`\n📄 relatório salvo em ${file}`);
  console.log(
    `  resumo: ${totalFindings} finding(s), ${totalCrashes} crash(es)`,
  );

  if (totalCrashes > 0) process.exit(2);
  if (totalFindings > 0) process.exit(1);
  process.exit(0);
}

if (require.main === module) {
  withPrisma(main).catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
