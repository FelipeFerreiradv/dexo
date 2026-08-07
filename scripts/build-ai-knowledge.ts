import "./lib/load-env";
import fs from "node:fs";
import path from "node:path";

import prisma from "../app/lib/prisma";
import {
  chunkDocument,
  planReindex,
  type KnowledgeChunk,
  type StoredChunkRef,
} from "../app/ai/knowledge/indexer";
import { KNOWLEDGE_DOCS } from "../app/ai/knowledge/docs";

/**
 * Indexa a base de conhecimento do Bitz: os .md de app/ai/knowledge/content/
 * viram linhas em AiKnowledgeChunk.
 *
 * REINDEXAÇÃO INCREMENTAL. O checksum de cada pedaço é comparado com o do
 * banco: documento inalterado não gera UMA escrita. Documento encurtado tem as
 * posições sobrando apagadas; documento removido do manifesto é apagado
 * inteiro. Rodar duas vezes seguidas produz "0 gravações" na segunda.
 *
 * A tabela é GLOBAL — não tem coluna de tenant e não é dado de cliente
 * nenhum. Este script é a ÚNICA coisa no sistema que escreve nela.
 *
 * DRY-RUN POR PADRÃO. Sem --apply nada é gravado; o relatório mostra
 * exatamente o que seria feito.
 *
 * Uso (SEMPRE npx tsx — `npm run` engole as flags e roda dry-run em silêncio):
 *   npx tsx scripts/build-ai-knowledge.ts              # dry-run
 *   npx tsx scripts/build-ai-knowledge.ts --apply      # grava
 *   npx tsx scripts/build-ai-knowledge.ts --doc=produtos --apply
 *
 * ORDEM DE DEPLOY: DDL da tabela -> prisma generate -> deploy -> este script.
 * Sem ele a tabela fica vazia e o Bitz responde sem base de conhecimento
 * (degradação, não erro).
 */

const CONTENT_DIR = path.resolve(
  __dirname,
  "..",
  "app",
  "ai",
  "knowledge",
  "content",
);

interface Args {
  apply: boolean;
  docId: string | null;
}

function parseArgs(argv: string[]): Args {
  const docArg = argv.find((a) => a.startsWith("--doc="));
  return {
    apply: argv.includes("--apply"),
    docId: docArg ? docArg.slice("--doc=".length) : null,
  };
}

function lerDocumento(docId: string): string {
  const arquivo = path.join(CONTENT_DIR, `${docId}.md`);
  if (!fs.existsSync(arquivo)) {
    throw new Error(
      `Documento declarado em docs.ts mas ausente do disco: ${arquivo}`,
    );
  }
  return fs.readFileSync(arquivo, "utf8");
}

/**
 * Aponta o que ainda depende de você.
 *
 * O marcador `> ⚠️ PENDENTE DE CONFIRMAÇÃO` é a regra da Fase 4: onde eu não
 * consegui confirmar o comportamento lendo o código, eu PERGUNTO em vez de
 * supor. Listá-los a cada indexação evita que virem verdade por esquecimento.
 */
function listarPendencias(docId: string, markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .filter((l) => l.includes("PENDENTE DE CONFIRMAÇÃO"))
    .map((l) => `${docId}: ${l.replace(/^>\s*/, "").trim()}`);
}

async function main() {
  const { apply, docId } = parseArgs(process.argv.slice(2));

  const docs = docId
    ? KNOWLEDGE_DOCS.filter((d) => d.id === docId)
    : KNOWLEDGE_DOCS;

  if (docs.length === 0) {
    throw new Error(
      `Documento desconhecido: ${docId}. Ids válidos: ${KNOWLEDGE_DOCS.map(
        (d) => d.id,
      ).join(", ")}`,
    );
  }

  console.log(
    `[ai:index] ${apply ? "APLICANDO" : "DRY-RUN (use --apply para gravar)"}`,
  );
  console.log(`[ai:index] conteúdo: ${CONTENT_DIR}`);
  console.log(`[ai:index] documentos: ${docs.length}\n`);

  const desejados: KnowledgeChunk[] = [];
  const pendencias: string[] = [];

  for (const doc of docs) {
    const markdown = lerDocumento(doc.id);
    const chunks = chunkDocument(doc.id, markdown);
    desejados.push(...chunks);
    pendencias.push(...listarPendencias(doc.id, markdown));

    const chars = chunks.reduce((acc, c) => acc + c.content.length, 0);
    console.log(
      `  ${doc.id.padEnd(28)} ${String(chunks.length).padStart(3)} pedaços · ${String(
        Math.round(chars / 1000),
      ).padStart(3)} mil caracteres`,
    );
  }

  console.log(
    `\n[ai:index] total: ${desejados.length} pedaços · ${Math.round(
      desejados.reduce((a, c) => a + c.content.length, 0) / 1000,
    )} mil caracteres`,
  );

  if (pendencias.length > 0) {
    console.log(
      `\n[ai:index] ${pendencias.length} ponto(s) aguardando sua confirmação:`,
    );
    for (const p of pendencias) console.log(`  - ${p}`);
  }

  // Com --doc, comparamos SÓ contra o que existe daquele documento — senão o
  // plano acharia que todos os outros sumiram do manifesto e os apagaria.
  let armazenados: StoredChunkRef[];
  try {
    armazenados = await prisma.aiKnowledgeChunk.findMany({
      where: docId ? { docId } : undefined,
      select: { docId: true, ord: true, checksum: true },
    });
  } catch (err: any) {
    // P2021 = tabela ausente. É o estado ANTES da DDL manual em produção, e
    // merece uma instrução em vez de um stack trace.
    if (err?.code === "P2021") {
      console.error(
        "\n[ai:index] a tabela AiKnowledgeChunk ainda não existe neste banco.\n" +
          "           Aplique prisma/migrations/20260807120000_add_ai_knowledge_chunk/migration.sql\n" +
          "           e rode `npx prisma generate` antes de indexar.\n" +
          "           O chunking acima já rodou e está correto — só falta onde gravar.",
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const plano = planReindex(desejados, armazenados);

  console.log("\n[ai:index] plano:");
  console.log(`  gravar .............. ${plano.upserts.length}`);
  console.log(`  inalterados ......... ${plano.unchanged}`);
  console.log(`  apagar (sobra) ...... ${plano.deletes.length}`);
  console.log(
    `  documentos removidos  ${plano.staleDocIds.length}${
      plano.staleDocIds.length ? ` (${plano.staleDocIds.join(", ")})` : ""
    }`,
  );

  if (!apply) {
    console.log("\n[ai:index] dry-run: nada foi gravado.");
    return;
  }

  for (const chunk of plano.upserts) {
    await prisma.aiKnowledgeChunk.upsert({
      where: { docId_ord: { docId: chunk.docId, ord: chunk.ord } },
      create: {
        docId: chunk.docId,
        ord: chunk.ord,
        heading: chunk.heading,
        content: chunk.content,
        search: chunk.search,
        checksum: chunk.checksum,
      },
      update: {
        heading: chunk.heading,
        content: chunk.content,
        search: chunk.search,
        checksum: chunk.checksum,
      },
    });
  }

  for (const alvo of plano.deletes) {
    await prisma.aiKnowledgeChunk.deleteMany({
      where: { docId: alvo.docId, ord: alvo.ord },
    });
  }

  if (plano.staleDocIds.length > 0) {
    await prisma.aiKnowledgeChunk.deleteMany({
      where: { docId: { in: plano.staleDocIds } },
    });
  }

  const total = await prisma.aiKnowledgeChunk.count();
  console.log(`\n[ai:index] pronto. Total na base: ${total} pedaços.`);
}

main()
  .catch((err) => {
    console.error("[ai:index] falhou:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
