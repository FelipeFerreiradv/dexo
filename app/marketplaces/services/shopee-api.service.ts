import axios from "axios";
import {
  SHOPEE_CONSTANTS,
  validateShopeeConfig,
} from "../shopee/shopee-constants";
import { ShopeeOAuthService } from "./shopee-oauth.service";
import {
  ShopeeApiResponse,
  ShopeeItem,
  ShopeeItemCreatePayload,
  ShopeeItemUpdatePayload,
  ShopeeItemListResponse,
  ShopeeItemListParams,
  ShopeeImageUploadResponse,
  ShopeeCategoryResponse,
  ShopeeCategoryAttributeResponse,
} from "../types/shopee-api.types";

/**
 * Cliente para API do Shopee
 * Responsável por:
 * 1. Gerenciar itens/produtos
 * 2. Upload de imagens
 * 3. Buscar categorias
 * 4. Sincronizar estoque e preço
 */
export class ShopeeApiService {
  /**
   * Valida configuração antes de fazer requests
   */
  private static validateConfig(): void {
    validateShopeeConfig();
  }

  /**
   * Faz uma requisição autenticada para a API do Shopee
   */
  private static async makeAuthenticatedRequest<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    apiPath: string,
    accessToken: string,
    shopId: number,
    body?: any,
  ): Promise<T> {
    this.validateConfig();
    const partnerId = parseInt(SHOPEE_CONSTANTS.PARTNER_ID!);
    const timestamp = Math.floor(Date.now() / 1000);

    // A assinatura usa apenas o path da API (sem query string)
    const pathOnly = apiPath.split("?")[0];

    const signature = ShopeeOAuthService.generateSignature({
      partner_id: partnerId,
      api_path: pathOnly,
      timestamp,
      access_token: accessToken,
      shop_id: shopId,
    });

    const url = new URL(apiPath, SHOPEE_CONSTANTS.API_URL);
    url.searchParams.set("partner_id", partnerId.toString());
    url.searchParams.set("timestamp", timestamp.toString());
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("shop_id", shopId.toString());
    url.searchParams.set("sign", signature);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    try {
      const response = await axios.request<T>({
        method,
        url: url.toString(),
        headers,
        data: body,
        timeout: SHOPEE_CONSTANTS.REQUEST_TIMEOUT,
      });

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro na API Shopee: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Lista itens da loja
   */
  static async getItemList(
    accessToken: string,
    shopId: number,
    params: ShopeeItemListParams,
  ): Promise<ShopeeItemListResponse> {
    const apiPath = "/api/v2/product/get_item_list";

    const queryParams = new URLSearchParams({
      offset: params.offset.toString(),
      page_size: params.page_size.toString(),
    });

    if (params.item_status && params.item_status.length > 0) {
      queryParams.set("item_status", params.item_status.join(","));
    }

    if (params.update_time_from) {
      queryParams.set("update_time_from", params.update_time_from.toString());
    }

    if (params.update_time_to) {
      queryParams.set("update_time_to", params.update_time_to.toString());
    }

    const fullApiPath = `${apiPath}?${queryParams.toString()}`;

    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<ShopeeItemListResponse>
    >("GET", fullApiPath, accessToken, shopId);

    if (response.error) {
      throw new Error(`Erro ao listar itens: ${response.message}`);
    }

    return response.response!;
  }

  /**
   * Busca detalhes de um item específico
   */
  static async getItemDetail(
    accessToken: string,
    shopId: number,
    itemId: number,
  ): Promise<ShopeeItem> {
    const apiPath = "/api/v2/product/get_item_detail";

    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<ShopeeItem>
    >("GET", `${apiPath}?item_id=${itemId}`, accessToken, shopId);

    if (response.error) {
      throw new Error(`Erro ao buscar item: ${response.message}`);
    }

    return response.response!;
  }

  /**
   * Cria um novo item
   */
  static async createItem(
    accessToken: string,
    shopId: number,
    itemData: ShopeeItemCreatePayload,
  ): Promise<{ item_id: number }> {
    const apiPath = "/api/v2/product/add_item";

    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<{ item_id: number }>
    >("POST", apiPath, accessToken, shopId, itemData);

    if (response.error) {
      throw new Error(`Erro ao criar item: ${response.message}`);
    }

    return response.response!;
  }

  /**
   * Atualiza um item existente
   */
  static async updateItem(
    accessToken: string,
    shopId: number,
    itemData: ShopeeItemUpdatePayload,
  ): Promise<{ item_id: number }> {
    const apiPath = "/api/v2/product/update_item";

    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<{ item_id: number }>
    >("POST", apiPath, accessToken, shopId, itemData);

    if (response.error) {
      throw new Error(`Erro ao atualizar item: ${response.message}`);
    }

    return response.response!;
  }

  /**
   * Atualiza apenas o estoque de um item
   */
  static async updateItemStock(
    accessToken: string,
    shopId: number,
    itemId: number,
    stock: number,
  ): Promise<{ item_id: number }> {
    return this.updateItem(accessToken, shopId, {
      item_id: itemId,
      seller_stock: [{ stock }],
    });
  }

  /**
   * Atualiza apenas o preço de um item
   */
  static async updateItemPrice(
    accessToken: string,
    shopId: number,
    itemId: number,
    price: number,
  ): Promise<{ item_id: number }> {
    return this.updateItem(accessToken, shopId, {
      item_id: itemId,
      original_price: price,
    });
  }

  /**
   * Deleta um item
   */
  static async deleteItem(
    accessToken: string,
    shopId: number,
    itemId: number,
  ): Promise<{ item_id: number }> {
    const apiPath = "/api/v2/product/delete_item";

    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<{ item_id: number }>
    >("POST", apiPath, accessToken, shopId, { item_id: itemId });

    if (response.error) {
      throw new Error(`Erro ao deletar item: ${response.message}`);
    }

    return response.response!;
  }

  /**
   * Faz upload de imagem para o Shopee
   */
  static async uploadImage(
    accessToken: string,
    shopId: number,
    imageUrl: string,
  ): Promise<ShopeeImageUploadResponse> {
    const apiPath = "/api/v2/media_space/upload_image";

    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<ShopeeImageUploadResponse>
    >("POST", apiPath, accessToken, shopId, { image_url: imageUrl });

    if (response.error) {
      throw new Error(`Erro ao fazer upload de imagem: ${response.message}`);
    }

    return response.response!;
  }

  /**
   * Busca categorias do Shopee
   */
  static async getCategories(
    accessToken: string,
    shopId: number,
    language?: string,
  ): Promise<ShopeeCategoryResponse> {
    const apiPath = "/api/v2/product/get_category";

    const query = language ? `?language=${language}` : "";

    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<ShopeeCategoryResponse>
    >("GET", `${apiPath}${query}`, accessToken, shopId);

    if (response.error) {
      throw new Error(`Erro ao buscar categorias: ${response.message}`);
    }

    return response.response!;
  }

  /**
   * Lista pedidos (order_sn) com paginação
   */
  static async getOrderList(
    accessToken: string,
    shopId: number,
    params: {
      time_from: number;
      time_to: number;
      page_size?: number;
      cursor?: string;
      order_status?: string[];
      time_range_field?: "create_time" | "update_time";
    },
  ) {
    const apiPath = "/api/v2/order/get_order_list";

    const query = new URLSearchParams({
      time_range_field: params.time_range_field ?? "create_time",
      time_from: params.time_from.toString(),
      time_to: params.time_to.toString(),
      page_size: (params.page_size ?? 50).toString(),
    });
    if (params.cursor) query.set("cursor", params.cursor);
    if (params.order_status?.length) {
      for (const status of params.order_status) {
        query.append("order_status", status);
      }
    }

    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<{
        more: boolean;
        next_cursor?: string;
        order_list: {
          order_sn: string;
          order_status: string;
          create_time: number;
          update_time: number;
        }[];
      }>
    >("GET", `${apiPath}?${query.toString()}`, accessToken, shopId);

    if (response.error) {
      throw new Error(`Erro ao listar pedidos Shopee: ${response.message}`);
    }

    return response.response!;
  }

  /**
   * Busca detalhes de uma lista de pedidos
   */
  static async getOrderDetails(
    accessToken: string,
    shopId: number,
    orderSnList: string[],
  ) {
    if (!orderSnList.length) return [];
    const apiPath = "/api/v2/order/get_order_detail";
    const query = `order_sn_list=${orderSnList.join(",")}`;

    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<{ order_list: any[] }>
    >("GET", `${apiPath}?${query}`, accessToken, shopId);

    if (response.error) {
      throw new Error(
        `Erro ao buscar detalhes de pedidos: ${response.message}`,
      );
    }

    return response.response?.order_list ?? [];
  }

  /**
   * Busca pedidos recentes (em dias) já com detalhes
   */
  static async getRecentOrders(
    accessToken: string,
    shopId: number,
    days: number = 3,
  ) {
    const nowSec = Math.floor(Date.now() / 1000);
    const fromSec = nowSec - days * 24 * 60 * 60;

    let cursor: string | undefined;
    const orderSns: string[] = [];

    do {
      const listResp = await this.getOrderList(accessToken, shopId, {
        time_from: fromSec,
        time_to: nowSec,
        cursor,
        page_size: 50,
        order_status: ["COMPLETED", "READY_TO_SHIP", "SHIPPED", "PROCESSED"],
      });

      orderSns.push(...(listResp.order_list?.map((o) => o.order_sn) ?? []));
      cursor = listResp.more ? listResp.next_cursor : undefined;

      if (listResp.more && cursor) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    } while (cursor);

    // Buscar detalhes em lotes de até 50 order_sn
    const details: any[] = [];
    for (let i = 0; i < orderSns.length; i += 50) {
      const batch = orderSns.slice(i, i + 50);
      const det = await this.getOrderDetails(accessToken, shopId, batch);
      details.push(...det);
      if (i + 50 < orderSns.length) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }

    return details;
  }

  /**
   * Busca atributos de uma categoria
   */
  static async getCategoryAttributes(
    accessToken: string,
    shopId: number,
    categoryId: number,
    language?: string,
  ): Promise<ShopeeCategoryAttributeResponse> {
    const apiPath = "/api/v2/product/get_attributes";

    const query = `?category_id=${categoryId}${language ? `&language=${language}` : ""}`;

    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<ShopeeCategoryAttributeResponse>
    >("GET", `${apiPath}${query}`, accessToken, shopId);

    if (response.error) {
      throw new Error(
        `Erro ao buscar atributos da categoria: ${response.message}`,
      );
    }

    return response.response!;
  }
}
