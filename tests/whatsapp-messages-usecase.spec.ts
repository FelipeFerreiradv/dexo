import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AccountStatus } from "@prisma/client";

import { WhatsAppMessagesUseCase } from "@/app/marketplaces/usecases/whatsapp-messages.usecase";
import { WhatsAppRepository } from "@/app/marketplaces/repositories/whatsapp.repository";
import { WhatsAppInboxRepository } from "@/app/marketplaces/repositories/whatsapp-inbox.repository";
import { WhatsAppApiService } from "@/app/marketplaces/services/whatsapp-api.service";

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
  appSecret: null,
} as any;

const conversationOpen = {
  id: "conv-1",
  whatsAppAccountId: "wa-acc-1",
  contactWaId: "5547988887777",
  contactName: "João",
  lastMessageAt: new Date(),
  serviceWindowExpiresAt: new Date(Date.now() + 60 * 60 * 1000), // +1h
} as any;

describe("WhatsAppMessagesUseCase.sendText — janela de 24h e envio", () => {
  beforeEach(() => {
    vi.spyOn(
      WhatsAppRepository,
      "findWithSecretsByIdAndUser",
    ).mockResolvedValue(account);
    vi.spyOn(
      WhatsAppInboxRepository,
      "findConversationForAccount",
    ).mockResolvedValue(conversationOpen);
    vi.spyOn(WhatsAppInboxRepository, "recordOutboundMessage").mockResolvedValue(
      "msg-local-1",
    );
    vi.spyOn(WhatsAppRepository, "updateStatus").mockResolvedValue();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("janela aberta: envia via Graph e grava OUTBOUND com o wamid", async () => {
    const sendSpy = vi
      .spyOn(WhatsAppApiService, "sendText")
      .mockResolvedValue({ messageId: "wamid.out1" });

    const result = await WhatsAppMessagesUseCase.sendText(
      "user-1",
      "wa-acc-1",
      "conv-1",
      "  Olá! Temos a peça sim.  ",
    );

    expect(sendSpy).toHaveBeenCalledWith(
      "token-decifrado",
      "555000111",
      "5547988887777",
      "Olá! Temos a peça sim.",
    );
    expect(
      WhatsAppInboxRepository.recordOutboundMessage,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        waMessageId: "wamid.out1",
        text: "Olá! Temos a peça sim.",
      }),
    );
    expect(result).toEqual({ success: true, waMessageId: "wamid.out1" });
  });

  it("janela FECHADA (expirada): 409 sem chamar a Graph", async () => {
    (
      WhatsAppInboxRepository.findConversationForAccount as any
    ).mockResolvedValue({
      ...conversationOpen,
      serviceWindowExpiresAt: new Date(Date.now() - 1000),
    });
    const sendSpy = vi.spyOn(WhatsAppApiService, "sendText");

    await expect(
      WhatsAppMessagesUseCase.sendText("user-1", "wa-acc-1", "conv-1", "oi"),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("janela nunca aberta (NULL): 409", async () => {
    (
      WhatsAppInboxRepository.findConversationForAccount as any
    ).mockResolvedValue({
      ...conversationOpen,
      serviceWindowExpiresAt: null,
    });

    await expect(
      WhatsAppMessagesUseCase.sendText("user-1", "wa-acc-1", "conv-1", "oi"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("texto vazio: 400", async () => {
    await expect(
      WhatsAppMessagesUseCase.sendText("user-1", "wa-acc-1", "conv-1", "   "),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("texto acima de 4096 chars: 400", async () => {
    await expect(
      WhatsAppMessagesUseCase.sendText(
        "user-1",
        "wa-acc-1",
        "conv-1",
        "x".repeat(4097),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("conta de outro tenant: 404 (posse)", async () => {
    (WhatsAppRepository.findWithSecretsByIdAndUser as any).mockResolvedValue(
      null,
    );

    await expect(
      WhatsAppMessagesUseCase.sendText("user-2", "wa-acc-1", "conv-1", "oi"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("conversa inexistente na conta: 404", async () => {
    (
      WhatsAppInboxRepository.findConversationForAccount as any
    ).mockResolvedValue(null);

    await expect(
      WhatsAppMessagesUseCase.sendText("user-1", "wa-acc-1", "conv-x", "oi"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("corrida local×remoto: Graph devolve 131047 ⇒ 409 (mesma mensagem da janela)", async () => {
    const err: any = new Error("Re-engagement message");
    err.graphCode = 131047;
    vi.spyOn(WhatsAppApiService, "sendText").mockRejectedValue(err);

    await expect(
      WhatsAppMessagesUseCase.sendText("user-1", "wa-acc-1", "conv-1", "oi"),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(WhatsAppInboxRepository.recordOutboundMessage).not.toHaveBeenCalled();
  });

  it("token inválido (HTTP 401): marca a conta ERROR e devolve 502", async () => {
    const err: any = new Error("Invalid OAuth access token");
    err.status = 401;
    vi.spyOn(WhatsAppApiService, "sendText").mockRejectedValue(err);

    await expect(
      WhatsAppMessagesUseCase.sendText("user-1", "wa-acc-1", "conv-1", "oi"),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(WhatsAppRepository.updateStatus).toHaveBeenCalledWith(
      "wa-acc-1",
      AccountStatus.ERROR,
    );
  });
});
