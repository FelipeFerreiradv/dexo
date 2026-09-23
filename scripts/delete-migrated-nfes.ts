import "dotenv/config";
import path from "path";
import fs from "fs";
import prisma from "../app/lib/prisma";
import {
  ORDEM_SEQUENCIA,
  carregarConfigsFiscais,
  resolverEscopoSequencia,
  soDigitos,
  whereSequencia,
  type EscopoSequencia,
} from "./lib/nfe-sequence-scope";

/**
 * Apaga NF-e criadas por uma MIGRAÇÃO (identificadas pelo marcador gravado em
 * `informacoesComplementares`, ex.: "Migração MESQUITA · histórico (invoicy)"),
 * e opcionalmente reseta a `NfeSequence` que a migração avançou.
 *
 * Caso de uso: a base de NF-e foi importada para o CLIENTE ERRADO.
 *
 * SEGURANÇA (trava dupla):
 *   - Só considera NF-e do userId informado E cujo `informacoesComplementares`
 *     contenha o `--marker`. Nunca toca em notas sem o marcador (rascunhos,
 *     notas reais do cliente, etc.).
 *   - RECUSA apagar qualquer nota que tenha ITENS (> 0) ou `orderId` vinculado
 *     — essas são notas reais, não registros históricos da migração.
 *   - Sem `--apply` não escreve nada.
 *   - `--reset-sequence` APAGA uma linha de `NfeSequence`, que é POR CNPJ: num
 *     tenant multi-CNPJ, apagar a linha errada zera a numeração de uma empresa
 *     que nada tinha com a migração. Por isso a linha é escolhida pelo escopo
 *     do emitente (`scripts/lib/nfe-sequence-scope.ts`), que ABORTA quando o
 *     tenant tem mais de uma `CompanyFiscalConfig` e nada diz qual é.
 *
 *   npx tsx scripts/delete-migrated-nfes.ts --user-id=<ID> --marker="Migração MESQUITA" --dry-run
 *   npx tsx scripts/delete-migrated-nfes.ts --user-id=<ID> --marker="Migração MESQUITA" --reset-sequence --apply
 *   npx tsx scripts/delete-migrated-nfes.ts --user-id=<ID> --marker="..." --config-id=<CFC> --reset-sequence --apply
 */

const OUT_DIR = path.resolve(__dirname, "out");

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const f = process.argv.slice(2).find((a) => a.startsWith(p));
  return f ? f.slice(p.length) : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run") || !apply;
  const resetSequence = argv.includes("--reset-sequence");
  const userId = arg("user-id") ?? "";
  const marker = arg("marker") ?? "";
  const ambiente = arg("ambiente") ?? "PRODUCAO";
  const serieRaw = arg("serie");
  const serie = serieRaw && /^\d+$/.test(serieRaw) ? parseInt(serieRaw, 10) : 1;
  // Multi-CNPJ: de qual emitente é o contador. Vazio = deriva da chave de acesso
  // das próprias notas marcadas.
  const configIdFlag = arg("config-id") ?? null;
  const cnpjFlag = arg("cnpj") ?? null;

  if (!userId) throw new Error("Informe --user-id=<cuid>. Abortando.");
  if (!marker) throw new Error('Informe --marker="<texto do marcador>". Abortando.');

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) throw new Error(`Usuário ${userId} não encontrado.`);
  console.log(`[del-nfes] user=${user.email} marker="${marker}" modo=${dryRun ? "DRY-RUN" : "APPLY"}`);

  const totalDoUser = await prisma.nfeEmitida.count({ where: { userId } });

  const candidatas = await prisma.nfeEmitida.findMany({
    where: { userId, informacoesComplementares: { contains: marker } },
    select: {
      id: true,
      serie: true,
      numero: true,
      status: true,
      ambiente: true,
      orderId: true,
      // O CNPJ do emitente mora nas posições 6..20 da chave — é o que resolve,
      // sem flag, de qual empresa é o contador a resetar.
      chaveAcesso: true,
      _count: { select: { itens: true } },
    },
  });

  const sum = {
    nfe_total_do_user: totalDoUser,
    com_marcador: candidatas.length,
    sem_marcador_preservadas: totalDoUser - candidatas.length,
    recusadas_com_itens_ou_pedido: 0,
    apagadas: 0,
    por_status: {} as Record<string, number>,
    numero_min: 0,
    numero_max: 0,
    sequence: null as unknown,
    errors: 0,
  };

  const deletaveis: string[] = [];
  const recusadas: unknown[] = [];
  for (const n of candidatas) {
    const c = n._count as unknown as Record<string, number>;
    if (c.itens > 0 || n.orderId) {
      sum.recusadas_com_itens_ou_pedido++;
      recusadas.push({ id: n.id, serie: n.serie, numero: n.numero, itens: c.itens, orderId: n.orderId });
      continue;
    }
    sum.por_status[n.status] = (sum.por_status[n.status] ?? 0) + 1;
    deletaveis.push(n.id);
  }
  const nums = candidatas.map((n) => n.numero).filter((x) => Number.isFinite(x));
  sum.numero_min = nums.length ? Math.min(...nums) : 0;
  sum.numero_max = nums.length ? Math.max(...nums) : 0;

  // Multi-CNPJ: de QUAL emitente é o contador desta (ambiente, série). A dica
  // sai da chave de acesso das notas marcadas DESTA série; sem ela e com mais
  // de um CNPJ no tenant, o resolvedor lança em vez de escolher — apagar a
  // linha errada zera a numeração de uma empresa que nada tinha com a migração.
  const cnpjsDaSerie = new Set<string>();
  for (const n of candidatas) {
    if (n.ambiente !== ambiente || n.serie !== serie) continue;
    const ch = n.chaveAcesso;
    if (ch && /^\d{44}$/.test(ch)) cnpjsDaSerie.add(ch.slice(6, 20));
  }
  // Resolvido ANTES de apagar nota nenhuma: com --reset-sequence, tenant
  // ambíguo aborta sem estrago em vez de parar com as notas já fora e a
  // numeração em aberto. SEM --reset-sequence a ambiguidade NÃO é fatal — o
  // script não encosta na numeração, a NfeSequence só entra no relatório, e
  // derrubar o apagamento por causa dela seria regressão de uma função que
  // nada tem a ver com este defeito.
  let escopoSeq: EscopoSequencia | null = null;
  let escopoErro: string | null = null;
  try {
    escopoSeq = resolverEscopoSequencia(await carregarConfigsFiscais(prisma, userId), {
      configId: configIdFlag,
      cnpj: soDigitos(cnpjFlag) || (cnpjsDaSerie.size === 1 ? [...cnpjsDaSerie][0] : null),
    });
    console.log(`[del-nfes] contador ${ambiente}/série ${serie}: emitente por ${escopoSeq.motivo}`);
  } catch (err) {
    escopoErro = err instanceof Error ? err.message : String(err);
    if (resetSequence) throw err;
    console.warn(`[del-nfes] NfeSequence fica FORA do relatório: ${escopoErro}`);
  }

  if (!dryRun && deletaveis.length > 0) {
    const CH = 300;
    for (let i = 0; i < deletaveis.length; i += CH) {
      const ids = deletaveis.slice(i, i + CH);
      try {
        await prisma.$transaction([
          prisma.nfeItem.deleteMany({ where: { nfeId: { in: ids } } }),
          prisma.nfeEmitida.deleteMany({ where: { id: { in: ids } } }),
        ]);
        sum.apagadas += ids.length;
      } catch (err) {
        sum.errors += ids.length;
        console.error(`[del-nfes] erro no lote ${i}:`, err instanceof Error ? err.message : String(err));
      }
    }
  } else if (dryRun) {
    sum.apagadas = deletaveis.length;
  }

  // Reset da NfeSequence avançada pela migração (restaura o estado anterior).
  // Multi-CNPJ: o @@unique composto saiu do schema — findFirst + delete por
  // id (forma válida no client velho E novo). O `where` carrega o recorte por
  // EMITENTE; o `orderBy` (ASC = NULLS LAST) prefere a linha já adotada à
  // legada NULL, igual ao NfeSequenceService.
  const seqAtual = escopoSeq
    ? await prisma.nfeSequence.findFirst({
        where: whereSequencia({ userId, ambiente, serie, modelo: "55" }, escopoSeq),
        orderBy: ORDEM_SEQUENCIA,
        select: { id: true, proximoNumero: true },
      })
    : null;
  const seqBase = { ambiente, serie, emitente: escopoSeq?.motivo ?? `INDETERMINADO — ${escopoErro}` };
  sum.sequence = { ...seqBase, proximoNumero_atual: seqAtual?.proximoNumero ?? null, acao: "nenhuma" };
  if (resetSequence && seqAtual) {
    if (dryRun) {
      sum.sequence = { ...seqBase, proximoNumero_atual: seqAtual.proximoNumero, acao: "APAGARIA a linha" };
    } else {
      await prisma.nfeSequence.delete({ where: { id: seqAtual.id } });
      sum.sequence = { ...seqBase, proximoNumero_atual: seqAtual.proximoNumero, acao: "linha APAGADA (volta a 1)" };
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(OUT_DIR, `delete-migrated-nfes-${stamp}.json`),
    JSON.stringify({ userId, marker, mode: dryRun ? "dry-run" : "apply", ...sum, recusadas }, null, 2),
    "utf8",
  );

  console.log("\n===== RESUMO — apagar NF-e da migração =====");
  console.log(`modo: ${dryRun ? "DRY-RUN (0 exclusões)" : "APPLY"}`);
  console.log(`  NF-e totais do usuário:        ${sum.nfe_total_do_user}`);
  console.log(`  com o marcador (alvo):         ${sum.com_marcador}  (nº ${sum.numero_min}–${sum.numero_max})`);
  console.log(`  SEM marcador (preservadas):    ${sum.sem_marcador_preservadas}`);
  console.log(`  recusadas (itens/pedido):      ${sum.recusadas_com_itens_ou_pedido}`);
  console.log(`  ${dryRun ? "apagaria" : "apagadas"}:                     ${sum.apagadas}`);
  console.log(`  por status:                    ${JSON.stringify(sum.por_status)}`);
  console.log(`  NfeSequence:                   ${JSON.stringify(sum.sequence)}`);
  console.log(`  erros:                         ${sum.errors}`);
  console.log("===========================================\n");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[del-nfes][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
