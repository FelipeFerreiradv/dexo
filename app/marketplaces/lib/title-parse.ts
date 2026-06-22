/**
 * Parser determinístico de título de peça → entidades + chave de agrupamento.
 *
 * Módulo PURO (sem DB) compartilhado pelo job noturno (scripts/build-catalog-stats.ts)
 * e pelo endpoint GET /marketplace/internal/suggest. Consistência por construção:
 * ambos derivam `partType` e as colunas de lookup pela MESMA função, então a chave
 * gravada pelo job e a chave consultada pelo endpoint sempre alinham.
 *
 * Reaproveita infra existente:
 *  - `parseTitleToFields` + `BRANDS` de app/lib/product-parser.ts (marca/modelo/ano).
 *  - A mesma regex de ano (/\b(19|20)\d{2}\b/) do ml-catalog-suggestion.usecase
 *    (re-implementada aqui; tests/title-parse.spec.ts garante paridade).
 *
 * partType vem de um vocabulário curado de tipos de peça (o `pieceType` do
 * CategorySuggestionService é apenas o primeiro token de alias que casou — ruidoso
 * demais para agrupar). A posição (dianteiro/traseiro/esquerdo/...) é dobrada
 * dentro do partType porque muda a peça (ex.: "cubo-de-roda-dianteiro").
 */

import { BRANDS, parseTitleToFields } from "@/app/lib/product-parser";

// ──────────────────────────────────────────────────────────────────────────
// Normalização (o funil único)
// ──────────────────────────────────────────────────────────────────────────

// Marcas diacríticas combinantes (acentos) que sobram após normalize("NFD").
// Construída via RegExp para manter o fonte 100% ASCII.
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

/** NFD strip-acento + lowercase + colapsa espaços + trim. */
export function normalizeText(input?: string | null): string {
  if (typeof input !== "string") return "";
  return input
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** normalizeText e depois kebab: tudo que não é [a-z0-9] vira "-", colapsa repetições. */
export function kebab(input?: string | null): string {
  const n = normalizeText(input);
  return n
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Stopwords removidas antes do casamento de frases (espelha o espírito do
// STOPWORDS do CategorySuggestionService, mantido aqui para o módulo ser puro).
const STOPWORDS = new Set([
  "de",
  "da",
  "do",
  "das",
  "dos",
  "para",
  "pra",
  "por",
  "com",
  "sem",
  "na",
  "no",
  "nas",
  "nos",
  "em",
  "a",
  "o",
  "as",
  "os",
  "e",
  "ou",
  "um",
  "uma",
  "peca",
  "kit",
]);

// Palavras compostas: formas que devem ser unidas ANTES da remoção de stopwords
// (ex.: "para-choque" / "para choque" → "parachoque"), senão "para" some como
// stopword. Aplicadas no texto normalizado com hífen já virado espaço.
const COMPOUND_WORDS: Array<[RegExp, string]> = [
  [/\bpara\s?choques?\b/g, "parachoque"],
  [/\bpara\s?lamas?\b/g, "paralama"],
  [/\bpara\s?brisas?\b/g, "parabrisa"],
  [/\bpara\s?sol\b/g, "parasol"],
  [/\bpara\s?barros?\b/g, "parabarro"],
  [/\bpara\s?lamas?\b/g, "paralama"],
  [/\bsemi\s?eixos?\b/g, "semieixo"],
  [/\bbomba\s?d?\s?agua\b/g, "bombadagua"],
];

/** Texto normalizado, hífen→espaço, compostos unidos e SEM stopwords isoladas. */
export function stripStopwords(input?: string | null): string {
  let t = normalizeText(input).replace(/-/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, rep] of COMPOUND_WORDS) t = t.replace(re, rep);
  return t
    .split(" ")
    .filter((tok) => tok.length > 0 && !STOPWORDS.has(tok))
    .join(" ");
}

// ──────────────────────────────────────────────────────────────────────────
// Ano (mesma regex do ml-catalog-suggestion.usecase — paridade testada)
// ──────────────────────────────────────────────────────────────────────────

const MIN_YEAR = 1900;
const MAX_YEAR = 2100; // teto defensivo; o job aplica o teto fino (ano atual + 2)

/** Primeiro ano de 4 dígitos (19xx/20xx) no texto, ou null. */
export function parseYearToNumber(raw?: string | null): number | null {
  if (!raw) return null;
  const match = raw.match(/\b(19|20)\d{2}\b/);
  if (!match) return null;
  const n = parseInt(match[0], 10);
  if (!Number.isFinite(n) || n < MIN_YEAR || n > MAX_YEAR) return null;
  return n;
}

/** Faixa {from,to} = min/max de TODOS os anos de 4 dígitos no texto. */
export function parseYearRange(raw?: string | null): {
  from: number | null;
  to: number | null;
} {
  if (!raw) return { from: null, to: null };
  const matches = Array.from(raw.matchAll(/\b(19|20)\d{2}\b/g))
    .map((m) => parseInt(m[0], 10))
    .filter((n) => Number.isFinite(n) && n >= MIN_YEAR && n <= MAX_YEAR);
  if (matches.length === 0) return { from: null, to: null };
  return { from: Math.min(...matches), to: Math.max(...matches) };
}

// ──────────────────────────────────────────────────────────────────────────
// Posição (dianteiro/traseiro/lateral + lado) — dobrada dentro do partType
// ──────────────────────────────────────────────────────────────────────────

// Cada grupo é mutuamente exclusivo; capturamos no máximo um de cada e juntamos
// em ordem canônica (eixo → lado → altura) para distinguir a peça.
const POSITION_GROUPS: Array<{ canonical: string; terms: string[] }> = [
  // Eixo
  {
    canonical: "dianteiro",
    terms: ["dianteiro", "dianteira", "diant", "frontal", "frente"],
  },
  { canonical: "traseiro", terms: ["traseiro", "traseira", "tras", "traz"] },
  // Lado
  {
    canonical: "esquerdo",
    terms: ["esquerdo", "esquerda", "esq", "le", "motorista"],
  },
  {
    canonical: "direito",
    terms: ["direito", "direita", "dir", "ld", "passageiro", "carona"],
  },
  // Altura
  { canonical: "superior", terms: ["superior", "cima", "alto"] },
  { canonical: "inferior", terms: ["inferior", "baixo", "fundo"] },
];

/** Posição canônica (ex.: "dianteiro-esquerdo") presente no texto, ou null. */
export function extractPosition(text?: string | null): string | null {
  const tokens = new Set(normalizeText(text).replace(/-/g, " ").split(" "));
  const found: string[] = [];
  for (const group of POSITION_GROUPS) {
    if (group.terms.some((t) => tokens.has(t))) found.push(group.canonical);
  }
  return found.length > 0 ? found.join("-") : null;
}

// ──────────────────────────────────────────────────────────────────────────
// Vocabulário de tipo de peça (curado). Frases em forma normalizada SEM
// stopwords; `label` é o kebab canônico (display/chave). Frases mais longas têm
// prioridade (casamento longest-first) para preferir o tipo mais específico.
// ──────────────────────────────────────────────────────────────────────────

const PART_TYPES: Array<{ label: string; phrases: string[] }> = [
  // Carroceria / lataria
  { label: "parachoque", phrases: ["parachoque", "para choque"] },
  { label: "paralama", phrases: ["paralama", "para lama"] },
  { label: "parabrisa", phrases: ["parabrisa", "para brisa"] },
  { label: "grade", phrases: ["grade", "grade dianteira", "grade radiador"] },
  { label: "capo", phrases: ["capo"] },
  { label: "porta", phrases: ["porta"] },
  {
    label: "tampa-traseira",
    phrases: ["tampa traseira", "porta malas", "tampa porta malas"],
  },
  { label: "retrovisor", phrases: ["retrovisor", "espelho retrovisor"] },
  { label: "macaneta", phrases: ["macaneta", "puxador porta"] },
  { label: "lanterna", phrases: ["lanterna"] },
  {
    label: "farol-de-milha",
    phrases: ["farol milha", "farol neblina", "farol auxiliar"],
  },
  { label: "farol", phrases: ["farol"] },
  { label: "spoiler", phrases: ["spoiler", "aerofolio"] },
  { label: "friso", phrases: ["friso", "moldura"] },
  { label: "soleira", phrases: ["soleira"] },
  { label: "emblema", phrases: ["emblema", "logo", "logotipo"] },
  { label: "calota", phrases: ["calota"] },
  { label: "roda", phrases: ["roda", "aro"] },
  // Vidros
  { label: "vidro", phrases: ["vidro"] },
  {
    label: "maquina-de-vidro",
    phrases: ["maquina vidro", "maquina de vidro", "motor vidro"],
  },
  // Suspensão / direção
  { label: "amortecedor", phrases: ["amortecedor"] },
  { label: "mola", phrases: ["mola", "mola suspensao"] },
  { label: "bandeja", phrases: ["bandeja", "balanca"] },
  { label: "pivo", phrases: ["pivo"] },
  { label: "bieleta", phrases: ["bieleta"] },
  { label: "batente", phrases: ["batente", "kit batente"] },
  { label: "coifa", phrases: ["coifa"] },
  { label: "bucha", phrases: ["bucha", "bucha bandeja"] },
  { label: "cubo-de-roda", phrases: ["cubo roda", "cubo de roda", "cubo"] },
  { label: "rolamento", phrases: ["rolamento", "rolamento roda"] },
  { label: "terminal-de-direcao", phrases: ["terminal direcao", "terminal"] },
  { label: "caixa-de-direcao", phrases: ["caixa direcao", "caixa de direcao"] },
  { label: "ponta-de-eixo", phrases: ["ponta eixo", "ponta de eixo"] },
  { label: "semieixo", phrases: ["semieixo", "semi eixo"] },
  { label: "homocinetica", phrases: ["homocinetica", "junta homocinetica"] },
  // Freio
  { label: "disco-de-freio", phrases: ["disco freio", "disco de freio"] },
  {
    label: "pastilha-de-freio",
    phrases: ["pastilha freio", "pastilha de freio", "pastilha"],
  },
  {
    label: "pinca-de-freio",
    phrases: ["pinca freio", "pinca de freio", "pinca"],
  },
  {
    label: "cilindro-de-freio",
    phrases: ["cilindro freio", "cilindro mestre"],
  },
  { label: "tambor-de-freio", phrases: ["tambor freio", "tambor"] },
  { label: "freio", phrases: ["freio"] },
  // Motor / transmissão
  { label: "motor", phrases: ["motor"] },
  { label: "cabecote", phrases: ["cabecote"] },
  { label: "bloco-motor", phrases: ["bloco motor", "bloco"] },
  { label: "biela", phrases: ["biela"] },
  { label: "pistao", phrases: ["pistao"] },
  { label: "virabrequim", phrases: ["virabrequim"] },
  {
    label: "comando-de-valvulas",
    phrases: ["comando valvulas", "comando de valvulas", "comando"],
  },
  { label: "valvula", phrases: ["valvula"] },
  { label: "junta", phrases: ["junta", "junta cabecote"] },
  { label: "carter", phrases: ["carter"] },
  {
    label: "coletor",
    phrases: ["coletor", "coletor admissao", "coletor escape"],
  },
  { label: "turbo", phrases: ["turbo", "turbina"] },
  { label: "embreagem", phrases: ["embreagem", "kit embreagem"] },
  { label: "cambio", phrases: ["cambio", "caixa cambio", "transmissao"] },
  { label: "diferencial", phrases: ["diferencial"] },
  { label: "coxim", phrases: ["coxim", "coxim motor", "calco motor"] },
  // Arrefecimento / escape
  { label: "radiador", phrases: ["radiador"] },
  { label: "ventoinha", phrases: ["ventoinha", "eletroventilador"] },
  { label: "mangueira", phrases: ["mangueira"] },
  {
    label: "valvula-termostatica",
    phrases: ["valvula termostatica", "termostatica"],
  },
  { label: "bomba-dagua", phrases: ["bomba dagua", "bomba agua"] },
  { label: "escapamento", phrases: ["escapamento", "silencioso"] },
  { label: "catalisador", phrases: ["catalisador"] },
  { label: "intercooler", phrases: ["intercooler"] },
  // Elétrica
  { label: "alternador", phrases: ["alternador"] },
  {
    label: "motor-de-arranque",
    phrases: ["motor arranque", "motor de arranque", "motor partida"],
  },
  { label: "bobina", phrases: ["bobina", "bobina ignicao"] },
  { label: "sensor", phrases: ["sensor"] },
  { label: "modulo", phrases: ["modulo", "central"] },
  { label: "vela", phrases: ["vela", "vela ignicao"] },
  { label: "chicote", phrases: ["chicote"] },
  { label: "rele", phrases: ["rele"] },
  { label: "bateria", phrases: ["bateria"] },
  // Combustível / filtros
  {
    label: "bomba-de-combustivel",
    phrases: ["bomba combustivel", "bomba de combustivel"],
  },
  { label: "bico-injetor", phrases: ["bico injetor", "injetor"] },
  {
    label: "corpo-de-borboleta",
    phrases: ["corpo borboleta", "corpo de borboleta", "tbi"],
  },
  {
    label: "filtro",
    phrases: ["filtro", "filtro oleo", "filtro ar", "filtro combustivel"],
  },
  // Correia / tensor
  {
    label: "correia",
    phrases: ["correia", "correia dentada", "correia alternador"],
  },
  { label: "tensor", phrases: ["tensor", "tensor correia"] },
  // Interior
  { label: "painel", phrases: ["painel", "painel instrumentos"] },
  { label: "banco", phrases: ["banco", "assento", "encosto"] },
  { label: "volante", phrases: ["volante"] },
  {
    label: "cinto-de-seguranca",
    phrases: ["cinto seguranca", "cinto de seguranca", "cinto"],
  },
  { label: "airbag", phrases: ["airbag", "air bag", "bolsa ar"] },
  { label: "console", phrases: ["console"] },
  { label: "porta-luvas", phrases: ["porta luvas", "portaluvas"] },
];

// Índice plano (frase normalizada+stripada → label) ordenado por nº de palavras
// desc e comprimento desc, para casamento longest-first.
const PART_TYPE_INDEX: Array<{ phrase: string; words: number; label: string }> =
  PART_TYPES.flatMap((pt) =>
    pt.phrases.map((p) => {
      const phrase = stripStopwords(p);
      return { phrase, words: phrase.split(" ").length, label: pt.label };
    }),
  )
    .filter((e) => e.phrase.length > 0)
    .sort((a, b) => b.words - a.words || b.phrase.length - a.phrase.length);

/**
 * Tipo de peça canônico (kebab), com a POSIÇÃO dobrada quando presente
 * (ex.: "cubo-de-roda-dianteiro"). null quando nenhum tipo conhecido casa.
 * Casamento por frase (substring em limites de palavra) no texto normalizado
 * e sem stopwords — robusto a "cubo de roda" vs "cubo roda".
 */
export function extractPartType(text?: string | null): string | null {
  const stripped = stripStopwords(text);
  if (!stripped) return null;
  const padded = ` ${stripped} `;
  let base: string | null = null;
  for (const entry of PART_TYPE_INDEX) {
    if (padded.includes(` ${entry.phrase} `)) {
      base = entry.label;
      break;
    }
  }
  if (!base) return null;
  const position = extractPosition(text);
  return position ? `${base}-${position}` : base;
}

// ──────────────────────────────────────────────────────────────────────────
// Parse completo do título (caminho do ENDPOINT)
// ──────────────────────────────────────────────────────────────────────────

export interface TitleParts {
  /** Tipo de peça já com posição dobrada (kebab), ou null. */
  partType: string | null;
  /** Posição isolada (transparência/depuração). */
  position: string | null;
  /** Marca canônica (ex.: "Fiat"), ou null. */
  brand: string | null;
  /** Modelo heurístico (ex.: "UNO"), ou null. */
  model: string | null;
  /** Versão — não extraída do título livre no MVP (sempre null). */
  version: string | null;
  /** Ano único (4 dígitos), ou null. */
  year: number | null;
}

/** Parse determinístico do título livre para o endpoint. */
export function parseTitleToParts(title: string): TitleParts {
  const fields = parseTitleToFields(title || "");
  return {
    partType: extractPartType(title),
    position: extractPosition(title),
    brand: fields.brand ?? null,
    model: fields.model ?? null,
    version: null,
    year: parseYearToNumber(title),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Colunas de lookup + matchKey (usados por BOTH job e endpoint)
// ──────────────────────────────────────────────────────────────────────────

/** Sentinela usada nas colunas de lookup quando o campo não se aplica. */
export const ANY = "*";

export interface LookupInput {
  partType: string | null;
  brand?: string | null;
  model?: string | null;
  version?: string | null;
}

export interface LookupColumns {
  partType: string;
  brand: string;
  model: string;
  version: string;
}

const col = (v?: string | null): string => {
  const k = kebab(v);
  return k.length > 0 ? k : ANY;
};

/**
 * Colunas normalizadas de lookup. partType já vem kebab/dobrado do extractPartType,
 * mas re-kebabamos por segurança. brand/model/version → kebab ou "*".
 */
export function buildLookupColumns(input: LookupInput): LookupColumns {
  return {
    partType: col(input.partType),
    brand: col(input.brand),
    model: col(input.model),
    version: col(input.version),
  };
}

export interface MatchKeyInput extends LookupInput {
  yearFrom?: number | null;
  yearTo?: number | null;
}

/** Chave canônica "partType|brand|model|version|yearFrom-yearTo" (display/upsert). */
export function buildMatchKey(input: MatchKeyInput): string {
  const c = buildLookupColumns(input);
  const yearSeg =
    input.yearFrom != null || input.yearTo != null
      ? `${input.yearFrom ?? ""}-${input.yearTo ?? ""}`
      : ANY;
  return [c.partType, c.brand, c.model, c.version, yearSeg].join("|");
}
