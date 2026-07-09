import "dotenv/config";
import path from "path";
import fs from "fs";
import XLSX from "xlsx";
import { Prisma } from "@prisma/client";
import prisma from "../app/lib/prisma";

/**
 * Migração das NF-e emitidas do cliente 704 (vaapt) — export do sistema antigo
 * "invoicy". A base é resumo (sem itens/impostos), com números REPETIDOS por
 * re-emissão (Negada/Inutilizado → nova tentativa). Importa como REGISTRO
 * HISTÓRICO em `NfeEmitida`, 1 registro por número (dedup por prioridade de
 * status), e avança `NfeSequence` para continuar a numeração real.
 *
 * Decisão do usuário: #338 já autorizado → próximo número = 339, importar tudo.
 *
 * Uso (chame o tsx DIRETO):
 *   npx tsx scripts/migracao-vaapt-nfes.ts --dry-run
 *   npx tsx scripts/migracao-vaapt-nfes.ts --apply
 *   npx tsx scripts/migracao-vaapt-nfes.ts --apply --seq-start=339
 */

type RawRow = Record<string, unknown>;

const DEFAULT_USER_ID = "cmql2zugq0000vs8g376rend5"; // cliente 704 (vaapt)
const DEFAULT_FILE = path.resolve(__dirname, "data", "migracao-704", "notas-fiscais.xls");
const OUT_DIR = path.resolve(__dirname, "out");
const AMBIENTE = "PRODUCAO";
let TAG = "704"; // sobrescrito por --tenant no main (ex.: MESQUITA)

interface Flags {
  userId: string;
  dryRun: boolean;
  apply: boolean;
  file: string;
  seqStart: number | null; // próximo nº a emitir; null = deriva de (maxNumero + 1)
  skipSeqAdvance: boolean;
  tenant: string;
}

function parseFlags(argv: string[]): Flags {
  const get = (n: string) => {
    const p = `--${n}=`;
    const f = argv.find((a) => a.startsWith(p));
    return f ? f.slice(p.length) : undefined;
  };
  const has = (n: string) => argv.includes(`--${n}`);
  const apply = has("apply");
  const seqRaw = get("seq-start");
  return {
    userId: get("user-id") ?? DEFAULT_USER_ID,
    apply,
    dryRun: has("dry-run") || !apply,
    file: get("file") ?? DEFAULT_FILE,
    seqStart: seqRaw && /^\d+$/.test(seqRaw) ? parseInt(seqRaw, 10) : null,
    skipSeqAdvance: has("skip-seq-advance"),
    tenant: get("tenant") ?? "704",
  };
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}
function asInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  s = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  const n = Number(s.replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function normKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
function pushCap<T>(arr: T[], item: T, cap = 2000): void {
  if (arr.length < cap) arr.push(item);
}

/** Datas mistas: "2024-05-31", "dd/mm/yyyy" ou serial Excel (46206). */
function parseFlexibleDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) {
    const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Status invoicy → status Dexo. */
function mapStatus(situacao: string | null): string {
  const s = (situacao ?? "").toLowerCase();
  // "Cancelamento negado" = tentativa de cancelamento RECUSADA → nota permanece
  // válida (autorizada). Precisa vir antes do teste genérico de "cancel".
  if (s.includes("cancel") && s.includes("nega")) return "AUTHORIZED";
  if (s.includes("autoriz")) return "AUTHORIZED";
  if (s.includes("cancel")) return "CANCELLED";
  if (s.includes("inutiliz")) return "INUTILIZED";
  if (s.includes("nega")) return "REJECTED";
  return "AUTHORIZED";
}
const STATUS_PRIORITY: Record<string, number> = {
  Autorizada: 1,
  Cancelada: 2,
  Inutilizado: 3,
  Negada: 4,
};

/** CFOP → tipoOperacao / destinoOperacao. */
function cfopDerive(cfop: string | null): { tipo: string; destino: string } {
  const d1 = (cfop ?? "").trim()[0];
  const tipo = d1 === "1" || d1 === "2" || d1 === "3" ? "ENTRADA" : "SAIDA";
  const destino =
    d1 === "1" || d1 === "5" ? "INTERNA" : d1 === "2" || d1 === "6" ? "INTERESTADUAL" : d1 === "3" || d1 === "7" ? "EXTERIOR" : "INTERNA";
  return { tipo, destino };
}

function readSheet(file: string): { get: (r: RawRow, label: string) => unknown; dataRows: RawRow[] } {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`Arquivo não encontrado: ${resolved}`);
  const wb = XLSX.readFile(resolved);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: null });
  // A 1ª linha de dados é a de RÓTULOS (o header real da planilha é o título).
  const labelRow = rows[0] ?? {};
  const labelToKey = new Map<string, string>();
  for (const key of Object.keys(labelRow)) {
    const lbl = asString(labelRow[key]);
    if (lbl) labelToKey.set(normKey(lbl), key);
  }
  const dataRows = rows.slice(1);
  const get = (r: RawRow, label: string): unknown => {
    const k = labelToKey.get(normKey(label));
    return k ? r[k] : null;
  };
  console.log(`[sheet] ${path.basename(resolved)} '${wb.SheetNames[0]}': ${dataRows.length} linhas de dados`);
  return { get, dataRows };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const flags = parseFlags(process.argv.slice(2));
  TAG = flags.tenant;
  console.log(
    `[nfe-${TAG}] userId=${flags.userId} tenant=${TAG} modo=${flags.dryRun ? "DRY-RUN" : "APPLY"} file=${path.basename(flags.file)}`,
  );

  const user = await prisma.user.findUnique({
    where: { id: flags.userId },
    select: { id: true, email: true, role: true },
  });
  if (!user) throw new Error(`Usuário ${flags.userId} não encontrado.`);
  console.log(`[preflight] user=${user.email} role=${user.role}`);

  const { get, dataRows } = readSheet(flags.file);

  // Dedup por número — 1 registro por número, prioridade de status.
  const byNum = new Map<number, RawRow[]>();
  let semNumero = 0;
  for (const r of dataRows) {
    const n = asInt(get(r, "N° NFe"));
    if (n === null) {
      semNumero++;
      continue;
    }
    (byNum.get(n) ?? byNum.set(n, []).get(n)!).push(r);
  }

  const chosen: Array<{ numero: number; row: RawRow }> = [];
  for (const [numero, rowsN] of byNum) {
    const sorted = [...rowsN].sort((a, b) => {
      const pa = STATUS_PRIORITY[String(get(a, "Status da NFe") ?? "").trim()] ?? 9;
      const pb = STATUS_PRIORITY[String(get(b, "Status da NFe") ?? "").trim()] ?? 9;
      if (pa !== pb) return pa - pb;
      const ca = asString(get(a, "Chave de Acesso")) ? 0 : 1;
      const cb = asString(get(b, "Chave de Acesso")) ? 0 : 1;
      if (ca !== cb) return ca - cb;
      const da = parseFlexibleDate(get(a, "Data de Emissão"))?.getTime() ?? 0;
      const db = parseFlexibleDate(get(b, "Data de Emissão"))?.getTime() ?? 0;
      return db - da;
    });
    chosen.push({ numero, row: sorted[0] });
  }
  chosen.sort((a, b) => a.numero - b.numero);

  // Preload dos números já existentes (idempotência) — serie 1, ambiente PRODUCAO.
  const existentes = new Set(
    (
      await prisma.nfeEmitida.findMany({
        where: { userId: flags.userId, ambiente: AMBIENTE, serie: 1 },
        select: { numero: true },
      })
    ).map((n) => n.numero),
  );

  const sum = {
    linhas: dataRows.length,
    sem_numero: semNumero,
    numeros_distintos: byNum.size,
    duplicados_colapsados: dataRows.length - byNum.size - semNumero,
    created: 0,
    skipped_existing: 0,
    errors: 0,
    por_status: {} as Record<string, number>,
    sem_chave: 0,
    cnpjs: new Set<string>(),
    numero_min: chosen.length ? chosen[0].numero : 0,
    numero_max: chosen.length ? chosen[chosen.length - 1].numero : 0,
    seq_de: 0,
    seq_para: 0,
    details: [] as unknown[],
  };

  for (const { numero, row } of chosen) {
    const situacao = asString(get(row, "Status da NFe"));
    const status = mapStatus(situacao);
    sum.por_status[status] = (sum.por_status[status] ?? 0) + 1;

    if (existentes.has(numero)) {
      sum.skipped_existing++;
      continue;
    }

    const chaveRaw = asString(get(row, "Chave de Acesso"));
    const chave = chaveRaw && /^\d{44}$/.test(chaveRaw) ? chaveRaw : null;
    if (!chave) sum.sem_chave++;
    const serie = chave ? parseInt(chave.slice(22, 25), 10) : 1;
    const cnpj = chave ? chave.slice(6, 20) : null;
    if (cnpj) sum.cnpjs.add(cnpj);

    const cfop = asString(get(row, "CFOP"));
    const { tipo, destino } = cfopDerive(cfop);
    const valor = asNumber(get(row, "Valor Total da NFe")) ?? 0;
    const dataEmissao = parseFlexibleDate(get(row, "Data de Emissão"));
    const dataAutorizacao = parseFlexibleDate(get(row, "Data de Autorização"));
    const nome = asString(get(row, "Nome do Cliente")) ?? "";
    const motivo = asString(get(row, "Motivo do cancelamento"));

    const infoParts = [`Migração ${TAG} · histórico (invoicy)`];
    if (cfop) infoParts.push(`CFOP ${cfop}`);
    if (situacao) infoParts.push(situacao);
    if (motivo) infoParts.push(`motivo: ${motivo}`);

    if (flags.dryRun) {
      sum.created++;
      pushCap(sum.details, { numero, serie, status, valor, nome, cfop, reason: "would_create" });
      continue;
    }
    try {
      const data: Prisma.NfeEmitidaUncheckedCreateInput = {
        userId: flags.userId,
        ambiente: AMBIENTE,
        modelo: "55",
        serie,
        numero,
        chaveAcesso: chave,
        tipoOperacao: tipo,
        finalidade: "NORMAL",
        destinoOperacao: destino,
        naturezaOperacao: tipo === "SAIDA" ? "VENDA" : "ENTRADA",
        indPresenca: "9",
        informacoesComplementares: infoParts.join(" · "),
        dataEmissao,
        dataAutorizacao: status === "AUTHORIZED" || status === "CANCELLED" ? dataAutorizacao ?? dataEmissao : null,
        destinatarioJson: { tipoPessoa: "PJ", cpfCnpj: "", nome } as unknown as Prisma.InputJsonValue,
        emitenteJson: { cnpj: cnpj ?? "" } as unknown as Prisma.InputJsonValue,
        totaisJson: {
          totalNota: valor,
          totalProdutos: valor,
          totalIcms: 0,
          totalPis: 0,
          totalCofins: 0,
          totalDesconto: 0,
          totalFrete: 0,
        } as unknown as Prisma.InputJsonValue,
        status,
        emittedByUserId: flags.userId,
      };
      await prisma.nfeEmitida.create({ data, select: { id: true } });
      sum.created++;
    } catch (err) {
      if (isUniqueViolation(err)) sum.skipped_existing++;
      else {
        sum.errors++;
        pushCap(sum.details, { numero, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // Avança NfeSequence (serie 1, PRODUCAO) para o próximo número — só p/ frente.
  // Sem --seq-start explícito, deriva do maior número importado + 1.
  const effectiveSeqStart = flags.seqStart ?? sum.numero_max + 1;
  {
    const existingSeq = await prisma.nfeSequence.findUnique({
      where: { userId_ambiente_serie: { userId: flags.userId, ambiente: AMBIENTE, serie: 1 } },
      select: { proximoNumero: true },
    });
    const current = existingSeq?.proximoNumero ?? 1;
    const novo = Math.max(current, effectiveSeqStart);
    sum.seq_de = current;
    sum.seq_para = novo;
    if (!flags.dryRun && !flags.skipSeqAdvance && (novo !== current || !existingSeq)) {
      await prisma.nfeSequence.upsert({
        where: { userId_ambiente_serie: { userId: flags.userId, ambiente: AMBIENTE, serie: 1 } },
        create: { userId: flags.userId, ambiente: AMBIENTE, serie: 1, proximoNumero: novo },
        update: { proximoNumero: novo },
      });
    }
  }

  // Relatório
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(OUT_DIR, `migracao-nfes-${TAG}-${stamp}.json`);
  const report = {
    ...sum,
    cnpjs: [...sum.cnpjs],
    mode: flags.dryRun ? "dry-run" : "apply",
    userId: flags.userId,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`[report] ${reportPath}`);

  console.log(`\n===== RESUMO NF-e ${TAG} =====`);
  console.log(`modo: ${flags.dryRun ? "DRY-RUN (0 escritas)" : "APPLY"}`);
  console.log(`  linhas na base:        ${sum.linhas}`);
  console.log(`  números distintos:     ${sum.numeros_distintos} (${sum.numero_min}–${sum.numero_max})`);
  console.log(`  repetidos colapsados:  ${sum.duplicados_colapsados}`);
  console.log(`  NF-e ${flags.dryRun ? "a criar" : "criadas"}:        ${sum.created}`);
  console.log(`  já existentes (skip):  ${sum.skipped_existing}`);
  console.log(`  por status:            ${JSON.stringify(sum.por_status)}`);
  console.log(`  sem chave:             ${sum.sem_chave}  | CNPJs: ${[...sum.cnpjs].join(", ")}`);
  console.log(`  erros:                 ${sum.errors}`);
  console.log(`  NfeSequence série 1:   ${sum.seq_de} → ${sum.seq_para}${flags.dryRun ? " (dry-run)" : ""}`);
  console.log("===========================\n");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(`[nfe-${TAG}][fatal]`, e);
  await prisma.$disconnect();
  process.exit(1);
});
