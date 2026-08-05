/**
 * Camada V2 da sugestao de categoria — entrada rica + coerencia + calibragem.
 *
 * Tudo aqui e PURO (sem prisma, sem rede, sem React) e vive atras do
 * kill-switch CATEGORY_SUGGEST_V2_DISABLED. Com a flag ligada, nenhuma destas
 * funcoes e chamada e o ranking volta a ser byte-identico ao anterior.
 *
 * ── O que a regua mostrou (baseline de 04/08/2026, producao) ──
 * Contra o gabarito humano do ML (mlCategorySource='manual', 400 casos,
 * 14 tenants): top-1 exato 0,0% | top-3 4,0% | MESMO RAMO 4,5% |
 * autoApply no top-1 366/400, TODOS divergentes do gabarito.
 *
 * O "top-1 exato ~0%" e em boa parte definicional (o front so grava "manual"
 * quando a escolha final diverge do auto-detectado), mas "mesmo ramo" nao e —
 * 4,5% significa que a sugestao vai para galhos completamente diferentes.
 *
 * Os erros mais frequentes da matriz apontam duas familias concretas:
 *   22x  "Espelhos Retrovisores Laterais"  -> "Espelhos Retrovisores INTERNOS"
 *    6x  "Para-choques > Difusores Aerodinamicos" -> "Difusores DE AR" (interior)
 *    4x  "Caixas de Ferramentas" -> "Tampas das Caixas de FUSIVEIS"
 * Ou seja: o candidato carrega um QUALIFICADOR que o titulo nao sustenta. E o
 * que `coherenceVerdict` resolve.
 */

/** Kill-switch. Lido por chamada para nao congelar no import (e testavel). */
export function isV2Enabled(): boolean {
  return process.env.CATEGORY_SUGGEST_V2_DISABLED !== "1";
}

// ─────────────────────────────────────────────────────────────────────────────
// Contexto do produto
// ─────────────────────────────────────────────────────────────────────────────

/**
 * O que o formulario JA TEM em maos quando pede a sugestao. Ate 04/08/2026 as
 * nove chamadas do front mandavam apenas o titulo e descartavam todo o resto,
 * mesmo lendo `brand`/`model`/`year`/`partNumber` e as medidas no mesmo callback
 * (create-product-dialog.tsx:2295-2299 e :2342-2345).
 */
export interface ProductSuggestContext {
  title: string;
  description?: string | null;
  brand?: string | null;
  model?: string | null;
  year?: string | null;
  version?: string | null;
  partNumber?: string | null;
  /** Categoria INTERNA do Dexo (Product.category), nao a do marketplace. */
  internalCategory?: string | null;
  sourceVehicle?: string | null;
  quality?: string | null;
  heightCm?: number | null;
  widthCm?: number | null;
  lengthCm?: number | null;
  weightKg?: number | null;
}

const CONTEXT_FIELDS = [
  "description",
  "brand",
  "model",
  "year",
  "version",
  "partNumber",
  "internalCategory",
  "sourceVehicle",
  "quality",
] as const;

/**
 * true quando o contexto nao acrescenta NADA alem do titulo. Este e o predicado
 * que garante a retrocompatibilidade: contexto vazio => caminho antigo,
 * inclusive a chave de cache.
 */
export function isContextEmpty(ctx: ProductSuggestContext): boolean {
  return CONTEXT_FIELDS.every((f) => {
    const v = ctx[f];
    return v === undefined || v === null || String(v).trim() === "";
  });
}

/**
 * Sufixo estavel para a chave de cache. Vazio quando o contexto e vazio — assim
 * a chave continua sendo exatamente `${siteId}::${normalizedTitle}` para quem
 * chama do jeito antigo, e as entradas de cache antigas seguem valendo.
 *
 * Determinista: ordem fixa dos campos, sem JSON.stringify (que depende da ordem
 * de insercao das chaves).
 */
export function contextCacheSuffix(ctx: ProductSuggestContext): string {
  if (isContextEmpty(ctx)) return "";
  const parts = CONTEXT_FIELDS.map((f) => {
    const v = ctx[f];
    if (v === undefined || v === null) return "";
    // A descricao pode ser enorme; entra so o comeco normalizado, que e o que
    // carrega o tipo de peca. Evita chave de cache de 4 KB.
    const s = String(v).trim().toLowerCase();
    return f === "description" ? s.slice(0, 120) : s;
  });
  return `::${parts.join("|")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coerencia de qualificador
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Eixos de qualificadores mutuamente exclusivos. Se o titulo afirma um valor do
 * eixo e o candidato afirma OUTRO, e contradicao direta — bloqueia.
 */
const QUALIFIER_AXES: Array<{
  axis: string;
  values: Record<string, string[]>;
}> = [
  {
    axis: "profundidade",
    values: {
      interno: ["interno", "interna", "internos", "internas"],
      externo: [
        "externo",
        "externa",
        "externos",
        "externas",
        "lateral",
        "laterais",
      ],
    },
  },
  {
    axis: "eixo",
    values: {
      dianteiro: [
        "dianteiro",
        "dianteira",
        "dianteiros",
        "dianteiras",
        "frontal",
      ],
      traseiro: ["traseiro", "traseira", "traseiros", "traseiras"],
    },
  },
  {
    axis: "lado",
    values: {
      esquerdo: ["esquerdo", "esquerda"],
      direito: ["direito", "direita"],
    },
  },
  {
    axis: "altura",
    values: {
      superior: ["superior", "superiores"],
      inferior: ["inferior", "inferiores"],
    },
  },
];

/**
 * Qualificadores MARCADOS: quando o candidato os carrega, o titulo precisa
 * sustenta-los explicitamente. "Retrovisor" sozinho e o lateral (o espelho da
 * porta), nunca o interno — foi o erro numero 1 da matriz, 22 ocorrencias.
 */
const MARKED_QUALIFIERS = new Set([
  "interno",
  "interna",
  "internos",
  "internas",
  "fusivel",
  "fusiveis",
]);

export type CoherenceVerdict = "ok" | "penalize" | "block";

function valueOnAxis(
  tokens: Set<string>,
  axis: (typeof QUALIFIER_AXES)[number],
): string | null {
  for (const [value, terms] of Object.entries(axis.values)) {
    if (terms.some((t) => tokens.has(t))) return value;
  }
  return null;
}

/**
 * O candidato e coerente com o titulo?
 *
 *  - "block"    : titulo e candidato afirmam valores OPOSTOS do mesmo eixo
 *                 (titulo "lateral" x candidato "interno").
 *  - "penalize" : o candidato carrega um qualificador marcado que o titulo nao
 *                 menciona (candidato "internos" x titulo so "retrovisor").
 *  - "ok"       : nada a objetar.
 *
 * Recebe tokens JA normalizados. `candidateTokens` deve vir do NOME DA FOLHA,
 * nao do caminho inteiro — o caminho carrega qualificadores dos ancestrais que
 * nao qualificam a folha.
 */
export function coherenceVerdict(
  titleTokens: Set<string>,
  candidateTokens: Set<string>,
): CoherenceVerdict {
  let penalize = false;

  for (const axis of QUALIFIER_AXES) {
    const inTitle = valueOnAxis(titleTokens, axis);
    const inCandidate = valueOnAxis(candidateTokens, axis);
    if (inTitle && inCandidate && inTitle !== inCandidate) return "block";
    if (!inTitle && inCandidate) {
      const marked = axis.values[inCandidate].some(
        (t) => MARKED_QUALIFIERS.has(t) && candidateTokens.has(t),
      );
      if (marked) penalize = true;
    }
  }

  for (const t of candidateTokens) {
    if (MARKED_QUALIFIERS.has(t) && !titleTokens.has(t)) penalize = true;
  }

  return penalize ? "penalize" : "ok";
}

/** Fator aplicado a score e confidence quando o veredito e "penalize". */
export const COHERENCE_PENALTY = 0.45;

// ─────────────────────────────────────────────────────────────────────────────
// Calibragem do auto-aplicar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Auto-aplicar categoria errada e pior do que nao auto-aplicar: o lojista
 * publica no lugar errado sem perceber. O baseline auto-aplicava em 366 de 400
 * casos do gabarito humano — e errava em todos os 366.
 *
 * A regra antiga (`confidence >= 0.65 && signalCount >= 2`) dispara com dois
 * sinais fracos quaisquer. A nova exige convergencia real e nunca auto-aplica
 * candidato que a coerencia reprovou.
 */
export const AUTO_APPLY_MIN_CONFIDENCE_V2 = 0.8;
export const AUTO_APPLY_MIN_SIGNALS_V2 = 3;
/** Com 2 sinais so, a confianca precisa ser alta o bastante para compensar. */
export const AUTO_APPLY_TWO_SIGNAL_CONFIDENCE_V2 = 0.9;

export function shouldAutoApplyV2(input: {
  confidence: number;
  signalCount: number;
  coherence: CoherenceVerdict;
}): boolean {
  if (input.coherence !== "ok") return false;
  if (input.confidence < AUTO_APPLY_MIN_CONFIDENCE_V2) return false;
  if (input.signalCount >= AUTO_APPLY_MIN_SIGNALS_V2) return true;
  return (
    input.signalCount >= 2 &&
    input.confidence >= AUTO_APPLY_TWO_SIGNAL_CONFIDENCE_V2
  );
}
