// Núcleo PURO (sem React/DOM) do combobox de localização: tipo do item, o
// filtro tolerante e o RANQUEAMENTO por relevância. Mantido separado do
// componente para ser testável em ambiente node (sem jsdom) — o componente
// importa daqui.

import { normalizeText, tokenize } from "@/app/localizacoes/lib/search-utils";

/** Shape de cada opção vinda de `GET /locations/select`. */
export interface LocationSelectItem {
  id: string;
  code: string;
  description?: string;
  fullPath: string;
  maxCapacity: number;
  productsCount: number;
  isFull: boolean;
}

// A base por usuário costuma ser pequena, mas capamos o render por busca para
// manter o combobox leve mesmo com centenas de localizações. O corte acontece
// DEPOIS do ranqueamento: enquanto ele caía na ordem alfabética de `fullPath`
// (a que o backend devolve), buscar "Galpão 2" gastava as 50 vagas com os
// descendentes de "Galpão 1" que têm um "2" no caminho ("Galpão 1 > Prateleira
// 2", "Galpão 1 > A12"…) e o próprio "Galpão 2" nunca era alcançado.
export const LOCATION_SELECT_MAX_RESULTS = 50;

/**
 * Opção + campos normalizados, pré-computados UMA vez por lista de opções.
 * - `haystack` decide QUEM casa (semântica inalterada).
 * - `code`/`path`/`depth` decidem apenas a ORDEM.
 */
export interface LocationSearchEntry {
  item: LocationSelectItem;
  haystack: string;
  /**
   * `code` normalizado — o nome PRÓPRIO do nó. É também o último segmento do
   * caminho: `listForSelect` monta `fullPath` empilhando o próprio código e
   * subindo pelos pais (`parts.unshift`), então o "self" fica no fim.
   */
  code: string;
  /** `fullPath` normalizado (ancestrais + o próprio código). */
  path: string;
  /** Profundidade: 1 = raiz. Conta os segmentos " > " do caminho. */
  depth: number;
}

/**
 * Pré-normaliza os campos buscáveis de cada opção UMA vez. Como eles dependem
 * só da opção (não da query), memoizar isto por `options` evita re-normalizar
 * (NFD/acento) tudo a cada tecla no combobox — inclusive para o ranqueamento,
 * que por isso NÃO reusa `scoreMatch` de `search-utils` (ela re-normaliza a
 * cada chamada e é contrato compartilhado com a árvore de /localizacoes).
 */
export function buildLocationSearchIndex(
  options: LocationSelectItem[],
): LocationSearchEntry[] {
  return options.map((item) => {
    const code = normalizeText(item.code);
    const path = normalizeText(item.fullPath);
    return {
      item,
      code,
      path,
      depth: path.length === 0 ? 0 : path.split(" > ").length,
      // Une os campos por espaço: como os tokens são palavras sem espaço,
      // `haystack.includes(token)` casa sse o token está em ALGUM campo — sem
      // falso-positivo cruzando a fronteira (o separador é espaço).
      haystack: code + " " + normalizeText(item.description) + " " + path,
    };
  });
}

// Camadas de relevância (menor = melhor). Elas NÃO alteram o conjunto que casa
// (isso continua sendo só o `haystack`) — mudam apenas a ordem e, portanto,
// quais `max` sobrevivem ao corte.
const RANK_CODE_EXACT = 0; // o código É a query          → "Galpão 2"
const RANK_CODE_PREFIX = 1; // o código começa com a query → "Galpão" acha as 2 raízes
const RANK_CODE_PHRASE = 2; // o código contém a query
const RANK_CODE_TOKENS = 3; // todos os tokens no código, fora de ordem
const RANK_PATH_PHRASE = 4; // o caminho contém a query    → descendentes de "Galpão 2"
const RANK_LOOSE = 5; // tokens espalhados pelo caminho/descrição

/**
 * Relevância de um item JÁ casado (menor = melhor). `phrase` é a query
 * normalizada (os tokens juntos por espaço) e `tokens` são os mesmos do match:
 * nada é normalizado aqui dentro.
 */
function rankEntry(
  entry: LocationSearchEntry,
  phrase: string,
  tokens: string[],
): number {
  const { code, path } = entry;
  if (code === phrase) return RANK_CODE_EXACT;
  if (code.startsWith(phrase)) return RANK_CODE_PREFIX;
  if (code.includes(phrase)) return RANK_CODE_PHRASE;
  if (tokens.every((t) => code.includes(t))) return RANK_CODE_TOKENS;
  if (path.includes(phrase)) return RANK_PATH_PHRASE;
  return RANK_LOOSE;
}

/**
 * Filtra o índice pré-normalizado e ordena por relevância. O MATCH é idêntico
 * ao anterior (`matchesTokens`: AND entre tokens, OR entre campos, tolerante a
 * caixa/acento/substring) — o conjunto de itens que casa NÃO muda. O que muda é
 * a ORDEM e, com ela, quais itens sobrevivem ao cap. Query vazia devolve as
 * primeiras `max` opções na ordem original, sem ranquear.
 */
export function filterLocationIndex(
  index: LocationSearchEntry[],
  query: string,
  max: number = LOCATION_SELECT_MAX_RESULTS,
): LocationSelectItem[] {
  const tokens = tokenize(query);

  // Query vazia/em branco: caminho ORIGINAL, intocado — as primeiras `max`
  // opções na ordem em que vieram do backend (fullPath alfabético). Sem query
  // não existe relevância a medir, e ranquear aqui embaralharia a hierarquia
  // (com `tokens` vazio, `code.startsWith("")` é true para TODO mundo).
  if (tokens.length === 0) {
    const head: LocationSelectItem[] = [];
    for (const entry of index) {
      head.push(entry.item);
      if (head.length >= max) break;
    }
    return head;
  }

  // `tokenize` já normalizou; juntar por espaço reconstrói `normalizeText(query)`
  // sem uma segunda passada de NFD.
  const phrase = tokens.join(" ");

  // 1) MATCH — predicado IDÊNTICO ao anterior. Sem `break` aqui: cortar ANTES
  //    de ranquear é exatamente o bug.
  const matched: Array<{ entry: LocationSearchEntry; rank: number }> = [];
  for (const entry of index) {
    if (tokens.every((t) => entry.haystack.includes(t))) {
      matched.push({ entry, rank: rankEntry(entry, phrase, tokens) });
    }
  }

  // 2) RANQUEIA — `Array.prototype.sort` é estável desde a ES2019, então
  //    empates de (rank, depth) preservam a ordem de `index`, que é a do
  //    backend (`fullPath.localeCompare`). Profundidade menor primeiro: com
  //    relevância textual igual, o container é a intenção mais provável e o
  //    filho fica logo abaixo. É esse desempate que conserta a busca de um
  //    token só ("2"), onde "Galpão 2" e "Galpão 1 > A12" empatam no rank.
  matched.sort((a, b) => a.rank - b.rank || a.entry.depth - b.entry.depth);

  // 3) CORTA — só agora, sobre a lista já ordenada por relevância. Mesmo laço
  //    push/break de antes (preserva inclusive o comportamento degenerado de
  //    `max <= 0`, que devolvia 1 item).
  const out: LocationSelectItem[] = [];
  for (const m of matched) {
    out.push(m.entry.item);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Quantos itens CASAM a query, ignorando o cap. Serve para avisar que a lista
 * foi truncada ("mostrando 50 de 601") — depois do #268 os 50 exibidos são os
 * mais relevantes, mas o corte continuava silencioso.
 *
 * O predicado é o MESMO de `filterLocationIndex` (e a query vazia devolve o
 * índice inteiro, como lá). Duplicar a condição é o preço de não alocar nem
 * ordenar só para contar — há teste amarrando as duas ao mesmo conjunto para
 * que uma não derive da outra.
 */
export function countLocationMatches(
  index: LocationSearchEntry[],
  query: string,
): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) return index.length;

  let total = 0;
  for (const entry of index) {
    if (tokens.every((t) => entry.haystack.includes(t))) total++;
  }
  return total;
}

/**
 * Conveniência: constrói o índice e filtra numa passada. Mantida para uso onde
 * `options` não é estável/memoizado (e para os testes).
 */
export function filterLocationOptions(
  options: LocationSelectItem[],
  query: string,
  max: number = LOCATION_SELECT_MAX_RESULTS,
): LocationSelectItem[] {
  return filterLocationIndex(buildLocationSearchIndex(options), query, max);
}
