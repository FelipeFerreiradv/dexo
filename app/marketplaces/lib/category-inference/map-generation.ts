/**
 * Lógica PURA da geração do mapa tipo-de-peça → categoria (gates estatísticos
 * e semânticos). O I/O (varredura do banco, resolução de folha, escrita do
 * arquivo) fica em scripts/build-part-type-category-map.ts — mesmo desenho do
 * par catalog-stats-aggregation.ts ↔ build-catalog-stats.ts.
 */

// ── Parâmetros dos gates ────────────────────────────────────────────────────

export const MAP_MIN_SAMPLE = 10;
export const MAP_MIN_MODE_SHARE = 0.5;
export const MAP_MIN_DOMINANCE = 1.5;
/** Nº de tipos-base distintos a partir do qual uma categoria vira "lixão". */
export const DUMP_CATEGORY_MIN_BASES = 3;

/**
 * Labels-base que sozinhos NÃO determinam categoria (o casamento leftmost do
 * extractPartType os atribui a produtos heterogêneos: "motor" pega motor
 * parcial, de arranque, do limpador, da máquina de vidro…). Multiword
 * derivados ("motor-de-arranque", "caixa-de-direcao", "luz-de-teto") são
 * labels próprios do PART_TYPES e não caem aqui.
 */
export const AMBIGUOUS_LABELS = new Set([
  "motor",
  "sensor",
  "caixa",
  "capa",
  "freio",
  "botao",
  "alavanca",
  "coluna",
  "acabamento",
  "tampa",
  "luz",
  "chave",
  "cabo",
  "suporte",
  "tubo",
  "chapa",
  "valvula",
  "modulo",
]);

/** Marcadores de domínio automotivo no fullPath Shopee (acento-insensível). */
export const SHOPEE_AUTOMOTIVE_MARKERS = [
  "veicul",
  "automotiv",
  "automo",
  "motocicleta",
];
/** Ramos Shopee onde autopeça de carro nunca pertence (histórico poluído). */
export const SHOPEE_BLOCKED_BRANCHES = [
  "veiculos pesados",
  "barcos",
  "motocicleta",
];
/** Ramos ML idem (ex.: moda caiu em Peças de Motos e Quadriciclos). */
export const ML_BLOCKED_BRANCHES = ["motos e quadriciclos"];

// ── Normalização/tokens ─────────────────────────────────────────────────────

export function normalizePath(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

const POSITION_WORDS = new Set([
  "dianteiro",
  "dianteira",
  "dianteiros",
  "dianteiras",
  "traseiro",
  "traseira",
  "traseiros",
  "traseiras",
  "esquerdo",
  "esquerda",
  "direito",
  "direita",
  "superior",
  "inferior",
]);

/** Singularização crua o suficiente p/ comparar tokens PT ("farois"→"faro"). */
function singularize(t: string): string {
  return t.replace(/(is|es|s)$/, "");
}

function contentTokens(text: string): string[] {
  return (
    normalizePath(text)
      // Compostos "para-X" viram um token só (mesma família do COMPOUND_WORDS
      // do title-parse) — senão o "para" solto de "Para-brisa" casaria como
      // prefixo de "parachoque".
      .replace(/para[\s-]+(brisa|choque|lama|barro)/g, "para$1")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !POSITION_WORDS.has(t))
  );
}

/**
 * true quando o label do tipo compartilha um token de conteúdo com o NOME da
 * folha ("lanterna" → "Lanternas Traseiras"; "fechadura" → idem NÃO).
 * Posições são ignoradas dos dois lados (senão "tampa-traseira" casaria
 * "Lanternas Traseiras" pelo "traseira").
 */
export function labelMatchesLeaf(baseLabel: string, leafPath: string): boolean {
  const labelTokens = contentTokens(baseLabel.replace(/-/g, " "));
  const lastSegment = leafPath.split(">").pop() ?? leafPath;
  const leafTokens = contentTokens(lastSegment);
  return labelTokens.some((a) =>
    leafTokens.some((b) => {
      if (a === b) return true;
      const sa = singularize(a);
      const sb = singularize(b);
      return sa === sb || a.startsWith(sb) || b.startsWith(sa);
    }),
  );
}

/**
 * Chave-base de uma chave possivelmente dobrada com posição
 * ("fechadura-traseiro-direito" → "fechadura"). Labels femininos próprios do
 * PART_TYPES ("tampa-traseira") não são posição dobrada e ficam intactos.
 */
export function baseKeyOf(key: string): string {
  const m = key.match(
    /-(dianteiro|traseiro|esquerdo|direito|superior|inferior)(-(dianteiro|traseiro|esquerdo|direito|superior|inferior))*$/,
  );
  return m ? key.slice(0, m.index) : key;
}

// ── Moda + dominância ───────────────────────────────────────────────────────

export interface ModeResult {
  value: string;
  count: number;
  sample: number;
  share: number;
  runnerUp: { value: string; count: number } | null;
}

/** Moda + segundo colocado de um mapa de contagens. */
export function modeOf(counts: Map<string, number>): ModeResult | null {
  let sample = 0;
  let first: { value: string; count: number } | null = null;
  let second: { value: string; count: number } | null = null;
  for (const [value, count] of counts) {
    sample += count;
    if (!first || count > first.count) {
      second = first;
      first = { value, count };
    } else if (!second || count > second.count) {
      second = { value, count };
    }
  }
  if (!first) return null;
  return {
    value: first.value,
    count: first.count,
    sample,
    share: first.count / sample,
    runnerUp: second,
  };
}

/**
 * Gate estatístico da moda: amostra mínima, cobertura e dominância sobre o
 * segundo colocado. Retorna o motivo da reprovação ou null quando passa.
 */
export function statisticalGate(
  mode: ModeResult,
  minSample = MAP_MIN_SAMPLE,
): string | null {
  if (mode.sample < minSample) return `amostra < ${minSample}`;
  if (mode.share < MAP_MIN_MODE_SHARE) return "modeShare < 0.5";
  if (mode.runnerUp && mode.count < MAP_MIN_DOMINANCE * mode.runnerUp.count)
    return "dominância < 1.5x";
  return null;
}

// ── Anti categoria-lixão ────────────────────────────────────────────────────

export interface DumpFilterCandidate {
  key: string;
  baseKey: string;
  /** id no namespace da árvore (MLB… / SHP_…). */
  treeId: string;
  leafPath: string;
}

/**
 * Mesma categoria como moda de ≥ N tipos-BASE distintos = assinatura de import
 * legado que despejou tudo numa categoria só. Só sobrevive a chave cujo label
 * bate com o nome da folha. Retorna o Set de candidatos REPROVADOS.
 */
export function dumpCategoryRejects<T extends DumpFilterCandidate>(
  candidates: T[],
  minBases = DUMP_CATEGORY_MIN_BASES,
): Set<T> {
  const basesPerCategory = new Map<string, Set<string>>();
  for (const c of candidates) {
    let set = basesPerCategory.get(c.treeId);
    if (!set) basesPerCategory.set(c.treeId, (set = new Set()));
    set.add(c.baseKey);
  }
  const rejected = new Set<T>();
  for (const c of candidates) {
    const bases = basesPerCategory.get(c.treeId)!;
    if (bases.size < minBases) continue;
    if (labelMatchesLeaf(c.baseKey, c.leafPath)) continue;
    rejected.add(c);
  }
  return rejected;
}
