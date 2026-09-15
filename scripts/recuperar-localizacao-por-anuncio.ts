/**
 * DEVOLVE A LOCALIZACAO USANDO O ID DO ANUNCIO COMO CHAVE
 * ======================================================
 *
 * O export da VAAPT traz a coluna `MLB` — o id do anuncio daquela peca no
 * Mercado Livre. Isso e uma chave DURA: o mesmo anuncio so pode ser de uma
 * peca. Cruzando `ProductListing.externalListingId` com essa coluna, a peca
 * do catalogo recebe a `Localizacao` que a planilha ja tinha.
 *
 * POR QUE ISSO IMPORTA
 * A varredura de anuncios criou milhares de produtos que nunca casaram com a
 * peca migrada — e nasceram SEM endereco de prateleira. No Desmanche Tijuco
 * Preto sobraram 7.331 produtos sem localizacao, 4.732 deles com SKU sintetico.
 *
 * ⚠️ AS CHAVES FRACAS JA FORAM TESTADAS E REPROVADAS:
 *  - etiqueta embutida no `seller_sku` ("12506 Caixa 301"): 93 candidatos, 6
 *    aproveitaveis;
 *  - titulo identico: dos 2.446 pares, so 198 dao para testar e apenas 63
 *    (31,8%) compartilham foto — dois tercos sao pecas DIFERENTES.
 * O id do anuncio nao tem esse problema.
 *
 * ⚠️ GRAVA TEXTO **E** FK JUNTOS. `Product.location` (texto, que a lista e o
 * card leem) e `Product.locationId` (FK, que a aba Localizacoes consulta) tem
 * de andar juntos: gravar so um faz a peca sumir de um dos lados. Foi o bug
 * que `scripts/corrigir-vinculo-localizacao.ts` existe para consertar.
 *
 * SO PREENCHE VAZIO. Produto que ja tem localizacao nao e tocado.
 *
 * CLI:
 *   npx tsx scripts/recuperar-localizacao-por-anuncio.ts --user-email=<email> --planilha=<arquivo.xlsx> --dry-run
 *   npx tsx scripts/recuperar-localizacao-por-anuncio.ts --user-email=<email> --planilha=<arquivo.xlsx> --apply
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";
import prisma from "../app/lib/prisma";

const args = process.argv.slice(2);
const arg = (n: string) => {
  const p = `--${n}=`;
  const f = args.find((a) => a.startsWith(p));
  return f ? f.slice(p.length) : undefined;
};
const OUT_DIR = path.resolve(__dirname, "out");
const DRY = !args.includes("--apply");

function assertBanco() {
  const host =
    (process.env.DATABASE_URL || "").match(/@([^:/?]+)/)?.[1] ?? "(desconhecido)";
  if (!args.includes("--allow-any-host") && !host.includes("sa-east-1")) {
    throw new Error(`DATABASE_URL aponta para "${host}", nao sa-east-1.`);
  }
  return host;
}

const asString = (v: unknown) => String(v ?? "").trim();
/** Mesma normalizacao do import-vaapt-emp583: upper, sem espacos. */
const normalizeCode = (raw: unknown): string | null => {
  const s = asString(raw);
  return s ? s.toUpperCase().replace(/\s+/g, "") : null;
};

async function main() {
  const host = assertBanco();
  const email = arg("user-email");
  const planilha = arg("planilha");
  const colMlb = arg("col-mlb") ?? "MLB";
  const colLoc = arg("col-loc") ?? "Localizacao";
  if (!email) throw new Error("Informe --user-email=");
  if (!planilha) throw new Error("Informe --planilha=<arquivo.xlsx>");

  const user = await prisma.user.findFirstOrThrow({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, email: true, name: true },
  });
  console.log(`[loc] banco ${host} | modo ${DRY ? "DRY-RUN" : "APPLY"}`);
  console.log(`[loc] cliente ${user.name} (${user.id})`);

  const wb = XLSX.readFile(planilha);
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    wb.Sheets[wb.SheetNames[0]],
    { defval: null },
  );
  const porMlb = new Map<string, { loc: string; code: string }>();
  for (const r of rows) {
    const mlb = asString(r[colMlb]).toUpperCase();
    if (!/^MLB\d+$/.test(mlb)) continue;
    const loc = asString(r[colLoc]);
    const code = normalizeCode(loc);
    if (!loc || !code || loc.toLowerCase() === "null") continue;
    if (!porMlb.has(mlb)) porMlb.set(mlb, { loc, code });
  }
  console.log(`[loc] planilha: ${rows.length} linhas | ${porMlb.size} anuncios com localizacao`);

  // Só produtos SEM localização — nada que já tenha endereço é tocado.
  const listings = await prisma.productListing.findMany({
    where: {
      marketplaceAccount: { userId: user.id },
      product: { locationId: null },
    },
    select: {
      externalListingId: true,
      product: { select: { id: true, sku: true, name: true, location: true } },
    },
  });
  console.log(`[loc] anuncios de produtos sem localizacao: ${listings.length}`);

  type Plano = { id: string; sku: string; nome: string; loc: string; code: string; anuncio: string };
  const planos = new Map<string, Plano>();
  const conflitos: Array<{ id: string; sku: string; a: string; b: string }> = [];

  for (const l of listings) {
    const achou = porMlb.get(String(l.externalListingId).toUpperCase());
    if (!achou || !l.product) continue;
    const ja = planos.get(l.product.id);
    if (ja) {
      // Dois anúncios do mesmo produto apontando para caixas diferentes:
      // não invento desempate, deixo para conferência.
      if (ja.code !== achou.code)
        conflitos.push({ id: l.product.id, sku: l.product.sku, a: ja.loc, b: achou.loc });
      continue;
    }
    planos.set(l.product.id, {
      id: l.product.id,
      sku: l.product.sku,
      nome: l.product.name,
      loc: achou.loc,
      code: achou.code,
      anuncio: l.externalListingId,
    });
  }
  for (const c of conflitos) planos.delete(c.id);

  const lista = [...planos.values()];
  const codigos = [...new Set(lista.map((p) => p.code))];
  const existentes = new Map<string, string>();
  for (const l of await prisma.location.findMany({
    where: { userId: user.id },
    select: { id: true, code: true },
  }))
    existentes.set(l.code, l.id);
  const novos = codigos.filter((c) => !existentes.has(c));

  console.log("\n--- PLANO ---");
  console.log(`produtos a receber localizacao : ${lista.length}`);
  console.log(`enderecos distintos            : ${codigos.length}`);
  console.log(`  ja existem no cadastro       : ${codigos.length - novos.length}`);
  console.log(`  a criar                      : ${novos.length}`);
  console.log(`conflitos (2 caixas p/ a mesma peca, pulados): ${conflitos.length}`);
  for (const p of lista.slice(0, 6))
    console.log(`   ex: ${p.sku.padEnd(14)} -> ${p.loc.padEnd(10)} | ${p.nome.slice(0, 44)}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const modo = DRY ? "dryrun" : "apply";
  fs.writeFileSync(
    path.join(OUT_DIR, `recuperar-localizacao-${modo}-${stamp}.json`),
    JSON.stringify({ planos: lista, conflitos }, null, 1),
  );

  let gravados = 0;
  let criados = 0;
  let erros = 0;

  if (!DRY) {
    for (const code of novos) {
      try {
        const amostra = lista.find((p) => p.code === code);
        const c = await prisma.location.create({
          data: { userId: user.id, code, description: amostra?.loc ?? code },
          select: { id: true },
        });
        existentes.set(code, c.id);
        criados++;
      } catch {
        // corrida benigna: já existe
        const ex = await prisma.location.findUnique({
          where: { userId_code: { userId: user.id, code } },
          select: { id: true },
        });
        if (ex) existentes.set(code, ex.id);
        else erros++;
      }
    }

    for (let i = 0; i < lista.length; i += 200) {
      const lote = lista.slice(i, i + 200);
      try {
        await prisma.$transaction(
          lote.map((p) =>
            prisma.product.update({
              where: { id: p.id },
              // TEXTO **E** FK juntos — ver o aviso no cabeçalho.
              data: { location: p.loc, locationId: existentes.get(p.code) ?? null },
            }),
          ),
        );
        gravados += lote.length;
      } catch (e) {
        erros += lote.length;
        console.error(`[loc] lote ${i} falhou: ${(e as Error).message}`);
      }
      if (i % 1000 === 0) process.stdout.write(`\r[loc] ${gravados}/${lista.length}   `);
    }
    console.log("");
  }

  console.log("\n===== RESUMO =====");
  console.log(`modo                 ${DRY ? "DRY-RUN (nada gravado)" : "APLICADO"}`);
  console.log(`produtos localizados ${DRY ? lista.length : gravados}`);
  console.log(`enderecos criados    ${DRY ? novos.length : criados}`);
  console.log(`conflitos pulados    ${conflitos.length}`);
  console.log(`erros                ${erros}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[loc][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
