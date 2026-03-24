import { Platform } from "@prisma/client";
import { MLApiService } from "../services/ml-api.service";
import { MLOAuthService } from "../services/ml-oauth.service";
import { ShopeeApiService } from "../services/shopee-api.service";
import { ShopeeOAuthService } from "../services/shopee-oauth.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { SystemLogService } from "../../services/system-log.service";
import { ListingRepository } from "../repositories/listing.repository";
import { MLItemCreatePayload } from "../types/ml-api.types";
import { ShopeeItemCreatePayload } from "../types/shopee-api.types";
import { ProductRepositoryPrisma } from "../../repositories/product.repository";
import { CategoryResolutionService } from "../services/category-resolution.service";
import { AccountStatus } from "@prisma/client";
import { UserRepositoryPrisma } from "../../repositories/user.repository";
import { ensureMLMinImageSize } from "../services/image-resize.service";

export interface CreateListingResult {
  success: boolean;
  listingId?: string;
  externalListingId?: string;
  permalink?: string;
  error?: string;
  skipped?: boolean;
  // raw ML error payload (when available) to let callers decide handling/retries
  mlError?: string;
}

export interface MLListingSettings {
  listingType?: string; // "bronze" | "gold_special" | "gold_pro"
  hasWarranty?: boolean;
  warrantyUnit?: string; // "dias" | "meses"
  warrantyDuration?: number;
  itemCondition?: string; // "new" | "used"
  shippingMode?: string; // "me2" | "me1" | "custom" | "not_specified"
  freeShipping?: boolean;
  localPickup?: boolean;
  manufacturingTime?: number; // dias de disponibilidade
}

export class ListingUseCase {
  private static productRepository = new ProductRepositoryPrisma();
  private static userRepository = new UserRepositoryPrisma();

  // Limites aceitos pelo ML para dimensões de pacote (padrões razoáveis; podem ser ajustados via env)
  private static readonly ML_MIN_DIM_CM = 1;
  private static readonly ML_MAX_DIM_CM = Number(
    process.env.ML_MAX_DIM_CM || 200,
  );
  private static readonly ML_MIN_WEIGHT_KG = 0.05; // 50 g
  private static readonly ML_MAX_WEIGHT_KG = Number(
    process.env.ML_MAX_WEIGHT_KG || 70,
  ); // 70 kg (70000 g)

  /**
   * Cria um anÃºncio em qualquer marketplace suportado
   */
  static async createListing(
    userId: string,
    productId: string,
    platform: Platform,
    categoryId?: string,
    accountId?: string,
    mlSettings?: MLListingSettings,
  ): Promise<CreateListingResult> {
    switch (platform) {
      case Platform.MERCADO_LIVRE:
        return this.createMLListing(
          userId,
          productId,
          categoryId,
          accountId,
          mlSettings,
        );
      case Platform.SHOPEE:
        return this.createShopeeListing(
          userId,
          productId,
          categoryId,
          accountId,
        );
      default:
        return {
          success: false,
          error: `Plataforma ${platform} nÃ£o suportada`,
        };
    }
  }
  private static mapQualityToMLCondition(quality?: string): "new" | "used" {
    switch (quality) {
      case "NOVO":
        return "new";
      case "SEMINOVO":
      case "RECONDICIONADO":
      case "SUCATA":
        return "used";
      default:
        return "used"; // ML não aceita not_specified em MLB
    }
  }

  // Normaliza category_id para o formato aceito pelo ML: remove sufixos "-NN".
  private static normalizeMLCategoryId(externalId?: string) {
    if (!externalId) return externalId;
    return externalId.split("-")[0];
  }

  /**
   * Título principal: exatamente o nome do produto, apenas higienizado.
   */
  private static buildMLTitle(product: any): string {
    return this.sanitizeTitle(product?.name || "", product, 60);
  }

  /**
   * Fallback seguro que não degrada para marca isolada.
   */
  private static buildSafeFallbackTitle(product: any): string {
    const primary = this.sanitizeTitle(product?.name || "", product, 60);
    if (primary && primary !== "Produto") return primary;

    const parts: string[] = [];
    if (product.brand) parts.push(product.brand);
    if (product.model) parts.push(product.model);
    if (product.year) parts.push(product.year);
    if (parts.length === 0 && product.sku) parts.push(product.sku);

    return this.sanitizeTitle(parts.join(" "), product, 60);
  }

  /**
   * Sanitiza e normaliza título para ML, preservando o nome original.
   */
  private static sanitizeTitle(
    raw: string,
    product: any,
    maxLen: number = 60,
  ): string {
    const base = raw || product?.name || "";
    let fullTitle = base
      .toString()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!fullTitle && product?.sku) {
      fullTitle = String(product.sku);
    }

    if (fullTitle.length > maxLen) {
      fullTitle = fullTitle.substring(0, maxLen).trim();
    }

    return fullTitle || "Produto";
  }

  /**
   * Heurística para corrigir textos com mojibake (Ã©/Ã§) e bytes corrompidos (\uFFFD).
   * A conversão latin1→utf8 é feita ANTES de remover \uFFFD, pois senão o texto
   * parcialmente limpo pode gerar novos \uFFFD ao ser reinterpretado.
   */
  private static normalizeUtf8(text?: string): string {
    if (!text) return "";
    let str = text.toString();

    // 1. Tentar mojibake fix (double-encoded: latin1 → utf8) ANTES de remover \uFFFD
    if (str.includes("Ã")) {
      try {
        const decoded = Buffer.from(str, "latin1").toString("utf8");
        // Aceitar somente se a conversão gerou menos \uFFFD que o original
        const origCount = (str.match(/\uFFFD/g) || []).length;
        const decodedCount = (decoded.match(/\uFFFD/g) || []).length;
        if (decodedCount <= origCount) {
          str = decoded;
        }
      } catch {
        /* ignore */
      }
    }

    // 2. Remover U+FFFD restantes (bytes irrecuperáveis)
    str = str.replace(/\uFFFD/g, "");

    return str.trim();
  }

  private static cleanBrand(brand?: string): string | undefined {
    const b = this.normalizeUtf8(brand);
    return b ? b : undefined;
  }

  private static cleanYear(year?: any): number | undefined {
    const n = Number(year);
    const current = new Date().getFullYear();
    if (!Number.isFinite(n)) return undefined;
    if (n < 1950 || n > current + 2) return undefined;
    return n;
  }

  private static cleanModel(model?: string, year?: any): string | undefined {
    if (!model) return undefined;
    const m = this.normalizeUtf8(model);
    if (!m) return undefined;
    if (/^\d{4}$/.test(m)) {
      const yr = this.cleanYear(year);
      if (yr && String(yr) === m) return undefined;
    }
    return m;
  }

  /**
   * Timeout helper to avoid hanging on ML API calls.
   */
  private static async withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout (${label}) after ${ms}ms`));
      }, ms);
      promise
        .then((val) => {
          clearTimeout(timer);
          resolve(val);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /**
   * Sanitiza dimensões/peso para atender limites do ML, fazendo clamp quando necessário.
   * Retorna null se faltar alguma dimensão obrigatória.
   */
  private static sanitizePackageDimensions(input?: {
    heightCm?: number;
    widthCm?: number;
    lengthCm?: number;
    weightKg?: number;
  }) {
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

    const height = clamp(
      input.heightCm,
      this.ML_MIN_DIM_CM,
      this.ML_MAX_DIM_CM,
    );
    const width = clamp(input.widthCm, this.ML_MIN_DIM_CM, this.ML_MAX_DIM_CM);
    const length = clamp(
      input.lengthCm,
      this.ML_MIN_DIM_CM,
      this.ML_MAX_DIM_CM,
    );

    const weightKgRaw = Number(input.weightKg);
    if (!Number.isFinite(weightKgRaw)) return null;
    const weightKg = clamp(
      weightKgRaw,
      this.ML_MIN_WEIGHT_KG,
      this.ML_MAX_WEIGHT_KG,
    );

    return { height, width, length, weightKg };
  }

  /**
   * Constrói atributos estruturados sem sobrescrever com inferências fracas.
   */
  private static buildMLAttributes(product: any, resolvedCategoryId?: string) {
    const attrs: Array<{ id: string; value_name: string }> = [];
    const brand = this.cleanBrand(product.brand);
    const model = this.cleanModel(product.model, product.year);
    const year = this.cleanYear(product.year);

    if (brand) attrs.push({ id: "BRAND", value_name: brand });
    if (model) attrs.push({ id: "MODEL", value_name: model });
    if (year) attrs.push({ id: "YEAR", value_name: String(year) });

    // inferir posição para portas (ajuda a atender requisitos do domínio)
    const positionCategories = new Set(["MLB101763", "MLB458642"]);
    if (resolvedCategoryId && positionCategories.has(resolvedCategoryId)) {
      const name = (product.name || "").toLowerCase();
      const pos = /dianteir|frente/.test(name)
        ? "Dianteira"
        : /traseir|tras|trás/.test(name)
          ? "Traseira"
          : null;
      if (pos) attrs.push({ id: "POSITION", value_name: pos });
    }

    attrs.push({ id: "SELLER_SKU", value_name: product.sku });
    if (product.partNumber) {
      attrs.push({ id: "PART_NUMBER", value_name: product.partNumber });
    }

    return attrs;
  }

  /**
   * Constrói a descrição do ML priorizando a descrição oficial do produto/usuário.
   */
  private static buildMLDescription(
    product: any,
    hintedSource?: "product" | "user_default" | "fallback",
  ): { text: string; source: "product" | "user_default" | "fallback" } {
    const clamp = (text: string) => {
      const max = Number(process.env.ML_DESCRIPTION_LIMIT || 4000);
      return text && text.length > max ? text.slice(0, max) : text;
    };

    if (product.description) {
      return {
        text: clamp(this.normalizeUtf8(product.description)),
        source: hintedSource || "product",
      };
    }

    const parts: string[] = [];
    const headline = [product.name, product.brand, product.model]
      .filter(Boolean)
      .join(" ");
    if (headline.trim()) parts.push(this.normalizeUtf8(headline));

    const details: string[] = [];
    const brand = this.cleanBrand(product.brand);
    const model = this.cleanModel(product.model, product.year);
    const year = this.cleanYear(product.year);
    if (brand) details.push(`Marca: ${brand}`);
    if (model) details.push(`Modelo: ${model}`);
    if (year) details.push(`Ano: ${year}`);
    if (product.version)
      details.push(`Versão: ${this.normalizeUtf8(product.version)}`);
    if (product.partNumber)
      details.push(`Número da Peça: ${this.normalizeUtf8(product.partNumber)}`);
    if (product.quality)
      details.push(`Qualidade: ${this.normalizeUtf8(product.quality)}`);
    if (product.location)
      details.push(`Localização: ${this.normalizeUtf8(product.location)}`);
    if (product.heightCm && product.widthCm && product.lengthCm) {
      details.push(
        `Dimensões (cm): ${product.heightCm} x ${product.widthCm} x ${product.lengthCm}`,
      );
    }
    if (product.weightKg) {
      details.push(`Peso: ${product.weightKg} kg`);
    }

    if (details.length > 0) {
      parts.push("Detalhes Técnicos:");
      parts.push(details.join("\n"));
    }

    if (product.sku) parts.push(`SKU: ${product.sku}`);

    let text = clamp(parts.join("\n\n").trim());
    if (!text) {
      text = clamp(
        "Descrição não informada pelo vendedor. Tire suas dúvidas no campo de perguntas.",
      );
    }
    return { text, source: "fallback" };
  }

  /**
   * family_name só deve ser enviado se for explicitamente necessário.
   */
  private static shouldIncludeFamilyName(categoryId?: string): boolean {
    const forceEnv = process.env.ML_FORCE_FAMILY_NAME?.toLowerCase() === "true";

    // Permite sobrescrever/estender via env (lista separada por vírgula)
    const extra = (process.env.ML_FAMILY_NAME_ALLOWLIST || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const allowList = new Set<string>([
      // Domínios com fluxo User Product (catálogo) que exigem family_name
      // IMPORTANTE: usar apenas IDs reais de leaf do ML, nunca IDs sintéticos do catálogo estático
      "MLB193419", // Cubo de roda
      "MLB101763", // Portas (carroceria e lataria)
      "MLB458642", // Portas (categoria alternativa usada via override)
      "MLB191833", // Acessórios > Peças > Outros (observado pedindo family_name e recusando title)
      "MLB193531", // Acessórios > Radiadores > Reservatório — observado exigindo family_name e recusando title
      "MLB116479", // Janelas e Vedações > Sistemas de Elevação > Outros — exige family_name e rejeita title
      "MLB193613", // Suspensão e Direção > Outros — exige family_name e rejeita title
      "MLB188061", // Tampas de Combustível — observado exigindo family_name e recusando title
      "MLB22693", // Peças de Carros e Caminhonetes — fluxo UP
      ...extra,
    ]);

    if (!categoryId) return forceEnv;
    // Normalizar para remover sufixos internos antes do lookup
    const normalized = this.normalizeMLCategoryId(categoryId) || categoryId;
    return forceEnv || allowList.has(categoryId) || allowList.has(normalized);
  }

  /**
   * Algumas categorias do catálogo (User Product) não permitem enviar title junto com family_name.
   * Mantemos a lista explícita e configurável.
   */
  private static noTitleWithFamilyName(categoryId?: string): boolean {
    const envList = (process.env.ML_NO_TITLE_WITH_FAMILY || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const hard = new Set<string>([
      "MLB193419", // Cubo de roda — comprovado que title é rejeitado quando family_name está presente
      "MLB101763", // Portas — fluxo UP exige family_name sem title
      "MLB458642", // Portas (categoria alternativa) segue mesma regra de catálogo
      "MLB22693", // Peças de Carros e Caminhonetes (válida)
      "MLB191833", // Outros acessórios (observado rejeitando title quando family_name é exigido)
      "MLB193531", // Radiadores > Reservatório — exige family_name e bloqueia title
      "MLB116479", // Janelas e Vedações > Sistemas de Elevação > Outros — exige family_name e bloqueia title
      "MLB193613", // Suspensão e Direção > Outros — exige family_name e bloqueia title
      "MLB188061", // Tampas de Combustível — observado exigindo family_name e bloqueando title
      ...envList,
    ]);
    if (!categoryId) return false;
    const normalized = this.normalizeMLCategoryId(categoryId) || categoryId;
    return hard.has(categoryId) || hard.has(normalized);
  }

  static async createMLListing(
    userId: string,
    productId: string,
    categoryId?: string,
    accountId?: string,
    mlSettings?: MLListingSettings,
  ): Promise<CreateListingResult> {
    try {
      let account = accountId
        ? await MarketplaceRepository.findByIdAndUser(accountId, userId)
        : await MarketplaceRepository.findFirstActiveByUserAndPlatform(
            userId,
            Platform.MERCADO_LIVRE,
          );

      // Se múltiplas contas ativas e accountId não foi informado, escolher a primeira ativa (mais recente) para não bloquear o fluxo.
      if (!account && !accountId) {
        const allActive =
          await MarketplaceRepository.findAllByUserIdAndPlatform(
            userId,
            Platform.MERCADO_LIVRE,
          );
        const active = (allActive || []).filter(
          (acc) => acc.status === AccountStatus.ACTIVE,
        );
        if (active.length > 0) {
          // Opcional: ordenar por updatedAt/createdAt se disponível
          account = active.sort(
            (a, b) =>
              new Date(b.updatedAt || b.createdAt || 0).getTime() -
              new Date(a.updatedAt || a.createdAt || 0).getTime(),
          )[0];
        }
      }

      if (!account || !account.accessToken) {
        return {
          success: false,
          error: "Conta do Mercado Livre nÃ£o conectada ou sem credenciais",
        };
      }
      let acc: NonNullable<typeof account> = account; // narrow to non-null

      // Verificar se token expirou e tentar renovaÃ§Ã£o automÃ¡tica (melhor experiÃªncia para o usuÃ¡rio)
      const now = new Date();
      if (acc.expiresAt < now) {
        try {
          console.debug(
            `[ListingUseCase] ML token expired for account ${acc.id || "<no-account>"}, attempting refresh`,
          );
          const refreshed = await MLOAuthService.refreshAccessToken(
            acc.refreshToken,
          );

          console.debug(
            `[ListingUseCase] ML token refresh returned, updating DB tokens`,
          );
          const updated = await MarketplaceRepository.updateTokens(acc.id, {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
          });

          // usar tokens renovados â€” only reassign if update returned a value
          if (updated) {
            account = updated as any;
            acc = updated;
            console.debug(
              `[ListingUseCase] Account tokens updated, using accessToken=${acc.accessToken}`,
            );
          } else {
            console.warn(
              `[ListingUseCase] updateTokens returned empty for account ${acc.id}`,
            );
          }
        } catch (refreshErr) {
          // marcar conta como erro e informar usuÃ¡rio para reconectar
          await MarketplaceRepository.updateStatus(acc.id, AccountStatus.ERROR);
          console.warn(
            `[ListingUseCase] Failed to refresh token for account ${acc.id || "<no-account>"}:`,
            (refreshErr as any)?.message || refreshErr,
          );
          return {
            success: false,
            error:
              "Conta do Mercado Livre expirou ou token invÃ¡lido â€” reconecte a conta",
          };
        }
      }
      // If account appears INACTIVE in DB, attempt an immediate capability re-check
      // (user may have just reactivated sales in Seller Center). If the re-check
      // succeeds, mark the account ACTIVE so the listing flow proceeds.
      if (acc.status !== AccountStatus.ACTIVE) {
        try {
          console.debug(
            `[ListingUseCase] account ${acc.id || "<no-account>"} status is ${acc.status}; attempting capability re-check before failing`,
          );
          const mlUserInfo = await MLOAuthService.getUserInfo(acc.accessToken);
          const sellerId = mlUserInfo?.id?.toString();
          if (sellerId) {
            await MLApiService.getSellerItemIds(
              acc.accessToken,
              sellerId,
              "active",
              1,
            );
            // re-activate account in DB
            const updatedStatus = await MarketplaceRepository.updateStatus(
              acc.id,
              AccountStatus.ACTIVE,
            );
            if (updatedStatus) {
              account = updatedStatus as any;
              console.info(
                `[ListingUseCase] account ${acc.id || "<no-account>"} reactivated after capability re-check`,
              );
            } else {
              console.warn(
                `[ListingUseCase] updateStatus returned empty for account ${acc.id}`,
              );
            }
          }
        } catch (recheckErr) {
          console.debug(
            `[ListingUseCase] capability re-check for account ${acc.id || "<no-account>"} failed: ${
              recheckErr instanceof Error
                ? recheckErr.message
                : String(recheckErr)
            }`,
          );
          // continue â€” the later pre-check will still detect vacation/restriction
        }
      }
      // Pre-check: validar que o seller pode criar anÃºncios (detectar restriÃ§Ãµes antes de montar payload)
      let sellerId: string | undefined;
      try {
        const mlUserInfo = await MLOAuthService.getUserInfo(acc.accessToken);
        sellerId = mlUserInfo?.id?.toString();
        if (sellerId) {
          try {
            // chamada leve para confirmar capacidade de listar (pede 1 id apenas)
            await MLApiService.getSellerItemIds(
              acc.accessToken,
              sellerId,
              "active",
              1,
            );
          } catch (preErr: any) {
            const preMsg =
              preErr instanceof Error ? preErr.message : String(preErr);
            if (
              preMsg.includes("seller.unable_to_list") ||
              preMsg.includes("User is unable to list")
            ) {
              // Seller restriction detected during pre-check. Try *more* retries
              // before treating as permanent â€” ML can be eventually consistent when the
              // seller disables vacation / restriction in Seller Center.
              let recovered = false;
              try {
                // increase attempts and backoff to cover short propagation delays
                for (let attempt = 1; attempt <= 5; attempt++) {
                  await new Promise((r) => setTimeout(r, attempt * 700));
                  try {
                    await MLApiService.getSellerItemIds(
                      acc.accessToken,
                      sellerId!,
                      "active",
                      1,
                    );
                    recovered = true;
                    break;
                  } catch (e) {
                    // continue retrying
                    console.debug(
                      `[ListingUseCase] pre-check retry ${attempt} failed for account ${account?.id || "<no-account>"}`,
                    );
                  }
                }
              } catch (e) {
                /* ignore */
              }

              if (recovered) {
                // treat as transient â€” continue flow so listing creation will be attempted
                console.info(
                  `[ListingUseCase] pre-check seller restriction recovered for account ${account?.id || "<no-account>"}`,
                );
              } else {
                // Not recovered: record ML error and return skipped (no creation)
                await SystemLogService.logError(
                  "CREATE_LISTING",
                  `Pre-check: vendedor bloqueado no ML: ${preMsg}`,
                  {
                    userId,
                    resource: "MarketplaceAccount",
                    resourceId: acc.id,
                    details: { mlError: preMsg },
                  },
                );

                return {
                  success: false,
                  skipped: true,
                  error:
                    "Conta do Mercado Livre com restriÃ§Ã£o â€” impossÃ­vel criar anÃºncios. Verifique o Seller Center do Mercado Livre. (restrictions_coliving)",
                  mlError: preMsg,
                };
              }
            }

            if (
              preMsg.toLowerCase().includes("unauthorized") ||
              preMsg.toLowerCase().includes("invalid access token")
            ) {
              await MarketplaceRepository.updateStatus(
                acc.id,
                AccountStatus.ERROR,
              );
              return {
                success: false,
                error:
                  "Conta do Mercado Livre sem credenciais vÃ¡lidas â€” reconecte a conta.",
              };
            }

            console.warn("[ListingUseCase] ML pre-check warning:", preMsg);
          }
        }
      } catch (infoErr: any) {
        const msg =
          infoErr instanceof Error ? infoErr.message : String(infoErr);
        if (
          msg.toLowerCase().includes("unauthorized") ||
          msg.toLowerCase().includes("invalid access token")
        ) {
          await MarketplaceRepository.updateStatus(acc.id, AccountStatus.ERROR);
          return {
            success: false,
            error:
              "Conta do Mercado Livre sem credenciais vÃ¡lidas â€” reconecte a conta.",
          };
        }
        console.warn(
          "[ListingUseCase] getUserInfo pre-check failed, continuing:",
          msg,
        );
      }

      // 2. Buscar dados do produto
      const product =
        await ListingUseCase.productRepository.findById(productId);
      if (!product) {
        return {
          success: false,
          error: "Produto nÃ£o encontrado",
        };
      }

      // Validar prÃ©-requisitos do produto antes de enviar ao ML (ex.: imagem obrigatÃ³ria)
      if (!product.imageUrl) {
        return {
          success: false,
          error:
            "Produto precisa ter imagem para criar anÃºncio no Mercado Livre",
        };
      }

      let descriptionSource: "product" | "user_default" | "fallback" =
        product.description ? "product" : "fallback";

      // Carregar configurações do usuário (descrição padrão + padrões de anúncio ML)
      let userDefaults: MLListingSettings = {};
      if (product.userId) {
        try {
          const owner = await ListingUseCase.userRepository.findById(
            product.userId,
          );
          if (owner) {
            // Descrição padrão
            if (!product.description && owner.defaultProductDescription) {
              product.description = owner.defaultProductDescription;
              descriptionSource = "user_default";
            }
            // Padrões de anúncio ML do usuário
            userDefaults = {
              listingType: owner.defaultListingType ?? undefined,
              hasWarranty: owner.defaultHasWarranty ?? undefined,
              warrantyUnit: owner.defaultWarrantyUnit ?? undefined,
              warrantyDuration: owner.defaultWarrantyDuration ?? undefined,
              itemCondition: owner.defaultItemCondition ?? undefined,
              shippingMode: owner.defaultShippingMode ?? undefined,
              freeShipping: owner.defaultFreeShipping ?? undefined,
              localPickup: owner.defaultLocalPickup ?? undefined,
              manufacturingTime: owner.defaultManufacturingTime ?? undefined,
            };
          }
        } catch (descErr) {
          console.warn(
            "[ListingUseCase] Falha ao carregar configurações do usuário:",
            descErr instanceof Error ? descErr.message : String(descErr),
          );
        }
      }

      // Mesclar: settings explícitos > padrões do usuário > hardcoded
      const effectiveSettings: MLListingSettings = {
        listingType:
          mlSettings?.listingType ?? userDefaults.listingType ?? "bronze",
        hasWarranty:
          mlSettings?.hasWarranty ?? userDefaults.hasWarranty ?? false,
        warrantyUnit:
          mlSettings?.warrantyUnit ?? userDefaults.warrantyUnit ?? "dias",
        warrantyDuration:
          mlSettings?.warrantyDuration ?? userDefaults.warrantyDuration ?? 30,
        itemCondition: mlSettings?.itemCondition ?? userDefaults.itemCondition,
        shippingMode:
          mlSettings?.shippingMode ?? userDefaults.shippingMode ?? "me2",
        freeShipping:
          mlSettings?.freeShipping ?? userDefaults.freeShipping ?? false,
        localPickup:
          mlSettings?.localPickup ?? userDefaults.localPickup ?? false,
        manufacturingTime:
          mlSettings?.manufacturingTime ?? userDefaults.manufacturingTime ?? 0,
      };

      // Detectar descrição corrompida (contém \uFFFD = encoding perdido) e logar aviso
      if (product.description && /\uFFFD/.test(product.description)) {
        console.warn(
          "[ListingUseCase] ⚠ Descrição contém caracteres corrompidos (\\uFFFD). " +
            "Atualize o campo defaultProductDescription do usuário e a descrição deste produto no banco de dados. " +
            `productId=${product.id}, source=${descriptionSource}`,
        );
      }

      // Resolve categoryId determinístico: explícito -> categoria persistida -> erro
      const resolvedCategory =
        await CategoryResolutionService.resolveMLCategory({
          explicitCategoryId: categoryId,
          product,
          validateWithMLAPI: false,
        });
      let resolvedCategoryId = resolvedCategory.externalId;
      const originalCategoryId = resolvedCategoryId;

      // Forçar leaf local antes de montar payload (evita postar em pai como MLB1747)
      const leafLocal =
        await CategoryResolutionService.ensureLeafLocalOnly(resolvedCategoryId);
      if (leafLocal) {
        resolvedCategoryId = leafLocal.externalId;
        resolvedCategory.fullPath =
          leafLocal.fullPath || resolvedCategory.fullPath;
      }
      // Normalizar category_id removendo sufixos internos "-NN" que não são aceitos pelo ML API
      // (ex: "MLB1747-01" → "MLB1747"). IDs reais do ML são puramente alfanuméricos.
      let categoryIdForML =
        this.normalizeMLCategoryId(resolvedCategoryId) || resolvedCategoryId;

      // Categoria MLB193419 (sugerida pelo domain_discovery para cubo de roda) exige PART_NUMBER
      if (resolvedCategoryId === "MLB193419" && !product.partNumber) {
        return {
          success: false,
          error:
            "A categoria selecionada exige o atributo PART_NUMBER. Preencha o Part Number da peça antes de publicar.",
        };
      }

      // 3. Preparar payload para criaÃ§Ã£o do anÃºncio
      // Detectar moeda baseada no site da conta (temporÃ¡rio - TODO: implementar detecÃ§Ã£o dinÃ¢mica)
      const currencyId =
        account?.accountName?.includes("MLA") ||
        account?.accountName?.includes("Argentina")
          ? "ARS"
          : "BRL";

      const { text: descriptionText, source: derivedDescriptionSource } =
        this.buildMLDescription(
          product,
          descriptionSource === "user_default"
            ? "user_default"
            : descriptionSource,
        );
      descriptionSource = derivedDescriptionSource;

      const attributes = this.buildMLAttributes(product, resolvedCategoryId);
      // Usar APENAS a categoria resolvida (leaf real do ML) para decidir family_name.
      // Nunca usar originalCategoryId pois pode ser ID sintético do catálogo estático.
      let includeFamilyName = this.shouldIncludeFamilyName(resolvedCategoryId);
      // family_name deve ser o nome completo do produto (título desejado pelo usuário),
      // pois o ML usa family_name para calcular o título visível em categorias User Product.
      const familyNameValue = this.buildMLTitle(product);
      const noTitleWithFamily = this.noTitleWithFamilyName(resolvedCategoryId);
      const forceNoTitleFlow = includeFamilyName && noTitleWithFamily;

      // Upload da imagem diretamente para o ML (mais confiável do que source URL)
      let picturesArray: MLItemCreatePayload["pictures"];
      // Coletar todas as URLs de imagens (imageUrls se disponível, ou apenas imageUrl)
      const allImageUrls: string[] = [];
      if (product.imageUrls && product.imageUrls.length > 0) {
        allImageUrls.push(...product.imageUrls);
      } else if (product.imageUrl) {
        allImageUrls.push(product.imageUrl);
      }

      if (allImageUrls.length > 0) {
        try {
          const backendBase =
            process.env.APP_BACKEND_URL || "http://localhost:3333";
          // Hoisted imports — executados uma única vez antes do loop
          const { join } = await import("path");
          const { readFile } = await import("fs/promises");
          const axios = (await import("axios")).default;

          // Preparar buffers de todas as imagens em paralelo
          const bufferResults = await Promise.allSettled(
            allImageUrls.map(async (rawUrl) => {
              const imageUrl = rawUrl.startsWith("http")
                ? rawUrl.replace(
                    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i,
                    backendBase,
                  )
                : `${backendBase}${rawUrl}`;

              const urlPath = new URL(imageUrl).pathname;
              const fileName = urlPath.split("/").pop() || "image.jpg";

              let imageBuffer: Buffer | null = null;

              if (urlPath.startsWith("/uploads/")) {
                const localPath = join(process.cwd(), "public", urlPath);
                try {
                  imageBuffer = await readFile(localPath);
                  console.log(
                    `[ListingUseCase] Imagem lida do disco local: ${localPath} (${imageBuffer.length} bytes)`,
                  );
                } catch {
                  console.warn(
                    `[ListingUseCase] Imagem não encontrada no disco local: ${localPath}, baixando via HTTP`,
                  );
                }
              }

              if (!imageBuffer) {
                const resp = await axios.get(imageUrl, {
                  responseType: "arraybuffer",
                  timeout: 10000,
                });
                imageBuffer = Buffer.from(resp.data);
                console.log(
                  `[ListingUseCase] Imagem baixada via HTTP: ${imageUrl} (${imageBuffer.length} bytes)`,
                );
              }

              // Construir URL pública para fallback via uploadPictureFromUrl
              const publicUrl = rawUrl.startsWith("http")
                ? rawUrl.replace(
                    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i,
                    backendBase,
                  )
                : `${backendBase}${rawUrl}`;

              return { imageBuffer, fileName, rawUrl, publicUrl };
            }),
          );

          // Upload sequencial ao ML (a API do ML pode ter rate-limit)
          picturesArray = [];
          for (let i = 0; i < bufferResults.length; i++) {
            const result = bufferResults[i];
            const rawUrl = allImageUrls[i];

            if (result.status === "fulfilled") {
              const {
                imageBuffer: imgBuf,
                fileName: imgName,
                publicUrl,
              } = result.value;

              // Garantir dimensões mínimas exigidas pelo ML (500px após trim de bordas)
              const processedBuf = await ensureMLMinImageSize(imgBuf);

              // Estratégia 1: Upload binário direto (form-data com getBuffer)
              try {
                const picResult = await MLApiService.uploadPicture(
                  acc.accessToken,
                  processedBuf,
                  imgName,
                );
                console.log(
                  `[ListingUseCase] Imagem enviada diretamente ao ML: pictureId=${picResult.id}`,
                );
                picturesArray.push({ id: picResult.id });
                continue;
              } catch (uploadErr) {
                console.warn(
                  `[ListingUseCase] Upload binário falhou para ${rawUrl}:`,
                  uploadErr instanceof Error
                    ? uploadErr.message
                    : String(uploadErr),
                );
              }

              // Estratégia 2: Upload via source URL síncrono (ML baixa e retorna picture ID)
              try {
                const picResult = await MLApiService.uploadPictureFromUrl(
                  acc.accessToken,
                  publicUrl,
                );
                console.log(
                  `[ListingUseCase] Imagem enviada via URL ao ML: pictureId=${picResult.id}`,
                );
                picturesArray.push({ id: picResult.id });
                continue;
              } catch (urlUploadErr) {
                console.warn(
                  `[ListingUseCase] Upload via URL também falhou para ${rawUrl}:`,
                  urlUploadErr instanceof Error
                    ? urlUploadErr.message
                    : String(urlUploadErr),
                );
              }

              // Estratégia 3: source URL no payload (assíncrono - menos confiável)
              console.warn(
                `[ListingUseCase] Usando source URL como fallback final: ${publicUrl}`,
              );
              picturesArray.push({ source: publicUrl });
            } else {
              console.warn(
                `[ListingUseCase] Falha ao preparar imagem ${rawUrl}:`,
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
              );

              // Mesmo sem buffer, tentar upload via URL
              const fallbackUrl = rawUrl.startsWith("http")
                ? rawUrl.replace(
                    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i,
                    backendBase,
                  )
                : `${backendBase}${rawUrl}`;
              try {
                const picResult = await MLApiService.uploadPictureFromUrl(
                  acc.accessToken,
                  fallbackUrl,
                );
                console.log(
                  `[ListingUseCase] Imagem enviada via URL (após falha buffer) ao ML: pictureId=${picResult.id}`,
                );
                picturesArray.push({ id: picResult.id });
              } catch {
                picturesArray.push({ source: fallbackUrl });
              }
            }
          }

          if (picturesArray.length === 0) {
            picturesArray = [
              {
                source: "https://via.placeholder.com/500x500.png?text=Produto",
              },
            ];
          }
        } catch (picErr) {
          console.warn(
            `[ListingUseCase] Falha geral no upload de imagens ao ML:`,
            picErr instanceof Error ? picErr.message : String(picErr),
          );
          const backendBase =
            process.env.APP_BACKEND_URL || "http://localhost:3333";
          picturesArray = allImageUrls.map((rawUrl) => {
            const fallbackUrl = rawUrl.startsWith("http")
              ? rawUrl.replace(
                  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i,
                  backendBase,
                )
              : `${backendBase}${rawUrl}`;
            return { source: fallbackUrl };
          });
        }
      } else {
        picturesArray = [
          { source: "https://via.placeholder.com/500x500.png?text=Produto" },
        ];
      }

      const payload: MLItemCreatePayload = {
        title: this.buildMLTitle(product),
        category_id: categoryIdForML,
        price: product.price,
        currency_id: currencyId,
        available_quantity: Math.min(product.stock, 999999),
        buying_mode: "buy_it_now",
        listing_type_id: effectiveSettings.listingType || "bronze",
        condition:
          effectiveSettings.itemCondition ||
          this.mapQualityToMLCondition(product.quality) ||
          "new",
        pictures: picturesArray,
        attributes,
        seller_custom_field: product.sku,
        description: {
          plain_text: descriptionText,
        },
      };

      // Garantia (sale_terms)
      const isUsedItem = payload.condition === "used";
      if (effectiveSettings.hasWarranty && effectiveSettings.warrantyDuration) {
        const unit =
          effectiveSettings.warrantyUnit === "meses" ? "meses" : "dias";
        payload.sale_terms = [
          { id: "WARRANTY_TYPE", value_name: "Garantia do vendedor" },
          {
            id: "WARRANTY_TIME",
            value_name: `${effectiveSettings.warrantyDuration} ${unit}`,
          },
        ];
        // Tempo de fabricação — ML só aceita para itens novos
        if (
          !isUsedItem &&
          effectiveSettings.manufacturingTime &&
          effectiveSettings.manufacturingTime > 0
        ) {
          payload.sale_terms.push({
            id: "MANUFACTURING_TIME",
            value_name: `${effectiveSettings.manufacturingTime} dias`,
          });
        }
      } else if (
        !isUsedItem &&
        effectiveSettings.manufacturingTime &&
        effectiveSettings.manufacturingTime > 0
      ) {
        payload.sale_terms = [
          {
            id: "MANUFACTURING_TIME",
            value_name: `${effectiveSettings.manufacturingTime} dias`,
          },
        ];
      }

      if (includeFamilyName) {
        if (familyNameValue) {
          payload.family_name = familyNameValue;
        }
      }
      if (forceNoTitleFlow) {
        delete (payload as any).title;
      }

      const attrSnapshot = {
        brand: attributes.find((a) => a.id === "BRAND")?.value_name,
        model: attributes.find((a) => a.id === "MODEL")?.value_name,
        year: attributes.find((a) => a.id === "YEAR")?.value_name,
      };
      const finalTitleForLog = (payload as any).title || "(omitted)";
      console.log("[ListingUseCase] ML payload summary", {
        productId: product.id,
        productName: product.name,
        finalTitle: finalTitleForLog,
        descriptionSource,
        family_name_sent: includeFamilyName,
        category: {
          id: resolvedCategoryId,
          fullPath: resolvedCategory.fullPath,
          source: resolvedCategory.source,
        },
        attrs: attrSnapshot,
      });

      // 3.1 Criar (ou reutilizar) placeholder local antes de chamar o ML
      // Isso garante que o usuÃ¡rio veja o anÃºncio pendente mesmo que a API do ML falhe.
      let listing = await ListingRepository.findByProductAndAccount(
        productId,
        acc.id,
      );

      if (!listing) {
        listing = await ListingRepository.createListing({
          productId,
          marketplaceAccountId: acc.id,
          externalListingId: `PENDING_${Date.now()}`,
          externalSku: product.sku,
          permalink: null,
          status: "pending",
          retryAttempts: 0,
          nextRetryAt: null,
          lastError: null,
          retryEnabled: true,
          requestedCategoryId: payload.category_id || null,
        });
      }

      // Include shipping dimensions (ML exige string "HxWxL,weight") — clamp para limites aceitos
      // Se o produto não tiver dimensões, usar valores padrão mínimos aceitos pelo ML
      const rawDims = {
        heightCm: product.heightCm,
        widthCm: product.widthCm,
        lengthCm: product.lengthCm,
        weightKg: product.weightKg,
      };
      const hasDims =
        rawDims.heightCm != null &&
        rawDims.widthCm != null &&
        rawDims.lengthCm != null &&
        rawDims.weightKg != null;
      const pkg = this.sanitizePackageDimensions(
        hasDims
          ? rawDims
          : { heightCm: 10, widthCm: 10, lengthCm: 10, weightKg: 1 },
      );

      if (pkg) {
        const dims = `${pkg.height}x${pkg.width}x${pkg.length},${Number(
          pkg.weightKg,
        )}`;
        payload.shipping = {
          dimensions: dims,
          mode: effectiveSettings.shippingMode || undefined,
          free_shipping: effectiveSettings.freeShipping || false,
          local_pick_up: effectiveSettings.localPickup || false,
        };

        // Algumas contas/políticas do ML exigem os atributos seller_package_* mesmo quando enviamos shipping.dimensions.
        const ensureAttr = (id: string, value: string | number) => {
          const exists = payload.attributes?.some((a) => a.id === id);
          if (!exists) {
            payload.attributes?.push({
              id,
              value_name: String(value),
            });
          }
        };

        // ML exige unidades nos atributos de pacote: cm para dimensões, g para peso
        ensureAttr("SELLER_PACKAGE_HEIGHT", `${pkg.height} cm`);
        ensureAttr("SELLER_PACKAGE_WIDTH", `${pkg.width} cm`);
        ensureAttr("SELLER_PACKAGE_LENGTH", `${pkg.length} cm`);
        ensureAttr(
          "SELLER_PACKAGE_WEIGHT",
          `${Math.round(Number(pkg.weightKg) * 1000)} g`,
        );

        // Avisar se houve clamp para facilitar troubleshooting
        if (
          product.heightCm !== pkg.height ||
          product.widthCm !== pkg.width ||
          product.lengthCm !== pkg.length ||
          (product.weightKg != null &&
            Math.round(product.weightKg * 100) !==
              Math.round(pkg.weightKg * 100))
        ) {
          console.warn(
            `[ListingUseCase] Package dimensions clamped to ML limits: ` +
              `H:${pkg.height} W:${pkg.width} L:${pkg.length}cm Wt:${pkg.weightKg}kg (was ` +
              `${product.heightCm}x${product.widthCm}x${product.lengthCm},${product.weightKg}kg)`,
          );
        }
      }

      // Adicionar descriÃ§Ã£o se existir
      // Removido temporariamente para debug
      // if (product.description) {
      //   payload.attributes = [
      //     {
      //       id: "DESCRIPTION",
      //       value_name: product.description,
      //     },
      //   ];
      // }

      // 4. Criar anÃºncio no ML
      console.log(
        `[ListingUseCase] Creating ML listing for product ${productId} (${product.name})`,
      );
      console.log(
        `[ListingUseCase] Payload being sent:`,
        JSON.stringify(payload, null, 2),
      );

      // Envolver createItem para tratar erros especÃ­ficos do ML (ex: seller.unable_to_list)
      let mlItem: any;
      const timeoutMs = Number(process.env.ML_API_TIMEOUT_MS || 15000);
      try {
        mlItem = await this.withTimeout(
          MLApiService.createItem(acc.accessToken, payload),
          timeoutMs,
          "ML createItem",
        );
        console.log(
          `[ListingUseCase] ML response:`,
          JSON.stringify(mlItem, null, 2),
        );
      } catch (err: any) {
        // capture raw mlError object attached by MLApiService
        const parsedMl =
          err && (err as any).mlError ? (err as any).mlError : null;
        const errMsg = err instanceof Error ? err.message : String(err);

        const isCategoryInvalid = !!parsedMl?.cause?.some(
          (c: any) => c?.code === "item.category_id.invalid",
        );

        // Se categoria for inválida, tentar resolver novamente para um leaf local e reenviar
        if (!mlItem && isCategoryInvalid) {
          try {
            const catRetry = await CategoryResolutionService.resolveMLCategory({
              explicitCategoryId: categoryIdForML,
              product,
              validateWithMLAPI: true, // usa fallback local se ML falhar
            });
            const leafRetry =
              await CategoryResolutionService.ensureLeafLocalOnly(
                catRetry.externalId,
              );
            resolvedCategoryId = leafRetry?.externalId || catRetry.externalId;
            categoryIdForML =
              this.normalizeMLCategoryId(resolvedCategoryId) ||
              resolvedCategoryId;

            const retryPayload: MLItemCreatePayload = {
              ...payload,
              category_id: categoryIdForML,
            };
            mlItem = await this.withTimeout(
              MLApiService.createItem(acc.accessToken, retryPayload),
              timeoutMs,
              "ML createItem retry category",
            );
            console.warn(
              `[ListingUseCase] Retentativa com categoria leaf ${categoryIdForML} bem-sucedida`,
            );
          } catch (catErr) {
            console.warn(
              "[ListingUseCase] Retentativa com categoria leaf falhou:",
              catErr instanceof Error ? catErr.message : String(catErr),
            );
          }
        }

        // Fallback imediato: se o erro citar title/invalid_fields, tentar variante segura
        let isTitleInvalid =
          errMsg.toLowerCase().includes("invalid_fields") &&
          errMsg.toLowerCase().includes("title");

        const missingFamilyName =
          errMsg.toLowerCase().includes("family_name") ||
          JSON.stringify(parsedMl || "")
            .toLowerCase()
            .includes("family_name");
        const noTitleFlow = noTitleWithFamily || forceNoTitleFlow;

        if (!mlItem && missingFamilyName && !includeFamilyName) {
          try {
            console.warn(
              `[ListingUseCase] ML solicitou family_name; retentando mantendo título informado`,
            );
            const withFamily: MLItemCreatePayload = {
              ...payload,
              family_name: familyNameValue || this.buildMLTitle(product),
            };
            if (noTitleFlow) delete (withFamily as any).title;

            // Atualizar estado ANTES da chamada para que retries subsequentes tenham family_name
            includeFamilyName = includeFamilyName || !!withFamily.family_name;
            if (!payload.family_name && withFamily.family_name) {
              (payload as any).family_name = withFamily.family_name;
            }

            mlItem = await this.withTimeout(
              MLApiService.createItem(acc.accessToken, withFamily),
              timeoutMs,
              "ML createItem family_name",
            );
          } catch (famErr) {
            const famMsg =
              famErr instanceof Error ? famErr.message : String(famErr);
            console.warn(
              "[ListingUseCase] Retentativa com family_name falhou:",
              famMsg,
            );
            if (
              !isTitleInvalid &&
              famMsg.toLowerCase().includes("invalid_fields") &&
              famMsg.toLowerCase().includes("title")
            ) {
              isTitleInvalid = true;
            }
          }
        }

        // Para categorias que proíbem title quando family_name está presente, priorizar tentativa sem title
        const shouldTryNoTitle = noTitleFlow;
        if (!mlItem && (isTitleInvalid || noTitleFlow) && shouldTryNoTitle) {
          try {
            console.warn(
              "[ListingUseCase] Retentando createItem sem title (UP domain requer family_name)",
            );
            const noTitlePayload: MLItemCreatePayload = {
              ...payload,
              family_name:
                (payload as any).family_name ||
                familyNameValue ||
                this.buildMLTitle(product),
            } as any;
            delete (noTitlePayload as any).title;
            mlItem = await this.withTimeout(
              MLApiService.createItem(acc.accessToken, noTitlePayload),
              timeoutMs,
              "ML createItem noTitle",
            );
          } catch (noTitleErr) {
            console.warn(
              "[ListingUseCase] Retentativa sem title falhou:",
              noTitleErr instanceof Error
                ? noTitleErr.message
                : String(noTitleErr),
            );
          }
        }

        // Se o ML rejeitar title e a categoria permitir title, tente um título seguro
        if (!mlItem && isTitleInvalid && !noTitleFlow) {
          try {
            const safeTitle = this.buildSafeFallbackTitle(product);
            console.warn(
              `[ListingUseCase] Retentando createItem com título seguro: "${safeTitle}"`,
            );
            const retryPayload: MLItemCreatePayload = {
              ...payload,
              title: safeTitle,
            };
            if (
              includeFamilyName &&
              familyNameValue &&
              !retryPayload.family_name
            ) {
              retryPayload.family_name = familyNameValue;
            }
            mlItem = await this.withTimeout(
              MLApiService.createItem(acc.accessToken, retryPayload),
              timeoutMs,
              "ML createItem safeTitle",
            );
          } catch (retryTitleErr) {
            console.warn(
              "[ListingUseCase] Retentativa com título seguro falhou:",
              retryTitleErr instanceof Error
                ? retryTitleErr.message
                : String(retryTitleErr),
            );
          }
        }

        // Fallback dinâmico: se ainda falhar com título e family_name foi enviado, tente sem title mesmo fora da allowlist
        if (!mlItem && isTitleInvalid && includeFamilyName && !noTitleFlow) {
          try {
            console.warn(
              "[ListingUseCase] Retentando createItem sem title (fallback dinâmico após título rejeitado)",
            );
            const noTitlePayload: MLItemCreatePayload = {
              ...payload,
              family_name:
                (payload as any).family_name ||
                familyNameValue ||
                this.buildMLTitle(product),
            } as any;
            delete (noTitlePayload as any).title;
            mlItem = await this.withTimeout(
              MLApiService.createItem(acc.accessToken, noTitlePayload),
              timeoutMs,
              "ML createItem fallback noTitle",
            );
          } catch (dynErr) {
            console.warn(
              "[ListingUseCase] Fallback dinâmico sem title falhou:",
              dynErr instanceof Error ? dynErr.message : String(dynErr),
            );
          }
        }

        if (!mlItem && isTitleInvalid) {
          const nextRetryMs = 60 * 1000;
          await ListingRepository.updateListing(listing.id, {
            status: "error",
            lastError: errMsg,
            retryEnabled: true,
            nextRetryAt: new Date(Date.now() + nextRetryMs),
            requestedCategoryId: payload.category_id || null,
          });
          return {
            success: false,
            error:
              "Mercado Livre rejeitou o título informado. Ajuste o título e tente novamente.",
            mlError: errMsg,
          };
        }

        // Bloqueio por PolicyAgent (permissÃ£o funcional faltando ou polÃ­tica da conta)
        const policyBlocked =
          parsedMl?.code === "PA_UNAUTHORIZED_RESULT_FROM_POLICIES" ||
          parsedMl?.blocked_by === "PolicyAgent" ||
          errMsg.includes("PolicyAgent");

        if (!mlItem && policyBlocked) {
          const humanMsg =
            "Conta do Mercado Livre sem permissÃ£o para publicar (PolicyAgent). RefaÃ§a a autorizaÃ§Ã£o habilitando permissÃµes de anÃºncio no app do ML e reconecte a conta.";

          try {
            await SystemLogService.logError("CREATE_LISTING", humanMsg, {
              userId,
              resource: "MarketplaceAccount",
              resourceId: acc.id,
              details: { mlError: parsedMl || errMsg },
            });
          } catch (logErr) {
            console.error(
              "[ListingUseCase] failed to log PolicyAgent block:",
              logErr,
            );
          }

          // Marcar conta como ERROR para forÃ§ar reconexÃ£o e desabilitar retries automÃ¡ticos
          try {
            await MarketplaceRepository.updateStatus(
              acc.id,
              AccountStatus.ERROR,
            );
          } catch (stErr) {
            console.warn(
              "[ListingUseCase] failed to mark account as ERROR:",
              stErr,
            );
          }

          try {
            await ListingRepository.updateListing(listing.id, {
              status: "error",
              lastError: humanMsg,
              retryEnabled: false,
              nextRetryAt: null,
              requestedCategoryId: payload.category_id || null,
            });
          } catch (phErr) {
            console.error(
              "[ListingUseCase] Failed to flag placeholder after PolicyAgent block:",
              phErr,
            );
          }

          return {
            success: false,
            error: humanMsg,
            mlError: errMsg,
          };
        }

        // Caso conhecido: vendedor estÃ¡ impedido de anunciar (restriÃ§Ã£o do ML)
        if (
          errMsg.includes("seller.unable_to_list") ||
          errMsg.includes("User is unable to list")
        ) {
          // log entire object for debugging
          try {
            await SystemLogService.logError(
              "CREATE_LISTING",
              `Falha ao criar anÃºncio no ML (seller.unable_to_list): ${errMsg}`,
              {
                userId,
                resource: "MarketplaceAccount",
                resourceId: acc.id,
                details: { mlError: parsedMl || errMsg },
              },
            );
          } catch (logErr) {
            console.error(
              "[ListingUseCase] failed to log detailed ML error:",
              logErr,
            );
          }

          // Attempt quick re-checks before giving up â€” seller restrictions can be
          // transient. Do NOT mark account as ERROR here; keep it connected.
          let recovered = false;
          try {
            // ensure we have sellerId (may not be populated if earlier pre-check was skipped)
            if (!sellerId) {
              const _u = await MLOAuthService.getUserInfo(acc.accessToken);
              sellerId = _u?.id?.toString();
            }

            if (sellerId) {
              // extend quick re-check window
              for (let attempt = 1; attempt <= 4; attempt++) {
                await new Promise((r) => setTimeout(r, attempt * 700));
                try {
                  await MLApiService.getSellerItemIds(
                    acc.accessToken,
                    sellerId,
                    "active",
                    1,
                  );
                  recovered = true;
                  break;
                } catch (e) {
                  console.debug(
                    `[ListingUseCase] create-item recheck ${attempt} failed for account ${account?.id || "<no-account>"}`,
                  );
                }
              }
            }
          } catch (e) {
            /* ignore */
          }

          if (recovered) {
            // Try creating the item again with a small retry loop
            for (let attempt = 1; attempt <= 3 && !mlItem; attempt++) {
              try {
                if (attempt > 1) {
                  await new Promise((r) => setTimeout(r, attempt * 700));
                }
                mlItem = await this.withTimeout(
                  MLApiService.createItem(acc.accessToken, payload),
                  timeoutMs,
                  "ML createItem retry restricted",
                );
                console.log(
                  `[ListingUseCase] ML create succeeded on retry (attempt ${attempt})`,
                );
                break;
              } catch (retryCreateErr) {
                console.debug(
                  `[ListingUseCase] createItem retry ${attempt} failed:`,
                  retryCreateErr instanceof Error
                    ? retryCreateErr.message
                    : String(retryCreateErr),
                );
                // continue retrying
              }
            }
          }

          // If we still don't have an mlItem, record a system log and update placeholder
          if (!mlItem) {
            try {
              await SystemLogService.logError(
                "CREATE_LISTING",
                `Falha ao criar anÃºncio no ML: ${errMsg}`,
                {
                  userId,
                  resource: "MarketplaceAccount",
                  resourceId: acc.id,
                  details: { mlError: parsedMl || errMsg },
                },
              );
            } catch (logErr) {
              console.error(
                "[ListingUseCase] Failed to record system log for ML restriction:",
                logErr,
              );
            }

            // atualizar placeholder existente com erro e agendar retry
            const nextRetryMs = 60 * 1000; // 1 min de backoff inicial
            try {
              await ListingRepository.updateListing(listing.id, {
                status: "error",
                lastError: errMsg,
                retryEnabled: true,
                nextRetryAt: new Date(Date.now() + nextRetryMs),
                requestedCategoryId: payload.category_id || null,
              });
            } catch (phErr) {
              console.error(
                "[ListingUseCase] Failed to update placeholder after ML failure:",
                phErr,
              );
            }

            return {
              success: false,
              skipped: true,
              listingId: listing.id,
              error:
                "Conta do Mercado Livre com restriÃ§Ã£o â€” impossÃ­vel criar anÃºncios. Verifique o Seller Center do Mercado Livre.",
              mlError: errMsg,
            };
          }

          // If we recovered and mlItem was created by the retry above, continue the normal flow
        }

        // If we recovered and have mlItem, continue normal flow; otherwise rethrow
        if (!mlItem) {
          // marcar placeholder com erro genÃ©rico para retry e exibir ao usuÃ¡rio
          const nextRetryMs = 60 * 1000;
          try {
            await ListingRepository.updateListing(listing.id, {
              status: "error",
              lastError: errMsg,
              retryEnabled: true,
              nextRetryAt: new Date(Date.now() + nextRetryMs),
              requestedCategoryId: payload.category_id || null,
            });
          } catch (updateErr) {
            console.error(
              "[ListingUseCase] Failed to flag placeholder after generic ML error:",
              updateErr,
            );
          }

          throw err;
        }
      }
      // 4.1. Reforçar descrição após criação usando endpoint dedicado
      try {
        await this.withTimeout(
          MLApiService.upsertDescription(
            acc.accessToken,
            mlItem.id,
            descriptionText,
          ),
          timeoutMs,
          "ML upsertDescription",
        );
        console.log(
          "[ListingUseCase] ML item description updated via /description",
        );
      } catch (err) {
        console.error(
          "[ListingUseCase] Failed to update ML item description:",
          err,
        );
      }

      // 4.1.1 Atualizar family_name via PUT para que o título gerado pelo ML
      // reflita o nome completo do produto (em categorias User Product o título
      // visível é calculado a partir de family_name + atributos).
      const desiredFamilyName = this.buildMLTitle(product);
      if (mlItem?.id && desiredFamilyName) {
        const mlReturnedTitle = (mlItem.title || "").trim();
        // Tentar atualizar family_name se o título retornado não contém o nome desejado
        // ou se a categoria usa o fluxo User Product (family_name)
        const titleMismatch =
          mlReturnedTitle.toLowerCase() !== desiredFamilyName.toLowerCase() &&
          !mlReturnedTitle
            .toLowerCase()
            .includes(desiredFamilyName.toLowerCase());
        if (
          titleMismatch ||
          includeFamilyName ||
          (payload as any).family_name
        ) {
          try {
            await this.withTimeout(
              MLApiService.updateItem(acc.accessToken, mlItem.id, {
                family_name: desiredFamilyName,
              }),
              timeoutMs,
              "ML updateItem family_name",
            );
            console.log(
              `[ListingUseCase] family_name updated to "${desiredFamilyName}" for ${mlItem.id}`,
            );
          } catch (fnErr) {
            // Não é crítico — o anúncio já foi criado. Logar e seguir.
            console.warn(
              `[ListingUseCase] Failed to update family_name for ${mlItem.id}:`,
              fnErr instanceof Error ? fnErr.message : String(fnErr),
            );
          }
        }
      }

      // 4.2 Verificar status real no ML e tentar reativar se possível
      let remoteStatus: "active" | "paused" | "closed" | "under_review" =
        "active";
      let remoteSubStatus: string[] | undefined;
      try {
        const details = await MLApiService.getItemDetails(
          acc.accessToken,
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
                acc.accessToken,
                mlItem.id,
                {
                  status: "active",
                },
              );
              remoteStatus = reactivated.status;
              remoteSubStatus = (reactivated as any).sub_status;
              console.warn(
                `[ListingUseCase] ML item ${mlItem.id} was paused; auto-activation attempted -> ${remoteStatus}`,
              );
            } catch (reactivateErr) {
              console.warn(
                `[ListingUseCase] Failed to auto-activate paused item ${mlItem.id}:`,
                reactivateErr instanceof Error
                  ? reactivateErr.message
                  : String(reactivateErr),
              );
            }
          }
        }
      } catch (statusErr) {
        console.warn(
          `[ListingUseCase] Could not fetch status for ${mlItem.id} after creation:`,
          statusErr instanceof Error ? statusErr.message : String(statusErr),
        );
      }

      // 5. Atualizar placeholder local (ou criar, se por algum motivo não existir)
      let finalListingId: string;
      try {
        const updated = await ListingRepository.updateListing(listing.id, {
          externalListingId: mlItem.id,
          externalSku: product.sku,
          permalink: mlItem.permalink || null,
          status: remoteStatus,
          retryEnabled: false,
          nextRetryAt: null,
          lastError:
            remoteStatus === "paused" && remoteSubStatus?.length
              ? `ML retornou status=paused (${remoteSubStatus.join(",")})`
              : null,
          retryAttempts: 0,
          requestedCategoryId: payload.category_id || null,
        });
        finalListingId = updated.id;
      } catch (updateErr) {
        // fallback: cria novo registro se update falhar por algum motivo inesperado
        const created = await ListingRepository.createListing({
          productId,
          marketplaceAccountId: acc.id,
          externalListingId: mlItem.id,
          externalSku: product.sku,
          permalink: mlItem.permalink,
          status: remoteStatus,
          retryEnabled: false,
          nextRetryAt: null,
          lastError:
            remoteStatus === "paused" && remoteSubStatus?.length
              ? `ML retornou status=paused (${remoteSubStatus.join(",")})`
              : null,
          requestedCategoryId: payload.category_id || null,
        });
        finalListingId = created.id;
      }

      console.log(`[ListingUseCase] ML listing created: ${mlItem.id}`);

      return {
        success: true,
        listingId: finalListingId,
        externalListingId: mlItem.id,
        permalink: mlItem.permalink,
      };
    } catch (error) {
      console.error("[ListingUseCase] Error creating ML listing:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Erro desconhecido",
      };
    }
  }

  /**
   * ConstrÃ³i um tÃ­tulo para o anÃºncio do Shopee
   */
  private static buildShopeeTitle(product: any): string {
    const parts: string[] = [];

    // Adicionar nome do produto
    parts.push(product.name);

    // Adicionar marca se disponÃ­vel
    if (product.brand) {
      parts.push(product.brand);
    }

    // Adicionar modelo se disponÃ­vel
    if (product.model) {
      parts.push(product.model);
    }

    // Adicionar ano se disponÃ­vel
    if (product.year) {
      parts.push(product.year);
    }

    // Adicionar versÃ£o se disponÃ­vel
    if (product.version) {
      parts.push(product.version);
    }

    // Adicionar partNumber se disponÃ­vel
    if (product.partNumber) {
      parts.push(`PN: ${product.partNumber}`);
    }

    // Juntar tudo e limitar a 120 caracteres (limite do Shopee)
    const fullTitle = parts.join(" - ");
    return fullTitle.length > 120 ? fullTitle.substring(0, 120) : fullTitle;
  }

  /**
   * ConstrÃ³i uma descriÃ§Ã£o para o anÃºncio do Shopee
   */
  private static buildShopeeDescription(product: any): string {
    const parts: string[] = [];

    // DescriÃ§Ã£o principal
    if (product.description) {
      parts.push(product.description);
    }

    // Detalhes tÃ©cnicos
    const details: string[] = [];
    if (product.brand) details.push(`Marca: ${product.brand}`);
    if (product.model) details.push(`Modelo: ${product.model}`);
    if (product.year) details.push(`Ano: ${product.year}`);
    if (product.version) details.push(`VersÃ£o: ${product.version}`);
    if (product.partNumber)
      details.push(`NÃºmero da PeÃ§a: ${product.partNumber}`);
    if (product.quality) details.push(`Qualidade: ${product.quality}`);
    if (product.location) details.push(`LocalizaÃ§Ã£o: ${product.location}`);

    if (details.length > 0) {
      parts.push("Detalhes TÃ©cnicos:");
      parts.push(details.join("\n"));
    }

    // SKU para referÃªncia
    parts.push(`SKU: ${product.sku}`);

    return parts.join("\n\n");
  }

  /**
   * Cria um anÃºncio no Shopee para um produto
   * @param userId ID do usuÃ¡rio
   * @param productId ID do produto
   * @param categoryId ID da categoria do Shopee (opcional, serÃ¡ inferida se nÃ£o fornecida)
   */
  static async createShopeeListing(
    userId: string,
    productId: string,
    categoryId?: string,
    accountId?: string,
  ): Promise<CreateListingResult> {
    let account: any = null;
    try {
      account = accountId
        ? await MarketplaceRepository.findByIdAndUser(accountId, userId)
        : await MarketplaceRepository.findFirstActiveByUserAndPlatform(
            userId,
            Platform.SHOPEE,
          );

      if (!account && !accountId) {
        const all = await MarketplaceRepository.findAllByUserIdAndPlatform(
          userId,
          Platform.SHOPEE,
        );
        const active = (all || []).filter(
          (acc) => acc.status === AccountStatus.ACTIVE,
        );
        if (active.length > 1) {
          return {
            success: false,
            error:
              "Selecione a conta Shopee para criar o anúncio (multi-contas ativas detectadas).",
          };
        }
        account = active[0];
      }

      if (!account || !account.accessToken || !account.shopId) {
        return {
          success: false,
          error: "Conta do Shopee não conectada ou sem credenciais válidas",
        };
      }

      // --- Token refresh automático (mesmo padrão do ML) ---
      const now = new Date();
      if (account.expiresAt < now) {
        try {
          console.debug(
            `[ListingUseCase] Shopee token expired for account ${account.id}, attempting refresh`,
          );
          const refreshed = await ShopeeOAuthService.refreshAccessToken(
            account.refreshToken,
            account.shopId,
          );

          console.debug(
            `[ListingUseCase] Shopee token refresh returned, updating DB tokens`,
          );
          const updated = await MarketplaceRepository.updateTokens(account.id, {
            accessToken: refreshed.access_token,
            refreshToken: refreshed.refresh_token,
            expiresAt: ShopeeOAuthService.calculateExpiryDate(
              refreshed.expire_in,
            ),
          });

          if (updated) {
            account = updated as any;
            console.debug(
              `[ListingUseCase] Shopee account tokens updated successfully`,
            );
          }
        } catch (refreshErr) {
          await MarketplaceRepository.updateStatus(
            account.id,
            AccountStatus.ERROR,
          );
          console.warn(
            `[ListingUseCase] Failed to refresh Shopee token for account ${account.id}:`,
            (refreshErr as any)?.message || refreshErr,
          );
          return {
            success: false,
            error:
              "Conta do Shopee expirou ou token inválido — reconecte a conta",
          };
        }
      }

      // 2. Buscar dados do produto
      const product =
        await ListingUseCase.productRepository.findById(productId);
      if (!product) {
        return {
          success: false,
          error: "Produto não encontrado",
        };
      }

      const resolvedShopeeCategoryId =
        categoryId || (product as any).shopeeCategoryId;
      if (!resolvedShopeeCategoryId) {
        return {
          success: false,
          error:
            "Selecione uma categoria do Shopee no produto antes de publicar.",
        };
      }

      // Strip "SHP_" prefix if present to get the numeric category ID
      const numericCategoryId = parseInt(
        String(resolvedShopeeCategoryId).replace(/^SHP_/i, ""),
        10,
      );
      if (isNaN(numericCategoryId)) {
        return {
          success: false,
          error: `Categoria do Shopee inválida: ${resolvedShopeeCategoryId}`,
        };
      }

      // 3. Buscar atributos obrigatórios da categoria via API Shopee
      const attributeList: ShopeeItemCreatePayload["attribute_list"] = [];

      // Mapa de valores do produto para os nomes de atributos mais comuns
      const productAttrValues: Record<string, string> = {};
      if (product.brand) productAttrValues["marca"] = product.brand;
      if (product.brand) productAttrValues["brand"] = product.brand;
      if (product.model) productAttrValues["modelo"] = product.model;
      if (product.model) productAttrValues["model"] = product.model;
      if (product.year) productAttrValues["ano"] = product.year;
      if (product.year) productAttrValues["year"] = product.year;
      if (product.partNumber)
        productAttrValues["número de referência"] = product.partNumber;
      if (product.partNumber)
        productAttrValues["part number"] = product.partNumber;
      if (product.partNumber)
        productAttrValues["reference number"] = product.partNumber;

      try {
        const categoryAttrs = await ShopeeApiService.getCategoryAttributes(
          account.accessToken,
          account.shopId,
          numericCategoryId,
          "pt-BR",
        );

        const attrs = categoryAttrs?.attribute_list || [];
        console.log(
          `[ListingUseCase] Shopee category ${numericCategoryId} has ${attrs.length} attributes (${attrs.filter((a) => a.is_mandatory).length} mandatory)`,
        );

        for (const attr of attrs) {
          // Tentar encontrar um valor do produto para este atributo
          const attrNameLower = attr.attribute_name.toLowerCase();
          const productValue = productAttrValues[attrNameLower];

          if (!productValue && !attr.is_mandatory) continue;

          // Resolução de value_id: tentar casar com a lista de valores permitidos
          let valueId = 0;
          let valueName = productValue || "";

          if (
            attr.attribute_value_list &&
            attr.attribute_value_list.length > 0
          ) {
            // Procurar match exato ou parcial na lista de valores permitidos
            const exactMatch = attr.attribute_value_list.find(
              (v) =>
                v.value_name.toLowerCase() ===
                (productValue || "").toLowerCase(),
            );
            if (exactMatch) {
              valueId = exactMatch.value_id;
              valueName = exactMatch.value_name;
            } else if (productValue) {
              // Match parcial (contém)
              const partialMatch = attr.attribute_value_list.find(
                (v) =>
                  v.value_name
                    .toLowerCase()
                    .includes((productValue || "").toLowerCase()) ||
                  (productValue || "")
                    .toLowerCase()
                    .includes(v.value_name.toLowerCase()),
              );
              if (partialMatch) {
                valueId = partialMatch.value_id;
                valueName = partialMatch.value_name;
              }
            }

            // Se obrigatório e sem match, usar o primeiro valor ou "Outros"
            if (attr.is_mandatory && !valueName) {
              const otherValue = attr.attribute_value_list.find(
                (v) =>
                  v.value_name.toLowerCase() === "outros" ||
                  v.value_name.toLowerCase() === "other" ||
                  v.value_name.toLowerCase() === "genérica",
              );
              if (otherValue) {
                valueId = otherValue.value_id;
                valueName = otherValue.value_name;
              } else {
                // Fallback: primeiro valor da lista
                valueId = attr.attribute_value_list[0].value_id;
                valueName = attr.attribute_value_list[0].value_name;
              }
            }
          } else if (attr.is_mandatory && !valueName) {
            // Campo obrigatório do tipo texto livre sem lista de valores
            valueName = productValue || product.brand || product.name;
          }

          if (valueName) {
            const attrValue: Record<string, unknown> = {
              value_id: valueId,
            };
            if (valueId === 0) {
              attrValue.original_value_name = valueName;
            } else {
              attrValue.original_value_name = valueName;
              attrValue.value_id = valueId;
            }
            attributeList.push({
              attribute_id: attr.attribute_id,
              attribute_name: attr.attribute_name,
              attribute_value_list: [attrValue as any],
            });
          }
        }
      } catch (attrErr) {
        // Fallback: se não conseguiu buscar atributos da categoria, enviar lista vazia.
        // IDs de atributos variam por categoria – hardcodar IDs causa rejeição.
        // A API Shopee retornará erro específico se atributos obrigatórios estiverem faltando.
        console.warn(
          `[ListingUseCase] Failed to fetch Shopee category attributes for ${numericCategoryId}, proceeding without attributes:`,
          (attrErr as any)?.message || attrErr,
        );
      }

      // Normalizar URL de imagem (evitar barra dupla)
      const backendUrl = (
        process.env.APP_BACKEND_URL || "http://localhost:3333"
      ).replace(/\/+$/, "");
      let imageUrl = "";
      if (product.imageUrl) {
        if (product.imageUrl.startsWith("http")) {
          imageUrl = product.imageUrl;
        } else {
          const path = product.imageUrl.startsWith("/")
            ? product.imageUrl
            : `/${product.imageUrl}`;
          imageUrl = `${backendUrl}${path}`;
        }
      }

      // Validar que temos uma imagem válida antes de upload
      if (!imageUrl) {
        throw new Error(
          "Produto sem imagem. A Shopee exige pelo menos uma imagem para criar o anúncio.",
        );
      }

      // Upload da imagem ao Shopee (API requer image_id, não URL direta)
      let shopeeImageId: string;
      try {
        console.log(`[ListingUseCase] Uploading image to Shopee: ${imageUrl}`);
        const uploadResult = await ShopeeApiService.uploadImage(
          account.accessToken,
          account.shopId,
          imageUrl,
        );
        shopeeImageId = uploadResult.image_info.image_id;
        console.log(`[ListingUseCase] Shopee image uploaded: ${shopeeImageId}`);
      } catch (imgErr) {
        console.error(
          `[ListingUseCase] Shopee image upload failed:`,
          (imgErr as any)?.message || imgErr,
        );
        throw new Error(
          `Falha ao fazer upload da imagem para Shopee: ${(imgErr as any)?.message || imgErr}`,
        );
      }

      // Shopee exige brand — fallback "Genérica" se produto não tiver marca
      const brandName = product.brand || "Genérica";

      // Mapear condição do produto para Shopee (uppercase)
      const shopeeCondition: "NEW" | "USED" =
        (product as any).quality === "NOVO" ? "NEW" : "USED";

      // Buscar canais logísticos disponíveis na loja Shopee
      let logisticInfo: Array<{ logistic_id: number; enabled: boolean }> = [];
      try {
        const channels = await ShopeeApiService.getLogisticsChannelList(
          account.accessToken,
          account.shopId,
        );
        logisticInfo = channels
          .filter((ch) => ch.enabled)
          .map((ch) => ({
            logistic_id: ch.logistics_channel_id,
            enabled: true,
          }));
        console.log(
          `[ListingUseCase] Shopee logistics channels found: ${logisticInfo.length}`,
        );
      } catch (logErr) {
        console.warn(
          `[ListingUseCase] Failed to fetch Shopee logistics, using empty:`,
          (logErr as any)?.message || logErr,
        );
      }

      // Shopee Xpress BR limits: max 30kg, max 100cm per side, L+W+H <= 200cm
      const SHOPEE_MAX_WEIGHT_KG = 30;
      const SHOPEE_MAX_DIM_CM = 100;
      const SHOPEE_MAX_SUM_CM = 200;
      const SHOPEE_MIN_DIM_CM = 1;

      const rawWeightKg =
        product.weightKg && product.weightKg > 0 ? product.weightKg : 1.0;
      const rawLength =
        product.lengthCm && product.lengthCm > 0 ? product.lengthCm : 10;
      const rawWidth =
        product.widthCm && product.widthCm > 0 ? product.widthCm : 10;
      const rawHeight =
        product.heightCm && product.heightCm > 0 ? product.heightCm : 10;

      const clampedWeightKg = Math.min(rawWeightKg, SHOPEE_MAX_WEIGHT_KG);
      let clampedLength = Math.max(SHOPEE_MIN_DIM_CM, Math.min(rawLength, SHOPEE_MAX_DIM_CM));
      let clampedWidth = Math.max(SHOPEE_MIN_DIM_CM, Math.min(rawWidth, SHOPEE_MAX_DIM_CM));
      let clampedHeight = Math.max(SHOPEE_MIN_DIM_CM, Math.min(rawHeight, SHOPEE_MAX_DIM_CM));

      // Ensure L+W+H <= 200cm (scale down proportionally if needed)
      const dimSum = clampedLength + clampedWidth + clampedHeight;
      if (dimSum > SHOPEE_MAX_SUM_CM) {
        const scale = SHOPEE_MAX_SUM_CM / dimSum;
        clampedLength = Math.max(SHOPEE_MIN_DIM_CM, Math.round(clampedLength * scale));
        clampedWidth = Math.max(SHOPEE_MIN_DIM_CM, Math.round(clampedWidth * scale));
        clampedHeight = Math.max(SHOPEE_MIN_DIM_CM, Math.round(clampedHeight * scale));
      }

      if (rawWeightKg !== clampedWeightKg || rawLength !== clampedLength || rawWidth !== clampedWidth || rawHeight !== clampedHeight) {
        console.warn(
          `[ListingUseCase] Shopee dimensions clamped: ${clampedHeight}x${clampedWidth}x${clampedLength}cm ${clampedWeightKg}kg (was ${rawHeight}x${rawWidth}x${rawLength}cm,${rawWeightKg}kg)`,
        );
      }

      const payload: ShopeeItemCreatePayload = {
        category_id: numericCategoryId,
        item_name: this.buildShopeeTitle(product),
        description: this.buildShopeeDescription(product),
        item_sku: product.sku,
        original_price: Number(product.price) || 1,
        seller_stock: [{ stock: Math.min(product.stock || 1, 999999) }],
        condition: shopeeCondition,
        weight: clampedWeightKg,
        dimension: {
          package_length: clampedLength,
          package_width: clampedWidth,
          package_height: clampedHeight,
        },
        image: {
          image_id_list: [shopeeImageId],
        },
        attribute_list: attributeList,
        brand: { brand_id: 0, original_brand_name: brandName },
        ...(logisticInfo.length > 0 ? { logistic_info: logisticInfo } : {}),
      };

      // 3.5 Criar placeholder local ANTES de chamar a API (visibilidade + retry)
      let listing = await ListingRepository.findByProductAndAccount(
        productId,
        account.id,
      );
      if (!listing) {
        listing = await ListingRepository.createListing({
          productId,
          marketplaceAccountId: account.id,
          externalListingId: `PENDING_SHP_${Date.now()}`,
          externalSku: product.sku,
          permalink: null,
          status: "pending",
          retryAttempts: 0,
          nextRetryAt: null,
          lastError: null,
          retryEnabled: true,
          requestedCategoryId: String(numericCategoryId),
        });
        console.log(
          `[ListingUseCase] Shopee placeholder created: ${listing.id} for product ${productId}`,
        );
      }

      // 4. Criar anúncio no Shopee (com retry em caso de erro de token)
      console.log(
        `[ListingUseCase] Creating Shopee listing for product ${productId} (${product.name})`,
      );
      console.log(
        `[ListingUseCase] Shopee payload summary`,
        JSON.stringify({
          category_id: payload.category_id,
          item_name: payload.item_name,
          brand: payload.brand,
          condition: payload.condition,
          original_price: payload.original_price,
          seller_stock: payload.seller_stock,
          weight: payload.weight,
          dimension: payload.dimension,
          logistic_info_count: payload.logistic_info?.length || 0,
          attributes: (payload.attribute_list || []).map((a) => ({
            id: a.attribute_id,
            name: a.attribute_name,
            value: a.attribute_value_list?.[0]?.value_name,
          })),
          imageId: shopeeImageId,
        }),
      );

      let shopeeItem: { item_id: number };
      try {
        shopeeItem = await ShopeeApiService.createItem(
          account.accessToken,
          account.shopId,
          payload,
        );
      } catch (firstErr) {
        // Retry: se erro parece ser de token, tentar refresh e retry uma vez
        const errMsg =
          (firstErr instanceof Error ? firstErr.message : String(firstErr)) ||
          "";
        const isAuthError =
          /token|auth|permission|forbidden|unauthorized|expire/i.test(errMsg);

        if (isAuthError && account.refreshToken) {
          console.warn(
            `[ListingUseCase] Shopee API auth error, attempting token refresh and retry`,
          );
          try {
            const refreshed = await ShopeeOAuthService.refreshAccessToken(
              account.refreshToken,
              account.shopId,
            );
            await MarketplaceRepository.updateTokens(account.id, {
              accessToken: refreshed.access_token,
              refreshToken: refreshed.refresh_token,
              expiresAt: ShopeeOAuthService.calculateExpiryDate(
                refreshed.expire_in,
              ),
            });

            shopeeItem = await ShopeeApiService.createItem(
              refreshed.access_token,
              account.shopId,
              payload,
            );
          } catch (retryErr) {
            console.error(
              `[ListingUseCase] Shopee retry also failed:`,
              retryErr,
            );
            throw retryErr;
          }
        } else {
          throw firstErr;
        }
      }

      console.log(
        `[ListingUseCase] Shopee response:`,
        JSON.stringify(shopeeItem, null, 2),
      );

      // 5. Atualizar placeholder com dados reais do Shopee
      await ListingRepository.updateListing(listing.id, {
        externalListingId: shopeeItem.item_id.toString(),
        permalink: `https://shopee.com.br/product/${account.shopId}/${shopeeItem.item_id}`,
        status: "active",
        lastError: null,
        retryEnabled: false,
      });

      console.log(
        `[ListingUseCase] Shopee listing created: ${shopeeItem.item_id}`,
      );

      return {
        success: true,
        listingId: listing.id,
        externalListingId: shopeeItem.item_id.toString(),
      };
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : "Erro desconhecido";
      console.error(
        `[ListingUseCase] Error creating Shopee listing for product ${productId}:`,
        errorMsg,
      );

      // Atualizar placeholder com erro para visibilidade e retry futuro
      try {
        const acctId = account?.id;
        if (acctId) {
          const existingListing =
            await ListingRepository.findByProductAndAccount(productId, acctId);
          if (existingListing) {
            await ListingRepository.updateListing(existingListing.id, {
              status: "error",
              lastError: errorMsg.substring(0, 500),
              retryEnabled: true,
              nextRetryAt: new Date(Date.now() + 60_000),
            });
          }
        }
      } catch (updateErr) {
        console.error(
          `[ListingUseCase] Failed to update Shopee placeholder with error:`,
          updateErr,
        );
      }

      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Atualiza o estoque de um anÃºncio no ML
   * @param listingId ID do vÃ­nculo local
   * @param quantity Nova quantidade
   */
  static async updateMLListingStock(
    listingId: string,
    quantity: number,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Buscar vÃ­nculo
      const listing = await ListingRepository.findById(listingId);
      if (!listing) {
        return { success: false, error: "VÃ­nculo nÃ£o encontrado" };
      }

      // Buscar conta para obter access token
      const account = await MarketplaceRepository.findById(
        listing.marketplaceAccountId,
      );
      if (!account || !account.accessToken) {
        return { success: false, error: "Conta sem credenciais vÃ¡lidas" };
      }

      // Atualizar estoque no ML
      await MLApiService.updateItemStock(
        account.accessToken,
        listing.externalListingId,
        quantity,
      );

      return { success: true };
    } catch (error) {
      console.error("[ListingUseCase] Error updating ML stock:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Erro ao atualizar estoque",
      };
    }
  }

  /**
   * Remove um anÃºncio do ML
   * @param listingId ID do vÃ­nculo local
   */
  static async removeMLListing(
    listingId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Buscar vÃ­nculo
      const listing = await ListingRepository.findById(listingId);
      if (!listing) {
        return { success: false, error: "VÃ­nculo nÃ£o encontrado" };
      }

      // Se ainda estÃ¡ com placeholder PENDING ou sem externalListingId, apenas remove localmente
      if (
        !listing.externalListingId ||
        listing.externalListingId.startsWith("PENDING_")
      ) {
        await ListingRepository.deleteListing(listingId);
        return { success: true };
      }

      // Buscar conta para obter access token
      const account = await MarketplaceRepository.findById(
        listing.marketplaceAccountId,
      );
      if (!account || !account.accessToken) {
        // Sem credenciais, remova localmente para evitar lixo
        await ListingRepository.deleteListing(listingId);
        return { success: true };
      }

      // Primeiro, verificar o status atual do anÃºncio
      try {
        const currentItem = await MLApiService.getItemDetails(
          account.accessToken,
          listing.externalListingId,
        );
        console.log(
          `[ListingUseCase] Current status of ${listing.externalListingId}: ${currentItem.status}`,
        );
      } catch (statusError) {
        console.warn(
          `[ListingUseCase] Could not get current status of ${listing.externalListingId}:`,
          statusError,
        );
        // se o item nÃ£o existir mais no ML, apenas prossegue com remoÃ§Ã£o local
      }

      // Tentar fechar anÃºncio no ML (itens com infraÃ§Ãµes ou em processamento podem nÃ£o poder ser fechados)
      try {
        await MLApiService.updateItem(
          account.accessToken,
          listing.externalListingId,
          {
            status: "closed",
          },
        );
        console.log(
          `[ListingUseCase] ML listing ${listing.externalListingId} closed successfully`,
        );
      } catch (closeError) {
        console.warn(
          `[ListingUseCase] Could not close ML listing ${listing.externalListingId}:`,
          closeError,
        );
        // Mesmo que nÃ£o consiga fechar, continua removendo o vÃ­nculo local.
        // O item pode jÃ¡ ter sido apagado ou estar em processamento; nÃ£o devemos travar a remoÃ§Ã£o local.
      }

      // Remover vÃ­nculo local
      await ListingRepository.deleteListing(listingId);

      return { success: true };
    } catch (error) {
      console.error("[ListingUseCase] Error removing ML listing:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Erro ao remover anÃºncio",
      };
    }
  }
}
