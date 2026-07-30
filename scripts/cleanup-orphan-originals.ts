/**
 * Cleanup de arquivos `<uuid>.orig.<ext>` em public/uploads/ que não são
 * mais referenciados por nenhum produto/anúncio.
 *
 * O endpoint POST /upload/image grava sempre um `<uuid>.orig.<ext>` ao
 * lado da versão processada (`<uuid>.<format>`), preservando o original
 * caso seja necessário reprocessar. Ao longo do tempo, originais cujo
 * produto/anúncio referenciador foi removido viram lixo no disco.
 *
 * Critério de seleção (idempotente, conservador):
 *   - arquivo é `*.orig.*` em public/uploads/
 *   - o UUID extraído do nome NÃO aparece em:
 *       Product.imageUrl, Product.imageUrls, ProductListing.imageUrlsOverride
 *   - mtime > MIN_AGE_DAYS atrás (default 30) — evita corrida com upload
 *     em voo
 *
 * Modos:
 *   - default (dry-run): lista o que seria deletado e o tamanho total
 *   - --execute / --apply: deleta de fato
 *
 * Uso:
 *   npx tsx scripts/cleanup-orphan-originals.ts
 *   npx tsx scripts/cleanup-orphan-originals.ts --execute
 *   npx tsx scripts/cleanup-orphan-originals.ts --min-age-days=7
 */

import { PrismaClient } from "@prisma/client";
import { readdir, stat, unlink } from "fs/promises";
import { join } from "path";

const prisma = new PrismaClient();

const UPLOAD_DIR = join(process.cwd(), "public", "uploads");
const UUID_REGEX =
  /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;
// Regex que casa especificamente o padrão de nome de arquivo do upload:
//   <uuid>.orig.<ext>
const ORIG_FILENAME_REGEX =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.orig\.[a-zA-Z0-9]+$/;

interface CliOptions {
  execute: boolean;
  minAgeDays: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute") || args.includes("--apply");
  let minAgeDays = 30;
  for (const arg of args) {
    const m = arg.match(/^--min-age-days[=\s]+(\d+)$/);
    if (m) minAgeDays = Number(m[1]);
  }
  if (!Number.isFinite(minAgeDays) || minAgeDays < 0) {
    throw new Error("min-age-days deve ser inteiro >= 0");
  }
  return { execute, minAgeDays };
}

function extractUuidsFromUrl(url: string, target: Set<string>): void {
  if (!url) return;
  const m = url.match(UUID_REGEX);
  if (m) target.add(m[1]);
}

async function collectInUseUuids(): Promise<Set<string>> {
  const inUse = new Set<string>();

  const products = await prisma.product.findMany({
    select: { imageUrl: true, imageUrls: true },
  });
  for (const p of products) {
    if (p.imageUrl) extractUuidsFromUrl(p.imageUrl, inUse);
    for (const url of p.imageUrls ?? []) extractUuidsFromUrl(url, inUse);
  }

  const listings = await prisma.productListing.findMany({
    select: { imageUrlsOverride: true },
  });
  for (const l of listings) {
    for (const url of l.imageUrlsOverride ?? []) extractUuidsFromUrl(url, inUse);
  }

  // Lacuna pré-existente corrigida no PR 4: sucatas também referenciam
  // uploads (create-scrap-dialog usa o MESMO componente de upload).
  const scraps = await prisma.scrap.findMany({
    select: { imageUrls: true },
  });
  for (const s of scraps) {
    for (const url of s.imageUrls ?? []) extractUuidsFromUrl(url, inUse);
  }

  // Jobs do recorte assíncrono (PR 4): o worker lê o `.orig` do disco para
  // processar — apagar o original de um job vivo quebraria o recorte. Rows
  // COMPLETED/FAILED também protegem (o retry manual relê o .orig).
  const jobs = await (prisma as any).imageBgJob.findMany({
    select: { uploadUuid: true },
  });
  for (const j of jobs) {
    if (j.uploadUuid) inUse.add(j.uploadUuid);
  }

  return inUse;
}

interface OrphanCandidate {
  filename: string;
  uuid: string;
  fullPath: string;
  sizeBytes: number;
  mtime: Date;
}

async function listOrigCandidates(
  minAgeDays: number,
): Promise<OrphanCandidate[]> {
  let entries: string[];
  try {
    entries = await readdir(UPLOAD_DIR);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(`[cleanup] Diretório ${UPLOAD_DIR} não existe — nada a fazer.`);
      return [];
    }
    throw err;
  }

  const cutoff = Date.now() - minAgeDays * 24 * 60 * 60 * 1000;
  const candidates: OrphanCandidate[] = [];

  for (const filename of entries) {
    const match = filename.match(ORIG_FILENAME_REGEX);
    if (!match) continue;
    const uuid = match[1];
    const fullPath = join(UPLOAD_DIR, filename);
    const st = await stat(fullPath);
    if (st.mtimeMs > cutoff) continue; // muito recente, pula
    candidates.push({
      filename,
      uuid,
      fullPath,
      sizeBytes: st.size,
      mtime: st.mtime,
    });
  }

  return candidates;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Retenção dos jobs de recorte assíncrono: terminais com mais de 90 dias
 *  são removidos (execute mode) — senão a proteção de `.orig` deles seria
 *  eterna e a tabela cresceria sem limite. Jobs vivos nunca são tocados. */
async function pruneOldImageBgJobs(execute: boolean): Promise<void> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  if (!execute) {
    const count = await (prisma as any).imageBgJob.count({
      where: {
        status: { in: ["COMPLETED", "FAILED"] },
        updatedAt: { lt: cutoff },
      },
    });
    if (count > 0) {
      console.log(
        `[cleanup] ${count} ImageBgJob terminal(is) com >90d seriam removidos (execute).`,
      );
    }
    return;
  }
  const removed = await (prisma as any).imageBgJob.deleteMany({
    where: {
      status: { in: ["COMPLETED", "FAILED"] },
      updatedAt: { lt: cutoff },
    },
  });
  if (removed.count > 0) {
    console.log(`[cleanup] ${removed.count} ImageBgJob terminal(is) removido(s).`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs();
  console.log(
    `[cleanup] Modo ${opts.execute ? "EXECUTE (vai deletar)" : "DRY-RUN"}; min-age-days=${opts.minAgeDays}`,
  );

  // Poda de jobs ANTES de coletar os in-use: um job terminal recém-podado
  // libera o `.orig` correspondente já nesta execução.
  await pruneOldImageBgJobs(opts.execute);

  const [inUse, candidates] = await Promise.all([
    collectInUseUuids(),
    listOrigCandidates(opts.minAgeDays),
  ]);

  console.log(
    `[cleanup] Encontrados ${candidates.length} arquivo(s) .orig elegíveis (idade >= ${opts.minAgeDays} dias).`,
  );
  console.log(
    `[cleanup] ${inUse.size} UUID(s) ainda referenciados por algum produto/anúncio.`,
  );

  const orphans = candidates.filter((c) => !inUse.has(c.uuid));
  const totalSize = orphans.reduce((acc, c) => acc + c.sizeBytes, 0);

  if (orphans.length === 0) {
    console.log("[cleanup] Nenhum órfão encontrado. Tudo limpo.");
    return;
  }

  console.log(
    `[cleanup] ${orphans.length} órfão(s) totalizando ${formatSize(totalSize)}.`,
  );

  for (const o of orphans) {
    const tag = opts.execute ? "DELETE" : "would-delete";
    console.log(
      `  [${tag}] ${o.filename}  (${formatSize(o.sizeBytes)}, mtime=${o.mtime.toISOString()})`,
    );
  }

  if (!opts.execute) {
    console.log(
      `\n[cleanup] DRY-RUN: nada foi alterado. Reexecute com --execute para deletar de fato.`,
    );
    return;
  }

  let deleted = 0;
  let freed = 0;
  for (const o of orphans) {
    try {
      await unlink(o.fullPath);
      deleted += 1;
      freed += o.sizeBytes;
    } catch (err) {
      console.warn(
        `  [skip] ${o.filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(
    `\n[cleanup] Deletados ${deleted}/${orphans.length} arquivos (${formatSize(freed)} liberados).`,
  );
}

main()
  .catch((err) => {
    console.error("[cleanup] erro fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
