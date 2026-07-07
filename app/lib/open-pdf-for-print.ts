// Entrega de um PDF gerado no cliente: abre em nova aba pronta para impressao,
// em vez de forcar o download. Espelha o padrao ja usado no fluxo de etiqueta de
// envio (app/pedidos/*): window.open + revoke tardio. Alem disso, tenta disparar
// o dialogo de impressao (best-effort) e, se o pop-up for bloqueado, cai no
// download para o usuario nunca ficar sem o arquivo.

export type PdfDeliveryResult = "opened" | "downloaded";

// Tempo ate revogar a object URL. Precisa ser longo o bastante para nao invalidar
// a aba/impressao recem-aberta (mesmo valor do fluxo de pedidos).
const REVOKE_DELAY_MS = 60_000;

// Fallback de disparo do print caso o evento "load" nao venha: o visualizador de
// PDF do navegador frequentemente nao emite "load" para o documento.
const PRINT_FALLBACK_MS = 1500;

export function openPdfForPrint(
  blob: Blob,
  fallbackFileName: string,
): PdfDeliveryResult {
  const url = URL.createObjectURL(blob);

  // Sem "noopener": o blob e same-origin (conteudo gerado por nos) e precisamos
  // da referencia da janela para (a) detectar pop-up bloqueado e (b) tentar
  // disparar a impressao automaticamente.
  const win = window.open(url, "_blank");

  if (win) {
    let printTriggered = false;
    const triggerPrint = () => {
      if (printTriggered) return;
      printTriggered = true;
      try {
        win.focus();
        win.print();
      } catch {
        // Alguns navegadores bloqueiam print() no visualizador de PDF;
        // o PDF ja esta aberto e pronto para Ctrl+P.
      }
    };

    try {
      win.addEventListener("load", triggerPrint);
    } catch {
      // O acesso pode falhar se a aba ja navegou para um visualizador de PDF
      // cross-origin; o timeout abaixo cobre esse caso.
    }
    setTimeout(triggerPrint, PRINT_FALLBACK_MS);
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
    return "opened";
  }

  // Pop-up bloqueado: baixa o arquivo para o usuario nao ficar sem o PDF.
  const link = document.createElement("a");
  link.href = url;
  link.download = fallbackFileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  return "downloaded";
}
