import { ListingUseCase, ListingFullEditInput } from "../usecases/listing.usercase";
import { ProductRepositoryPrisma } from "../../repositories/product.repository";
import prisma from "../../lib/prisma";
import { applyRules, type BulkRulesProductInput } from "./bulk-listing-rules.service";
import type {
  BulkOverrideTemplate,
  BulkListingItemResult,
  BulkListingPlatform,
} from "../repositories/bulk-listing-job.repository";

export type ListingPlatform = "MERCADO_LIVRE" | "SHOPEE";

export interface ListingDispatchRequest {
  platform: ListingPlatform;
  accountId?: string;
  categoryId?: string;
  mlSettings?: {
    listingType?: string;
    hasWarranty?: boolean;
    warrantyUnit?: string;
    warrantyDuration?: number;
    itemCondition?: string;
    shippingMode?: string;
    freeShipping?: boolean;
    localPickup?: boolean;
    manufacturingTime?: number;
  };
}

export interface ListingDispatchInput {
  userId: string;
  productId: string;
  requests: ListingDispatchRequest[];
}

export interface BulkRunRequest {
  platform: BulkListingPlatform;
  accountId: string;
  categoryId?: string;
  mlSettings?: ListingDispatchRequest["mlSettings"];
}

export interface ListingDispatchSnapshot {
  queued: Array<{
    platform: ListingPlatform;
    accountId?: string;
  }>;
}

/**
 * Ponto único de orquestração para criação de anúncios em múltiplos
 * marketplaces. Substitui os blocos fire-and-forget duplicados em
 * `POST /products` (criação) e, futuramente, no fluxo de edição.
 *
 * Comportamento atual (slice 1 da Fase 3):
 *  - Fire-and-forget por request (platform × account).
 *  - Erros individuais são logados mas não propagam — caller recebe o
 *    snapshot do que foi enfileirado imediatamente.
 *  - Preflight, persistência de status e polling serão adicionados em
 *    slices futuros sem quebrar callers.
 */
export class ListingDispatcher {
  static dispatch(input: ListingDispatchInput): ListingDispatchSnapshot {
    const { userId, productId, requests } = input;
    const queued: ListingDispatchSnapshot["queued"] = [];

    for (const req of requests) {
      queued.push({ platform: req.platform, accountId: req.accountId });
      void this.runOne(userId, productId, req);
    }

    console.log(
      JSON.stringify({
        event: "listing.dispatch",
        productId,
        userId,
        count: queued.length,
        platforms: queued.map((q) => q.platform),
      }),
    );

    return { queued };
  }

  private static async runOne(
    userId: string,
    productId: string,
    req: ListingDispatchRequest,
  ): Promise<void> {
    // Observabilidade simétrica ML↔Shopee. createMLListing e createShopeeListing
    // ambos retornam CreateListingResult com `success: boolean`. Antes desta
    // simetria, ML descartava o retorno e falhas "normais" (success: false sem
    // throw) ficavam invisíveis — o placeholder PENDING_ era criado, status ia
    // pra "error" no banco, mas nada aparecia no log. O usuário só percebia
    // pelo ícone dimmed no frontend.
    try {
      if (req.platform === "MERCADO_LIVRE") {
        const result = await ListingUseCase.createMLListing(
          userId,
          productId,
          req.categoryId,
          req.accountId,
          req.mlSettings,
        );
        this.logDispatchResult({
          userId,
          productId,
          req,
          success: !!result.success,
          listingId: (result as any).listingId,
          externalListingId: (result as any).externalListingId,
          error: result.success ? null : result.error || null,
          mlError: (result as any).mlError || null,
        });
        if (!result.success) {
          console.error(
            `[ListingDispatcher] MERCADO_LIVRE listing failed (product=${productId}, account=${req.accountId}): ${result.error}`,
          );
        }
        return;
      }
      if (req.platform === "SHOPEE") {
        const result = await ListingUseCase.createShopeeListing(
          userId,
          productId,
          req.categoryId,
          req.accountId,
        );
        this.logDispatchResult({
          userId,
          productId,
          req,
          success: !!result.success,
          listingId: (result as any).listingId,
          externalListingId: (result as any).externalListingId,
          error: result.success ? null : result.error || null,
        });
        if (!result.success) {
          console.error(
            `[ListingDispatcher] Shopee listing failed (product=${productId}, account=${req.accountId}): ${result.error}`,
          );
        }
        return;
      }
    } catch (err) {
      console.error(
        `[ListingDispatcher] ${req.platform} error (product=${productId}, account=${req.accountId}):`,
        err instanceof Error ? err.message : err,
      );
      this.logDispatchResult({
        userId,
        productId,
        req,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        threw: true,
      });
    }
  }

  /**
   * Log estruturado de resultado de cada plataforma×conta. Mesmo formato JSON
   * one-line do `listing.dispatch` event que já existe (linha 72), pra ficar
   * grep-friendly. Não deve lançar — falhas de logging não devem mascarar
   * resultados reais.
   */
  private static logDispatchResult(args: {
    userId: string;
    productId: string;
    req: ListingDispatchRequest;
    success: boolean;
    listingId?: string;
    externalListingId?: string;
    error?: string | null;
    mlError?: unknown;
    threw?: boolean;
  }) {
    try {
      console.log(
        JSON.stringify({
          event: "listing.dispatch.result",
          productId: args.productId,
          userId: args.userId,
          platform: args.req.platform,
          accountId: args.req.accountId,
          success: args.success,
          listingId: args.listingId,
          externalListingId: args.externalListingId,
          error: args.error,
          mlError:
            args.mlError !== undefined && args.mlError !== null
              ? typeof args.mlError === "string"
                ? args.mlError
                : (() => {
                    try {
                      return JSON.stringify(args.mlError);
                    } catch {
                      return String(args.mlError);
                    }
                  })()
              : null,
          threw: args.threw || false,
        }),
      );
    } catch {
      // ignore
    }
  }

  /**
   * Variante batch: cria N produtos × M requests (platform × account) com
   * concorrência fixa (mesmo padrão do bulk-delete na UI). Espera cada
   * createMLListing/createShopeeListing finalizar e, em caso de sucesso,
   * aplica overrides do template via updateListingFields.
   *
   * `onItemDone` é chamado AO FINAL de cada par (productId, request) com o
   * resultado completo — usado pelo endpoint para persistir progresso no
   * BulkListingJob.
   *
   * Erros individuais nunca propagam; sempre viram um item com success=false.
   */
  static async dispatchBatch(input: {
    userId: string;
    productIds: string[];
    requests: Array<{
      platform: BulkListingPlatform;
      accountId: string;
      categoryId?: string;
      mlSettings?: ListingDispatchRequest["mlSettings"];
    }>;
    overrideTemplate?: BulkOverrideTemplate | null;
    onItemDone: (item: BulkListingItemResult) => void | Promise<void>;
  }): Promise<{ success: number; failed: number; lastError?: string | null }> {
    type Pair = { productId: string; req: BulkRunRequest };
    const pairs: Pair[] = [];
    for (const pid of input.productIds) {
      for (const r of input.requests) {
        pairs.push({
          productId: pid,
          req: {
            platform: r.platform,
            accountId: r.accountId,
            categoryId: r.categoryId,
            mlSettings: r.mlSettings,
          },
        });
      }
    }

    let success = 0;
    let failed = 0;
    let lastError: string | null = null;

    // Otimização: quando há overrideTemplate, applyRules precisa apenas de
    // (id, name, price, costPrice) por produto. Em vez de N findById com JOIN
    // pesado em compatibilidades dentro de cada worker, faz UM SELECT enxuto
    // antes do pool. O cache é compartilhado entre workers.
    let productRulesCache: Map<string, BulkRulesProductInput> | null = null;
    if (input.overrideTemplate && input.productIds.length > 0) {
      const lite = await prisma.product.findMany({
        where: { id: { in: input.productIds }, userId: input.userId },
        select: { id: true, name: true, price: true, costPrice: true },
      });
      productRulesCache = new Map();
      for (const p of lite) {
        productRulesCache.set(p.id, {
          id: p.id,
          name: p.name,
          price: p.price as unknown as number | { toNumber(): number },
          costPrice: p.costPrice as unknown as
            | number
            | { toNumber(): number }
            | null
            | undefined,
        });
      }
    }

    const concurrency = Math.min(4, pairs.length);
    let cursor = 0;

    const worker = async () => {
      while (cursor < pairs.length) {
        const idx = cursor++;
        const { productId, req } = pairs[idx];
        const result = await this.runOneWithResult(
          input.userId,
          productId,
          req,
          input.overrideTemplate ?? null,
          productRulesCache,
        );
        if (result.success) success++;
        else {
          failed++;
          if (result.error) lastError = result.error;
        }
        try {
          await onItemDoneSafe(input.onItemDone, result);
        } catch (e) {
          console.error("[ListingDispatcher] onItemDone callback failed", e);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    return { success, failed, lastError };
  }

  /**
   * Wrapper de runOne que captura o resultado em vez de descartar (como o
   * fire-and-forget do dispatch single). Aplica overrides após criação.
   */
  static async runOneWithResult(
    userId: string,
    productId: string,
    req: BulkRunRequest,
    overrideTemplate: BulkOverrideTemplate | null,
    productRulesCache?: Map<string, BulkRulesProductInput> | null,
  ): Promise<BulkListingItemResult> {
    const finishedAt = () => new Date().toISOString();

    try {
      let createResult;
      if (req.platform === "MERCADO_LIVRE") {
        createResult = await ListingUseCase.createMLListing(
          userId,
          productId,
          req.categoryId,
          req.accountId,
          req.mlSettings,
        );
      } else if (req.platform === "SHOPEE") {
        createResult = await ListingUseCase.createShopeeListing(
          userId,
          productId,
          req.categoryId,
          req.accountId,
        );
      } else {
        return {
          productId,
          platform: req.platform,
          accountId: req.accountId,
          success: false,
          error: `Plataforma não suportada: ${req.platform}`,
          finishedAt: finishedAt(),
        };
      }

      if (!createResult.success || !createResult.listingId) {
        return {
          productId,
          platform: req.platform,
          accountId: req.accountId,
          success: false,
          error: createResult.error ?? "Falha desconhecida na criação",
          finishedAt: finishedAt(),
        };
      }

      // Sucesso na criação — aplicar overrides se o template render algum.
      if (overrideTemplate) {
        try {
          // Usa cache pre-fetched do dispatchBatch quando disponível; caso
          // contrário, faz fallback ao repositório (caminho antigo, mantido
          // para callers que invocam runOneWithResult fora do batch).
          let productRules: BulkRulesProductInput | undefined =
            productRulesCache?.get(productId);
          if (!productRules) {
            const product = await new ProductRepositoryPrisma().findById(
              productId,
            );
            if (product) {
              productRules = {
                id: product.id,
                name: product.name,
                price: product.price as unknown as number | { toNumber(): number },
                costPrice: product.costPrice as unknown as
                  | number
                  | { toNumber(): number }
                  | null
                  | undefined,
              };
            }
          }

          if (productRules) {
            const fields = applyRules(productRules, overrideTemplate);
            if (fields) {
              const upd = await ListingUseCase.updateListingFields(
                createResult.listingId,
                userId,
                fields as ListingFullEditInput,
              );
              if (!upd.success) {
                console.warn(
                  `[ListingDispatcher] override apply falhou (listing=${createResult.listingId}): ${upd.error}`,
                );
              }
            }
          }
        } catch (overrideErr) {
          console.warn(
            "[ListingDispatcher] override apply lançou exceção:",
            overrideErr instanceof Error ? overrideErr.message : overrideErr,
          );
        }
      }

      return {
        productId,
        platform: req.platform,
        accountId: req.accountId,
        success: true,
        listingId: createResult.listingId,
        externalListingId: createResult.externalListingId,
        finishedAt: finishedAt(),
      };
    } catch (err) {
      return {
        productId,
        platform: req.platform,
        accountId: req.accountId,
        success: false,
        error: err instanceof Error ? err.message : "Erro desconhecido",
        finishedAt: finishedAt(),
      };
    }
  }
}

async function onItemDoneSafe(
  cb: ((item: BulkListingItemResult) => void | Promise<void>) | undefined,
  item: BulkListingItemResult,
) {
  if (!cb) return;
  await cb(item);
}
