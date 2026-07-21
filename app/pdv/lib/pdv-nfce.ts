// PDV Balcão — Fase 2: emissão de NFC-e (modelo 65) em 1 clique.
//
// Toda a UI de NFC-e do PDV fica atrás de NEXT_PUBLIC_NFCE_ENABLED (E do
// módulo fiscal). Flags ausentes ⇒ o PDV renderiza EXATAMENTE como na Fase 1.

import { getApiBaseUrl } from "@/lib/api";
import { NFCE_LIMITE_VALOR } from "@/app/fiscal/domain/nfce";

// Referências literais a process.env.NEXT_PUBLIC_* para o Next inlinar.
const NFCE_ENABLED = process.env.NEXT_PUBLIC_NFCE_ENABLED === "true";
const FISCAL_ENABLED = process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED === "true";
const MULTI_CNPJ_ENABLED =
  process.env.NEXT_PUBLIC_MULTI_CNPJ_ENABLED === "true";

/** UI de NFC-e visível? Exige o módulo fiscal E a flag da NFC-e. */
export function isNfceUiEnabled(): boolean {
  return NFCE_ENABLED && FISCAL_ENABLED;
}

/** UI de multi-CNPJ (seletor de emitente/gestão de empresas) habilitada? */
export function isMultiCnpjUiEnabled(): boolean {
  return MULTI_CNPJ_ENABLED && FISCAL_ENABLED;
}

/** Venda acima do limite legal da NFC-e? (roteia para NF-e 55) */
export function excedeLimiteNfce(total: number): boolean {
  return Number(total) > NFCE_LIMITE_VALOR;
}

export interface NfceEmitResult {
  state: "authorized" | "processing" | "rejected" | "error";
  alreadyEmitted?: boolean;
  nfeId: string;
  numero: number | null;
  serie: number | null;
  chaveAcesso: string | null;
  danfeDisponivel: boolean;
  mensagem: string;
}

export type NfceEmitOutcome =
  | { ok: true; nfce: NfceEmitResult }
  | { ok: false; status: number; error: string };

/**
 * Chama o POST /finance/receivables/:id/nfce (idempotente por venda).
 * NUNCA lança: falha vira { ok: false } para o caller transformar em toast —
 * a venda já está concluída e jamais é desfeita por causa da nota.
 */
export async function emitNfceForReceivable(
  receivableId: string,
  email: string,
  // Multi-CNPJ: emitente do seletor do PDV. Ausente ⇒ URL byte-idêntica à
  // atual (CNPJ padrão no backend).
  companyId?: string | null,
): Promise<NfceEmitOutcome> {
  try {
    // SEM "Content-Type: application/json": o POST não tem body, e declarar
    // JSON com body vazio faz o Fastify rejeitar na fase de parse
    // (FST_ERR_CTP_EMPTY_JSON_BODY, 400) ANTES do handler — mesmo padrão do
    // POST /pay, que também não envia body. O emitente vai por QUERY pelo
    // mesmo motivo.
    const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
    const res = await fetch(
      `${getApiBaseUrl()}/finance/receivables/${receivableId}/nfce${query}`,
      { method: "POST", headers: { email } },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: data?.error ?? `Erro ao emitir NFC-e (HTTP ${res.status})`,
      };
    }
    return { ok: true, nfce: data.nfce as NfceEmitResult };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : "Erro de rede ao emitir NFC-e",
    };
  }
}

/** Mensagem de toast padrão por estado da emissão. */
export function nfceToastFor(outcome: NfceEmitOutcome): {
  message: string;
  type: "success" | "warning";
} {
  if (!outcome.ok) {
    return {
      message: `A venda está OK, mas a NFC-e falhou: ${outcome.error}`,
      type: "warning",
    };
  }
  const n = outcome.nfce;
  switch (n.state) {
    case "authorized":
      return {
        message: n.alreadyEmitted
          ? `NFC-e já emitida para esta venda (nº ${n.numero ?? "?"}).`
          : `NFC-e nº ${n.numero ?? "?"} autorizada.`,
        type: "success",
      };
    case "processing":
      return {
        message:
          "NFC-e enviada — em processamento na SEFAZ. Consulte pelo botão NFC-e da venda.",
        type: "success",
      };
    case "rejected":
      return {
        message: `NFC-e rejeitada: ${n.mensagem}. Corrija e reemita pelo botão NFC-e da venda.`,
        type: "warning",
      };
    default:
      return {
        message: `A venda está OK, mas a NFC-e falhou: ${n.mensagem}. Reemita pelo botão NFC-e.`,
        type: "warning",
      };
  }
}
