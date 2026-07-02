import { AccountStatus } from "@prisma/client";
import { WHATSAPP_CONSTANTS } from "../whatsapp/whatsapp-constants";
import { WhatsAppRepository } from "../repositories/whatsapp.repository";
import { WhatsAppInboxRepository } from "../repositories/whatsapp-inbox.repository";
import { WhatsAppApiService } from "../services/whatsapp-api.service";

/**
 * Envio de mensagens do canal WhatsApp (MVP: texto livre dentro da janela de
 * 24h da Cloud API; templates/mídia ficam para uma fase futura).
 *
 * Regras espelhadas do MessagesUseCase (ML/Shopee/Magalu): erros carregam
 * `statusCode` para a rota mapear (400 validação, 404 posse, 409 estado).
 */

function httpError(statusCode: number, message: string): Error {
  const err = new Error(message);
  (err as { statusCode?: number }).statusCode = statusCode;
  return err;
}

export class WhatsAppMessagesUseCase {
  /**
   * Envia texto livre na conversa. Fluxo:
   *   1. posse conta (tenant) + posse conversa (conta) — 404;
   *   2. valida texto (trim, limite 4096 da Cloud API) — 400;
   *   3. janela de 24h LOCAL (serviceWindowExpiresAt) — 409 se fechada
   *      (a Graph também rejeitaria com 131047; validar antes economiza a
   *      chamada e dá mensagem clara);
   *   4. POST Graph → wamid; token inválido ⇒ conta status ERROR;
   *   5. grava OUTBOUND local (ticks atualizam via webhook `statuses`).
   */
  static async sendText(
    userId: string,
    whatsAppAccountId: string,
    conversationId: string,
    rawText: string,
  ): Promise<{ success: true; waMessageId: string }> {
    const text = rawText?.trim();
    if (!text) {
      throw httpError(400, "Mensagem vazia");
    }
    if (text.length > WHATSAPP_CONSTANTS.TEXT_MAX_LENGTH) {
      throw httpError(
        400,
        `Mensagem excede o limite de ${WHATSAPP_CONSTANTS.TEXT_MAX_LENGTH} caracteres do WhatsApp`,
      );
    }

    const account = await WhatsAppRepository.findWithSecretsByIdAndUser(
      whatsAppAccountId,
      userId,
    );
    if (!account) {
      throw httpError(404, "Conta não encontrada");
    }

    const conversation =
      await WhatsAppInboxRepository.findConversationForAccount(
        whatsAppAccountId,
        conversationId,
      );
    if (!conversation) {
      throw httpError(404, "Conversa não encontrada");
    }

    const windowExpiresAt = conversation.serviceWindowExpiresAt;
    if (!windowExpiresAt || windowExpiresAt.getTime() <= Date.now()) {
      throw httpError(
        409,
        "A janela de atendimento de 24h fechou — aguarde o cliente enviar uma nova mensagem",
      );
    }

    let sent;
    try {
      sent = await WhatsAppApiService.sendText(
        account.accessToken,
        account.phoneNumberId,
        conversation.contactWaId,
        text,
      );
    } catch (err: any) {
      // Janela fechada do lado da Meta (corrida local×remoto) ⇒ mesmo 409.
      if (err?.graphCode === WHATSAPP_CONSTANTS.ERROR_CODE_OUTSIDE_WINDOW) {
        throw httpError(
          409,
          "A janela de atendimento de 24h fechou — aguarde o cliente enviar uma nova mensagem",
        );
      }
      // Token inválido/revogado ⇒ conta em ERROR (a UI de integração orienta).
      if (err?.status === 401 || err?.status === 403 || err?.graphCode === 190) {
        await WhatsAppRepository.updateStatus(account.id, AccountStatus.ERROR);
        throw httpError(
          502,
          "Token da conta WhatsApp inválido/revogado — reconecte o número em Integrações",
        );
      }
      throw httpError(502, err?.message ?? "Erro ao enviar mensagem WhatsApp");
    }

    if (!sent.messageId) {
      throw httpError(502, "A Meta não devolveu o id da mensagem enviada");
    }

    // A mensagem JÁ foi entregue à Meta (temos o wamid). Se a gravação local
    // falhar, NÃO propagamos erro: um 5xx faria o cliente reenviar e o texto
    // chegaria DUPLICADO ao contato. Preferimos logar e reportar sucesso — a
    // mensagem enviada é o efeito colateral irreversível que manda. (O eco
    // local é cosmético; o próximo webhook/refresh reconcilia.)
    try {
      await WhatsAppInboxRepository.recordOutboundMessage({
        conversationId: conversation.id,
        waMessageId: sent.messageId,
        text,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error(
        `[whatsapp] Mensagem ${sent.messageId} enviada à Meta mas falhou ao gravar localmente (evitando reenvio):`,
        err instanceof Error ? err.message : err,
      );
    }

    return { success: true, waMessageId: sent.messageId };
  }
}
