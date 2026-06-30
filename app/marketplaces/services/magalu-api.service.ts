import axios from "axios";
import { MAGALU_CONSTANTS } from "../magalu/magalu-constants";
import type {
  MagaluSku,
  MagaluSkuListParams,
  MagaluSkuListResponse,
} from "../types/magalu-api.types";
import type {
  MagaluOrder,
  MagaluOrderListResponse,
} from "../types/magalu-order.types";

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

  /**
   * Cria um SKU no portfólio do seller (POST /seller/v1/portfolios/skus).
   * A API responde 202 (assíncrono) — a resposta pode não conter o id final.
   * TODO(validar): contrato exato do corpo e da resposta.
   */
  static async createSku(
    accessToken: string,
    payload: unknown,
  ): Promise<MagaluSku> {
    try {
      const response = await axios.post<MagaluSku>(
        `${MAGALU_CONSTANTS.API_URL}${MAGALU_CONSTANTS.PORTFOLIO_SKUS_ENDPOINT}`,
        payload,
        {
          headers: this.authHeaders(accessToken),
          timeout: MAGALU_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
      return response.data ?? ({} as MagaluSku);
    } catch (error) {
      throw this.formatError("Erro ao criar SKU na Magalu", error);
    }
  }

  /**
   * Lista pedidos recentes (últimos `days` dias).
   * TODO(validar): nome do filtro de data (updated_at__ge?) e paginação real.
   */
  static async getRecentOrders(
    accessToken: string,
    days = 7,
    maxOrders = 500,
  ): Promise<MagaluOrder[]> {
    try {
      const since = new Date(
        Date.now() - days * 24 * 60 * 60 * 1000,
      ).toISOString();
      const url = new URL(
        MAGALU_CONSTANTS.ORDERS_ENDPOINT,
        MAGALU_CONSTANTS.API_URL,
      );
      url.searchParams.set(
        "limit",
        String(Math.min(maxOrders, MAGALU_CONSTANTS.DEFAULT_PAGE_SIZE)),
      );
      url.searchParams.set("updated_at__ge", since);

      const response = await axios.get<MagaluOrderListResponse>(
        url.toString(),
        {
          headers: this.authHeaders(accessToken),
          timeout: MAGALU_CONSTANTS.REQUEST_TIMEOUT,
        },
      );

      const body = response.data;
      const list = body.results ?? body.data ?? [];
      return list.slice(0, maxOrders);
    } catch (error) {
      throw this.formatError("Erro ao listar pedidos da Magalu", error);
    }
  }

  /**
   * Informações do seller logado: GET /seller/v1/portfolios/me
   * → { tenant:{id}, channel:{id,name}, seller:{id,name} } (VALIDADO na doc).
   */
  static async getMe(accessToken: string): Promise<{
    tenant?: { id?: string };
    channel?: { id?: string; name?: string };
    seller?: { id?: string; name?: string };
    [key: string]: unknown;
  }> {
    try {
      const response = await axios.get<any>(
        `${MAGALU_CONSTANTS.API_URL}/seller/v1/portfolios/me`,
        {
          headers: this.authHeaders(accessToken),
          timeout: MAGALU_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
      return response.data ?? {};
    } catch (error) {
      throw this.formatError("Erro ao consultar seller (me) na Magalu", error);
    }
  }

  /**
   * Canal de venda do seller (channels[].id é obrigatório no create de SKU).
   * O seller tem UM canal, retornado em /portfolios/me.channel.
   */
  static async getChannels(
    accessToken: string,
  ): Promise<Array<{ id: string; name?: string }>> {
    const me = await this.getMe(accessToken);
    return me.channel?.id ? [{ id: me.channel.id, name: me.channel.name }] : [];
  }

  /**
   * Busca um pedido específico (usado pelo webhook, via data.params.id).
   */
  static async getOrder(
    accessToken: string,
    orderId: string,
  ): Promise<MagaluOrder> {
    try {
      const response = await axios.get<MagaluOrder>(
        `${MAGALU_CONSTANTS.API_URL}${MAGALU_CONSTANTS.ORDERS_ENDPOINT}/${encodeURIComponent(orderId)}`,
        {
          headers: this.authHeaders(accessToken),
          timeout: MAGALU_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
      return response.data;
    } catch (error) {
      throw this.formatError("Erro ao buscar pedido da Magalu", error);
    }
  }
}
