import axios from "axios";
import FormData from "form-data";
import { readFile } from "fs/promises";
import { join, basename } from "path";
import sharp from "sharp";
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
  ShopeeCategoryAttribute,
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
        weight_limit?: {
          item_min_weight?: number;
          item_max_weight?: number;
        };
        item_max_dimension?: {
          length?: number;
          width?: number;
          height?: number;
          unit?: string;
          dimension_sum?: number;
        };
      }>;
      fetchedAt: number;
    }
  >();
  private static readonly LOGISTICS_CACHE_TTL_MS = 15 * 60 * 1000;

  private static categoryCache = new Map<
    string,
    { map: Map<number, { hasChildren: boolean; parentId: number; name: string }>; fetchedAt: number }
  >();
  private static readonly CATEGORY_CACHE_TTL_MS = 60 * 60 * 1000;

  /**
   * Verifica se um category_id é folha (não tem filhos). Shopee rejeita
   * add_item em categorias não-folha com "Invalid category. : should use
   * leaf category". Lança erro com essa mensagem para que o classificador
   * de erros terminais (listing.usercase / listing-retry) reconheça.
   */
  static async assertLeafCategory(
    accessToken: string,
    shopId: number,
    categoryId: number,
    language = "pt-BR",
  ): Promise<void> {
    const cacheKey = `${shopId}:${language}`;
    const cached = this.categoryCache.get(cacheKey);
    let map = cached?.map;
    if (!map || Date.now() - (cached?.fetchedAt ?? 0) > this.CATEGORY_CACHE_TTL_MS) {
      const resp = await this.getCategories(accessToken, shopId, language);
      map = new Map();
      for (const c of resp.category_list ?? []) {
        map.set(c.category_id, {
          hasChildren: !!c.has_children,
          parentId: c.parent_category_id,
          name: c.category_name,
        });
      }
      this.categoryCache.set(cacheKey, { map, fetchedAt: Date.now() });
    }
    const node = map.get(categoryId);
    if (!node) {
      throw new Error(
        `Categoria Shopee ${categoryId} não encontrada — selecione uma categoria válida.`,
      );
    }
    if (node.hasChildren) {
      throw new Error(
        `Invalid category: ${categoryId} (${node.name}) should use leaf category. Selecione uma subcategoria final.`,
      );
    }
  }

  /**
   * Valida configuração antes de fazer requests
   */
  private static validateConfig(): void {
    validateShopeeConfig();
  }

  /**
   * Retorna informações básicas da loja (nome, região, status).
   * Usado apenas para enriquecer a listagem de contas conectadas.
   */
  static async getShopInfo(
    accessToken: string,
    shopId: number,
  ): Promise<{
    shop_name?: string;
    region?: string;
    status?: string;
    shop_logo?: string;
    merchant_name?: string;
  }> {
    return this.makeAuthenticatedRequest(
      "GET",
      "/api/v2/shop/get_shop_info",
      accessToken,
      shopId,
    );
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
   * Atualiza estoque de um item (ou modelo específico) via /api/v2/product/update_stock.
   * update_item NÃO aceita seller_stock — aceita o request e descarta o campo.
   */
  static async updateItemStock(
    accessToken: string,
    shopId: number,
    itemId: number,
    stock: number,
    modelId?: number,
  ): Promise<void> {
    const apiPath = "/api/v2/product/update_stock";
    const sellerStock = [{ stock }];
    const stockEntry = modelId
      ? { model_id: modelId, seller_stock: sellerStock }
      : { seller_stock: sellerStock };

    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<{
        result?: Array<{
          model_id?: number;
          location_id?: string;
          failed_reason?: string;
        }>;
      }>
    >("POST", apiPath, accessToken, shopId, {
      item_id: itemId,
      stock_list: [stockEntry],
    });

    if (response.error) {
      throw new Error(
        `Erro ao atualizar estoque: ${response.message ?? response.error}`,
      );
    }

    const failed = response.response?.result?.find((r) => r.failed_reason);
    if (failed) {
      throw new Error(
        `Shopee rejeitou update de estoque: ${failed.failed_reason}`,
      );
    }
  }

  /**
   * Atualiza preço de um item (ou modelos específicos) via
   * /api/v2/product/update_price.
   *
   * IMPORTANTE: o endpoint `update_item` aceita `original_price` mas a
   * Shopee descarta silenciosamente esse campo em vários cenários (mesmo
   * sem variações). Para garantia de propagação do preço, sempre usar
   * este método dedicado.
   *
   * Para itens SEM variações: passar `[{ original_price }]`.
   * Para itens COM variações: passar `[{ model_id, original_price }, ...]`
   * uma entrada por modelo.
   */
  static async updatePrice(
    accessToken: string,
    shopId: number,
    itemId: number,
    priceList: Array<{ model_id?: number; original_price: number }>,
  ): Promise<void> {
    const apiPath = "/api/v2/product/update_price";

    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<{
        result?: Array<{
          model_id?: number;
          failed_reason?: string;
        }>;
      }>
    >("POST", apiPath, accessToken, shopId, {
      item_id: itemId,
      price_list: priceList,
    });

    if (response.error) {
      throw new Error(
        `Erro ao atualizar preço Shopee: ${response.message ?? response.error}`,
      );
    }

    const failed = response.response?.result?.find((r) => r.failed_reason);
    if (failed) {
      throw new Error(
        `Shopee rejeitou update de preço${failed.model_id ? ` (model ${failed.model_id})` : ""}: ${failed.failed_reason}`,
      );
    }
  }

  /**
   * Atualiza apenas o preço de um item — wrapper conveniência sobre updatePrice.
   * Para itens sem variações (caso comum). Para variações, use updatePrice
   * diretamente com um price_list por model_id.
   */
  static async updateItemPrice(
    accessToken: string,
    shopId: number,
    itemId: number,
    price: number,
  ): Promise<void> {
    return this.updatePrice(accessToken, shopId, itemId, [
      { original_price: price },
    ]);
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
      const err = new Error(`Erro ao deletar item: ${response.message}`);
      (err as any).shopeeError = response.error;
      (err as any).shopeeMessage = response.message;
      throw err;
    }

    return response.response!;
  }

  /**
   * Pausa (unlist=true) ou reativa (unlist=false) anuncios na Shopee.
   * Endpoint /api/v2/product/unlist_item aceita ate 50 itens por chamada.
   *
   * Erros globais (auth, throttling) sao lancados como exception via
   * makeAuthenticatedRequest. Falhas por-item vem em failure_list (lista vazia
   * se todos OK).
   *
   * Doc: open.shopee.com -> Open API v2 -> product -> unlist_item
   */
  static async unlistItem(
    accessToken: string,
    shopId: number,
    items: Array<{ itemId: number; unlist: boolean }>,
  ): Promise<{
    failure_list: Array<{ item_id: number; failed_reason: string }>;
  }> {
    if (items.length === 0) {
      return { failure_list: [] };
    }

    const apiPath = "/api/v2/product/unlist_item";

    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<{
        failure_list?: Array<{ item_id: number; failed_reason: string }>;
      }>
    >("POST", apiPath, accessToken, shopId, {
      item_list: items.map((i) => ({ item_id: i.itemId, unlist: i.unlist })),
    });

    if (response.error) {
      throw new Error(
        `Erro ao alterar visibilidade do(s) anuncio(s) Shopee: ${response.message}`,
      );
    }

    return { failure_list: response.response?.failure_list ?? [] };
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
        if (filename.endsWith(".png")) contentType = "image/png";
        else if (filename.endsWith(".webp")) contentType = "image/webp";
        else contentType = "image/jpeg";
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

    // Shopee aceita JPG/PNG — transcodar formatos não suportados (webp, gif, avif, etc.)
    const isSupported =
      contentType.includes("jpeg") ||
      contentType.includes("jpg") ||
      contentType.includes("png");
    if (!isSupported) {
      try {
        imageBuffer = await sharp(imageBuffer)
          .jpeg({ quality: 90 })
          .toBuffer();
        contentType = "image/jpeg";
      } catch (transcodeErr) {
        throw new Error(
          `Erro ao converter imagem ${contentType} para JPEG: ${(transcodeErr as Error).message}`,
        );
      }
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
      weight_limit?: {
        item_min_weight?: number;
        item_max_weight?: number;
      };
      item_max_dimension?: {
        length?: number;
        width?: number;
        height?: number;
        unit?: string;
        dimension_sum?: number;
      };
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
          weight_limit?: {
            item_min_weight?: number;
            item_max_weight?: number;
          };
          item_max_dimension?: {
            length?: number;
            width?: number;
            height?: number;
            unit?: string;
            dimension_sum?: number;
          };
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
   * Busca atributos de uma categoria.
   *
   * Migrado de `/api/v2/product/get_attributes` (descontinuado pela Shopee —
   * "No APP type can call this API") para `/api/v2/product/get_attribute_tree`
   * (substituto moderno disponivel para ERP System + outros app types).
   *
   * Endpoint novo aceita lista de categoryIds (max 20) e retorna estrutura
   * em arvore com `name`/`mandatory` em vez de `attribute_name`/`is_mandatory`.
   * Esta funcao MANTEM a assinatura e o shape do retorno antigo via
   * mapeamento de campos — os consumers a jusante (ShopeeAttributeCatalogService,
   * listing.usercase, sync script, testes existentes) continuam funcionando
   * sem mudancas.
   */
  static async getCategoryAttributes(
    accessToken: string,
    shopId: number,
    categoryId: number,
    language?: string,
  ): Promise<ShopeeCategoryAttributeResponse> {
    const apiPath = "/api/v2/product/get_attribute_tree";

    // Novo endpoint usa category_id_list (pode pedir ate 20 por chamada);
    // aqui consultamos uma so para preservar a assinatura existente.
    const query = `?category_id_list=${categoryId}${language ? `&language=${language}` : ""}`;

    interface AttributeTreeValue {
      value_id: number;
      name: string;
      value_unit?: string;
      child_attribute_list?: AttributeTreeNode[];
    }
    interface AttributeTreeNode {
      attribute_id: number;
      name: string;
      mandatory: boolean;
      attribute_value_list?: AttributeTreeValue[];
      attribute_info?: {
        input_type?: number;
        attribute_unit_list?: string[];
      };
    }
    interface AttributeTreeResponse {
      list: Array<{
        category_id: number;
        attribute_tree: AttributeTreeNode[];
      }>;
    }

    // true se escolher um valor introduz, em qualquer profundidade do
    // child_attribute_list, um atributo OBRIGATORIO. Selecionar esse valor
    // sem preencher os filhos faz a Shopee rejeitar o item com
    // "Attribute X is mandatory required".
    const hasMandatoryDescendant = (
      children?: AttributeTreeNode[],
    ): boolean => {
      if (!children || children.length === 0) return false;
      for (const child of children) {
        if (child.mandatory === true) return true;
        for (const v of child.attribute_value_list ?? []) {
          if (hasMandatoryDescendant(v.child_attribute_list)) return true;
        }
      }
      return false;
    };

    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<AttributeTreeResponse>
    >("GET", `${apiPath}${query}`, accessToken, shopId);

    if (response.error) {
      throw new Error(
        `Erro ao buscar atributos da categoria: ${response.message}`,
      );
    }

    const tree = response.response?.list?.[0]?.attribute_tree ?? [];

    // Mapear formato novo (attribute_tree) -> formato antigo (attribute_list)
    // que os consumers a jusante esperam. Preserva attribute_id intacto e
    // converte apenas os nomes de campo divergentes. Anexa
    // has_mandatory_children por valor pra o mapping evitar disparar
    // atributos-filho obrigatorios que nao temos como preencher.
    const attribute_list: ShopeeCategoryAttribute[] = tree.map((node) => ({
      attribute_id: node.attribute_id,
      attribute_name: node.name,
      is_mandatory: node.mandatory === true,
      input_type: String(node.attribute_info?.input_type ?? ""),
      attribute_unit: node.attribute_info?.attribute_unit_list ?? [],
      attribute_value_list: (node.attribute_value_list ?? []).map((v) => ({
        value_id: v.value_id,
        value_name: v.name,
        parent_attribute_id: 0,
        parent_value_id: 0,
        has_mandatory_children: hasMandatoryDescendant(v.child_attribute_list),
      })),
    }));

    return { attribute_list };
  }

  // ====================================================================
  // LOGÍSTICA / ETIQUETA DE ENVIO (módulo aditivo — Fase 4)
  //
  // makeAuthenticatedRequest é private; por isso estes métodos vivem AQUI,
  // públicos, ao lado de getLogisticsChannelList. Os endpoints JSON usam
  // makeAuthenticatedRequest; upload (multipart) e download (binário) assinam
  // inline (mesmo padrão de uploadImage). NÃO alteram nada existente.
  // Shapes a confirmar em homologação (SHOPEE_SANDBOX=true).
  // ====================================================================

  /** Monta a URL assinada de um endpoint (mesmo esquema de uploadImage). */
  private static buildSignedUrl(
    apiPath: string,
    accessToken: string,
    shopId: number,
  ): string {
    this.validateConfig();
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
    return url.toString();
  }

  /**
   * Envia/atualiza a NF-e do pedido (passo fiscal do Brasil). Multipart com o
   * XML autorizado. A loja precisa estar configurada como emissor externo de
   * NF-e no Seller Center.
   */
  static async uploadInvoiceDoc(
    accessToken: string,
    shopId: number,
    orderSn: string,
    xml: string,
    fileType = "normal_invoice",
  ): Promise<void> {
    const url = this.buildSignedUrl(
      "/api/v2/logistics/upload_invoice_doc",
      accessToken,
      shopId,
    );
    const form = new FormData();
    form.append("order_sn", orderSn);
    form.append("file_type", fileType);
    form.append("file", Buffer.from(xml, "utf-8"), {
      filename: `${orderSn}.xml`,
      contentType: "application/xml",
    });
    try {
      const resp = await axios.post(url, form, {
        headers: { ...form.getHeaders() },
        timeout: SHOPEE_CONSTANTS.REQUEST_TIMEOUT,
        maxContentLength: 10 * 1024 * 1024,
        maxBodyLength: 10 * 1024 * 1024,
      });
      const data = resp.data as ShopeeApiResponse<unknown>;
      if (data?.error) {
        throw new Error(
          `Erro ao enviar NF-e à Shopee: ${data.message ?? data.error}`,
        );
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const message =
          (error.response?.data as { message?: string })?.message ||
          error.message;
        const err = new Error(`Shopee upload_invoice_doc ${status ?? ""}: ${message}`);
        (err as { status?: number }).status = status;
        throw err;
      }
      throw error;
    }
  }

  /** GET /api/v2/logistics/get_shipping_parameter?order_sn=... */
  static async getShippingParameter(
    accessToken: string,
    shopId: number,
    orderSn: string,
  ): Promise<Record<string, any>> {
    const apiPath = `/api/v2/logistics/get_shipping_parameter?order_sn=${encodeURIComponent(
      orderSn,
    )}`;
    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<Record<string, any>>
    >("GET", apiPath, accessToken, shopId);
    if (response.error) {
      throw new Error(
        `Erro ao obter parâmetros de envio Shopee: ${response.message ?? response.error}`,
      );
    }
    return response.response ?? {};
  }

  /** GET /api/v2/logistics/get_address_list */
  static async getAddressList(
    accessToken: string,
    shopId: number,
  ): Promise<any[]> {
    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<{ address_list?: any[] }>
    >("GET", "/api/v2/logistics/get_address_list", accessToken, shopId);
    if (response.error) {
      throw new Error(
        `Erro ao listar endereços Shopee: ${response.message ?? response.error}`,
      );
    }
    return response.response?.address_list ?? [];
  }

  /** POST /api/v2/logistics/ship_order (pickup ou dropoff). */
  static async shipOrder(
    accessToken: string,
    shopId: number,
    body: { order_sn: string; pickup?: any; dropoff?: any },
  ): Promise<void> {
    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<unknown>
    >("POST", "/api/v2/logistics/ship_order", accessToken, shopId, body);
    if (response.error) {
      const err = new Error(
        `Erro ao arranjar envio Shopee: ${response.message ?? response.error}`,
      );
      (err as { shopeeError?: string }).shopeeError = response.error ?? undefined;
      (err as { shopeeMessage?: string }).shopeeMessage =
        response.message ?? undefined;
      throw err;
    }
  }

  /** GET /api/v2/logistics/get_tracking_number?order_sn=... */
  static async getTrackingNumber(
    accessToken: string,
    shopId: number,
    orderSn: string,
  ): Promise<string | null> {
    const apiPath = `/api/v2/logistics/get_tracking_number?order_sn=${encodeURIComponent(
      orderSn,
    )}`;
    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<{ tracking_number?: string }>
    >("GET", apiPath, accessToken, shopId);
    if (response.error) {
      throw new Error(
        `Erro ao obter tracking Shopee: ${response.message ?? response.error}`,
      );
    }
    return response.response?.tracking_number ?? null;
  }

  /** POST /api/v2/logistics/create_shipping_document (assíncrono). */
  static async createShippingDocument(
    accessToken: string,
    shopId: number,
    orderList: Array<{ order_sn: string }>,
    docType: string,
  ): Promise<void> {
    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<{
        result_list?: Array<{
          order_sn: string;
          fail_error?: string;
          fail_message?: string;
        }>;
      }>
    >("POST", "/api/v2/logistics/create_shipping_document", accessToken, shopId, {
      order_list: orderList.map((o) => ({
        order_sn: o.order_sn,
        shipping_document_type: docType,
      })),
    });
    if (response.error) {
      throw new Error(
        `Erro ao criar documento de envio Shopee: ${response.message ?? response.error}`,
      );
    }
    const failed = (response.response?.result_list ?? []).find(
      (r) => r.fail_error || r.fail_message,
    );
    if (failed) {
      throw new Error(
        `Shopee rejeitou create_shipping_document (${failed.order_sn}): ${failed.fail_message ?? failed.fail_error}`,
      );
    }
  }

  /** POST /api/v2/logistics/get_shipping_document_result → status por pedido. */
  static async getShippingDocumentResult(
    accessToken: string,
    shopId: number,
    orderList: Array<{ order_sn: string }>,
    docType: string,
  ): Promise<Array<{ order_sn: string; status: string }>> {
    const response = await this.makeAuthenticatedRequest<
      ShopeeApiResponse<{
        result_list?: Array<{ order_sn: string; status: string }>;
      }>
    >(
      "POST",
      "/api/v2/logistics/get_shipping_document_result",
      accessToken,
      shopId,
      {
        order_list: orderList.map((o) => ({
          order_sn: o.order_sn,
          shipping_document_type: docType,
        })),
      },
    );
    if (response.error) {
      throw new Error(
        `Erro ao consultar documento de envio Shopee: ${response.message ?? response.error}`,
      );
    }
    return (response.response?.result_list ?? []).map((r) => ({
      order_sn: r.order_sn,
      status: r.status,
    }));
  }

  /**
   * POST /api/v2/logistics/download_shipping_document → PDF (binário).
   * Assina inline (makeAuthenticatedRequest assume JSON; aqui é arraybuffer).
   */
  static async downloadShippingDocument(
    accessToken: string,
    shopId: number,
    orderList: Array<{ order_sn: string }>,
    docType: string,
  ): Promise<Buffer> {
    const url = this.buildSignedUrl(
      "/api/v2/logistics/download_shipping_document",
      accessToken,
      shopId,
    );
    try {
      const resp = await axios.post(
        url,
        {
          order_list: orderList.map((o) => ({
            order_sn: o.order_sn,
            shipping_document_type: docType,
          })),
          shipping_document_type: docType,
        },
        {
          responseType: "arraybuffer",
          timeout: SHOPEE_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
      return Buffer.from(resp.data as ArrayBuffer);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const err = new Error(
          `Shopee download_shipping_document ${status ?? ""}`,
        );
        (err as { status?: number }).status = status;
        throw err;
      }
      throw error;
    }
  }
}
