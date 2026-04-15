import { ListingRepository } from "../repositories/listing.repository";
import { MLApiService } from "./ml-api.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { ProductRepositoryPrisma } from "../../repositories/product.repository";
import { SystemLogService } from "../../services/system-log.service";
import { MLItemCreatePayload } from "../types/ml-api.types";
import { CategoryResolutionService } from "./category-resolution.service";
import { ensureMLMinImageSize } from "./image-resize.service";
import { UserRepositoryPrisma } from "../../repositories/user.repository";

const BACKOFF_SECONDS = [30, 60, 120, 300, 900]; // exponential-ish backoff
const MAX_ATTEMPTS = BACKOFF_SECONDS.length;
const errMsg = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const ML_MIN_DIM_CM = 1;
const ML_MAX_DIM_CM = Number(process.env.ML_MAX_DIM_CM || 200);
const ML_MIN_WEIGHT_KG = 0.05;
const ML_MAX_WEIGHT_KG = Number(process.env.ML_MAX_WEIGHT_KG || 70);

// Reaplica lógica de título/descrição do ListingUseCase, evitando sujar o item
const sanitizeTitle = (raw: string, product: any, maxLen = 60) => {
  const base = raw || product?.name || "";
  let fullTitle = base
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (fullTitle.length > maxLen)
    fullTitle = fullTitle.substring(0, maxLen).trim();
  if (!fullTitle) fullTitle = product?.sku || "Produto";
  return fullTitle;
};

const buildSafeTitle = (product: any) => {
  const primary = sanitizeTitle(product?.name || "", product, 60);
  if (primary && primary !== "Produto") return primary;
  const parts: string[] = [];
  if (product.brand) parts.push(product.brand);
  if (product.model) parts.push(product.model);
  if (product.year) parts.push(product.year);
  if (parts.length === 0 && product.sku) parts.push(product.sku);
  return sanitizeTitle(parts.join(" "), product, 60);
};

const buildDescription = (product: any) => {
  if (product.description) {
    return product.description;
  }

  const blocks: string[] = [];
  const headline = [product.name, product.brand, product.model]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (headline) blocks.push(headline);

  const details: string[] = [];
  if (product.brand) details.push(`Marca: ${product.brand}`);
  if (product.model) details.push(`Modelo: ${product.model}`);
  if (product.year) details.push(`Ano: ${product.year}`);
  if (product.version) details.push(`Versão: ${product.version}`);
  if (product.partNumber) details.push(`Número da Peça: ${product.partNumber}`);
  if (product.quality) details.push(`Qualidade: ${product.quality}`);
  if (product.location) details.push(`Localização: ${product.location}`);
  if (product.heightCm && product.widthCm && product.lengthCm) {
    details.push(
      `Dimensões (cm): ${product.heightCm} x ${product.widthCm} x ${product.lengthCm}`,
    );
  }
  if (product.weightKg) details.push(`Peso: ${product.weightKg} kg`);

  if (details.length > 0) {
    blocks.push("Detalhes Técnicos:");
    blocks.push(details.join("\n"));
  }

  if (product.sku) blocks.push(`SKU: ${product.sku}`);
  return blocks.join("\n\n");
};

const sanitizePackageDimensions = (input?: {
  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightKg?: number;
}) => {
  if (
    !input ||
    input.heightCm == null ||
    input.widthCm == null ||
    input.lengthCm == null ||
    input.weightKg == null
  ) {
    return null;
  }

  const clamp = (v: number, min: number, max: number) =>
    Math.min(Math.max(Math.round(v), min), max);

  const height = clamp(input.heightCm, ML_MIN_DIM_CM, ML_MAX_DIM_CM);
  const width = clamp(input.widthCm, ML_MIN_DIM_CM, ML_MAX_DIM_CM);
  const length = clamp(input.lengthCm, ML_MIN_DIM_CM, ML_MAX_DIM_CM);

  const weightKgRaw = Number(input.weightKg);
  if (!Number.isFinite(weightKgRaw)) return null;
  const weightKg = clamp(weightKgRaw, ML_MIN_WEIGHT_KG, ML_MAX_WEIGHT_KG);

  return { height, width, length, weightKg };
};

// Pre-built sets from env (read once at module load, not per-call)
const FAMILY_NAME_HARD_IDS = [
  "MLB193419", "MLB101763", "MLB458642", "MLB1754", "MLB22693",
  "MLB191833", "MLB193531", "MLB116479", "MLB193613", "MLB188061",
];

const _familyAllowSet = new Set<string>([
  ...FAMILY_NAME_HARD_IDS,
  ...(process.env.ML_FAMILY_NAME_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean),
]);
const _forceFamily = process.env.ML_FORCE_FAMILY_NAME?.toLowerCase() === "true";

const shouldIncludeFamilyName = (categoryId?: string) =>
  _forceFamily || (categoryId ? _familyAllowSet.has(categoryId) : false);

const _noTitleSet = new Set<string>([
  ...FAMILY_NAME_HARD_IDS,
  ...(process.env.ML_NO_TITLE_WITH_FAMILY || "").split(",").map((s) => s.trim()).filter(Boolean),
]);

const noTitleWithFamily = (categoryId?: string) =>
  categoryId ? _noTitleSet.has(categoryId) : false;

const _categoryOverrideMap = new Map<string, string>();
(process.env.ML_CATEGORY_OVERRIDE || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .forEach((pair) => {
    const [from, to] = pair.split(":").map((s) => s.trim());
    if (from && to) _categoryOverrideMap.set(from, to);
  });

const categoryOverride = (categoryId?: string) =>
  categoryId && _categoryOverrideMap.has(categoryId) ? _categoryOverrideMap.get(categoryId) : undefined;

// Pre-compiled regex for Shopee terminal error detection
const SHOPEE_TERMINAL_RE = /excede os limites de todos os canais|duplicates? another|duplicate.*shop|selecione uma categoria|categoria.*inv[aá]lida/i;

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

        // Shopee placeholders: delegar para ListingUseCase.createShopeeListing
        if (
          account?.platform === "SHOPEE" ||
          cand.externalListingId?.startsWith("PENDING_SHP_")
        ) {
          console.log(
            `[ListingRetryService] delegating Shopee retry for ${cand.id} to createShopeeListing`,
          );
          try {
            const { ListingUseCase } =
              await import("../usecases/listing.usercase");
            const result = await ListingUseCase.createShopeeListing(
              account?.userId || "",
              cand.productId,
              cand.requestedCategoryId || undefined,
              account?.id,
            );
            if (result.success) {
              console.log(
                `[ListingRetryService] Shopee retry succeeded for ${cand.id}: ${result.externalListingId}`,
              );
            } else {
              // createShopeeListing already updates the listing placeholder in its
              // own catch block (with terminal classification and attempt tracking).
              // Log here for observability only.
              console.warn(
                `[ListingRetryService] Shopee retry failed for ${cand.id}: ${result.error}`,
              );
            }
          } catch (shopeeErr) {
            const msg = errMsg(shopeeErr);
            console.error(
              `[ListingRetryService] Shopee retry exception for ${cand.id}:`,
              msg,
            );
            // Classify terminal Shopee errors that should stop retry
            const isTerminal = SHOPEE_TERMINAL_RE.test(msg);

            const attempts = (cand.retryAttempts || 0) + 1;
            const shouldRetry = !isTerminal && attempts < MAX_ATTEMPTS;
            const nextDelay =
              BACKOFF_SECONDS[
                Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)
              ];
            await ListingRepository.incrementRetryAttempts(cand.id, {
              lastError: (isTerminal ? "[TERMINAL] " : "") + msg.substring(0, 490),
              nextRetryAt: shouldRetry ? new Date(Date.now() + nextDelay * 1000) : null,
              retryEnabled: shouldRetry,
            });
            if (isTerminal) {
              console.warn(
                `[ListingRetryService] Shopee terminal error for ${cand.id} — retry disabled`,
              );
            }
          }
          continue;
        }
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
            `[ListingRetryService] capability check failed for ${cand.id}: ${errMsg(capErr)}`,
          );
          // schedule next retry
          const attempts = (cand.retryAttempts || 0) + 1;
          const nextDelay =
            BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
          await ListingRepository.incrementRetryAttempts(cand.id, {
            lastError: errMsg(capErr),
            nextRetryAt: new Date(Date.now() + nextDelay * 1000),
            retryEnabled: attempts < MAX_ATTEMPTS,
          });

          await SystemLogService.logError(
            "RETRY_LISTING" as any,
            `Capability check failed for placeholder ${cand.id} (scheduling retry): ${errMsg(capErr)}`,
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
        const retryTitle = sanitizeTitle(product.name || "", product, 60);
        const backendBase =
          process.env.APP_BACKEND_URL || "http://localhost:3333";

        // Carregar padrões do usuário para ML settings
        const userRepo = new UserRepositoryPrisma();
        const retryUserId = account.userId || (cand as any).userId;
        let userDefaults: any = {};
        try {
          if (retryUserId) {
            const user = await userRepo.findById(retryUserId);
            if (user) {
              userDefaults = {
                listingType: user.defaultListingType || "bronze",
                itemCondition: user.defaultItemCondition,
                hasWarranty: user.defaultHasWarranty || false,
                warrantyUnit: user.defaultWarrantyUnit || "dias",
                warrantyDuration: user.defaultWarrantyDuration || 30,
                shippingMode: user.defaultShippingMode || "me2",
                freeShipping: user.defaultFreeShipping || false,
                localPickup: user.defaultLocalPickup || false,
                manufacturingTime: user.defaultManufacturingTime || 0,
              };
            }
          }
        } catch (e) {
          console.warn(
            "[ListingRetryService] failed to load user defaults:",
            e,
          );
        }

        // Resolve categoria de forma determinística: explicit -> produto -> erro
        const resolvedCategory =
          await CategoryResolutionService.resolveMLCategory({
            explicitCategoryId: cand.requestedCategoryId || undefined,
            product,
            validateWithMLAPI: true,
          });
        const resolvedCategoryId = resolvedCategory.externalId;

        const pkg = sanitizePackageDimensions({
          heightCm: product.heightCm,
          widthCm: product.widthCm,
          lengthCm: product.lengthCm,
          weightKg: product.weightKg,
        });

        const retryCondition =
          userDefaults.itemCondition ||
          (product.quality === "NOVO" ? "new" : "used");

        const payload: any = {
          title: retryTitle,
          category_id: resolvedCategoryId,
          price: Number(product.price || 0),
          currency_id: "BRL",
          available_quantity: product.stock || 1,
          buying_mode: "buy_it_now",
          listing_type_id: userDefaults.listingType || "bronze",
          condition: retryCondition,
          pictures: await (async () => {
            if (!product.imageUrl) return [];
            // Coletar todas as URLs de imagens
            const allImageUrls: string[] = [];
            if (
              (product as any).imageUrls &&
              (product as any).imageUrls.length > 0
            ) {
              allImageUrls.push(...(product as any).imageUrls);
            } else {
              allImageUrls.push(product.imageUrl);
            }

            const { join } = await import("path");
            const { readFile } = await import("fs/promises");
            const pics: Array<{ id: string } | { source: string }> = [];

            for (const rawUrl of allImageUrls) {
              const imgUrl = rawUrl.startsWith("http")
                ? rawUrl.replace(
                    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i,
                    backendBase,
                  )
                : `${backendBase}${rawUrl}`;

              const urlPath = new URL(imgUrl).pathname;
              const fileName = urlPath.split("/").pop() || "image.jpg";

              let imageBuffer: Buffer | null = null;

              if (urlPath.startsWith("/uploads/")) {
                const localPath = join(process.cwd(), "public", urlPath);
                try {
                  imageBuffer = await readFile(localPath);
                } catch {
                  // fallback to HTTP below
                }
              }

              if (!imageBuffer) {
                try {
                  const axiosLib = (await import("axios")).default;
                  const resp = await axiosLib.get(imgUrl, {
                    responseType: "arraybuffer",
                    timeout: 10000,
                  });
                  imageBuffer = Buffer.from(resp.data);
                } catch {
                  // buffer fetch failed
                }
              }

              // Estratégia 1: Upload binário
              if (imageBuffer) {
                try {
                  // Garantir dimensões mínimas exigidas pelo ML (500px após trim de bordas)
                  const processedBuf = await ensureMLMinImageSize(imageBuffer);
                  const picResult = await MLApiService.uploadPicture(
                    account.accessToken,
                    processedBuf,
                    fileName,
                  );
                  console.log(
                    `[ListingRetryService] Imagem enviada ao ML: pictureId=${picResult.id}`,
                  );
                  pics.push({ id: picResult.id });
                  continue;
                } catch (picErr) {
                  console.warn(
                    `[ListingRetryService] Upload binário falhou:`,
                    picErr instanceof Error ? picErr.message : String(picErr),
                  );
                }
              }

              // Estratégia 2: Upload via source URL síncrono
              try {
                const picResult = await MLApiService.uploadPictureFromUrl(
                  account.accessToken,
                  imgUrl,
                );
                console.log(
                  `[ListingRetryService] Imagem enviada via URL ao ML: pictureId=${picResult.id}`,
                );
                pics.push({ id: picResult.id });
                continue;
              } catch (urlErr) {
                console.warn(
                  `[ListingRetryService] Upload via URL falhou:`,
                  urlErr instanceof Error ? urlErr.message : String(urlErr),
                );
              }

              // Estratégia 3: source URL no payload (fallback)
              console.warn(
                `[ListingRetryService] Usando source URL como fallback: ${imgUrl}`,
              );
              pics.push({ source: imgUrl });
            }

            return pics.length > 0 ? pics : [];
          })(),
          attributes: (() => {
            const yearNum = Number(product.year);
            const validYear =
              Number.isFinite(yearNum) &&
              yearNum >= 1950 &&
              yearNum <= new Date().getFullYear() + 2
                ? yearNum
                : undefined;
            const attrs: any[] = [];
            if (product.brand)
              attrs.push({ id: "BRAND", value_name: product.brand });
            if (product.model && !/^\d{4}$/.test(String(product.model))) {
              attrs.push({ id: "MODEL", value_name: product.model });
            }
            if (validYear)
              attrs.push({ id: "YEAR", value_name: String(validYear) });
            const posCats = new Set(["MLB101763", "MLB458642"]);
            if (
              posCats.has((product as any).mlCategoryId || resolvedCategoryId)
            ) {
              const name = (product.name || "").toLowerCase();
              const pos = /dianteir|frente/.test(name)
                ? "Dianteira"
                : /traseir|tras|trás/.test(name)
                  ? "Traseira"
                  : null;
              if (pos) attrs.push({ id: "POSITION", value_name: pos });
            }
            attrs.push({ id: "SELLER_SKU", value_name: product.sku });
            return attrs;
          })(),
          seller_custom_field: product.sku,
          description: {
            plain_text: buildDescription(product),
          },
        };

        if (shouldIncludeFamilyName(payload.category_id)) {
          payload.family_name = sanitizeTitle(product.name || "", product, 60);
        }
        // Heurística pró-autopeças: se produto tem marca + ano, envie family_name
        if (
          !payload.family_name &&
          product.brand &&
          product.year &&
          String(product.year).length === 4
        ) {
          payload.family_name = sanitizeTitle(product.name || "", product, 60);
        }

        // Shipping dimensions string se todos os campos existirem
        if (pkg) {
          payload.shipping = {
            mode: userDefaults.shippingMode || "me2",
            free_shipping: userDefaults.freeShipping || false,
            local_pick_up: userDefaults.localPickup || false,
            dimensions: `${pkg.height}x${pkg.width}x${pkg.length},${Number(
              pkg.weightKg,
            )}`,
          };
        } else {
          payload.shipping = {
            mode: userDefaults.shippingMode || "me2",
            free_shipping: userDefaults.freeShipping || false,
            local_pick_up: userDefaults.localPickup || false,
          };
        }

        // sale_terms: garantia e tempo de fabricação
        const saleTerms: Array<{ id: string; value_name: string }> = [];
        if (userDefaults.hasWarranty) {
          saleTerms.push({
            id: "WARRANTY_TYPE",
            value_name: "Garantia do vendedor",
          });
          const dur = userDefaults.warrantyDuration || 30;
          const unit = userDefaults.warrantyUnit || "dias";
          saleTerms.push({ id: "WARRANTY_TIME", value_name: `${dur} ${unit}` });
        }
        if (
          userDefaults.manufacturingTime &&
          userDefaults.manufacturingTime > 0
        ) {
          saleTerms.push({
            id: "MANUFACTURING_TIME",
            value_name: `${userDefaults.manufacturingTime} dias`,
          });
        }
        if (saleTerms.length > 0) {
          payload.sale_terms = saleTerms;
        }

        if (pkg) {
          const addPkgAttr = (id: string, val: number | string) => {
            const exists = payload.attributes.some((a: any) => a.id === id);
            if (!exists) {
              payload.attributes.push({ id, value_name: String(val) });
            }
          };
          addPkgAttr("SELLER_PACKAGE_HEIGHT", `${pkg.height} cm`);
          addPkgAttr("SELLER_PACKAGE_WIDTH", `${pkg.width} cm`);
          addPkgAttr("SELLER_PACKAGE_LENGTH", `${pkg.length} cm`);
          addPkgAttr(
            "SELLER_PACKAGE_WEIGHT",
            `${Math.round(pkg.weightKg * 1000)} g`,
          );
          if (
            product.heightCm !== pkg.height ||
            product.widthCm !== pkg.width ||
            product.lengthCm !== pkg.length ||
            (product.weightKg != null &&
              Math.round(product.weightKg * 100) !==
                Math.round(pkg.weightKg * 100))
          ) {
            console.warn(
              `[ListingRetryService] Package dimensions clamped: ` +
                `H:${pkg.height} W:${pkg.width} L:${pkg.length}cm Wt:${pkg.weightKg}kg (was ` +
                `${product.heightCm}x${product.widthCm}x${product.lengthCm},${product.weightKg}kg)`,
            );
          }
        }

        // ─── Pré-flight de domínio/condição antes do createItem ──────────
        // Evita bater no ML API quando sabemos que vai falhar (categoria
        // fora do nicho veicular ou incompatível com a condition). Marca
        // o listing como erro permanente para parar o loop de retry.
        const isVehicularCandidate = !!(
          product.brand &&
          product.model &&
          product.year
        );
        if (isVehicularCandidate) {
          const domainCheck =
            await CategoryResolutionService.assertWithinVehicleRoot(
              resolvedCategoryId,
            );
          if (!domainCheck.ok && domainCheck.reason === "outside_root") {
            const msg = `Categoria '${resolvedCategory.fullPath || resolvedCategoryId}' está fora do nicho de autopeças; retry bloqueado.`;
            console.warn(`[ListingRetryService] ${msg} (listing=${cand.id})`);
            await ListingRepository.updateListing(cand.id, {
              status: "error",
              lastError: msg,
              retryEnabled: false,
              nextRetryAt: null,
            });
            continue;
          }
        }
        const condCheck =
          await CategoryResolutionService.assertConditionCoherent(
            resolvedCategoryId,
            retryCondition,
          );
        if (!condCheck.ok && condCheck.reason === "incompatible") {
          const allowed = condCheck.allowedConditions || [];
          if (allowed.length === 1) {
            // Override: leaf com única condição permitida (padrão em autopeças).
            console.warn(
              `[ListingRetryService] category trace OVERRIDE condition (listing=${cand.id}) productCondition=${retryCondition} overrideTo=${allowed[0]}`,
            );
            payload.condition = allowed[0];
          } else {
            const msg = `Categoria '${resolvedCategory.fullPath || resolvedCategoryId}' aceita apenas ${JSON.stringify(allowed)} mas produto está '${retryCondition}'; retry bloqueado.`;
            console.warn(`[ListingRetryService] ${msg} (listing=${cand.id})`);
            await ListingRepository.updateListing(cand.id, {
              status: "error",
              lastError: msg,
              retryEnabled: false,
              nextRetryAt: null,
            });
            continue;
          }
        }

        // ─── Preflight: required attributes da categoria (ML API catalog) ──
        // Auto-preenche attrs a partir de campos do produto e bloqueia retry
        // se faltar algo crítico — evita desperdiçar budget de retry quando
        // o problema é de dados e não de título.
        try {
          const { ListingPreflightService } = await import(
            "./listing-preflight.service"
          );
          const pf = await ListingPreflightService.checkML({
            product: product as any,
            categoryId: resolvedCategoryId,
            currentAttributes: payload.attributes as any,
          });
          payload.attributes = pf.enrichedAttributes as any;
          if (!pf.ok) {
            const msg = ListingPreflightService.formatBlockMessage(pf);
            console.warn(
              `[ListingRetryService] preflight BLOCKED ${cand.id}: ${msg}`,
            );
            await ListingRepository.updateListing(cand.id, {
              status: "error",
              lastError: `[TERMINAL] ${msg}`,
              retryEnabled: false,
              nextRetryAt: null,
            });
            continue;
          }
        } catch (pfErr) {
          console.warn(
            `[ListingRetryService] preflight failed (fail-open) for ${cand.id}:`,
            pfErr instanceof Error ? pfErr.message : String(pfErr),
          );
        }

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
          const rawMsg = errMsg(createErr);
          const parsed =
            createErr && (createErr as any).mlError
              ? (createErr as any).mlError
              : null;
          console.log(
            `[ListingRetryService] createItem error for ${cand.id}: ${rawMsg}`,
          );

          const isTitleInvalid =
            rawMsg.toLowerCase().includes("invalid_fields") &&
            rawMsg.toLowerCase().includes("title");
          const missingFamilyName = rawMsg
            .toLowerCase()
            .includes("family_name");

          // Se a categoria exigir family_name e ele não foi enviado, tente novamente com family_name
          if (!mlItem && missingFamilyName && !payload.family_name) {
            try {
              const withFamily: MLItemCreatePayload = {
                ...(payload as any),
                family_name: sanitizeTitle(product.name || "", product, 60),
              } as any;
              // propagate family_name into payload BEFORE call for subsequent retries
              (payload as any).family_name = withFamily.family_name;
              console.warn(
                `[ListingRetryService] retrying createItem WITH family_name for ${cand.id}`,
              );
              mlItem = await MLApiService.createItem(
                account.accessToken,
                withFamily as any,
              );
            } catch (famErr) {
              console.warn(
                `[ListingRetryService] family_name retry failed for ${cand.id}: ${errMsg(famErr)}`,
              );
            }
          }

          // Se o erro for invalid_fields/title, tentar uma vez com título extra-sanitizado
          if (isTitleInvalid) {
            try {
              const safeTitle = buildSafeTitle(product);
              console.warn(
                `[ListingRetryService] retrying createItem with safe title for ${cand.id}: "${safeTitle}"`,
              );
              mlItem = await MLApiService.createItem(account.accessToken, {
                ...payload,
                title: safeTitle,
              });
              console.log(
                `[ListingRetryService] createItem with safe title returned for ${cand.id}: ${mlItem?.id}`,
              );
            } catch (noTitleErr) {
              console.warn(
                `[ListingRetryService] safe-title retry failed for ${cand.id}: ${errMsg(noTitleErr)}`,
              );
            }

            // Em domínios que reclamam do title, tente primeiro sem family_name (mantendo título).
            if (!mlItem && (payload.family_name || missingFamilyName)) {
              try {
                const payloadNoFamily: MLItemCreatePayload = {
                  ...(payload as any),
                };
                delete (payloadNoFamily as any).family_name;
                console.warn(
                  `[ListingRetryService] retrying createItem WITHOUT family_name for ${cand.id} (keep title)`,
                );
                mlItem = await MLApiService.createItem(
                  account.accessToken,
                  payloadNoFamily as any,
                );
                console.log(
                  `[ListingRetryService] createItem without family_name returned for ${cand.id}: ${mlItem?.id}`,
                );
              } catch (noFamilyErr2) {
                console.warn(
                  `[ListingRetryService] no-family retry failed for ${cand.id}: ${errMsg(noFamilyErr2)}`,
                );
              }
            }

            // Para categorias com family_name (ou que reclamam dele/title), tentar sem title (UP flow).
            const shouldTryNoTitle =
              payload.family_name ||
              missingFamilyName ||
              noTitleWithFamily(payload.category_id);
            if (!mlItem && shouldTryNoTitle) {
              try {
                const payloadNoTitle: MLItemCreatePayload = {
                  ...(payload as any),
                };
                payloadNoTitle.family_name =
                  payloadNoTitle.family_name ||
                  sanitizeTitle(product.name || "", product, 60);
                delete (payloadNoTitle as any).title;
                console.warn(
                  `[ListingRetryService] retrying createItem WITHOUT title for ${cand.id} (UP domain)`,
                );
                mlItem = await MLApiService.createItem(
                  account.accessToken,
                  payloadNoTitle as any,
                );
                console.log(
                  `[ListingRetryService] createItem without title returned for ${cand.id}: ${mlItem?.id}`,
                );
              } catch (noTitleErr2) {
                console.warn(
                  `[ListingRetryService] no-title retry failed for ${cand.id}: ${errMsg(noTitleErr2)}`,
                );
              }
            }
          }

          // If retry succeeded, skip remaining error handling
          if (mlItem) {
            /* fall through to success section below */
          } else {
            // Missing required attribute: terminal (user precisa corrigir produto).
            // Ex: `item.attributes.missing_required references [item.attributes] [PART_NUMBER]`
            if (
              /missing_required/i.test(rawMsg) ||
              /required for category/i.test(rawMsg)
            ) {
              const attrMatch = rawMsg.match(/\[([A-Z_]+)\]\s+required/i);
              const missingAttr = attrMatch ? attrMatch[1] : "atributo obrigatório";
              console.warn(
                `[ListingRetryService] terminal missing_required for ${cand.id}: ${missingAttr}`,
              );
              await ListingRepository.updateListing(cand.id, {
                status: "error",
                lastError: `[TERMINAL] Categoria exige ${missingAttr} — corrija o produto antes de republicar`,
                retryEnabled: false,
                nextRetryAt: null,
              });
              await SystemLogService.logError(
                "RETRY_LISTING" as any,
                `createItem missing_required for placeholder ${cand.id}: ${missingAttr}`,
                {
                  resource: "ProductListing",
                  resourceId: cand.id,
                  details: { mlError: parsed || rawMsg, missingAttr },
                },
              );
              continue;
            }

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
                "RETRY_LISTING" as any,
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
              BACKOFF_SECONDS[
                Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)
              ];
            await ListingRepository.incrementRetryAttempts(cand.id, {
              lastError: rawMsg,
              nextRetryAt: new Date(Date.now() + nextDelay * 1000),
              retryEnabled: attempts < MAX_ATTEMPTS,
            });

            await SystemLogService.logError(
              "RETRY_LISTING" as any,
              `createItem failed for placeholder ${cand.id}, scheduling retry: ${rawMsg}`,
              { resource: "ProductListing", resourceId: cand.id },
            );
            continue;
          }
        }

        // Success: update existing placeholder with ML id and mark active
        console.debug(
          `[ListingRetryService] ML created for placeholder ${cand.id} -> ${mlItem.id}`,
        );

        // Atualizar family_name via PUT para que o título gerado pelo ML reflita o nome completo
        const desiredFamilyName = sanitizeTitle(
          product.name || "",
          product,
          60,
        );
        if (mlItem?.id && desiredFamilyName) {
          const mlReturnedTitle = (mlItem.title || "").trim();
          const titleMismatch =
            mlReturnedTitle.toLowerCase() !== desiredFamilyName.toLowerCase() &&
            !mlReturnedTitle
              .toLowerCase()
              .includes(desiredFamilyName.toLowerCase());
          if (titleMismatch || payload.family_name) {
            try {
              await MLApiService.updateItem(account.accessToken, mlItem.id, {
                family_name: desiredFamilyName,
              } as any);
              console.log(
                `[ListingRetryService] family_name updated to "${desiredFamilyName}" for ${mlItem.id}`,
              );
            } catch (fnErr) {
              console.warn(
                `[ListingRetryService] Failed to update family_name for ${mlItem.id}: ${errMsg(fnErr)}`,
              );
            }
          }
        }

        let remoteStatus: "active" | "paused" | "closed" | "under_review" =
          "active";
        let remoteSubStatus: string[] | undefined;
        try {
          const details = await MLApiService.getItemDetails(
            account.accessToken,
            mlItem.id,
          );
          remoteStatus = details.status;
          remoteSubStatus = (details as any).sub_status;
          if (remoteStatus === "paused") {
            const canAutoActivate =
              !remoteSubStatus ||
              remoteSubStatus.length === 0 ||
              remoteSubStatus.every((s) =>
                ["waiting_for_activation", "waiting_for_payment"].includes(s),
              );
            if (canAutoActivate) {
              try {
                const reactivated = await MLApiService.updateItem(
                  account.accessToken,
                  mlItem.id,
                  { status: "active" } as any,
                );
                remoteStatus = reactivated.status;
                remoteSubStatus = (reactivated as any).sub_status;
                console.warn(
                  `[ListingRetryService] paused item ${mlItem.id} auto-activate -> ${remoteStatus}`,
                );
              } catch (reactivateErr) {
                console.warn(
                  `[ListingRetryService] auto-activate failed for ${mlItem.id}: ${errMsg(reactivateErr)}`,
                );
              }
            }
          }
        } catch (statusErr) {
          console.warn(
            `[ListingRetryService] could not fetch status for ${mlItem.id}: ${errMsg(statusErr)}`,
          );
        }

        await ListingRepository.updateListing(cand.id, {
          externalListingId: mlItem.id,
          permalink: mlItem.permalink || null,
          status: remoteStatus,
          retryEnabled: false,
          nextRetryAt: null,
          lastError:
            remoteStatus === "paused" && remoteSubStatus?.length
              ? `ML retornou status=paused (${remoteSubStatus.join(",")})`
              : null,
          retryAttempts: 0,
        });

        console.debug(
          `[ListingRetryService] updated placeholder ${cand.id} in DB`,
        );
        await SystemLogService.logError(
          "RETRY_LISTING" as any,
          `Placeholder ${cand.id} successfully posted to ML (${mlItem.id})`,
          { resource: "ProductListing", resourceId: cand.id },
        );
      } catch (err) {
        // unexpected error
        try {
          await ListingRepository.incrementRetryAttempts(cand.id, {
            lastError: errMsg(err),
            nextRetryAt: new Date(Date.now() + 60 * 1000),
            retryEnabled: true,
          });
        } catch (e) {
          /* ignore */
        }
        await SystemLogService.logError(
          "RETRY_LISTING" as any,
          `Unexpected error while retrying placeholder ${cand.id}: ${errMsg(err)}`,
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
