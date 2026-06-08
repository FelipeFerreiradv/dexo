/**
 * Tokenização e expansão de sinônimos para a busca de peças.
 *
 * Por que existe: a busca tratava a frase inteira como uma única string e
 * combinava os campos com OR — qualquer campo isolado parecido com a frase
 * inteira já trazia o produto. Resultado: "fecha tras esq palio" trazia todo
 * produto de modelo Palio (via similarity do model) somado a toda "fechadura
 * traseira esquerda" de qualquer veículo. Aqui quebramos a frase em termos,
 * expandimos abreviações do setor de autopeças e devolvemos GRUPOS de
 * variantes; o repositório exige que CADA grupo case em algum campo (AND).
 */

/** Remove acentos, baixa caixa e apara espaços. */
export function normalizeTerm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Conectivos sem valor de busca. Mantemos curto e conservador: só palavras
 * que nunca discriminam uma peça (preposições, artigos, "lado"). NÃO incluir
 * termos de posição como "traseira/esquerda" — esses são justamente o que
 * precisa casar.
 */
export const STOPWORDS = new Set<string>([
  "de",
  "da",
  "do",
  "das",
  "dos",
  "e",
  "ou",
  "com",
  "sem",
  "para",
  "pra",
  "p",
  "a",
  "o",
  "as",
  "os",
  "em",
  "no",
  "na",
  "nos",
  "nas",
  "um",
  "uma",
  "lado",
]);

/**
 * Abreviação/forma-curta → formas que efetivamente aparecem nos dados.
 * A chave já está normalizada (sem acento, minúscula). O próprio token é
 * sempre incluído como variante (ver `expandToken`), então aqui só listamos
 * as formas ADICIONAIS. Extensível: acrescentar entradas conforme o vocábulo
 * real do catálogo for surgindo.
 */
export const SYNONYMS: Record<string, string[]> = {
  // tipo de peça (abreviações comuns de anúncio)
  fecha: ["fechadura"],
  fech: ["fechadura"],
  retrov: ["retrovisor"],
  retr: ["retrovisor"],
  amort: ["amortecedor"],
  susp: ["suspensao"],
  paralma: ["paralama"],
  paralam: ["paralama"],
  parab: ["parabrisa", "para-brisa"],
  macaneta: ["maçaneta"],

  // posição: dianteira / traseira (entradas full-word são bidirecionais de
  // gênero para casar "dianteira" com "dianteiro" etc.)
  diant: ["dianteira", "dianteiro"],
  dianteir: ["dianteira", "dianteiro"],
  dianteira: ["dianteiro"],
  dianteiro: ["dianteira"],
  dt: ["dianteira", "dianteiro"],
  tras: ["traseira", "traseiro"],
  traz: ["traseira", "traseiro"],
  traseir: ["traseira", "traseiro"],
  traseira: ["traseiro"],
  traseiro: ["traseira"],
  tr: ["traseira", "traseiro"],

  // posição: esquerda / direita (inclui LE/LD = lado esquerdo/direito)
  esq: ["esquerda", "esquerdo"],
  esquerd: ["esquerda", "esquerdo"],
  esquerda: ["esquerdo"],
  esquerdo: ["esquerda"],
  le: ["esquerda", "esquerdo"],
  dir: ["direita", "direito"],
  direit: ["direita", "direito"],
  direita: ["direito"],
  direito: ["direita"],
  ld: ["direita", "direito"],

  // posição: superior / inferior
  sup: ["superior"],
  superio: ["superior"],
  inf: ["inferior"],
  inferio: ["inferior"],
};

/**
 * Expande um token normalizado em seu grupo de variantes (sempre inclui o
 * próprio token). Variantes são normalizadas para casar contra
 * `immutable_unaccent(lower(campo))` no SQL.
 */
function expandToken(token: string): string[] {
  const variants = new Set<string>([token]);
  const extra = SYNONYMS[token];
  if (extra) {
    for (const v of extra) variants.add(normalizeTerm(v));
  }
  return Array.from(variants);
}

/**
 * Otimização provavelmente-equivalente: remove variantes redundantes para um
 * `ILIKE '%v%'`. Se uma variante mais curta é substring de outra, o `%curta%`
 * já casa tudo que o `%longa%` casaria — então `[tras, traseira, traseiro]`
 * vira `[tras]` (45→20 condições no caso "fecha tras esq palio"). Como o
 * token original sempre entra no grupo, o conjunto de resultados é idêntico;
 * só diminui o trabalho do Postgres. Nunca esvazia o grupo (guarda no fim).
 */
export function reduceVariants(variants: string[]): string[] {
  const reduced = variants.filter(
    (v) =>
      !variants.some(
        (other) => other !== v && other.length < v.length && v.includes(other),
      ),
  );
  return reduced.length > 0 ? reduced : variants;
}

/** Limite defensivo de termos por busca — evita predicados gigantes em colagens absurdas. */
export const MAX_TOKEN_GROUPS = 10;

/**
 * Quebra a busca em grupos de variantes (AND entre grupos, OR dentro do
 * grupo). Remove stopwords e tokens com menos de 2 caracteres. Tokens
 * numéricos (ano, número de peça) são preservados.
 *
 * Ex.: "fecha tras esq palio" →
 *   [["fecha","fechadura"], ["tras","traseira","traseiro"],
 *    ["esq","esquerda","esquerdo"], ["palio"]]
 */
export function tokenizeSearch(search: string): string[][] {
  const normalized = normalizeTerm(search ?? "");
  if (!normalized) return [];

  const rawTokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);

  const groups: string[][] = [];
  for (const token of rawTokens) {
    if (token.length < 2) continue;
    if (STOPWORDS.has(token)) continue;
    groups.push(expandToken(token));
    if (groups.length >= MAX_TOKEN_GROUPS) break;
  }
  return groups;
}
