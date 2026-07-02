import crypto from "crypto";
import prisma from "../../lib/prisma";
import { WHATSAPP_CONSTANTS } from "../whatsapp/whatsapp-constants";
import { isWhatsappEnabledFor } from "../whatsapp/whatsapp-entitlement.service";
import { WhatsAppRepository } from "../repositories/whatsapp.repository";
import { WhatsAppInboxRepository } from "../repositories/whatsapp-inbox.repository";
import { WhatsAppApiService } from "../services/whatsapp-api.service";
import { WhatsAppMediaStorageService } from "../services/whatsapp-media-storage.service";

/**
 * Processamento do webhook da WhatsApp Cloud API (campo "messages").
 *
 * Espelha o padrão do webhook.usercase (ML/Shopee/Magalu): a ROTA valida e
 * responde 200 imediato; o processamento roda em background (setImmediate).
 * Diferenças de segurança em relação aos webhooks legados:
 *   - assinatura X-Hub-Signature-256 validada sobre o RAW BODY e BLOQUEANTE
 *     (401 em mismatch) — os legados são log-only/sem validação;
 *   - eventos de contas cujo dono perdeu o entitlement (plano) são DESCARTADOS.
 *
 * Idempotência em duas camadas: WebhookEventLog (@@unique[source, externalId],
 * create+P2002 — mesmo helper pattern do webhook.usercase:53) + o @unique de
 * WhatsAppMessage.waMessageId no insert.
 */

interface WebhookChangeValue {
  messaging_product?: string;
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: Array<Record<string, any>>;
  statuses?: Array<Record<string, any>>;
}

interface WebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{ field?: string; value?: WebhookChangeValue }>;
  }>;
}

/** Idempotência via WebhookEventLog (create + P2002 ⇒ já processado). */
async function claimWebhookEvent(
  externalId: string,
  payload: unknown,
): Promise<boolean> {
  try {
    await (prisma as any).webhookEventLog.create({
      data: {
        source: WHATSAPP_CONSTANTS.WEBHOOK_LOG_SOURCE,
        externalId,
        payload: payload as any,
      },
    });
    return true;
  } catch (err: any) {
    if (err?.code === "P2002") return false;
    throw err;
  }
}

/** Tipos de mensagem com binário para baixar (campo homônimo traz o media id). */
const MEDIA_TYPES = new Set([
  "image",
  "video",
  "audio",
  "document",
  "sticker",
]);

function extractText(msg: Record<string, any>): string | null {
  const type = msg.type as string;
  if (type === "text") return msg.text?.body ?? null;
  if (MEDIA_TYPES.has(type)) {
    // caption (imagem/vídeo/documento) ou filename (documento) viram o texto.
    return msg[type]?.caption ?? msg[type]?.filename ?? null;
  }
  if (type === "button") return msg.button?.text ?? null;
  if (type === "interactive") {
    return (
      msg.interactive?.button_reply?.title ??
      msg.interactive?.list_reply?.title ??
      null
    );
  }
  if (type === "reaction") return msg.reaction?.emoji ?? null;
  if (type === "location") {
    const loc = msg.location;
    if (!loc) return null;
    return `📍 Localização (${loc.latitude}, ${loc.longitude})`;
  }
  return null;
}

function timestampFrom(msg: Record<string, any>): Date {
  const seconds = Number(msg.timestamp);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000);
  return new Date();
}

export class WhatsAppWebhookUseCase {
  /**
   * Valida a assinatura `X-Hub-Signature-256: sha256=<hmac>` sobre o corpo
   * BRUTO com cada segredo candidato (App Secret por conta e/ou global).
   * timingSafeEqual; header ausente/malformado ⇒ inválida (fail-closed).
   */
  static verifySignature(
    rawBody: Buffer,
    signatureHeader: string | undefined,
    secrets: string[],
  ): boolean {
    if (!signatureHeader || secrets.length === 0) return false;
    const match = /^sha256=([0-9a-f]+)$/i.exec(signatureHeader.trim());
    if (!match) return false;
    let received: Buffer;
    try {
      received = Buffer.from(match[1], "hex");
    } catch {
      return false;
    }

    for (const secret of secrets) {
      if (!secret) continue;
      const expected = crypto
        .createHmac("sha256", secret)
        .update(rawBody)
        .digest();
      if (
        expected.length === received.length &&
        crypto.timingSafeEqual(expected, received)
      ) {
        return true;
      }
    }
    return false;
  }

  /** phone_number_ids únicos citados no payload (p/ resolver contas/segredos). */
  static extractPhoneNumberIds(payload: WebhookPayload): string[] {
    const ids = new Set<string>();
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const id = change.value?.metadata?.phone_number_id;
        if (id) ids.add(String(id));
      }
    }
    return [...ids];
  }

  /**
   * Processa o payload em background. Cada change de campo "messages" é
   * roteado para a conta pelo metadata.phone_number_id; conta desconhecida ou
   * dono sem entitlement ⇒ descarte silencioso (log). Erros por mensagem não
   * derrubam o lote (espelha o padrão dos webhooks legados).
   */
  static async processWebhook(payload: WebhookPayload): Promise<void> {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages") continue;
        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!value || !phoneNumberId) continue;

        try {
          await this.processChange(String(phoneNumberId), value);
        } catch (err) {
          console.error(
            `[whatsapp-webhook] Erro processando change do número ${phoneNumberId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  private static async processChange(
    phoneNumberId: string,
    value: WebhookChangeValue,
  ): Promise<void> {
    const account =
      await WhatsAppRepository.findByPhoneNumberIdWithSecrets(phoneNumberId);
    if (!account) {
      console.warn(
        `[whatsapp-webhook] Número ${phoneNumberId} não conectado — evento descartado`,
      );
      return;
    }
    // Gate por plano: dono sem entitlement ⇒ descarta (não grava nada).
    if (!(await isWhatsappEnabledFor(account.userId))) {
      console.warn(
        `[whatsapp-webhook] Tenant ${account.userId} sem módulo WhatsApp — evento descartado`,
      );
      return;
    }

    // Nome de perfil por wa_id (contacts[] acompanha messages[]).
    const nameByWaId = new Map<string, string>();
    for (const contact of value.contacts ?? []) {
      if (contact.wa_id && contact.profile?.name) {
        nameByWaId.set(String(contact.wa_id), contact.profile.name);
      }
    }

    for (const msg of value.messages ?? []) {
      try {
        await this.processInboundMessage(account, msg, nameByWaId);
      } catch (err) {
        console.error(
          `[whatsapp-webhook] Erro na mensagem ${msg?.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    for (const st of value.statuses ?? []) {
      try {
        await this.processStatus(st);
      } catch (err) {
        console.error(
          `[whatsapp-webhook] Erro no status ${st?.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  private static async processInboundMessage(
    account: {
      id: string;
      userId: string;
      accessToken: string;
    },
    msg: Record<string, any>,
    nameByWaId: Map<string, string>,
  ): Promise<void> {
    const waMessageId = msg.id ? String(msg.id) : null;
    const from = msg.from ? String(msg.from) : null;
    if (!waMessageId || !from) return;

    // Dedup camada 1: WebhookEventLog (retries da Meta duram até 7 dias).
    if (!(await claimWebhookEvent(waMessageId, msg))) return;

    const type = String(msg.type ?? "unsupported");
    const media = MEDIA_TYPES.has(type) ? msg[type] : null;

    const result = await WhatsAppInboxRepository.recordInboundMessage({
      whatsAppAccountId: account.id,
      contactWaId: from,
      contactName: nameByWaId.get(from) ?? null,
      waMessageId,
      type,
      text: extractText(msg),
      mediaId: media?.id ? String(media.id) : null,
      mediaMimeType: media?.mime_type ?? null,
      timestamp: timestampFrom(msg),
      raw: msg,
    });

    // Mídia: baixa via Graph (URL temporária ~5min + Bearer) e persiste no
    // storage PRIVADO. Falha não perde a mensagem — fica sem mediaPath e a
    // UI mostra o placeholder.
    if (!result.duplicated && result.messageId && media?.id) {
      try {
        await this.downloadMedia(
          account,
          result.conversationId,
          result.messageId,
          String(media.id),
          media?.mime_type ?? null,
        );
      } catch (err) {
        console.error(
          `[whatsapp-webhook] Falha ao baixar mídia da mensagem ${waMessageId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  private static async downloadMedia(
    account: { userId: string; accessToken: string },
    conversationId: string,
    messageId: string,
    mediaId: string,
    mimeTypeHint: string | null,
  ): Promise<void> {
    const info = await WhatsAppApiService.getMediaInfo(
      account.accessToken,
      mediaId,
    );
    const bytes = await WhatsAppApiService.downloadMedia(
      account.accessToken,
      info.url,
    );
    const storage = new WhatsAppMediaStorageService();
    const mediaPath = await storage.saveMedia(
      account.userId,
      conversationId,
      messageId,
      info.mimeType ?? mimeTypeHint,
      bytes,
    );
    await WhatsAppInboxRepository.setMessageMediaPath(messageId, mediaPath);
  }

  private static async processStatus(st: Record<string, any>): Promise<void> {
    const waMessageId = st.id ? String(st.id) : null;
    const status = st.status ? String(st.status) : null;
    if (!waMessageId || !status) return;

    // Dedup por (wamid, status) — cada transição chega num webhook próprio.
    if (!(await claimWebhookEvent(`${waMessageId}:${status}`, st))) return;

    const errorCode = st.errors?.[0]?.code != null
      ? String(st.errors[0].code)
      : null;
    await WhatsAppInboxRepository.updateMessageStatus(
      waMessageId,
      status,
      errorCode,
    );
  }
}
