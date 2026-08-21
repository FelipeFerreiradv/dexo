// PRIMEIRA linha de propósito: `import "dotenv/config"` só olha o cwd, e um
// worktree não tem `.env` próprio (ele fica no checkout principal). Sem isto o
// Prisma explode já no import com "Invalid value undefined for datasource".
import "./lib/load-env";
import fs from "node:fs";
import path from "node:path";
import prisma from "../app/lib/prisma";

/**
 * Backfill de `MarketplaceQuestion.readAt` — limpeza do passivo de não lidas.
 *
 * O PORQUÊ (diagnóstico de 21/08/2026): `upsertFromMl` e
 * `upsertFromShopeeComment` criavam toda pergunta com `readAt` NULL, inclusive
 * as que chegavam ao Dexo JÁ respondidas. Em produção isso deixou 7.562 linhas
 * não lidas, das quais 4.173 (55%) tinham resposta anexada e 98,9% estavam em
 * conversas que ninguém nunca abriu. O maior tenant via 1.383 no badge com
 * apenas 40 alcançáveis pela lista.
 *
 * A correção no código impede o passivo de CRESCER. Este script limpa o que já
 * existe. Rodar SÓ DEPOIS de a correção estar em produção — senão o número
 * volta a subir pelo bug ainda vivo.
 *
 * CRITÉRIO (aprovado em 21/08/2026) — marca como lida a linha com `readAt` NULL
 * que satisfaça QUALQUER uma:
 *   1. tem `MarketplaceAnswer` associada (foi respondida);
 *   2. está em estado terminal (nunca poderá ser respondida);
 *   3. foi criada antes do corte `--ate` (passivo histórico).
 *
 * NUNCA toca em pergunta sem resposta, em estado respondível e dentro da
 * janela — essa é a caixa de entrada de verdade.
 *
 * Valor gravado: COALESCE(resposta.dateCreated, pergunta.dateCreated) —
 * coerente no tempo (nunca no futuro do evento) e auditável depois.
 *
 * Uso:
 *   npx tsx scripts/backfill-question-read-at.ts                        # dry-run
 *   npx tsx scripts/backfill-question-read-at.ts --dias=30              # dry-run, outra janela
 *   npx tsx scripts/backfill-question-read-at.ts --ate=2026-07-22 --apply
 *
 * `--ate` é OBRIGATÓRIO no `--apply`, e o dry-run imprime o valor a usar: com
 * janela relativa, rodar de novo daqui a um mês varreria linhas novas, e o
 * requisito é que reexecutar não altere nada.
 */

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");

/** Estados em que a pergunta não pede mais ação do vendedor. */
const STATUS_TERMINAIS = ["ANSWERED", "CLOSED_UNANSWERED", "BANNED", "DELETED"];

function argValor(nome: string): string | null {
  const hit = argv.find((a) => a.startsWith(`--${nome}=`));
  return hit ? hit.slice(nome.length + 3) : null;
}

/**
 * Trava de ambiente: produção vive em São Paulo. Um `--apply` disparado contra
 * um `.env` de worktree apontando para outra região gravaria em silêncio no
 * lugar errado — já aconteceu neste projeto.
 * (Espelha `scripts/apply-branch-alias-leaves.ts`.)
 */
function assertBanco(): string {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^/:]+)/)?.[1] ?? "";
  if (!host) throw new Error("DATABASE_URL ausente ou ilegível — abortando.");
  if (apply && !host.includes("sa-east-1")) {
    throw new Error(
      `--apply bloqueado: host "${host}" não é sa-east-1 (produção São Paulo).`,
    );
  }
  return host;
}

/** Resolve o corte: `--ate=YYYY-MM-DD` explícito, ou hoje menos `--dias`. */
function resolverCorte(): Date {
  const ate = argValor("ate");
  if (ate) {
    const d = new Date(`${ate}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`--ate inválido: "${ate}" (esperado YYYY-MM-DD).`);
    }
    return d;
  }
  if (apply) {
    throw new Error(
      "--apply exige --ate=YYYY-MM-DD explícito (o dry-run imprime o valor). " +
        "Com janela relativa, reexecutar varreria linhas novas.",
    );
  }
  const dias = Number.parseInt(argValor("dias") ?? "30", 10);
  if (!Number.isFinite(dias) || dias < 0) {
    throw new Error(`--dias inválido: "${argValor("dias")}".`);
  }
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - dias);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

interface Linha {
  email: string | null;
  platform: string;
  accountName: string;
  contaStatus: string;
  nao_lidas: bigint;
  alvo: bigint;
}

/** Contagem por conta: quantas não lidas existem e quantas o critério pega. */
async function contar(corte: Date): Promise<Linha[]> {
  return prisma.$queryRaw<Linha[]>`
    SELECT u.email,
           a.platform::text AS platform,
           a."accountName",
           a.status::text AS "contaStatus",
           count(*) AS nao_lidas,
           count(*) FILTER (
             WHERE ans.id IS NOT NULL
                OR q.status = ANY(${STATUS_TERMINAIS})
                OR q."dateCreated" < ${corte}
           ) AS alvo
      FROM "MarketplaceQuestion" q
      JOIN "MarketplaceAccount" a ON a.id = q."marketplaceAccountId"
      JOIN "User" u ON u.id = a."userId"
      LEFT JOIN "MarketplaceAnswer" ans ON ans."questionId" = q.id
     WHERE q."readAt" IS NULL
     GROUP BY 1, 2, 3, 4
     ORDER BY nao_lidas DESC
  `;
}

/** Ids que o critério pega — salvos ANTES de gravar, para poder desfazer. */
async function idsAlvo(corte: Date): Promise<{ id: string }[]> {
  return prisma.$queryRaw<{ id: string }[]>`
    SELECT q.id
      FROM "MarketplaceQuestion" q
      LEFT JOIN "MarketplaceAnswer" ans ON ans."questionId" = q.id
     WHERE q."readAt" IS NULL
       AND (ans.id IS NOT NULL
            OR q.status = ANY(${STATUS_TERMINAIS})
            OR q."dateCreated" < ${corte})
  `;
}

function imprimirTabela(linhas: Linha[], titulo: string): void {
  console.log(`\n${titulo}`);
  console.log(
    "email".padEnd(38) +
      "plataforma".padEnd(15) +
      "conta".padEnd(28) +
      "st".padEnd(9) +
      "naoLidas".padStart(9) +
      "alvo".padStart(8),
  );
  for (const l of linhas.slice(0, 40)) {
    console.log(
      (l.email ?? "-").slice(0, 37).padEnd(38) +
        l.platform.padEnd(15) +
        l.accountName.slice(0, 27).padEnd(28) +
        l.contaStatus.padEnd(9) +
        String(l.nao_lidas).padStart(9) +
        String(l.alvo).padStart(8),
    );
  }
  if (linhas.length > 40) {
    console.log(`... e mais ${linhas.length - 40} conta(s)`);
  }
  const totalNaoLidas = linhas.reduce((s, l) => s + Number(l.nao_lidas), 0);
  const totalAlvo = linhas.reduce((s, l) => s + Number(l.alvo), 0);
  console.log(
    `\nTOTAL: ${totalNaoLidas} não lidas | ${totalAlvo} seriam marcadas | ` +
      `${totalNaoLidas - totalAlvo} permaneceriam`,
  );
}

async function run() {
  const host = assertBanco();
  const corte = resolverCorte();
  const corteIso = corte.toISOString().slice(0, 10);

  console.log(`Banco : ${host}`);
  console.log(`Modo  : ${apply ? "APPLY (grava)" : "DRY-RUN (nao grava nada)"}`);
  console.log(`Corte : dateCreated < ${corte.toISOString()}`);
  console.log(`Terminais: ${STATUS_TERMINAIS.join(", ")}`);

  const antes = await contar(corte);
  imprimirTabela(antes, "===== ANTES =====");

  if (!apply) {
    console.log(
      `\nNada foi gravado. Para aplicar:\n` +
        `  npx tsx scripts/backfill-question-read-at.ts --ate=${corteIso} --apply\n` +
        `(o --ate fixo torna a reexecucao um no-op de verdade)`,
    );
    return;
  }

  const ids = await idsAlvo(corte);
  const dir = path.join(process.cwd(), "scripts", "out");
  fs.mkdirSync(dir, { recursive: true });
  // Timestamp do relógio na hora da execução — script de CLI, não build id.
  const carimbo = new Date().toISOString().replace(/[:.]/g, "-");
  const arquivo = path.join(dir, `backfill-question-read-at-${carimbo}.json`);
  fs.writeFileSync(
    arquivo,
    JSON.stringify(
      {
        corte: corte.toISOString(),
        total: ids.length,
        ids: ids.map((r) => r.id),
      },
      null,
      2,
    ),
  );
  console.log(`\nIds afetados salvos para desfazer: ${arquivo} (${ids.length})`);

  // `updateMany` do Prisma não sabe copiar de outra coluna; daí o UPDATE ... FROM.
  const afetadas = await prisma.$executeRaw`
    UPDATE "MarketplaceQuestion" q
       SET "readAt" = COALESCE(ans."dateCreated", q."dateCreated")
      FROM "MarketplaceQuestion" alvo
      LEFT JOIN "MarketplaceAnswer" ans ON ans."questionId" = alvo.id
     WHERE q.id = alvo.id
       AND q."readAt" IS NULL
       AND (ans.id IS NOT NULL
            OR q.status = ANY(${STATUS_TERMINAIS})
            OR q."dateCreated" < ${corte})
  `;
  console.log(`\n${afetadas} linha(s) marcada(s) como lida(s).`);

  const depois = await contar(corte);
  imprimirTabela(depois, "===== DEPOIS =====");
  console.log(
    "\nRodar de novo com o MESMO --ate nao altera nada (o filtro e readAt IS NULL).",
  );
}

run()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
