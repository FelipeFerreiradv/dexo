/**
 * O ANUNCIO DO ML BATE COM O PRODUTO QUE ELE APONTA NA DEXO?
 * =========================================================
 *
 * Nasceu do caso 12506 do Desmanche Tijuco Preto (14/09/2026), onde um
 * "Chicote De Injecao Gm Vectra 2.2" vendeu no ML e a Dexo deu baixa num
 * "Puxador Interno Porta Traseira Esquerda". Prova coletada na API:
 *
 *   MLB5148843769  ML="Chicote..."  Dexo="Puxador..."   <- vendeu 1
 *   MLB5145535539  ML="Chicote..."  Dexo="Puxador..."
 *   MLB6456374482  ML="Chicote..."  Dexo="Chicote..."   <- o certo
 *
 * Os tres anuncios de chicote carregam `seller_sku = 12506` e a MESMA foto
 * (861123-MLB80429008534_112024). Como o produto "Puxador" tambem tem SKU
 * 12506 no catalogo (veio da etiqueta VAAPT), a autodeteccao colou dois deles
 * na peca errada — e a venda seguiu o vinculo errado.
 *
 * ⚠️ POR QUE O TITULO E A UNICA TESTEMUNHA CONFIAVEL AQUI
 * O `seller_sku` desta base esta poluido: `externalSku = "1"` aparece em 945
 * anuncios, "8383" em 468, "3838" em 445. SKU igual NAO prova mesma peca.
 * O titulo do anuncio, comparado com o nome do produto, prova o desencontro.
 *
 * ⚠️ RODAR A VARREDURA NA VPS. Refresh de token do ML a partir da maquina
 * local marca a conta como ERROR (client_id local != producao) e o lojista
 * para de receber pedidos. A varredura so LE.
 *
 * FASES
 *   --varrer    le a API do ML e grava o cache (resumivel, salva a cada lote)
 *   --analisar  cruza o cache com o banco e emite o veredito + planilha
 *
 * CLI:
 *   npx tsx scripts/conferir-anuncio-vs-produto-ml.ts --user-email=<email> --varrer
 *   npx tsx scripts/conferir-anuncio-vs-produto-ml.ts --user-email=<email> --analisar
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";
import prisma from "../app/lib/prisma";
import { areTitlesSimilar, titleSimilarity } from "../app/lib/title-similarity";

const args = process.argv.slice(2);
const arg = (n: string) => {
  const p = `--${n}=`;
  const f = args.find((a) => a.startsWith(p));
  return f ? f.slice(p.length) : undefined;
};

const OUT_DIR = path.resolve(__dirname, "out");
const LOTE = 20; // teto do multiget do ML

type Anuncio = {
  id: string;
  title: string | null;
  status: string | null;
  subStatus: string[];
  sellerSku: string | null;
  quantidade: number | null;
  vendidos: number | null;
  sellerId: number | null;
  fotos: string[];
};

function caminhoCache(userId: string) {
  return path.join(OUT_DIR, `anuncios-ml-cache-${userId}.json`);
}

function lerCache(userId: string): Record<string, Anuncio> {
  const f = caminhoCache(userId);
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, Anuncio>;
  } catch {
    console.warn("[varrer] cache ilegivel, recomecando do zero");
    return {};
  }
}

async function resolverUsuario() {
  const email = arg("user-email");
  const userId = arg("user-id");
  if (!email && !userId) throw new Error("Informe --user-email= ou --user-id=");
  return userId
    ? prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, email: true, name: true },
      })
    : prisma.user.findFirstOrThrow({
        where: { email: { equals: email as string, mode: "insensitive" } },
        select: { id: true, email: true, name: true },
      });
}

async function varrer() {
  const user = await resolverUsuario();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cache = lerCache(user.id);
  console.log(`[varrer] cliente ${user.name} (${user.id})`);
  console.log(`[varrer] ja no cache: ${Object.keys(cache).length}`);

  const contas = await prisma.marketplaceAccount.findMany({
    where: { userId: user.id, platform: "MERCADO_LIVRE" },
    select: { id: true, accountName: true, accessToken: true, expiresAt: true },
  });
  for (const c of contas) {
    const venc = c.expiresAt < new Date() ? "VENCIDO" : "ok";
    console.log(`[varrer] conta ${c.accountName} token ${venc}`);
  }

  let novos = 0;
  let falhas = 0;

  for (const conta of contas) {
    const listings = await prisma.productListing.findMany({
      where: { marketplaceAccountId: conta.id },
      select: { externalListingId: true },
    });
    const pendentes = listings
      .map((l) => l.externalListingId)
      .filter((id) => id && !cache[id]);
    console.log(
      `[varrer] ${conta.accountName}: ${listings.length} anuncios, ${pendentes.length} a buscar`,
    );

    for (let i = 0; i < pendentes.length; i += LOTE) {
      const ids = pendentes.slice(i, i + LOTE);
      try {
        const url =
          `https://api.mercadolibre.com/items?ids=${ids.join(",")}` +
          `&attributes=id,title,status,sub_status,seller_custom_field,available_quantity,sold_quantity,seller_id,pictures,attributes`;
        const r = await fetch(url, {
          headers: { Authorization: `Bearer ${conta.accessToken}` },
        });
        if (!r.ok) {
          falhas += ids.length;
          if (r.status === 401 || r.status === 403) {
            console.error(
              `[varrer] ${r.status} na conta ${conta.accountName} — token sem permissao. Interrompendo esta conta.`,
            );
            break;
          }
          continue;
        }
        const arr = (await r.json()) as Array<{
          code: number;
          body?: Record<string, unknown>;
        }>;
        for (const it of arr) {
          const b = it.body;
          if (!b || !b.id) continue;
          const attrs = (b.attributes ?? []) as Array<{
            id?: string;
            value_name?: string;
          }>;
          const skuAttr = attrs.find((a) => /SELLER_SKU/i.test(a.id ?? ""));
          cache[String(b.id)] = {
            id: String(b.id),
            title: (b.title as string) ?? null,
            status: (b.status as string) ?? null,
            subStatus: (b.sub_status as string[]) ?? [],
            sellerSku:
              (b.seller_custom_field as string) ?? skuAttr?.value_name ?? null,
            quantidade: (b.available_quantity as number) ?? null,
            vendidos: (b.sold_quantity as number) ?? null,
            sellerId: (b.seller_id as number) ?? null,
            fotos: ((b.pictures ?? []) as Array<{ id?: string }>)
              .map((p) => p.id ?? "")
              .filter(Boolean),
          };
          novos++;
        }
      } catch (e) {
        falhas += ids.length;
        console.error(`[varrer] erro no lote ${i}: ${(e as Error).message}`);
      }

      if ((i / LOTE) % 25 === 0) {
        fs.writeFileSync(caminhoCache(user.id), JSON.stringify(cache));
        process.stdout.write(
          `\r[varrer] ${conta.accountName} ${i + ids.length}/${pendentes.length} (cache ${Object.keys(cache).length})   `,
        );
      }
    }
    fs.writeFileSync(caminhoCache(user.id), JSON.stringify(cache));
    console.log("");
  }

  fs.writeFileSync(caminhoCache(user.id), JSON.stringify(cache));
  console.log(`\n[varrer] novos ${novos} · falhas ${falhas}`);
  console.log(`[varrer] cache total ${Object.keys(cache).length}`);
  console.log(`[varrer] arquivo ${caminhoCache(user.id)}`);
}

async function analisar() {
  const user = await resolverUsuario();
  const cache = lerCache(user.id);
  const total = Object.keys(cache).length;
  if (total === 0) throw new Error("Cache vazio — rode --varrer primeiro.");
  console.log(`[analisar] cache com ${total} anuncios`);

  const listings = await prisma.productListing.findMany({
    where: { marketplaceAccount: { userId: user.id, platform: "MERCADO_LIVRE" } },
    select: {
      id: true,
      externalListingId: true,
      externalSku: true,
      status: true,
      marketplaceAccount: { select: { accountName: true } },
      product: {
        select: { id: true, sku: true, name: true, stock: true, locationId: true },
      },
    },
  });
  console.log(`[analisar] ${listings.length} vinculos no banco`);

  const divergentes: Record<string, string | number>[] = [];
  let conferidos = 0;
  let batem = 0;
  let semCache = 0;
  let sumiuDoMl = 0;
  let semNome = 0;

  for (const l of listings) {
    const a = cache[l.externalListingId];
    // ⚠️ TRÊS MOTIVOS DIFERENTES, NÃO UM. Agrupar tudo como "não varrido"
    // escondia o caso mais informativo: no Leonardo Jotabe, 18.024 dos 42.720
    // vínculos apontam para anúncio que o ML devolve 404 — o anúncio não existe
    // mais. Isso não é falha da varredura, é catálogo apontando para o vazio.
    if (!a) {
      semCache++;
      continue;
    }
    if (!a.title) {
      sumiuDoMl++;
      continue;
    }
    if (!l.product?.name) {
      semNome++;
      continue;
    }
    conferidos++;
    if (areTitlesSimilar(a.title, l.product.name)) {
      batem++;
      continue;
    }
    divergentes.push({
      Anuncio: l.externalListingId,
      Conta: l.marketplaceAccount.accountName,
      "Titulo no Mercado Livre": a.title,
      "Produto na Dexo": l.product.name,
      "SKU do produto": l.product.sku,
      "SKU do anuncio": l.externalSku ?? a.sellerSku ?? "",
      Semelhanca: Number(titleSimilarity(a.title, l.product.name).toFixed(3)),
      "Status no ML": a.status ?? "",
      "Ja vendeu": a.vendidos ?? 0,
      "Estoque do produto": l.product.stock,
      "Produto tem localizacao": l.product.locationId ? "sim" : "nao",
    });
  }

  // Um anuncio que JA VENDEU e aponta para o produto errado significa baixa de
  // estoque na peca errada — e o subconjunto que exige acao imediata.
  const vendidosErrados = divergentes.filter((d) => Number(d["Ja vendeu"]) > 0);

  console.log("\n--- VEREDITO ---");
  console.log(`vinculos conferidos        ${conferidos}`);
  console.log(`titulo bate                ${batem}`);
  console.log(
    `titulo NAO bate            ${divergentes.length}` +
      (conferidos ? `  (${((divergentes.length / conferidos) * 100).toFixed(1)}%)` : ""),
  );
  console.log(`  destes, ja venderam      ${vendidosErrados.length}  <- baixa na peca errada`);
  console.log(`anuncio sumiu do ML (404)     ${sumiuDoMl}`);
  console.log(`produto sem nome           ${semNome}`);
  console.log(`sem cache (nao varridos)   ${semCache}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonOut = path.join(OUT_DIR, `anuncio-vs-produto-${stamp}.json`);
  fs.writeFileSync(
    jsonOut,
    JSON.stringify(
      { conferidos, batem, divergentes: divergentes.length, vendidosErrados: vendidosErrados.length, semCache, itens: divergentes },
      null,
      1,
    ),
  );

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet([
      { Campo: "Vinculos conferidos", Valor: conferidos },
      { Campo: "Titulo bate", Valor: batem },
      { Campo: "Titulo NAO bate", Valor: divergentes.length },
      { Campo: "Desses, ja venderam", Valor: vendidosErrados.length },
      { Campo: "Anuncio sumiu do ML (404)", Valor: sumiuDoMl },
      { Campo: "Produto sem nome", Valor: semNome },
      { Campo: "Sem cache (nao varrido)", Valor: semCache },
    ]),
    "Resumo",
  );
  if (vendidosErrados.length)
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(vendidosErrados),
      "Venderam peca errada",
    );
  if (divergentes.length)
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(divergentes.slice(0, 50000)),
      "Todos os divergentes",
    );
  const xlsxOut = path.join(OUT_DIR, `anuncio-vs-produto-${stamp}.xlsx`);
  XLSX.writeFile(wb, xlsxOut);

  console.log(`\njson     ${jsonOut}`);
  console.log(`planilha ${xlsxOut}`);
}

async function main() {
  if (args.includes("--varrer")) await varrer();
  else if (args.includes("--analisar")) await analisar();
  else throw new Error("Use --varrer (na VPS) ou --analisar.");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[conferir][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
