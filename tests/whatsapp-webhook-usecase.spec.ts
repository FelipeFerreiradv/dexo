import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import prisma from "@/app/lib/prisma";
import { WhatsAppWebhookUseCase } from "@/app/marketplaces/usecases/whatsapp-webhook.usecase";
import { WhatsAppRepository } from "@/app/marketplaces/repositories/whatsapp.repository";
import { WhatsAppInboxRepository } from "@/app/marketplaces/repositories/whatsapp-inbox.repository";
import { WhatsAppApiService } from "@/app/marketplaces/services/whatsapp-api.service";
import { WhatsAppMediaStorageService } from "@/app/marketplaces/services/whatsapp-media-storage.service";
import { clearWhatsappEntitlementCache } from "@/app/marketplaces/whatsapp/whatsapp-entitlement.service";

const account = {
  id: "wa-acc-1",
  userId: "user-1",
  wabaId: "waba-1",
  phoneNumberId: "555000111",
  displayPhoneNumber: "5511999990000",
  verifiedName: "Loja",
  status: "ACTIVE",
  createdAt: new Date(),
  accessToken: "token-decifrado",
  appSecret: "secret",
} as any;

const payloadWith = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "waba-1",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: "555000111" },
            ...value,
          },
        },
      ],
    },
  ],
});

describe("WhatsAppWebhookUseCase.processWebhook", () => {
  beforeEach(() => {
    clearWhatsappEntitlementCache();
    vi.stubEnv("NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED", "true");
    // Dono da conta COM o módulo no plano (gate por usuário).
    vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
      whatsappEnabledAt: new Date(),
    } as any);
    vi.spyOn(
      WhatsAppRepository,
      "findByPhoneNumberIdWithSecrets",
    ).mockResolvedValue(account);
    // Dedup camada 1 (WebhookEventLog): default = evento NOVO.
    vi.spyOn(prisma.webhookEventLog, "create").mockResolvedValue({} as any);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("mensagem de texto INBOUND: grava com conversa/contato/texto corretos", async () => {
    const recordSpy = vi
      .spyOn(WhatsAppInboxRepository, "recordInboundMessage")
      .mockResolvedValue({
        conversationId: "conv-1",
        messageId: "msg-1",
        duplicated: false,
      });

    await WhatsAppWebhookUseCase.processWebhook(
      payloadWith({
        contacts: [{ profile: { name: "João" }, wa_id: "5547988887777" }],
        messages: [
          {
            id: "wamid.1",
            from: "5547988887777",
            timestamp: "1750000000",
            type: "text",
            text: { body: "olá, tem a peça?" },
          },
        ],
      }) as any,
    );

    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        whatsAppAccountId: "wa-acc-1",
        contactWaId: "5547988887777",
        contactName: "João",
        waMessageId: "wamid.1",
        type: "text",
        text: "olá, tem a peça?",
        timestamp: new Date(1750000000 * 1000),
      }),
    );
  });

  it("evento repetido (P2002 no WebhookEventLog): NÃO grava de novo (idempotência)", async () => {
    (prisma.webhookEventLog.create as any).mockRejectedValue({
      code: "P2002",
    });
    const recordSpy = vi.spyOn(
      WhatsAppInboxRepository,
      "recordInboundMessage",
    );

    await WhatsAppWebhookUseCase.processWebhook(
      payloadWith({
        messages: [
          {
            id: "wamid.1",
            from: "5547988887777",
            timestamp: "1750000000",
            type: "text",
            text: { body: "duplicada" },
          },
        ],
      }) as any,
    );

    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("número não conectado: descarta sem gravar", async () => {
    (
      WhatsAppRepository.findByPhoneNumberIdWithSecrets as any
    ).mockResolvedValue(null);
    const recordSpy = vi.spyOn(
      WhatsAppInboxRepository,
      "recordInboundMessage",
    );

    await WhatsAppWebhookUseCase.processWebhook(
      payloadWith({
        messages: [
          {
            id: "wamid.1",
            from: "x",
            timestamp: "1",
            type: "text",
            text: { body: "y" },
          },
        ],
      }) as any,
    );

    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("dono da conta SEM o módulo no plano: descarta sem gravar", async () => {
    (prisma.user.findUnique as any).mockResolvedValue({
      whatsappEnabledAt: null,
    });
    const recordSpy = vi.spyOn(
      WhatsAppInboxRepository,
      "recordInboundMessage",
    );

    await WhatsAppWebhookUseCase.processWebhook(
      payloadWith({
        messages: [
          {
            id: "wamid.1",
            from: "x",
            timestamp: "1",
            type: "text",
            text: { body: "y" },
          },
        ],
      }) as any,
    );

    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("statuses[]: atualiza o status de entrega (dedup por wamid:status)", async () => {
    const statusSpy = vi
      .spyOn(WhatsAppInboxRepository, "updateMessageStatus")
      .mockResolvedValue(true);
    const claimSpy = prisma.webhookEventLog.create as any;

    await WhatsAppWebhookUseCase.processWebhook(
      payloadWith({
        statuses: [
          {
            id: "wamid.out1",
            status: "delivered",
            timestamp: "1750000100",
            recipient_id: "5547988887777",
          },
        ],
      }) as any,
    );

    expect(statusSpy).toHaveBeenCalledWith("wamid.out1", "delivered", null);
    expect(claimSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: "WHATSAPP",
          externalId: "wamid.out1:delivered",
        }),
      }),
    );
  });

  it("status failed: carrega o errorCode da Meta", async () => {
    const statusSpy = vi
      .spyOn(WhatsAppInboxRepository, "updateMessageStatus")
      .mockResolvedValue(true);

    await WhatsAppWebhookUseCase.processWebhook(
      payloadWith({
        statuses: [
          {
            id: "wamid.out2",
            status: "failed",
            timestamp: "1750000200",
            errors: [{ code: 131047, title: "Re-engagement message" }],
          },
        ],
      }) as any,
    );

    expect(statusSpy).toHaveBeenCalledWith("wamid.out2", "failed", "131047");
  });

  it("mensagem com mídia: baixa via Graph e persiste o caminho privado", async () => {
    vi.spyOn(WhatsAppInboxRepository, "recordInboundMessage").mockResolvedValue(
      { conversationId: "conv-1", messageId: "msg-9", duplicated: false },
    );
    vi.spyOn(WhatsAppApiService, "getMediaInfo").mockResolvedValue({
      url: "https://lookaside.fbsbx.com/temp",
      mimeType: "image/jpeg",
    } as any);
    vi.spyOn(WhatsAppApiService, "downloadMedia").mockResolvedValue(
      Buffer.from("img"),
    );
    const saveSpy = vi
      .spyOn(WhatsAppMediaStorageService.prototype, "saveMedia")
      .mockResolvedValue("/storage/user-1/media/conv-1/msg-9.jpg");
    const pathSpy = vi
      .spyOn(WhatsAppInboxRepository, "setMessageMediaPath")
      .mockResolvedValue();

    await WhatsAppWebhookUseCase.processWebhook(
      payloadWith({
        messages: [
          {
            id: "wamid.img",
            from: "5547988887777",
            timestamp: "1750000300",
            type: "image",
            image: { id: "media-1", mime_type: "image/jpeg", caption: "foto" },
          },
        ],
      }) as any,
    );

    expect(WhatsAppApiService.getMediaInfo).toHaveBeenCalledWith(
      "token-decifrado",
      "media-1",
    );
    expect(saveSpy).toHaveBeenCalledWith(
      "user-1",
      "conv-1",
      "msg-9",
      "image/jpeg",
      expect.any(Buffer),
    );
    expect(pathSpy).toHaveBeenCalledWith(
      "msg-9",
      "/storage/user-1/media/conv-1/msg-9.jpg",
    );
  });

  it("falha no download de mídia NÃO perde a mensagem (fica sem mediaPath)", async () => {
    const recordSpy = vi
      .spyOn(WhatsAppInboxRepository, "recordInboundMessage")
      .mockResolvedValue({
        conversationId: "conv-1",
        messageId: "msg-10",
        duplicated: false,
      });
    vi.spyOn(WhatsAppApiService, "getMediaInfo").mockRejectedValue(
      new Error("URL expirada"),
    );
    const pathSpy = vi.spyOn(WhatsAppInboxRepository, "setMessageMediaPath");

    await expect(
      WhatsAppWebhookUseCase.processWebhook(
        payloadWith({
          messages: [
            {
              id: "wamid.img2",
              from: "5547988887777",
              timestamp: "1750000400",
              type: "image",
              image: { id: "media-2", mime_type: "image/jpeg" },
            },
          ],
        }) as any,
      ),
    ).resolves.toBeUndefined();

    expect(recordSpy).toHaveBeenCalled();
    expect(pathSpy).not.toHaveBeenCalled();
  });
});
