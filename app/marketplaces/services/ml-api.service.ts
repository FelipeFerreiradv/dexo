import axios from "axios";
import { ML_CONSTANTS } from "../mercado-livre/ml-constants";
import {
  MLItemsSearchResponse,
  MLItemDetails,
  MLMultigetResponse,
  MLItemUpdatePayload,
  MLItemCreatePayload,
} from "../types/ml-api.types";
import {
  MLOrderDetails,
  MLOrdersSearchResponse,
  MLOrdersSearchParams,
  MLOrderStatus,
} from "../types/ml-order.types";

/**
 * Cliente para API do Mercado Livre
 * Responsável por:
 * 1. Listar items do vendedor
 * 2. Obter detalhes de items
 * 3. Atualizar estoque e preço
 */
export class MLApiService {
  /**
   * Lista todos os IDs de items de um vendedor
   * @param accessToken Token de acesso OAuth
   * @param sellerId ID do vendedor no ML
   * @param status Filtro por status (opcional, padrão: "active")
   * @param maxItems Limite máximo de IDs a buscar (opcional, sem limite por padrão)
   */
  static async getSellerItemIds(
    accessToken: string,
    sellerId: string,
    status: "active" | "paused" | "closed" = "active", // Padrão: apenas itens ativos
    maxItems?: number, // Sem limite por padrão
  ): Promise<string[]> {
    const allItemIds: string[] = [];
    let offset = 0;
    const limit = 50; // ML aceita no máximo 50 por página

    try {
      while (true) {
        const url = new URL(
          `/users/${sellerId}/items/search`,
          ML_CONSTANTS.API_URL,
        );
        url.searchParams.set("limit", limit.toString());
        url.searchParams.set("offset", offset.toString());
        url.searchParams.set("status", status);

        const response = await axios.get<MLItemsSearchResponse>(
          url.toString(),
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
            timeout: 10000, // 10 segundos de timeout por requisição
          },
        );

        allItemIds.push(...response.data.results);

        // Verificar se há mais páginas
        if (response.data.results.length < limit) {
          break;
        }
        offset += limit;

        // Limite opcional (se especificado)
        if (maxItems && allItemIds.length >= maxItems) {
          break;
        }

        // IMPORTANTE: API do ML limita offset a 1000 quando usa filtro de status
        // Ref: https://developers.mercadolivre.com.br/pt_br/items-e-buscas
        if (offset >= 1000) {
          console.log(
            `[ML API] Reached ML API offset limit (1000 with status filter). Total: ${allItemIds.length}`,
          );
          break;
        }

        // Pequena pausa para evitar rate limiting
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      console.log(`[ML API] Fetched ${allItemIds.length} item IDs`);
      return allItemIds;
    } catch (error) {
      console.error(`[ML API] Error fetching IDs at offset ${offset}:`, error);
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao buscar items do vendedor: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Obtém detalhes de múltiplos items (máximo 20 por chamada)
   * @param accessToken Token de acesso OAuth
   * @param itemIds Array de IDs de items
   * @param maxItems Limite opcional de itens a processar
   */
  static async getItemsDetails(
    accessToken: string,
    itemIds: string[],
    maxItems?: number,
  ): Promise<MLItemDetails[]> {
    if (itemIds.length === 0) return [];

    // Limitar número de itens se especificado
    const idsToProcess = maxItems ? itemIds.slice(0, maxItems) : itemIds;
    console.log(`[ML API] Processing ${idsToProcess.length} items`);

    // API permite máximo 20 items por chamada
    const chunks: string[][] = [];
    for (let i = 0; i < idsToProcess.length; i += 20) {
      chunks.push(idsToProcess.slice(i, i + 20));
    }

    console.log(
      `[ML API] Will make ${chunks.length} requests for item details`,
    );

    const allItems: MLItemDetails[] = [];

    try {
      let chunkIndex = 0;
      for (const chunk of chunks) {
        chunkIndex++;
        const url = `${ML_CONSTANTS.API_URL}/items?ids=${chunk.join(",")}`;

        const response = await axios.get<MLMultigetResponse[]>(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        // Filtrar apenas respostas com sucesso
        for (const item of response.data) {
          if (item.code === 200) {
            allItems.push(item.body);
          }
        }

        // Pequena pausa entre chunks para evitar rate limiting
        if (chunkIndex < chunks.length) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      console.log(`[ML API] Fetched ${allItems.length} item details`);
      return allItems;
    } catch (error) {
      console.error(`[ML API] Error fetching item details:`, error);
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao obter detalhes dos items: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Obtém detalhes de um único item
   * @param accessToken Token de acesso OAuth
   * @param itemId ID do item
   */
  static async getItemDetails(
    accessToken: string,
    itemId: string,
  ): Promise<MLItemDetails> {
    try {
      const response = await axios.get<MLItemDetails>(
        `${ML_CONSTANTS.API_URL}/items/${itemId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao obter detalhes do item: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Busca item por SKU (seller_custom_field ou atributo SELLER_SKU)
   * @param accessToken Token de acesso OAuth
   * @param sellerId ID do vendedor
   * @param sku SKU do produto
   */
  static async findItemBySku(
    accessToken: string,
    sellerId: string,
    sku: string,
  ): Promise<MLItemDetails | null> {
    try {
      // Tentar buscar por seller_custom_field
      const url = new URL(
        `/users/${sellerId}/items/search`,
        ML_CONSTANTS.API_URL,
      );
      url.searchParams.set("sku", sku);

      const response = await axios.get<MLItemsSearchResponse>(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (response.data.results.length === 0) {
        return null;
      }

      // Obter detalhes do primeiro item encontrado
      const itemDetails = await this.getItemDetails(
        accessToken,
        response.data.results[0],
      );

      return itemDetails;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao buscar item por SKU: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Atualiza um item no Mercado Livre
   * @param accessToken Token de acesso OAuth
   * @param itemId ID do item
   * @param data Dados para atualizar
   */
  static async updateItem(
    accessToken: string,
    itemId: string,
    data: MLItemUpdatePayload,
  ): Promise<MLItemDetails> {
    try {
      const response = await axios.put<MLItemDetails>(
        `${ML_CONSTANTS.API_URL}/items/${itemId}`,
        data,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        },
      );

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao atualizar item: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Atualiza apenas o estoque de um item
   * @param accessToken Token de acesso OAuth
   * @param itemId ID do item
   * @param quantity Nova quantidade
   */
  static async updateItemStock(
    accessToken: string,
    itemId: string,
    quantity: number,
  ): Promise<MLItemDetails> {
    return this.updateItem(accessToken, itemId, {
      available_quantity: quantity,
    });
  }

  /**
   * Atualiza apenas o preço de um item
   * @param accessToken Token de acesso OAuth
   * @param itemId ID do item
   * @param price Novo preço
   */
  static async updateItemPrice(
    accessToken: string,
    itemId: string,
    price: number,
  ): Promise<MLItemDetails> {
    return this.updateItem(accessToken, itemId, { price });
  }

  // ====================================================================
  // MÉTODOS DE ORDERS (PEDIDOS)
  // ====================================================================

  /**
   * Busca pedidos de um vendedor com filtros
   * @param accessToken Token de acesso OAuth
   * @param params Parâmetros de busca
   */
  static async getSellerOrders(
    accessToken: string,
    params: MLOrdersSearchParams,
  ): Promise<MLOrdersSearchResponse> {
    try {
      const url = new URL("/orders/search", ML_CONSTANTS.API_URL);

      // Parâmetro obrigatório: seller
      url.searchParams.set("seller", params.seller);

      // Parâmetros opcionais
      if (params.status) {
        url.searchParams.set("order.status", params.status);
      }
      if (params.dateCreatedFrom) {
        url.searchParams.set("order.date_created.from", params.dateCreatedFrom);
      }
      if (params.dateCreatedTo) {
        url.searchParams.set("order.date_created.to", params.dateCreatedTo);
      }
      if (params.sort) {
        url.searchParams.set("sort", params.sort);
      }
      if (params.offset !== undefined) {
        url.searchParams.set("offset", params.offset.toString());
      }
      if (params.limit !== undefined) {
        url.searchParams.set("limit", params.limit.toString());
      }
      if (params.tags) {
        url.searchParams.set("tags", params.tags);
      }

      console.log(`[ML API] Fetching orders: ${url.toString()}`);

      const response = await axios.get<MLOrdersSearchResponse>(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: 15000,
      });

      console.log(
        `[ML API] Found ${response.data.results.length} orders (total: ${response.data.paging.total})`,
      );

      return response.data;
    } catch (error) {
      console.error("[ML API] Error fetching orders:", error);
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao buscar pedidos: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Busca todos os pedidos paginados (com limite de segurança)
   * @param accessToken Token de acesso OAuth
   * @param sellerId ID do vendedor
   * @param status Status dos pedidos (opcional)
   * @param maxOrders Limite máximo de pedidos a buscar (padrão: 100)
   */
  static async getAllSellerOrders(
    accessToken: string,
    sellerId: string,
    status?: MLOrderStatus,
    maxOrders: number = 100,
  ): Promise<MLOrderDetails[]> {
    const allOrders: MLOrderDetails[] = [];
    let offset = 0;
    const limit = 50; // ML aceita no máximo 50 por página

    try {
      while (allOrders.length < maxOrders) {
        const response = await this.getSellerOrders(accessToken, {
          seller: sellerId,
          status,
          offset,
          limit,
          sort: "date_desc", // Mais recentes primeiro
        });

        allOrders.push(...response.results);

        // Verificar se há mais páginas
        if (
          response.results.length < limit ||
          allOrders.length >= response.paging.total
        ) {
          break;
        }

        offset += limit;

        // Pequena pausa para evitar rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Limitar ao máximo especificado
      return allOrders.slice(0, maxOrders);
    } catch (error) {
      console.error("[ML API] Error fetching all orders:", error);
      throw error;
    }
  }

  /**
   * Obtém detalhes de um pedido específico
   * @param accessToken Token de acesso OAuth
   * @param orderId ID do pedido no ML
   */
  static async getOrderDetails(
    accessToken: string,
    orderId: string,
  ): Promise<MLOrderDetails> {
    try {
      const response = await axios.get<MLOrderDetails>(
        `${ML_CONSTANTS.API_URL}/orders/${orderId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          timeout: 10000,
        },
      );

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao obter detalhes do pedido: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Busca pedidos recentes (últimos N dias)
   * @param accessToken Token de acesso OAuth
   * @param sellerId ID do vendedor
   * @param days Número de dias para trás (padrão: 7)
   * @param status Status dos pedidos (opcional, padrão: "paid")
   */
  static async getRecentOrders(
    accessToken: string,
    sellerId: string,
    days: number = 7,
    status: MLOrderStatus = "paid",
  ): Promise<MLOrderDetails[]> {
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    const response = await this.getSellerOrders(accessToken, {
      seller: sellerId,
      status,
      dateCreatedFrom: dateFrom.toISOString(),
      sort: "date_desc",
      limit: 50,
    });

    return response.results;
  }

  /**
   * Cria um novo item no Mercado Livre
   * @param accessToken Token de acesso OAuth
   * @param payload Dados do item a ser criado
   */
  static async createItem(
    accessToken: string,
    payload: MLItemCreatePayload,
  ): Promise<MLItemDetails> {
    try {
      const response = await axios.post<MLItemDetails>(
        `${ML_CONSTANTS.API_URL}/items`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        },
      );

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorData = error.response?.data;
        const errorMessage = errorData
          ? JSON.stringify(errorData)
          : error.message;
        throw new Error(`Erro ao criar item: ${errorMessage}`);
      }
      throw error;
    }
  }
}
