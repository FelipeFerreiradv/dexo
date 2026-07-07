// Núcleo PURO (sem React/DOM) do combobox de localização: tipo do item e o
// filtro tolerante. Mantido separado do componente para ser testável em
// ambiente node (sem jsdom) — o componente importa daqui.

import { matchesTokens, tokenize } from "@/app/localizacoes/lib/search-utils";

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

/**
 * Filtra as opções por código, descrição e caminho completo, tolerante a
 * caixa/acento/substring e múltiplos termos (AND entre tokens, OR entre
 * campos), reutilizando os utilitários de busca da aba Localizações. Query
 * vazia devolve as primeiras `max` opções (sem filtro).
 */
export function filterLocationOptions(
  options: LocationSelectItem[],
  query: string,
  max: number = LOCATION_SELECT_MAX_RESULTS,
): LocationSelectItem[] {
  const tokens = tokenize(query);
  const result = options.filter((loc) =>
    matchesTokens(tokens, {
      code: loc.code,
      description: loc.description,
      fullPath: loc.fullPath,
    }),
  );
  return result.slice(0, max);
}
