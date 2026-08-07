// O registry COMPLETO — o que o orquestrador enxerga.
//
// A ordem é o desempate da seleção por palavra-chave (tools/select.ts) e a
// ordem em que o modelo vê o cardápio. Leitura vem antes de consultiva de
// propósito: quando a pergunta é ambígua ("e o farol do palio?"), consultar o
// que a loja TEM é sempre uma resposta melhor do que recomendar o que ela
// PODERIA cobrar.

import { ADVISORY_TOOLS } from "./advisory";
import { READ_TOOLS } from "./read";
import { buildRegistry, type AiTool } from "./registry";

export const ALL_TOOLS: AiTool[] = [...READ_TOOLS, ...ADVISORY_TOOLS];

let cache: Map<string, AiTool> | null = null;

/**
 * Registry montado uma vez por processo.
 *
 * `buildRegistry` lança em nome duplicado — e é exatamente por juntar dois
 * conjuntos aqui que essa checagem deixa de ser teórica: uma tool consultiva
 * chamada `buscar_produto` faria o modelo pedir uma e receber a outra.
 */
export function getToolRegistry(): Map<string, AiTool> {
  if (!cache) cache = buildRegistry(ALL_TOOLS);
  return cache;
}
