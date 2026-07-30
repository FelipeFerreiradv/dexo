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
   * Diagnóstico de assinatura que NÃO conferiu, para descobrir por quê.
   *
   * Existe por causa de um caso concreto (30/07/2026): o Push Log da Shopee
   * mostrou um push real de pedido — `code:3`, `shop_id:690138776`,
   * `ordersn:260722ABQH1CYK` — recebendo 401 nosso. Com o corpo e a URL em mãos
   * mas SEM o header que ela enviou, não há como distinguir "chave errada" de
   * "base da assinatura errada": as duas dão exatamente o mesmo 401.
   *
   * Devolve o que a Shopee mandou e o que cada chave candidata produziria, para
   * a comparação ser feita sobre dado e não sobre suposição.
   *
   * O header é um MAC por mensagem, não um segredo de longo prazo, e o corpo do
   * push só tem order_sn/status/shop_id — nenhum dado de comprador. Ainda assim
   * fica atrás de `SHOPEE_WEBHOOK_SIGNATURE_DEBUG=1`, desligado por default: é
   * ferramenta de investigação, não log permanente.
   */
  static diagnose(
    url: string | undefined,
    rawBody: string | undefined,
    authorization: string | undefined,
    candidatas: Array<{ nome: string; valor: string | undefined }>,
  ): Record<string, unknown> | null {
    if (process.env.SHOPEE_WEBHOOK_SIGNATURE_DEBUG !== "1") return null;

    const recebido = (authorization ?? "").trim();
    const esperado: Record<string, string> = {};
    for (const c of candidatas) {
      if (!c.valor || !url || typeof rawBody !== "string") continue;
      esperado[c.nome] = this.sign(url, rawBody, c.valor);
      // Bases alternativas plausíveis, para o caso de a divergência não estar
      // na chave: só o corpo, e url+corpo sem o separador.
      esperado[`${c.nome}:soCorpo`] = crypto
        .createHmac("sha256", c.valor)
        .update(rawBody)
        .digest("hex");
      esperado[`${c.nome}:semBarra`] = crypto
        .createHmac("sha256", c.valor)
        .update(`${url}${rawBody}`)
        .digest("hex");
    }

    return {
      urlUsada: url ?? null,
      corpoCruTamanho: typeof rawBody === "string" ? rawBody.length : null,
      corpoCru: rawBody ?? null,
      authorizationRecebido: recebido || null,
      authorizationTamanho: recebido.length,
      esperado,
      // Qual das combinações acima bate com o recebido, se alguma.
      combinacaoQueBate:
        Object.entries(esperado).find(([, v]) => v === recebido)?.[0] ?? null,
    };
  }

  /**
   * Verifica contra VÁRIAS chaves candidatas e diz qual conferiu.
   *
   * Por que não uma só: o console tem duas chaves legítimas do mesmo app — a
   * "Live API Partner Key" (tela do app) e a "Live Push Partner Key" (tela Push
   * Mechanism) — e a documentação não deixa claro qual assina o push. Escolher
   * errado rejeita 100% dos pushes com 401, e em silêncio: push recusado não
   * deixa pedido para ninguém estranhar.
   *
   * Observado em produção em 30/07/2026: quatro pushes caíram em
   * `invalid_signature` e depois passaram a conferir, sem mudança de código no
   * meio. Tentar as duas remove a adivinhação, e o nome da que conferiu vai para
   * o log — assim a resposta fica registrada em vez de inferida.
   *
   * Não enfraquece nada: ambas são segredo do mesmo app, e uma assinatura que
   * não confere com NENHUMA continua sendo 401.
   */
  static verifyAny(
    url: string | undefined,
    rawBody: string | undefined,
    authorization: string | undefined,
    candidatas: Array<{ nome: string; valor: string | undefined }>,
  ): { ok: boolean; chave?: string } {
    const vistas = new Set<string>();
    for (const c of candidatas) {
      if (!c.valor || vistas.has(c.valor)) continue;
      vistas.add(c.valor);
      if (this.verify(url, rawBody, authorization, c.valor)) {
        return { ok: true, chave: c.nome };
      }
    }
    return { ok: false };
  }

  /**
   * Chave que assina o PUSH, que não é necessariamente a mesma que assina as
   * chamadas de API.
   *
   * O console do Shopee Open Platform tem, na tela Push Mechanism, um campo
   * "Live Push Partner Key" próprio, com botão Generate — separado das "Test/Live
   * API Partner Key" da tela do app. Quando esse campo é preenchido, é ELE que
   * assina o push, e verificar com a chave de API rejeitaria 100% dos pushes.
   *
   * `SHOPEE_PUSH_PARTNER_KEY` ausente cai em `SHOPEE_PARTNER_KEY`, que é o
   * comportamento anterior byte-a-byte (apps antigos usam a mesma chave para as
   * duas coisas).
   */
  static pushPartnerKey(): string | undefined {
    const dedicada = process.env.SHOPEE_PUSH_PARTNER_KEY?.trim();
    if (dedicada) return dedicada;
    return process.env.SHOPEE_PARTNER_KEY?.trim() || undefined;
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
