/**
 * Planilha "Exportar todos os produtos" (Produtos → Importar / Exportar).
 *
 * Antes a exportação trazia só as 17 colunas do modelo de IMPORTAÇÃO — sem
 * localização, compatibilidades, ficha técnica nem anúncios. Clientes
 * baixavam a base e não achavam onde cada peça estava guardada.
 *
 * Contrato:
 * - As 17 colunas de `IMPORT_COLUMNS` vêm PRIMEIRO, com os mesmos nomes e
 *   valores de antes: a planilha exportada continua servindo para importar
 *   (o importador lê pelo nome da coluna e ignora as demais).
 * - As colunas novas vêm depois (`EXTRA_COLUMNS`).
 * - Nenhuma célula passa de 32.767 caracteres (limite do Excel: acima disso
 *   o arquivo abre "com problemas" e o Excel descarta o conteúdo).
 *
 * Funções puras: o componente só busca as páginas e grava o arquivo.
 */
import {
  LISTING_PLATFORM_LABELS,
  getListingStatusBadge,
} from "./listing-status-labels";

export const IMPORT_COLUMNS = [
  "SKU",
  "Nome",
  "Descrição",
  "Preço",
  "Custo",
  "Estoque",
  "Marca",
  "Modelo",
  "Ano",
  "Categoria",
  "Part Number",
  "Qualidade",
  "Altura (cm)",
  "Largura (cm)",
  "Comprimento (cm)",
  "Peso (kg)",
  "URL Imagem",
] as const;

export const EXTRA_COLUMNS = [
  "Localização",
  "Descrição da localização",
  "Localização (texto digitado)",
  "Estoque reservado",
  "Estoque disponível",
  "Markup (%)",
  "Versão",
  "Veículo de origem",
  "Sucata de origem",
  "Peça de segurança",
  "Rastreável",
  "Compatibilidades",
  "Qtd. de veículos compatíveis",
  "Posição da peça",
  "Ficha técnica",
  "Dados importados de outro sistema",
  "Todas as imagens",
  "Qtd. de imagens",
  "Categoria Mercado Livre",
  "Código da categoria Mercado Livre",
  "Código da categoria Shopee",
  "Código da categoria Magalu",
  "Código da categoria OLX",
  "Código da categoria Facebook",
  "Anúncios Mercado Livre",
  "Anúncios Shopee",
  "Anúncios Magalu",
  "Anúncios OLX",
  "Anúncios Facebook",
  "Links dos anúncios",
  "Plataforma de origem",
  "Cadastrado por",
  "Criado em",
  "Atualizado em",
  "ID do produto",
] as const;

export const EXPORT_COLUMNS = [...IMPORT_COLUMNS, ...EXTRA_COLUMNS] as const;

export type ExportColumn = (typeof EXPORT_COLUMNS)[number];
export type ExportCell = string | number;
export type ExportRow = Record<ExportColumn, ExportCell>;

/** Limite de caracteres de uma célula no Excel. */
export const EXCEL_CELL_MAX = 32_767;

// ── Contrato da rota GET /products/export ───────────────────────────────────

export interface ExportCompatibility {
  brand: string;
  model: string;
  version: string | null;
  yearFrom: number | null;
  yearTo: number | null;
}

export interface ExportListing {
  platform: string;
  accountName: string | null;
  /** null quando a linha ainda não tem anúncio real (id provisório). */
  externalListingId: string | null;
  status: string | null;
  permalink: string | null;
}

export interface ExportFichaEntry {
  id: string;
  /** Nome do campo no Mercado Livre; null quando desconhecido. */
  name: string | null;
  value: string;
}

export interface ExportExtraEntry {
  key: string;
  value: string;
}

export interface ExportProduct {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  price: number | null;
  costPrice: number | null;
  markup: number | null;
  stock: number;
  reservedStock: number;
  brand: string | null;
  model: string | null;
  year: string | null;
  version: string | null;
  category: string | null;
  partNumber: string | null;
  quality: string | null;
  heightCm: number | null;
  widthCm: number | null;
  lengthCm: number | null;
  weightKg: number | null;
  imageUrl: string | null;
  imageUrls: string[];
  isSecurityItem: boolean;
  isTraceable: boolean;
  sourceVehicle: string | null;
  location: {
    /** O que a tela mostra: caminho completo, código ou texto livre. */
    path: string | null;
    description: string | null;
    /** Texto livre gravado no produto, só quando difere do mostrado. */
    typedText: string | null;
  };
  mlCategory: { code: string | null; path: string | null };
  shopeeCategoryId: string | null;
  magaluCategoryId: string | null;
  olxCategoryId: string | null;
  fbCategoryId: string | null;
  compatibilities: ExportCompatibility[];
  compatibilityPositions: string[];
  ficha: ExportFichaEntry[];
  extraData: ExportExtraEntry[];
  listings: ExportListing[];
  scrap: string | null;
  createdByName: string | null;
  originPlatform: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ExportPage {
  products: ExportProduct[];
  /** Próximo cursor; null na última página. */
  nextCursor: string | null;
  /** Total de produtos do cliente (só na primeira página). */
  total?: number;
}

// ── Formatação ──────────────────────────────────────────────────────────────

const TRUNCATED_SUFFIX = " … (texto cortado: limite do Excel)";

/** Corta texto acima do limite do Excel, avisando na própria célula. */
export function clampCell(value: string): string {
  if (value.length <= EXCEL_CELL_MAX) return value;
  return value.slice(0, EXCEL_CELL_MAX - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX;
}

/**
 * Junta itens com `separator` sem passar do limite do Excel. O que não couber
 * vira "… e mais N <rótulo>" — nunca um item cortado ao meio.
 */
export function joinWithinLimit(
  items: string[],
  separator: string,
  moreLabel: (rest: number) => string,
  limit: number = EXCEL_CELL_MAX,
): string {
  const full = items.join(separator);
  if (full.length <= limit) return full;
  let out = "";
  for (let i = 0; i < items.length; i++) {
    const rest = items.length - i;
    const next = out ? `${out}${separator}${items[i]}` : items[i];
    // Reserva espaço para o aviso do que sobrar depois deste item.
    const tail = rest - 1 > 0 ? `${separator}${moreLabel(rest - 1)}` : "";
    if (next.length + tail.length > limit) {
      const notice = moreLabel(rest);
      return out ? `${out}${separator}${notice}` : notice;
    }
    out = next;
  }
  return out;
}

function text(value: string | null | undefined): string {
  return value == null ? "" : clampCell(String(value));
}

function num(value: number | null | undefined): ExportCell {
  return value == null || !Number.isFinite(value) ? "" : value;
}

function yesNo(value: boolean): string {
  return value ? "Sim" : "Não";
}

export function formatCompatibility(c: ExportCompatibility): string {
  const vehicle = [c.brand, c.model, c.version]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const from = c.yearFrom ?? null;
  const to = c.yearTo ?? null;
  let years = "";
  if (from != null && to != null) {
    years = from === to ? ` (${from})` : ` (${from} a ${to})`;
  } else if (from != null) {
    years = ` (a partir de ${from})`;
  } else if (to != null) {
    years = ` (até ${to})`;
  }
  return `${vehicle}${years}`;
}

function platformLabel(platform: string | null | undefined): string {
  if (!platform) return "";
  return (
    (LISTING_PLATFORM_LABELS as Record<string, string>)[platform] ?? platform
  );
}

export function formatListing(l: ExportListing): string {
  const account = (l.accountName ?? "").trim() || "Conta";
  const id = l.externalListingId ?? "sem anúncio publicado";
  const status = getListingStatusBadge(l.status).label;
  return `${account}: ${id} (${status})`;
}

const DATE_PARTS = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "25/09/2026 14:33", no horário de Brasília. */
export function formatExportDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts: Record<string, string> = {};
  for (const p of DATE_PARTS.formatToParts(date)) parts[p.type] = p.value;
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

function uniqueImages(p: ExportProduct): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of [p.imageUrl, ...(p.imageUrls ?? [])]) {
    const u = (url ?? "").trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

function listingsOf(p: ExportProduct, platform: string): string {
  const items = p.listings
    .filter((l) => l.platform === platform)
    .map(formatListing);
  return joinWithinLimit(items, "; ", (n) => `… e mais ${n} anúncio(s)`);
}

/** Uma linha da planilha. As 17 primeiras colunas são as de sempre. */
export function exportRowFromProduct(p: ExportProduct): ExportRow {
  const images = uniqueImages(p);
  const compat = (p.compatibilities ?? []).map(formatCompatibility);
  const links = p.listings
    .map((l) => (l.permalink ?? "").trim())
    .filter(Boolean);

  return {
    // ── modelo de importação (inalterado) ──
    SKU: text(p.sku),
    Nome: text(p.name),
    Descrição: text(p.description),
    Preço: num(p.price ?? 0),
    Custo: num(p.costPrice),
    Estoque: num(p.stock ?? 0),
    Marca: text(p.brand),
    Modelo: text(p.model),
    Ano: text(p.year),
    Categoria: text(p.category),
    "Part Number": text(p.partNumber),
    Qualidade: text(p.quality),
    "Altura (cm)": num(p.heightCm),
    "Largura (cm)": num(p.widthCm),
    "Comprimento (cm)": num(p.lengthCm),
    "Peso (kg)": num(p.weightKg),
    "URL Imagem": text(p.imageUrl),
    // ── informações completas ──
    Localização: text(p.location?.path),
    "Descrição da localização": text(p.location?.description),
    "Localização (texto digitado)": text(p.location?.typedText),
    "Estoque reservado": num(p.reservedStock ?? 0),
    "Estoque disponível": Math.max(
      0,
      (p.stock ?? 0) - (p.reservedStock ?? 0),
    ),
    "Markup (%)": num(p.markup),
    Versão: text(p.version),
    "Veículo de origem": text(p.sourceVehicle),
    "Sucata de origem": text(p.scrap),
    "Peça de segurança": yesNo(Boolean(p.isSecurityItem)),
    Rastreável: yesNo(Boolean(p.isTraceable)),
    Compatibilidades: joinWithinLimit(
      compat,
      "; ",
      (n) => `… e mais ${n} veículo(s) — lista completa no sistema`,
    ),
    "Qtd. de veículos compatíveis": compat.length,
    "Posição da peça": text((p.compatibilityPositions ?? []).join(", ")),
    "Ficha técnica": joinWithinLimit(
      (p.ficha ?? []).map((f) => `${f.name || f.id}: ${f.value}`),
      "; ",
      (n) => `… e mais ${n} campo(s)`,
    ),
    "Dados importados de outro sistema": joinWithinLimit(
      (p.extraData ?? []).map((e) => `${e.key}: ${e.value}`),
      "; ",
      (n) => `… e mais ${n} campo(s)`,
    ),
    "Todas as imagens": joinWithinLimit(
      images,
      " | ",
      (n) => `… e mais ${n} imagem(ns)`,
    ),
    "Qtd. de imagens": images.length,
    "Categoria Mercado Livre": text(p.mlCategory?.path),
    "Código da categoria Mercado Livre": text(p.mlCategory?.code),
    "Código da categoria Shopee": text(p.shopeeCategoryId),
    "Código da categoria Magalu": text(p.magaluCategoryId),
    "Código da categoria OLX": text(p.olxCategoryId),
    "Código da categoria Facebook": text(p.fbCategoryId),
    "Anúncios Mercado Livre": listingsOf(p, "MERCADO_LIVRE"),
    "Anúncios Shopee": listingsOf(p, "SHOPEE"),
    "Anúncios Magalu": listingsOf(p, "MAGALU"),
    "Anúncios OLX": listingsOf(p, "OLX"),
    "Anúncios Facebook": listingsOf(p, "FACEBOOK"),
    "Links dos anúncios": joinWithinLimit(
      links,
      " | ",
      (n) => `… e mais ${n} link(s)`,
    ),
    "Plataforma de origem": platformLabel(p.originPlatform),
    "Cadastrado por": text(p.createdByName),
    "Criado em": formatExportDate(p.createdAt),
    "Atualizado em": formatExportDate(p.updatedAt),
    "ID do produto": text(p.id),
  };
}

/**
 * Mesma ordem da listagem de Produtos (em estoque primeiro, mais novo
 * primeiro), com desempate por id para o resultado não variar entre
 * exportações. Não altera o array recebido.
 */
export function sortForExport(products: ExportProduct[]): ExportProduct[] {
  const time = (iso: string | null) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(t) ? 0 : t;
  };
  return [...products].sort((a, b) => {
    const stockA = (a.stock ?? 0) > 0 ? 1 : 0;
    const stockB = (b.stock ?? 0) > 0 ? 1 : 0;
    if (stockA !== stockB) return stockB - stockA;
    const byDate = time(b.createdAt) - time(a.createdAt);
    if (byDate !== 0) return byDate;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

const EXPORT_RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

/**
 * Espera antes de tentar a página de novo, ou null para não tentar.
 * `status` null = falha de rede. Só 429 (limite de requisições) e 5xx são
 * passageiros; 4xx é definitivo (sessão, parâmetro).
 */
export function exportRetryDelayMs(
  status: number | null,
  attempt: number,
): number | null {
  const transient = status === null || status === 429 || status >= 500;
  if (!transient || attempt >= EXPORT_RETRY_DELAYS_MS.length) return null;
  return EXPORT_RETRY_DELAYS_MS[attempt];
}

/** O pedaço do SheetJS que a planilha usa (injetado: o módulo é carregado sob demanda). */
export interface XlsxLike {
  utils: {
    aoa_to_sheet(data: unknown[][]): Record<string, unknown>;
    book_new(): unknown;
    book_append_sheet(wb: unknown, ws: unknown, name: string): void;
  };
  write(wb: unknown, opts: Record<string, unknown>): ArrayBuffer;
}

/**
 * Gera o .xlsx em memória.
 *
 * ⚠️ `compression: true` é OBRIGATÓRIO. Sem ele o SheetJS monta o arquivo
 * inteiro sem compressão numa única string; com 52 colunas e 60 mil produtos
 * (maior cliente, 25/09/2026) isso estoura a memória e a aba cai — medido:
 * sem compressão o processo morre, com compressão sai um arquivo de 58 MB com
 * pico de 2,3 GB (a exportação antiga de 17 colunas: 86 MB, 2,2 GB).
 * Linhas como arrays (`aoa_to_sheet`) em vez de objetos: −190 MB de pico.
 */
export function buildExportWorkbook(
  xlsx: XlsxLike,
  products: ExportProduct[],
): ArrayBuffer {
  const sorted = sortForExport(products);
  const data: ExportCell[][] = [[...EXPORT_COLUMNS]];
  for (const p of sorted) {
    const row = exportRowFromProduct(p);
    data.push(EXPORT_COLUMNS.map((c) => row[c]));
  }
  const ws = xlsx.utils.aoa_to_sheet(data);
  ws["!cols"] = exportColumnWidths();
  if (typeof ws["!ref"] === "string") ws["!autofilter"] = { ref: ws["!ref"] };
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, "Produtos");
  return xlsx.write(wb, { bookType: "xlsx", type: "array", compression: true });
}

/** Largura das colunas (em caracteres) para o arquivo abrir legível. */
export function exportColumnWidths(): Array<{ wch: number }> {
  const wide = new Set<ExportColumn>([
    "Nome",
    "Descrição",
    "Localização",
    "Compatibilidades",
    "Ficha técnica",
    "Dados importados de outro sistema",
    "Todas as imagens",
    "Categoria Mercado Livre",
    "Anúncios Mercado Livre",
    "Anúncios Shopee",
    "Links dos anúncios",
  ]);
  return EXPORT_COLUMNS.map((c) => ({
    wch: wide.has(c) ? 40 : Math.max(12, Math.min(28, c.length + 2)),
  }));
}
