// Núcleo PURO (sem React/DOM) do combobox de localização: tipo do item e o
// filtro tolerante. Mantido separado do componente para ser testável em
// ambiente node (sem jsdom) — o componente importa daqui.

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
// manter o combobox leve mesmo com centenas de localizações.
export const LOCATION_SELECT_MAX_RESULTS = 50;

/** Opção + haystack normalizado (código+descrição+caminho), pré-computado. */
export interface LocationSearchEntry {
  item: LocationSelectItem;
  haystack: string;
}

/**
 * Pré-normaliza os campos buscáveis de cada opção UMA vez. Como o haystack
 * depende só dos campos da opção (não da query), memoizar isto por `options`
 * evita re-normalizar (NFD/acento) tudo a cada tecla no combobox.
 */
export function buildLocationSearchIndex(
  options: LocationSelectItem[],
): LocationSearchEntry[] {
  return options.map((item) => ({
    item,
    // Une os campos por espaço: como os tokens são palavras sem espaço,
    // `haystack.includes(token)` casa sse o token está em ALGUM campo — sem
    // falso-positivo cruzando a fronteira (o separador é espaço).
    haystack:
      normalizeText(item.code) +
      " " +
      normalizeText(item.description) +
      " " +
      normalizeText(item.fullPath),
  }));
}

/**
 * Filtra o índice pré-normalizado. Equivale a `matchesTokens` (AND entre
 * tokens, OR entre campos), tolerante a caixa/acento/substring/múltiplos
 * termos. Query vazia devolve as primeiras `max` opções.
 */
export function filterLocationIndex(
  index: LocationSearchEntry[],
  query: string,
  max: number = LOCATION_SELECT_MAX_RESULTS,
): LocationSelectItem[] {
  const tokens = tokenize(query);
  const out: LocationSelectItem[] = [];
  for (const entry of index) {
    if (tokens.every((t) => entry.haystack.includes(t))) {
      out.push(entry.item);
      if (out.length >= max) break;
    }
  }
  return out;
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
