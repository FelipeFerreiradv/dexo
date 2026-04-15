import { ListingUseCase } from "../usecases/listing.usercase";

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
    try {
      if (req.platform === "MERCADO_LIVRE") {
        await ListingUseCase.createMLListing(
          userId,
          productId,
          req.categoryId,
          req.accountId,
          req.mlSettings,
        );
        return;
      }
      if (req.platform === "SHOPEE") {
        const result = await ListingUseCase.createShopeeListing(
          userId,
          productId,
          req.categoryId,
          req.accountId,
        );
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
    }
  }
}
