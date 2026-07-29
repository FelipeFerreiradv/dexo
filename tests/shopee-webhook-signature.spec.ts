import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "crypto";

// ──────────────────────────────────────────────────────────────────────────────
// Auditoria adversarial de 29/07/2026 — este era o ÚNICO caminho de segurança do
// trabalho sem teste nenhum, e o único gate novo com default ENFORCING (401).
//
// O que ele protege: até 29/07/2026 a rota POST /marketplace/shopee/webhook não
// validava nada. Qualquer POST com {shop_id, code:4} de uma loja conhecida
// disparava importação com baixa de estoque e consumia a chave de idempotência
// do evento.
//
// O risco do gate em si: a base da assinatura inclui a URL do callback, derivada
// de env. Divergência de UM byte com o que está cadastrado no Partner Portal
// rejeita 100% dos pushes com 401 — e silenciosamente, porque um push rejeitado
// não deixa pedido nenhum para alguém estranhar. Por isso a normalização de
// barra final e a precedência de SHOPEE_WEBHOOK_URL são testadas aqui.
// ──────────────────────────────────────────────────────────────────────────────

import { ShopeeWebhookSignatureService } from "@/app/marketplaces/services/shopee-webhook-signature.service";

const URL_CB = "https://api.exemplo.com/marketplace/shopee/webhook";
const CORPO = '{"shop_id":123,"code":4,"data":{"ordersn":"SN-1"}}';
const CHAVE = "partner-key-secreta";

/** HMAC calculado à mão, sem passar pelo código sob teste. */
function hmacManual(url: string, corpo: string, chave: string): string {
  return crypto
    .createHmac("sha256", chave)
    .update(`${url}|${corpo}`)
    .digest("hex");
}

const guardadas: Record<string, string | undefined> = {};
const NOMES = ["SHOPEE_WEBHOOK_URL", "APP_BACKEND_URL"];

beforeEach(() => {
  for (const n of NOMES) {
    guardadas[n] = process.env[n];
    delete process.env[n];
  }
});

afterEach(() => {
  for (const n of NOMES) {
    if (guardadas[n] === undefined) delete process.env[n];
    else process.env[n] = guardadas[n]!;
  }
});

describe("sign", () => {
  it("é o HMAC-SHA256 hex de `url|corpo` com a partner key", () => {
    expect(ShopeeWebhookSignatureService.sign(URL_CB, CORPO, CHAVE)).toBe(
      hmacManual(URL_CB, CORPO, CHAVE),
    );
  });

  it("o separador é `|` — não concatenação simples", () => {
    // Sem o separador, url="a" corpo="bc" e url="ab" corpo="c" dariam a MESMA
    // assinatura, e um atacante poderia deslocar a fronteira.
    const a = ShopeeWebhookSignatureService.sign("a", "bc", CHAVE);
    const b = ShopeeWebhookSignatureService.sign("ab", "c", CHAVE);
    expect(a).not.toBe(b);
  });

  it("é determinístico", () => {
    expect(ShopeeWebhookSignatureService.sign(URL_CB, CORPO, CHAVE)).toBe(
      ShopeeWebhookSignatureService.sign(URL_CB, CORPO, CHAVE),
    );
  });
});

describe("verify — aceita o que é legítimo", () => {
  it("assinatura correta passa", () => {
    const assinatura = hmacManual(URL_CB, CORPO, CHAVE);
    expect(
      ShopeeWebhookSignatureService.verify(URL_CB, CORPO, assinatura, CHAVE),
    ).toBe(true);
  });

  it("tolera espaço em volta do header", () => {
    const assinatura = `  ${hmacManual(URL_CB, CORPO, CHAVE)}  `;
    expect(
      ShopeeWebhookSignatureService.verify(URL_CB, CORPO, assinatura, CHAVE),
    ).toBe(true);
  });

  it("corpo VAZIO é corpo válido, não entrada ausente", () => {
    // `""` é falsy: um teste de verdade em vez de `typeof === "string"` recusaria
    // um push de corpo vazio legítimo.
    const assinatura = hmacManual(URL_CB, "", CHAVE);
    expect(
      ShopeeWebhookSignatureService.verify(URL_CB, "", assinatura, CHAVE),
    ).toBe(true);
  });
});

describe("verify — recusa o que não é", () => {
  it("assinatura de outra partner key não passa", () => {
    const assinatura = hmacManual(URL_CB, CORPO, "outra-chave");
    expect(
      ShopeeWebhookSignatureService.verify(URL_CB, CORPO, assinatura, CHAVE),
    ).toBe(false);
  });

  it("corpo alterado não passa (é o ponto do raw body)", () => {
    const assinatura = hmacManual(URL_CB, CORPO, CHAVE);
    const adulterado = CORPO.replace("SN-1", "SN-2");
    expect(
      ShopeeWebhookSignatureService.verify(URL_CB, adulterado, assinatura, CHAVE),
    ).toBe(false);
  });

  it("URL diferente não passa", () => {
    const assinatura = hmacManual("https://outro.host/webhook", CORPO, CHAVE);
    expect(
      ShopeeWebhookSignatureService.verify(URL_CB, CORPO, assinatura, CHAVE),
    ).toBe(false);
  });

  it("assinatura de tamanho diferente devolve false, NÃO lança", () => {
    // crypto.timingSafeEqual LANÇA com buffers de tamanhos diferentes. Sem a
    // checagem de comprimento antes, um header curto derrubaria a rota com 500
    // em vez de 401.
    expect(() =>
      ShopeeWebhookSignatureService.verify(URL_CB, CORPO, "abc", CHAVE),
    ).not.toThrow();
    expect(
      ShopeeWebhookSignatureService.verify(URL_CB, CORPO, "abc", CHAVE),
    ).toBe(false);
  });

  it("header muito longo devolve false, NÃO lança", () => {
    expect(() =>
      ShopeeWebhookSignatureService.verify(URL_CB, CORPO, "0".repeat(500), CHAVE),
    ).not.toThrow();
  });

  it("assinatura em MAIÚSCULAS não passa (a Shopee manda hex minúsculo)", () => {
    // Pino de comportamento: se algum dia um push chegar com hex maiúsculo, o
    // sintoma será 401 em 100% dos pushes — e este teste diz onde olhar.
    const assinatura = hmacManual(URL_CB, CORPO, CHAVE).toUpperCase();
    expect(
      ShopeeWebhookSignatureService.verify(URL_CB, CORPO, assinatura, CHAVE),
    ).toBe(false);
  });

  it.each([
    ["url ausente", undefined, CORPO, "assin", CHAVE],
    ["corpo ausente", URL_CB, undefined, "assin", CHAVE],
    ["header ausente", URL_CB, CORPO, undefined, CHAVE],
    ["partner key ausente", URL_CB, CORPO, "assin", undefined],
    ["header vazio", URL_CB, CORPO, "", CHAVE],
    ["partner key vazia", URL_CB, CORPO, "assin", ""],
  ])("%s devolve false sem lançar", (_nome, url, corpo, header, chave) => {
    expect(() =>
      ShopeeWebhookSignatureService.verify(
        url as any,
        corpo as any,
        header as any,
        chave as any,
      ),
    ).not.toThrow();
    expect(
      ShopeeWebhookSignatureService.verify(
        url as any,
        corpo as any,
        header as any,
        chave as any,
      ),
    ).toBe(false);
  });
});

describe("callbackUrl", () => {
  it("SHOPEE_WEBHOOK_URL tem precedência sobre APP_BACKEND_URL", () => {
    process.env.APP_BACKEND_URL = "https://api.exemplo.com";
    process.env.SHOPEE_WEBHOOK_URL = "https://proxy.exemplo.com/hook-shopee";

    expect(ShopeeWebhookSignatureService.callbackUrl()).toBe(
      "https://proxy.exemplo.com/hook-shopee",
    );
  });

  it("deriva de APP_BACKEND_URL quando a explícita não existe", () => {
    process.env.APP_BACKEND_URL = "https://api.exemplo.com";

    expect(ShopeeWebhookSignatureService.callbackUrl()).toBe(URL_CB);
  });

  it("barra final do APP_BACKEND_URL não vira barra dupla", () => {
    // Barra dupla mudaria a base da assinatura e rejeitaria todo push.
    process.env.APP_BACKEND_URL = "https://api.exemplo.com/";

    expect(ShopeeWebhookSignatureService.callbackUrl()).toBe(URL_CB);
  });

  it("barra final da URL explícita é removida", () => {
    process.env.SHOPEE_WEBHOOK_URL = "https://proxy.exemplo.com/hook/";

    expect(ShopeeWebhookSignatureService.callbackUrl()).toBe(
      "https://proxy.exemplo.com/hook",
    );
  });

  it("espaço em volta da env não entra na assinatura", () => {
    process.env.SHOPEE_WEBHOOK_URL = "  https://proxy.exemplo.com/hook  ";

    expect(ShopeeWebhookSignatureService.callbackUrl()).toBe(
      "https://proxy.exemplo.com/hook",
    );
  });

  it("sem nenhuma das duas devolve undefined", () => {
    // A rota então NÃO bloqueia: recusar sem poder verificar perderia venda.
    expect(ShopeeWebhookSignatureService.callbackUrl()).toBeUndefined();
  });

  it("APP_BACKEND_URL só com espaço conta como ausente", () => {
    process.env.APP_BACKEND_URL = "   ";

    expect(ShopeeWebhookSignatureService.callbackUrl()).toBeUndefined();
  });
});
