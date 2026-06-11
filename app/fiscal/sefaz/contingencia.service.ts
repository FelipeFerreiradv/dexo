/**
 * Lógica de contingência SEFAZ.
 *
 * Quando a SEFAZ da UF do emitente está fora do ar (paralisação, timeout,
 * erro 5xx persistente), o NT 2014.002 permite emitir via SVC (Sefaz Virtual
 * de Contingência) — SVC-AN (Ambiente Nacional) ou SVC-RS (Sefaz Virtual do
 * Rio Grande do Sul), conforme a UF.
 *
 * Para a NFe ser válida via SVC, o `tpEmis` da chave de acesso muda:
 *   - 1 = Normal (SEFAZ origem)
 *   - 6 = SVC-AN
 *   - 7 = SVC-RS
 *   - 9 = Contingência offline (modo papel; fora do escopo desta fase)
 *
 * Como tpEmis muda, a CHAVE DE ACESSO inteira muda (cDV recalculado). O XML
 * é refeito do zero e re-assinado. Isso é orquestrado pelo provider quando
 * recebe `contingencia` no payload.
 *
 * Decisão de quando entrar em contingência:
 *   - Erro de rede (timeout, ECONNRESET, ENOTFOUND) → fallback OK
 *   - cStat 108/109 (serviço paralisado) → fallback OK
 *   - cStat 280..289 (família infra/comunicação SEFAZ) → fallback OK
 *   - HTTP 5xx após retry → fallback OK
 *   - Rejeição de validação (200+ não-infra) → NÃO fallback (problema no XML)
 *   - Autorizada/duplicidade → NÃO fallback (sucesso)
 */

import type { NfeProviderEmitResult } from "../providers/nfe-provider.interface";
import { SVC_FALLBACK, type UF } from "./endpoints";
import { lookupCStat } from "./cstat-mapper";

export type SvcType = "SVC_AN" | "SVC_RS";

export interface FallbackDecision {
  /**
   * true = seguro reenviar via SVC IMEDIATAMENTE: a SEFAZ origem sinalizou
   * indisponibilidade explicita (cStat 108/109/280-289), o que garante que o
   * lote NAO foi processado.
   */
  shouldFallback: boolean;
  /**
   * true = a emissao falhou por rede/timeout/5xx (status "erro"), em que NAO
   * sabemos se a SEFAZ processou ou nao o lote. O use case DEVE consultar a
   * chave da 1a tentativa antes de decidir reenviar — reenvio cego causaria
   * DUPLA AUTORIZACAO (PRO-3/USE-1). Mutuamente exclusivo com shouldFallback.
   */
  needsConsult: boolean;
  reason: string;
}

/**
 * Decide o que fazer apos uma resposta de emit malsucedida.
 *
 * REGRA DE SEGURANCA (anti dupla-emissao): so autorizamos fallback CEGO para
 * SVC quando a SEFAZ origem disse explicitamente que esta fora (108/109/280-289)
 * — nesse caso o lote comprovadamente nao foi processado. Para erro de
 * rede/timeout/5xx (status "erro"), o lote PODE ter sido autorizado e a
 * resposta se perdido; reenviar via SVC criaria uma 2a NF-e. Por isso
 * sinalizamos needsConsult para o use case consultar a chave antes.
 */
export function shouldFallbackToSvc(
  result: NfeProviderEmitResult,
): FallbackDecision {
  // Sucesso explícito ou pendente — não cair em contingência
  if (result.success && result.status === "autorizada") {
    return { shouldFallback: false, needsConsult: false, reason: "autorizada" };
  }
  if (result.status === "processando") {
    return {
      shouldFallback: false,
      needsConsult: false,
      reason: "processando (reconciliar por consulta, nao por SVC)",
    };
  }

  // Códigos de paralisação / família infra → SEFAZ explicitamente fora, lote
  // NAO processado → SVC imediato e seguro.
  const cStat = result.codigoStatus ?? null;
  if (cStat === 108 || cStat === 109) {
    return {
      shouldFallback: true,
      needsConsult: false,
      reason: `cStat ${cStat}: ${lookupCStat(cStat).descricao}`,
    };
  }
  if (cStat !== null && cStat >= 280 && cStat <= 289) {
    return {
      shouldFallback: true,
      needsConsult: false,
      reason: `cStat ${cStat}: erro de comunicacao SEFAZ`,
    };
  }

  // Erro de rede / HTTP 5xx / timeout: AMBIGUO. Pode ter autorizado.
  if (result.status === "erro") {
    return {
      shouldFallback: false,
      needsConsult: true,
      reason: result.mensagem || "erro de rede/timeout — consultar antes de reenviar",
    };
  }

  // Rejeição "comum" — problema no XML, SVC não ajuda.
  return {
    shouldFallback: false,
    needsConsult: false,
    reason: `cStat ${cStat ?? "?"}: rejeicao de validacao (nao e infra)`,
  };
}

/**
 * Retorna o SVC primário recomendado para uma UF. Cada UF tem um SVC
 * "natural" definido pela CG-NFe; a tabela vive em endpoints.ts.
 */
export function getSvcType(uf: UF): SvcType {
  return SVC_FALLBACK[uf];
}

/**
 * tpEmis correspondente ao tipo de SVC. Necessário porque a chave de acesso
 * carrega esse dígito.
 */
export function getTpEmisForSvc(svc: SvcType): 6 | 7 {
  return svc === "SVC_AN" ? 6 : 7;
}

/**
 * Lê env SEFAZ_AUTO_FALLBACK_ENABLED. Default false (opt-in) — o use case
 * só dispara fallback automático quando esta flag estiver explicitamente
 * ligada. Permite gating sem deploy de código.
 */
export function isAutoFallbackEnabled(): boolean {
  return process.env.SEFAZ_AUTO_FALLBACK_ENABLED === "true";
}
