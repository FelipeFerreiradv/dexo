import axios from "axios";
import { MAGALU_CONSTANTS } from "../magalu/magalu-constants";

/**
 * Cliente HTTP do "Chat com Cliente" da Magalu (services.magalu.com/v0).
 *
 * Diferente das demais APIs Magalu (api.magalu.com), o Chat vive em
 * services.magalu.com e modela CONVERSAS (N mensagens), não Perguntas&Respostas
 * 1:1. Bearer; escopos services:conversations-seller:read/write (o client
 * precisa TÊ-LOS e a conta precisa reautorizar). O accessToken é injetado pelo
 * caller (igual MlQuestionsApiService); o refresh fica na camada acima.
 *
 * ATENÇÃO: shapes confirmados na DOC (2026-06-30), não contra a API real ainda —
 * tipos defensivos. Validar contra uma conta real (como o resto da Magalu).
 */

export interface MagaluChatUser {
  id?: string;
  external_id?: string;
  full_name?: string;
  full_name_normalized?: string;
  type?: "CUSTOMER" | "SELLER" | string;
  [key: string]: unknown;
}

export interface MagaluChatMessage {
  id?: string;
  external_id?: string;
  content?: string;
  from_user?: MagaluChatUser;
  to_user?: MagaluChatUser;
  when_at?: string;
  attachments?: string[];
  moderation?: { status?: string; when_at?: string };
  read_by?: string[];
  integration?: boolean;
  [key: string]: unknown;
}

export interface MagaluConversation {
  id?: string;
  channel?: string;
  display_name?: string;
  from_user?: MagaluChatUser;
  to_user?: MagaluChatUser;
  owner?: { external_id?: string; name?: string };
  status?: string; // OPENED | CLOSED
  // MinimalMessage: id/from_user/content/when_at. Usado pelo polling p/ gravar a
  // última mensagem sem um GET por conversa.
  last_message?: {
    id?: string;
    external_id?: string;
    from_user?: MagaluChatUser;
    content?: string;
    when_at?: string;
    [key: string]: unknown;
  };
  unread_to_count?: number;
  unread_from_count?: number;
  last_interaction_at?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

interface MagaluListResponse<T> {
  results?: T[];
  meta?: { page?: { total?: number; count?: number; limit?: number } };
  [key: string]: unknown;
}

export class MagaluChatApiService {
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
      const msg =
        data?.error_description ||
        data?.message ||
        data?.detail ||
        error.message;
      const e = new Error(`${prefix}: ${msg}`);
      (e as { status?: number }).status = error.response?.status;
      (e as { responseData?: unknown }).responseData = data;
      return e;
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /** GET /v0/conversations — lista conversas (default status OPENED). */
  static async listConversations(
    accessToken: string,
    opts: {
      status?: string;
      channelId?: string;
      offset?: number;
      limit?: number;
    } = {},
  ): Promise<{ conversations: MagaluConversation[]; total: number }> {
    try {
      const url = new URL(
        MAGALU_CONSTANTS.CONVERSATIONS_ENDPOINT,
        MAGALU_CONSTANTS.SERVICES_URL,
      );
      url.searchParams.set("status", opts.status ?? "OPENED");
      if (opts.channelId) url.searchParams.set("channel__id", opts.channelId);
      url.searchParams.set("_offset", String(opts.offset ?? 0));
      url.searchParams.set(
        "_limit",
        String(Math.min(opts.limit ?? 50, 100)),
      );
      const resp = await axios.get<MagaluListResponse<MagaluConversation>>(
        url.toString(),
        {
          headers: this.authHeaders(accessToken),
          timeout: MAGALU_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
      const body = resp.data;
      return {
        conversations: body?.results ?? [],
        total: body?.meta?.page?.total ?? body?.results?.length ?? 0,
      };
    } catch (error) {
      throw this.formatError("Erro ao listar conversas Magalu", error);
    }
  }

  /** GET /v0/conversations/:id/messages — mensagens de uma conversa. */
  static async listMessages(
    accessToken: string,
    conversationId: string,
    opts: { offset?: number; limit?: number } = {},
  ): Promise<{ messages: MagaluChatMessage[]; total: number }> {
    try {
      const url = new URL(
        `${MAGALU_CONSTANTS.CONVERSATIONS_ENDPOINT}/${encodeURIComponent(
          conversationId,
        )}/messages`,
        MAGALU_CONSTANTS.SERVICES_URL,
      );
      url.searchParams.set("_offset", String(opts.offset ?? 0));
      url.searchParams.set("_limit", String(Math.min(opts.limit ?? 100, 100)));
      const resp = await axios.get<MagaluListResponse<MagaluChatMessage>>(
        url.toString(),
        {
          headers: this.authHeaders(accessToken),
          timeout: MAGALU_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
      const body = resp.data;
      return {
        messages: body?.results ?? [],
        total: body?.meta?.page?.total ?? body?.results?.length ?? 0,
      };
    } catch (error) {
      throw this.formatError(
        `Erro ao listar mensagens da conversa ${conversationId}`,
        error,
      );
    }
  }

  /**
   * POST /v0/conversations/:id/messages — insere (responde) uma mensagem. O
   * `owner` é o DESTINATÁRIO (o cliente): external_id + name vêm da conversa.
   */
  static async replyMessage(
    accessToken: string,
    conversationId: string,
    body: {
      content: string;
      owner: { external_id: string; name: string };
      externalId?: string;
    },
  ): Promise<MagaluChatMessage> {
    try {
      const url = `${MAGALU_CONSTANTS.SERVICES_URL}${
        MAGALU_CONSTANTS.CONVERSATIONS_ENDPOINT
      }/${encodeURIComponent(conversationId)}/messages`;
      const resp = await axios.post<MagaluChatMessage>(
        url,
        {
          content: body.content,
          ...(body.externalId ? { external_id: body.externalId } : {}),
          owner: { external_id: body.owner.external_id, name: body.owner.name },
        },
        {
          headers: this.authHeaders(accessToken),
          timeout: MAGALU_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
      return resp.data;
    } catch (error) {
      throw this.formatError(
        `Erro ao responder a conversa ${conversationId}`,
        error,
      );
    }
  }

  /** PATCH /v0/conversations/:id/read_by — marca a conversa como lida. */
  static async markRead(
    accessToken: string,
    conversationId: string,
  ): Promise<void> {
    try {
      const url = `${MAGALU_CONSTANTS.SERVICES_URL}${
        MAGALU_CONSTANTS.CONVERSATIONS_ENDPOINT
      }/${encodeURIComponent(conversationId)}/read_by`;
      await axios.patch(
        url,
        {},
        {
          headers: this.authHeaders(accessToken),
          timeout: MAGALU_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
    } catch (error) {
      throw this.formatError(
        `Erro ao marcar conversa ${conversationId} como lida`,
        error,
      );
    }
  }
}
