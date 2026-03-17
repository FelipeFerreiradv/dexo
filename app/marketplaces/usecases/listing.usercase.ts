import { Platform } from "@prisma/client";
import { MLApiService } from "../services/ml-api.service";
import { MLOAuthService } from "../services/ml-oauth.service";
import { ShopeeApiService } from "../services/shopee-api.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { SystemLogService } from "../../services/system-log.service";
import { ListingRepository } from "../repositories/listing.repository";
import CategoryRepository from "../repositories/category.repository";
import { MLItemCreatePayload } from "../types/ml-api.types";
import { ShopeeItemCreatePayload } from "../types/shopee-api.types";
import { ProductRepositoryPrisma } from "../../repositories/product.repository";
import {
  ML_CATEGORY_OPTIONS,
  mapSuggestedCategory,
  suggestCategoryFromTitle,
} from "../../lib/product-parser";
import { AccountStatus } from "@prisma/client";
import { UserRepositoryPrisma } from "../../repositories/user.repository";

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
  ): Promise<CreateListingResult> {
    switch (platform) {
      case Platform.MERCADO_LIVRE:
        return this.createMLListing(userId, productId, categoryId, accountId);
      case Platform.SHOPEE:
        return this.createShopeeListing(userId, productId, categoryId, accountId);
      default:
        return {
          success: false,
          error: `Plataforma ${platform} nÃ£o suportada`,
        };
    }
  }
  private static mapQualityToMLCondition(
    quality?: string,
  ): "new" | "used" {
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
   * Heurística leve para corrigir textos com mojibake (Ã©/Ã§) mantendo UTF-8.
   */
  private static normalizeUtf8(text?: string): string {
    if (!text) return "";
    const str = text.toString();
    if (str.includes("Ã")) {
      try {
        return Buffer.from(str, "latin1").toString("utf8").trim();
      } catch {
        /* ignore */
      }
    }
    return Buffer.from(str, "utf8").toString("utf8").trim();
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
    const width = clamp(
      input.widthCm,
      this.ML_MIN_DIM_CM,
      this.ML_MAX_DIM_CM,
    );
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
      const pos =
        /dianteir|frente/.test(name)
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
    hintedSource?: "product" | "user_default",
  ): { text: string; source: "product" | "user_default" | "fallback" } {
    if (product.description) {
      return {
        text: this.normalizeUtf8(product.description),
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
    if (product.version) details.push(`Versão: ${this.normalizeUtf8(product.version)}`);
    if (product.partNumber)
      details.push(`Número da Peça: ${this.normalizeUtf8(product.partNumber)}`);
    if (product.quality) details.push(`Qualidade: ${this.normalizeUtf8(product.quality)}`);
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

    return { text: parts.join("\n\n").trim(), source: "fallback" };
  }

  /**
   * family_name só deve ser enviado se for explicitamente necessário.
   */
  private static shouldIncludeFamilyName(categoryId?: string): boolean {
    const forceEnv =
      process.env.ML_FORCE_FAMILY_NAME?.toLowerCase() === "true";

    // Permite sobrescrever/estender via env (lista separada por vírgula)
    const extra = (process.env.ML_FAMILY_NAME_ALLOWLIST || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const allowList = new Set<string>([
      // Domínios com fluxo User Product (catálogo) que exigem family_name
      "MLB193419", // Cubo de roda
      "MLB101763", // Portas (carroceria e lataria)
      "MLB458642", // Portas (categoria alternativa usada via override)
      ...extra,
    ]);

    return forceEnv || (categoryId ? allowList.has(categoryId) : false);
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
      ...envList,
    ]);
    return categoryId ? hard.has(categoryId) : false;
  }

  private static categoryOverride(categoryId?: string): string | undefined {
    // formato: MLBA:MLBB,MLC:MLD
    const env = process.env.ML_CATEGORY_OVERRIDE || "";
    const map = new Map<string, string>();
    env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((pair) => {
        const [from, to] = pair.split(":").map((s) => s.trim());
        if (from && to) map.set(from, to);
      });
    return categoryId && map.has(categoryId) ? map.get(categoryId) : undefined;
  }

  static async createMLListing(
    userId: string,
    productId: string,
    categoryId?: string,
    accountId?: string,
  ): Promise<CreateListingResult> {
    try {
      let account = accountId
        ? await MarketplaceRepository.findByIdAndUser(accountId, userId)
        : await MarketplaceRepository.findFirstActiveByUserAndPlatform(
            userId,
            Platform.MERCADO_LIVRE,
          );

      // Se múltiplas contas ativas e accountId não foi informado, exigir escolha explícita
      if (!account && !accountId) {
        const allActive = await MarketplaceRepository.findAllByUserIdAndPlatform(
          userId,
          Platform.MERCADO_LIVRE,
        );
        const active = (allActive || []).filter(
          (acc) => acc.status === AccountStatus.ACTIVE,
        );
        if (active.length > 1) {
          return {
            success: false,
            error:
              "Selecione a conta do Mercado Livre para criar o anúncio (multi-contas ativas detectadas).",
          };
        }
        account = active[0];
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
          await MarketplaceRepository.updateStatus(
            acc.id,
            AccountStatus.ERROR,
          );
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
              recheckErr instanceof Error ? recheckErr.message : String(recheckErr)
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

      // Garantir descrição: se o produto não tiver, usar a descrição padrão do usuário (quando disponível)
      if (!product.description && product.userId) {
        try {
          const owner =
            await ListingUseCase.userRepository.findById(product.userId);
          if (owner?.defaultProductDescription) {
            product.description = owner.defaultProductDescription;
            descriptionSource = "user_default";
          }
        } catch (descErr) {
          console.warn(
            "[ListingUseCase] Falha ao carregar descrição padrão do usuário:",
            descErr instanceof Error ? descErr.message : String(descErr),
          );
        }
      }

      // Resolve categoryId: explicit param -> override map -> DB mapping -> product link -> heuristics -> ML discovery
      let resolvedCategoryId: string | undefined;
      if (categoryId) {
        // Distinguish between a likely external ML id (alphanumeric only) and internal ML_CATALOG ids (contain hyphen or other chars).
        const looksLikeExternalId = /^[A-Za-z0-9]+$/.test(categoryId);

        if (looksLikeExternalId) {
          let fromDb = null;
          try {
            fromDb = await CategoryRepository.findByExternalId(categoryId);
          } catch (e) {
            fromDb = null;
          }
          if (fromDb) {
            resolvedCategoryId = categoryId;
          } else {
            console.warn(
              `[ListingUseCase] Provided external-like categoryId='${categoryId}' not found in DB; will attempt resolution/fallback`,
            );
            // Accept explicit external ids even when not yet synced locally to avoid blocking publication
            resolvedCategoryId = categoryId;
          }
        } else {
          // Treat categoryId as internal ML_CATALOG id and resolve it via ML_CATEGORY_OPTIONS -> DB fullPath lookup / on-demand sync
          const child = ML_CATEGORY_OPTIONS.find((c) => c.id === categoryId);
          const fullPathCandidate = child?.value || categoryId;
          let found = null;
          try {
            found = await CategoryRepository.findByFullPath(fullPathCandidate);
          } catch (e) {
            found = null;
          }

          if (!found) {
            try {
              const { SyncUseCase } = await import("./sync.usercase");
              await SyncUseCase.syncMLCategories(userId, "MLB");
              found = await CategoryRepository.findByFullPath(fullPathCandidate);
            } catch (syncErr) {
              const msg =
                syncErr instanceof Error ? syncErr.message : String(syncErr);
              console.warn(
                "[ListingUseCase] on-demand ML category sync failed:",
                msg,
              );
            }
          }

          if (found && /^[A-Za-z0-9]+$/.test(found.externalId || "")) {
            resolvedCategoryId = found.externalId;
          } else {
            console.warn(
              `[ListingUseCase] DB mapping for '${fullPathCandidate}' invalid or missing externalId; will keep resolving`,
            );
          }
        }
      }

      // 2.1 Se o produto já estiver vinculado a uma categoria do ML no banco, reutilizar
        if (!resolvedCategoryId && (product as any).mlCategoryId) {
        try {
          const linked = await CategoryRepository.findById(
            (product as any).mlCategoryId,
          );
          if (
            linked?.externalId &&
            /^[A-Za-z0-9]+$/.test(linked.externalId || "")
          ) {
            resolvedCategoryId = linked.externalId;
          }
        } catch (e) {
          console.warn(
            "[ListingUseCase] Falha ao resolver mlCategoryId salvo no produto:",
            e instanceof Error ? e.message : String(e),
          );
        }
      }

      // 2.2 Tentar deduzir categoria pelo título/categoria textual do produto
      if (!resolvedCategoryId) {
        const candidateFromProduct =
          product.category && product.category.includes(">")
            ? product.category
            : undefined;
        const titleForGuess = [
          product.name,
          product.brand,
          product.model,
          product.partNumber,
        ]
          .filter(Boolean)
          .join(" ");

        const suggested = suggestCategoryFromTitle(titleForGuess);
        const mapped = suggested
          ? mapSuggestedCategory(suggested)
          : undefined;
        const fullPathGuess =
          mapped?.detailedValue ||
          candidateFromProduct ||
          mapped?.topLevel ||
          undefined;

        if (fullPathGuess) {
          let foundByGuess = null;
          try {
            foundByGuess = await CategoryRepository.findByFullPath(fullPathGuess);
          } catch {
            foundByGuess = null;
          }
          if (
            foundByGuess?.externalId &&
            /^[A-Za-z0-9]+$/.test(foundByGuess.externalId || "")
          ) {
            resolvedCategoryId = foundByGuess.externalId;
          }
        }
      }

      // 2.3 Último recurso controlado: pedir ao ML para sugerir categoria pelo título
      if (!resolvedCategoryId) {
        const query = [
          product.name,
          product.brand,
          product.model,
          product.partNumber,
        ]
          .filter(Boolean)
          .join(" ");
        const suggestedByML = await MLApiService.suggestCategoryId(
          "MLB",
          query,
        );
        if (suggestedByML) {
          resolvedCategoryId = suggestedByML;
        }
      }

      // Não insista em publicar com categoria indefinida ou não suportada
      if (!resolvedCategoryId) {
        return {
          success: false,
          error:
            "Não foi possível inferir uma categoria válida do Mercado Livre para este produto. Selecione uma categoria antes de publicar.",
        };
      }

      // Aplicar override de categoria (permite sair de domínio UP para domínio alternativo).
      const originalCategoryId = resolvedCategoryId;
      const overridden = this.categoryOverride(resolvedCategoryId);
      if (overridden) {
        console.warn(
          `[ListingUseCase] category ${resolvedCategoryId} override configured -> ${overridden}`,
        );
        resolvedCategoryId = overridden;
      }

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
          descriptionSource === "user_default" ? "user_default" : descriptionSource,
        );
      descriptionSource = derivedDescriptionSource;

      const attributes = this.buildMLAttributes(product, resolvedCategoryId);
      const includeFamilyFromResolved =
        this.shouldIncludeFamilyName(resolvedCategoryId);
      const includeFamilyFromOriginal =
        this.shouldIncludeFamilyName(originalCategoryId);
      let includeFamilyName = includeFamilyFromResolved || includeFamilyFromOriginal;
      const noTitleWithFamily =
        this.noTitleWithFamilyName(resolvedCategoryId) ||
        this.noTitleWithFamilyName(originalCategoryId);

      const payload: MLItemCreatePayload = {
        title: this.buildMLTitle(product),
        category_id: resolvedCategoryId, // Categoria obrigatória e validada
        price: product.price, // Usar preço real do produto
        currency_id: currencyId,
        available_quantity: Math.min(product.stock, 999999), // ML limita quantidade máxima
        buying_mode: "buy_it_now",
        listing_type_id: "bronze", // Usar bronze que pode não exigir pictures
        condition: this.mapQualityToMLCondition(product.quality) || "new",
        pictures: [
          {
            // ML precisa conseguir baixar a imagem; se vier com host localhost, substituímos pelo ngrok/back-end público
            source: (() => {
              const backendBase =
                process.env.APP_BACKEND_URL || "http://localhost:3333";
              if (!product.imageUrl) {
                return "https://via.placeholder.com/500x500.png?text=Produto";
              }
              if (product.imageUrl.startsWith("http")) {
                return product.imageUrl.replace(
                  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i,
                  backendBase,
                );
              }
              return `${backendBase}${product.imageUrl}`;
            })(),
          },
        ],
        attributes,
        seller_custom_field: product.sku,
        description: {
          plain_text: descriptionText,
        },
      };

      if (includeFamilyName) {
        payload.family_name = product.brand || product.name;
      }

      const attrSnapshot = {
        brand: attributes.find((a) => a.id === "BRAND")?.value_name,
        model: attributes.find((a) => a.id === "MODEL")?.value_name,
        year: attributes.find((a) => a.id === "YEAR")?.value_name,
      };
      const fallbackNonUPCategory =
        process.env.ML_FALLBACK_NON_UP_CATEGORY || "";
      console.log("[ListingUseCase] ML payload summary", {
        productId: product.id,
        productName: product.name,
        finalTitle: payload.title,
        descriptionSource,
        family_name_sent: includeFamilyName,
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

      // Include shipping dimensions quando completo (ML exige string "HxWxL,weight") — clamp para limites aceitos
      const pkg = this.sanitizePackageDimensions({
        heightCm: product.heightCm,
        widthCm: product.widthCm,
        lengthCm: product.lengthCm,
        weightKg: product.weightKg,
      });

      if (pkg) {
        const dims = `${pkg.height}x${pkg.width}x${pkg.length},${Number(
          pkg.weightKg,
        )}`;
        payload.shipping = { dimensions: dims };

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
      try {
        mlItem = await MLApiService.createItem(acc.accessToken, payload);
        console.log(
          `[ListingUseCase] ML response:`,
          JSON.stringify(mlItem, null, 2),
        );
      } catch (err: any) {
        // capture raw mlError object attached by MLApiService
        const parsedMl =
          err && (err as any).mlError ? (err as any).mlError : null;
        const errMsg = err instanceof Error ? err.message : String(err);

        // Fallback imediato: se o erro citar title/invalid_fields, tentar variante segura
        let isTitleInvalid =
          errMsg.toLowerCase().includes("invalid_fields") &&
          errMsg.toLowerCase().includes("title");

        const missingFamilyName =
          errMsg.toLowerCase().includes("family_name") ||
          JSON.stringify(parsedMl || "")
            .toLowerCase()
            .includes("family_name");

        if (!mlItem && missingFamilyName && !includeFamilyName) {
          try {
            console.warn(
              `[ListingUseCase] ML solicitou family_name; retentando mantendo título informado`,
            );
            const withFamily: MLItemCreatePayload = {
              ...payload,
              family_name: product.brand || product.name,
            };
            mlItem = await MLApiService.createItem(acc.accessToken, withFamily);

            // Passe a considerar a categoria como exigindo family_name para os próximos tratamentos
            includeFamilyName = includeFamilyName || !!withFamily.family_name;
          } catch (famErr) {
            const famMsg = famErr instanceof Error ? famErr.message : String(famErr);
            console.warn("[ListingUseCase] Retentativa com family_name falhou:", famMsg);
            if (
              !isTitleInvalid &&
              famMsg.toLowerCase().includes("invalid_fields") &&
              famMsg.toLowerCase().includes("title")
            ) {
              isTitleInvalid = true;
            }
          }
        }

        // Se o ML rejeitar title, primeiro tente remover family_name (mantendo o título).
        if (!mlItem && isTitleInvalid && includeFamilyName && !noTitleWithFamily) {
          try {
            console.warn(
              "[ListingUseCase] Retentando createItem mantendo título e removendo family_name",
            );
            const noFamilyPayload: MLItemCreatePayload = { ...payload };
            delete (noFamilyPayload as any).family_name;
            mlItem = await MLApiService.createItem(acc.accessToken, noFamilyPayload);
          } catch (noFamilyErr) {
            console.warn(
              "[ListingUseCase] Retentativa sem family_name falhou:",
              noFamilyErr instanceof Error ? noFamilyErr.message : String(noFamilyErr),
            );
          }
        }

        // Para categorias que realmente não aceitam title com family_name, tentar sem title.
        if (
          !mlItem &&
          isTitleInvalid &&
          (includeFamilyName || missingFamilyName) &&
          noTitleWithFamily
        ) {
          try {
            console.warn(
              "[ListingUseCase] Retentando createItem sem title (UP domain requer family_name)",
            );
            const noTitlePayload: MLItemCreatePayload = {
              ...payload,
              family_name: (payload as any).family_name || product.brand || product.name,
            } as any;
            delete (noTitlePayload as any).title;
            mlItem = await MLApiService.createItem(acc.accessToken, noTitlePayload);
          } catch (noTitleErr) {
            console.warn(
              "[ListingUseCase] Retentativa sem title falhou:",
              noTitleErr instanceof Error ? noTitleErr.message : String(noTitleErr),
            );
          }
        }

        if (!mlItem && isTitleInvalid && !includeFamilyName) {
          // Tentar um título ultra-sanitizado
          try {
            const safeTitle = this.buildSafeFallbackTitle(product);
            console.warn(
              `[ListingUseCase] Retentando createItem com tÃ­tulo seguro: \"${safeTitle}\"`,
            );
            const retryPayload: MLItemCreatePayload = {
              ...payload,
              title: safeTitle,
            };
            // Evitar acionar o fluxo de User Product quando não for obrigatório
            if (!this.shouldIncludeFamilyName(resolvedCategoryId)) {
              delete (retryPayload as any).family_name;
            }
            mlItem = await MLApiService.createItem(acc.accessToken, retryPayload);
          } catch (retryTitleErr) {
            console.warn(
              "[ListingUseCase] Retentativa com tÃ­tulo seguro falhou:",
              retryTitleErr instanceof Error
                ? retryTitleErr.message
                : String(retryTitleErr),
            );
          }
        }

        // Se ainda não conseguiu e o erro envolver family_name/title, recuar para categoria não-UP e título original
        const isFamilyOrTitleBlock =
          !mlItem &&
          fallbackNonUPCategory &&
          (missingFamilyName || isTitleInvalid) &&
          resolvedCategoryId !== fallbackNonUPCategory;
        if (isFamilyOrTitleBlock) {
          try {
            const altPayload: MLItemCreatePayload = {
              ...payload,
              category_id: fallbackNonUPCategory,
              title: payload.title,
            };
            // manter family_name se já exigido para não cair em required_fields
            if (includeFamilyName || missingFamilyName) {
              altPayload.family_name =
                (payload as any).family_name || product.brand || product.name;
            } else {
              delete (altPayload as any).family_name;
            }
            console.warn(
              `[ListingUseCase] Retentando em categoria não-UP ${fallbackNonUPCategory} sem family_name para preservar título`,
            );
            mlItem = await MLApiService.createItem(acc.accessToken, altPayload);
            resolvedCategoryId = fallbackNonUPCategory;
          } catch (altErr) {
            console.warn(
              "[ListingUseCase] Retentativa em categoria não-UP falhou:",
              altErr instanceof Error ? altErr.message : String(altErr),
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
            await SystemLogService.logError(
              "CREATE_LISTING",
              humanMsg,
              {
                userId,
                resource: "MarketplaceAccount",
                resourceId: acc.id,
                details: { mlError: parsedMl || errMsg },
              },
            );
          } catch (logErr) {
            console.error("[ListingUseCase] failed to log PolicyAgent block:", logErr);
          }

          // Marcar conta como ERROR para forÃ§ar reconexÃ£o e desabilitar retries automÃ¡ticos
          try {
            await MarketplaceRepository.updateStatus(acc.id, AccountStatus.ERROR);
          } catch (stErr) {
            console.warn("[ListingUseCase] failed to mark account as ERROR:", stErr);
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
                mlItem = await MLApiService.createItem(
                  acc.accessToken,
                  payload,
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
        await MLApiService.upsertDescription(
          acc.accessToken,
          mlItem.id,
          descriptionText,
        );
        console.log("[ListingUseCase] ML item description updated via /description");
      } catch (err) {
        console.error(
          "[ListingUseCase] Failed to update ML item description:",
          err,
        );
      }

      // 4.2 Verificar status real no ML e tentar reativar se possível
      let remoteStatus: "active" | "paused" | "closed" | "under_review" = "active";
      let remoteSubStatus: string[] | undefined;
      try {
        const details = await MLApiService.getItemDetails(acc.accessToken, mlItem.id);
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
              const reactivated = await MLApiService.updateItem(acc.accessToken, mlItem.id, {
                status: "active",
              });
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
    try {
      let account = accountId
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
          error: "Conta do Shopee nÃ£o conectada ou sem credenciais vÃ¡lidas",
        };
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

      // 3. Preparar payload para criaÃ§Ã£o do anÃºncio
      const payload: ShopeeItemCreatePayload = {
        category_id: categoryId ? parseInt(categoryId) : 100644, // Usar categoria fornecida ou padrÃ£o
        item_name: this.buildShopeeTitle(product),
        description: this.buildShopeeDescription(product),
        item_sku: product.sku,
        price: product.price,
        stock: Math.min(product.stock, 999999), // Shopee limita quantidade mÃ¡xima
        weight: 1.0, // Peso padrÃ£o em kg
        package_length: 10,
        package_width: 10,
        package_height: 10,
        image: {
          image_url_list: [
            product.imageUrl
              ? product.imageUrl.startsWith("http")
                ? product.imageUrl
                : `${process.env.APP_BACKEND_URL || "http://localhost:3333"}${product.imageUrl}`
              : "https://via.placeholder.com/500x500.png?text=Produto",
          ],
        },
        attribute_list: [
          {
            attribute_id: 100001, // Marca
            attribute_name: "Marca",
            attribute_value_list: [
              {
                value_id: 0,
                value_name: product.brand || "GenÃ©rica",
                value_unit: "",
              },
            ],
          },
          {
            attribute_id: 100002, // Modelo
            attribute_name: "Modelo",
            attribute_value_list: [
              {
                value_id: 0,
                value_name: product.model || product.name,
                value_unit: "",
              },
            ],
          },
        ],
        logistic_info: [], // LogÃ­stica serÃ¡ configurada separadamente
      };

      // 4. Criar anÃºncio no Shopee
      console.log(
        `[ListingUseCase] Creating Shopee listing for product ${productId} (${product.name})`,
      );
      console.log(
        `[ListingUseCase] Payload being sent:`,
        JSON.stringify(payload, null, 2),
      );
      const shopeeItem = await ShopeeApiService.createItem(
        account.accessToken,
        account.shopId,
        payload,
      );
      console.log(
        `[ListingUseCase] Shopee response:`,
        JSON.stringify(shopeeItem, null, 2),
      );

      // 5. Criar vÃ­nculo local (ProductListing)
      const listing = await ListingRepository.createListing({
        productId,
        marketplaceAccountId: account.id,
        externalListingId: shopeeItem.item_id.toString(),
        externalSku: product.sku,
        permalink: `https://shopee.com.br/product/${shopeeItem.item_id}`,
        status: "active",
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
      console.error("[ListingUseCase] Error creating Shopee listing:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Erro desconhecido",
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

      // Buscar conta para obter access token
      const account = await MarketplaceRepository.findById(
        listing.marketplaceAccountId,
      );
      if (!account || !account.accessToken) {
        return { success: false, error: "Conta sem credenciais vÃ¡lidas" };
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
        // Mesmo que nÃ£o consiga fechar, continua removendo o vÃ­nculo local
        // O anÃºncio ficarÃ¡ visÃ­vel no ML mas nÃ£o estarÃ¡ mais vinculado ao produto
        // Isso pode acontecer com itens que tÃªm infraÃ§Ãµes ou estÃ£o em processamento
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

































