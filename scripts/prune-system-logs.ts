/**
 * scripts/prune-system-logs.ts
 *
 * Retenção de tabelas de log: apaga linhas mais antigas que N dias (default 90),
 * EM LOTES, para não travar a tabela nem estourar o statement_timeout.
 *
 * Tabelas suportadas (allowlist — todas têm coluna "createdAt"):
 *   - SystemLog       (default; era 1,86 GB em 2026-07 antes da 1ª poda)
 *   - SyncLog         (112 MB; alimentado por todo tick de sync — o COUNT do
 *                      health-check de token varre só 30min, então retenção de
 *                      90d não muda comportamento nenhum)
 *   - WebhookEventLog (274 MB; ⚠️ a unique (source, externalId) serve de dedupe
 *                      de webhook — podar >90d é seguro na prática porque
 *                      ML/Magalu não reentregam eventos de meses atrás, mas
 *                      saiba que um evento REENTREGUE após a poda seria tratado
 *                      como novo)
 *
 * Por que não usar `SystemLogRepository.deleteOldLogs`: ele faz um único
 * `deleteMany` global. Numa tabela grande, acessada via link cross-region
 * (VPS São Paulo → Supabase Ohio), um DELETE único segura lock por muito tempo,
 * gera um pico de WAL e pode bater no statement_timeout. Aqui deletamos em
 * lotes por `ctid`, cada lote é uma transação curta.
 *
 * Dry-run por PADRÃO — só conta o que apagaria. Use --apply para executar.
 *
 * Uso:
 *   tsx scripts/prune-system-logs.ts                                # dry-run, SystemLog, 90 dias
 *   tsx scripts/prune-system-logs.ts --table=SyncLog                # dry-run, SyncLog
 *   tsx scripts/prune-system-logs.ts --table=SyncLog --apply        # APAGA de verdade
 *   tsx scripts/prune-system-logs.ts --days=60 --apply --batch=10000
 *
 * DEPOIS de rodar com --apply, devolva o espaço / atualize estatísticas
 * (fora deste script, pois VACUUM não roda dentro de transação):
 *   psql "$DIRECT_URL" -c 'VACUUM (ANALYZE) "<Tabela>";'
 *   # para RECUPERAR disco de fato (trava a tabela; rodar em janela ociosa):
 *   psql "$DIRECT_URL" -c 'VACUUM FULL "<Tabela>";'
 *
 * ⚠️ O .env do projeto aponta para o banco de PRODUÇÃO. Rode na VPS.
 */
import { Prisma } from "@prisma/client";
import prisma from "../app/lib/prisma";

// Allowlist estrita: só tabelas de log append-only COM coluna "createdAt".
// O identificador interpolado no SQL vem SEMPRE daqui, nunca do argv cru.
const ALLOWED_TABLES = ["SystemLog", "SyncLog", "WebhookEventLog"] as const;
type AllowedTable = (typeof ALLOWED_TABLES)[number];

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  return fallback;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const days = Number(arg("days", "90"));
  const batch = Number(arg("batch", "5000"));
  const apply = hasFlag("apply");
  const tableArg = arg("table", "SystemLog")!;

  const table = ALLOWED_TABLES.find((t) => t === tableArg) as
    | AllowedTable
    | undefined;
  if (!table) {
    throw new Error(
      `--table inválida: "${tableArg}". Permitidas: ${ALLOWED_TABLES.join(", ")}`,
    );
  }
  // Identificador citado, montado a partir do valor da ALLOWLIST (seguro).
  const tbl = Prisma.raw(`"${table}"`);

  if (!Number.isInteger(days) || days < 1) {
    throw new Error("--days deve ser um inteiro >= 1");
  }
  if (!Number.isInteger(batch) || batch < 100 || batch > 50000) {
    throw new Error("--batch deve ser um inteiro entre 100 e 50000");
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const [{ total }] = await prisma.$queryRaw<{ total: bigint }[]>`
    SELECT COUNT(*)::bigint AS total FROM ${tbl} WHERE "createdAt" < ${cutoff}
  `;
  const [{ keep }] = await prisma.$queryRaw<{ keep: bigint }[]>`
    SELECT COUNT(*)::bigint AS keep FROM ${tbl} WHERE "createdAt" >= ${cutoff}
  `;

  console.log(
    `[prune-logs] tabela=${table}  retenção=${days}d  corte=${cutoff.toISOString()}`,
  );
  console.log(
    `[prune-logs] a APAGAR: ${total.toString()}  |  a MANTER: ${keep.toString()}`,
  );

  if (!apply) {
    console.log(
      "[prune-logs] DRY-RUN — nada foi apagado. Rode com --apply para executar.",
    );
    return;
  }
  if (total === BigInt(0)) {
    console.log("[prune-logs] nada a apagar dentro do corte.");
    return;
  }

  console.log(`[prune-logs] APLICANDO em lotes de ${batch}...`);
  const startedAt = Date.now();
  let removed = BigInt(0);
  for (;;) {
    // Deleção em lote por ctid: não carrega ids no Node e cada lote é uma
    // transação curta (lock breve). Repete até esgotar as linhas antigas.
    const affected = await prisma.$executeRaw`
      DELETE FROM ${tbl}
      WHERE ctid IN (
        SELECT ctid FROM ${tbl}
        WHERE "createdAt" < ${cutoff}
        LIMIT ${batch}
      )
    `;
    removed += BigInt(affected);
    console.log(
      `[prune-logs] ... ${removed.toString()}/${total.toString()}`,
    );
    if (affected < batch) break;
  }

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[prune-logs] concluído: ${removed.toString()} linhas removidas em ${secs}s.`,
  );
  console.log(
    `[prune-logs] agora rode:  psql "$DIRECT_URL" -c 'VACUUM (ANALYZE) "${table}";'`,
  );
}

main()
  .catch((e) => {
    console.error("[prune-logs] ERRO:", e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
