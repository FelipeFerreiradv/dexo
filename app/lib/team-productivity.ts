import { canonPlatform } from "./marketplace-platform";

/**
 * Agregação PURA (sem DB) da produtividade da equipe a partir das linhas de
 * `SystemLog` já filtradas/deduplicadas pela camada de rota (apenas a linha do
 * SERVIÇO: `action ∈ {CREATE_PRODUCT,CREATE_LISTING}`, `resourceId != null`,
 * `level = INFO`). Conta produtos (entidade interna, sem plataforma) e anúncios
 * (total + split ML/Shopee/Outro via `canonPlatform` sobre `details.marketplace`).
 * Toda a lógica fica aqui para ser testável sem banco. Usada pela Entrega A
 * (tela) e reaproveitada nos relatórios PDF (Entregas B/C).
 */

export interface ProductivityLogRow {
  userId: string | null;
  action: string;
  details: unknown;
  createdAt: Date;
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
  if (!start) start = new Date(end.getTime() - 30 * MS_PER_DAY);
  if (start > end) start = new Date(end.getTime() - 30 * MS_PER_DAY);

  const label = usedDefault
    ? "Últimos 30 dias"
    : `${fmtBR(start)} a ${fmtBR(end)}`;
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
  rows: ProductivityLogRow[],
  collaborators: ProductivityCollaboratorInput[],
  range: { startDate: Date; endDate: Date },
): ProductivityResult {
  const totals = { produtos: 0, anuncios: newAnuncios() };

  const perCollab = new Map<
    string,
    {
      produtos: number;
      anuncios: AnunciosBreakdown;
      lastActivityAt: Date | null;
    }
  >();
  for (const c of collaborators) {
    perCollab.set(c.id, {
      produtos: 0,
      anuncios: newAnuncios(),
      lastActivityAt: null,
    });
  }

  const dayMap = new Map<string, ProductivityTimeseriesPoint>();

  for (const row of rows) {
    if (!row.userId) continue;
    const c = perCollab.get(row.userId);
    if (!c) continue; // fora do escopo de colaboradores conhecidos (defensivo)

    if (!c.lastActivityAt || row.createdAt > c.lastActivityAt) {
      c.lastActivityAt = row.createdAt;
    }

    const dayKey = toISODate(row.createdAt);
    let bucket = dayMap.get(dayKey);
    if (!bucket) {
      bucket = { date: dayKey, produtos: 0, ml: 0, shopee: 0 };
      dayMap.set(dayKey, bucket);
    }

    if (row.action === "CREATE_PRODUCT") {
      totals.produtos++;
      c.produtos++;
      bucket.produtos++;
      continue;
    }

    // CREATE_LISTING — split por plataforma (normalizada na leitura).
    const platform = canonPlatform(
      (row.details as { marketplace?: string | null } | null)?.marketplace,
    );
    totals.anuncios.total++;
    c.anuncios.total++;
    if (platform === "ML") {
      totals.anuncios.ml++;
      c.anuncios.ml++;
      bucket.ml++;
    } else if (platform === "SHOPEE") {
      totals.anuncios.shopee++;
      c.anuncios.shopee++;
      bucket.shopee++;
    } else {
      totals.anuncios.outro++;
      c.anuncios.outro++;
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
        lastActivityAt: agg.lastActivityAt
          ? agg.lastActivityAt.toISOString()
          : null,
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
