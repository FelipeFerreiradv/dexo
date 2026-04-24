import { getApiBaseUrl } from "@/lib/api";

/**
 * Baixa o PDF "Cupom sem validade fiscal" de uma conta a receber.
 * Espelha o padrão de download binário usado em notas-fiscais
 * (blob + URL.createObjectURL + <a> programático).
 */
export async function downloadReceipt(id: string, email: string): Promise<void> {
  const res = await fetch(
    `${getApiBaseUrl()}/finance/receivables/${id}/receipt`,
    { headers: { email } },
  );
  if (!res.ok) {
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
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = `cupom-${id}.pdf`;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
