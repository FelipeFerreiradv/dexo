import axios from "axios";
import { WHATSAPP_CONSTANTS } from "../whatsapp/whatsapp-constants";

/**
 * Cliente HTTP da WhatsApp Cloud API (Graph API oficial da Meta).
 *
 * Espelha o estilo dos services de marketplace (axios + Bearer + formatError);
 * o accessToken é injetado pelo caller (a decifra fica no WhatsAppRepository).
 * Endpoints validados contra a doc oficial em 2026-07 (Graph v25.0):
 *   - POST /{phone_number_id}/messages    (texto, mark-as-read)
 *   - GET  /{phone_number_id}?fields=...  (validação de conta/token)
 *   - GET  /{media_id}                    (URL temporária ~5min de mídia)
 *   - POST /{waba_id}/subscribed_apps     (assinar webhooks da WABA)
 *   - POST /{phone_number_id}/register    (registro com PIN)
 *   - GET  /oauth/access_token            (troca de code — Embedded Signup futuro)
 *
 * Erros da Graph API chegam como { error: { message, code, error_subcode,
 * error_data.details } }; expomos `status` (HTTP) e `graphCode` no Error para
 * a camada acima mapear (ex.: 131047 = janela de 24h fechada → 409).
 */

export interface WhatsAppSendResult {
  /** wamid da mensagem aceita (idempotência/local echo). */
  messageId: string;
  /** wa_id canônico do destinatário (pode diferir do número enviado). */
  recipientWaId?: string;
}

export interface WhatsAppPhoneNumberInfo {
  id: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  qualityRating?: string;
}

export interface WhatsAppMediaInfo {
  url: string;
  mimeType?: string;
  fileSize?: number;
  sha256?: string;
}

export class WhatsAppApiService {
  private static graphUrl(path: string): string {
    return `${WHATSAPP_CONSTANTS.GRAPH_BASE_URL}/${WHATSAPP_CONSTANTS.API_VERSION}/${path}`;
  }

  private static authHeaders(accessToken: string) {
    return {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private static formatError(prefix: string, error: unknown): Error {
    if (axios.isAxiosError(error)) {
      const data: any = error.response?.data;
      const graph = data?.error;
      const msg =
        graph?.error_data?.details || graph?.message || error.message;
      const e = new Error(`${prefix}: ${msg}`);
      (e as { status?: number }).status = error.response?.status;
      (e as { graphCode?: number }).graphCode = graph?.code;
      (e as { graphSubcode?: number }).graphSubcode = graph?.error_subcode;
      (e as { responseData?: unknown }).responseData = data;
      return e;
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * POST /{phone_number_id}/messages — texto livre (type=text). Só entrega com
   * a janela de 24h aberta; a resposta é ACEITAÇÃO (entrega vem por webhook).
   */
  static async sendText(
    accessToken: string,
    phoneNumberId: string,
    to: string,
    body: string,
  ): Promise<WhatsAppSendResult> {
    try {
      const resp = await axios.post(
        this.graphUrl(`${encodeURIComponent(phoneNumberId)}/messages`),
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { preview_url: false, body },
        },
        {
          headers: this.authHeaders(accessToken),
          timeout: WHATSAPP_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
      const data: any = resp.data;
      return {
        messageId: data?.messages?.[0]?.id ?? "",
        recipientWaId: data?.contacts?.[0]?.wa_id,
      };
    } catch (error) {
      throw this.formatError("Erro ao enviar mensagem WhatsApp", error);
    }
  }

  /**
   * POST /{phone_number_id}/messages com {status:"read"} — marca a mensagem
   * (e as anteriores da conversa) como lida no WhatsApp do cliente.
   */
  static async markRead(
    accessToken: string,
    phoneNumberId: string,
    messageId: string,
  ): Promise<void> {
    try {
      await axios.post(
        this.graphUrl(`${encodeURIComponent(phoneNumberId)}/messages`),
        {
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
        },
        {
          headers: this.authHeaders(accessToken),
          timeout: WHATSAPP_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
    } catch (error) {
      throw this.formatError(
        `Erro ao marcar mensagem ${messageId} como lida`,
        error,
      );
    }
  }

  /**
   * GET /{phone_number_id}?fields=... — valida token+número e devolve os
   * metadados exibidos na UI de conexão (usado no connect e no "testar").
   */
  static async getPhoneNumberInfo(
    accessToken: string,
    phoneNumberId: string,
  ): Promise<WhatsAppPhoneNumberInfo> {
    try {
      const resp = await axios.get(
        this.graphUrl(encodeURIComponent(phoneNumberId)),
        {
          params: {
            fields: "id,display_phone_number,verified_name,quality_rating",
          },
          headers: this.authHeaders(accessToken),
          timeout: WHATSAPP_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
      const data: any = resp.data;
      return {
        id: String(data?.id ?? phoneNumberId),
        displayPhoneNumber: data?.display_phone_number,
        verifiedName: data?.verified_name,
        qualityRating: data?.quality_rating,
      };
    } catch (error) {
      throw this.formatError(
        `Erro ao consultar o número ${phoneNumberId}`,
        error,
      );
    }
  }

  /**
   * GET /{media_id} — troca o media id (do webhook) por uma URL temporária
   * (~5 minutos). O download em si também exige o Bearer (downloadMedia).
   */
  static async getMediaInfo(
    accessToken: string,
    mediaId: string,
  ): Promise<WhatsAppMediaInfo> {
    try {
      const resp = await axios.get(
        this.graphUrl(encodeURIComponent(mediaId)),
        {
          headers: this.authHeaders(accessToken),
          timeout: WHATSAPP_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
      const data: any = resp.data;
      if (!data?.url) {
        throw new Error(`Graph não devolveu URL para a mídia ${mediaId}`);
      }
      return {
        url: data.url,
        mimeType: data.mime_type,
        fileSize: data.file_size ? Number(data.file_size) : undefined,
        sha256: data.sha256,
      };
    } catch (error) {
      throw this.formatError(`Erro ao resolver mídia ${mediaId}`, error);
    }
  }

  /** Baixa o binário da mídia (URL temporária + Bearer obrigatório). */
  static async downloadMedia(
    accessToken: string,
    url: string,
  ): Promise<Buffer> {
    try {
      const resp = await axios.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: WHATSAPP_CONSTANTS.REQUEST_TIMEOUT,
        maxContentLength: 100 * 1024 * 1024, // teto da Cloud API (100MB)
      });
      return Buffer.from(resp.data);
    } catch (error) {
      throw this.formatError("Erro ao baixar mídia WhatsApp", error);
    }
  }

  /**
   * POST /{waba_id}/subscribed_apps — assina o app aos webhooks da WABA.
   * Necessário 1x por WABA conectada (manual ou Embedded Signup).
   */
  static async subscribeApp(
    accessToken: string,
    wabaId: string,
  ): Promise<void> {
    try {
      await axios.post(
        this.graphUrl(`${encodeURIComponent(wabaId)}/subscribed_apps`),
        {},
        {
          headers: this.authHeaders(accessToken),
          timeout: WHATSAPP_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
    } catch (error) {
      throw this.formatError(
        `Erro ao assinar webhooks da WABA ${wabaId}`,
        error,
      );
    }
  }

  /**
   * POST /{phone_number_id}/register — registra o número na Cloud API (PIN de
   * verificação em 2 etapas). Não usado no MVP manual (números já registrados
   * pelo próprio cliente); fica pronto para o Embedded Signup.
   */
  static async registerPhone(
    accessToken: string,
    phoneNumberId: string,
    pin: string,
  ): Promise<void> {
    try {
      await axios.post(
        this.graphUrl(`${encodeURIComponent(phoneNumberId)}/register`),
        { messaging_product: "whatsapp", pin },
        {
          headers: this.authHeaders(accessToken),
          timeout: WHATSAPP_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
    } catch (error) {
      throw this.formatError(
        `Erro ao registrar o número ${phoneNumberId}`,
        error,
      );
    }
  }

  /**
   * GET /oauth/access_token — troca o `code` do Embedded Signup (TTL 30s!) por
   * um Business Integration System User token. Seam da fase futura; não é
   * chamado no MVP manual.
   */
  static async exchangeCode(code: string): Promise<string> {
    try {
      const resp = await axios.get(this.graphUrl("oauth/access_token"), {
        params: {
          client_id: WHATSAPP_CONSTANTS.APP_ID,
          client_secret: WHATSAPP_CONSTANTS.APP_SECRET,
          code,
        },
        timeout: WHATSAPP_CONSTANTS.REQUEST_TIMEOUT,
      });
      const token = (resp.data as any)?.access_token;
      if (!token) throw new Error("Graph não devolveu access_token");
      return token;
    } catch (error) {
      throw this.formatError("Erro ao trocar code do Embedded Signup", error);
    }
  }
}
