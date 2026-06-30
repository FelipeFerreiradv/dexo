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
import type {
  MagaluCategory,
  MagaluAttribute,
} from "../types/magalu-category.types";

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
   * Estoque do SKU (VALIDADO na doc): POST cria, PATCH atualiza, em
   * /seller/v1/portfolios/stocks/{sku}. Body: { channel:{id}, quantity,
   * type:"AVAILABLE", branch?:{id} }. SKU vai na URL.
   */
  static async setStock(
    accessToken: string,
    sku: string,
    quantity: number,
    channelId: string,
    opts?: { branchId?: string; create?: boolean },
  ): Promise<void> {
    await this.upsert(
      accessToken,
      `${MAGALU_CONSTANTS.API_URL}/seller/v1/portfolios/stocks/${encodeURIComponent(sku)}`,
      {
        channel: { id: channelId },
        ...(opts?.branchId ? { branch: { id: opts.branchId } } : {}),
        quantity,
        type: "AVAILABLE",
      },
      Boolean(opts?.create),
      "Erro ao atualizar estoque na Magalu",
    );
  }

  /**
   * Faz POST (criar) ou PATCH (atualizar) e, em 404/409, tenta o outro método —
   * torna estoque/preço idempotentes independente de a entrada já existir.
   */
  private static async upsert(
    accessToken: string,
    url: string,
    data: unknown,
    create: boolean,
    errLabel: string,
  ): Promise<void> {
    const primary = create ? "post" : "patch";
    const fallback = create ? "patch" : "post";
    const headers = this.authHeaders(accessToken);
    const timeout = MAGALU_CONSTANTS.REQUEST_TIMEOUT;
    try {
      await axios.request({ method: primary, url, data, headers, timeout });
    } catch (error) {
      const status = axios.isAxiosError(error)
        ? error.response?.status
        : undefined;
      if (status === 404 || status === 409) {
        try {
          await axios.request({ method: fallback, url, data, headers, timeout });
          return;
        } catch (err2) {
          throw this.formatError(errLabel, err2);
        }
      }
      throw this.formatError(errLabel, error);
    }
  }

  /**
   * Preço do SKU (VALIDADO na doc): POST cria, PATCH atualiza, em
   * /seller/v1/portfolios/prices/{sku}. Body: { channel:{id}, currency:"BRL",
   * list_price, price, normalizer:100 }. price/list_price são INTEIROS em
   * CENTAVOS (normalizer 100). Recebe reais e converte.
   */
  static async setPrice(
    accessToken: string,
    sku: string,
    priceReais: number,
    channelId: string,
    opts?: { listPriceReais?: number; create?: boolean },
  ): Promise<void> {
    const cents = (v: number) => Math.round(v * 100);
    const price = cents(priceReais);
    const listPrice = cents(opts?.listPriceReais ?? priceReais);
    await this.upsert(
      accessToken,
      `${MAGALU_CONSTANTS.API_URL}/seller/v1/portfolios/prices/${encodeURIComponent(sku)}`,
      {
        channel: { id: channelId },
        currency: "BRL",
        list_price: listPrice,
        price,
        normalizer: 100,
      },
      Boolean(opts?.create),
      "Erro ao atualizar preço na Magalu",
    );
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

  // ── Categorias e Atributos (escopo open:portfolio-categories-seller:read) ──

  /**
   * Busca categorias por nome (similaridade) ou id. /portfolios/categories.
   * A busca por nome devolve um array ordenado por relevância.
   */
  static async searchCategories(
    accessToken: string,
    params: { name?: string; id?: string },
  ): Promise<MagaluCategory[]> {
    try {
      const url = new URL(
        "/seller/v1/portfolios/categories",
        MAGALU_CONSTANTS.API_URL,
      );
      if (params.name) url.searchParams.set("name", params.name);
      if (params.id) url.searchParams.set("id", params.id);
      const resp = await axios.get<any>(url.toString(), {
        headers: this.authHeaders(accessToken),
        timeout: MAGALU_CONSTANTS.REQUEST_TIMEOUT,
      });
      const body = resp.data;
      if (Array.isArray(body)) return body;
      return body?.results ?? (body?.id ? [body] : []);
    } catch (error) {
      throw this.formatError("Erro ao buscar categoria na Magalu", error);
    }
  }

  private static async getCategoryFields(
    accessToken: string,
    categoryId: string,
    kind: "attributes" | "datasheet",
    requiredOnly: boolean,
  ): Promise<MagaluAttribute[]> {
    try {
      const url = new URL(
        `/seller/v1/portfolios/categories/${encodeURIComponent(categoryId)}/${kind}`,
        MAGALU_CONSTANTS.API_URL,
      );
      url.searchParams.set("_limit", "100");
      if (requiredOnly) url.searchParams.set("required", "required");
      const resp = await axios.get<any>(url.toString(), {
        headers: this.authHeaders(accessToken),
        timeout: MAGALU_CONSTANTS.REQUEST_TIMEOUT,
      });
      // Shape TBD: espelha searchCategories — pode vir array puro ou {results}.
      const body = resp.data;
      if (Array.isArray(body)) return body;
      return body?.results ?? [];
    } catch (error) {
      throw this.formatError(`Erro ao consultar ${kind} da categoria`, error);
    }
  }

  /** Atributos de variação de uma categoria. */
  static async getCategoryAttributes(
    accessToken: string,
    categoryId: string,
    requiredOnly = false,
  ): Promise<MagaluAttribute[]> {
    return this.getCategoryFields(
      accessToken,
      categoryId,
      "attributes",
      requiredOnly,
    );
  }

  /** Atributos de ficha técnica (datasheet) de uma categoria. */
  static async getCategoryDatasheet(
    accessToken: string,
    categoryId: string,
    requiredOnly = false,
  ): Promise<MagaluAttribute[]> {
    return this.getCategoryFields(
      accessToken,
      categoryId,
      "datasheet",
      requiredOnly,
    );
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
