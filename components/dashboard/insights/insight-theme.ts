/**
 * Cores, rótulos e formatadores dos cards de insight do Dashboard.
 *
 * Módulo PURO (sem React, sem recharts) — roda direto no vitest, que usa
 * `environment: "node"` e não tem DOM.
 */

/**
 * O recharts não resolve `var()` nem `color-mix()` dentro do atributo `fill` do
 * SVG. O padrão do projeto é `fill="currentColor"` + `style={{ color }}`, e é
 * esta função que monta o valor do `color` — misturando o token com o fundo do
 * card para a barra não brigar com o texto, igual aos gráficos existentes.
 */
export function chartColor(token: string, mix = 74): string {
  return `color-mix(in srgb, var(${token}) ${mix}%, var(--color-card) ${
    100 - mix
  }%)`;
}

/** Paleta da marca (app/globals.css), já adaptada a claro/escuro pelos tokens. */
export const CHART_TOKENS = [
  "--color-chart-1",
  "--color-chart-2",
  "--color-chart-3",
  "--color-chart-5",
  "--color-chart-4",
] as const;

/** Cor estável por posição — a mesma categoria mantém a cor entre períodos. */
export function paletteColor(index: number, mix = 74): string {
  return chartColor(CHART_TOKENS[index % CHART_TOKENS.length], mix);
}

export type PlatformKey = "ML" | "SHOPEE" | "MAGALU" | "OUTRO";

/** Cor fixa por marketplace: trocar de período não pode trocar a cor da barra. */
export const PLATFORM_COLOR: Record<PlatformKey, string> = {
  ML: chartColor("--color-chart-1"),
  SHOPEE: chartColor("--color-chart-2"),
  MAGALU: chartColor("--color-chart-3"),
  OUTRO: chartColor("--color-chart-4"),
};

export function platformColor(key: string): string {
  return PLATFORM_COLOR[key as PlatformKey] ?? PLATFORM_COLOR.OUTRO;
}

export const CHANNEL_COLOR = {
  BALCAO: chartColor("--color-chart-2"),
  AVULSO: chartColor("--color-chart-4"),
} as const;

// ────────────────────────────── formatadores ─────────────────────────────────
// Instanciados uma vez no módulo (padrão de hero-area-chart.tsx). Nada é
// importado de app/page.tsx: aquele arquivo está em produção e não é tocado.

const BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const BRL_COMPACT = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  notation: "compact",
  maximumFractionDigits: 1,
});

const INT = new Intl.NumberFormat("pt-BR");

export function fmtBRL(value: number): string {
  return BRL.format(Number.isFinite(value) ? value : 0);
}

/** Para eixos e chips, onde "R$ 12,3 mil" cabe e "R$ 12.345,67" não. */
export function fmtBRLCompact(value: number): string {
  return BRL_COMPACT.format(Number.isFinite(value) ? value : 0);
}

export function fmtInt(value: number): string {
  return INT.format(Number.isFinite(value) ? Math.round(value) : 0);
}

export function fmtPct(value: number, digits = 1): string {
  const n = Number.isFinite(value) ? value : 0;
  return `${n.toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

/** Nomes longos de categoria estouram o eixo; corta preservando o começo. */
export function truncateLabel(label: string, max = 22): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/**
 * Categorias de marketplace vêm como caminho hierárquico:
 *   "Acessórios para Veículos > Peças de Carros e Caminhonetes > Faróis"
 * Truncar isso pelo começo é inútil — TODAS as categorias do Mercado Livre
 * partem do mesmo prefixo e virariam "Acessórios para Veícu…", indistinguíveis
 * no eixo. O que identifica a categoria é a FOLHA, então é ela que vai no
 * rótulo; o caminho completo fica no tooltip e no `title` da lista.
 */
export function categoryLeaf(path: string): string {
  const partes = String(path)
    .split(">")
    .map((p) => p.trim())
    .filter(Boolean);
  return partes.length ? partes[partes.length - 1] : String(path);
}

/** Nível imediatamente acima da folha — desempata folhas homônimas. */
export function categoryParent(path: string): string | null {
  const partes = String(path)
    .split(">")
    .map((p) => p.trim())
    .filter(Boolean);
  return partes.length > 1 ? partes[partes.length - 2] : null;
}

/**
 * Cor de barra em RANKING: uma única cor da marca com intensidade decrescente,
 * em vez de N cores diferentes. Dez cores categóricas numa lista ordenada
 * poluem e sugerem uma diferença de natureza que não existe — todas as barras
 * medem a mesma coisa, só que menos.
 */
export function rankColor(index: number, total: number): string {
  const passo = total > 1 ? index / (total - 1) : 0;
  const mix = Math.round(88 - passo * 46); // 88% → 42%
  return `color-mix(in srgb, var(--color-chart-2) ${mix}%, var(--color-card) ${
    100 - mix
  }%)`;
}

/** Cinza neutro — para a linha "Outras", que é uma soma e não uma categoria. */
export const NEUTRAL_BAR = chartColor("--color-chart-4", 38);

/** Estilo do tooltip do recharts — mesmo visual dos gráficos já em produção. */
export const TOOLTIP_STYLE = {
  contentStyle: {
    backgroundColor: "var(--color-popover)",
    color: "var(--color-popover-foreground)",
    border: "1px solid var(--color-border)",
    borderRadius: 12,
    boxShadow:
      "0 18px 48px color-mix(in srgb, var(--color-shadow-color) 16%, transparent)",
  },
  labelStyle: {
    color: "var(--color-muted-foreground)",
    fontWeight: 500,
  },
} as const;

export const AXIS_TICK = {
  fill: "var(--color-muted-foreground)",
  fontSize: 12,
} as const;

export const GRID_STROKE =
  "color-mix(in srgb, var(--color-border) 68%, transparent)";
