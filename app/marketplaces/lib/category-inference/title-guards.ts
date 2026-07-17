/**
 * Guards PUROS de título para a inferência de categoria — compartilhados pelo
 * engine (ML/Shopee) e pela resolução Magalu. Vêm de casos reais da validação
 * com 800 produtos: "REATOR farol" vende reator, não farol; "Lanterna TAMPA
 * Voyage" é a lanterna da tampa (folha própria), não Faróis Traseiros.
 */

import { normalizeText } from "../title-parse";
import { AMBIGUOUS_LABELS } from "./map-generation";

/**
 * Palavras de COMPONENTE que o PART_TYPES não conhece: quando presentes, o
 * tipo extraído é o da peça-MÃE, não do que está à venda.
 */
const COMPONENT_BLOCKERS = [
  "dobradica",
  "parafuso",
  "reator",
  "cinta",
  "moldura",
  "engrenagem",
  "interruptor",
  "reparo",
  "carcaca",
];

/**
 * true quando o título é COMPOSTO demais para a inferência votar com
 * segurança: contém palavra de componente desconhecida do vocabulário, ou um
 * label ambíguo ("tampa", "caixa") fora do próprio tipo extraído.
 */
export function isCompoundTitle(title: string, partTypeFolded: string): boolean {
  const tokens = normalizeText(title).split(/[^a-z0-9]+/);
  for (const token of tokens) {
    if (token.length < 4) continue;
    for (const blocker of COMPONENT_BLOCKERS) {
      if (token.startsWith(blocker)) return true;
    }
    for (const ambiguous of AMBIGUOUS_LABELS) {
      if (
        token.startsWith(ambiguous) &&
        token.length - ambiguous.length <= 2 &&
        !partTypeFolded.includes(ambiguous)
      )
        return true;
    }
  }
  return false;
}
