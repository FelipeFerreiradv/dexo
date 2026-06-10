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
  shouldFallback: boolean;
  reason: string;
}

/**
 * Decide se devemos tentar reenviar via SVC após uma resposta de emit.
 *
 * Retorna false se a emissão foi sucesso (autorizada ou duplicidade) — não
 * faz sentido fallback nesse caso. Retorna true para falhas que cheirem a
 * problema de infraestrutura SEFAZ.
 */
export function shouldFallbackToSvc(
  result: NfeProviderEmitResult,
): FallbackDecision {
  // Sucesso explícito — não cair em contingência
  if (result.success && result.status === "autorizada") {
    return { shouldFallback: false, reason: "autorizada — nao precisa SVC" };
  }
  if (result.status === "processando") {
    return {
      shouldFallback: false,
      reason: "processando (sincrono pendente) — nao precisa SVC",
    };
  }

  // Erro genérico (rede / HTTP 5xx / timeout) — provider já tentou retry,
  // ainda assim falhou → infra
  if (result.status === "erro") {
    return { shouldFallback: true, reason: result.mensagem || "erro de infra" };
  }

  // Códigos de paralisação ou família infra
  const cStat = result.codigoStatus ?? null;
  if (cStat === 108 || cStat === 109) {
    return {
      shouldFallback: true,
      reason: `cStat ${cStat}: ${lookupCStat(cStat).descricao}`,
    };
  }
  if (cStat !== null && cStat >= 280 && cStat <= 289) {
    return {
      shouldFallback: true,
      reason: `cStat ${cStat}: erro de comunicacao SEFAZ`,
    };
  }

  // Rejeição "comum" — problema no XML, SVC não vai ajudar
  return {
    shouldFallback: false,
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
