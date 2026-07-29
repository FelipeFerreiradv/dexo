/**
 * Agregação PURA (sem DB) dos gráficos novos do Dashboard: vendas por
 * plataforma, vendas por categoria, valor a receber por forma de pagamento e
 * divisão por forma de venda (balcão × avulso).
 *
 * Recebe linhas JÁ agregadas pelo banco (`dashboard-breakdowns.query.ts`) e só
 * as formata — mesma separação de `team-productivity.ts` ← `.query.ts`. Lógica
 * isolada aqui p/ ser testável sem banco.
 *
 * DOIS DOMÍNIOS, DUAS REGRAS DE STATUS (não "harmonizar" num refactor futuro):
 *  - Pedidos (`Order`): CANCELLED ENTRA na receita por padrão, igual a
 *    /orders-over-time, /account-stats, /report.pdf e /product-metrics. Sair
 *    disso faria os gráficos novos divergirem dos números já exibidos na mesma
 *    tela. Quem quiser o recorte usa `?excludeCancelled=true` ou os campos
 *    `cancelledOrders`/`cancelledRevenue`, devolvidos à parte.
 *  - Contas a receber (`Receivable`): CANCELADA fica FORA, regra do módulo
 *    financeiro (finance.routes.ts e finance-report.ts:106).
 */

import { canonPlatform, type CanonPlatform } from "./marketplace-platform";
import { paymentMethodLabel } from "./payment-methods";
import {
  resolveProductivityRange,
  type ProductivityRange,
} from "./team-productivity";

/** Valores do enum `Platform` do Prisma. Literal p/ manter o módulo puro. */
export type PlatformEnumValue = "MERCADO_LIVRE" | "SHOPEE" | "MAGALU";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Teto da janela consultável. `resolveProductivityRange` valida o FORMATO das
 * datas mas não o TAMANHO do intervalo: `?startDate=1900-01-01` mandaria o
 * banco varrer ~46 mil dias. 730 dias cobre qualquer filtro real da UI.
 */
export const MAX_RANGE_DAYS = 730;

/** Teto de linhas do GROUP BY de categoria (`Product.category` é texto livre). */
export const MAX_CATEGORY_ROWS = 500;

/** Teto de tokens aceitos no CSV de `?platform=` (anti-DoS de parsing). */
const MAX_PLATFORM_TOKENS = 8;

const CANON_TO_ENUM: Partial<Record<CanonPlatform, PlatformEnumValue>> = {
  ML: "MERCADO_LIVRE",
  SHOPEE: "SHOPEE",
  MAGALU: "MAGALU",
};

const PLATFORM_LABEL: Record<CanonPlatform, string> = {
  ML: "Mercado Livre",
  SHOPEE: "Shopee",
  MAGALU: "Magalu",
  OUTRO: "Outros",
};

/** Ordem fixa das plataformas na resposta (legenda estável entre períodos). */
const PLATFORM_ORDER: CanonPlatform[] = ["ML", "SHOPEE", "MAGALU"];

export const SEM_CATEGORIA_LABEL = "Sem categoria";
export const OUTRAS_CATEGORIAS_LABEL = "Outras";

/** Meio centavo: resto abaixo disso é ruído de float, não uma fatia real. */
const MONEY_EPSILON = 0.005;

// ───────────────────────────── helpers numéricos ─────────────────────────────

/**
 * `numeric` do Postgres chega como string (`::text`) para não virar
 * `Prisma.Decimal` — que serializaria como string no JSON e quebraria o
 * contrato numérico de /orders-over-time. Nunca devolve NaN/Infinity.
 */
export function num(x: string | number | null | undefined): number {
  if (x == null) return 0;
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** Percentual sem arredondar (quem formata é o front; 2 casas aqui gera "99,99%"). */
export function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

// ──────────────────────────── parsing de querystring ─────────────────────────

export interface DashboardRange extends ProductivityRange {
  /** true quando a janela pedida excedeu MAX_RANGE_DAYS e foi encurtada. */
  clamped: boolean;
}

/**
 * Período dos gráficos. Mesma precedência de /dashboard/report.pdf: `days` só
 * vale quando NÃO há `startDate`/`endDate`. Nunca lança — entrada inválida cai
 * no default de 30 dias, como todas as rotas do Dashboard hoje.
 */
export function resolveDashboardRange(
  q: Record<string, string | undefined>,
  now: Date = new Date(),
): DashboardRange {
  let startStr = q.startDate;
  const endStr = q.endDate;
  let daysLabel: string | null = null;

  if (!startStr && !endStr && q.days) {
    const n = parseInt(q.days, 10);
    if (Number.isFinite(n) && n > 0) {
      const days = Math.min(n, MAX_RANGE_DAYS);
      startStr = new Date(now.getTime() - days * MS_PER_DAY).toISOString();
      daysLabel = `Últimos ${days} dias`;
    }
  }

  const r = resolveProductivityRange(startStr, endStr, now);
  const label = daysLabel ?? r.label;

  if (r.endDate.getTime() - r.startDate.getTime() > MAX_RANGE_DAYS * MS_PER_DAY) {
    return {
      startDate: new Date(r.endDate.getTime() - MAX_RANGE_DAYS * MS_PER_DAY),
      endDate: r.endDate,
      label,
      clamped: true,
    };
  }
  return { ...r, label, clamped: false };
}

/**
 * CSV tolerante de plataformas: "ml", "ML,shopee", "Mercado Livre",
 * "MERCADO_LIVRE" — tudo passa por `canonPlatform`. Token desconhecido é
 * IGNORADO (não vira 400: nenhuma rota do Dashboard responde 400 hoje).
 * Lista vazia = sem filtro. O retorno alimenta um bind parametrizado, nunca
 * concatenação de SQL.
 */
export function parsePlatformFilter(
  raw?: string | null,
): PlatformEnumValue[] {
  if (!raw) return [];
  const out: PlatformEnumValue[] = [];
  for (const token of String(raw).split(",").slice(0, MAX_PLATFORM_TOKENS)) {
    const v = CANON_TO_ENUM[canonPlatform(token)];
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Inteiro de querystring com clamp. Lixo → `def`. */
export function parseTopN(
  raw: string | undefined,
  def: number,
  max: number,
): number {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, 0), max);
}

/** Padrão do repo (finance.routes.ts): só o literal "true" liga a opção. */
export function parseBooleanFlag(raw?: string | null): boolean {
  return raw === "true";
}

/** Range serializável no JSON da resposta. */
export function serializeRange(range: DashboardRange) {
  return {
    startDate: range.startDate.toISOString(),
    endDate: range.endDate.toISOString(),
    label: range.label,
    clamped: range.clamped,
  };
}

// ─────────────────────────── vendas por plataforma ───────────────────────────

export interface PlatformRow {
  platform: string;
  orders: number;
  revenue: string;
  cancelledOrders: number;
  cancelledRevenue: string;
}

export interface PlatformBreakdownItem {
  platform: CanonPlatform;
  label: string;
  orders: number;
  revenue: number;
  cancelledOrders: number;
  cancelledRevenue: number;
  share: number;
}

export interface PlatformBreakdown {
  totals: {
    orders: number;
    revenue: number;
    cancelledOrders: number;
    cancelledRevenue: number;
  };
  byPlatform: PlatformBreakdownItem[];
}

/**
 * ML/SHOPEE/MAGALU aparecem SEMPRE (mesmo zerados) p/ a legenda do gráfico não
 * mudar de forma entre períodos. "OUTRO" só entra se tiver movimento — o enum
 * `Platform` tem só 3 valores, então na prática nunca aparece; é defesa contra
 * um valor novo no enum sem atualizar este arquivo.
 */
export function buildPlatformBreakdown(
  rows: PlatformRow[],
): PlatformBreakdown {
  const acc = new Map<
    CanonPlatform,
    Omit<PlatformBreakdownItem, "platform" | "label" | "share">
  >();
  const bump = (key: CanonPlatform, row: PlatformRow) => {
    const e = acc.get(key) ?? {
      orders: 0,
      revenue: 0,
      cancelledOrders: 0,
      cancelledRevenue: 0,
    };
    e.orders += num(row.orders);
    e.revenue += num(row.revenue);
    e.cancelledOrders += num(row.cancelledOrders);
    e.cancelledRevenue += num(row.cancelledRevenue);
    acc.set(key, e);
  };

  for (const row of rows) bump(canonPlatform(row.platform), row);

  const keys: CanonPlatform[] = [...PLATFORM_ORDER];
  if ((acc.get("OUTRO")?.orders ?? 0) > 0) keys.push("OUTRO");

  const totals = {
    orders: 0,
    revenue: 0,
    cancelledOrders: 0,
    cancelledRevenue: 0,
  };
  for (const e of acc.values()) {
    totals.orders += e.orders;
    totals.revenue += e.revenue;
    totals.cancelledOrders += e.cancelledOrders;
    totals.cancelledRevenue += e.cancelledRevenue;
  }

  const byPlatform = keys.map((key) => {
    const e = acc.get(key) ?? {
      orders: 0,
      revenue: 0,
      cancelledOrders: 0,
      cancelledRevenue: 0,
    };
    return {
      platform: key,
      label: PLATFORM_LABEL[key],
      orders: e.orders,
      revenue: e.revenue,
      cancelledOrders: e.cancelledOrders,
      cancelledRevenue: e.cancelledRevenue,
      share: pct(e.revenue, totals.revenue),
    };
  });

  return { totals, byPlatform };
}

// ──────────────────────────── vendas por categoria ───────────────────────────

export interface CategoryRow {
  category: string | null;
  revenue: string;
  units: number;
}

export interface CategoryTotalsRow {
  revenue: string;
  units: number;
  orders: number;
  categories: number;
}

export interface CategoryBreakdownItem {
  category: string;
  revenue: number;
  units: number;
  share: number;
  /** true só na linha agregada "Outras". */
  isOther: boolean;
}

export interface CategoryBreakdown {
  totals: {
    revenue: number;
    units: number;
    orders: number;
    categories: number;
  };
  items: CategoryBreakdownItem[];
  /** true quando o GROUP BY bateu no teto de MAX_CATEGORY_ROWS. */
  truncated: boolean;
}

/**
 * Top-N + linha "Outras" derivada dos TOTAIS (que vêm de um agregado exato, sem
 * LIMIT) — não da soma das linhas. Assim os percentuais fecham 100% mesmo
 * quando a cauda foi cortada pelo teto do SQL.
 *
 * Não existe `orders` por categoria de propósito: um pedido com itens de duas
 * categorias contaria nas duas e `Σ items.orders ≠ totals.orders` — número que
 * vira chamado de bug. Pedidos só no total, via COUNT(DISTINCT).
 */
export function buildCategoryBreakdown(
  rows: CategoryRow[],
  totalsRow: CategoryTotalsRow | null | undefined,
  limit: number,
): CategoryBreakdown {
  const totals = {
    revenue: num(totalsRow?.revenue),
    units: num(totalsRow?.units),
    orders: num(totalsRow?.orders),
    categories: num(totalsRow?.categories),
  };

  const normalized = rows.map((r) => ({
    category: r.category?.trim() ? r.category.trim() : SEM_CATEGORIA_LABEL,
    revenue: num(r.revenue),
    units: num(r.units),
  }));

  const top = limit > 0 ? normalized.slice(0, limit) : normalized;

  const items: CategoryBreakdownItem[] = top.map((r) => ({
    category: r.category,
    revenue: r.revenue,
    units: r.units,
    share: pct(r.revenue, totals.revenue),
    isOther: false,
  }));

  const shownRevenue = top.reduce((s, r) => s + r.revenue, 0);
  const shownUnits = top.reduce((s, r) => s + r.units, 0);
  const restRevenue = totals.revenue - shownRevenue;
  const restUnits = totals.units - shownUnits;

  if (restRevenue > MONEY_EPSILON || restUnits > 0) {
    items.push({
      category: OUTRAS_CATEGORIAS_LABEL,
      revenue: Math.max(restRevenue, 0),
      units: Math.max(restUnits, 0),
      share: pct(Math.max(restRevenue, 0), totals.revenue),
      isOther: true,
    });
  }

  return { totals, items, truncated: rows.length >= MAX_CATEGORY_ROWS };
}

// ──────────────── formas de pagamento e formas de venda (a receber) ──────────

export interface FinanceBucketRow {
  /** `paymentMethod` (pode ser null) ou o canal ('BALCAO' | 'AVULSO'). */
  key: string | null;
  count: number;
  total: string;
  pago: string;
  pendente: string;
  vencido: string;
}

export interface FinanceBucket {
  total: number;
  pago: number;
  pendente: number;
  vencido: number;
  count: number;
}

export interface PaymentMethodItem extends FinanceBucket {
  method: string | null;
  label: string;
  share: number;
}

export interface PaymentMethodBreakdown {
  totals: FinanceBucket;
  items: PaymentMethodItem[];
}

export type SalesChannel = "BALCAO" | "AVULSO";

export interface ChannelItem extends FinanceBucket {
  channel: SalesChannel;
  label: string;
  share: number;
}

export interface ChannelSplit {
  totals: FinanceBucket;
  items: ChannelItem[];
}

const CHANNEL_LABEL: Record<SalesChannel, string> = {
  BALCAO: "Venda balcão",
  AVULSO: "A receber avulso",
};

function emptyBucket(): FinanceBucket {
  return { total: 0, pago: 0, pendente: 0, vencido: 0, count: 0 };
}

function bucketFromRow(row: FinanceBucketRow): FinanceBucket {
  return {
    total: num(row.total),
    pago: num(row.pago),
    pendente: num(row.pendente),
    vencido: num(row.vencido),
    count: num(row.count),
  };
}

function sumBuckets(rows: FinanceBucketRow[]): FinanceBucket {
  const t = emptyBucket();
  for (const row of rows) {
    const b = bucketFromRow(row);
    t.total += b.total;
    t.pago += b.pago;
    t.pendente += b.pendente;
    t.vencido += b.vencido;
    t.count += b.count;
  }
  return t;
}

/**
 * Ordena por valor total desc, igual ao `byMethod` de finance-report.ts:122-124.
 * `method: null` é bucket legítimo ("sem forma"), nunca filtrado —
 * `paymentMethodLabel` já o traduz para "—" e devolve códigos desconhecidos
 * (legado/importação) crus, sem quebrar.
 */
export function buildPaymentMethodBreakdown(
  rows: FinanceBucketRow[],
): PaymentMethodBreakdown {
  const totals = sumBuckets(rows);
  const items = rows
    .map((row) => {
      const b = bucketFromRow(row);
      return {
        method: row.key,
        label: paymentMethodLabel(row.key),
        ...b,
        share: pct(b.total, totals.total),
      };
    })
    .sort((a, b) => b.total - a.total);
  return { totals, items };
}

/**
 * Balcão × avulso: o mesmo split de finance-report.ts:109-110, onde "balcão" é
 * a conta a receber COM `ReceivableItem`. As duas linhas saem SEMPRE (zeradas
 * quando não houver movimento) p/ o gráfico de proporção não mudar de forma.
 */
export function buildChannelSplit(rows: FinanceBucketRow[]): ChannelSplit {
  const totals = sumBuckets(rows);
  const byKey = new Map<string, FinanceBucketRow>();
  for (const row of rows) if (row.key) byKey.set(row.key, row);

  const items = (["BALCAO", "AVULSO"] as SalesChannel[]).map((channel) => {
    const row = byKey.get(channel);
    const b = row ? bucketFromRow(row) : emptyBucket();
    return {
      channel,
      label: CHANNEL_LABEL[channel],
      ...b,
      share: pct(b.total, totals.total),
    };
  });

  return { totals, items };
}
