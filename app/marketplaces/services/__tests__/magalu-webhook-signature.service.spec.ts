import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { MagaluWebhookSignatureService } from "../magalu-webhook-signature.service";

const SECRET = "whsec_test_secret";
const TS = "1700000000";
const BODY = '{"data":{"status":"new"},"tenant_id":"t1","topic":"orders_order"}';

function sign(body: string, ts: string, secret: string): string {
  return createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

describe("MagaluWebhookSignatureService.verify", () => {
  it("aceita assinatura válida (sha256=<hex> sobre {ts}.{body})", () => {
    const sig = `sha256=${sign(BODY, TS, SECRET)}`;
    expect(MagaluWebhookSignatureService.verify(BODY, TS, sig, SECRET)).toBe(
      true,
    );
  });

  it("rejeita assinatura inválida", () => {
    const sig = "sha256=deadbeef";
    expect(MagaluWebhookSignatureService.verify(BODY, TS, sig, SECRET)).toBe(
      false,
    );
  });

  it("rejeita quando o corpo é adulterado", () => {
    const sig = `sha256=${sign(BODY, TS, SECRET)}`;
    expect(
      MagaluWebhookSignatureService.verify(
        BODY + "x",
        TS,
        sig,
        SECRET,
      ),
    ).toBe(false);
  });

  it("aceita rotação: múltiplas assinaturas separadas por vírgula (nova válida)", () => {
    const good = sign(BODY, TS, SECRET);
    const header = `sha256=0000, sha256=${good}`;
    expect(MagaluWebhookSignatureService.verify(BODY, TS, header, SECRET)).toBe(
      true,
    );
  });

  it("retorna false sem segredo / sem header / sem timestamp", () => {
    const sig = `sha256=${sign(BODY, TS, SECRET)}`;
    expect(MagaluWebhookSignatureService.verify(BODY, TS, sig, undefined)).toBe(
      false,
    );
    expect(MagaluWebhookSignatureService.verify(BODY, TS, undefined, SECRET)).toBe(
      false,
    );
    expect(MagaluWebhookSignatureService.verify(BODY, undefined, sig, SECRET)).toBe(
      false,
    );
  });
});
