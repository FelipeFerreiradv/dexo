/**
 * O ANUNCIO DA SHOPEE BATE COM O PRODUTO QUE ELE APONTA NA DEXO?
 * =============================================================
 *
 * Irmao de `conferir-anuncio-vs-produto-ml.ts`, para a Shopee. Mesma pergunta:
 * o titulo do anuncio na plataforma corresponde ao nome da peca que ele aponta
 * no catalogo? Quando nao corresponde, a venda baixa estoque da peca errada.
 *
 * POR QUE PRECISA EXISTIR
 * A auditoria de PEDIDOS so enxerga o que JA vendeu. No MK2 ela apontava 57
 * defeitos; a varredura dos anuncios do Mercado Livre achou **914 vinculos
 * errados**, dos quais so 35 tinham vendido — o dano latente era ~26x maior
 * que o visivel. Os 10.282 anuncios da Shopee do mesmo cliente estavam sem
 * nenhuma conferencia.
 *
 * ⚠️⚠️ A SHOPEE DEVOLVE `item_status`, NAO `status`. O tipo `ShopeeItem`
 * declara `status`, e ler esse campo da `undefined` em 100% dos itens — uma
 * guarda que le `status` NUNCA dispara e passa por aprovada. Custou caro numa
 * conferencia anterior: 1.934 de 1.934 itens liam `undefined`.
 *
 * ⚠️ SO RODA DA VPS. A Shopee valida o IP de origem contra a whitelist da
 * aplicacao; de qualquer outra maquina a chamada e recusada.
 *
 * O cache sai no MESMO formato do irmao do ML, entao
 * `dedupe-anuncios-por-foto.ts --cache=<arquivo>` consome sem adaptacao — ele
 * mapeia anuncio->produto por `ProductListing`, que e agnostico de plataforma.
 * A chave de foto aqui e `image.image_id_list`.
 *
 * FASES
 *   --varrer    le a API da Shopee e grava o cache (resumivel)
 *   --analisar  cruza o cache com o banco e emite o veredito + planilha
 *
 * CLI (na VPS):
 *   npx tsx scripts/conferir-anuncio-vs-produto-shopee.ts --user-email=<email> --varrer
 *   npx tsx scripts/conferir-anuncio-vs-produto-shopee.ts --user-email=<email> --analisar
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";
import prisma from "../app/lib/prisma";
import { areTitlesSimilar, titleSimilarity } from "../app/lib/title-similarity";
import { motivoOposicao } from "./lib/lado-e-eixo";
import { ShopeeApiService } from "../app/marketplaces/services/shopee-api.service";
import { ShopeeOAuthService } from "../app/marketplaces/services/shopee-oauth.service";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";

const args = process.argv.slice(2);
const arg = (n: string) => {
  const p = `--${n}=`;
  const f = args.find((a) => a.startsWith(p));
  return f ? f.slice(p.length) : undefined;
};

const OUT_DIR = path.resolve(__dirname, "out");
/** Cap da Shopee para `get_item_base_info`. */
const LOTE = 50;

type Anuncio = {
  id: string;
  titulo: string;
  status: string;
  sellerSku: string;
  fotos: string[];
  quantidade: number | null;
};

function caminhoCache(userId: string) {
  return path.join(OUT_DIR, `anuncios-shopee-cache-${userId}.json`);
}

function lerCache(userId: string): Record<string, Anuncio> {
  const f = caminhoCache(userId);
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, Anuncio>;
  } catch {
    console.warn("[shopee] cache ilegivel, recomecando do zero");
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

async function tokenDaConta(acc: {
  id: string;
  accountName: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  externalUserId: string | null;
}): Promise<{ token: string; shopId: number }> {
  const shopId = Number(acc.externalUserId);
  if (!Number.isFinite(shopId) || shopId <= 0)
    throw new Error(`Conta ${acc.accountName} sem shopId valido`);

  const vencido =
    !acc.accessToken ||
    (acc.expiresAt && acc.expiresAt.getTime() < Date.now() + 60_000);
  if (!vencido) return { token: acc.accessToken as string, shopId };

  if (!acc.refreshToken)
    throw new Error(`Conta ${acc.accountName} sem refreshToken`);
  console.log(`[shopee] renovando token de "${acc.accountName}"...`);
  const r = await ShopeeOAuthService.refreshAccessToken(acc.refreshToken, shopId);
  await MarketplaceRepository.updateTokens(acc.id, {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: new Date(Date.now() + r.expire_in * 1000),
  });
  return { token: r.access_token, shopId };
}

async function varrer() {
  const user = await resolverUsuario();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cache = lerCache(user.id);
  console.log(`[shopee] cliente ${user.name} (${user.id})`);
  console.log(`[shopee] ja no cache: ${Object.keys(cache).length}`);

  const contas = await prisma.marketplaceAccount.findMany({
    where: { userId: user.id, platform: "SHOPEE", status: "ACTIVE" },
    select: {
      id: true,
      accountName: true,
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
      externalUserId: true,
    },
  });
  if (contas.length === 0) throw new Error("Nenhuma conta Shopee ATIVA");

  let novos = 0;
  let falhas = 0;

  for (const acc of contas) {
    const { token, shopId } = await tokenDaConta(acc);
    const listings = await prisma.productListing.findMany({
      where: { marketplaceAccountId: acc.id },
      select: { externalListingId: true },
    });
    const pendentes = listings
      .map((l) => l.externalListingId)
      .filter((id) => id && !cache[id]);
    console.log(
      `[shopee] ${acc.accountName}: ${listings.length} anuncios, ${pendentes.length} a buscar`,
    );

    for (let i = 0; i < pendentes.length; i += LOTE) {
      const ids = pendentes.slice(i, i + LOTE);
      const numericos = ids
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (numericos.length === 0) continue;
      try {
        const itens = await ShopeeApiService.getItemsBaseInfo(
          token,
          shopId,
          numericos,
        );
        for (const it of itens) {
          const bruto = it as unknown as {
            item_id?: number;
            item_name?: string;
            item_sku?: string;
            item_status?: string;
            status?: string;
            image?: { image_id_list?: string[] };
            stock_info_v2?: {
              summary_info?: { total_available_stock?: number };
            };
          };
          if (!bruto.item_id) continue;
          cache[String(bruto.item_id)] = {
            id: String(bruto.item_id),
            titulo: String(bruto.item_name ?? "").trim(),
            // ⚠️ item_status PRIMEIRO — ver o aviso no cabecalho.
            status: String(bruto.item_status ?? bruto.status ?? "").trim(),
            sellerSku: String(bruto.item_sku ?? "").trim(),
            fotos: (bruto.image?.image_id_list ?? []).filter(Boolean),
            quantidade:
              bruto.stock_info_v2?.summary_info?.total_available_stock ?? null,
          };
          novos++;
        }
      } catch (e) {
        falhas += ids.length;
        console.error(`[shopee] lote ${i}: ${(e as Error).message.slice(0, 90)}`);
      }

      if ((i / LOTE) % 10 === 0) {
        fs.writeFileSync(caminhoCache(user.id), JSON.stringify(cache));
        process.stdout.write(
          `\r[shopee] ${acc.accountName} ${i + ids.length}/${pendentes.length} (cache ${Object.keys(cache).length})   `,
        );
      }
    }
    fs.writeFileSync(caminhoCache(user.id), JSON.stringify(cache));
    console.log("");
  }

  fs.writeFileSync(caminhoCache(user.id), JSON.stringify(cache));
  console.log(`\n[shopee] novos ${novos} · falhas ${falhas}`);
  console.log(`[shopee] cache total ${Object.keys(cache).length}`);
  console.log(`[shopee] arquivo ${caminhoCache(user.id)}`);

  // Cache no formato que o dedupe-anuncios-por-foto.ts consome (--cache=).
  const paraDedupe = Object.values(cache).map((a) => ({
    id: a.id,
    fotos: a.fotos,
    sellerSku: a.sellerSku,
    titulo: a.titulo,
    status: a.status,
  }));
  const fDedupe = path.join(OUT_DIR, `shopee-fotos-${user.id}.json`);
  fs.writeFileSync(fDedupe, JSON.stringify(paraDedupe));
  console.log(`[shopee] cache p/ dedupe ${fDedupe}`);
}

async function analisar() {
  const user = await resolverUsuario();
  const cache = lerCache(user.id);
  if (Object.keys(cache).length === 0)
    throw new Error("Cache vazio — rode --varrer na VPS primeiro.");
  console.log(`[analisar] cache com ${Object.keys(cache).length} anuncios`);

  const listings = await prisma.productListing.findMany({
    where: { marketplaceAccount: { userId: user.id, platform: "SHOPEE" } },
    select: {
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
  let opostos = 0;
  let semCache = 0;
  let semTitulo = 0;

  for (const l of listings) {
    const a = cache[l.externalListingId];
    if (!a) {
      semCache++;
      continue;
    }
    if (!a.titulo) {
      semTitulo++;
      continue;
    }
    if (!l.product?.name) continue;
    conferidos++;
    // ⚠️⚠️ Mesma guarda do ML: lado e eixo sao EXCLUDENTES e o Jaccard nao os
    // ve. "Pinca Freio Dianteira Esquerda" x "...Direita" da 0,82 e passava
    // como "titulo bate". Ver scripts/lib/lado-e-eixo.ts para a medicao.
    const oposicao = motivoOposicao(a.titulo, l.product.name);
    if (!oposicao && areTitlesSimilar(a.titulo, l.product.name)) {
      batem++;
      continue;
    }
    if (oposicao) opostos++;
    divergentes.push({
      Anuncio: l.externalListingId,
      Conta: l.marketplaceAccount.accountName,
      "Titulo na Shopee": a.titulo,
      "Produto na Dexo": l.product.name,
      "SKU do produto": l.product.sku,
      "SKU do anuncio": l.externalSku ?? a.sellerSku ?? "",
      Semelhanca: Number(titleSimilarity(a.titulo, l.product.name).toFixed(3)),
      "Lado/eixo oposto": oposicao || "",
      "Status na Shopee": a.status,
      "Qtd na Shopee": a.quantidade ?? "",
      "Estoque do produto": l.product.stock,
    });
  }

  console.log("\n--- VEREDITO ---");
  console.log(`vinculos conferidos        ${conferidos}`);
  console.log(`titulo bate                ${batem}`);
  console.log(
    `titulo NAO bate            ${divergentes.length}` +
      (conferidos
        ? `  (${((divergentes.length / conferidos) * 100).toFixed(1)}%)`
        : ""),
  );
  console.log(`  destes, LADO/EIXO oposto ${opostos}  <- peca espelhada, o Jaccard nao pegava`);
  console.log(`anuncio sem titulo na API  ${semTitulo}`);
  console.log(`sem cache (nao varridos)   ${semCache}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet([
      { Campo: "Vinculos conferidos", Valor: conferidos },
      { Campo: "Titulo bate", Valor: batem },
      { Campo: "Titulo NAO bate", Valor: divergentes.length },
      { Campo: "Sem titulo na API", Valor: semTitulo },
      { Campo: "Sem cache", Valor: semCache },
    ]),
    "Resumo",
  );
  if (divergentes.length)
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(divergentes),
      "Divergentes",
    );
  const out = path.join(OUT_DIR, `anuncio-vs-produto-shopee-${stamp}.xlsx`);
  XLSX.writeFile(wb, out);
  fs.writeFileSync(
    path.join(OUT_DIR, `anuncio-vs-produto-shopee-${stamp}.json`),
    JSON.stringify({ conferidos, batem, itens: divergentes }, null, 1),
  );
  console.log(`\nplanilha ${out}`);
}

async function main() {
  if (args.includes("--varrer")) await varrer();
  else if (args.includes("--analisar")) await analisar();
  else throw new Error("Use --varrer (na VPS) ou --analisar.");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[shopee][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
