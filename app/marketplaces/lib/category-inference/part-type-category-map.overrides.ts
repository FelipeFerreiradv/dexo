/**
 * Curadoria MANUAL do mapa tipo-de-peça → categoria. Merge POR CAMPO por cima
 * do arquivo gerado (`part-type-category-map.data.ts`): campo string
 * substitui, campo null REMOVE (mantendo os demais), chave inteira null
 * descarta a entrada gerada. O gerador NUNCA toca este arquivo.
 *
 * Use para: corrigir uma moda errada da base, fixar uma categoria que o gate do
 * gerador rejeitou por amostra pequena, ou remover um lado poluído (ex.:
 * histórico Shopee mal categorizado) preservando o lado bom.
 *
 * Toda entrada abaixo foi conferida contra o fullPath da árvore local
 * sincronizada — o id citado é FOLHA no ramo automotivo correto.
 */

import type { PartTypeCategoryOverride } from "./part-type-category-map";

export const PART_TYPE_CATEGORY_OVERRIDES: Record<
  string,
  PartTypeCategoryOverride | null
> = {
  // ── Shopee: moda histórica poluída → id correto conferido na árvore ──
  // era "Grade de Farol de Milha"; correto: Iluminação > Faróis e Kit Frontal
  farol: { shopee: "102297" },
  // Iluminação > Faróis de Neblina (gerado só tinha o lado ML)
  "farol-de-milha": { shopee: "102299" },
  // era "Grades de Para-choques"; correto: Carroceria > Para-choques
  parachoque: { shopee: "102286" },
  "parachoque-dianteiro": { shopee: "102286" },
  // era "Vidros > Para-brisa Traseiro" (!); correto: Carroceria > Para-choques.
  // ML: a árvore separa por posição e a base não tinha amostra que passasse no
  // gate — folha conferida: Para-choques > Pára-choques Traseiros.
  "parachoque-traseiro": { shopee: "102286", ml: "MLB63586" },
  // era "Alargadores de Paralamas" (acessório); correto: Carroceria > Paralamas
  paralama: { shopee: "102293" },
  // era "Coxins de Amortecedor"; correto: Suspensão e Direção > Amortecedores
  amortecedor: { shopee: "102320" },
  // era "Tampa do Porta-malas do Câmbio"; correto: Transmissão > Câmbio Manual
  cambio: { shopee: "102364" },
  // Carroceria > Maçanetas de Automóveis (gerado só tinha o lado ML)
  macaneta: { shopee: "102291" },
  // era "Vidros > Vidro da Porta"; máquina de vidro = Janela Elétrica de Enrolar
  "maquina-de-vidro-dianteiro-direito": { shopee: "102370" },

  // ── Shopee: moda irrecuperável → remove só o lado Shopee ──
  "macaneta-dianteiro-esquerdo": { shopee: null }, // moda = Tampa do Porta-malas do Câmbio
  "comando-de-valvulas": { shopee: null }, // moda = Ar Condicionado
  painel: { shopee: null }, // moda = Painel da Porta; "painel" aqui é o de instrumentos
  "tampa-de-reservatorio": { shopee: null }, // moda = o reservatório inteiro

  // ── ML: moda semanticamente certa que só perdeu o gate por cauda longa ──
  // (share < 0.5 mas dominância alta; folha conferida na árvore)
  capo: { ml: "MLB101762", source: "manual" }, // Carroceria > Capôs (moda era Dobradiças por viés de título)
  cabecote: { ml: "MLB47127", source: "manual" }, // Motor > Componentes > Tampas > Cabeçotes (23/51, 2º=8)
  escapamento: { ml: "MLB7818", source: "manual" }, // Escapamentos Completos (25/64, 2º=7)
  "porta-luvas": { ml: "MLB432462", source: "manual" }, // Portaluvas Completos (26/77, 2º=10)
};
