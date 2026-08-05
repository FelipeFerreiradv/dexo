import "dotenv/config";
import fs from "fs";
import path from "path";
import prisma from "../app/lib/prisma";
import { detectFile } from "../app/usecases/import/import-detector";
import {
  runVaaptLinks,
  defaultLinksRunnerDeps,
} from "../app/usecases/import/executors/product-links.executor";
import type {
  DetectedFile,
  ImportContext,
  ImportReport,
} from "../app/usecases/import/import.types";

/**
 * Vínculo de LOCALIZAÇÃO por linha de comando, para o relatório de produtos do
 * Vaapt — o mesmo motor da tela de importação, operado por quem migra.
 *
 * PARA QUE SERVE
 *
 * O cliente que já usa o Dexo costuma ter o catálogo criado pela importação de
 * ANÚNCIOS: os produtos existem, mas nenhum tem endereço no galpão. A planilha
 * do Vaapt tem justamente as localizações. Este script leva uma coisa à outra.
 *
 * ⚠️ Ele NÃO CRIA PRODUTO. Só liga localização (e sucata, se o arquivo de
 * veículos vier junto) a produto que JÁ EXISTE. Para criar o que falta, a
 * ferramenta é a entidade VAAPT/PRODUTOS na tela — e num cliente que já tem
 * catálogo isso duplica, então leia o relatório antes.
 *
 * COMO CASA
 *
 * Primeiro pelo `Cod Peça`. Quem não achar produto tenta pela `Etiqueta` —
 * medido num cliente real: `Cod Peça` casava 0 de 28.910, a `Etiqueta` casou
 * 15.894. Só vincula quando a chave aponta para UM único produto. Toda a lógica
 * é a de `lib/etiqueta-match.ts`, coberta por teste; aqui não há regra nova.
 *
 * SEGURANÇA
 *
 * - **Dry-run é o padrão.** Só escreve com `--apply` literal.
 * - `assertBanco()` aborta fora de `sa-east-1` (o script de migração do 704 NÃO
 *   tem essa guarda — foi de onde veio a ideia).
 * - Não fala com o Mercado Livre em nenhum modo: só banco. Diferente do
 *   `migracao-vaapt.ts`, aqui não há risco de rotacionar token nem de marcar a
 *   conta do cliente como ERROR.
 * - Idempotente: rodar de novo não duplica — quem já está no destino certo é
 *   contado como "já correto".
 *
 * USO (PowerShell, a partir da RAIZ do repo)
 *
 *   # 1. ensaio: 200 linhas, sem gravar
 *   .\node_modules\.bin\tsx.cmd scripts\vincular-localizacao-por-etiqueta.ts `
 *     --user-id=<cuid> --arquivo="C:\caminho\parte 1.xlsx" --limit=200
 *
 *   # 2. prévia do arquivo inteiro, sem gravar
 *   .\node_modules\.bin\tsx.cmd scripts\vincular-localizacao-por-etiqueta.ts `
 *     --user-id=<cuid> --arquivo="C:\caminho\parte 1.xlsx"
 *
 *   # 3. aplicar
 *   .\node_modules\.bin\tsx.cmd scripts\vincular-localizacao-por-etiqueta.ts `
 *     --user-id=<cuid> --arquivo="C:\caminho\parte 1.xlsx" --apply
 *
 * ⚠️ NUNCA chame por `npm run` — o npm engole as flags (inclusive o `--apply`)
 * e o script roda em dry-run silencioso. Chame o tsx direto, como acima.
 */

const OUT_DIR = path.resolve(__dirname, "out");

interface Flags {
  userId: string;
  arquivos: string[];
  veiculos: string | null;
  apply: boolean;
  dryRun: boolean;
  limit: number | null;
  offset: number;
}

function parseFlags(argv: string[]): Flags {
  const get = (name: string): string | undefined => {
    const flag = `--${name}=`;
    const found = argv.find((a) => a.startsWith(flag));
    return found ? found.slice(flag.length) : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  const apply = has("apply");
  const limitRaw = get("limit");
  const offsetRaw = get("offset");

  // Aceita --arquivo= repetido, mas o motor usa UM por execução (o mesmo
  // limite da tela). Rodar as partes em sequência é seguro e não duplica.
  const arquivos = argv
    .filter((a) => a.startsWith("--arquivo="))
    .map((a) => a.slice("--arquivo=".length))
    .filter(Boolean);

  return {
    userId: get("user-id") ?? "",
    arquivos,
    veiculos: get("veiculos") ?? null,
    apply,
    // Mesma regra do resto da casa: --dry-run VENCE --apply.
    dryRun: has("dry-run") || !apply,
    limit: limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null,
    offset: offsetRaw && /^\d+$/.test(offsetRaw) ? parseInt(offsetRaw, 10) : 0,
  };
}

/**
 * Aborta se o banco não for o de produção em São Paulo. É a guarda que falta no
 * `migracao-vaapt.ts`: um `.env` de worktree pode apontar para outra região e o
 * script escreveria no lugar errado sem nenhum aviso.
 */
function assertBanco(): void {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^:/?]+)/)?.[1] ?? "(não identificado)";
  if (!host.includes("sa-east-1")) {
    console.error(
      `[abortado] DATABASE_URL aponta para "${host}", que não é o banco de produção (sa-east-1).\n` +
        `           Rode a partir da RAIZ do repositório, não de um worktree com .env próprio.`,
    );
    process.exit(1);
  }
  console.log(`[banco] ${host}`);
}

function lerArquivo(caminho: string): DetectedFile {
  if (!fs.existsSync(caminho)) {
    console.error(`[abortado] arquivo não encontrado: ${caminho}`);
    process.exit(1);
  }
  const detected = detectFile({
    fieldname: "file",
    filename: path.basename(caminho),
    buffer: fs.readFileSync(caminho),
  });
  if (detected.kind !== "VAAPT_PRODUTOS" && detected.kind !== "VAAPT_PECAS") {
    console.error(
      `[abortado] "${detected.filename}" foi reconhecido como ${detected.kind}.\n` +
        `           Este script só aceita o relatório de produtos ou o arquivo-ponte do Vaapt.\n` +
        `           Colunas lidas: ${detected.header.slice(0, 12).join(", ")}`,
    );
    process.exit(1);
  }
  return detected;
}

/** Recorta as linhas ANTES do motor, para o ensaio com --limit. */
function recortar(file: DetectedFile, flags: Flags): DetectedFile {
  if (flags.limit === null && flags.offset === 0) return file;
  const fim = flags.limit !== null ? flags.offset + flags.limit : undefined;
  return { ...file, rows: file.rows.slice(flags.offset, fim) };
}

function n(v: number | undefined): string {
  return (v ?? 0).toLocaleString("pt-BR");
}

function imprimirResumo(rel: ImportReport, dryRun: boolean): void {
  const vinc = rel.porFase?.vinculos;
  const loc = rel.porFase?.localizacoes;
  const c = vinc?.contadores ?? {};

  console.log("\n===== RESUMO =====");
  console.log(`modo: ${dryRun ? "PRÉVIA (nada gravado)" : "APLICADO"}`);
  console.log(`  linhas no arquivo ............. ${n(c.linhas_de_vinculo)}`);
  console.log(`  PRODUTOS CASADOS .............. ${n(c.produtos_casados)}`);
  console.log(`     destes, pela ETIQUETA ...... ${n(c.casados_pela_etiqueta)}`);
  console.log(`  etiquetas ambíguas (puladas) .. ${n(c.etiqueta_ambigua)}`);
  console.log(`  sem produto no Dexo ........... ${n(rel.semProduto?.total)}`);
  console.log(`  SKU ambíguo ................... ${n(c.sku_ambiguo)}`);
  // ⚠️ Os nomes dos contadores vêm do `executeLocationPlan` e são três, não um:
  // `a_criar` só existe em dry-run, `criadas` só no apply, e `ja_existiam` nos
  // dois. A 1ª versão deste script leu um nome que NÃO EXISTE
  // (`localizacoes_criadas`) e caía no tamanho do plano — na parte 2 da
  // migração real isso imprimiu "480 criadas" quando foram 107 criadas e 373
  // reaproveitadas. O número no banco estava certo; o relatório mentia.
  const locCriadas = dryRun
    ? loc?.contadores.a_criar
    : loc?.contadores.criadas;
  const locJaExistiam = loc?.contadores.ja_existiam;
  console.log(
    `  localizações no arquivo ....... ${n(loc?.contadores.localizacoes_distintas)}`,
  );
  console.log(
    `     ${dryRun ? "a criar" : "criadas"} .................... ${n(locCriadas)}`,
  );
  console.log(`     já existiam ................ ${n(locJaExistiam)}`);
  console.log(
    `  vínculos de localização ....... ` +
      `${n(c.local_vinculado ?? c.local_a_vincular)}`,
  );
  console.log(`  já estavam corretos ........... ${n(c.local_ja_correto)}`);
  console.log(`  erros ......................... ${n(rel.contadores.erros)}`);
  console.log("==================");

  const avisos = [
    ...(rel.avisos ?? []),
    ...(vinc?.avisos ?? []),
    ...(loc?.avisos ?? []),
  ];
  if (avisos.length > 0) {
    console.log("\n----- AVISOS -----");
    for (const a of avisos.slice(0, 8)) {
      console.log(`  • ${a.motivo}`);
    }
    if (avisos.length > 8) console.log(`  … e mais ${avisos.length - 8}.`);
  }
  if (rel.semProduto && rel.semProduto.total > 0) {
    console.log(
      `\n[nota] ${n(rel.semProduto.total)} peça(s) da planilha não existem no Dexo — ` +
        `este script não cria produto. Exemplos de código: ` +
        `${rel.semProduto.exemplos.slice(0, 5).join(", ")}`,
    );
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  if (!flags.userId || flags.arquivos.length === 0) {
    console.error(
      "uso: tsx scripts/vincular-localizacao-por-etiqueta.ts --user-id=<cuid> --arquivo=<.xlsx> [--apply] [--limit=N] [--offset=N] [--veiculos=<.xlsx>]",
    );
    process.exit(1);
  }
  if (flags.arquivos.length > 1) {
    console.error(
      `[abortado] recebi ${flags.arquivos.length} arquivos. Envie UM por execução — ` +
        `rodar as partes em sequência é seguro e não duplica.`,
    );
    process.exit(1);
  }

  assertBanco();

  const user = await prisma.user.findUnique({
    where: { id: flags.userId },
    select: { id: true, email: true, name: true, role: true, parentUserId: true },
  });
  if (!user) {
    console.error(`[abortado] usuário ${flags.userId} não existe.`);
    process.exit(1);
  }

  const original = lerArquivo(flags.arquivos[0]);
  const file = recortar(original, flags);
  const files: DetectedFile[] = [file];
  if (flags.veiculos) files.push(lerArquivo(flags.veiculos));

  // O RECIBO: confira esta linha antes de qualquer coisa.
  console.log(
    `[vinculo-etiqueta] modo=${flags.dryRun ? "DRY-RUN" : "APPLY"} ` +
      `user=${user.email} arquivo="${file.filename}" tipo=${file.kind} ` +
      `linhas=${file.rows.length}${
        flags.limit !== null ? ` (recorte de ${original.rows.length})` : ""
      }`,
  );
  if (user.parentUserId !== null) {
    console.warn(
      `[aviso] o alvo é um COLABORADOR (parentUserId=${user.parentUserId}), não o dono da conta.`,
    );
  }

  const antes = await prisma.product.count({
    where: { userId: flags.userId, locationId: { not: null } },
  });
  console.log(`[antes] produtos com localização: ${n(antes)}`);

  const ctx: ImportContext = {
    targetUserId: flags.userId,
    files,
    dryRun: flags.dryRun,
    onProgress: ({ fase, processadas, total }) => {
      if (processadas % 2000 === 0 || processadas === total) {
        console.log(`  … ${fase}: ${n(processadas)}/${n(total)}`);
      }
    },
  };

  const rel = await runVaaptLinks(ctx, defaultLinksRunnerDeps);
  imprimirResumo(rel, flags.dryRun);

  const depois = await prisma.product.count({
    where: { userId: flags.userId, locationId: { not: null } },
  });
  console.log(
    `\n[depois] produtos com localização: ${n(depois)}  (Δ ${depois - antes >= 0 ? "+" : ""}${n(depois - antes)})`,
  );
  if (flags.dryRun && depois !== antes) {
    console.warn("[ATENÇÃO] a prévia não deveria mudar nada — investigue.");
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destino = path.join(OUT_DIR, `vinculo-etiqueta-${stamp}.json`);
  fs.writeFileSync(
    destino,
    JSON.stringify(
      {
        modo: flags.dryRun ? "dry-run" : "apply",
        userId: flags.userId,
        email: user.email,
        arquivo: file.filename,
        tipo: file.kind,
        linhas: file.rows.length,
        produtosComLocalizacaoAntes: antes,
        produtosComLocalizacaoDepois: depois,
        relatorio: rel,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`[relatorio] ${destino}`);
}

main()
  .catch((e) => {
    console.error("[vinculo-etiqueta][fatal]", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
