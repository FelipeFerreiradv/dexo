import axios from "axios";
import { MAGALU_CONSTANTS } from "../magalu/magalu-constants";
import type {
  MagaluSku,
  MagaluSkuListParams,
  MagaluSkuListResponse,
} from "../types/magalu-api.types";

/**
 * Cliente HTTP autenticado da API de Marketplace da Magalu.
 *
 * Espelha o estilo do MLApiService (axios + `Authorization: Bearer`), pois a
 * Magalu usa access_token JWT padrão OAuth — NÃO assina cada request como a
 * Shopee. Constantes em magalu-constants.ts.
 *
 * ATENÇÃO: endpoints/payloads de estoque, preço, listagem e categorias da Open
 * API da Magalu não puderam ser 100% confirmados sem Sandbox. Os métodos abaixo
 * seguem os padrões documentados (/seller/v1/portfolios/*) e estão marcados com
 * TODO onde precisam de validação contra a API real. A construção das requests
 * (URL + Bearer + corpo) é coberta por testes unitários (Entrega G).
 */
export class MagaluApiService {
  private static authHeaders(accessToken: string) {
    return {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };
  }

  private static formatError(prefix: string, error: unknown): Error {
    if (axios.isAxiosError(error)) {
      const data: any = error.response?.data;
      const apiMessage =
        data?.error_description ||
        data?.message ||
        data?.error ||
        (Array.isArray(data?.errors) ? JSON.stringify(data.errors) : "") ||
        error.message;
      const wrapped = new Error(`${prefix}: ${apiMessage}`);
      (wrapped as any).status = error.response?.status;
      (wrapped as any).responseData = error.response?.data;
      (wrapped as any).cause = error;
      return wrapped;
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * Lista SKUs/anúncios do portfólio do seller (paginado).
   * TODO(validar): formato da resposta (results vs data) e paginação real.
   */
  static async listSkus(
    accessToken: string,
    params: MagaluSkuListParams = {},
  ): Promise<MagaluSku[]> {
    try {
      const url = new URL(
        MAGALU_CONSTANTS.PORTFOLIO_SKUS_ENDPOINT,
        MAGALU_CONSTANTS.API_URL,
      );
      url.searchParams.set(
        "limit",
        String(params.limit ?? MAGALU_CONSTANTS.DEFAULT_PAGE_SIZE),
      );
      if (params.offset != null)
        url.searchParams.set("offset", String(params.offset));
      if (params.cursor) url.searchParams.set("cursor", params.cursor);

      const response = await axios.get<MagaluSkuListResponse>(url.toString(), {
        headers: this.authHeaders(accessToken),
        timeout: MAGALU_CONSTANTS.REQUEST_TIMEOUT,
      });

      const body = response.data;
      return body.results ?? body.data ?? [];
    } catch (error) {
      throw this.formatError("Erro ao listar SKUs da Magalu", error);
    }
  }

  /**
   * Busca um SKU específico do portfólio.
   * TODO(validar): caminho exato do recurso por id.
   */
  static async getSku(accessToken: string, skuId: string): Promise<MagaluSku> {
    try {
      const response = await axios.get<MagaluSku>(
        `${MAGALU_CONSTANTS.API_URL}${MAGALU_CONSTANTS.PORTFOLIO_SKUS_ENDPOINT}/${encodeURIComponent(skuId)}`,
        {
          headers: this.authHeaders(accessToken),
          timeout: MAGALU_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
      return response.data;
    } catch (error) {
      throw this.formatError("Erro ao buscar SKU da Magalu", error);
    }
  }

  /**
   * Atualiza o estoque de um SKU.
   * TODO(validar): a Magalu usa um serviço de estoque separado; confirmar
   * método (PUT/PATCH), caminho e nome do campo de quantidade.
   */
  static async updateStock(
    accessToken: string,
    sku: string,
    quantity: number,
  ): Promise<void> {
    try {
      await axios.put(
        `${MAGALU_CONSTANTS.API_URL}${MAGALU_CONSTANTS.PORTFOLIO_STOCKS_ENDPOINT}`,
        { sku, quantity },
        {
          headers: this.authHeaders(accessToken),
          timeout: MAGALU_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
    } catch (error) {
      throw this.formatError("Erro ao atualizar estoque na Magalu", error);
    }
  }

  /**
   * Atualiza o preço de um SKU.
   * TODO(validar): serviço de preço separado; confirmar método/caminho/campo.
   */
  static async updatePrice(
    accessToken: string,
    sku: string,
    price: number,
  ): Promise<void> {
    try {
      await axios.put(
        `${MAGALU_CONSTANTS.API_URL}${MAGALU_CONSTANTS.PORTFOLIO_PRICES_ENDPOINT}`,
        { sku, price },
        {
          headers: this.authHeaders(accessToken),
          timeout: MAGALU_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
    } catch (error) {
      throw this.formatError("Erro ao atualizar preço na Magalu", error);
    }
  }
}
