// O registry das tools de LEITURA.
//
// A ordem importa duas vezes: é o desempate da seleção por palavra-chave
// (tools/select.ts) e é a ordem em que o modelo vê o cardápio. As de uso mais
// frequente vêm primeiro.
//
// TODAS são somente leitura. Nenhuma escreve, nenhuma publica, nenhuma apaga —
// e `ai-tools-registry.spec.ts` prova que nenhuma delas sequer aceita um
// argumento de tenant.

import { buildRegistry, type AiTool } from "../registry";
import { buscarProduto, detalheProduto } from "./produtos";
import { buscarLocalizacao } from "./localizacoes";
import { buscarCliente } from "./clientes";
import { buscarPedido } from "./pedidos";
import { buscarSucata, detalheSucata } from "./sucatas";
import { buscarOrcamento, contasAPagar, contasAReceber } from "./financeiro";
import { relatorioEstoque, relatorioVendas } from "./relatorios";
import { diagnosticoOperacional } from "./diagnostico";
import { pendenciasDoCatalogo } from "./catalogo-pendencias";
import { buscaGeral } from "./busca-geral";

export const READ_TOOLS: AiTool[] = [
  buscarProduto,
  detalheProduto,
  buscarPedido,
  contasAReceber,
  contasAPagar,
  relatorioVendas,
  relatorioEstoque,
  buscarSucata,
  detalheSucata,
  buscarCliente,
  buscarLocalizacao,
  buscarOrcamento,
  diagnosticoOperacional,
  pendenciasDoCatalogo,
  // ⭐ POR ÚLTIMO DE PROPÓSITO. A ordem desta lista é o desempate da seleção por
  // palavra-chave: num empate, a busca ESPECÍFICA da área tem de vencer a geral.
  // Quem já disse "acha o pedido 123" merece `buscar_pedido`, com todo o
  // detalhe; a geral existe para quem NÃO sabe o que o código é.
  buscaGeral,
];

let cache: Map<string, AiTool> | null = null;

/**
 * Registry montado uma vez por processo.
 *
 * `buildRegistry` lança em nome duplicado; construir na primeira chamada (e não
 * no topo do módulo) mantém o custo fora do caminho de import de quem só quer o
 * tipo.
 */
export function getReadToolRegistry(): Map<string, AiTool> {
  if (!cache) cache = buildRegistry(READ_TOOLS);
  return cache;
}
