/**
 * DIAGNOSTICO DA DUPLICIDADE QUE SOBROU — SOMENTE LEITURA.
 *
 * Depois da fusao de 18/09 o cliente ainda ve peca repetida no catalogo. Este
 * script separa o que e defeito do que e estoque de verdade, porque os dois se
 * parecem na tela e ja foram confundidos aqui: em 15/09 desfiz 576 fusoes
 * indevidas neste mesmo cliente.
 *
 * O DISCRIMINADOR PRINCIPAL e a CONTA. A Dexo publica no maximo UM anuncio por
 * conta, entao:
 *   - o mesmo titulo com 1 anuncio por conta em N contas = UMA peca republicada;
 *   - o mesmo titulo com 2+ anuncios na MESMA conta = N pecas de verdade, ou
 *     anuncio duplicado — e nao ha como parear qual anuncio e qual peca.
 * Ver project_dedupe_rotulo_caixa_particionado: sem essa guarda o veredito dizia
 * 334 fusoes; com ela, 132 — e as 202 de diferenca eram peca REAL no galpao.
 *
 * Usa o tokenizador e a guarda de lado/eixo DA APLICACAO, nunca uma copia.
 *
 * Uso (na VPS, a partir de /var/www/dexo):
 *   npx tsx scripts/catalog-dedupe/diagnostico-duplicidade.ts --tenants=<id>,<id> --saida=<dir>
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

import prisma from "../../app/lib/prisma";
import { titleTokens } from "../../app/lib/title-similarity";
import { ladoOuEixoOposto } from "../lib/lado-e-eixo";

const args = process.argv.slice(2);
const valor = (nome: string, padrao: string) => {
  const achado = args.find((a) => a.startsWith(`--${nome}=`));
  return achado ? achado.slice(nome.length + 3) : padrao;
};

/** "Anúncio 58258296009" — ficha que nasceu de anuncio sem nome de peca. */
const NOME_DE_PLACEHOLDER = /^an[úu]ncio\s+\d+$/i;
/** "VAAPT-MLB7538818174", "MK2AUTO-MLB1744459082" — SKU cunhado pela Dexo a partir do anuncio. */
const SKU_CUNHADO = /^[A-Za-z0-9]+-(MLB)?\d{6,}$/;

const chaveDoTitulo = (nome: string) => [...titleTokens(nome)].sort().join(" ");

type Peca = {
  id: string;
  sku: string | null;
  name: string;
  stock: number;
  createdFromMarketplace: boolean;
  locationId: string | null;
  fotos: string[];
};

const idDaFoto = (u: string) => {
  const m = /\/D_([A-Za-z0-9-]+_\d+)-/.exec(u || "");
  return m ? m[1].toUpperCase() : null;
};

async function diagnosticar(tenantId: string) {
  const produtos = (await prisma.$queryRaw<
    Array<Peca & { anuncios: number; contas: string[] }>
  >`
    SELECT p.id, p.sku, p.name, p.stock, p."createdFromMarketplace", p."locationId",
           COALESCE(p."imageUrls", ARRAY[]::text[]) AS fotos,
           COUNT(pl.id) FILTER (WHERE pl.status = 'active')::int AS anuncios,
           COALESCE(
             ARRAY_AGG(DISTINCT pl."marketplaceAccountId") FILTER (WHERE pl.status = 'active'),
             ARRAY[]::text[]
           ) AS contas
      FROM "Product" p
      JOIN "User" u ON u.id = p."userId"
      LEFT JOIN "ProductListing" pl ON pl."productId" = p.id
     WHERE COALESCE(u."parentUserId", u.id) = ${tenantId}
     GROUP BY p.id
  `) as Array<Peca & { anuncios: number; contas: string[] }>;

  const grupos = new Map<string, typeof produtos>();
  for (const p of produtos) {
    const chave = chaveDoTitulo(p.name);
    if (!chave) continue;
    grupos.set(chave, [...(grupos.get(chave) ?? []), p]);
  }

  const balde = {
    PECA_REPETIDA_DE_VERDADE: [] as string[][],
    DUPLICATA_PROVAVEL: [] as string[][],
    AMBIGUO_MESMA_CONTA: [] as string[][],
    LADO_OU_EIXO: [] as string[][],
    DUPLICATA_DA_MIGRACAO: [] as string[][],
    REPUBLICACAO_ENTRE_CONTAS: [] as string[][],
  };
  let produtosEmDuplicataProvavel = 0;
  let produtosEmDuplicataDaMigracao = 0;
  let produtosEmRepublicacao = 0;

  for (const [, membros] of grupos) {
    if (membros.length < 2) continue;

    // Lado/eixo separa peca OPOSTA que o tokenizador aproxima. Basta um par
    // oposto para o grupo inteiro exigir olho humano.
    let oposto = false;
    for (let i = 0; i < membros.length && !oposto; i += 1) {
      for (let j = i + 1; j < membros.length; j += 1) {
        if (ladoOuEixoOposto(membros[i].name, membros[j].name)) { oposto = true; break; }
      }
    }
    const rotulo = membros.map(
      (m) =>
        `${m.sku ?? "?"} | ${m.name} | estoque ${m.stock} | ${m.locationId ? "com endereco" : "SEM endereco"} | ${m.anuncios} anuncio(s) | ${m.fotos[0] ?? ""}`,
    );
    if (oposto) { balde.LADO_OU_EIXO.push(rotulo); continue; }

    // A guarda da CONTA. Uma conta que aparece em 2+ membros significa que o
    // lojista tem mais de uma peca daquelas, ou anuncio duplicado: nao da para
    // parear qual anuncio e qual peca, e fundir apagaria peca real.
    const usoDaConta = new Map<string, number>();
    for (const m of membros) for (const c of m.contas) usoDaConta.set(c, (usoDaConta.get(c) ?? 0) + 1);
    const contaRepetida = [...usoDaConta.values()].some((n) => n > 1);
    if (contaRepetida) { balde.AMBIGUO_MESMA_CONTA.push(rotulo); continue; }

    // Todo membro publicado em VARIAS contas = o lojista tem mesmo N pecas.
    const todosMultiConta = membros.every((m) => m.contas.length >= 2);
    if (todosMultiConta) { balde.PECA_REPETIDA_DE_VERDADE.push(rotulo); continue; }

    // ⛔ "Mesmo titulo" NAO e duplicata num desmanche: o galpao tem mesmo 9
    // mangueiras iguais. O que caracteriza defeito da MIGRACAO e a convivencia
    // de DOIS registros da mesma peca fisica: um nascido do ANUNCIO (SKU
    // cunhado pela Dexo, sem endereco) e um vindo da PLANILHA (SKU do lojista,
    // com endereco) — e a foto do anuncio ligando os dois.
    const daIngestao = membros.filter((m) => (m.sku && SKU_CUNHADO.test(m.sku)) || !m.locationId);
    const daPlanilha = membros.filter((m) => m.sku && !SKU_CUNHADO.test(m.sku) && m.locationId);
    const fotoDe = (m: Peca) => new Set(m.fotos.map(idDaFoto).filter(Boolean) as string[]);
    const compartilhamFoto = daIngestao.some((a) => {
      const fa = fotoDe(a);
      return fa.size > 0 && daPlanilha.some((b) => [...fotoDe(b)].some((f) => fa.has(f)));
    });

    if (daIngestao.length > 0 && daPlanilha.length > 0 && compartilhamFoto) {
      balde.DUPLICATA_DA_MIGRACAO.push(rotulo);
      produtosEmDuplicataDaMigracao += membros.length;
      continue;
    }

    // Republicacao entre contas: todos os membros nasceram de anuncio e
    // compartilham a MESMA foto. Como o grupo ja passou pela guarda da conta
    // (nenhuma conta aparece duas vezes), isso e UMA peca anunciada em varias
    // contas — nao N pecas. E o padrao que o cliente ve na tela como repeticao.
    const todosDaIngestao = membros.every((m) => (m.sku && SKU_CUNHADO.test(m.sku)) || !m.locationId);
    const fotos = membros.map((m) => new Set(m.fotos.map(idDaFoto).filter(Boolean) as string[]));
    const todosComFoto = fotos.every((f) => f.size > 0);
    const fotoEmComum =
      todosComFoto && fotos.every((f) => [...f].some((id) => fotos[0].has(id)));

    if (todosDaIngestao && fotoEmComum) {
      balde.REPUBLICACAO_ENTRE_CONTAS.push(rotulo);
      produtosEmRepublicacao += membros.length;
      continue;
    }

    balde.DUPLICATA_PROVAVEL.push(rotulo);
    produtosEmDuplicataProvavel += membros.length;
  }

  const placeholders = produtos.filter((p) => NOME_DE_PLACEHOLDER.test(p.name));
  const cunhados = produtos.filter((p) => p.sku && SKU_CUNHADO.test(p.sku));
  const semEndereco = produtos.filter((p) => !p.locationId);

  // Foto repetida entre produtos DIFERENTES: sinal independente do titulo.
  const porFoto = new Map<string, Set<string>>();
  for (const p of produtos) {
    for (const f of new Set(p.fotos.map(idDaFoto).filter(Boolean) as string[])) {
      porFoto.set(f, (porFoto.get(f) ?? new Set()).add(p.id));
    }
  }
  const fotosCompartilhadas = [...porFoto.values()].filter((s) => s.size > 1 && s.size <= 9);

  const semNomeDetalhado = placeholders.map(
    (p) => `${p.sku ?? "?"} | ${p.name} | estoque ${p.stock} | ${p.anuncios} anuncio(s) | ${p.fotos[0] ?? ""}`,
  );

  return {
    tenantId,
    produtos: produtos.length,
    semNomeDetalhado,
    fichasSemNomeDePeca: placeholders.length,
    exemplosSemNome: placeholders.slice(0, 5).map((p) => `${p.sku} | ${p.name}`),
    skuCunhadoPelaDexo: cunhados.length,
    semEndereco: semEndereco.length,
    gruposDeMesmoTitulo: [...grupos.values()].filter((g) => g.length > 1).length,
    veredito: {
      DUPLICATA_DA_MIGRACAO: balde.DUPLICATA_DA_MIGRACAO.length,
      produtosEmDuplicataDaMigracao,
      REPUBLICACAO_ENTRE_CONTAS: balde.REPUBLICACAO_ENTRE_CONTAS.length,
      produtosEmRepublicacao,
      MESMO_TITULO_SEM_PROVA: balde.DUPLICATA_PROVAVEL.length,
      produtosEmMesmoTituloSemProva: produtosEmDuplicataProvavel,
      PECA_REPETIDA_DE_VERDADE: balde.PECA_REPETIDA_DE_VERDADE.length,
      AMBIGUO_MESMA_CONTA: balde.AMBIGUO_MESMA_CONTA.length,
      LADO_OU_EIXO: balde.LADO_OU_EIXO.length,
    },
    fotoCompartilhadaEntreProdutos: fotosCompartilhadas.length,
    amostras: {
      duplicataDaMigracao: balde.DUPLICATA_DA_MIGRACAO.slice(0, 8),
      republicacaoEntreContas: balde.REPUBLICACAO_ENTRE_CONTAS.slice(0, 8),
      mesmoTituloSemProva: balde.DUPLICATA_PROVAVEL.slice(0, 4),
      ambiguoMesmaConta: balde.AMBIGUO_MESMA_CONTA.slice(0, 6),
      ladoOuEixo: balde.LADO_OU_EIXO.slice(0, 4),
    },
    detalhe: balde,
  };
}

async function main(): Promise<void> {
  const tenants = valor("tenants", "").split(",").map((t) => t.trim()).filter(Boolean);
  if (tenants.length === 0) throw new Error("Informe --tenants=<id>,<id>.");
  const saida = valor("saida", "/root/auditoria-fusao-18-09");

  const relatorio = [];
  for (const tenantId of tenants) relatorio.push(await diagnosticar(tenantId));

  fs.mkdirSync(saida, { recursive: true });
  fs.writeFileSync(path.join(saida, "diagnostico-duplicidade.json"), JSON.stringify(relatorio, null, 1));
  for (const r of relatorio) {
    const { detalhe, ...resumo } = r;
    console.log(JSON.stringify(resumo, null, 1));
  }
  await prisma.$disconnect();
}

main().catch(async (erro) => {
  await prisma.$disconnect();
  throw erro;
});
