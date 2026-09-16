import "dotenv/config";
import path from "path";
import fs from "fs";
import prisma from "../app/lib/prisma";
import { areTitlesSimilar, isOppositeSideOrAxis } from "../app/lib/title-similarity";

/**
 * Dedupe por foto do anúncio — versão que PARTICIONA o cluster por título
 * ANTES de eleger o dono.
 *
 * POR QUE ESTE ARQUIVO EXISTE (medido no Desmanche Tijuco Preto, 16/09/2026).
 * O `dedupe-anuncios-por-foto.ts` elege o dono primeiro (a peça migrada da
 * planilha) e só depois recusa a duplicata cujo título não casa com o do dono.
 * Num desmanche que usa RÓTULO DE CAIXA como `seller_sku` isso inverte o
 * resultado: o anúncio "Suporte De Cambio Honda Civic 1.6 1999" carrega
 * `seller_sku=3993`, e 3993 é a CAIXA — o produto migrado com esse SKU é
 * "Suporte Do Câmbio Volkswagen Gol G3". O dono eleito vira a peça ERRADA e as
 * duas duplicatas legítimas (títulos idênticos entre si) saem recusadas.
 * Resultado medido: 104 dos 126 clusters terminaram sem nada a fundir.
 *
 * A ordem certa é a inversa:
 *   1. agrupa anúncios que compartilham id de foto (o ML reaproveita o id
 *      quando o vendedor duplica o anúncio — prova de mesma peça física);
 *   2. dentro do cluster, PARTICIONA os produtos por título similar; peça de
 *      caixa cai numa partição própria e simplesmente não participa;
 *   3. elege o dono DENTRO de cada partição e funde só ali.
 *
 * Nada aqui escreve no banco: a saída é o mesmo JSON que
 * `resolver-duplicata-de-anuncio.ts` já consome (dono + duplicatas por SKU).
 *
 *   tsx scripts/dedupe-por-foto-particionado.ts --user-email=<email> \
 *     [--cache=<json do varredor>] [--max-uso-foto=9]
 */

const OUT_DIR = path.resolve(__dirname, "out");
const args = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const p = `--${n}=`;
  const f = args.find((a) => a.startsWith(p));
  return f ? f.slice(p.length) : undefined;
};

const CONHECIDAS = new Set(["user-email", "cache", "max-uso-foto", "saida", "allow-any-host"]);
for (const a of args) {
  if (!a.startsWith("--")) throw new Error(`argumento solto: ${a}`);
  const nome = a.slice(2).split("=")[0];
  if (!CONHECIDAS.has(nome)) throw new Error(`flag desconhecida: --${nome}`);
}

function assertBanco(): string {
  const host = (process.env.DATABASE_URL || "").match(/@([^:/?]+)/)?.[1] ?? "(desconhecido)";
  if (!args.includes("--allow-any-host") && !host.includes("sa-east-1")) {
    throw new Error(`ABORTADO: banco '${host}' não é a produção (sa-east-1).`);
  }
  return host;
}

interface CacheAnuncio {
  id: string;
  fotos: string[];
  sellerSku: string;
  titulo: string;
  status: string;
}

/** union-find, o mesmo agrupamento transitivo do script original */
class UF {
  private pai = new Map<string, string>();
  acha(x: string): string {
    if (!this.pai.has(x)) this.pai.set(x, x);
    let r = this.pai.get(x)!;
    while (r !== this.pai.get(r)!) r = this.pai.get(r)!;
    let c = x;
    while (c !== r) {
      const n = this.pai.get(c)!;
      this.pai.set(c, r);
      c = n;
    }
    return r;
  }
  une(a: string, b: string): void {
    const ra = this.acha(a);
    const rb = this.acha(b);
    if (ra !== rb) this.pai.set(ra, rb);
  }
}

interface Prod {
  id: string;
  sku: string;
  nome: string;
  estoque: number;
  daVaapt: boolean;
  lastro: boolean;
  anuncios: number;
  migrado: boolean;
  temLoc: boolean;
  vendeu: boolean;
  criadoEm: string;
}

async function main() {
  const host = assertBanco();
  const email = arg("user-email");
  if (!email) throw new Error("Faltou --user-email=<email>");
  const maxUsoFoto = Number(arg("max-uso-foto") ?? "9");

  const user = await prisma.user.findFirst({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`usuário não encontrado: ${email}`);

  const cachePath = arg("cache") ?? path.join(OUT_DIR, `ml-fotos-${user.id}.json`);
  if (!fs.existsSync(cachePath)) {
    throw new Error(`cache não existe: ${cachePath} (rode o --varrer antes)`);
  }
  const cache: CacheAnuncio[] = JSON.parse(fs.readFileSync(cachePath, "utf8"));

  console.log("===== DEDUPE POR FOTO (PARTICIONADO POR TITULO) =====");
  console.log(`banco: ${host}`);
  console.log(`user : ${user.email}`);
  console.log(`cache: ${cachePath} (${cache.length} anuncios)`);
  console.log(`max-uso-foto: ${maxUsoFoto}`);

  // ---------- descarta foto genérica ----------
  const uso = new Map<string, number>();
  for (const a of cache) for (const f of a.fotos) uso.set(f, (uso.get(f) ?? 0) + 1);
  const descartadas = new Set(
    [...uso.entries()].filter(([, n]) => n > maxUsoFoto).map(([f]) => f),
  );
  console.log(
    `[fotos] ids distintos: ${uso.size} | descartados por uso > ${maxUsoFoto}: ${descartadas.size}`,
  );

  // ---------- agrupa anúncios que compartilham foto ----------
  const uf = new UF();
  const porFoto = new Map<string, string[]>();
  for (const a of cache) {
    uf.acha(a.id);
    for (const f of a.fotos) {
      if (descartadas.has(f)) continue;
      if (!porFoto.has(f)) porFoto.set(f, []);
      porFoto.get(f)!.push(a.id);
    }
  }
  for (const ids of porFoto.values()) {
    for (let i = 1; i < ids.length; i++) uf.une(ids[0], ids[i]);
  }

  const grupos = new Map<string, string[]>();
  for (const a of cache) {
    const r = uf.acha(a.id);
    if (!grupos.has(r)) grupos.set(r, []);
    grupos.get(r)!.push(a.id);
  }
  const multi = [...grupos.values()].filter((g) => g.length > 1);
  console.log(
    `[grupos] anuncios: ${cache.length} | grupos: ${grupos.size} | com +1 anuncio: ${multi.length}`,
  );

  // ---------- liga anúncio → produto ----------
  const listings = await prisma.productListing.findMany({
    where: { product: { userId: user.id } },
    select: {
      externalListingId: true,
      marketplaceAccountId: true,
      product: {
        select: {
          id: true,
          sku: true,
          name: true,
          stock: true,
          attributes: true,
          createdAt: true,
          locationId: true,
          _count: { select: { orderItems: true, stockLogs: true, nfeItens: true, listings: true } },
        },
      },
    },
  });
  const prodPorAnuncio = new Map<string, Prod>();
  const contaPorAnuncio = new Map<string, string>();
  for (const l of listings) {
    if (!l.externalListingId || !l.product) continue;
    contaPorAnuncio.set(l.externalListingId, l.marketplaceAccountId);
    const p = l.product;
    prodPorAnuncio.set(l.externalListingId, {
      id: p.id,
      sku: p.sku,
      nome: p.name,
      estoque: p.stock,
      daVaapt: !!String((p.attributes as any)?.etiquetaOrigem ?? "").trim(),
      lastro: p._count.orderItems > 0 || p._count.stockLogs > 0 || p._count.nfeItens > 0,
      anuncios: p._count.listings,
      migrado: !!String((p.attributes as any)?.migration ?? "").trim(),
      temLoc: !!p.locationId,
      vendeu: p._count.orderItems > 0,
      criadoEm: p.createdAt.toISOString(),
    });
  }

  interface ClusterOut {
    anuncios: string[];
    produtos: Prod[];
    dono: string;
    duplicatas: string[];
    criterioDono: string;
    foraDaParticao: string[];
  }
  const clusters: ClusterOut[] = [];
  let particoesDescartadas = 0;
  let clustersComCaixa = 0;
  let recusadosPorContaRepetida = 0;
  let pecasReaisEstimadas = 0;

  for (const g of multi) {
    const vistos = new Map<string, Prod>();
    const anunciosPorProduto = new Map<string, string[]>();
    for (const a of g) {
      const p = prodPorAnuncio.get(a);
      if (!p) continue;
      if (!vistos.has(p.id)) vistos.set(p.id, p);
      if (!anunciosPorProduto.has(p.id)) anunciosPorProduto.set(p.id, []);
      anunciosPorProduto.get(p.id)!.push(a);
    }
    const produtos = [...vistos.values()];
    if (produtos.length < 2) continue;

    // PARTIÇÃO por título: une só quem é similar E não é lado/eixo oposto.
    // A peça que entrou pelo rótulo de caixa cai sozinha e não participa.
    const ufT = new UF();
    for (const p of produtos) ufT.acha(p.id);
    for (let i = 0; i < produtos.length; i++) {
      for (let j = i + 1; j < produtos.length; j++) {
        const a = produtos[i];
        const b = produtos[j];
        if (isOppositeSideOrAxis(a.nome, b.nome)) continue;
        if (!areTitlesSimilar(a.nome, b.nome)) continue;
        ufT.une(a.id, b.id);
      }
    }
    const particoes = new Map<string, Prod[]>();
    for (const p of produtos) {
      const r = ufT.acha(p.id);
      if (!particoes.has(r)) particoes.set(r, []);
      particoes.get(r)!.push(p);
    }
    if (particoes.size > 1) clustersComCaixa++;

    for (const membros of particoes.values()) {
      if (membros.length < 2) {
        particoesDescartadas++;
        continue;
      }

      // ⛔⛔ GUARDA DE PEÇA REPETIDA LEGÍTIMA — a mais importante deste script.
      //
      // A foto NÃO distingue "a mesma peça republicada nas 3 contas" de "o
      // lojista tem 3 peças iguais e reusou a mesma foto em todas". Medido no
      // Tijuco Preto: o cluster "Difusor De Ar Central Peugeot 408" tem 8
      // anúncios distribuídos ANAP 3 / FEMA 3 / DUCELO 2 — são ~3 difusores
      // reais, não um. Fundir os 8 num só APAGARIA duas peças do galpão.
      //
      // O que separa os dois casos é a CONTA: a Dexo publica a mesma peça uma
      // vez por conta, então republicação dá no máximo 1 anúncio por conta.
      // Duas entradas na mesma conta ⇒ são peças distintas, e não há como
      // parear qual anúncio da conta A é qual peça. Recusa o cluster inteiro.
      const porConta = new Map<string, number>();
      for (const m of membros) {
        for (const a of anunciosPorProduto.get(m.id) ?? []) {
          const c = contaPorAnuncio.get(a);
          if (!c) continue;
          porConta.set(c, (porConta.get(c) ?? 0) + 1);
        }
      }
      const maxPorConta = Math.max(0, ...porConta.values());
      if (maxPorConta > 1) {
        recusadosPorContaRepetida++;
        pecasReaisEstimadas += maxPorConta;
        continue;
      }

      // Dono = a ficha com mais chance de ser a "boa" da peça.
      const peso = (p: Prod) =>
        (p.daVaapt ? 8 : 0) + (p.migrado ? 4 : 0) + (p.temLoc ? 2 : 0) + (p.vendeu ? 1 : 0);
      const porPrioridade = [...membros].sort((a, b) => {
        const d = peso(b) - peso(a);
        if (d !== 0) return d;
        return a.criadoEm.localeCompare(b.criadoEm) || a.id.localeCompare(b.id);
      });
      const dono = porPrioridade[0];
      const criterio = dono.daVaapt
        ? "etiquetaOrigem"
        : dono.migrado
          ? "peca migrada da planilha"
          : dono.temLoc
            ? "tem localizacao"
            : dono.vendeu
              ? "tem venda"
              : "mais antiga da particao";

      const duplicatas = porPrioridade.slice(1);
      const idsMembros = new Set(membros.map((m) => m.id));
      const anuncios = membros.flatMap((m) => anunciosPorProduto.get(m.id) ?? []);
      const fora = produtos
        .filter((p) => !idsMembros.has(p.id))
        .map((p) => `${p.sku} :: ${p.nome}`);

      clusters.push({
        anuncios,
        produtos: membros,
        dono: dono.sku,
        duplicatas: duplicatas.map((d) => d.sku),
        criterioDono: criterio,
        foraDaParticao: fora,
      });
    }
  }

  const totalDup = clusters.reduce((a, c) => a + c.duplicatas.length, 0);
  const donoZerado = clusters.filter(
    (c) => (c.produtos.find((p) => p.sku === c.dono)?.estoque ?? 0) <= 0,
  ).length;
  const comLastro = clusters.reduce(
    (a, c) => a + c.produtos.filter((p) => p.sku !== c.dono && p.lastro).length,
    0,
  );
  const anunciosAfetados = clusters.reduce(
    (a, c) => a + c.produtos.filter((p) => p.sku !== c.dono).reduce((s, p) => s + p.anuncios, 0),
    0,
  );

  console.log("");
  console.log("===== VEREDITO =====");
  console.log(`  clusters com 2+ produtos na MESMA particao de titulo: ${clusters.length}`);
  console.log(`  produtos duplicados a fundir ......................: ${totalDup}`);
  console.log(`  anuncios que mudam de dono .......................: ${anunciosAfetados}`);
  console.log(`  clusters que tinham peca de OUTRO titulo (caixa) ..: ${clustersComCaixa}`);
  console.log(`  particoes de 1 produto so (ignoradas) ............: ${particoesDescartadas}`);
  console.log(`  RECUSADOS por conta repetida (pecas iguais de verdade): ${recusadosPorContaRepetida}`);
  console.log(`     pecas fisicas que esses clusters representam ..: ~${pecasReaisEstimadas}`);
  console.log(`  duplicatas COM lastro (renomeadas, nao apagadas) ..: ${comLastro}`);
  console.log(`  clusters cujo dono esta com estoque 0 ............: ${donoZerado}`);
  console.log("");
  console.log("  amostra:");
  for (const c of clusters.slice(0, 10)) {
    const d = c.produtos.find((p) => p.sku === c.dono);
    console.log(`     dono[${c.dono}] (${c.criterioDono}) + ${c.duplicatas.length} duplicata(s)`);
    console.log(`        "${(d?.nome ?? "").slice(0, 58)}"`);
    if (c.foraDaParticao.length) {
      console.log(`        fora da particao: ${c.foraDaParticao[0].slice(0, 58)}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const saida = arg("saida") ?? path.join(OUT_DIR, `dedupe-particionado-${stamp}.json`);
  fs.mkdirSync(path.dirname(saida), { recursive: true });
  fs.writeFileSync(
    saida,
    JSON.stringify(
      {
        banco: host,
        user: user.email,
        maxUsoFoto,
        totais: { clusters: clusters.length, duplicatas: totalDup, clustersComCaixa, donoZerado, comLastro, anunciosAfetados, recusadosPorContaRepetida, pecasReaisEstimadas },
        clusters,
      },
      null,
      2,
    ),
  );
  console.log("");
  console.log(`  detalhe: ${saida}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
