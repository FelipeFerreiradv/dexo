import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import crypto from "crypto";

import { whatsappRoutes } from "@/app/routes/whatsapp.routes";
import { WhatsAppRepository } from "@/app/marketplaces/repositories/whatsapp.repository";
import { WhatsAppWebhookUseCase } from "@/app/marketplaces/usecases/whatsapp-webhook.usecase";

const VERIFY_TOKEN = "verify-token-de-teste";
const APP_SECRET = "app-secret-de-teste";

const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify();
  await app.register(whatsappRoutes, { prefix: "/whatsapp" });
  return app;
};

const samplePayload = (phoneNumberId = "555000111") => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "waba-1",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: {
              phone_number_id: phoneNumberId,
              display_phone_number: "5511999990000",
            },
            messages: [
              {
                id: "wamid.ABC",
                from: "5547988887777",
                timestamp: "1750000000",
                type: "text",
                text: { body: "olá" },
              },
            ],
          },
        },
      ],
    },
  ],
});

const signed = (body: string, secret: string) =>
  `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

const accountFixture = {
  id: "wa-acc-1",
  userId: "user-1",
  wabaId: "waba-1",
  phoneNumberId: "555000111",
  displayPhoneNumber: "5511999990000",
  verifiedName: "Loja",
  status: "ACTIVE",
  createdAt: new Date(),
  accessToken: "token",
  appSecret: APP_SECRET,
} as any;

// ===========================================================================
// verifySignature — HMAC-SHA256 do corpo bruto (X-Hub-Signature-256)
// ===========================================================================
describe("WhatsAppWebhookUseCase.verifySignature", () => {
  const raw = Buffer.from('{"a":1}');

  it("aceita assinatura válida", () => {
    expect(
      WhatsAppWebhookUseCase.verifySignature(
        raw,
        signed(raw.toString(), APP_SECRET),
        [APP_SECRET],
      ),
    ).toBe(true);
  });

  it("rejeita assinatura de outro segredo", () => {
    expect(
      WhatsAppWebhookUseCase.verifySignature(
        raw,
        signed(raw.toString(), "outro-segredo"),
        [APP_SECRET],
      ),
    ).toBe(false);
  });

  it("rejeita header ausente/malformado e lista de segredos vazia", () => {
    const ok = signed(raw.toString(), APP_SECRET);
    expect(WhatsAppWebhookUseCase.verifySignature(raw, undefined, [APP_SECRET])).toBe(false);
    expect(WhatsAppWebhookUseCase.verifySignature(raw, "md5=abc", [APP_SECRET])).toBe(false);
    expect(WhatsAppWebhookUseCase.verifySignature(raw, "sha256=zzzz", [APP_SECRET])).toBe(false);
    expect(WhatsAppWebhookUseCase.verifySignature(raw, ok, [])).toBe(false);
  });

  it("aceita quando QUALQUER segredo da lista casa (rotação/multi-conta)", () => {
    expect(
      WhatsAppWebhookUseCase.verifySignature(
        raw,
        signed(raw.toString(), APP_SECRET),
        ["primeiro-nao-casa", APP_SECRET],
      ),
    ).toBe(true);
  });

  it("rejeita corpo adulterado (raw body diferente do assinado)", () => {
    const sig = signed(raw.toString(), APP_SECRET);
    expect(
      WhatsAppWebhookUseCase.verifySignature(
        Buffer.from('{"a":2}'),
        sig,
        [APP_SECRET],
      ),
    ).toBe(false);
  });
});

// ===========================================================================
// GET /whatsapp/webhook — handshake de verificação
// ===========================================================================
describe("GET /whatsapp/webhook — handshake", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("flag ligada + verify token correto: 200 com o challenge", async () => {
    vi.stubEnv("NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED", "true");
    vi.stubEnv("WHATSAPP_WEBHOOK_VERIFY_TOKEN", VERIFY_TOKEN);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("12345");
    await app.close();
  });

  it("verify token errado: 403", async () => {
    vi.stubEnv("NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED", "true");
    vi.stubEnv("WHATSAPP_WEBHOOK_VERIFY_TOKEN", VERIFY_TOKEN);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=12345",
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("flag global desligada: 404 (handshake não completa; módulo inerte)", async () => {
    vi.stubEnv("NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED", "");
    vi.stubEnv("WHATSAPP_WEBHOOK_VERIFY_TOKEN", VERIFY_TOKEN);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`,
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ===========================================================================
// POST /whatsapp/webhook — assinatura bloqueante + 200 imediato + background
// ===========================================================================
describe("POST /whatsapp/webhook — eventos", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED", "true");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const flushBackground = () => new Promise((r) => setImmediate(r));

  it("assinatura válida (segredo POR CONTA): 200 e processa em background", async () => {
    vi.spyOn(
      WhatsAppRepository,
      "findByPhoneNumberIdWithSecrets",
    ).mockResolvedValue(accountFixture);
    const processSpy = vi
      .spyOn(WhatsAppWebhookUseCase, "processWebhook")
      .mockResolvedValue();

    const body = JSON.stringify(samplePayload());
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/whatsapp/webhook",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signed(body, APP_SECRET),
      },
    });

    expect(res.statusCode).toBe(200);
    await flushBackground();
    expect(processSpy).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("assinatura inválida: 401 e NÃO processa", async () => {
    vi.spyOn(
      WhatsAppRepository,
      "findByPhoneNumberIdWithSecrets",
    ).mockResolvedValue(accountFixture);
    const processSpy = vi
      .spyOn(WhatsAppWebhookUseCase, "processWebhook")
      .mockResolvedValue();

    const body = JSON.stringify(samplePayload());
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/whatsapp/webhook",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signed(body, "segredo-forjado"),
      },
    });

    expect(res.statusCode).toBe(401);
    await flushBackground();
    expect(processSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("sem NENHUM segredo configurado (conta sem appSecret e sem env): 401 fail-closed", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", "");
    vi.spyOn(
      WhatsAppRepository,
      "findByPhoneNumberIdWithSecrets",
    ).mockResolvedValue({ ...accountFixture, appSecret: null });

    const body = JSON.stringify(samplePayload());
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/whatsapp/webhook",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signed(body, APP_SECRET),
      },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("número não conectado: 200 e descarta sem processar", async () => {
    vi.spyOn(
      WhatsAppRepository,
      "findByPhoneNumberIdWithSecrets",
    ).mockResolvedValue(null);
    const processSpy = vi
      .spyOn(WhatsAppWebhookUseCase, "processWebhook")
      .mockResolvedValue();

    const body = JSON.stringify(samplePayload("999-desconhecido"));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/whatsapp/webhook",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signed(body, APP_SECRET),
      },
    });

    expect(res.statusCode).toBe(200);
    await flushBackground();
    expect(processSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("flag global desligada: 200 inerte (não resolve conta, não processa)", async () => {
    vi.stubEnv("NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED", "");
    const repoSpy = vi.spyOn(
      WhatsAppRepository,
      "findByPhoneNumberIdWithSecrets",
    );
    const processSpy = vi.spyOn(WhatsAppWebhookUseCase, "processWebhook");

    const body = JSON.stringify(samplePayload());
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/whatsapp/webhook",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signed(body, APP_SECRET),
      },
    });

    expect(res.statusCode).toBe(200);
    await flushBackground();
    expect(repoSpy).not.toHaveBeenCalled();
    expect(processSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("payload de outro object: 200 e descarta", async () => {
    const repoSpy = vi.spyOn(
      WhatsAppRepository,
      "findByPhoneNumberIdWithSecrets",
    );

    const body = JSON.stringify({ object: "page", entry: [] });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/whatsapp/webhook",
      payload: body,
      headers: { "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(200);
    expect(repoSpy).not.toHaveBeenCalled();
    await app.close();
  });
});
