import axios from "axios";
import FormData from "form-data";
import { readFile } from "fs/promises";
import { join, basename } from "path";
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
  // OPT-3: Cache de logistics channels por shopId (TTL 15 min)
  private static logisticsCache = new Map<
    number,
    {
      data: Array<{
        logistics_channel_id: number;
        logistics_channel_name: string;
        enabled: boolean;
      }>;
      fetchedAt: number;
    }
  >();
  private static readonly LOGISTICS_CACHE_TTL_MS = 15 * 60 * 1000;

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
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;
        const err = new Error(`Shopee API ${status ?? ""}: ${message}`);
        (err as any).status = status;
        throw err;
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

    // Garantir que recebemos o item_sku (não vem por padrão na API)
    const optionalFields =
      params.response_optional_fields && params.response_optional_fields.length > 0
        ? params.response_optional_fields
        : ["item_sku"];
    queryParams.set("response_optional_fields", optionalFields.join(","));

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
    return this.getItemBaseInfo(accessToken, shopId, itemId);
  }

  /**
   * Busca detalhes base de vários itens (melhor para performance e consistência)
   */
  static async getItemsBaseInfo(
    accessToken: string,
    shopId: number,
    itemIds: number[],
  ): Promise<ShopeeItem[]> {
    if (itemIds.length === 0) {
      return [];
    }

    const apiPath = "/api/v2/product/get_item_base_info";
    const queryParams = new URLSearchParams({
      item_id_list: itemIds.join(","),
      need_model: "true",
      response_optional_fields: [
        "item_sku",
        "model_list",
        "price_info",
        "stock_info",
        "item_status",
      ].join(","),
    });
    const fullApiPath = `${apiPath}?${queryParams.toString()}`;

    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<{ item_list: ShopeeItem[] }>
    >(
      "GET",
      fullApiPath,
      accessToken,
      shopId,
      {
        item_id_list: itemIds,
        need_model: true,
        // Pedir SKU do item e das variações; sem isso a API costuma não retornar
        response_optional_fields: [
          "item_sku",
          "model_list",
          "price_info",
          "stock_info",
          "item_status",
        ],
      },
    );

    if (response.error) {
      throw new Error(`Erro ao buscar itens base: ${response.message}`);
    }

    return response.response?.item_list || [];
  }

  /**
   * Busca os dados base de um unico item.
   */
  static async getItemBaseInfo(
    accessToken: string,
    shopId: number,
    itemId: number,
  ): Promise<ShopeeItem> {
    const items = await this.getItemsBaseInfo(accessToken, shopId, [itemId]);
    const item = items[0];

    if (!item) {
      throw new Error(`Item Shopee ${itemId} nao encontrado`);
    }

    return item;
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
   * Faz upload de imagem para o Shopee (multipart/form-data)
   * Shopee exige que a imagem seja enviada como arquivo binário,
   * não aceita JSON com URL.
   */
  static async uploadImage(
    accessToken: string,
    shopId: number,
    imageUrl: string,
  ): Promise<ShopeeImageUploadResponse> {
    this.validateConfig();
    const apiPath = "/api/v2/media_space/upload_image";
    const partnerId = parseInt(SHOPEE_CONSTANTS.PARTNER_ID!);
    const timestamp = Math.floor(Date.now() / 1000);

    const signature = ShopeeOAuthService.generateSignature({
      partner_id: partnerId,
      api_path: apiPath,
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

    // 1. Baixar a imagem da URL (OPT-8: leitura local direta quando possível)
    const appBackendUrl = (
      process.env.APP_BACKEND_URL || "http://localhost:3333"
    ).replace(/\/+$/, "");
    let imageBuffer: Buffer;
    let contentType: string;

    if (imageUrl.startsWith(appBackendUrl + "/uploads/")) {
      // Imagem local — ler direto do disco, sem HTTP roundtrip
      const filename = basename(new URL(imageUrl).pathname);
      const localPath = join(process.cwd(), "public", "uploads", filename);
      try {
        imageBuffer = await readFile(localPath);
        contentType = filename.endsWith(".png") ? "image/png" : "image/jpeg";
      } catch {
        // Fallback: se arquivo não encontrado no disco, baixar via HTTP
        const imageResponse = await axios.get(imageUrl, {
          responseType: "arraybuffer",
          timeout: 15000,
        });
        imageBuffer = Buffer.from(imageResponse.data);
        contentType = imageResponse.headers["content-type"] || "image/jpeg";
      }
    } else {
      // URL externa — baixar via HTTP como antes
      const imageResponse = await axios.get(imageUrl, {
        responseType: "arraybuffer",
        timeout: 15000,
      });
      imageBuffer = Buffer.from(imageResponse.data);
      contentType = imageResponse.headers["content-type"] || "image/jpeg";
    }
    const ext = contentType.includes("png") ? "png" : "jpg";

    // 2. Criar FormData com a imagem (multipart/form-data)
    const form = new FormData();
    form.append("image", imageBuffer, {
      filename: `upload.${ext}`,
      contentType,
    });

    const formHeaders = form.getHeaders();

    // 3. Enviar como multipart
    const response = await axios.post<
      ShopeeApiResponse<ShopeeImageUploadResponse>
    >(url.toString(), form, {
      headers: {
        ...formHeaders,
      },
      timeout: SHOPEE_CONSTANTS.REQUEST_TIMEOUT,
      maxContentLength: 10 * 1024 * 1024,
      maxBodyLength: 10 * 1024 * 1024,
    });

    const data = response.data;
    if (data.error) {
      throw new Error(`Erro ao fazer upload de imagem: ${data.message}`);
    }

    return data.response!;
  }

  /**
   * Busca canais logísticos disponíveis para a loja
   */
  static async getLogisticsChannelList(
    accessToken: string,
    shopId: number,
  ): Promise<
    Array<{
      logistics_channel_id: number;
      logistics_channel_name: string;
      enabled: boolean;
    }>
  > {
    // OPT-3: Cache por shopId (TTL 15 min)
    const cached = this.logisticsCache.get(shopId);
    if (cached && Date.now() - cached.fetchedAt < this.LOGISTICS_CACHE_TTL_MS) {
      return cached.data;
    }

    const apiPath = "/api/v2/logistics/get_channel_list";

    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<{
        logistics_channel_list: Array<{
          logistics_channel_id: number;
          logistics_channel_name: string;
          enabled: boolean;
        }>;
      }>
    >("GET", apiPath, accessToken, shopId);

    if (response.error) {
      throw new Error(`Erro ao buscar canais logísticos: ${response.message}`);
    }

    const result = response.response?.logistics_channel_list ?? [];
    this.logisticsCache.set(shopId, { data: result, fetchedAt: Date.now() });
    return result;
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
    const query = new URLSearchParams({
      order_sn_list: orderSnList.join(","),
      // item_list is required to map Shopee items back to local SKU/product.
      response_optional_fields: "item_list,buyer_username,total_amount",
    }).toString();

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

    const allowedStatuses = new Set([
      "COMPLETED",
      "READY_TO_SHIP",
      "SHIPPED",
      "PROCESSED",
      "TO_CONFIRM_RECEIVE",
    ]);

    return details.filter((order) => allowedStatuses.has(order.order_status));
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
