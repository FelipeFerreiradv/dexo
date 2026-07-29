import axios from "axios";
import {
  FACEBOOK_CONSTANTS,
  facebookGraphBase,
} from "../facebook/facebook-constants";
import type {
  FacebookAvailability,
  FacebookBatchRequest,
  FacebookBatchStatusEntry,
  FacebookBatchStatusResponse,
  FacebookCatalogItemData,
  FacebookCatalogProduct,
  FacebookCatalogProductsResponse,
  FacebookItemsBatchRequest,
  FacebookItemsBatchResponse,
} from "../types/facebook-api.types";

/**
 * Cliente da Graph Catalog Batch API (Meta Commerce Catalog).
 *
 * ⚠️ Difere da OLX: usa `Authorization: Bearer` (não token no corpo) e o host é
 * graph.facebook.com. O item é endereçado por `retailer_id` (= SKU). O batch é
 * síncrono em lote (devolve `handles`); o resultado por-item pode ser conferido
 * em check_batch_request_status (opcional — best-effort).
 *
 * Operações:
 *   - CREATE/UPDATE de item (upsertItem, allow_upsert liga CREATE→update).
 *   - UPDATE de disponibilidade (setAvailability) — usado na baixa de estoque
 *     (0 → 'out of stock'; refill → 'in stock'). O item PERMANECE no catálogo.
 *   - DELETE (deleteItem) — só no desvínculo real do listing.
 */
export class FacebookApiService {
  private static formatError(prefix: string, error: unknown): Error {
    if (axios.isAxiosError(error)) {
      const data: any = error.response?.data;
      const apiMessage =
        data?.error?.message ||
        data?.error?.error_user_msg ||
        data?.message ||
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

  private static catalogId(catalogId?: string): string {
    const id = catalogId ?? FACEBOOK_CONSTANTS.CATALOG_ID;
    if (!id) {
      throw new Error(
        "FACEBOOK_CATALOG_ID não configurado (integração Facebook)",
      );
    }
    return id;
  }

  /**
   * Envia um lote de operações ao catálogo (POST /{catalog_id}/items_batch).
   * Retorna os `handles` (usados no check de status). Guard de tamanho de lote.
   */
  static async submitItemsBatch(
    accessToken: string,
    requests: FacebookBatchRequest[],
    opts?: { catalogId?: string; allowUpsert?: boolean },
  ): Promise<FacebookItemsBatchResponse> {
    try {
      if (requests.length > FACEBOOK_CONSTANTS.MAX_REQUESTS_PER_BATCH) {
        throw new Error(
          `Lote Facebook excede ${FACEBOOK_CONSTANTS.MAX_REQUESTS_PER_BATCH} requests`,
        );
      }
      const url = `${facebookGraphBase()}/${this.catalogId(opts?.catalogId)}/items_batch`;
      const body: FacebookItemsBatchRequest = {
        item_type: "PRODUCT_ITEM",
        requests,
        ...(opts?.allowUpsert != null
          ? { allow_upsert: opts.allowUpsert }
          : {}),
      };
      const response = await axios.post<FacebookItemsBatchResponse>(url, body, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: FACEBOOK_CONSTANTS.REQUEST_TIMEOUT,
      });
      // A Meta devolve 200 + handles mesmo quando um item é rejeitado. Quando
      // presente, `validation_status` traz os erros SÍNCRONOS por retailer_id —
      // transforma-os em Error (com responseData) p/ o classify decidir.
      const validationError = this.firstValidationError(response.data);
      if (validationError) {
        const err = new Error(`Facebook rejeitou o item: ${validationError}`);
        (err as any).responseData = response.data;
        throw err;
      }
      return response.data;
    } catch (error) {
      throw this.formatError("Erro ao enviar items_batch ao Facebook", error);
    }
  }

  /**
   * Extrai a 1ª mensagem de erro de `validation_status` (se presente). A Meta
   * só popula esse campo em erros de validação síncronos; ausente ⇒ null (o
   * resultado real vem no poll de check_batch_request_status).
   */
  private static firstValidationError(
    data: FacebookItemsBatchResponse | undefined,
  ): string | null {
    const entries = data?.validation_status;
    if (!Array.isArray(entries)) return null;
    for (const entry of entries) {
      const errors = entry?.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const first: any = errors[0];
        return (
          first?.message ||
          first?.error_user_msg ||
          (typeof first === "string" ? first : JSON.stringify(first))
        );
      }
    }
    return null;
  }

  /**
   * Insere/edita UM item (CREATE com allow_upsert → cria ou atualiza pelo
   * retailer_id). Editar = mesmo retailer_id.
   */
  static async upsertItem(
    accessToken: string,
    retailerId: string,
    data: FacebookCatalogItemData,
    opts?: { catalogId?: string },
  ): Promise<FacebookItemsBatchResponse> {
    return this.submitItemsBatch(
      accessToken,
      [{ method: "CREATE", retailer_id: retailerId, data }],
      { catalogId: opts?.catalogId, allowUpsert: true },
    );
  }

  /** UPDATE de um item existente via items_batch (endereçado por retailer_id). */
  static async updateItem(
    accessToken: string,
    retailerId: string,
    data: FacebookCatalogItemData,
    opts?: { catalogId?: string },
  ): Promise<FacebookItemsBatchResponse> {
    return this.submitItemsBatch(
      accessToken,
      [{ method: "UPDATE", retailer_id: retailerId, data }],
      { catalogId: opts?.catalogId },
    );
  }

  /**
   * Atualiza SÓ a disponibilidade de um item (UPDATE availability). Usado na
   * baixa de estoque: 0 → 'out of stock'; refill → 'in stock'. O item continua
   * no catálogo (≠ delete da OLX). `quantity` é opcional (espelha o estoque).
   */
  static async setAvailability(
    accessToken: string,
    retailerId: string,
    availability: FacebookAvailability,
    opts?: { catalogId?: string; quantity?: number },
  ): Promise<FacebookItemsBatchResponse> {
    const data: FacebookCatalogItemData = { availability };
    if (opts?.quantity != null) {
      data.quantity_to_sell_on_facebook = Math.max(
        0,
        Math.trunc(opts.quantity),
      );
    }
    return this.submitItemsBatch(
      accessToken,
      [{ method: "UPDATE", retailer_id: retailerId, data }],
      { catalogId: opts?.catalogId },
    );
  }

  /** Remove UM item do catálogo (DELETE). Só `retailer_id` é necessário. */
  static async deleteItem(
    accessToken: string,
    retailerId: string,
    opts?: { catalogId?: string },
  ): Promise<FacebookItemsBatchResponse> {
    return this.submitItemsBatch(
      accessToken,
      [{ method: "DELETE", retailer_id: retailerId }],
      { catalogId: opts?.catalogId },
    );
  }

  /**
   * Lê os itens do catálogo (GET /{catalog_id}/products) para o vínculo por SKU
   * do "Importar anúncios". Pagina pelo cursor `after` até esgotar (ou trava de
   * segurança). Retorna a lista crua; `normalizeFacebookItem` casa por
   * `retailer_id` (= SKU). Espelha MagaluApiService.listSkus, mas com cursor.
   */
  static async listCatalogItems(
    accessToken: string,
    opts?: { catalogId?: string; limit?: number; maxPages?: number },
  ): Promise<FacebookCatalogProduct[]> {
    const limit = opts?.limit ?? 100;
    const maxPages = opts?.maxPages ?? 200; // trava (até 20k itens) contra loop
    const fields = "id,retailer_id,name,availability,url,price,image_url";
    const items: FacebookCatalogProduct[] = [];
    let after: string | undefined;
    try {
      for (let page = 0; page < maxPages; page++) {
        const url = new URL(
          `${facebookGraphBase()}/${this.catalogId(opts?.catalogId)}/products`,
        );
        url.searchParams.set("fields", fields);
        url.searchParams.set("limit", String(limit));
        if (after) url.searchParams.set("after", after);
        const response = await axios.get<FacebookCatalogProductsResponse>(
          url.toString(),
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: FACEBOOK_CONSTANTS.REQUEST_TIMEOUT,
          },
        );
        const pageItems = response.data?.data ?? [];
        items.push(...pageItems);
        after = response.data?.paging?.cursors?.after;
        if (!after || pageItems.length === 0) break;
      }
      return items;
    } catch (error) {
      throw this.formatError(
        "Erro ao listar itens do catálogo Facebook",
        error,
      );
    }
  }

  /**
   * Confere o status de um batch (GET check_batch_request_status). Best-effort:
   * a Meta processa o batch de forma assíncrona; usado só para diagnóstico do
   * resultado por-handle. Não lança em ausência de dados.
   */
  static async checkBatchStatus(
    accessToken: string,
    handle: string,
    opts?: { catalogId?: string },
  ): Promise<FacebookBatchStatusResponse> {
    try {
      const url = new URL(
        `${facebookGraphBase()}/${this.catalogId(opts?.catalogId)}/check_batch_request_status`,
      );
      url.searchParams.set("handle", handle);
      const response = await axios.get<FacebookBatchStatusResponse>(
        url.toString(),
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: FACEBOOK_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
      return response.data ?? { data: [] };
    } catch (error) {
      throw this.formatError(
        "Erro ao consultar status do items_batch no Facebook",
        error,
      );
    }
  }

  /**
   * Faz poll do status de um batch até sair de "in_progress" (finished/error)
   * ou esgotar as tentativas. Best-effort: devolve a última entrada obtida (ou
   * null). Espelha OlxApiService.pollImportUntilDone — usado na PUBLICAÇÃO para
   * capturar rejeições assíncronas da Meta (o corpo do items_batch devolve 200
   * mesmo com item rejeitado). Não lança em timeout de poll (o chamador decide).
   */
  static async pollBatchUntilDone(
    accessToken: string,
    handle: string,
    opts?: { catalogId?: string; intervalMs?: number; maxAttempts?: number },
  ): Promise<FacebookBatchStatusEntry | null> {
    const interval =
      opts?.intervalMs ?? FACEBOOK_CONSTANTS.BATCH_POLL_INTERVAL_MS;
    const maxAttempts =
      opts?.maxAttempts ?? FACEBOOK_CONSTANTS.BATCH_POLL_MAX_ATTEMPTS;

    let last: FacebookBatchStatusEntry | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const status = await this.checkBatchStatus(accessToken, handle, {
          catalogId: opts?.catalogId,
        });
        last =
          status?.data?.find((e) => e.handle === handle) ??
          status?.data?.[0] ??
          null;
        if (last && last.status !== "in_progress") {
          return last;
        }
      } catch (err) {
        console.warn(
          `[FacebookApiService] poll status falhou (tentativa ${attempt + 1}):`,
          err instanceof Error ? err.message : String(err),
        );
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    return last;
  }
}
