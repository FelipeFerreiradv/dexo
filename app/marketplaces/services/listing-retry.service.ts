import { ListingRepository } from "../repositories/listing.repository";
import { MLApiService } from "./ml-api.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { ProductRepositoryPrisma } from "../../repositories/product.repository";
import { SystemLogService } from "../../services/system-log.service";

const BACKOFF_SECONDS = [30, 60, 120, 300, 900]; // exponential-ish backoff
const MAX_ATTEMPTS = BACKOFF_SECONDS.length;

export class ListingRetryService {
  private static running = false;
  private static intervalId: NodeJS.Timeout | null = null;

  /**
   * Run a single pass: find placeholders / pending retries and try to create them on ML.
   */
  static async runOnce() {
    console.log("[ListingRetryService] runOnce start");
    const now = new Date();
    const candidates = await ListingRepository.findPendingRetries(now, 200);
    console.log(`[ListingRetryService] candidates=${candidates?.length || 0}`);

    for (const cand of candidates) {
      try {
        console.log(`[ListingRetryService] processing candidate ${cand.id}`);
        // only handle placeholders (externals starting with PENDING_) or retryEnabled
        if (
          !cand.externalListingId?.startsWith("PENDING_") &&
          !cand.retryEnabled
        ) {
          console.log(
            `[ListingRetryService] skipping ${cand.id} (not placeholder/retryEnabled)`,
          );
          continue;
        }

        // defensive: skip if product missing
        if (!cand.product) {
          console.log(`[ListingRetryService] skipping ${cand.id} (no product)`);
          continue;
        }

        const account = cand.marketplaceAccount;
        if (!account || !account.accessToken) {
          console.log(
            `[ListingRetryService] skipping ${cand.id} (no account/token)`,
          );
          continue;
        }

        // Quick capability check
        try {
          console.log(
            `[ListingRetryService] capability check for account ${account.id}`,
          );
          await MLApiService.getSellerItemIds(
            account.accessToken,
            String(account.externalUserId || account.userId),
            "active",
            1,
          );
        } catch (capErr) {
          console.log(
            `[ListingRetryService] capability check failed for ${cand.id}: ${capErr?.message || capErr}`,
          );
          // schedule next retry
          const attempts = (cand.retryAttempts || 0) + 1;
          const nextDelay =
            BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
          await ListingRepository.incrementRetryAttempts(cand.id, {
            lastError: String(capErr?.message || capErr),
            nextRetryAt: new Date(Date.now() + nextDelay * 1000),
            retryEnabled: attempts < MAX_ATTEMPTS,
          });

          await SystemLogService.logError(
            "RETRY_LISTING",
            `Capability check failed for placeholder ${cand.id} (scheduling retry): ${String(capErr?.message || capErr)}`,
            { resource: "ProductListing", resourceId: cand.id },
          );
          continue;
        }

        console.log(
          `[ListingRetryService] capability OK for ${cand.id}, attempting createItem`,
        );

        // Build payload by reusing ListingUseCase flow indirectly: call MLApiService.createItem
        // (we only need ml item creation; existing placeholder will be updated)
        // NOTE: reuse product data from cand.product
        const product = cand.product as any;
        const payload: any = {
          title: product.name,
          // prefer the originally requested category (stored on placeholder); fallback to product.mlCategoryId; final fallback to the same default used elsewhere
          category_id:
            cand.requestedCategoryId ||
            cand.product?.mlCategoryId ||
            "MLB271107",
          price: Number(product.price || 0),
          currency_id: "BRL",
          available_quantity: product.stock || 1,
          buying_mode: "buy_it_now",
          listing_type_id: "bronze",
          condition: product.quality === "NOVO" ? "new" : "not_specified",
          pictures: product.imageUrl ? [{ source: product.imageUrl }] : [],
          attributes: [{ id: "SELLER_SKU", value_name: product.sku }],
          seller_custom_field: product.sku,
        };

        let mlItem: any = null;
        try {
          console.log(
            `[ListingRetryService] calling createItem for ${cand.id}`,
          );
          mlItem = await MLApiService.createItem(account.accessToken, payload);
          console.log(
            `[ListingRetryService] createItem returned for ${cand.id}: ${mlItem?.id}`,
          );
        } catch (createErr) {
          const rawMsg = String(createErr?.message || createErr);
          const parsed =
            createErr && (createErr as any).mlError
              ? (createErr as any).mlError
              : null;
          console.log(
            `[ListingRetryService] createItem error for ${cand.id}: ${rawMsg}`,
          );

          // If ML returned a policy restriction (e.g. restrictions_coliving) treat as non-retryable
          if (
            /restrictions_\w+/i.test(rawMsg) ||
            /restrictions_coliving/i.test(rawMsg)
          ) {
            await ListingRepository.updateListing(cand.id, {
              lastError: rawMsg,
              retryEnabled: false,
              nextRetryAt: null,
            });

            await SystemLogService.logError(
              "RETRY_LISTING",
              `createItem non-retryable policy error for placeholder ${cand.id}: ${rawMsg}`,
              {
                resource: "ProductListing",
                resourceId: cand.id,
                details: { mlError: parsed || rawMsg },
              },
            );
            continue;
          }

          const attempts = (cand.retryAttempts || 0) + 1;
          const nextDelay =
            BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
          await ListingRepository.incrementRetryAttempts(cand.id, {
            lastError: rawMsg,
            nextRetryAt: new Date(Date.now() + nextDelay * 1000),
            retryEnabled: attempts < MAX_ATTEMPTS,
          });

          await SystemLogService.logError(
            "RETRY_LISTING",
            `createItem failed for placeholder ${cand.id}, scheduling retry: ${rawMsg}`,
            { resource: "ProductListing", resourceId: cand.id },
          );
          continue;
        }

        // Success: update existing placeholder with ML id and mark active
        console.debug(
          `[ListingRetryService] ML created for placeholder ${cand.id} -> ${mlItem.id}`,
        );
        await ListingRepository.updateListing(cand.id, {
          externalListingId: mlItem.id,
          permalink: mlItem.permalink || null,
          status: "active",
          retryEnabled: false,
          nextRetryAt: null,
          lastError: null,
          retryAttempts: 0,
        });

        console.debug(
          `[ListingRetryService] updated placeholder ${cand.id} in DB`,
        );
        await SystemLogService.logError(
          "RETRY_LISTING",
          `Placeholder ${cand.id} successfully posted to ML (${mlItem.id})`,
          { resource: "ProductListing", resourceId: cand.id },
        );
      } catch (err) {
        // unexpected error
        try {
          await ListingRepository.incrementRetryAttempts(cand.id, {
            lastError: String(err?.message || err),
            nextRetryAt: new Date(Date.now() + 60 * 1000),
            retryEnabled: true,
          });
        } catch (e) {
          /* ignore */
        }
        await SystemLogService.logError(
          "RETRY_LISTING",
          `Unexpected error while retrying placeholder ${cand.id}: ${String(err?.message || err)}`,
          { resource: "ProductListing", resourceId: cand.id },
        );
      }
    }
  }

  static start(intervalMs = 60 * 1000) {
    if (this.running) return;
    this.running = true;
    this.intervalId = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
  }

  static stop() {
    if (this.intervalId) clearInterval(this.intervalId as NodeJS.Timeout);
    this.intervalId = null;
    this.running = false;
  }
}
