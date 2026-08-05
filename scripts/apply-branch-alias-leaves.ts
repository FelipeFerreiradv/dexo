/**
 * apply-branch-alias-leaves.ts — aplica a planilha preenchida por
 * `scripts/report-branch-aliases.ts`, repontando os aliases que apontam para
 * uma categoria-GALHO para a FOLHA que o humano escolheu.
 *
 * DRY-RUN por padrão: sem `--apply` nada é escrito, só o relatório do que
 * mudaria. Com `--apply`, faz UPDATE de `CategoryAlias.marketplaceCategoryId`.
 *
 * ── Por que UPDATE cirúrgico e não reimportar a planilha original ──
 * `scripts/import-category-aliases.ts` faz `deleteMany` + `createMany` do site
 * inteiro a partir de `categorizacao_mercado_livre_sugerida.xlsx`. Reimportar
 * exigiria ter aquele arquivo atualizado e reescreveria `tokens`, `synonyms` e
 * `brandModelPatterns` de TODOS os 19.485 aliases — inclusive os 9.253 que já
 * apontam para folha e estão certos. Aqui só a coluna do vínculo muda, nos
 * aliases que a decisão humana cobre. O resto do dado fica intacto.
 *
 * ── Como a linha da planilha encontra os aliases ──
 * A chave é a mesma tripla que o relatório usou para agrupar:
 *   Galho_ExternalId + Tipo_De_Peca + Folha_Sugerida
 * O tipo de peça é recalculado com `extractPartType`, o MESMO parser do motor
 * de inferência, e `Folha_Sugerida` é o filho que o título nomeia. Não altere
 * nem renomeie essas três colunas na planilha — sem elas a linha não casa.
 *
 * ── Uso ──
 *   npx tsx scripts/apply-branch-alias-leaves.ts --in=planilha.xlsx
 *   npx tsx scripts/apply-branch-alias-leaves.ts --in=planilha.xlsx --apply
 *   npx tsx scripts/apply-branch-alias-leaves.ts --in=planilha.xlsx --site=SHP
 */

import "dotenv/config";
import path from "node:path";
import XLSX from "xlsx";
import prisma from "../app/lib/prisma";
import {
  extractPartType,
  normalizeText,
} from "../app/marketplaces/lib/title-parse";

const apply = process.argv.includes("--apply");

interface Args {
  siteId: string;
  inPath: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { siteId: "MLB", inPath: null };
  for (const a of argv) {
    if (a.startsWith("--site=")) args.siteId = a.slice(7).toUpperCase();
    else if (a.startsWith("--in=")) args.inPath = path.resolve(a.slice(5));
  }
  return args;
}

const leafSegment = (fullPath?: string | null) => {
  const parts = (fullPath ?? "").split(">");
  return (parts[parts.length - 1] || "").trim();
};

/** Igual ao do relatório — precisa casar exatamente para a chave bater. */
function childNamedByTitle(
  pseudoTitulo: string,
  children: { externalId: string; fullPath: string | null; name: string }[],
): string | null {
  const toks = new Set(
    normalizeText(pseudoTitulo)
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  let hit: string | null = null;
  let hits = 0;
  for (const c of children) {
    const nome = leafSegment(c.fullPath) || c.name;
    const casa = normalizeText(nome)
      .split(/[^a-z0-9]+/)
      .some((w) => w.length >= 4 && toks.has(w));
    if (casa) {
      hits++;
      if (hits > 1) return null;
      hit = nome;
    }
  }
  return hits === 1 ? hit : null;
}

/**
 * Trava de ambiente: o banco de produção vive em São Paulo. Um `--apply`
 * disparado contra um `.env` de worktree apontando para outra região gravaria
 * em silêncio no lugar errado — já aconteceu neste projeto.
 */
function assertBanco() {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^/:]+)/)?.[1] ?? "";
  if (!host) {
    throw new Error("DATABASE_URL ausente ou ilegível — abortando.");
  }
  if (apply && !host.includes("sa-east-1")) {
    throw new Error(
      `--apply bloqueado: host "${host}" não é sa-east-1 (produção São Paulo).`,
    );
  }
  return host;
}

interface Decisao {
  linha: number;
  galhoExternalId: string;
  tipoDePeca: string;
  folhaSugerida: string;
  folhaCorreta: string;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.inPath) {
    throw new Error(
      "Informe a planilha preenchida: --in=caminho/planilha.xlsx",
    );
  }
  const host = assertBanco();
  console.log(
    `[aliases] ${apply ? "APLICANDO" : "DRY-RUN"} | host=${host} | site=${args.siteId}`,
  );
  console.log(`[aliases] planilha: ${args.inPath}`);

  // ── 1. Lê as decisões preenchidas ──
  const wb = XLSX.readFile(args.inPath);
  const sheet = wb.Sheets["galhos"] ?? wb.Sheets[wb.SheetNames[0]];
  const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const decisoes: Decisao[] = [];
  let vazias = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const folhaCorreta = String(r["Folha_Correta"] ?? "").trim();
    if (!folhaCorreta) {
      vazias++;
      continue;
    }
    const galho = String(r["Galho_ExternalId"] ?? "").trim();
    if (!galho) {
      console.warn(`  linha ${i + 2}: sem Galho_ExternalId — ignorada`);
      continue;
    }
    decisoes.push({
      linha: i + 2,
      galhoExternalId: galho,
      tipoDePeca: String(r["Tipo_De_Peca"] ?? "").trim(),
      folhaSugerida: String(r["Folha_Sugerida"] ?? "").trim(),
      folhaCorreta,
    });
  }
  console.log(
    `[aliases] linhas: ${rows.length} | preenchidas: ${decisoes.length} | em branco: ${vazias}`,
  );
  if (decisoes.length === 0) {
    console.log("[aliases] nada preenchido — nada a fazer.");
    return;
  }

  // ── 2. Árvore local ──
  const cats = await prisma.marketplaceCategory.findMany({
    where: { siteId: args.siteId },
    select: {
      id: true,
      externalId: true,
      parentExternalId: true,
      fullPath: true,
      name: true,
    },
  });
  const childrenOf = new Map<string, typeof cats>();
  for (const c of cats) {
    if (!c.parentExternalId) continue;
    const arr = (childrenOf.get(c.parentExternalId) ?? []) as typeof cats;
    arr.push(c);
    childrenOf.set(c.parentExternalId, arr);
  }
  const isBranch = (extId: string) => childrenOf.has(extId);
  const byFullPath = new Map(
    cats.map((c) => [normalizeText(c.fullPath ?? c.name), c]),
  );

  /**
   * Resolve o que o humano escreveu: aceita o NOME do filho (como sai em
   * `Opcoes_De_Folha`) ou um caminho completo. Recusa o que não existir, o que
   * for ambíguo e o que ainda for galho — gravar um galho recriaria o problema.
   */
  const resolverFolha = (d: Decisao) => {
    const alvo = normalizeText(d.folhaCorreta);
    const filhos = (childrenOf.get(d.galhoExternalId) ?? []) as typeof cats;
    const porNome = filhos.filter(
      (c) => normalizeText(leafSegment(c.fullPath) || c.name) === alvo,
    );
    let hit = porNome[0] ?? byFullPath.get(alvo) ?? null;
    if (porNome.length > 1) {
      return { erro: `"${d.folhaCorreta}" casa com ${porNome.length} filhos` };
    }
    if (!hit) return { erro: `"${d.folhaCorreta}" não existe na árvore` };
    if (isBranch(hit.externalId)) {
      return {
        erro: `"${d.folhaCorreta}" ainda é GALHO — escolha uma folha`,
      };
    }
    return { cat: hit };
  };

  // ── 3. Casa cada decisão com os aliases do grupo ──
  const aliases = await prisma.categoryAlias.findMany({
    where: { marketplaceCategory: { siteId: args.siteId } },
    select: {
      id: true,
      tokens: true,
      marketplaceCategoryId: true,
      marketplaceCategory: {
        select: { externalId: true, fullPath: true, name: true },
      },
    },
  });

  const porGrupo = new Map<string, string[]>();
  for (const a of aliases) {
    const ext = a.marketplaceCategory?.externalId;
    if (!ext || !isBranch(ext)) continue;
    const pseudoTitulo = (a.tokens ?? "").split(",").join(" ");
    const partType = extractPartType(pseudoTitulo) ?? "(tipo não detectado)";
    const filhos = (childrenOf.get(ext) ?? []) as any[];
    const named = childNamedByTitle(pseudoTitulo, filhos);
    const key = `${ext}||${partType}||${named ?? ""}`;
    const arr = porGrupo.get(key) ?? [];
    arr.push(a.id);
    porGrupo.set(key, arr);
  }

  const plano: {
    catId: string;
    aliasIds: string[];
    de: string;
    para: string;
  }[] = [];
  const erros: string[] = [];
  let semGrupo = 0;
  let totalAliases = 0;

  for (const d of decisoes) {
    const r = resolverFolha(d);
    if ("erro" in r) {
      erros.push(`  linha ${d.linha}: ${r.erro}`);
      continue;
    }
    const key = `${d.galhoExternalId}||${d.tipoDePeca}||${d.folhaSugerida}`;
    const aliasIds = porGrupo.get(key);
    if (!aliasIds || aliasIds.length === 0) {
      semGrupo++;
      erros.push(
        `  linha ${d.linha}: nenhum alias casou (galho/tipo/sugerida mudaram?)`,
      );
      continue;
    }
    totalAliases += aliasIds.length;
    plano.push({
      catId: r.cat!.id,
      aliasIds,
      de: d.tipoDePeca,
      para: leafSegment(r.cat!.fullPath) || r.cat!.name,
    });
  }

  console.log(`\n[aliases] decisões aplicáveis: ${plano.length}`);
  console.log(`[aliases] aliases afetados: ${totalAliases}`);
  if (erros.length > 0) {
    console.log(`\n── ${erros.length} linha(s) com problema ──`);
    for (const e of erros.slice(0, 30)) console.log(e);
    if (erros.length > 30) console.log(`  ... e mais ${erros.length - 30}`);
  }
  if (semGrupo > 0) {
    console.log(
      `\n  ATENÇÃO: ${semGrupo} linha(s) não casaram com nenhum alias. Isso costuma`,
    );
    console.log(
      `  significar planilha gerada de uma versão anterior do banco — regere com`,
    );
    console.log(
      `  scripts/report-branch-aliases.ts e transporte o preenchimento.`,
    );
  }

  console.log(`\n── amostra do que muda ──`);
  for (const p of plano.slice(0, 12)) {
    console.log(
      `  ${String(p.aliasIds.length).padStart(4)} aliases  ${p.de.padEnd(26)} -> ${p.para}`,
    );
  }

  if (!apply) {
    console.log(
      `\n[aliases] DRY-RUN: nada foi gravado. Rode com --apply para aplicar as ${totalAliases} mudanças.`,
    );
    console.log(
      `[aliases] Depois de aplicar, meça: npx tsx scripts/eval-category-suggestion.ts --sample=600`,
    );
    return;
  }

  // ── 4. Aplica ──
  let gravados = 0;
  for (const p of plano) {
    // updateMany por lote: só a coluna do vínculo muda, nada mais é tocado.
    const res = await prisma.categoryAlias.updateMany({
      where: { id: { in: p.aliasIds } },
      data: { marketplaceCategoryId: p.catId },
    });
    gravados += res.count;
    if (gravados % 500 < res.count) {
      console.log(`  ... ${gravados}/${totalAliases}`);
    }
  }
  console.log(`\n[aliases] APLICADO: ${gravados} aliases repontados.`);
  console.log(
    `[aliases] O cache de aliases do serviço é de 5 min — a mudança aparece sozinha.`,
  );
  console.log(
    `[aliases] Meça agora: npx tsx scripts/eval-category-suggestion.ts --sample=600`,
  );
}

main()
  .catch((err) => {
    console.error("[aliases] erro:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
