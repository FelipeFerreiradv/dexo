import axios from "axios";
import crypto from "crypto";
import { SHOPEE_CONSTANTS, validateShopeeConfig } from "../shopee/shopee-constants";
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

    const bodyString = body ? JSON.stringify(body) : "";

    const signature = ShopeeOAuthService["generateSignature"]({
      partner_id: partnerId,
      api_path: apiPath,
      timestamp,
      access_token: accessToken,
      shop_id: shopId,
      body: bodyString,
    });

    const url = `${SHOPEE_CONSTANTS.API_URL}${apiPath}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `SHA256 Credential=${partnerId}, Timestamp=${timestamp}, Signature=${signature}`,
    };

    try {
      const response = await axios.request<T>({
        method,
        url,
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

    return this.makeAuthenticatedRequest<ShopeeItemListResponse>(
      "GET",
      fullApiPath,
      accessToken,
      shopId,
    );
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
      stock,
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
      price,
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
