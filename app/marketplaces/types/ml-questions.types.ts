/**
 * Tipos da API de Perguntas/Respostas do Mercado Livre.
 * Doc: https://developers.mercadolivre.com.br/pt_br/perguntas-e-respostas
 */

import { MLWebhookPayload } from "./ml-order.types";

export type MLQuestionStatus =
  | "UNANSWERED"
  | "ANSWERED"
  | "CLOSED_UNANSWERED"
  | "UNDER_REVIEW"
  | "BANNED"
  | "DELETED";

export type MLAnswerStatus = "ACTIVE" | "DELETED" | "DISABLED";

export interface MLAnswer {
  text: string;
  status: MLAnswerStatus;
  date_created: string;
}

export interface MLQuestionFromBuyer {
  id: number;
  nickname?: string;
}

/**
 * Resposta crua do ML para GET /questions/{id} ou itens de /questions/search.
 * Campos opcionais refletem variações entre endpoints.
 */
export interface MLQuestion {
  id: number;
  text: string;
  status: MLQuestionStatus;
  date_created: string;
  item_id: string;
  seller_id: number;
  from?: MLQuestionFromBuyer;
  answer?: MLAnswer | null;
  deleted_from_listing?: boolean;
  hold?: boolean;
  tags?: string[];
}

export interface MLQuestionsSearchResponse {
  total: number;
  limit: number;
  offset: number;
  questions: MLQuestion[];
  filters?: Record<string, unknown>;
  available_filters?: unknown[];
  available_sorts?: unknown[];
}

/** Body do POST /answers. */
export interface MLPostAnswerPayload {
  question_id: number;
  text: string;
}

/** Webhook do ML quando a pergunta é criada/atualizada. */
export interface MLQuestionWebhookPayload extends MLWebhookPayload {
  topic: "questions";
  resource: string; // "/questions/{id}"
}
