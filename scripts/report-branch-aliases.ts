/**
 * report-branch-aliases.ts — planilha de trabalho para completar os aliases que
 * apontam para uma categoria-GALHO.
 *
 * READ-ONLY no banco: só faz SELECT e escreve um .xlsx local. Nunca altera
 * `CategoryAlias`, `MarketplaceCategory` nem `Product`.
 *
 * ── O problema ──
 * 10.232 dos 19.485 aliases do ML apontam para um GALHO, não para uma folha,
 * porque a planilha que os gerou (`categorizacao_mercado_livre_sugerida.xlsx`,
 * coluna `Categoria_Oficial_ML_Sugerida`) foi preenchida com caminhos em
 * profundidades variadas. Como as sugestões precisam ser folhas, o serviço
 * desce sozinho — e nos 10.232 casos ele cai num filho "Outros", que é uma
 * folha legítima mas genérica.
 *
 * Tentar adivinhar a folha certa em tempo de consulta foi medido e PIOROU
 * (top-1 8,1% -> 7,3%, auto-aplicado errado 164 -> 240): trocar a folha muda o
 * veredito do guard de coerência e reordena os candidatos. A informação que
 * falta é humana, não heurística — daí esta planilha.
 *
 * ── Por que agrupar por (galho × tipo de peça) ──
 * Completar 10.232 linhas à mão é inviável. Agrupando por galho e tipo de peça,
 * UMA decisão cobre todos os aliases daquele tipo naquele galho. O relatório sai
 * ordenado por cobertura, então preencher as primeiras linhas já resolve a maior
 * parte do volume — a curva de cobertura acumulada vai na própria planilha.
 *
 * ── Como usar ──
 *   npx tsx scripts/report-branch-aliases.ts
 *   npx tsx scripts/report-branch-aliases.ts --site=SHP --out=C:/tmp/galhos.xlsx
 *   npx tsx scripts/report-branch-aliases.ts --min=5   (só grupos com 5+ aliases)
 *
 * Preencha a coluna `Folha_Correta` com um dos caminhos de `Opcoes_De_Folha`
 * (ou com qualquer caminho de folha válido da árvore). Linhas em branco são
 * ignoradas: o comportamento atual ("Outros") continua valendo para elas.
 */

import "dotenv/config";
import path from "node:path";
import XLSX from "xlsx";
import prisma from "../app/lib/prisma";
import {
  extractPartType,
  normalizeText,
} from "../app/marketplaces/lib/title-parse";

interface Args {
  siteId: string;
  outPath: string;
  minGroup: number;
  examples: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    siteId: "MLB",
    outPath: path.resolve(`galhos-aliases-${new Date().getTime()}.xlsx`),
    minGroup: 1,
    examples: 3,
  };
  for (const a of argv) {
    if (a.startsWith("--site=")) args.siteId = a.slice(7).toUpperCase();
    else if (a.startsWith("--out=")) args.outPath = path.resolve(a.slice(6));
    else if (a.startsWith("--min=")) {
      const n = parseInt(a.slice(6), 10);
      if (Number.isFinite(n) && n > 0) args.minGroup = n;
    } else if (a.startsWith("--examples=")) {
      const n = parseInt(a.slice(11), 10);
      if (Number.isFinite(n) && n > 0) args.examples = n;
    }
  }
  return args;
}

/** Último segmento do caminho — o nome da própria categoria. */
const leafSegment = (fullPath?: string | null) => {
  const parts = (fullPath ?? "").split(">");
  return (parts[parts.length - 1] || "").trim();
};

/**
 * Reconstrói algo legível a partir dos tokens do alias.
 *
 * `CategoryAlias.tokens` guarda o título do anúncio de origem E, no fim, as
 * palavras do caminho da categoria (ex.: "...,pecas,de,interior,acab"). Aqui as
 * palavras que já aparecem no caminho são removidas, para o exemplo mostrar o
 * PRODUTO e não a categoria.
 */
function exampleFromTokens(tokens: string | null, branchPath: string): string {
  if (!tokens) return "";
  const pathWords = new Set(
    normalizeText(branchPath)
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  const words = tokens
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t && !pathWords.has(normalizeText(t)));
  return words.join(" ").slice(0, 90);
}

/**
 * O título nomeia algum filho do galho, de forma única? Só conta palavra com 4+
 * letras — "de", "ar", "kit" casariam com qualquer coisa.
 */
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

interface Group {
  branchExternalId: string;
  branchPath: string;
  partType: string;
  /**
   * Filho que o TÍTULO dos aliases deste grupo nomeia, quando é sempre o mesmo.
   * Entra na chave do grupo de propósito: em "Sistemas de Elevação" as opções
   * são Manual / Elétrico / Borracha / Outros, e a resposta certa varia DENTRO
   * do tipo de peça — sem isso, "máquina de vidro manual" e "máquina de vidro
   * elétrico" cairiam na mesma linha e uma folha só estaria errada para metade.
   */
  namedChild: string | null;
  count: number;
  examples: string[];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = (process.env.DATABASE_URL ?? "").match(/@([^/:]+)/)?.[1] ?? "?";
  console.log(
    `[galhos] READ-ONLY | host=${host} | site=${args.siteId} | min=${args.minGroup}`,
  );

  const cats = await prisma.marketplaceCategory.findMany({
    where: { siteId: args.siteId },
    select: {
      externalId: true,
      parentExternalId: true,
      fullPath: true,
      name: true,
    },
  });
  const byExternal = new Map(cats.map((c) => [c.externalId, c]));
  const childrenOf = new Map<string, typeof cats>();
  for (const c of cats) {
    if (!c.parentExternalId) continue;
    const arr = (childrenOf.get(c.parentExternalId) ?? []) as typeof cats;
    arr.push(c);
    childrenOf.set(c.parentExternalId, arr);
  }
  const isBranch = (extId: string) => childrenOf.has(extId);

  const aliases = await prisma.categoryAlias.findMany({
    where: { marketplaceCategory: { siteId: args.siteId } },
    select: {
      tokens: true,
      marketplaceCategory: {
        select: { externalId: true, fullPath: true, name: true },
      },
    },
  });
  console.log(`[galhos] aliases do site: ${aliases.length}`);

  // Agrupa por (galho, tipo de peça).
  const groups = new Map<string, Group>();
  let apontamParaGalho = 0;
  let semTipoDetectado = 0;

  for (const a of aliases) {
    const ext = a.marketplaceCategory?.externalId;
    if (!ext || !isBranch(ext)) continue;
    apontamParaGalho++;

    const branchPath =
      a.marketplaceCategory?.fullPath || a.marketplaceCategory?.name || ext;
    // O tipo de peça sai do MESMO parser que o motor de inferência usa, então o
    // agrupamento aqui é o mesmo que o sistema enxerga em produção.
    const pseudoTitulo = (a.tokens ?? "").split(",").join(" ");
    const partType = extractPartType(pseudoTitulo) ?? "(tipo não detectado)";
    if (partType === "(tipo não detectado)") semTipoDetectado++;

    const children = (childrenOf.get(ext) ?? []) as any[];
    const named = childNamedByTitle(pseudoTitulo, children);

    const key = `${ext}||${partType}||${named ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        branchExternalId: ext,
        branchPath,
        partType,
        namedChild: named,
        count: 0,
        examples: [],
      };
      groups.set(key, g);
    }
    g.count++;
    if (g.examples.length < args.examples) {
      const ex = exampleFromTokens(a.tokens, branchPath);
      if (ex && !g.examples.includes(ex)) g.examples.push(ex);
    }
  }

  const ordered = [...groups.values()]
    .filter((g) => g.count >= args.minGroup)
    .sort(
      (a, b) => b.count - a.count || a.branchPath.localeCompare(b.branchPath),
    );

  // Cobertura acumulada: quantas linhas preencher para resolver quanto do total.
  const totalNoRecorte = ordered.reduce((s, g) => s + g.count, 0);
  let acumulado = 0;

  const rows = ordered.map((g, i) => {
    acumulado += g.count;
    const children = (childrenOf.get(g.branchExternalId) ?? []) as typeof cats;
    // O que o sistema escolhe HOJE: o filho "Outros", senão o primeiro.
    const atual =
      children.find((c) =>
        (c.fullPath || c.name || "").toLowerCase().includes("outros"),
      ) ?? children[0];
    // Opções: filhos diretos. "*" marca filho que TAMBÉM é galho (ao escolher um
    // desses, o sistema volta a precisar descer).
    const opcoes = children
      .map(
        (c) =>
          `${leafSegment(c.fullPath) || c.name}${isBranch(c.externalId) ? " *" : ""}`,
      )
      .join(" | ");

    const folhaHoje = atual ? leafSegment(atual.fullPath) || atual.name : "";

    // Alertas que impedem quem preenche de errar em silêncio.
    const obs: string[] = [];
    if (g.partType === "(tipo não detectado)") {
      obs.push(
        "grupo HETEROGÊNEO: o parser não achou um tipo de peça comum — provavelmente NÃO se resolve com uma folha só, prefira pular",
      );
    }
    if (children.every((c) => isBranch(c.externalId))) {
      obs.push(
        "todas as opções são galhos: escolher aqui exige descer mais um nível",
      );
    }
    if (g.namedChild && g.namedChild !== folhaHoje) {
      obs.push(`o próprio título diz "${g.namedChild}"`);
    }
    if (!g.namedChild && children.length > 12) {
      obs.push(
        `${children.length} opções e nenhuma nomeada pelo título — confira se "Outros" já não é o certo`,
      );
    }

    return {
      "#": i + 1,
      Qtd_Aliases: g.count,
      Cobertura_Acumulada: `${((100 * acumulado) / totalNoRecorte).toFixed(1)}%`,
      Tipo_De_Peca: g.partType,
      Galho_Atual: g.branchPath,
      Folha_Hoje: folhaHoje,
      // Palpite, não decisão: vem de o título nomear um filho de forma única.
      // Fica numa coluna própria justamente para não parecer já preenchido.
      Folha_Sugerida: g.namedChild ?? "",
      Folha_Correta: "",
      Observacao: obs.join(" | "),
      Opcoes_De_Folha: opcoes,
      Qtd_Opcoes: children.length,
      Exemplos_De_Produto: g.examples.join("  ///  "),
      Galho_ExternalId: g.branchExternalId,
    };
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [
    { wch: 5 },
    { wch: 12 },
    { wch: 12 },
    { wch: 24 },
    { wch: 58 },
    { wch: 24 },
    { wch: 22 },
    { wch: 26 },
    { wch: 62 },
    { wch: 70 },
    { wch: 10 },
    { wch: 70 },
    { wch: 16 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, "galhos");

  // Aba de instruções: a planilha precisa se explicar sozinha para quem preencher.
  const instrucoes = [
    ["Como preencher"],
    [""],
    ["1. Preencha SÓ a coluna Folha_Correta."],
    [
      "2. Use um dos nomes de Opcoes_De_Folha, ou um caminho de folha completo.",
    ],
    ["3. Um ' *' em Opcoes_De_Folha marca filho que TAMBÉM é galho — evite."],
    ["4. Linha em branco = fica como está hoje (coluna Folha_Hoje)."],
    [
      "5. Folha_Sugerida é PALPITE (o título nomeia esse filho). Confira antes.",
    ],
    ["6. Leia Observacao: ela marca grupo heterogêneo e caso em que 'Outros'"],
    ["   provavelmente já é a resposta certa."],
    ["7. Comece de cima: as linhas estão ordenadas por quantos aliases cada"],
    [
      "   decisão resolve, e Cobertura_Acumulada mostra o quanto você já cobriu.",
    ],
    [""],
    ["O que cada coluna diz"],
    ["Qtd_Aliases", "quantos aliases essa única decisão resolve"],
    ["Tipo_De_Peca", "tipo detectado pelo mesmo parser que o sistema usa"],
    ["Galho_Atual", "categoria que a planilha original apontou (não é folha)"],
    ["Folha_Hoje", "onde o sistema cai hoje sozinho (quase sempre 'Outros')"],
    ["Folha_Sugerida", "palpite: filho que o título nomeia. NÃO é decisão."],
    ["Observacao", "alertas — leia antes de preencher a linha"],
    ["Exemplos_De_Produto", "títulos reais que caem nesse grupo"],
    [""],
    [
      "Gerado por scripts/report-branch-aliases.ts — READ-ONLY, não altera o banco.",
    ],
  ];
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(instrucoes),
    "instrucoes",
  );

  XLSX.writeFile(wb, args.outPath);

  console.log(`\n[galhos] aliases apontando para GALHO: ${apontamParaGalho}`);
  console.log(`[galhos] sem tipo de peça detectado: ${semTipoDetectado}`);
  console.log(`[galhos] grupos (galho x tipo): ${groups.size}`);
  console.log(
    `[galhos] grupos no recorte (>= ${args.minGroup}): ${ordered.length}`,
  );
  console.log(`[galhos] planilha: ${args.outPath}`);

  const marcos = [10, 25, 50, 100, 200];
  console.log(`\n── quanto do volume cada fatia de linhas resolve ──`);
  let soma = 0;
  let idx = 0;
  for (const m of marcos) {
    while (idx < Math.min(m, ordered.length)) soma += ordered[idx++].count;
    console.log(
      `  ${String(m).padStart(4)} primeiras linhas -> ${soma} aliases (${((100 * soma) / totalNoRecorte).toFixed(1)}%)`,
    );
    if (m >= ordered.length) break;
  }

  console.log(`\n── as 15 decisões de maior impacto ──`);
  for (const r of rows.slice(0, 15)) {
    console.log(
      `  ${String(r.Qtd_Aliases).padStart(4)}  ${r.Tipo_De_Peca.padEnd(24)} ${r.Galho_Atual}`,
    );
    console.log(
      `        hoje: ${r.Folha_Hoje}${r.Folha_Sugerida ? `   -> sugerido: ${r.Folha_Sugerida}` : ""}` +
        `   |   opções (${r.Qtd_Opcoes}): ${String(r.Opcoes_De_Folha).slice(0, 95)}`,
    );
    if (r.Observacao)
      console.log(`        ! ${String(r.Observacao).slice(0, 110)}`);
  }
}

main()
  .catch((err) => {
    console.error("[galhos] erro:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
