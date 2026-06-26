import { getApiBaseUrl } from "@/lib/api";

/**
 * Baixa o PDF do Orçamento. Espelha download-receipt.ts (blob +
 * URL.createObjectURL + <a> programático), trocando a URL e o filename.
 */
export async function downloadBudgetPdf(
  id: string,
  email: string,
): Promise<void> {
  const res = await fetch(`${getApiBaseUrl()}/budgets/${id}/pdf`, {
    headers: { email },
  });
  if (!res.ok) {
    let message = "Não foi possível gerar o orçamento";
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // resposta não era JSON, mantém mensagem padrão
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = `orcamento-${id}.pdf`;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
