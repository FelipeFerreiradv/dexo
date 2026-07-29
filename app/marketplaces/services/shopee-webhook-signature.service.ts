import crypto from "crypto";

/**
 * Assinatura do push da Shopee (Open Platform v2).
 *
 * A Shopee manda o header `Authorization` com
 *   HMAC-SHA256( "<url do callback>|<corpo cru>", partner_key )  em hex
 *
 * onde `<url do callback>` é EXATAMENTE a URL cadastrada no Partner Portal
 * (sem query string) e `<corpo cru>` são os bytes originais do POST — por isso
 * a rota captura o raw body antes do parse: re-serializar o JSON muda a ordem
 * das chaves e o espaçamento, e a assinatura nunca bateria.
 *
 * Por que isto existe: até 29/07/2026 a rota `POST /marketplace/shopee/webhook`
 * não validava NADA. Qualquer POST com `{shop_id, code:4}` de uma loja conhecida
 * disparava um ciclo completo de importação com baixa de estoque e consumia a
 * chave de idempotência daquele evento.
 */
export class ShopeeWebhookSignatureService {
  static sign(url: string, rawBody: string, partnerKey: string): string {
    return crypto
      .createHmac("sha256", partnerKey)
      .update(`${url}|${rawBody}`)
      .digest("hex");
  }

  /**
   * Comparação em tempo constante. Retorna false para qualquer entrada
   * ausente — quem chama decide se isso bloqueia ou só avisa.
   */
  static verify(
    url: string | undefined,
    rawBody: string | undefined,
    authorization: string | undefined,
    partnerKey: string | undefined,
  ): boolean {
    if (!url || !partnerKey || typeof rawBody !== "string" || !authorization) {
      return false;
    }

    const expected = this.sign(url, rawBody, partnerKey);
    const received = authorization.trim();

    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(received, "utf8");
    // timingSafeEqual exige o mesmo comprimento; comparar antes vaza só o
    // tamanho, que não é segredo.
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * URL de callback usada na assinatura. `SHOPEE_WEBHOOK_URL` tem precedência
   * para o caso de a URL cadastrada na Shopee diferir do `APP_BACKEND_URL`
   * (proxy, domínio próprio). Retorna undefined quando não dá para saber — aí
   * a rota não bloqueia, porque bloquear sem poder verificar perderia pedidos.
   */
  static callbackUrl(): string | undefined {
    const explicit = process.env.SHOPEE_WEBHOOK_URL?.trim();
    if (explicit) return explicit.replace(/\/+$/, "");

    const base = process.env.APP_BACKEND_URL?.trim();
    if (!base) return undefined;
    return `${base.replace(/\/+$/, "")}/marketplace/shopee/webhook`;
  }
}
