/**
 * DESFAZ AS FUSOES QUE NAO DEVIAM TER ACONTECIDO
 * ==============================================
 *
 * A fusao por foto (`dedupe-anuncios-por-foto.ts`) ganhou guarda de titulo
 * DEPOIS de ja ter rodado no primeiro cliente, e ganhou a guarda de lado/eixo
 * depois de ja ter rodado em oito. Este script refaz o julgamento sobre o que
 * foi aplicado e devolve ao catalogo a peca que foi apagada por engano.
 *
 * DE ONDE VEM O PASSIVO (medido em 15/09/2026)
 *
 *   A) Sem guarda de titulo nenhuma — o Tijuco Preto foi o primeiro cliente e
 *      foi fundido antes de a guarda existir. Ela so nasceu no 777, quando 118
 *      de 3.180 grupos juntavam "quebra-sol Azera" com "lanterna Spacefox".
 *      Refazendo o julgamento sobre os `planos[]` gravados: **720 de 14.560
 *      fusoes (4,9%) a guarda de hoje recusaria**, 714 delas no Tijuco Preto
 *      (13,8% do cliente). Exemplo: "Fechadura Eletrica Porta Dianteira
 *      Esquerda Nissan Kicks" fundida em "Borracha Porta Traseira Direita Fiat
 *      Toro" — semelhanca 0,06.
 *
 *   B) Com a guarda de titulo, mas cega a lado/eixo — **39 fusoes** passaram no
 *      Jaccard com lado ou eixo OPOSTOS (MK2 24, Tijuco Preto 7, Revive 5,
 *      777 3). Exemplo: "Dobradica Braco Direito Capo Fiat Uno Vivace" fundida
 *      em "Dobradica Braco Esquerdo Capo Fiat Uno Vivace", semelhanca 0,75.
 *
 * O QUE A FUSAO FEZ, E O QUE ESTE SCRIPT DESFAZ
 *   fusao:   move os `ProductListing` da duplicata para o dono, apaga o produto
 *            duplicado (ou so renomeia, quando tinha lastro) e ajusta estoque.
 *   desfaz:  recria o produto com o MESMO id e os MESMOS campos do backup e
 *            devolve a ele os anuncios que eram dele.
 *
 * ⚠️⚠️ SO DESFAZ O QUE ESTA INTACTO. Se qualquer coisa mexeu no par depois da
 * fusao, o script RECUSA e explica — nunca adivinha:
 *   - o id do produto voltou a existir (ja foi recriado por outra via);
 *   - o SKU foi tomado por outro produto (`@@unique([userId, sku])`);
 *   - um anuncio do backup nao existe mais;
 *   - um anuncio NAO esta no dono da fusao (foi reapontado depois, e devolver
 *     agora desfaria uma correcao posterior — que pode estar certa).
 *
 * ⚠️ O ESTOQUE VOLTA COMO ESTAVA NO BACKUP. A politica "1 unidade por peca
 * fisica" valia para duas copias da MESMA peca; aqui sao pecas DIFERENTES, e
 * cada uma tem a propria unidade. E exatamente a unidade que a fusao destruiu.
 *
 * CLI:
 *   npx tsx scripts/desfazer-fusao-indevida.ts --user-email=<email>            (dry-run)
 *   npx tsx scripts/desfazer-fusao-indevida.ts --user-email=<email> --apply
 *   npx tsx scripts/desfazer-fusao-indevida.ts --todos                         (todos os clientes)
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";
import prisma from "../app/lib/prisma";
import { areTitlesSimilar, titleSimilarity } from "../app/lib/title-similarity";
import { ladoOuEixoOposto, motivoOposicao } from "./lib/lado-e-eixo";

const args = process.argv.slice(2);
const arg = (n: string) => {
  const p = `--${n}=`;
  const f = args.find((a) => a.startsWith(p));
  return f ? f.slice(p.length) : undefined;
};

const OUT_DIR = path.resolve(__dirname, "out");
const DRY = !args.includes("--apply");
const TODOS = args.includes("--todos");

function assertBanco() {
  const host =
    (process.env.DATABASE_URL || "").match(/@([^:/?]+)/)?.[1] ?? "(desconhecido)";
  if (!args.includes("--allow-any-host") && !host.includes("sa-east-1")) {
    throw new Error(`DATABASE_URL aponta para "${host}", nao sa-east-1.`);
  }
  return host;
}

type ProdutoBackup = {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  price: string | number | null;
  stock: number;
  quality: string | null;
  location: string | null;
  locationId: string | null;
  imageUrl: string | null;
  imageUrls: string[] | null;
  partNumber: string | null;
  brand: string | null;
  model: string | null;
  year: string | number | null;
  category: string | null;
  attributes: unknown;
  createdAt: string;
  listings?: Array<{ externalListingId: string }>;
};

type Caso = {
  cliente: string;
  dupId: string;
  dupSku: string;
  dupNome: string;
  dupEstoque: number;
  donoId: string;
  donoNome: string;
  sim: number;
  classe: "sem semelhanca" | "lado/eixo oposto";
  oposicao: string;
  anuncios: string[];
  backup: ProdutoBackup;
  decisao: "DESFAZER" | "RECUSADO";
  motivo?: string;
};

/** Emparelha cada relatorio de aplicacao com o backup do mesmo instante. */
function paresDeArquivos(): Array<{ apply: string; backup: string }> {
  const arquivos = fs.readdirSync(OUT_DIR);
  const out: Array<{ apply: string; backup: string }> = [];
  for (const a of arquivos.filter((f) => /^duplicatas-apply-.*\.json$/.test(f))) {
    const stamp = a.replace(/^duplicatas-apply-/, "").replace(/\.json$/, "");
    const b = `duplicatas-backup-apply-${stamp}.json`;
    if (arquivos.includes(b)) out.push({ apply: a, backup: b });
  }
  return out.sort((x, y) => x.apply.localeCompare(y.apply));
}

async function main() {
  const host = assertBanco();
  const email = arg("user-email");
  if (!email && !TODOS) throw new Error("Informe --user-email=<email> ou --todos");

  console.log(`[desfazer] banco ${host} | modo ${DRY ? "DRY-RUN" : "APPLY"}`);
  console.log(`[desfazer] alvo: ${TODOS ? "TODOS os clientes" : email}`);

  // ---------- 1. reune os casos a partir dos relatorios gravados ----------
  const casos: Caso[] = [];
  for (const { apply, backup } of paresDeArquivos()) {
    const rel = JSON.parse(fs.readFileSync(path.join(OUT_DIR, apply), "utf8"));
    if (String(rel.modo ?? "").toUpperCase().includes("DRY")) continue;
    const cliente = String(rel.user ?? "?");
    if (!TODOS && cliente.toLowerCase() !== String(email).toLowerCase()) continue;

    const bak = JSON.parse(fs.readFileSync(path.join(OUT_DIR, backup), "utf8"));
    const porId = new Map<string, ProdutoBackup>(
      (bak.produtos ?? []).map((p: ProdutoBackup) => [p.id, p]),
    );

    // O nome do dono nao vai no plano; o dono nunca e renomeado pelo resolver,
    // entao o nome atual dele no banco E o nome da epoca.
    const donoIds = [...new Set((rel.planos ?? []).map((p: any) => p.donoId).filter(Boolean))] as string[];
    const nomeDono = new Map<string, string>();
    for (let i = 0; i < donoIds.length; i += 500) {
      const rows = await prisma.product.findMany({
        where: { id: { in: donoIds.slice(i, i + 500) } },
        select: { id: true, name: true },
      });
      for (const r of rows) nomeDono.set(r.id, r.name);
    }

    for (const p of rel.planos ?? []) {
      const donoNome = nomeDono.get(p.donoId);
      const b = porId.get(p.dupId);
      if (!donoNome || !p.dupNome || !b) continue;
      if (!p.apagar) continue; // renomeada, nao apagada: o produto ainda esta la

      const oposicao = motivoOposicao(p.dupNome, donoNome);
      const semSemelhanca = !areTitlesSimilar(p.dupNome, donoNome);
      const oposto = ladoOuEixoOposto(p.dupNome, donoNome);
      if (!semSemelhanca && !oposto) continue; // a fusao estava certa

      casos.push({
        cliente,
        dupId: p.dupId,
        dupSku: p.dupSku,
        dupNome: p.dupNome,
        dupEstoque: p.dupEstoque ?? b.stock ?? 0,
        donoId: p.donoId,
        donoNome,
        sim: Number(titleSimilarity(p.dupNome, donoNome).toFixed(3)),
        classe: semSemelhanca ? "sem semelhanca" : "lado/eixo oposto",
        oposicao,
        anuncios: (b.listings ?? []).map((l) => l.externalListingId).filter(Boolean),
        backup: b,
        decisao: "DESFAZER",
      });
    }
  }
  console.log(`[desfazer] fusoes indevidas encontradas nos relatorios: ${casos.length}`);
  if (casos.length === 0) return;

  // ---------- 2. confere o estado atual em LOTE ----------
  const idsProduto = [...new Set(casos.map((c) => c.dupId))];
  const existe = new Set<string>();
  for (let i = 0; i < idsProduto.length; i += 500) {
    const rows = await prisma.product.findMany({
      where: { id: { in: idsProduto.slice(i, i + 500) } },
      select: { id: true },
    });
    for (const r of rows) existe.add(r.id);
  }

  const userIds = new Map<string, string>();
  for (const c of new Set(casos.map((x) => x.cliente))) {
    const u = await prisma.user.findFirst({
      where: { email: { equals: c, mode: "insensitive" } },
      select: { id: true },
    });
    if (u) userIds.set(c, u.id);
  }

  // SKU ocupado hoje por OUTRO produto do mesmo cliente
  const skuOcupado = new Map<string, string>(); // `${userId} ${sku}` -> productId
  for (const [cliente, userId] of userIds) {
    const skus = [...new Set(casos.filter((c) => c.cliente === cliente).map((c) => c.dupSku))];
    for (let i = 0; i < skus.length; i += 500) {
      const rows = await prisma.product.findMany({
        where: { userId, sku: { in: skus.slice(i, i + 500) } },
        select: { id: true, sku: true },
      });
      for (const r of rows) skuOcupado.set(`${userId} ${r.sku}`, r.id);
    }
  }

  const idsAnuncio = [...new Set(casos.flatMap((c) => c.anuncios))];
  const donoAtual = new Map<string, { listingId: string; productId: string }>();
  for (let i = 0; i < idsAnuncio.length; i += 500) {
    const rows = await prisma.productListing.findMany({
      where: { externalListingId: { in: idsAnuncio.slice(i, i + 500) } },
      select: { id: true, externalListingId: true, productId: true },
    });
    for (const r of rows)
      donoAtual.set(r.externalListingId, { listingId: r.id, productId: r.productId });
  }

  // ---------- 3. decide caso a caso ----------
  const recusa = (c: Caso, m: string) => {
    c.decisao = "RECUSADO";
    c.motivo = m;
  };
  for (const c of casos) {
    const userId = userIds.get(c.cliente);
    if (!userId) {
      recusa(c, "cliente nao encontrado pelo email do relatorio");
      continue;
    }
    if (existe.has(c.dupId)) {
      recusa(c, "o produto ja existe de novo — nada a recriar");
      continue;
    }
    const dono = skuOcupado.get(`${userId} ${c.dupSku}`);
    if (dono) {
      recusa(c, `SKU "${c.dupSku}" agora pertence a outro produto (${dono})`);
      continue;
    }
    if (c.anuncios.length === 0) {
      recusa(c, "o backup nao registrou nenhum anuncio — sem como devolver");
      continue;
    }
    const sumidos = c.anuncios.filter((a) => !donoAtual.has(a));
    if (sumidos.length) {
      recusa(c, `${sumidos.length} anuncio(s) do backup nao existem mais`);
      continue;
    }
    const movidos = c.anuncios.filter((a) => donoAtual.get(a)!.productId !== c.donoId);
    if (movidos.length) {
      recusa(
        c,
        `${movidos.length} anuncio(s) ja foram reapontados para outro produto depois da fusao`,
      );
      continue;
    }
  }

  const aFazer = casos.filter((c) => c.decisao === "DESFAZER");
  const recusados = casos.filter((c) => c.decisao === "RECUSADO");

  console.log("\n--- PLANO ---");
  const porCliente = new Map<string, { faz: number; rec: number; un: number }>();
  for (const c of casos) {
    const e = porCliente.get(c.cliente) ?? { faz: 0, rec: 0, un: 0 };
    if (c.decisao === "DESFAZER") {
      e.faz++;
      e.un += c.backup.stock ?? 0;
    } else e.rec++;
    porCliente.set(c.cliente, e);
  }
  console.log("cliente".padEnd(38) + "desfazer".padStart(10) + "recusado".padStart(10) + "unidades".padStart(10));
  console.log("-".repeat(68));
  for (const [k, v] of [...porCliente].sort((a, b) => b[1].faz - a[1].faz))
    console.log(String(k).padEnd(38) + String(v.faz).padStart(10) + String(v.rec).padStart(10) + String(v.un).padStart(10));
  console.log("-".repeat(68));
  console.log(
    "TOTAL".padEnd(38) +
      String(aFazer.length).padStart(10) +
      String(recusados.length).padStart(10) +
      String(aFazer.reduce((a, c) => a + (c.backup.stock ?? 0), 0)).padStart(10),
  );

  console.log(`\npor classe:`);
  for (const cl of ["sem semelhanca", "lado/eixo oposto"] as const)
    console.log(`  ${cl.padEnd(20)} ${aFazer.filter((c) => c.classe === cl).length}`);

  if (recusados.length) {
    console.log(`\nmotivos de recusa:`);
    const m = new Map<string, number>();
    for (const c of recusados) {
      const chave = (c.motivo ?? "").replace(/\d+/g, "N").replace(/\(.*\)/, "(...)");
      m.set(chave, (m.get(chave) ?? 0) + 1);
    }
    for (const [k, v] of [...m].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
  }

  console.log(`\namostra do que seria desfeito:`);
  for (const c of aFazer.slice(0, 8)) {
    console.log(`  [${c.classe}${c.oposicao ? " " + c.oposicao : ""}] sim=${c.sim} est=${c.backup.stock} anuncios=${c.anuncios.length}`);
    console.log(`     VOLTA: ${c.dupSku} · ${c.dupNome}`);
    console.log(`     estava fundida em: ${c.donoNome}`);
  }

  // ---------- 4. relatorio ----------
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(OUT_DIR, `desfazer-fusao-${DRY ? "dryrun" : "apply"}-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(casos, null, 2), "utf8");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      casos.map((c) => ({
        Cliente: c.cliente,
        Decisao: c.decisao,
        Motivo: c.motivo ?? "",
        Classe: c.classe,
        Oposicao: c.oposicao,
        Semelhanca: c.sim,
        "SKU que volta": c.dupSku,
        "Peca que volta": c.dupNome,
        "Estava fundida em": c.donoNome,
        Estoque: c.backup.stock,
        Anuncios: c.anuncios.length,
      })),
    ),
    "desfazer",
  );
  const xlsxPath = path.join(OUT_DIR, `desfazer-fusao-${DRY ? "dryrun" : "apply"}-${stamp}.xlsx`);
  fs.writeFileSync(xlsxPath, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

  if (DRY) {
    console.log(`\n===== RESUMO =====`);
    console.log(`modo DRY-RUN — 0 escritas`);
    console.log(`json     ${jsonPath}`);
    console.log(`planilha ${xlsxPath}`);
    return;
  }

  // ---------- 5. aplica ----------
  let feitos = 0;
  let anunciosDevolvidos = 0;
  const falhas: Array<{ dupId: string; erro: string }> = [];
  for (const c of aFazer) {
    const userId = userIds.get(c.cliente)!;
    const b = c.backup;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.product.create({
          data: {
            id: b.id,
            userId,
            sku: b.sku,
            name: b.name,
            description: b.description ?? undefined,
            // `price` e obrigatorio no schema. O backup sempre traz o valor da
            // peca; o `?? 0` so existe para o caso de um backup antigo sem ele.
            price: (b.price ?? 0) as never,
            stock: b.stock ?? 0,
            quality: (b.quality ?? undefined) as never,
            location: b.location ?? undefined,
            locationId: b.locationId ?? undefined,
            imageUrl: b.imageUrl ?? undefined,
            imageUrls: b.imageUrls ?? undefined,
            partNumber: b.partNumber ?? undefined,
            brand: b.brand ?? undefined,
            model: b.model ?? undefined,
            year: (b.year ?? undefined) as never,
            category: b.category ?? undefined,
            attributes: (b.attributes ?? undefined) as never,
            createdAt: b.createdAt ? new Date(b.createdAt) : undefined,
          },
        });
        const ids = c.anuncios.map((a) => donoAtual.get(a)!.listingId);
        const r = await tx.productListing.updateMany({
          where: { id: { in: ids }, productId: c.donoId },
          data: { productId: b.id },
        });
        anunciosDevolvidos += r.count;
        await tx.stockLog.create({
          data: {
            productId: b.id,
            change: b.stock ?? 0,
            previousStock: 0,
            newStock: b.stock ?? 0,
            reason: `Fusao indevida desfeita: a peca havia sido apagada por engano ao ser confundida com "${c.donoNome}" (semelhanca ${c.sim}${c.oposicao ? ", " + c.oposicao : ""}).`,
          },
        });
      });
      feitos++;
      if (feitos % 50 === 0) process.stdout.write(`\r[desfazer] ${feitos}/${aFazer.length}   `);
    } catch (e) {
      falhas.push({ dupId: c.dupId, erro: (e as Error).message.slice(0, 160) });
    }
  }
  console.log(`\n\n===== RESUMO =====`);
  console.log(`modo APPLY`);
  console.log(`produtos devolvidos ao catalogo: ${feitos}`);
  console.log(`anuncios devolvidos            : ${anunciosDevolvidos}`);
  console.log(`recusados (nao tocados)        : ${recusados.length}`);
  console.log(`falhas                         : ${falhas.length}`);
  for (const f of falhas.slice(0, 10)) console.log(`   ${f.dupId}: ${f.erro}`);
  fs.writeFileSync(jsonPath, JSON.stringify({ casos, falhas }, null, 2), "utf8");
  console.log(`json     ${jsonPath}`);
  console.log(`planilha ${xlsxPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
