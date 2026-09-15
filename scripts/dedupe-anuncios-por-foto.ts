import "dotenv/config";
import path from "path";
import fs from "fs";
import prisma from "../app/lib/prisma";
import { areTitlesSimilar } from "../app/lib/title-similarity";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";

import { ladoOuEixoOposto } from "./lib/lado-e-eixo";

/**
 * Encontra produtos DUPLICADOS provando pela FOTO DO ANÚNCIO.
 *
 * O problema: o mesmo item físico foi anunciado mais de uma vez no Mercado
 * Livre. O anúncio que trazia `seller_sku` casou com a peça da VAAPT; os outros
 * vieram sem código, e para cada um o Dexo criou um produto NOVO com SKU
 * automático. Resultado: a mesma peça aparece 2, 3 vezes no catálogo, e os SKUs
 * automáticos ocupam números que o cliente quer usar como etiqueta.
 *
 * ⚠️⚠️ POR QUE PELA FOTO DO ANÚNCIO, E NÃO PELO NOME OU PELA FOTO DO PRODUTO:
 *  - NOME não prova nada num desmanche: "Sensor Map Spin Activ 2016" é o nome de
 *    várias peças diferentes, de carros diferentes. Casar por nome dá 11.258
 *    candidatos na MK2, com falso-positivo garantido.
 *  - FOTO DO PRODUTO não é comparável: a peça vinda do anúncio guarda URL do
 *    `mlstatic.com` e a vinda da VAAPT guarda URL do storage da VAAPT — mesmas
 *    imagens, hospedagens diferentes, interseção SEMPRE vazia. Medido no caso
 *    33315 × 26163: 7 fotos de cada lado, 0 em comum.
 *  - FOTO DO ANÚNCIO resolve: os dois lados são anúncios do ML, e o ML
 *    REAPROVEITA o id da imagem quando o vendedor duplica o anúncio. Medido nos
 *    mesmos dois: `MLB4827806595` × `MLB4992597337` → 7 de 7 ids iguais, 100%.
 *
 * ⚠️ GUARDA DE FOTO GENÉRICA: imagem que aparece em muitos anúncios (logo, banner
 * de garantia, foto de fachada) ligaria o catálogo inteiro num cluster só.
 * `--max-uso-foto=N` (padrão 5) descarta ids de imagem usados acima disso.
 *
 * FASES
 *   --varrer     consulta a API do ML e grava o cache `anúncio → ids de foto`.
 *                ⚠️ ROda da VPS: a varredura do ML dá 503 fora dela, e o scan é
 *                tudo-ou-nada (aborta com zero, não com resultado parcial).
 *   --analisar   lê o cache, agrupa anúncios que compartilham foto e reporta os
 *                grupos que caem em mais de um produto.
 *
 * Este script é SOMENTE LEITURA: ele produz o veredito, não funde nem apaga.
 *
 *   tsx scripts/dedupe-anuncios-por-foto.ts --user-email=<email> --varrer --analisar
 */

const OUT_DIR = path.resolve(__dirname, "out");

const args = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const p = `--${n}=`;
  const f = args.find((a) => a.startsWith(p));
  return f ? f.slice(p.length) : undefined;
};

function assertBanco(): string {
  const host = (process.env.DATABASE_URL || "").match(/@([^:/?]+)/)?.[1] ?? "(desconhecido)";
  if (!args.includes("--allow-any-host") && !host.includes("sa-east-1")) {
    throw new Error(`ABORTADO: banco '${host}' não é a produção (sa-east-1).`);
  }
  return host;
}

const txt = (v: unknown): string => String(v ?? "").trim();

interface CacheAnuncio { id: string; fotos: string[]; sellerSku: string; titulo: string; status: string }

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A API do ML devolve **503 intermitente** neste volume, mesmo pela VPS — a
 * primeira varredura morreu em 3.400 de 24.660 e perdeu tudo. Por isso aqui:
 * lote pequeno, repetição com espera crescente, e o cache é gravado a cada
 * lote — assim uma queda custa um lote, não a varredura inteira, e a próxima
 * execução RETOMA de onde parou.
 */
async function varrer(userId: string, cachePath: string, lote: number, tentativas: number): Promise<CacheAnuncio[]> {
  const contas = await prisma.marketplaceAccount.findMany({
    where: { userId, platform: "MERCADO_LIVRE", status: "ACTIVE" },
    select: { id: true, accountName: true, externalUserId: true, accessToken: true, refreshToken: true, expiresAt: true },
  });
  // retoma: o que já está no cache não é buscado de novo
  const jaTem = new Map<string, CacheAnuncio>();
  if (fs.existsSync(cachePath)) {
    try {
      for (const a of JSON.parse(fs.readFileSync(cachePath, "utf8")) as CacheAnuncio[]) jaTem.set(a.id, a);
      console.log(`[varrer] cache existente: ${jaTem.size} anúncios já buscados — retomando`);
    } catch { console.log("[varrer] cache ilegível, começando do zero"); }
  }
  const out: CacheAnuncio[] = [...jaTem.values()];
  for (const acc of contas) {
    let token = acc.accessToken ?? "";
    if (!token || (acc.expiresAt && acc.expiresAt.getTime() < Date.now() + 60_000)) {
      const r = await MLOAuthService.refreshAccessTokenForAccount(acc.id, acc.refreshToken ?? "");
      token = r.accessToken;
      await prisma.marketplaceAccount.update({
        where: { id: acc.id },
        data: { accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: new Date(Date.now() + r.expiresIn * 1000) },
      });
    }
    console.log(`[varrer] ${acc.accountName}: buscando ids...`);
    const ids = await MLApiService.getSellerItemIds(token, acc.externalUserId!);
    const faltam = ids.filter((id) => !jaTem.has(id));
    console.log(`[varrer] ${acc.accountName}: ${ids.length} anúncios | faltam buscar: ${faltam.length}`);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });

    let falhas = 0;
    for (let i = 0; i < faltam.length; i += lote) {
      const fatia = faltam.slice(i, i + lote);
      let det: Awaited<ReturnType<typeof MLApiService.getItemsDetails>> = [];
      let ok = false;
      for (let tent = 1; tent <= tentativas; tent++) {
        try {
          det = await MLApiService.getItemsDetails(token, fatia);
          ok = true;
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (tent === tentativas) { falhas++; console.error(`  ✗ lote ${i}: desisti após ${tent} tentativas (${msg.slice(0, 70)})`); break; }
          await espera(3000 * tent);
        }
      }
      if (ok) {
        for (const d of det) {
          out.push({
            id: d.id,
            fotos: (d.pictures ?? []).map((p) => p.id).filter(Boolean),
            sellerSku: txt(d.seller_custom_field),
            titulo: txt(d.title),
            status: txt(d.status),
          });
        }
      }
      // grava a cada lote: uma queda custa um lote, não a varredura
      fs.writeFileSync(cachePath, JSON.stringify(out), "utf8");
      if ((i / lote) % 10 === 0 || i + lote >= faltam.length) {
        console.log(`[varrer] ${Math.min(i + lote, faltam.length)}/${faltam.length} (cache: ${out.length}${falhas ? `, lotes perdidos: ${falhas}` : ""})`);
      }
      await espera(250);
    }
    if (falhas) console.log(`[varrer] ⚠️ ${falhas} lote(s) sem resposta — rode de novo para completar (o script retoma)`);
  }
  console.log(`[varrer] cache: ${cachePath} (${out.length} anúncios)`);
  return out;
}

async function main() {
  const host = assertBanco();
  const email = arg("user-email");
  if (!email) throw new Error("Faltou --user-email=<email>");
  const maxUsoFoto = Number(arg("max-uso-foto") ?? "5");

  const user = await prisma.user.findFirstOrThrow({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, email: true },
  });
  const cachePath = arg("cache") ?? path.join(OUT_DIR, `ml-fotos-${user.id}.json`);

  console.log(`\n===== DEDUPE POR FOTO DO ANÚNCIO =====`);
  console.log(`banco: ${host}`);
  console.log(`user : ${user.email}`);
  console.log(`cache: ${cachePath}`);

  let cache: CacheAnuncio[];
  if (args.includes("--varrer")) {
    cache = await varrer(user.id, cachePath, Number(arg("lote") ?? "60"), Number(arg("tentativas") ?? "5"));
  } else {
    if (!fs.existsSync(cachePath)) throw new Error(`Cache não existe: ${cachePath}. Rode com --varrer.`);
    cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    console.log(`[cache] ${cache.length} anúncios lidos`);
  }
  if (!args.includes("--analisar")) return;

  // ---------- fotos genéricas ----------
  const usoFoto = new Map<string, number>();
  for (const a of cache) for (const f of new Set(a.fotos)) usoFoto.set(f, (usoFoto.get(f) ?? 0) + 1);
  const genericas = new Set([...usoFoto].filter(([, n]) => n > maxUsoFoto).map(([f]) => f));
  console.log(`\n[fotos] ids distintos: ${usoFoto.size} | descartados por uso > ${maxUsoFoto}: ${genericas.size}`);

  // ---------- agrupa anúncios que compartilham foto ----------
  const pai = new Map<string, string>();
  const acha = (x: string): string => {
    let r = x;
    while (pai.get(r) !== r) { pai.set(r, pai.get(pai.get(r)!)!); r = pai.get(r)!; }
    return r;
  };
  const une = (a: string, b: string) => { const ra = acha(a), rb = acha(b); if (ra !== rb) pai.set(ra, rb); };
  for (const a of cache) pai.set(a.id, a.id);
  const porFoto = new Map<string, string[]>();
  for (const a of cache) {
    for (const f of new Set(a.fotos)) {
      if (genericas.has(f)) continue;
      if (!porFoto.has(f)) porFoto.set(f, []);
      porFoto.get(f)!.push(a.id);
    }
  }
  for (const [, anuncios] of porFoto) for (let i = 1; i < anuncios.length; i++) une(anuncios[0], anuncios[i]);

  const grupos = new Map<string, string[]>();
  for (const a of cache) {
    const r = acha(a.id);
    if (!grupos.has(r)) grupos.set(r, []);
    grupos.get(r)!.push(a.id);
  }
  const multi = [...grupos.values()].filter((g) => g.length > 1);
  console.log(`[grupos] anúncios: ${cache.length} | grupos: ${grupos.size} | grupos com +1 anúncio: ${multi.length}`);

  // ---------- liga anúncio → produto ----------
  const listings = await prisma.productListing.findMany({
    where: { product: { userId: user.id } },
    select: { externalListingId: true, product: { select: { id: true, sku: true, name: true, stock: true, attributes: true, createdFromMarketplace: true, createdAt: true, locationId: true, _count: { select: { orderItems: true, stockLogs: true, nfeItens: true, listings: true } } } } },
  });
  const prodPorAnuncio = new Map<string, (typeof listings)[number]["product"]>();
  for (const l of listings) if (l.externalListingId && l.product) prodPorAnuncio.set(l.externalListingId, l.product);

  /**
   * ADITIVO. Como eleger o dono do grupo.
   *
   * `etiquetaOrigem` (PADRÃO, comportamento de sempre): dono é a única peça com
   * `attributes.etiquetaOrigem` — o marcador que a MK2 usa.
   *
   * `auto`: para tenants cujo marcador de migração é outro. Vai descendo:
   *   1. única peça com `attributes.migration` (veio de planilha, SKU é etiqueta real);
   *   2. único SKU não-sintético (não começa com VAAPT-/ML-/SHP-/MGL-);
   *   3. única peça com localização;
   *   4. a mais antiga do grupo — empate desfeito pelo id, para ser determinístico.
   *
   * O passo 4 existe porque no Desmanche Tijuco Preto 2.434 de 2.890 grupos são
   * formados SÓ por produtos sintéticos: nenhum deles é "o original", e qualquer
   * um serve de dono desde que a escolha seja estável entre execuções.
   */
  const donoPor = arg("dono-por") ?? "etiquetaOrigem";
  if (!["etiquetaOrigem", "auto"].includes(donoPor))
    throw new Error(`--dono-por invalido: ${donoPor} (use etiquetaOrigem ou auto)`);
  const SINTETICO = /^(VAAPT|ML|SHP|MGL|MP)-/i;

  interface Cluster {
    anuncios: string[];
    produtos: Array<{ id: string; sku: string; nome: string; estoque: number; daVaapt: boolean; lastro: boolean; anuncios: number; migrado: boolean; vendeu: boolean; temLoc: boolean; criadoEm: string }>;
    dono: string; duplicatas: string[]; criterioDono?: string; recusadasPorTitulo?: string[];
  }
  let tituloRecusou = 0;
  const clusters: Cluster[] = [];
  for (const g of multi) {
    const vistos = new Map<string, Cluster["produtos"][number]>();
    for (const a of g) {
      const p = prodPorAnuncio.get(a);
      if (!p || vistos.has(p.id)) continue;
      vistos.set(p.id, {
        id: p.id, sku: p.sku, nome: p.name, estoque: p.stock,
        daVaapt: !!txt((p.attributes as any)?.etiquetaOrigem),
        lastro: p._count.orderItems > 0 || p._count.stockLogs > 0 || p._count.nfeItens > 0,
        anuncios: p._count.listings,
        migrado: !!txt((p.attributes as any)?.migration),
        vendeu: p._count.orderItems > 0,
        temLoc: !!p.locationId,
        criadoEm: p.createdAt.toISOString(),
      });
    }
    const produtos = [...vistos.values()];
    if (produtos.length < 2) continue;

    let dono = "";
    let criterio = "";
    const daVaapt = produtos.filter((p) => p.daVaapt);
    if (daVaapt.length === 1) {
      dono = daVaapt[0].sku;
      criterio = "etiquetaOrigem";
    } else if (donoPor === "auto") {
      const migrados = produtos.filter((p) => p.migrado);
      const reais = produtos.filter((p) => !SINTETICO.test(p.sku));
      const comLoc = produtos.filter((p) => p.temLoc);
      if (migrados.length === 1) {
        dono = migrados[0].sku;
        criterio = "unica peca migrada";
      } else if (reais.length === 1) {
        dono = reais[0].sku;
        criterio = "unico SKU nao-sintetico";
      } else if (comLoc.length === 1) {
        dono = comLoc[0].sku;
        criterio = "unica com localizacao";
      } else {
        const maisAntigo = [...produtos].sort(
          (a, b) => a.criadoEm.localeCompare(b.criadoEm) || a.id.localeCompare(b.id),
        )[0];
        dono = maisAntigo.sku;
        criterio = "mais antiga do grupo";
      }
    }

    // ⚠️ A FOTO NÃO É INFALÍVEL: o lojista reaproveita a mesma imagem em
    // anúncios de peças SEM relação. No 777 AutoParts, 118 de 3.180 grupos
    // juntavam coisas como "quebra-sol Azera" com "lanterna Spacefox" — fundir
    // esses apagaria uma peça real e somaria o estoque de outra.
    // Por isso a duplicata só entra se o título dela casar com o do dono; a que
    // não casa é deixada de fora do grupo, não o grupo inteiro descartado.
    const donoProduto = produtos.find((p) => p.sku === dono);
    const duplicatas: string[] = [];
    const recusadasPorTitulo: string[] = [];
    if (dono && donoProduto) {
      for (const p of produtos) {
        if (p.sku === dono) continue;
        if (
          areTitlesSimilar(p.nome, donoProduto.nome) &&
          !ladoOuEixoOposto(p.nome, donoProduto.nome)
        )
          duplicatas.push(p.sku);
        else recusadasPorTitulo.push(p.sku);
      }
    }
    if (recusadasPorTitulo.length) tituloRecusou += recusadasPorTitulo.length;

    clusters.push({
      anuncios: g, produtos,
      dono: duplicatas.length ? dono : "",
      duplicatas,
      criterioDono: duplicatas.length ? criterio || undefined : undefined,
      recusadasPorTitulo: recusadasPorTitulo.length ? recusadasPorTitulo : undefined,
    });
  }

  console.log(`\n===== VEREDITO =====`);
  console.log(`  grupos de anúncios que caem em MAIS DE UM produto: ${clusters.length}`);
  const resolviveis = clusters.filter((c) => c.dono);
  console.log(`     com UM dono claro .............................: ${resolviveis.length}`);
  console.log(`     sem dono claro ................................: ${clusters.length - resolviveis.length}`);
  const porCriterio = new Map<string, number>();
  for (const c of resolviveis)
    porCriterio.set(c.criterioDono ?? "?", (porCriterio.get(c.criterioDono ?? "?") ?? 0) + 1);
  for (const [k, n] of [...porCriterio.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`        dono por ${k}: ${n}`);
  console.log(`     duplicatas recusadas por titulo divergente ...: ${tituloRecusou}`);
  const dupSkus = new Set(resolviveis.flatMap((c) => c.duplicatas));
  console.log(`  produtos duplicados a resolver .................: ${dupSkus.size}`);
  console.log(`     com SKU puramente numérico (ocupa etiqueta) .: ${[...dupSkus].filter((s) => /^\d+$/.test(s)).length}`);
  const comLastro = resolviveis.flatMap((c) =>
    c.produtos.filter((p) => p.sku !== c.dono && p.lastro),
  );
  console.log(`     com venda/movimentação (não mexer sem pensar): ${comLastro.length}`);

  // Estoque do dono depois da fusão. O grupo é UMA peça física anunciada N
  // vezes, então somar os estoques inventaria peça que não existe: no Desmanche
  // Tijuco Preto os grupos somam 7.771 unidades para 2.870 peças.
  // Quando o dono é uma peça migrada, o estoque dele veio da contagem real do
  // galpão e é preservado; caso contrário a peça vale 1.
  const estoqueDoGrupo = args.includes("--uma-unidade-por-peca");
  if (estoqueDoGrupo) {
    let somaAntes = 0;
    let somaDepois = 0;
    for (const c of resolviveis) {
      const dono = c.produtos.find((p) => p.sku === c.dono);
      if (!dono) continue;
      somaAntes += c.produtos.reduce((a, p) => a + p.estoque, 0);
      // ⚠️ NUNCA SUBIR O ESTOQUE DE QUEM JÁ VENDEU. A regra "1 por peça física"
      // olha o maior estoque do grupo, e uma duplicata nunca vendida (estoque 1)
      // levantaria o dono de 0 para 1 — ressuscitando peça que saiu do galpão.
      // Medido antes da trava: 13 donos com venda registrada iam de 0 para 1.
      // Quem vendeu tem o histórico como autoridade; o estoque dele não é tocado.
      const final =
        dono.migrado || dono.vendeu
          ? dono.estoque
          : Math.min(1, Math.max(...c.produtos.map((p) => p.estoque)));
      (c as Cluster & { estoqueFinalDono?: number; politicaEstoque?: string }).estoqueFinalDono = final;
      (c as Cluster & { politicaEstoque?: string }).politicaEstoque = dono.migrado
        ? "preserva o estoque da peca migrada"
        : dono.vendeu
          ? "preserva: o dono ja vendeu"
          : "uma unidade por peca fisica";
      somaDepois += final;
    }
    console.log(`\n  estoque nos grupos resolvíveis: ${somaAntes} → ${somaDepois} (${somaAntes - somaDepois} unidades fantasma a menos)`);
  } else {
    console.log(`\n  estoque: NÃO decidido (use --uma-unidade-por-peca para gravar estoqueFinalDono no veredito)`);
  }

  console.log(`\n  amostra:`);
  for (const c of resolviveis.slice(0, 8)) {
    console.log(`     ${c.anuncios.length} anúncios · dono ${c.dono} · duplicatas ${JSON.stringify(c.duplicatas)}`);
    console.log(`        "${c.produtos[0].nome.slice(0, 52)}"`);
  }

  const saida = path.join(OUT_DIR, `dedupe-por-foto-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(saida, JSON.stringify({
    banco: host, user: user.email, maxUsoFoto,
    totais: { anuncios: cache.length, grupos: grupos.size, clustersMultiProduto: clusters.length, resolviveis: resolviveis.length, duplicatas: dupSkus.size },
    clusters,
  }, null, 1), "utf8");
  console.log(`\n  detalhe: ${saida}`);
}

main()
  .catch((e) => { console.error(e?.response?.data ?? e); process.exit(1); })
  .finally(() => prisma.$disconnect());
