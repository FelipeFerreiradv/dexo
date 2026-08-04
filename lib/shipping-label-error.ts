/**
 * Formata o erro do módulo de etiqueta para exibição.
 *
 * Existe por causa do incidente de 29/07/2026, em que o detalhe do pedido lia
 * `data.message` cru e o lojista via na tela
 * "Shopee upload_invoice_doc 404: Request failed with status code 404".
 *
 * O backend agora devolve `{ error, code, message, correlationId }`, com
 * `message` já em português e acionável. Mesmo assim mantemos os fallbacks na
 * ordem message → error → texto padrão, porque a resposta antiga (só `error` e
 * `message`) continua válida e um front atualizado pode falar com uma API que
 * ainda não subiu.
 */

export interface ShippingLabelErrorBody {
  error?: string;
  code?: string;
  message?: string;
  correlationId?: string;
}

/** Códigos cuja mensagem do backend já é a orientação completa ao lojista. */
const SELF_EXPLANATORY_CODES = new Set([
  "NFE_NOT_FOUND",
  "NFE_HOMOLOGACAO",
  "NFE_XML_MISSING",
  "NOT_READY",
  "ORDER_NOT_FOUND",
  "UNSUPPORTED_PLATFORM",
  "SHIPMENT_NOT_FOUND",
  "PROVIDER_ERROR",
]);

export function formatLabelError(
  body: ShippingLabelErrorBody | null | undefined,
  fallback = "Não foi possível gerar a etiqueta. Tente novamente.",
): string {
  const message = body?.message?.trim();
  const title = body?.error?.trim();

  // Mensagem técnica crua de cliente HTTP nunca deve chegar ao lojista. Se
  // aparecer, é sinal de API antiga ou caminho não tratado — mostramos o
  // fallback e deixamos o correlationId para o suporte.
  const isRawHttpNoise =
    !!message && /request failed with status code|network error/i.test(message);

  let text = fallback;
  if (message && !isRawHttpNoise) {
    text = message;
  } else if (title && !isRawHttpNoise) {
    text = title;
  }

  if (body?.correlationId && (isRawHttpNoise || !SELF_EXPLANATORY_CODES.has(body.code ?? ""))) {
    text += ` (ref: ${body.correlationId})`;
  }
  return text;
}
