import { createHmac, timingSafeEqual } from "crypto";

/**
 * Validação de autenticidade dos webhooks nativos v1 da Magalu.
 *
 * A Magalu assina cada notificação com HMAC-SHA256 (mais do que ML/Shopee, que
 * não validam assinatura). Cabeçalhos:
 *  - `X-Signature-256`: uma ou mais assinaturas `sha256=<hex>` separadas por
 *    vírgula (durante a rotação de segredo, a antiga e a nova são enviadas).
 *  - `X-Timestamp`: unix timestamp (segundos).
 *
 * Payload assinado = `"{X-Timestamp}.{corpo_bruto}"`, HMAC-SHA256 com o segredo
 * `whsec_*` (MAGALU_WEBHOOK_SECRET).
 *
 * IMPORTANTE: o `rawBody` deve ser o corpo BRUTO exatamente como recebido. Ver
 * a rota /magalu/webhook para a limitação atual de captura do raw body.
 */
export class MagaluWebhookSignatureService {
  /**
   * Verifica a assinatura HMAC. Retorna true se qualquer assinatura presente
   * no header bater (suporta rotação). Comparação em tempo constante.
   */
  static verify(
    rawBody: string,
    timestamp: string | undefined,
    signatureHeader: string | undefined,
    secret: string | undefined,
  ): boolean {
    if (!secret || !signatureHeader || !timestamp) {
      return false;
    }

    const signedPayload = `${timestamp}.${rawBody}`;
    const expected = createHmac("sha256", secret)
      .update(signedPayload)
      .digest("hex");

    const provided = signatureHeader
      .split(",")
      .map((s) => s.trim().replace(/^sha256=/i, ""))
      .filter(Boolean);

    return provided.some((sig) => this.safeEqualHex(sig, expected));
  }

  private static safeEqualHex(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
    } catch {
      return false;
    }
  }
}
