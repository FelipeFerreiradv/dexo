// PDV Balcão — Bloco D: consulta e reimpressão de notas já emitidas.
//
// Nada aqui emite documento fiscal: é leitura (quais notas a venda já tem) e
// entrega do PDF que o backend já guardou (NfeEmitida.danfePdfPath). A emissão
// continua sendo o POST idempotente de pdv-nfce.ts.

import { getApiBaseUrl } from "@/lib/api";
import {
  openPdfForPrint,
  type PdfDeliveryResult,
} from "@/app/lib/open-pdf-for-print";
import type { FiscalDocSummary } from "./pdv-actions";

/**
 * Notas vinculadas à venda (link textual numeroPedido="receivable:<id>").
 *
 * NUNCA lança: o menu de ações não pode quebrar por causa de um lookup. Falha
 * ⇒ lista vazia ⇒ o menu oferece "Emitir", e a emissão é idempotente no
 * backend — o pior caso é o operador clicar em emitir numa nota que já existe
 * e receber de volta "NFC-e já emitida para esta venda".
 *
 * Egress: chamada sob demanda, só quando o operador ABRE o menu daquela linha
 * — não é um fan-out de 10 requests ao carregar o livro do dia.
 */
export async function fetchFiscalDocs(
  receivableId: string,
  email: string,
): Promise<FiscalDocSummary[]> {
  try {
    const res = await fetch(
      `${getApiBaseUrl()}/finance/receivables/${receivableId}/fiscal-docs`,
      { headers: { email } },
    );
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data?.docs) ? (data.docs as FiscalDocSummary[]) : [];
  } catch {
    return [];
  }
}

/**
 * Cria o rascunho de NF-e modelo 55 desta venda.
 *
 * Mesma chamada que o PDV já faz quando a venda passa de R$ 10.000
 * (pdv-view.tsx:167) — inclusive o "sem Content-Type", porque o POST não tem
 * body e declarar JSON vazio derruba a requisição no parse do Fastify
 * (FST_ERR_CTP_EMPTY_JSON_BODY). O emitente vai por QUERY pelo mesmo motivo.
 *
 * O usuário finaliza no módulo Notas Fiscais: o rascunho sai com NCM em
 * branco por decisão de projeto (finance.usecase.ts:601).
 */
export async function createNfe55Draft(
  receivableId: string,
  email: string,
  companyId?: string | null,
): Promise<void> {
  const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
  const res = await fetch(
    `${getApiBaseUrl()}/finance/receivables/${receivableId}/fiscal-draft${query}`,
    { method: "POST", headers: { email } },
  );
  if (!res.ok) {
    let message = "Não foi possível criar o rascunho de NF-e";
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // resposta não era JSON — mantém a mensagem padrão
    }
    throw new Error(message);
  }
}

/**
 * Reimpressão do DANFE/DANFCE de uma nota já emitida.
 *
 * Usa a rota existente `GET /fiscal/nfe/:id/danfe` (fiscal.routes.ts:1181),
 * que já faz o re-render best-effort a partir do XML autorizado e cai no PDF
 * gravado. 404 quando a nota não tem DANFE disponível — por isso a ação só é
 * oferecida com `danfeDisponivel: true`.
 */
export async function printFiscalDanfe(
  nfeId: string,
  email: string,
  modelo: "55" | "65",
): Promise<PdfDeliveryResult> {
  const res = await fetch(`${getApiBaseUrl()}/fiscal/nfe/${nfeId}/danfe`, {
    headers: { email },
  });
  if (!res.ok) {
    let message =
      modelo === "65"
        ? "DANFCE ainda não disponível para esta nota"
        : "DANFE ainda não disponível para esta nota";
    try {
      const data = await res.json();
      if (data?.error || data?.message) message = data.error ?? data.message;
    } catch {
      // resposta não era JSON — mantém a mensagem padrão
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  // Mesmo prefixo de nome que a rota usa (cupom p/ 65, danfe p/ 55).
  const prefixo = modelo === "65" ? "cupom" : "danfe";
  return openPdfForPrint(blob, `${prefixo}-${nfeId}.pdf`);
}
