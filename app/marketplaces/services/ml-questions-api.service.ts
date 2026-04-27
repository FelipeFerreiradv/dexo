import axios from "axios";
import { ML_CONSTANTS } from "../mercado-livre/ml-constants";
import {
  MLQuestion,
  MLQuestionsSearchResponse,
  MLPostAnswerPayload,
} from "../types/ml-questions.types";

/**
 * Cliente HTTP para a API de Perguntas/Respostas do Mercado Livre.
 *
 * Padrão: o accessToken é injetado por quem chama (igual MLApiService).
 * A camada acima (MessagesUseCase) é responsável por resolver a conta,
 * verificar expiração e chamar MLOAuthService.refreshAccessTokenForAccount.
 */
export class MlQuestionsApiService {
  private static authHeaders(accessToken: string) {
    return { Authorization: `Bearer ${accessToken}` };
  }

  private static formatAxiosError(prefix: string, error: unknown): Error {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const data = error.response?.data;
      const msg =
        (data && typeof data === "object" && (data as any).message) ||
        error.message;
      const err = new Error(`${prefix}: ${msg}`);
      (err as any).status = status;
      (err as any).mlError = data;
      return err;
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * GET /questions/{id} — fetch de uma pergunta específica
   * (usado pelo handler de webhook).
   */
  static async getQuestion(
    accessToken: string,
    externalQuestionId: string,
  ): Promise<MLQuestion> {
    try {
      const res = await axios.get<MLQuestion>(
        `${ML_CONSTANTS.API_URL}/questions/${externalQuestionId}`,
        { headers: this.authHeaders(accessToken), timeout: 10_000 },
      );
      return res.data;
    } catch (error) {
      throw this.formatAxiosError(
        `Erro ao buscar pergunta ${externalQuestionId}`,
        error,
      );
    }
  }

  /**
   * GET /questions/search?item={MLB} — todas as perguntas de um anúncio.
   * Suporta paginação via offset/limit (ML aceita até 50 por página).
   */
  static async searchQuestionsByItem(
    accessToken: string,
    itemId: string,
    opts: { offset?: number; limit?: number } = {},
  ): Promise<MLQuestionsSearchResponse> {
    try {
      const res = await axios.get<MLQuestionsSearchResponse>(
        `${ML_CONSTANTS.API_URL}/questions/search`,
        {
          headers: this.authHeaders(accessToken),
          params: {
            item: itemId,
            offset: opts.offset ?? 0,
            limit: Math.min(opts.limit ?? 50, 50),
            sort_fields: "date_created",
            sort_types: "DESC",
          },
          timeout: 15_000,
        },
      );
      return res.data;
    } catch (error) {
      throw this.formatAxiosError(
        `Erro ao listar perguntas do item ${itemId}`,
        error,
      );
    }
  }

  /**
   * POST /answers — responde a uma pergunta.
   * ML retorna a pergunta atualizada (já com answer preenchida).
   */
  static async postAnswer(
    accessToken: string,
    externalQuestionId: string,
    text: string,
  ): Promise<MLQuestion> {
    const body: MLPostAnswerPayload = {
      question_id: Number(externalQuestionId),
      text,
    };
    try {
      const res = await axios.post<MLQuestion>(
        `${ML_CONSTANTS.API_URL}/answers`,
        body,
        {
          headers: {
            ...this.authHeaders(accessToken),
            "Content-Type": "application/json",
          },
          timeout: 15_000,
        },
      );
      return res.data;
    } catch (error) {
      throw this.formatAxiosError(
        `Erro ao responder pergunta ${externalQuestionId}`,
        error,
      );
    }
  }
}
