import { canonPlatform } from "./marketplace-platform";

/**
 * Agregação PURA (sem DB) da produtividade da equipe. EGRESS: a contagem é feita
 * NO BANCO (GROUP BY userId, action, dia, marketplace + COUNT) — esta função
 * recebe os GRUPOS já contados, não as linhas cruas, evitando puxar milhares de
 * `SystemLog` para a memória (mesmo padrão das rotas /dashboard/*). A linha do
 * SERVIÇO já é isolada no `where` da rota (`action ∈ {CREATE_PRODUCT,
 * CREATE_LISTING}`, `resourceId != null`, `level = INFO`). Produtos = entidade
 * interna (sem plataforma); anúncios = total + split ML/Shopee/Outro via
 * `canonPlatform` sobre o `marketplace` extraído de `details`. Usada pela
 * Entrega A (tela) e reaproveitada nos relatórios PDF (Entregas B/C).
 */

export interface ProductivityGroupRow {
  userId: string | null;
  action: string; // CREATE_PRODUCT | CREATE_LISTING
  day: string; // "YYYY-MM-DD" (UTC) — to_char(createdAt)
  marketplace: string | null; // details->>'marketplace' (só p/ CREATE_LISTING)
  count: number;
}

export interface ProductivityCollaboratorInput {
  id: string;
  name?: string | null;
  email: string;
  avatarUrl?: string | null;
}

export interface AnunciosBreakdown {
  total: number;
  ml: number;
  shopee: number;
  outro: number;
}

export interface CollaboratorProductivity {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  produtos: number;
  anuncios: AnunciosBreakdown;
  lastActivityAt: string | null;
}

export interface ProductivityTimeseriesPoint {
  date: string; // YYYY-MM-DD (UTC)
  produtos: number;
  ml: number;
  shopee: number;
}

export interface ProductivityResult {
  totals: { produtos: number; anuncios: AnunciosBreakdown };
  byCollaborator: CollaboratorProductivity[];
  timeseries: ProductivityTimeseriesPoint[];
  // Aditivo (BLOCO 1 — orçamentos por vendedor). Opcional p/ não quebrar o
  // retorno de aggregateTeamProductivity (que cuida só de produtividade).
  budgetsByVendedor?: VendedorBudgetStats[];
  budgetTotals?: BudgetVendedorTotals;
}

// ── Orçamentos por vendedor (BLOCO 1) ──
// Linha agregada NO BANCO por vendedorId: emitidos + convertidos (count+valor).
export interface BudgetVendedorRow {
  vendedorId: string | null;
  count: number;
  totalValue: number;
  convertedCount: number;
  convertedValue: number;
}

// Vendedor selecionável = colaborador OU o próprio admin (isOwner=true).
export interface BudgetVendedorInput {
  id: string;
  name?: string | null;
  email: string;
  isOwner: boolean;
}

export interface VendedorBudgetStats {
  id: string;
  name: string | null;
  email: string;
  isOwner: boolean;
  orcamentos: { count: number; valor: number };
  convertidos: { count: number; valor: number };
}

export interface BudgetVendedorTotals {
  orcamentos: { count: number; valor: number };
  convertidos: { count: number; valor: number };
}

export interface ProductivityRange {
  startDate: Date;
  endDate: Date;
  label: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function newAnuncios(): AnunciosBreakdown {
  return { total: 0, ml: 0, shopee: 0, outro: 0 };
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtBR(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

/**
 * Resolve o intervalo a partir da querystring. Sem nenhum parâmetro → últimos
 * 30 dias (rolling). Datas no formato "YYYY-MM-DD" do `<input type=date>` viram
 * início do dia (start) e fim do dia (end) p/ inclusão correta. Entradas
 * inválidas são ignoradas (fallback ao default). Nunca lança.
 */
export function resolveProductivityRange(
  startStr?: string | null,
  endStr?: string | null,
  now: Date = new Date(),
): ProductivityRange {
  // Datas "YYYY-MM-DD" são interpretadas em UTC (sufixo "Z") — determinístico
  // entre máquinas (CI=UTC, dev=BRT) e consistente com /me/team/activity, que
  // parseia date-only como UTC (spec ES). Janelas curtas da UI toleram o leve
  // deslocamento de fuso na borda do dia.
  const parse = (
    s: string | null | undefined,
    endOfDay: boolean,
  ): Date | null => {
    if (!s) return null;
    const iso = DATE_ONLY.test(s)
      ? `${s}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
      : s;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  };

  let start = parse(startStr, false);
  let end = parse(endStr, true);
  const usedDefault = !start && !end;

  if (!end) end = now;
  // Rótulo reflete a data ESCOLHIDA pelo usuário (antes do clamp de fuso abaixo).
  const labelEnd = end;
  // Borda de fuso: o "fim do dia" é interpretado em UTC. À noite no Brasil
  // (BRT = UTC-3) o "hoje" do usuário já virou o próximo dia em UTC, então o
  // fim "hoje 23:59:59Z" cai ATRÁS do agora real e o filtro `createdAt <= end`
  // EXCLUI registros recém-criados (orçamento/venda/produto criados à noite
  // somem das stats até o dia virar). Quando o fim é "hoje" (ficou no passado
  // a < 24h do agora), estende até o agora. Intervalos genuinamente passados
  // (fim a > 24h atrás) não são tocados — a borda de dia histórica é inócua.
  if (end < now && now.getTime() - end.getTime() < MS_PER_DAY) end = now;
  if (!start) start = new Date(end.getTime() - 30 * MS_PER_DAY);
  if (start > end) start = new Date(end.getTime() - 30 * MS_PER_DAY);

  const label = usedDefault
    ? "Últimos 30 dias"
    : `${fmtBR(start)} a ${fmtBR(labelEnd)}`;
  return { startDate: start, endDate: end, label };
}

function buildTimeseries(
  start: Date,
  end: Date,
  dayMap: Map<string, ProductivityTimeseriesPoint>,
): ProductivityTimeseriesPoint[] {
  const out: ProductivityTimeseriesPoint[] = [];
  const cur = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const last = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()),
  );
  // Backstop de ~2 anos p/ intervalos absurdos (a UI usa janelas curtas).
  let guard = 0;
  while (cur <= last && guard < 800) {
    const key = toISODate(cur);
    const b = dayMap.get(key);
    out.push({
      date: key,
      produtos: b?.produtos ?? 0,
      ml: b?.ml ?? 0,
      shopee: b?.shopee ?? 0,
    });
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard++;
  }
  return out;
}

export function aggregateTeamProductivity(
  groups: ProductivityGroupRow[],
  collaborators: ProductivityCollaboratorInput[],
  range: { startDate: Date; endDate: Date },
): ProductivityResult {
  const totals = { produtos: 0, anuncios: newAnuncios() };

  const perCollab = new Map<
    string,
    {
      produtos: number;
      anuncios: AnunciosBreakdown;
      lastDay: string | null;
    }
  >();
  for (const c of collaborators) {
    perCollab.set(c.id, {
      produtos: 0,
      anuncios: newAnuncios(),
      lastDay: null,
    });
  }

  const dayMap = new Map<string, ProductivityTimeseriesPoint>();

  for (const g of groups) {
    if (!g.userId) continue;
    const c = perCollab.get(g.userId);
    if (!c) continue; // fora do escopo de colaboradores conhecidos (defensivo)
    const cnt = g.count || 0;

    if (!c.lastDay || g.day > c.lastDay) c.lastDay = g.day;

    let bucket = dayMap.get(g.day);
    if (!bucket) {
      bucket = { date: g.day, produtos: 0, ml: 0, shopee: 0 };
      dayMap.set(g.day, bucket);
    }

    if (g.action === "CREATE_PRODUCT") {
      totals.produtos += cnt;
      c.produtos += cnt;
      bucket.produtos += cnt;
      continue;
    }

    // CREATE_LISTING — split por plataforma (normalizada na leitura).
    const platform = canonPlatform(g.marketplace);
    totals.anuncios.total += cnt;
    c.anuncios.total += cnt;
    if (platform === "ML") {
      totals.anuncios.ml += cnt;
      c.anuncios.ml += cnt;
      bucket.ml += cnt;
    } else if (platform === "SHOPEE") {
      totals.anuncios.shopee += cnt;
      c.anuncios.shopee += cnt;
      bucket.shopee += cnt;
    } else {
      totals.anuncios.outro += cnt;
      c.anuncios.outro += cnt;
    }
  }

  const byCollaborator: CollaboratorProductivity[] = collaborators
    .map((c) => {
      const agg = perCollab.get(c.id)!;
      return {
        id: c.id,
        name: c.name ?? null,
        email: c.email,
        avatarUrl: c.avatarUrl ?? null,
        produtos: agg.produtos,
        anuncios: agg.anuncios,
        // lastActivityAt = último dia com atividade (a contagem é por dia no
        // banco; o campo é informativo e não é exibido na tela/PDF).
        lastActivityAt: agg.lastDay ? `${agg.lastDay}T00:00:00.000Z` : null,
      };
    })
    .sort(
      (a, b) =>
        b.anuncios.total - a.anuncios.total ||
        b.produtos - a.produtos ||
        (a.name ?? a.email).localeCompare(b.name ?? b.email),
    );

  return {
    totals,
    byCollaborator,
    timeseries: buildTimeseries(range.startDate, range.endDate, dayMap),
  };
}

/**
 * Agregação PURA dos orçamentos por vendedor (count + valor, emitidos e
 * convertidos). `rows` já vêm contados do banco (GROUP BY vendedorId).
 * `vendedores` = admin + colaboradores (cada um vira uma linha, mesmo com zero,
 * p/ o relatório listar todos). Ordena por valor de orçamentos desc.
 */
export function aggregateBudgetsByVendedor(
  rows: BudgetVendedorRow[],
  vendedores: BudgetVendedorInput[],
): { totals: BudgetVendedorTotals; byVendedor: VendedorBudgetStats[] } {
  const per = new Map<
    string,
    { count: number; valor: number; convCount: number; convValor: number }
  >();
  for (const v of vendedores) {
    per.set(v.id, { count: 0, valor: 0, convCount: 0, convValor: 0 });
  }
  const totals: BudgetVendedorTotals = {
    orcamentos: { count: 0, valor: 0 },
    convertidos: { count: 0, valor: 0 },
  };

  for (const r of rows) {
    if (!r.vendedorId) continue;
    const p = per.get(r.vendedorId);
    if (!p) continue; // vendedor fora do time conhecido (defensivo)
    const count = r.count || 0;
    const valor = r.totalValue || 0;
    const convCount = r.convertedCount || 0;
    const convValor = r.convertedValue || 0;
    p.count += count;
    p.valor += valor;
    p.convCount += convCount;
    p.convValor += convValor;
    totals.orcamentos.count += count;
    totals.orcamentos.valor += valor;
    totals.convertidos.count += convCount;
    totals.convertidos.valor += convValor;
  }

  const byVendedor: VendedorBudgetStats[] = vendedores
    .map((v) => {
      const p = per.get(v.id)!;
      return {
        id: v.id,
        name: v.name ?? null,
        email: v.email,
        isOwner: v.isOwner,
        orcamentos: { count: p.count, valor: p.valor },
        convertidos: { count: p.convCount, valor: p.convValor },
      };
    })
    .sort(
      (a, b) =>
        b.orcamentos.valor - a.orcamentos.valor ||
        b.orcamentos.count - a.orcamentos.count ||
        (a.name ?? a.email).localeCompare(b.name ?? b.email),
    );

  return { totals, byVendedor };
}
