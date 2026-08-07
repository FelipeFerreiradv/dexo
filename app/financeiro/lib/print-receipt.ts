import { getApiBaseUrl } from "@/lib/api";
import {
  openPdfForPrint,
  type PdfDeliveryResult,
} from "@/app/lib/open-pdf-for-print";

/**
 * Abre o "Cupom sem validade fiscal" de uma conta a receber JÁ PRONTO PARA
 * IMPRESSÃO (nova aba + diálogo de print), em vez de baixar o arquivo.
 *
 * Irmão de `downloadReceipt`, NÃO substituto: o Financeiro continua baixando
 * (comportamento atual, intocado) e o PDV — que é caixa, não escritório —
 * imprime. Mesmo endpoint, mesmo PDF, mesma geração: muda só a entrega.
 *
 * Reusa `openPdfForPrint`, que já resolve pop-up bloqueado caindo no download
 * (app/lib/open-pdf-for-print.ts:53-61) — o operador nunca fica sem o cupom.
 */
export async function printReceipt(
  id: string,
  email: string,
): Promise<PdfDeliveryResult> {
  const res = await fetch(
    `${getApiBaseUrl()}/finance/receivables/${id}/receipt`,
    { headers: { email } },
  );
  if (!res.ok) {
    // Mesma extração de mensagem do downloadReceipt (o endpoint responde
    // { error } em JSON quando falha antes de produzir o PDF).
    let message = "Nao foi possivel emitir o cupom";
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // resposta nao era JSON, mantem mensagem padrao
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  return openPdfForPrint(blob, `cupom-${id}.pdf`);
}
