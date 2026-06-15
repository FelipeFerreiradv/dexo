/**
 * Decisão de REAPROVEITAMENTO de número na reemissão de NF-e rejeitada.
 *
 * Regra de ouro fiscal: numa REJEIÇÃO a SEFAZ NÃO consome o número — ele pode e
 * deve ser reaproveitado na nova tentativa, evitando buraco na sequência. Já numa
 * DENEGAÇÃO (cStat 110) ou DUPLICIDADE (204/218/539...) o número/nota foi
 * consumido na SEFAZ e NUNCA pode ser reaproveitado.
 *
 * Como hoje o provider colapsa denegada+rejeitada no mesmo status "rejeitada"
 * (ver sefaz-direct.provider.ts) e o banco não guardava a categoria, a feature
 * passa a persistir o `cStat` da rejeição (campo `cStatRejeicao`). A elegibilidade
 * ao reuso é derivada dele via lookupCStat — só `categoria === "rejeitada"` reaproveita.
 *
 * Toda a feature fica atrás da flag NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED;
 * com a flag desligada o comportamento é idêntico ao atual (sempre reserva número novo).
 */

import { lookupCStat } from "../sefaz/cstat-mapper";

/**
 * Lê a flag em TEMPO DE CHAMADA (não no load do módulo) para que testes possam
 * usar vi.stubEnv e para refletir o valor real no runtime do Fastify.
 */
export function isNfeReemissaoRejeitadaEnabled(): boolean {
  return process.env.NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED === "true";
}

export interface ReuseDecisionInput {
  /** Status atual da nota (antes do claim atômico). */
  status: string;
  /** Número da nota. Rascunho novo nasce com placeholder NEGATIVO; REJECTED já enviada tem número positivo real. */
  numero: number;
  /** Ambiente em que o número foi reservado na 1ª tentativa. */
  ambiente: string;
  /** cStat da rejeição persistido (null = legado/desconhecido → tratado conservadoramente). */
  cStatRejeicao: number | null | undefined;
}

/**
 * Decide se a emissão deve REAPROVEITAR o número já reservado em vez de reservar
 * um novo. Retorna true SOMENTE quando todas as condições são satisfeitas:
 *  - flag ligada;
 *  - nota está REJECTED (reemissão após correção);
 *  - já tem número positivo (não é rascunho novo);
 *  - mesmo ambiente da reserva original (troca homolog↔prod → reserva novo);
 *  - rejeição "reaproveitável" (cStat conhecido E categoria === "rejeitada",
 *    isto é, NÃO denegada/duplicidade/etc).
 *
 * Função pura: não toca banco, env nem serviços — a flag entra por parâmetro.
 */
export function shouldReuseNumero(
  draft: ReuseDecisionInput,
  ambienteAtual: string,
  flagOn: boolean,
): boolean {
  if (!flagOn) return false;
  if (draft.status !== "REJECTED") return false;
  if (!(draft.numero > 0)) return false;
  if (draft.ambiente !== ambienteAtual) return false;
  if (draft.cStatRejeicao == null) return false;
  return lookupCStat(draft.cStatRejeicao).categoria === "rejeitada";
}
