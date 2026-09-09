import "./lib/load-env";

import fs from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { normalizeSku } from "../app/lib/sku";
import { toFullSizeMLImages } from "../app/lib/ml-image";

/**
 * RECRIA produtos apagados por engano, a partir dos anúncios que ficaram
 * `closed` no Mercado Livre.
 *
 * Contexto (Portal Eco Peças, 04/09/2026): uma exclusão em massa na Dexo
 * encerrou os anúncios no ML e apagou os produtos. `Product` não tem soft
 * delete — a linha some com StockLog e ProductListing juntos. O que sobrou foi
 * o próprio anúncio fechado no ML, que continua devolvendo título, categoria,
 * preço, fotos e atributos, e guarda o SKU em `seller_custom_field`.
 *
 * ESTE SCRIPT SÓ TRATA O CASO INEQUÍVOCO: anúncio fechado que ainda carrega o
 * SKU. Anúncio sem SKU precisaria casar por título, o que é outro problema e
 * outro script — casamento por texto já produziu peça trocada neste projeto.
 *
 * ─── por que ele não renova token ───────────────────────────────────────────
 * Ele lê `accessToken` do banco e usa CRU. Não chama nenhum caminho de refresh
 * de propósito: o `client_id` de uma máquina local não é o de produção, e o
 * refresh falha com `client_id_mismatch` marcando a MarketplaceAccount como
 * ERROR — o motor passa a PULAR a conta e o lojista para de receber pedidos,
 * em silêncio, com o accessToken ainda válido. Se o token estiver expirado o
 * script aborta com 401 e manda rodar da VPS. Nunca "conserta" sozinho.
 *
 * ─── travas ─────────────────────────────────────────────────────────────────
 *  - dry-run é o padrão; só grava com `--apply`
 *  - PULA SKU já ocupado no tenant (a unique [userId, sku] é a última linha
 *    de defesa, mas o objetivo é nunca chegar nela)
 *  - PULA anúncio que já esteja vinculado a algum produto
 *  - PULA grupo cujo `PART_NUMBER` divirja entre as contas — dois anúncios com
 *    o mesmo SKU e números de peça diferentes NÃO são a mesma peça
 *  - grupo com TÍTULO divergente entre contas exige `--aceitar-titulo-divergente`
 *    (visto em campo: "Comando Ar Condicionado" x "Comando SEM Ar Condicionado",
 *    mesmo SKU e mesmo part number — a escolha do título é comercial, é humana)
 *  - uma transação por SKU: um grupo que falha não derruba os outros
 *  - grava backup JSON em scripts/out/ ANTES e DEPOIS
 *
 * ⚠️ NÃO chamar via `npm run -- --apply`: o npm engole o `--apply` e o script
 * roda em dry-run achando que aplicou. Chamar o tsx direto:
 *
 *   .\node_modules\.bin\tsx.cmd scripts/recriar-produtos-de-anuncios-fechados.ts \
 *     --user-email=portalecopecasitajai@gmail.com \
 *     --from=2026-09-04T16:37:30Z --to=2026-09-04T16:38:25Z
 */

const ML_API = "https://api.mercadolibre.com";
const OUT_DIR = path.resolve(__dirname, "out");

type Flags = {
  userId: string | null;
  userEmail: string | null;
  from: string | null;
  to: string | null;
  apply: boolean;
  dryRun: boolean;
  aceitarTituloDivergente: boolean;
  limit: number | null;
  modo: "com-sku" | "sem-sku";
};

function parseFlags(): Flags {
  const argv = process.argv.slice(2);
  const conhecidas = new Set([
    "user-id", "user-email", "from", "to", "apply", "dry-run",
    "aceitar-titulo-divergente", "limit", "modo",
  ]);
  for (const a of argv) {
    const nome = a.replace(/^--/, "").split("=")[0];
    if (!a.startsWith("--") || !conhecidas.has(nome)) {
      throw new Error(`Flag desconhecida: ${a}. Abortando por segurança.`);
    }
  }
  const get = (n: string) => {
    const f = `--${n}=`;
    const x = argv.find((a) => a.startsWith(f));
    return x ? x.slice(f.length).trim() : undefined;
  };
  const has = (n: string) => argv.includes(`--${n}`);
  const apply = has("apply");
  const limitRaw = get("limit");
  return {
    userId: get("user-id") ?? null,
    userEmail: get("user-email") ?? null,
    from: get("from") ?? null,
    to: get("to") ?? null,
    apply,
    // `--dry-run` explícito vence `--apply`; ausência de `--apply` também.
    dryRun: has("dry-run") || !apply,
    aceitarTituloDivergente: has("aceitar-titulo-divergente"),
    limit: limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null,
    modo: get("modo") === "sem-sku" ? "sem-sku" : "com-sku",
  };
}

// ─── ML (somente leitura, token cru) ─────────────────────────────────────────

async function mlGet(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `ML respondeu ${res.status}. O token desta conta não serve mais. ` +
        `NÃO renove daqui: rode este script da VPS ou reconecte a conta pela aplicação.`,
    );
  }
  if (!res.ok) throw new Error(`ML ${res.status} em ${url}`);
  return res.json();
}

/**
 * Só os anúncios FECHADOS do vendedor.
 *
 * `search_type=scan` aceita `status` — medido em campo: 551 fechados contra
 * 4.620 no total da conta. Sem esse filtro seriam ~230 chamadas de multiget por
 * conta para descartar 88% no cliente. (O helper do projeto,
 * `MLApiService.getSellerItemIds`, ignora o parâmetro de status de propósito;
 * aqui o filtro é o ponto.)
 */
async function listarFechadosDoVendedor(sellerId: string, token: string): Promise<string[]> {
  const ids: string[] = [];
  let scroll: string | null = null;
  for (let i = 0; i < 400; i++) {
    const url =
      `${ML_API}/users/${sellerId}/items/search?search_type=scan&status=closed&limit=100` +
      (scroll ? `&scroll_id=${encodeURIComponent(scroll)}` : "");
    const d = await mlGet(url, token);
    const lote: string[] = d.results ?? [];
    ids.push(...lote);
    scroll = d.scroll_id ?? null;
    if (!lote.length || !scroll) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  return ids;
}

/** Multiget: o ML aceita no máximo 20 ids por chamada. */
async function detalhes(ids: string[], token: string): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const d = await mlGet(`${ML_API}/items?ids=${chunk.join(",")}`, token);
    for (const e of d) {
      // code !== 200 = item inacessível nesta conta; some em silêncio no ML,
      // então contamos a diferença em vez de deixar passar batido.
      if (e?.code === 200 && e.body) out.push(e.body);
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return out;
}

/**
 * A descrição NÃO vem no item: é `GET /items/{id}/description`, uma chamada por
 * anúncio. Por isso só é buscada para os grupos que realmente serão criados.
 *
 * Ausência de descrição é 404 legítimo no ML (anúncio sem descrição), não erro
 * — por isso esta função tolera falha e devolve null em vez de abortar o lote.
 */
async function buscarDescricao(mlb: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${ML_API}/items/${mlb}/description`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const d: any = await res.json();
    const txt = String(d?.plain_text ?? d?.text ?? "").trim();
    return txt.length ? txt : null;
  } catch {
    return null;
  }
}

// ─── mapeamento de atributos do ML ───────────────────────────────────────────

type Anuncio = {
  contaId: string;
  contaNome: string;
  mlb: string;
  sku: string;
  titulo: string;
  status: string;
  categoriaML: string | null;
  preco: number;
  qtd: number;
  vendidos: number;
  permalink: string | null;
  fotos: string[];
  marca: string | null;
  modelo: string | null;
  ano: string | null;
  partNumber: string | null;
  alturaCm: number | null;
  larguraCm: number | null;
  comprimentoCm: number | null;
  pesoKg: number | null;
  criadoEm: string | null;
  fechadoEm: string | null;
  /** Preenchida depois, só para os grupos que serão criados (endpoint separado). */
  descricao: string | null;
};

/** "30 cm" -> 30 · "300 mm" -> 30 · "0.3 m" -> 30 */
function cm(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = String(v).match(/([\d.,]+)\s*(mm|cm|m)?/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const u = (m[2] ?? "cm").toLowerCase();
  const val = u === "mm" ? n / 10 : u === "m" ? n * 100 : n;
  return val > 0 ? Math.round(val) : null;
}

/** "1400 g" -> 1.4 · "1.4 kg" -> 1.4 */
function kg(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = String(v).match(/([\d.,]+)\s*(mg|g|kg)?/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const u = (m[2] ?? "kg").toLowerCase();
  const val = u === "g" ? n / 1000 : u === "mg" ? n / 1_000_000 : n;
  return val > 0 ? Math.round(val * 100) / 100 : null;
}

function mapear(item: any, conta: { id: string; nome: string }): Anuncio {
  // sku vazio é legítimo aqui: anúncios antigos foram publicados antes de o SKU
  // passar a ser enviado ao ML. Quem separa os dois conjuntos é o `--modo`.
  const sku = String(item?.seller_custom_field ?? "").trim();
  const at: Record<string, string> = {};
  for (const a of item.attributes ?? []) {
    if (a?.id) at[a.id] = a.value_name ?? "";
  }
  return {
    contaId: conta.id,
    contaNome: conta.nome,
    mlb: item.id,
    sku,
    titulo: String(item.title ?? "").trim(),
    status: String(item.status ?? ""),
    categoriaML: item.category_id ?? null,
    preco: Number(item.price ?? 0),
    qtd: Number.isFinite(item.available_quantity) ? Number(item.available_quantity) : 0,
    vendidos: Number(item.sold_quantity ?? 0),
    permalink: item.permalink ?? null,
    fotos: toFullSizeMLImages((item.pictures ?? []).map((p: any) => p.secure_url ?? p.url)),
    marca: at.BRAND || null,
    modelo: at.MODEL || null,
    ano: at.YEAR || null,
    partNumber: at.PART_NUMBER || null,
    alturaCm: cm(at.SELLER_PACKAGE_HEIGHT),
    larguraCm: cm(at.SELLER_PACKAGE_WIDTH),
    comprimentoCm: cm(at.SELLER_PACKAGE_LENGTH),
    pesoKg: kg(at.SELLER_PACKAGE_WEIGHT),
    criadoEm: item.date_created ?? null,
    fechadoEm: item.last_updated ?? null,
    descricao: null,
  };
}

// ─── plano ───────────────────────────────────────────────────────────────────

type Grupo = {
  sku: string;
  anuncios: Anuncio[];
  acao: "criar" | "pular";
  motivo?: string;
  avisos: string[];
  tituloEscolhido?: string;
};

/** Título sem acento, sem pontuação, minúsculo — só para AGRUPAR, nunca para gravar. */
function chaveTitulo(t: string): string {
  return t
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function montarGrupos(
  anuncios: Anuncio[],
  skusOcupados: Set<string>,
  listingsExistentes: Set<string>,
  modo: "com-sku" | "sem-sku",
): Grupo[] {
  const porSku = new Map<string, Anuncio[]>();
  for (const a of anuncios) {
    // No modo sem-sku o SKU original é IRRECUPERÁVEL — não existe no anúncio
    // nem nos logs. O agrupamento passa a ser título + número de peça, que é
    // o par que provou separar peça de peça neste tenant (título sozinho não:
    // duas contas chegam a divergir no texto do mesmo anúncio).
    const chave =
      modo === "com-sku" ? a.sku : `${chaveTitulo(a.titulo)}|${(a.partNumber ?? "").toLowerCase()}`;
    const arr = porSku.get(chave) ?? [];
    arr.push(a);
    porSku.set(chave, arr);
  }

  // ⚠️ UMA PEÇA POR CONTA. Título e número de peça iguais só provam que é a
  // mesma peça quando os anúncios estão em contas DIFERENTES (publicação
  // cruzada). Dois anúncios na MESMA conta com o mesmo título são duas peças
  // físicas distintas — o lojista anunciou cada uma separadamente. Fundir as
  // duas num produto só faria SUMIR uma peça do pátio.
  // Caso real: duas 'Manopla De Marcha Lifan X60', mesma conta, criadas com 3
  // minutos de diferença, mesmo part number.
  for (const [chave, lista] of [...porSku.entries()]) {
    const contas = lista.map((a) => a.contaId);
    if (contas.length === new Set(contas).size) continue;
    porSku.delete(chave);
    for (const a of lista) porSku.set(`${chave}|so:${a.mlb}`, [a]);
  }

  const grupos: Grupo[] = [];
  for (const [chave, lista] of [...porSku.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    // `REC-<MLB>` é deliberadamente NÃO numérico: a etiqueta de desmanche é um
    // número, então um SKU assim grita "isto não é etiqueta, preciso ser
    // corrigido" em vez de se passar por uma. E rastreia até o anúncio de
    // origem. Um sequencial novo pareceria legítimo e ninguém notaria que não
    // bate com a peça na prateleira.
    const sku =
      modo === "com-sku"
        ? chave
        : `REC-${[...lista].map((a) => a.mlb).sort()[0]}`;
    const g: Grupo = { sku, anuncios: lista, acao: "criar", avisos: [] };
    if (modo === "sem-sku") {
      g.avisos.push("sku-original-irrecuperavel: etiqueta física precisa ser reconferida");
    }
    const norm = normalizeSku(sku);

    if (!norm) {
      g.acao = "pular";
      g.motivo = "sku-vazio";
    } else if (skusOcupados.has(norm)) {
      g.acao = "pular";
      g.motivo = "sku-ja-ocupado-no-tenant";
    } else if (lista.some((a) => listingsExistentes.has(`${a.contaId}::${a.mlb}`))) {
      g.acao = "pular";
      g.motivo = "anuncio-ja-vinculado-a-produto";
    } else if (lista.some((a) => !a.titulo)) {
      g.acao = "pular";
      g.motivo = "anuncio-sem-titulo";
    } else if (lista.every((a) => !(a.preco > 0))) {
      g.acao = "pular";
      g.motivo = "sem-preco";
    } else {
      // Dois anúncios com o mesmo SKU e PART_NUMBER diferente não são a mesma
      // peça. Aqui o SKU mente, e criar um produto só fundiria duas peças.
      const pns = new Set(lista.map((a) => a.partNumber ?? "").filter(Boolean));
      if (pns.size > 1) {
        g.acao = "pular";
        g.motivo = `part-number-divergente (${[...pns].join(" | ")})`;
      }
    }

    if (g.acao === "criar") {
      const titulos = [...new Set(lista.map((a) => a.titulo))];
      if (titulos.length > 1) {
        g.avisos.push(`titulo-divergente: ${titulos.map((t) => `"${t}"`).join(" x ")}`);
      }
      const precos = [...new Set(lista.map((a) => a.preco))];
      if (precos.length > 1) g.avisos.push(`preco-divergente: ${precos.join(" x ")}`);
      if (lista.some((a) => a.vendidos > 0)) {
        g.avisos.push(`tem-venda-no-ml: ${lista.map((a) => a.vendidos).join("/")}`);
      }
      // Título mais longo = o mais descritivo; a divergência fica registrada
      // no aviso para conferência humana.
      g.tituloEscolhido = [...lista].sort((a, b) => b.titulo.length - a.titulo.length)[0].titulo;
    }
    grupos.push(g);
  }
  return grupos;
}

function dadosDoProduto(g: Grupo, userId: string, mlCategoriaLocal: string | null) {
  const base = [...g.anuncios].sort((a, b) => b.fotos.length - a.fotos.length)[0];
  const fotos = base.fotos;
  // Mesma peça física anunciada em 2 contas: o estoque é UM, não a soma.
  const stock = Math.max(...g.anuncios.map((a) => a.qtd));
  const preco = Math.max(...g.anuncios.map((a) => a.preco));
  return {
    userId,
    sku: g.sku,
    skuNormalized: normalizeSku(g.sku),
    name: (g.tituloEscolhido ?? base.titulo).slice(0, 250),
    // A mais completa do grupo: as duas contas costumam repetir o mesmo texto,
    // mas uma pode ter sido editada e ficado mais curta.
    description:
      [...g.anuncios]
        .map((a) => a.descricao)
        .filter((d): d is string => !!d && d.trim().length > 0)
        .sort((a, b) => b.length - a.length)[0] ?? null,
    price: new Prisma.Decimal(preco),
    stock,
    brand: base.marca,
    model: base.modelo,
    year: base.ano,
    partNumber: base.partNumber,
    partNumberNormalized: base.partNumber ? base.partNumber.trim().toLowerCase() : null,
    imageUrl: fotos[0] ?? null,
    imageUrls: fotos,
    heightCm: base.alturaCm,
    widthCm: base.larguraCm,
    lengthCm: base.comprimentoCm,
    weightKg: base.pesoKg != null ? new Prisma.Decimal(base.pesoKg) : null,
    mlCategoryId: mlCategoriaLocal ?? undefined,
    ...(mlCategoriaLocal
      ? { mlCategorySource: "recuperacao-anuncio-fechado", mlCategoryChosenAt: new Date() }
      : {}),
    createdFromMarketplace: true,
    originPlatform: "MERCADO_LIVRE" as const,
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const f = parseFlags();
  if (!f.userId && !f.userEmail) {
    throw new Error("Informe --user-id=<id> ou --user-email=<email>. Abortando.");
  }
  if (!f.from || !f.to) {
    throw new Error(
      "Informe a janela: --from=<ISO> --to=<ISO> (o instante em que os anúncios foram fechados). Abortando.",
    );
  }
  const de = new Date(f.from);
  const ate = new Date(f.to);
  if (Number.isNaN(+de) || Number.isNaN(+ate) || de >= ate) {
    throw new Error("Janela inválida: --from precisa ser anterior a --to, ambos em ISO.");
  }

  const user = f.userId
    ? await prisma.user.findUnique({ where: { id: f.userId }, select: { id: true, email: true } })
    : await prisma.user.findFirst({
        where: { email: f.userEmail! },
        select: { id: true, email: true },
      });
  if (!user) throw new Error("Usuário não encontrado.");

  const contas = await prisma.marketplaceAccount.findMany({
    where: { userId: user.id, platform: "MERCADO_LIVRE", status: "ACTIVE" },
    select: { id: true, accountName: true, externalUserId: true, accessToken: true },
  });
  if (!contas.length) throw new Error("Nenhuma conta ACTIVE do Mercado Livre para este usuário.");

  console.log(`\n  usuário .......... ${user.email}`);
  console.log(`  contas ML ........ ${contas.map((c) => c.accountName).join(", ")}`);
  console.log(`  janela ........... ${de.toISOString()} -> ${ate.toISOString()}`);
  console.log(`  modo ............. ${f.dryRun ? "DRY-RUN (nada será gravado)" : "APPLY"}\n`);

  // 1) varre os anúncios fechados de cada conta, dentro da janela, com SKU
  const anuncios: Anuncio[] = [];
  let semSku = 0;
  for (const c of contas) {
    if (!c.externalUserId) {
      console.log(`  ! ${c.accountName}: sem externalUserId, pulando`);
      continue;
    }
    const ids = await listarFechadosDoVendedor(c.externalUserId, c.accessToken);
    const itens = await detalhes(ids, c.accessToken);
    let naJanela = 0;
    for (const it of itens) {
      if (String(it.status) !== "closed") continue;
      const lu = it.last_updated ? new Date(it.last_updated) : null;
      if (!lu || lu < de || lu > ate) continue;
      naJanela++;
      const a = mapear(it, { id: c.id, nome: c.accountName });
      anuncios.push(a);
      if (!a.sku) semSku++;
    }
    console.log(
      `  ${c.accountName}: ${ids.length} fechados na conta · ${itens.length} lidos · ${naJanela} na janela`,
    );
  }
  const comSku = anuncios.filter((a) => a.sku);
  const semSkuList = anuncios.filter((a) => !a.sku);
  console.log(`\n  com SKU: ${comSku.length} | sem SKU: ${semSku}`);

  const alvo = f.modo === "com-sku" ? comSku : semSkuList;
  console.log(`  modo ${f.modo}: processando ${alvo.length} anuncio(s)`);

  if (!alvo.length) {
    console.log("\n  Nada a fazer.");
    return;
  }

  // 2) estado atual do banco — o que já existe não pode ser recriado
  // Candidatos: no modo com-sku e o proprio SKU do anuncio; no sem-sku e o
  // sintetico de CADA anuncio (superconjunto do que o agrupamento escolhe).
  const skusCandidatos = [
    ...new Set(alvo.map((a) => (f.modo === "com-sku" ? a.sku : `REC-${a.mlb}`))),
  ];
  const skusOcupados = new Set(
    (
      await prisma.product.findMany({
        where: { userId: user.id, sku: { in: skusCandidatos } },
        select: { skuNormalized: true, sku: true },
      })
    ).map((p) => p.skuNormalized ?? normalizeSku(p.sku) ?? ""),
  );
  const listingsExistentes = new Set(
    (
      await prisma.productListing.findMany({
        where: { externalListingId: { in: [...new Set(alvo.map((a) => a.mlb))] } },
        select: { marketplaceAccountId: true, externalListingId: true },
      })
    ).map((l) => `${l.marketplaceAccountId}::${l.externalListingId}`),
  );

  // 3) categorias ML já sincronizadas localmente (miss = grava null, não aborta)
  const catExternos = [...new Set(alvo.map((a) => a.categoriaML).filter(Boolean))] as string[];
  const catLocal = new Map(
    (
      await prisma.marketplaceCategory.findMany({
        where: { externalId: { in: catExternos } },
        select: { id: true, externalId: true },
      })
    ).map((c) => [c.externalId, c.id]),
  );

  let grupos = montarGrupos(alvo, skusOcupados, listingsExistentes, f.modo);
  if (f.limit) grupos = grupos.slice(0, f.limit);

  // 3b) descrições — uma chamada por anúncio, só para o que será criado.
  const tokenPorConta = new Map(contas.map((c) => [c.id, c.accessToken]));
  const aBuscar = grupos.filter((g) => g.acao === "criar").flatMap((g) => g.anuncios);
  let comDescricao = 0;
  for (const a of aBuscar) {
    const tk = tokenPorConta.get(a.contaId);
    if (!tk) continue;
    a.descricao = await buscarDescricao(a.mlb, tk);
    if (a.descricao) comDescricao++;
    await new Promise((r) => setTimeout(r, 40));
  }
  if (aBuscar.length) {
    console.log(`
  descrições: ${comDescricao}/${aBuscar.length} anúncios têm texto`);
  }

  // 4) plano
  const criar = grupos.filter((g) => g.acao === "criar");
  const pular = grupos.filter((g) => g.acao === "pular");
  const comAviso = criar.filter((g) => g.avisos.length);
  const tituloDivergente = criar.filter((g) =>
    g.avisos.some((v) => v.startsWith("titulo-divergente")),
  );

  console.log(`\n  PLANO — ${grupos.length} SKUs\n`);
  for (const g of criar) {
    const cat = g.anuncios[0].categoriaML;
    console.log(
      `   + ${g.sku.padEnd(11)} ${String(g.anuncios.length).padStart(2)} anúncio(s)  ` +
        `est=${Math.max(...g.anuncios.map((a) => a.qtd))}  ` +
        `R$${Math.max(...g.anuncios.map((a) => a.preco)).toFixed(2).padStart(8)}  ` +
        `cat=${(cat && catLocal.get(cat) ? "ok" : "—").padEnd(3)} ` +
        `"${(g.tituloEscolhido ?? "").slice(0, 44)}"`,
    );
    for (const v of g.avisos) console.log(`        ⚠ ${v}`);
  }
  for (const g of pular) {
    console.log(`   - ${g.sku.padEnd(11)} PULADO: ${g.motivo}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const arqPlano = path.join(
    OUT_DIR,
    `recriar-fechados-${f.dryRun ? "dryrun" : "apply"}-${stamp}.json`,
  );
  // O plano carrega a LINHA EXATA que será gravada, não só a intenção — um
  // dry-run que não mostra o payload deixa o revisor conferindo a decisão em
  // vez do dado.
  const planoDetalhado = grupos.map((g) => ({
    ...g,
    produto:
      g.acao === "criar"
        ? dadosDoProduto(
            g,
            user.id,
            g.anuncios[0].categoriaML ? catLocal.get(g.anuncios[0].categoriaML) ?? null : null,
          )
        : null,
  }));
  fs.writeFileSync(
    arqPlano,
    JSON.stringify(
      {
        user: user.email,
        janela: { de, ate },
        contas: contas.map((c) => c.accountName),
        grupos: planoDetalhado,
      },
      null,
      1,
    ),
    "utf8",
  );

  console.log(`\n  a criar ......... ${criar.length} produtos`);
  console.log(`  anúncios a ligar  ${criar.reduce((n, g) => n + g.anuncios.length, 0)}`);
  console.log(`  pulados ......... ${pular.length}`);
  console.log(`  com aviso ....... ${comAviso.length}`);
  console.log(`  plano completo .. scripts/out/${path.basename(arqPlano)}`);

  if (tituloDivergente.length && !f.aceitarTituloDivergente) {
    console.log(
      `\n  ⛔ ${tituloDivergente.length} SKU(s) com TÍTULO divergente entre as contas ` +
        `(${tituloDivergente.map((g) => g.sku).join(", ")}).\n` +
        `     O título é escolha comercial — confira no plano e, se estiver certo, ` +
        `repita com --aceitar-titulo-divergente.`,
    );
    return;
  }

  if (f.dryRun) {
    console.log("\n  DRY-RUN: nada gravado. Repita com --apply para aplicar.\n");
    return;
  }

  // 5) apply — uma transação por SKU
  let criados = 0;
  let listingsCriados = 0;
  const erros: Array<{ sku: string; erro: string }> = [];
  const feitos: Array<{ sku: string; productId: string; listings: string[] }> = [];

  for (const g of criar) {
    try {
      const catLoc = g.anuncios[0].categoriaML ? catLocal.get(g.anuncios[0].categoriaML) ?? null : null;
      const res = await prisma.$transaction(async (tx) => {
        const p = await tx.product.create({
          data: dadosDoProduto(g, user.id, catLoc) as any,
          select: { id: true },
        });
        const ls: string[] = [];
        for (const a of g.anuncios) {
          const l = await tx.productListing.create({
            data: {
              productId: p.id,
              marketplaceAccountId: a.contaId,
              externalListingId: a.mlb,
              externalSku: a.sku,
              // status CRU do ML: o anúncio continua fechado lá, e o painel
              // precisa dizer a verdade. Religar é decisão separada.
              status: a.status,
              permalink: a.permalink,
            },
            select: { id: true },
          });
          ls.push(l.id);
        }
        return { productId: p.id, listings: ls };
      });
      criados++;
      listingsCriados += res.listings.length;
      feitos.push({ sku: g.sku, productId: res.productId, listings: res.listings });
      console.log(`   ✓ ${g.sku.padEnd(11)} produto ${res.productId} · ${res.listings.length} anúncio(s)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      erros.push({ sku: g.sku, erro: msg });
      console.log(`   ✗ ${g.sku.padEnd(11)} ${msg.slice(0, 120)}`);
    }
  }

  const arqRes = path.join(OUT_DIR, `recriar-fechados-resultado-${stamp}.json`);
  fs.writeFileSync(
    arqRes,
    JSON.stringify({ user: user.email, criados, listingsCriados, feitos, erros }, null, 1),
    "utf8",
  );

  console.log(`\n  criados ......... ${criados} produtos`);
  console.log(`  anúncios ligados  ${listingsCriados}`);
  console.log(`  erros ........... ${erros.length}`);
  console.log(`  resultado ....... scripts/out/${path.basename(arqRes)}\n`);
}

main()
  .catch((e) => {
    console.error("\nFALHOU:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
