import { Platform } from "@prisma/client";
import { MLApiService } from "../services/ml-api.service";
import { MLOAuthService } from "../services/ml-oauth.service";
import { ShopeeApiService } from "../services/shopee-api.service";
import { ShopeeOAuthService } from "../services/shopee-oauth.service";
import { MagaluApiService } from "../services/magalu-api.service";
import { MagaluOAuthService } from "../services/magalu-oauth.service";
import { MagaluPayloadBuilderService } from "../services/magalu-payload-builder.service";
import { MagaluCategoryResolutionService } from "../services/magalu-category-resolution.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { SystemLogService } from "../../services/system-log.service";
import { ListingRepository } from "../repositories/listing.repository";
import { MLItemCreatePayload } from "../types/ml-api.types";
import { ShopeeItemCreatePayload } from "../types/shopee-api.types";
import { ProductRepositoryPrisma } from "../../repositories/product.repository";
import { CategoryResolutionService } from "../services/category-resolution.service";
import CategoryRepository from "../repositories/category.repository";
import { AccountStatus } from "@prisma/client";
import { UserRepositoryPrisma } from "../../repositories/user.repository";
import { ensureMLMinImageSize } from "../services/image-resize.service";
import { ListingPreflightService } from "../services/listing-preflight.service";
import {
  pickActionableMLError,
  type MLCause,
} from "../services/ml-error-message.service";
import {
  classifyMLRemoveError,
  classifyShopeeRemoveError,
  withRetry,
} from "../services/listing-removal.helpers";
import { findCorrectMLAccount } from "../services/listing-ownership-repair.service";
import { ShopeeAttributeCatalogService } from "../services/shopee-attribute-catalog.service";

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
  listingType?: string; // "bronze" (Grátis) | "gold_special" (Clássico) | "gold_premium" (Premium)
  hasWarranty?: boolean;
  warrantyUnit?: string; // "dias" | "meses"
  warrantyDuration?: number;
  itemCondition?: string; // "new" | "used"
  shippingMode?: string; // "me2" | "me1" | "custom" | "not_specified"
  freeShipping?: boolean;
  localPickup?: boolean;
  manufacturingTime?: number; // dias de disponibilidade
}

/**
 * Input completo para edição de UM anúncio específico, isolado das outras
 * contas. Estende MLListingSettings com os campos override do produto que
 * passam a viver no ProductListing (titleOverride, priceOverride, etc.).
 *
 * Convenção de tristate:
 *  - undefined = "não tocar este campo"
 *  - null = "remover override (volta a herdar do produto)"
 *  - valor = "aplicar este valor como override"
 */
export interface ListingFullEditInput extends MLListingSettings {
  titleOverride?: string | null;
  descriptionOverride?: string | null;
  priceOverride?: number | null;
  brandOverride?: string | null;
  modelOverride?: string | null;
  yearOverride?: string | null;
  versionOverride?: string | null;
  categoryOverride?: string | null;
  mlCategoryOverride?: string | null;
  shopeeCategoryOverride?: string | null;
  partNumberOverride?: string | null;
  qualityOverride?: string | null;
  heightCmOverride?: number | null;
  widthCmOverride?: number | null;
  lengthCmOverride?: number | null;
  weightKgOverride?: number | null;
  imageUrlsOverride?: string[] | null;
  attributesOverride?: Record<
    string,
    { value_id?: string; value_name?: string }
  > | null;
  compatibilitiesOverride?: Array<{
    brand?: string;
    model?: string;
    yearFrom?: number | null;
    yearTo?: number | null;
    version?: string | null;
  }> | null;
  sourceVehicleOverride?: string | null;
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

  // Limites de quantidade de imagens por marketplace (Shopee: 9, ML: 12)
  private static readonly SHOPEE_MAX_IMAGES = 9;
  private static readonly ML_MAX_IMAGES = 12;

  // Sinonimos de "valor neutro" (não aplicável / outros / genérico) em
  // pt-BR e en. Usados quando precisamos escolher um valor para um atributo
  // mandatory sem dados do produto — preferimos o neutro.
  private static readonly SHOPEE_NEUTRAL_VALUE_SYNONYMS = new Set([
    "outros", "outro", "other", "others",
    "não aplicável", "nao aplicavel", "n/a", "na",
    "nenhum", "nenhuma", "none", "sem",
    "genérica", "generica", "genérico", "generico", "generic",
    "indefinido", "indefinida", "não informado", "nao informado",
  ]);

  /**
   * Escolhe um valor "seguro" para um atributo Shopee MANDATORY quando nao
   * temos dado do produto pra preencher.
   *
   * Prioridade (evita disparar atributos-filho obrigatorios que nao
   * conseguimos preencher — ex: "Connection Type=Wireless" exige
   * Registration ID / Manufacturer / Model Name):
   *   1. sinonimo neutro ("Outros"/"Others"/"N/A"...) SEM filhos obrigatorios
   *   2. qualquer valor SEM filhos obrigatorios
   *   3. sinonimo neutro (mesmo com filhos — raro)
   *   4. primeiro valor (fallback final, comportamento legado)
   *
   * has_mandatory_children pode ser undefined em schemas cacheados antes do
   * adapter passar a computa-lo — nesse caso `!== true` trata como "sem
   * filhos" (degrada pra preferencia por sinonimo, sem regressao).
   */
  public static pickSafeMandatoryShopeeValue(
    values: Array<{
      value_id: number;
      value_name: string;
      has_mandatory_children?: boolean;
    }>,
  ): { value_id: number; value_name: string } {
    const isNeutral = (name: string) =>
      ListingUseCase.SHOPEE_NEUTRAL_VALUE_SYNONYMS.has(
        (name || "").trim().toLowerCase(),
      );
    const childless = values.filter((v) => v.has_mandatory_children !== true);

    const neutralChildless = childless.find((v) => isNeutral(v.value_name));
    if (neutralChildless) return neutralChildless;
    if (childless.length > 0) return childless[0];

    const neutral = values.find((v) => isNeutral(v.value_name));
    if (neutral) return neutral;

    return values[0];
  }

  /**
   * Harvest cross-account: extrai attribute_list de algum listing Shopee
   * ATIVO em qualquer conta da plataforma na mesma categoria. Útil quando
   * a conta atual recebe 403 em get_attributes mas outra conta (ou a mesma
   * em momento anterior) tem item ativo de onde o schema é legível via
   * get_item_base_info. Tenta até 5 candidatos; primeiro sucesso ganha.
   * Retorna null se nada disponível.
   */
  public static async harvestShopeeAttrsFromAnyAccount(
    categoryId: number,
  ): Promise<any[] | null> {
    try {
      const prismaMod = await import("../../lib/prisma");
      const prisma = prismaMod.default;
      const samples = (await (prisma as any).productListing.findMany({
        where: {
          status: "active",
          NOT: { externalListingId: { startsWith: "PENDING_" } },
          marketplaceAccount: {
            platform: "SHOPEE",
            status: "ACTIVE",
          },
          product: { shopeeCategoryId: String(categoryId) },
        },
        select: {
          externalListingId: true,
          marketplaceAccount: {
            select: {
              id: true,
              accessToken: true,
              shopId: true,
            },
          },
        },
        take: 5,
      })) as Array<{
        externalListingId: string;
        marketplaceAccount: {
          id: string;
          accessToken: string;
          shopId: number;
        };
      }>;

      if (samples.length === 0) {
        // Caso muito comum: primeira publicação em uma categoria.
        // Logar pra observabilidade — usuário precisa saber que harvest não
        // tinha candidatos (vs. ter tentado e falhado).
        console.log(
          JSON.stringify({
            event: "shopee.category_attrs.harvest_no_candidates",
            categoryId,
            reason: "no_active_shopee_listing_in_category",
          }),
        );
      }

      for (const sample of samples) {
        const itemId = Number(sample.externalListingId);
        if (!Number.isFinite(itemId) || itemId <= 0) continue;
        const acct = sample.marketplaceAccount;
        if (!acct?.accessToken || !acct?.shopId) continue;
        try {
          const item = await ShopeeApiService.getItemBaseInfo(
            acct.accessToken,
            acct.shopId,
            itemId,
          );
          if (
            item?.attribute_list &&
            Array.isArray(item.attribute_list) &&
            item.attribute_list.length > 0
          ) {
            console.log(
              JSON.stringify({
                event: "shopee.category_attrs.harvested",
                categoryId,
                fromAccountId: acct.id,
                fromItemId: itemId,
                attrCount: item.attribute_list.length,
              }),
            );
            return item.attribute_list;
          }
        } catch (err) {
          console.warn(
            JSON.stringify({
              event: "shopee.category_attrs.harvest_attempt_failed",
              categoryId,
              fromAccountId: acct.id,
              fromItemId: itemId,
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "shopee.category_attrs.harvest_query_failed",
          categoryId,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return null;
  }

  /**
   * Coleta a galeria completa de imagens de um produto preservando ordem.
   * Usa `imageUrls` (lista) quando disponível; cai para `imageUrl` (único)
   * como fallback. Dedupe preservando ordem.
   */
  private static collectProductImageUrls(product: {
    imageUrls?: string[] | null;
    imageUrl?: string | null;
  }): string[] {
    const collected: string[] = [];
    const list = Array.isArray(product.imageUrls) ? product.imageUrls : [];
    for (const url of list) {
      if (typeof url === "string" && url.trim().length > 0) {
        collected.push(url.trim());
      }
    }
    if (
      collected.length === 0 &&
      typeof product.imageUrl === "string" &&
      product.imageUrl.trim().length > 0
    ) {
      collected.push(product.imageUrl.trim());
    }
    return Array.from(new Set(collected));
  }

  /**
   * Formata a lista de compatibilidades do produto como linhas legíveis
   * ("MARCA MODELO ANO ... VERSÃO"). Usado para enriquecer a descrição dos
   * anúncios (ML e Shopee) — garante que o comprador veja os veículos
   * compatíveis mesmo sem chamadas a endpoints proprietários de compat.
   */
  private static formatCompatibilityLines(product: {
    compatibilities?: Array<{
      brand: string;
      model: string;
      yearFrom?: number | null;
      yearTo?: number | null;
      version?: string | null;
    }> | null;
  }): string[] {
    const list = Array.isArray(product.compatibilities)
      ? product.compatibilities
      : [];
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const compat of list) {
      if (!compat) continue;
      const brand = (compat.brand || "").trim();
      const model = (compat.model || "").trim();
      if (!brand || !model) continue;
      const yFrom =
        typeof compat.yearFrom === "number" && compat.yearFrom > 0
          ? compat.yearFrom
          : null;
      const yTo =
        typeof compat.yearTo === "number" && compat.yearTo > 0
          ? compat.yearTo
          : null;
      let yearPart = "";
      if (yFrom && yTo && yFrom !== yTo) yearPart = `${yFrom}-${yTo}`;
      else if (yFrom && yTo && yFrom === yTo) yearPart = `${yFrom}`;
      else if (yFrom) yearPart = `${yFrom}+`;
      else if (yTo) yearPart = `até ${yTo}`;
      const versionPart =
        typeof compat.version === "string" && compat.version.trim().length > 0
          ? compat.version.trim()
          : "";
      const parts = [brand.toUpperCase(), model, yearPart, versionPart]
        .filter((p) => p && p.length > 0)
        .join(" ");
      const key = parts.toLowerCase();
      if (parts && !seen.has(key)) {
        seen.add(key);
        lines.push(parts);
      }
    }
    return lines;
  }

  /**
   * Converte uma URL relativa (ex.: "/uploads/foo.jpg") em URL absoluta usando
   * APP_BACKEND_URL. URLs já absolutas são retornadas sem alteração.
   */
  private static toAbsoluteImageUrl(rawUrl: string): string {
    const backendUrl = (
      process.env.APP_BACKEND_URL || "http://localhost:3333"
    ).replace(/\/+$/, "");
    if (rawUrl.startsWith("http")) return rawUrl;
    const path = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
    return `${backendUrl}${path}`;
  }

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
      case Platform.MAGALU:
        return this.createMagaluListing(
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
        // ML não aceita not_specified em MLB. Sem signal explícito de
        // qualidade nem de itemCondition, assumir "new" — é o default seguro
        // que preserva a intenção comum quando o usuário não preencheu nada.
        // Quem vende usado/sucata explicita via `quality` ou
        // `mlSettings.itemCondition` no modal — ambos sobrescrevem este
        // fallback. Antes este default era "used" e mascarava silenciosamente
        // a escolha do usuário, virando "usado" no anúncio publicado.
        return "new";
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
   * Sanitiza dimensões/peso para o ML. Aplica mínimos (arredonda e garante >= 1cm)
   * mas NÃO faz clamp de máximo — envia as dimensões reais para o ML.
   * Retorna null se faltar alguma dimensão obrigatória.
   * O campo `oversized` indica quando as dimensões excedem limites seguros do
   * Mercado Envios, para que o chamador possa decidir se bloqueia ou avisa.
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

    const height = Math.max(Math.round(input.heightCm), this.ML_MIN_DIM_CM);
    const width = Math.max(Math.round(input.widthCm), this.ML_MIN_DIM_CM);
    const length = Math.max(Math.round(input.lengthCm), this.ML_MIN_DIM_CM);

    const weightKgRaw = Number(input.weightKg);
    if (!Number.isFinite(weightKgRaw)) return null;
    const weightKg = Math.max(weightKgRaw, this.ML_MIN_WEIGHT_KG);

    const maxSide = Math.max(height, width, length);
    const dimSum = height + width + length;
    const oversized =
      maxSide > this.ML_MAX_DIM_CM || weightKg > this.ML_MAX_WEIGHT_KG;

    return { height, width, length, weightKg, oversized };
  }

  /**
   * Constrói atributos estruturados sem sobrescrever com inferências fracas.
   *
   * Após os atributos fixos (BRAND, MODEL, YEAR, POSITION, SELLER_SKU,
   * PART_NUMBER), faz merge com `product.attributes` — o mapa preenchido
   * pela UI dinâmica de ficha técnica secundária (oficial, vinda de
   * GET /categories/{id}/attributes). Ids já incluídos pelos campos
   * fixos NÃO são sobrescritos para preservar a higiene atual de marca/
   * modelo/ano e a integração com `setItemCompatibilities`.
   */
  private static buildMLAttributes(product: any, resolvedCategoryId?: string) {
    const attrs: Array<{ id: string; value_id?: string; value_name?: string }> =
      [];
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

    // Ficha técnica secundária — preenchida no modal a partir de
    // GET /categories/{id}/attributes. Mapa { [id]: { value_id?, value_name? } }.
    const seen = new Set(attrs.map((a) => a.id));
    const extras = product.attributes;
    if (extras && typeof extras === "object" && !Array.isArray(extras)) {
      for (const [id, raw] of Object.entries(
        extras as Record<string, unknown>,
      )) {
        if (!id || seen.has(id)) continue;
        if (!raw || typeof raw !== "object") continue;
        const v = raw as { value_id?: string; value_name?: string };
        const valueId =
          typeof v.value_id === "string" && v.value_id.trim().length > 0
            ? v.value_id.trim()
            : undefined;
        const valueName =
          typeof v.value_name === "string" && v.value_name.trim().length > 0
            ? v.value_name.trim()
            : undefined;
        if (!valueId && !valueName) continue;
        const entry: { id: string; value_id?: string; value_name?: string } = {
          id,
        };
        if (valueId) entry.value_id = valueId;
        if (valueName) entry.value_name = valueName;
        attrs.push(entry);
        seen.add(id);
      }
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

    const compatLines = this.formatCompatibilityLines(product);
    const compatBlock =
      compatLines.length > 0
        ? `\n\nCompatível com:\n- ${compatLines
            .map((l) => this.normalizeUtf8(l))
            .join("\n- ")}`
        : "";

    if (product.description) {
      const base = this.normalizeUtf8(product.description);
      const alreadyHasCompat = /compat[ií]vel com/i.test(base);
      const text = alreadyHasCompat ? base : `${base}${compatBlock}`;
      return {
        text: clamp(text),
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

    if (compatLines.length > 0) {
      parts.push("Compatível com:");
      parts.push(compatLines.map((l) => `- ${this.normalizeUtf8(l)}`).join("\n"));
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

  /**
   * Reconstrói os campos do payload ML que dependem da categoria (attributes,
   * family_name, title / no-title) para uma nova categoria. Preserva todos os
   * demais campos já montados (pictures, shipping, sale_terms, condition, etc).
   * Usado em retries após sugestão de categoria via domain_discovery.
   */
  private static rebuildMLPayloadForCategory(
    basePayload: MLItemCreatePayload,
    product: any,
    newCategoryId: string,
  ): MLItemCreatePayload {
    const normalized =
      this.normalizeMLCategoryId(newCategoryId) || newCategoryId;

    const newAttributes = this.buildMLAttributes(product, normalized);
    // Preservar atributos que não dependem da categoria (SELLER_PACKAGE_*, etc)
    // mas foram adicionados dinamicamente no payload original após buildMLAttributes.
    const baseAttrIds = new Set(newAttributes.map((a) => a.id));
    const extraAttrs = (basePayload.attributes || []).filter(
      (a) => !baseAttrIds.has(a.id) && a.id.startsWith("SELLER_PACKAGE_"),
    );

    const includeFamilyName = this.shouldIncludeFamilyName(normalized);
    const noTitleFlow = this.noTitleWithFamilyName(normalized);
    const familyNameValue = this.buildMLTitle(product);
    const titleValue =
      (basePayload as any).title || this.buildMLTitle(product);

    const rebuilt: MLItemCreatePayload = {
      ...basePayload,
      category_id: normalized,
      attributes: [...newAttributes, ...extraAttrs],
    };

    // title / family_name conforme a NOVA categoria
    if (includeFamilyName) {
      (rebuilt as any).family_name = familyNameValue;
      if (noTitleFlow) {
        delete (rebuilt as any).title;
      } else {
        (rebuilt as any).title = titleValue;
      }
    } else {
      delete (rebuilt as any).family_name;
      (rebuilt as any).title = titleValue;
    }

    return rebuilt;
  }

  static async createMLListing(
    userId: string,
    productId: string,
    categoryId?: string,
    accountId?: string,
    mlSettings?: MLListingSettings,
    /**
     * Sobrescreve o título do ML para esta criação específica sem persistir
     * no `product.name` do banco. Usado pelo fluxo de republicação (sync e
     * edit unitário) para criar o novo anúncio com o título desejado quando
     * o ML não permite alterar `family_name` de items UP existentes.
     */
    titleOverride?: string,
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
          const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
            acc.id,
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

      // 1.5. Guard anti-duplicata: se o produto JÁ tem um anúncio vivo nesta
      // conta, criar outro publica um anúncio DUPLICADO no ML (que penaliza
      // duplicatas) — e, no sucesso, o update final sobrescreveria o
      // externalListingId de uma linha cujo item continua vivo lá, deixando-o
      // órfão (publicado no ML, sem linha no banco). A base tem milhares de
      // pares (produto, conta) com mais de uma linha (o autodetect cria uma
      // por anúncio), então isso acontece de verdade — foi flagrado pelo
      // piloto de reabilitação do retry. `closed` não bloqueia: recriar um
      // anúncio encerrado é o fluxo legítimo de republicação (o
      // republishUpListing troca a linha por placeholder ANTES de chamar
      // aqui, então também não se auto-bloqueia).
      const liveListing = await ListingRepository.findLiveByProductAndAccount(
        productId,
        acc.id,
      );
      if (liveListing) {
        const liveDesc = liveListing.status === "paused" ? "pausado" : "ativo";
        // Se existe um placeholder de retry para este par, ele NUNCA vai
        // conseguir criar — o motivo terminal verdadeiro é este. Marca para o
        // cron parar de gastar tentativas com uma recusa determinística.
        try {
          const placeholder = await ListingRepository.findByProductAndAccount(
            productId,
            acc.id,
          );
          if (
            placeholder &&
            placeholder.externalListingId?.startsWith("PENDING_") &&
            placeholder.retryEnabled
          ) {
            await ListingRepository.updateListing(placeholder.id, {
              status: "error",
              lastError: `[TERMINAL] Produto já tem anúncio ${liveDesc} nesta conta (${liveListing.externalListingId}) — exclua este pendente ou encerre o anúncio existente antes de recriar`,
              retryEnabled: false,
              nextRetryAt: null,
            });
          }
        } catch (markErr) {
          console.warn(
            "[ListingUseCase] falha ao marcar placeholder duplicado como terminal:",
            markErr instanceof Error ? markErr.message : markErr,
          );
        }
        console.warn(
          JSON.stringify({
            event: "ml.create_item.duplicate_refused",
            productId,
            accountId: acc.id,
            liveExternalListingId: liveListing.externalListingId,
            liveStatus: liveListing.status,
          }),
        );
        return {
          success: false,
          skipped: true,
          listingId: liveListing.id,
          externalListingId: liveListing.externalListingId,
          error: `Produto já tem anúncio ${liveDesc} nesta conta (${liveListing.externalListingId}). Encerre o anúncio existente antes de criar outro.`,
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

      // Override do title (cirúrgico): substitui apenas em memória para esta
      // execução; não persiste no banco. Usado pela republicação UP para
      // criar o novo anúncio com o título alterado sem mutar o `product.name`.
      if (titleOverride && titleOverride.trim()) {
        (product as { name: string }).name = titleOverride.trim();
      }

      // Validar prÃ©-requisitos do produto antes de enviar ao ML (ex.: imagem obrigatÃ³ria)
      if (!product.imageUrl) {
        return {
          success: false,
          error:
            "Produto precisa ter imagem para criar anÃºncio no Mercado Livre",
        };
      }

      // Dimensões obrigatórias: o ML usa para frete e bloqueia anúncios sem medidas confiáveis.
      // Não enviamos mais fallback artificial (10x10x10/1kg) porque o ML detecta o padrão e suspende.
      if (
        product.heightCm == null ||
        product.widthCm == null ||
        product.lengthCm == null ||
        product.weightKg == null
      ) {
        return {
          success: false,
          error:
            "Produto precisa ter altura, largura, comprimento e peso preenchidos para criar anúncio no Mercado Livre",
        };
      }

      // Estoque e preço são exigidos pelo ML (item.stock.invalid / item.price.invalid).
      // Valida antes de montar payload — evita gastar uma chamada ao ML e um ciclo
      // inteiro de retries do ListingRetryService para falhar no mesmo motivo.
      if (typeof product.stock !== "number" || product.stock <= 0) {
        return {
          success: false,
          error:
            "Produto precisa ter estoque maior que zero para criar anúncio no Mercado Livre",
        };
      }
      if (typeof product.price !== "number" || product.price <= 0) {
        return {
          success: false,
          error:
            "Produto precisa ter preço maior que zero para criar anúncio no Mercado Livre",
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

      // Se não veio categoryId explícito e o produto não tem categoria persistida,
      // pedir sugestão ao ML via domain_discovery a partir do nome do produto.
      // Isso evita bloquear a publicação quando o form do modal não envia mlCategory.
      let effectiveCategoryId = categoryId;
      if (!effectiveCategoryId && !(product as any).mlCategoryId) {
        try {
          const suggested = await MLApiService.suggestCategoryId(
            "MLB",
            product.name || "",
          );
          if (suggested) {
            console.warn(
              `[ListingUseCase] Nenhuma categoria informada; usando sugestão domain_discovery: ${suggested} (produto=${product.id})`,
            );
            // Sugestão é usada apenas para a tentativa atual. Nunca persistimos
            // categoria sugerida em product.mlCategoryId sem confirmação do usuário
            // (fluxo consciente via PUT /products) — evita corrupção silenciosa
            // quando o domain_discovery devolve algo fora do nicho.
            effectiveCategoryId = suggested;
          }
        } catch (suggErr) {
          console.warn(
            "[ListingUseCase] Falha ao sugerir categoria via domain_discovery:",
            suggErr instanceof Error ? suggErr.message : String(suggErr),
          );
        }
      }

      // Resolve categoryId determinístico: explícito -> categoria persistida -> erro
      const resolvedCategory =
        await CategoryResolutionService.resolveMLCategory({
          explicitCategoryId: effectiveCategoryId,
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

      // ─── Pré-flight: barreira de domínio (nicho de autopeças) ─────────────
      // Para produtos com sinais fortes de veículo (brand+model+year), a
      // categoria resolvida DEVE estar sob a raiz de Veículos (MLB1747).
      // Isto bloqueia casos como "Mangueira Servo Freio Ka" com categoria
      // residual "Bebidas > Gin" vinda de corrupção de dados anterior.
      const isVehicularProduct = !!(
        product.brand &&
        product.model &&
        product.year
      );
      const effectiveConditionForPreflight: string =
        effectiveSettings.itemCondition ||
        ListingUseCase.mapQualityToMLCondition(product.quality) ||
        "new";

      let guardWithinVehicleRoot: boolean | "unknown" = "unknown";
      let guardConditionAllowed: boolean | "unknown" = "unknown";

      if (isVehicularProduct) {
        const domainCheck =
          await CategoryResolutionService.assertWithinVehicleRoot(
            categoryIdForML,
          );
        if (!domainCheck.ok && domainCheck.reason === "outside_root") {
          guardWithinVehicleRoot = false;
          console.warn(
            `[ListingUseCase] category trace BLOCKED outside_root`,
            {
              productId: product.id,
              productPersisted: (product as any).mlCategoryId,
              requestedByClient: categoryId,
              resolved: categoryIdForML,
              source: resolvedCategory.source,
              fullPath: resolvedCategory.fullPath,
              withinVehicleRoot: false,
            },
          );
          return {
            success: false,
            error: `Categoria '${resolvedCategory.fullPath || categoryIdForML}' está fora do nicho de autopeças. Edite o produto e escolha uma categoria sob 'Acessórios para Veículos'.`,
          };
        }
        guardWithinVehicleRoot =
          domainCheck.reason === "not_in_tree" ? "unknown" : true;
        if (domainCheck.reason === "not_in_tree") {
          console.warn(
            `[ListingUseCase] category.root.unknown — categoria ${categoryIdForML} não está na árvore local sincronizada; pulando guarda de domínio`,
          );
        }
      }

      // ─── Pré-flight: coerência condition × category ──────────────────────
      // Previne chamadas ao ML API quando sabemos que a categoria não aceita
      // a `condition` do produto (ex: categoria só aceita [new] mas produto
      // é usado). Fail-open em caso de erro de rede ou metadados ausentes.
      const condCheck =
        await CategoryResolutionService.assertConditionCoherent(
          categoryIdForML,
          effectiveConditionForPreflight,
        );
      // Rastreia se a condição veio EXPLICITAMENTE do modal (mlSettings) vs.
      // de derivação automática (product.quality). Override silencioso só é
      // aceitável no segundo caso — quando o usuário não escolheu, derivamos.
      // Mas se ele escolheu "novo" e categoria só aceita "usado", BLOQUEAR
      // com erro claro em vez de publicar como "usado" sem avisar.
      const userExplicitlyChoseCondition = !!mlSettings?.itemCondition;
      let conditionForPayload: string = effectiveConditionForPreflight;
      if (!condCheck.ok && condCheck.reason === "incompatible") {
        const allowed = condCheck.allowedConditions || [];
        if (userExplicitlyChoseCondition) {
          // Escolha explícita do operador. Bloquear em vez de overriding
          // silencioso — o usuário precisa decidir: ajustar categoria, ou
          // ajustar a condição.
          guardConditionAllowed = false;
          console.warn(
            `[ListingUseCase] category trace BLOCKED user_choice_vs_category`,
            {
              productId: product.id,
              resolved: categoryIdForML,
              fullPath: resolvedCategory.fullPath,
              userChose: effectiveConditionForPreflight,
              allowedConditions: allowed,
            },
          );
          return {
            success: false,
            error: `Você escolheu publicar como '${effectiveConditionForPreflight}', mas a categoria '${resolvedCategory.fullPath || categoryIdForML}' aceita apenas ${JSON.stringify(allowed)}. Escolha outra categoria ou ajuste a condição do item no modal.`,
          };
        }
        // Categorias de autopeça frequentemente têm leaves com uma única
        // condição permitida (ex: Servo Freio → ["new"]). Quando o usuário
        // NÃO escolheu explicitamente (derivamos de product.quality ou
        // default), em vez de bloquear, publicamos com a única condição
        // aceita — comportamento esperado para catálogos ML onde não há
        // variante "used" da sub-categoria.
        if (allowed.length === 1) {
          console.warn(`[ListingUseCase] category trace OVERRIDE condition`, {
            productId: product.id,
            productPersisted: (product as any).mlCategoryId,
            resolved: categoryIdForML,
            fullPath: resolvedCategory.fullPath,
            productCondition: effectiveConditionForPreflight,
            overrideTo: allowed[0],
            reason: "derived_from_quality_not_user_choice",
          });
          conditionForPayload = allowed[0];
          guardConditionAllowed = true;
        } else {
          guardConditionAllowed = false;
          console.warn(`[ListingUseCase] category trace BLOCKED condition`, {
            productId: product.id,
            productPersisted: (product as any).mlCategoryId,
            requestedByClient: categoryId,
            resolved: categoryIdForML,
            source: resolvedCategory.source,
            fullPath: resolvedCategory.fullPath,
            condition: effectiveConditionForPreflight,
            allowedConditions: allowed,
          });
          return {
            success: false,
            error: `Categoria '${resolvedCategory.fullPath || categoryIdForML}' aceita apenas ${JSON.stringify(allowed)} e o produto está marcado como '${effectiveConditionForPreflight}'. Escolha outra categoria ou ajuste a qualidade do produto.`,
          };
        }
      } else {
        guardConditionAllowed =
          condCheck.reason === "unknown" ? "unknown" : true;
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

      let attributes = this.buildMLAttributes(product, resolvedCategoryId);

      // ─── Pré-flight: atributos obrigatórios da categoria ─────────────────
      // Busca required attributes do catálogo ML (cache 24h) e verifica se
      // todos estão preenchidos no payload. Auto-preenche a partir de campos
      // do produto quando possível (PART_NUMBER←partNumber, etc). Bloqueia
      // cedo com erro acionável se faltar algo crítico. Fail-open: se o
      // catálogo estiver indisponível, segue o fluxo legado sem bloquear.
      const preflight = await ListingPreflightService.checkML({
        product: product as any,
        categoryId: categoryIdForML,
        currentAttributes: attributes,
      });
      attributes = preflight.enrichedAttributes;
      if (!preflight.ok) {
        const preflightMode = (
          process.env.LISTING_PREFLIGHT || "warn"
        ).toLowerCase();
        console.warn(
          JSON.stringify({
            event: "listing.preflight.ml.blocked",
            mode: preflightMode,
            productId: product.id,
            categoryId: categoryIdForML,
            missingRequired: preflight.missingRequired,
            issueCodes: preflight.issues.map((i) => i.code),
          }),
        );
        if (preflightMode === "strict") {
          return {
            success: false,
            error: ListingPreflightService.formatBlockMessage(preflight),
          };
        }
        // Modo warn (default): loga divergência mas prossegue. A API do ML
        // é a fonte de verdade final — se ela aceitar, a blocklist do
        // preflight estava errada e precisa ser ajustada.
      }

      // Usar APENAS a categoria resolvida (leaf real do ML) para decidir family_name.
      // Nunca usar originalCategoryId pois pode ser ID sintético do catálogo estático.
      // Patch (bulk import 2026-05-09): se o produto tem `attributes.familyName`
      // explícito (preenchido pelo enrichment), force include para qualquer
      // categoria — sinaliza que o operador já enriqueceu os dados.
      const productAttrs =
        (product.attributes as Record<string, unknown> | null) ?? {};
      const explicitFamilyName =
        typeof productAttrs.familyName === "string" &&
        (productAttrs.familyName as string).trim().length > 0
          ? (productAttrs.familyName as string).trim()
          : null;
      let includeFamilyName =
        this.shouldIncludeFamilyName(resolvedCategoryId) ||
        explicitFamilyName !== null;
      // family_name: prefere o explícito do produto (enrichment) sobre o
      // derivado do nome. Em ambos os casos, fica disponível para o retry interno.
      const familyNameValue = explicitFamilyName ?? this.buildMLTitle(product);
      const noTitleWithFamily = this.noTitleWithFamilyName(resolvedCategoryId);
      const forceNoTitleFlow = includeFamilyName && noTitleWithFamily;

      // Upload da imagem diretamente para o ML (mais confiável do que source URL)
      let picturesArray: MLItemCreatePayload["pictures"];
      // Coletar todas as URLs de imagens (imageUrls se disponível, ou apenas imageUrl)
      const allImageUrls = ListingUseCase.collectProductImageUrls(
        product,
      ).slice(0, ListingUseCase.ML_MAX_IMAGES);

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

          // Upload paralelo ao ML preservando ordem. O endpoint /pictures aceita
          // uploads concorrentes; 5 imagens em paralelo reduz o tempo em ~5x sem
          // encostar em rate-limit (limite prático é dezenas/min por conta).
          const uploadedPictures = await Promise.all(
            bufferResults.map(async (result, i) => {
              const rawUrl = allImageUrls[i];
              const fallbackUrl = rawUrl.startsWith("http")
                ? rawUrl.replace(
                    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i,
                    backendBase,
                  )
                : `${backendBase}${rawUrl}`;

              if (result.status !== "fulfilled") {
                console.warn(
                  `[ListingUseCase] Falha ao preparar imagem ${rawUrl}:`,
                  result.reason instanceof Error
                    ? result.reason.message
                    : String(result.reason),
                );
                try {
                  const picResult = await MLApiService.uploadPictureFromUrl(
                    acc.accessToken,
                    fallbackUrl,
                  );
                  return { id: picResult.id } as { id: string };
                } catch {
                  return { source: fallbackUrl } as { source: string };
                }
              }

              const {
                imageBuffer: imgBuf,
                fileName: imgName,
                publicUrl,
              } = result.value;

              const processedBuf = await ensureMLMinImageSize(imgBuf);

              try {
                const picResult = await MLApiService.uploadPicture(
                  acc.accessToken,
                  processedBuf,
                  imgName,
                );
                return { id: picResult.id } as { id: string };
              } catch (uploadErr) {
                console.warn(
                  `[ListingUseCase] Upload binário falhou para ${rawUrl}:`,
                  uploadErr instanceof Error
                    ? uploadErr.message
                    : String(uploadErr),
                );
              }

              try {
                const picResult = await MLApiService.uploadPictureFromUrl(
                  acc.accessToken,
                  publicUrl,
                );
                return { id: picResult.id } as { id: string };
              } catch (urlUploadErr) {
                console.warn(
                  `[ListingUseCase] Upload via URL também falhou para ${rawUrl}:`,
                  urlUploadErr instanceof Error
                    ? urlUploadErr.message
                    : String(urlUploadErr),
                );
              }

              return { source: publicUrl } as { source: string };
            }),
          );
          picturesArray = uploadedPictures;

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

      // Normaliza listing_type_id: o ML Brasil aceita `gold_pro` para Premium;
      // `gold_premium` é alias legado que sofre downgrade silencioso em fluxos
      // UP/family_name. Ver `MLApiService.normalizeListingType` para detalhes.
      const requestedListingType = effectiveSettings.listingType || "bronze";
      const normalizedListingType = MLApiService.normalizeListingType(
        requestedListingType,
      );
      if (normalizedListingType !== requestedListingType) {
        console.warn(
          `[ListingUseCase] listing_type normalizado: ${requestedListingType} → ${normalizedListingType} (alias MLB)`,
        );
      }

      const payload: MLItemCreatePayload = {
        title: this.buildMLTitle(product),
        category_id: categoryIdForML,
        price: product.price,
        currency_id: currencyId,
        available_quantity: Math.min(product.stock, 999999),
        buying_mode: "buy_it_now",
        listing_type_id: normalizedListingType,
        condition: conditionForPayload,
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
      console.log("[ListingUseCase] category trace", {
        productId: product.id,
        requestedByClient: categoryId,
        productPersisted: (product as any).mlCategoryId,
        resolved: categoryIdForML,
        source: resolvedCategory.source,
        fullPath: resolvedCategory.fullPath,
        condition: payload.condition,
        withinVehicleRoot: guardWithinVehicleRoot,
        conditionAllowed: guardConditionAllowed,
        isVehicularProduct,
      });

      // 3.1 Criar (ou reutilizar) placeholder local antes de chamar o ML
      // Isso garante que o usuÃ¡rio veja o anÃºncio pendente mesmo que a API do ML falhe.
      let listing = await ListingRepository.findByProductAndAccount(
        productId,
        acc.id,
      );

      if (!listing) {
        // retryEnabled=false: o fluxo primário é responsável pelo próprio
        // sucesso/erro. Só o catch habilita retry explicitamente se a
        // chamada falhar. Evita race com ListingRetryService.runOnce
        // rodando em paralelo ao fluxo de criação.
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
          retryEnabled: false,
          requestedCategoryId: payload.category_id || null,
          listingType: effectiveSettings.listingType ?? null,
          itemCondition: effectiveSettings.itemCondition ?? null,
          hasWarranty: effectiveSettings.hasWarranty ?? null,
          warrantyUnit: effectiveSettings.warrantyUnit ?? null,
          warrantyDuration: effectiveSettings.warrantyDuration ?? null,
          shippingMode: effectiveSettings.shippingMode ?? null,
          freeShipping: effectiveSettings.freeShipping ?? null,
          localPickup: effectiveSettings.localPickup ?? null,
          manufacturingTime: effectiveSettings.manufacturingTime ?? null,
        });
      } else {
        await ListingRepository.updateListing(listing.id, {
          listingType: effectiveSettings.listingType ?? null,
          itemCondition: effectiveSettings.itemCondition ?? null,
          hasWarranty: effectiveSettings.hasWarranty ?? null,
          warrantyUnit: effectiveSettings.warrantyUnit ?? null,
          warrantyDuration: effectiveSettings.warrantyDuration ?? null,
          shippingMode: effectiveSettings.shippingMode ?? null,
          freeShipping: effectiveSettings.freeShipping ?? null,
          localPickup: effectiveSettings.localPickup ?? null,
          manufacturingTime: effectiveSettings.manufacturingTime ?? null,
        });
      }

      // Include shipping dimensions (ML exige string "HxWxL,weight") — clamp para limites aceitos.
      // Dimensões obrigatórias já validadas no início de createMLListing.
      const pkg = this.sanitizePackageDimensions({
        heightCm: product.heightCm!,
        widthCm: product.widthCm!,
        lengthCm: product.lengthCm!,
        weightKg: Number(product.weightKg),
      });

      // Shipping settings (mode/free_shipping/local_pick_up) são aplicadas
      // sempre, independente de ter dimensões — frete grátis e retirada local
      // precisam chegar ao ML mesmo quando o produto não tem pacote mensurável.
      // Dimensões são adicionadas apenas quando pkg resolve.
      payload.shipping = {
        mode: effectiveSettings.shippingMode || undefined,
        free_shipping: effectiveSettings.freeShipping || false,
        local_pick_up: effectiveSettings.localPickup || false,
      };

      if (pkg) {
        const dims = `${pkg.height}x${pkg.width}x${pkg.length},${Number(
          pkg.weightKg,
        )}`;
        payload.shipping.dimensions = dims;

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

        // Avisar se dimensões foram normalizadas (arredondamento/mínimo)
        if (
          product.heightCm !== pkg.height ||
          product.widthCm !== pkg.width ||
          product.lengthCm !== pkg.length ||
          (product.weightKg != null &&
            Math.round(product.weightKg * 100) !==
              Math.round(pkg.weightKg * 100))
        ) {
          console.warn(
            `[ListingUseCase] Package dimensions normalized: ` +
              `H:${pkg.height} W:${pkg.width} L:${pkg.length}cm Wt:${pkg.weightKg}kg (original: ` +
              `${product.heightCm}x${product.widthCm}x${product.lengthCm},${product.weightKg}kg)`,
          );
        }

        if (pkg.oversized) {
          console.error(
            `[ListingUseCase] ATENÇÃO: Produto "${product.name}" (${productId}) com dimensões que excedem ` +
              `limites ML (máx ${this.ML_MAX_DIM_CM}cm/lado, ${this.ML_MAX_WEIGHT_KG}kg). ` +
              `Enviando dimensões reais: ${pkg.height}x${pkg.width}x${pkg.length}cm, ${pkg.weightKg}kg. ` +
              `O ML poderá rejeitar a publicação.`,
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

      // --- Tentativa de publicação via catalog listing (opt-in por flag) ---
      // Quando o produto tem `mlCatalogProductId` (vindo da sugestão de catálogo
      // no modal) e ML_CATALOG_LISTING_ENABLED=true, tentamos primeiro publicar
      // como catalog listing: payload reduzido com `catalog_product_id` +
      // `catalog_listing: true`. Se o ML rejeitar, logamos e caímos no shape
      // tradicional sem interromper o fluxo — o try/catch abaixo permanece
      // intocado e só faz sua chamada se `mlItem` ainda não estiver populado.
      const catalogProductIdForListing = (
        (product as any).mlCatalogProductId || ""
      ).trim();
      const catalogListingEnabled =
        process.env.ML_CATALOG_LISTING_ENABLED === "true";
      if (catalogListingEnabled && catalogProductIdForListing) {
        const catalogPayload: MLItemCreatePayload = {
          category_id: categoryIdForML,
          catalog_product_id: catalogProductIdForListing,
          catalog_listing: true,
          price: payload.price,
          currency_id: payload.currency_id,
          available_quantity: payload.available_quantity,
          buying_mode: payload.buying_mode,
          listing_type_id: payload.listing_type_id,
          condition: payload.condition,
          pictures: payload.pictures,
          ...(payload.seller_custom_field
            ? { seller_custom_field: payload.seller_custom_field }
            : {}),
          ...(payload.sale_terms ? { sale_terms: payload.sale_terms } : {}),
          ...(payload.shipping ? { shipping: payload.shipping } : {}),
        };
        try {
          mlItem = await this.withTimeout(
            MLApiService.createItem(acc.accessToken, catalogPayload),
            timeoutMs,
            "ML createItem catalog",
          );
          console.log(
            JSON.stringify({
              event: "ml.catalog_listing.succeeded",
              productId: product.id,
              catalogProductId: catalogProductIdForListing,
              mlItemId: mlItem?.id ?? null,
            }),
          );
        } catch (err) {
          console.warn(
            JSON.stringify({
              event: "ml.catalog_listing.fallback",
              productId: product.id,
              catalogProductId: catalogProductIdForListing,
              message: err instanceof Error ? err.message : String(err),
            }),
          );
          // mlItem continua undefined — fluxo tradicional abaixo assume.
        }
      }

      try {
        if (!mlItem) {
          mlItem = await this.withTimeout(
            MLApiService.createItem(acc.accessToken, payload),
            timeoutMs,
            "ML createItem",
          );
          console.log(
            `[ListingUseCase] ML response:`,
            JSON.stringify(mlItem, null, 2),
          );
        }
      } catch (err: any) {
        // capture raw mlError object attached by MLApiService
        const parsedMl =
          err && (err as any).mlError ? (err as any).mlError : null;
        const errMsg = err instanceof Error ? err.message : String(err);

        // Structured log — the axios-wrapped errMsg collapses cause[] into a
        // string, making title-rejection diagnostics impossible from logs. Emit
        // the parsed payload upfront so we can see ML's real complaint before
        // the retry ladder mutates the payload.
        console.warn(
          JSON.stringify({
            event: "ml.create_item.failed",
            productId: product.id,
            categoryId: categoryIdForML,
            status: parsedMl?.status || null,
            mlMessage: parsedMl?.message || null,
            mlError: parsedMl?.error || null,
            cause: Array.isArray(parsedMl?.cause) ? parsedMl.cause : [],
            hasFamilyName: !!(payload as any).family_name,
            titleLength: (payload.title || "").length,
          }),
        );

        // Causas de cada tentativa, em ordem cronológica. O ML valida o corpo
        // antes dos atributos, então a 1ª tentativa só reclama de family_name e
        // a causa REAL (ex.: PART_NUMBER ausente) só aparece nas retentativas.
        // Como a escada re-lança o erro original quando esgota, sem isso o
        // operador nunca vê o motivo que ele consegue corrigir.
        const attemptCauses: MLCause[][] = [
          Array.isArray(parsedMl?.cause) ? parsedMl.cause : [],
        ];
        const recordAttemptCause = (retryErr: any) => {
          const causes = retryErr?.mlError?.cause;
          if (Array.isArray(causes)) attemptCauses.push(causes);
        };

        const isCategoryInvalid = !!parsedMl?.cause?.some(
          (c: any) => c?.code === "item.category_id.invalid",
        );
        // ML retorna "item.condition.invalid" quando a categoria persistida é de
        // outra vertical (ex: Gin) e não aceita a condition escolhida. Isso é um
        // sinal forte de "categoria errada no produto" — acionamos domain_discovery
        // antes dos retries de título/family_name para evitar falsos positivos.
        const isConditionInvalid = !!parsedMl?.cause?.some(
          (c: any) => c?.code === "item.condition.invalid",
        );

        if (!mlItem && isConditionInvalid) {
          try {
            const siteId = (categoryIdForML || "MLB").slice(0, 3);
            const suggestedId = await MLApiService.suggestCategoryId(
              siteId,
              product.name || "",
            );
            if (suggestedId && suggestedId !== categoryIdForML) {
              console.warn(
                `[ListingUseCase] condition.invalid detectada; trocando categoria ${categoryIdForML} por sugestão domain_discovery ${suggestedId}`,
              );
              const leafRetry =
                await CategoryResolutionService.ensureLeafLocalOnly(
                  suggestedId,
                );
              const newCategoryId = leafRetry?.externalId || suggestedId;
              const normalizedNew =
                this.normalizeMLCategoryId(newCategoryId) || newCategoryId;

              const retryPayload = this.rebuildMLPayloadForCategory(
                payload,
                product,
                normalizedNew,
              );

              mlItem = await this.withTimeout(
                MLApiService.createItem(acc.accessToken, retryPayload),
                timeoutMs,
                "ML createItem condition retry",
              );

              if (mlItem) {
                resolvedCategoryId = normalizedNew;
                categoryIdForML = normalizedNew;
                // NÃO persistimos a categoria sugerida no produto. A correção
                // da categoria deve passar pelo fluxo consciente (PUT /products
                // com validação de domínio). Persistência cega aqui já corrompeu
                // produtos no passado (ex: mangueira → Gin).
              }
            }
          } catch (condErr) {
            console.warn(
              "[ListingUseCase] Retentativa após condition.invalid falhou:",
              condErr instanceof Error ? condErr.message : String(condErr),
            );
          }
        }

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
            // Categories that demand family_name are User Product (UP) flow and
            // reject title+family_name together. Drop title preemptively on the
            // first retry — evidence: MLB438074, MLB191833, MLB193531, MLB116479
            // all failed "body.invalid_fields [title]" when family_name was
            // present. This turns a 3-retry ladder into 1 retry.
            console.warn(
              `[ListingUseCase] ML solicitou family_name; retentando sem title (UP flow)`,
            );
            const withFamily: MLItemCreatePayload = {
              ...payload,
              family_name: familyNameValue || this.buildMLTitle(product),
            };
            delete (withFamily as any).title;

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
          } catch (famErr: any) {
            const famMsg =
              famErr instanceof Error ? famErr.message : String(famErr);
            const famMl = famErr?.mlError || null;
            recordAttemptCause(famErr);
            console.warn(
              JSON.stringify({
                event: "ml.create_item.retry_failed",
                step: "family_name",
                productId: product.id,
                categoryId: categoryIdForML,
                cause: Array.isArray(famMl?.cause) ? famMl.cause : [],
                mlMessage: famMl?.message || famMsg,
                mlError: famMl?.error || null,
              }),
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
          } catch (retryTitleErr: any) {
            const stMl = retryTitleErr?.mlError || null;
            recordAttemptCause(retryTitleErr);
            console.warn(
              JSON.stringify({
                event: "ml.create_item.retry_failed",
                step: "safe_title",
                productId: product.id,
                categoryId: categoryIdForML,
                cause: Array.isArray(stMl?.cause) ? stMl.cause : [],
                mlMessage:
                  stMl?.message ||
                  (retryTitleErr instanceof Error
                    ? retryTitleErr.message
                    : String(retryTitleErr)),
                mlError: stMl?.error || null,
              }),
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
          } catch (dynErr: any) {
            const dynMl = dynErr?.mlError || null;
            recordAttemptCause(dynErr);
            console.warn(
              JSON.stringify({
                event: "ml.create_item.retry_failed",
                step: "dynamic_no_title",
                productId: product.id,
                categoryId: categoryIdForML,
                cause: Array.isArray(dynMl?.cause) ? dynMl.cause : [],
                mlMessage:
                  dynMl?.message ||
                  (dynErr instanceof Error ? dynErr.message : String(dynErr)),
                mlError: dynMl?.error || null,
              }),
            );
          }
        }

        // Última tentativa: re-sugerir categoria via domain_discovery.
        // Caso o produto tenha uma categoria persistida incompatível (ex: condition.invalid
        // porque categoria só aceita "new", ou categoria de outra vertical), o ML nunca
        // aceitará o payload. Pedimos uma sugestão fresca a partir do título e retentamos
        // reconstruindo os campos do payload que dependem da categoria (attributes,
        // family_name, title/no-title).
        if (!mlItem) {
          try {
            const siteId = (categoryIdForML || "MLB").slice(0, 3);
            const suggestedId = await MLApiService.suggestCategoryId(
              siteId,
              product.name || "",
            );
            if (suggestedId && suggestedId !== categoryIdForML) {
              console.warn(
                `[ListingUseCase] Retentando createItem com categoria sugerida por domain_discovery: ${suggestedId} (anterior: ${categoryIdForML})`,
              );
              const leafRetry =
                await CategoryResolutionService.ensureLeafLocalOnly(
                  suggestedId,
                );
              const newCategoryId = leafRetry?.externalId || suggestedId;
              const normalizedNew =
                this.normalizeMLCategoryId(newCategoryId) || newCategoryId;

              const retryPayload = this.rebuildMLPayloadForCategory(
                payload,
                product,
                normalizedNew,
              );

              try {
                mlItem = await this.withTimeout(
                  MLApiService.createItem(acc.accessToken, retryPayload),
                  timeoutMs,
                  "ML createItem suggested category",
                );
              } catch (innerErr: any) {
                // Sugerida pode exigir family_name (fluxo User Product) mesmo
                // sem estar no allowList. Se o erro indicar isso, retentamos
                // adicionando family_name e removendo title.
                const innerMl =
                  innerErr && innerErr.mlError ? innerErr.mlError : null;
                recordAttemptCause(innerErr);
                const innerMsg = JSON.stringify(innerMl || innerErr?.message || "")
                  .toLowerCase();
                const innerNeedsFamily =
                  innerMsg.includes("family_name");
                if (innerNeedsFamily) {
                  const familyRetryPayload: MLItemCreatePayload = {
                    ...retryPayload,
                    family_name:
                      (retryPayload as any).family_name ||
                      this.buildMLTitle(product),
                  } as any;
                  delete (familyRetryPayload as any).title;
                  try {
                    mlItem = await this.withTimeout(
                      MLApiService.createItem(
                        acc.accessToken,
                        familyRetryPayload,
                      ),
                      timeoutMs,
                      "ML createItem suggested+family",
                    );
                  } catch (innerErr2: any) {
                    recordAttemptCause(innerErr2);
                    const inner2Msg = JSON.stringify(
                      (innerErr2 && innerErr2.mlError) || innerErr2?.message || "",
                    ).toLowerCase();
                    // Título rejeitado novamente → tentar apenas sem title
                    if (inner2Msg.includes("title")) {
                      const noTitleRetry: MLItemCreatePayload = {
                        ...retryPayload,
                        family_name:
                          (retryPayload as any).family_name ||
                          this.buildMLTitle(product),
                      } as any;
                      delete (noTitleRetry as any).title;
                      mlItem = await this.withTimeout(
                        MLApiService.createItem(
                          acc.accessToken,
                          noTitleRetry,
                        ),
                        timeoutMs,
                        "ML createItem suggested+noTitle",
                      );
                    } else {
                      throw innerErr2;
                    }
                  }
                } else {
                  throw innerErr;
                }
              }

              if (mlItem) {
                resolvedCategoryId = normalizedNew;
                categoryIdForML = normalizedNew;
                console.warn(
                  `[ListingUseCase] Retentativa com categoria sugerida ${normalizedNew} bem-sucedida`,
                );
                // NÃO persistimos automaticamente — ver comentário no retry
                // de condition.invalid. Correção de categoria é fluxo consciente.
              }
            }
          } catch (suggErr) {
            console.warn(
              "[ListingUseCase] Retentativa com categoria sugerida falhou:",
              suggErr instanceof Error ? suggErr.message : String(suggErr),
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
          // A escada esgotou. `err` é o erro da PRIMEIRA tentativa — em
          // categorias de catálogo isso é sempre `family_name`, que a escada
          // já resolveu e que o operador não tem como corrigir. A causa que
          // ele resolve (ex.: PART_NUMBER em branco) só aparece nas
          // retentativas. Reporta a mais acionável; sem nenhuma reconhecida,
          // mantém a mensagem de hoje.
          const actionable = pickActionableMLError(
            attemptCauses,
            categoryIdForML,
          );
          if (actionable) {
            console.warn(
              JSON.stringify({
                event: "ml.create_item.actionable_error",
                productId: product.id,
                categoryId: categoryIdForML,
                actionable,
                originalMessage: errMsg,
              }),
            );
          }

          // marcar placeholder com erro genÃ©rico para retry e exibir ao usuÃ¡rio
          const nextRetryMs = 60 * 1000;
          try {
            await ListingRepository.updateListing(listing.id, {
              status: "error",
              lastError: actionable || errMsg,
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

          if (actionable) {
            // Retorno (em vez de throw) para a mensagem chegar ao usuário sem
            // virar "Erro desconhecido" no catch externo. `mlError` preserva o
            // erro bruto do ML para diagnóstico.
            return {
              success: false,
              listingId: listing.id,
              error: actionable,
              mlError: errMsg,
            };
          }

          throw err;
        }
      }

      // 4.0. Reconciliação de listing_type_id — o ML pode aceitar o POST /items
      // mas devolver um tipo degradado (ex.: gold_pro → gold_special em
      // categorias com restrição ou contas sem direito a Premium). Sem essa
      // verificação, o usuário seleciona Premium e vê o anúncio publicado como
      // Clássica. POST /items/{id}/listing_type só permite upgrades, então é
      // seguro (no-op se já estiver no alvo; rejeita downgrades).
      const sentListingType = (payload as any).listing_type_id as
        | string
        | undefined;
      const returnedListingType = (mlItem as any)?.listing_type_id as
        | string
        | undefined;
      if (
        mlItem?.id &&
        sentListingType &&
        returnedListingType &&
        returnedListingType !== sentListingType
      ) {
        console.warn(
          JSON.stringify({
            event: "ml.listing_type.mismatch",
            productId: product.id,
            mlItemId: mlItem.id,
            categoryId: categoryIdForML,
            requested: sentListingType,
            returned: returnedListingType,
          }),
        );
        try {
          await this.withTimeout(
            MLApiService.changeListingType(
              acc.accessToken,
              mlItem.id,
              sentListingType,
            ),
            timeoutMs,
            "ML changeListingType reconcile",
          );
          (mlItem as any).listing_type_id = sentListingType;
          console.warn(
            `[ListingUseCase] listing_type promovido ${returnedListingType} → ${sentListingType} (item ${mlItem.id})`,
          );
        } catch (promoteErr) {
          console.error(
            JSON.stringify({
              event: "ml.listing_type.promote_failed",
              productId: product.id,
              mlItemId: mlItem.id,
              from: returnedListingType,
              to: sentListingType,
              error:
                promoteErr instanceof Error
                  ? promoteErr.message
                  : String(promoteErr),
            }),
          );
          // Não interrompe o fluxo: o item foi criado, descrição/compat seguem.
        }
      }

      // 4.1. Pós-criação: reforçar descrição via /description e, se necessário,
      // atualizar family_name. As duas chamadas são independentes, então rodam
      // em paralelo. family_name é pulado quando o ML já retornou um valor que
      // bate com o desejado — caso contrário o PUT falha com BODY_INVALID_FIELDS
      // em categorias User Product (family_name fica travado após criação).
      const desiredFamilyName = this.buildMLTitle(product);
      const mlReturnedFamilyName = ((mlItem as any)?.family_name || "")
        .toString()
        .trim();
      const familyNameAlreadyOk =
        !!mlReturnedFamilyName &&
        (mlReturnedFamilyName.toLowerCase() ===
          desiredFamilyName.toLowerCase() ||
          mlReturnedFamilyName
            .toLowerCase()
            .includes(desiredFamilyName.toLowerCase()));

      const mlReturnedTitle = (mlItem.title || "").trim();
      const titleMismatch =
        mlReturnedTitle.toLowerCase() !== desiredFamilyName.toLowerCase() &&
        !mlReturnedTitle
          .toLowerCase()
          .includes(desiredFamilyName.toLowerCase());

      const shouldUpdateFamilyName =
        !!mlItem?.id &&
        !!desiredFamilyName &&
        !familyNameAlreadyOk &&
        (titleMismatch ||
          includeFamilyName ||
          !!(payload as any).family_name);

      const descriptionPromise = this.withTimeout(
        MLApiService.upsertDescription(
          acc.accessToken,
          mlItem.id,
          descriptionText,
        ),
        timeoutMs,
        "ML upsertDescription",
      )
        .then(() => {
          console.log(
            "[ListingUseCase] ML item description updated via /description",
          );
        })
        .catch((err) => {
          console.error(
            "[ListingUseCase] Failed to update ML item description:",
            err,
          );
        });

      const familyNamePromise = shouldUpdateFamilyName
        ? this.withTimeout(
            MLApiService.updateItem(acc.accessToken, mlItem.id, {
              family_name: desiredFamilyName,
            }),
            timeoutMs,
            "ML updateItem family_name",
          )
            .then(() => {
              console.log(
                `[ListingUseCase] family_name updated to "${desiredFamilyName}" for ${mlItem.id}`,
              );
            })
            .catch((fnErr) => {
              console.warn(
                `[ListingUseCase] Failed to update family_name for ${mlItem.id}:`,
                fnErr instanceof Error ? fnErr.message : String(fnErr),
              );
            })
        : Promise.resolve();

      await Promise.all([descriptionPromise, familyNamePromise]);

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
          listingType: effectiveSettings.listingType ?? null,
          itemCondition: effectiveSettings.itemCondition ?? null,
          hasWarranty: effectiveSettings.hasWarranty ?? null,
          warrantyUnit: effectiveSettings.warrantyUnit ?? null,
          warrantyDuration: effectiveSettings.warrantyDuration ?? null,
          shippingMode: effectiveSettings.shippingMode ?? null,
          freeShipping: effectiveSettings.freeShipping ?? null,
          localPickup: effectiveSettings.localPickup ?? null,
          manufacturingTime: effectiveSettings.manufacturingTime ?? null,
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
          listingType: effectiveSettings.listingType ?? null,
          itemCondition: effectiveSettings.itemCondition ?? null,
          hasWarranty: effectiveSettings.hasWarranty ?? null,
          warrantyUnit: effectiveSettings.warrantyUnit ?? null,
          warrantyDuration: effectiveSettings.warrantyDuration ?? null,
          shippingMode: effectiveSettings.shippingMode ?? null,
          freeShipping: effectiveSettings.freeShipping ?? null,
          localPickup: effectiveSettings.localPickup ?? null,
          manufacturingTime: effectiveSettings.manufacturingTime ?? null,
        });
        finalListingId = created.id;
      }

      // 6. Anexar compatibilidades estruturadas (ficha técnica).
      // O endpoint /items/{id}/compatibilities exige catalog product IDs
      // (não aceita known_attributes). Resolvemos marca/modelo/ano textuais
      // via searchCatalogCompatibilityChunks e enviamos `products: [{id}]`.
      // Não-bloqueante: falhas só geram warning. A descrição já contém as
      // linhas formatadas via formatCompatibilityLines como fallback visual.
      try {
        const compatList = Array.isArray(product.compatibilities)
          ? product.compatibilities
          : [];
        const vehicles = compatList
          .filter((c): c is NonNullable<typeof c> => !!c)
          .map((c) => ({
            brand: c.brand,
            model: c.model,
            yearFrom: c.yearFrom ?? null,
            yearTo: c.yearTo ?? null,
          }));
        if (vehicles.length > 0) {
          const resolved =
            await MLApiService.resolveCompatibilityCatalogProducts(
              acc.accessToken,
              vehicles,
            );
          if (resolved.unresolved.length > 0) {
            console.warn(
              `[ListingUseCase] Compatibilidades não resolvidas (${mlItem.id}): ` +
                `${resolved.unresolved.length} entrada(s) — ${JSON.stringify(
                  resolved.unresolved.slice(0, 3),
                )}`,
            );
          }
          if (resolved.catalogProductIds.length > 0) {
            const compatResult = await MLApiService.setItemCompatibilities(
              acc.accessToken,
              mlItem.id,
              resolved.catalogProductIds,
            );
            if (compatResult.errors.length > 0) {
              console.warn(
                `[ListingUseCase] Compatibilidades parciais em ${mlItem.id}: ` +
                  `createdCount=${compatResult.createdCount} errors=${compatResult.errors.length} ` +
                  `firstError=${compatResult.errors[0]}`,
              );
            } else if (compatResult.createdCount > 0) {
              console.log(
                `[ListingUseCase] Compatibilidades anexadas ao ML item ${mlItem.id}: ` +
                  `${compatResult.createdCount} catalog product(s)`,
              );
            }
          }
          // Fallback por atributos crus: marcas como Chevrolet, Dodge, CAOA
          // Chery não aparecem no /catalog_domains (endpoint truncado) e a
          // busca por chunks retorna lixo genérico. O ML aceita compat via
          // `products: [{ attributes: [BRAND/MODEL/YEAR por nome] }]` — é o
          // caminho que o próprio dashboard deles usa para adicionar veículos
          // fora do catálogo restrito.
          if (resolved.unresolved.length > 0) {
            const unresolvedVehicles = vehicles.filter((v) => {
              const b = (v.brand || "").trim().toLowerCase();
              const m = (v.model || "").trim().toLowerCase();
              return resolved.unresolved.some(
                (u) =>
                  (u.brand || "").trim().toLowerCase() === b &&
                  (u.model || "").trim().toLowerCase() === m,
              );
            });
            if (unresolvedVehicles.length > 0) {
              const attrResult =
                await MLApiService.setItemCompatibilitiesByAttributes(
                  acc.accessToken,
                  mlItem.id,
                  unresolvedVehicles,
                );
              if (attrResult.errors.length > 0) {
                console.warn(
                  `[ListingUseCase] Compat por atributos parcial em ${mlItem.id}: ` +
                    `createdCount=${attrResult.createdCount} errors=${attrResult.errors.length} ` +
                    `firstError=${attrResult.errors[0]}`,
                );
              } else if (attrResult.createdCount > 0) {
                console.log(
                  `[ListingUseCase] Compat por atributos anexada ao ML item ${mlItem.id}: ` +
                    `${attrResult.createdCount} veículo(s)`,
                );
              }
            }
          }
        }
      } catch (compatErr) {
        console.warn(
          `[ListingUseCase] Falha ao anexar compatibilidades estruturadas em ${mlItem.id} (seguindo apenas com descrição):`,
          compatErr instanceof Error ? compatErr.message : String(compatErr),
        );
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
  // Shopee aceita descrição entre 10 e 5000 chars. Margem de 100 chars para
  // o sufixo de truncamento e variação de encoding.
  private static readonly SHOPEE_MAX_DESCRIPTION = 5000;
  private static readonly SHOPEE_DESC_SAFE_LIMIT = 4900;

  private static buildShopeeDescription(product: any): string {
    const parts: string[] = [];

    // Descrição principal
    if (product.description) {
      parts.push(product.description);
    }

    // Detalhes técnicos
    const details: string[] = [];
    if (product.brand) details.push(`Marca: ${product.brand}`);
    if (product.model) details.push(`Modelo: ${product.model}`);
    if (product.year) details.push(`Ano: ${product.year}`);
    if (product.version) details.push(`Versão: ${product.version}`);
    if (product.partNumber)
      details.push(`Número da Peça: ${product.partNumber}`);
    if (product.quality) details.push(`Qualidade: ${product.quality}`);
    if (product.location) details.push(`Localização: ${product.location}`);

    if (details.length > 0) {
      parts.push("Detalhes Técnicos:");
      parts.push(details.join("\n"));
    }

    // SKU primeiro para garantir que cabe mesmo se compat for truncada.
    const skuLine = `SKU: ${product.sku}`;

    // Compatibilidades — Shopee não tem campo dedicado. Vão na descrição.
    const compatLines = this.formatCompatibilityLines(product);
    const descriptionAlreadyHasCompat =
      typeof product.description === "string" &&
      /compat[ií]vel com/i.test(product.description);

    // Calcula orçamento para compat: tamanho atual (parts + sku) + duas seções
    // de compat (header "Compatível com:" + corpo). Se estourar, trunca a
    // lista por linhas (mantendo as N primeiras compatibilidades cabíveis).
    if (compatLines.length > 0 && !descriptionAlreadyHasCompat) {
      const baseLen = parts.join("\n\n").length;
      // "\n\n" + "Compatível com:" + "\n\n" + body + "\n\n" + sku
      const overheadCompat = 2 + "Compatível com:".length + 2;
      const overheadSku = 2 + skuLine.length;
      const budget =
        ListingUseCase.SHOPEE_DESC_SAFE_LIMIT -
        baseLen -
        overheadCompat -
        overheadSku;

      const fittedLines: string[] = [];
      let used = 0;
      for (const line of compatLines) {
        const formatted = `- ${line}`;
        const cost = (fittedLines.length === 0 ? 0 : 1) + formatted.length;
        if (used + cost > budget) break;
        fittedLines.push(formatted);
        used += cost;
      }

      if (fittedLines.length > 0) {
        parts.push("Compatível com:");
        const truncated = fittedLines.length < compatLines.length;
        const body = truncated
          ? `${fittedLines.join("\n")}\n- (+${compatLines.length - fittedLines.length} versões)`
          : fittedLines.join("\n");
        parts.push(body);
      }
    }

    parts.push(skuLine);

    let result = parts.join("\n\n");

    // Salvaguarda final: se algum dos campos individuais (e.g. descrição do
    // produto) já era enorme, trunca o todo preservando o sufixo SKU para
    // continuar minimamente útil.
    if (result.length > ListingUseCase.SHOPEE_MAX_DESCRIPTION) {
      const tail = `\n\n${skuLine}`;
      const head = result.slice(
        0,
        ListingUseCase.SHOPEE_MAX_DESCRIPTION - tail.length - 4,
      );
      result = `${head}…${tail}`;
    }

    return result;
  }

  /**
   * Cria um anÃºncio no Shopee para um produto
   * @param userId ID do usuÃ¡rio
   * @param productId ID do produto
   * @param categoryId ID da categoria do Shopee (opcional, serÃ¡ inferida se nÃ£o fornecida)
   */
  /**
   * Cria um anúncio (SKU no portfólio) na Magalu a partir de um Product.
   * Espelha a estrutura do createShopeeListing (resolução de conta + refresh +
   * validações), mas com o fluxo simples da Magalu: monta payload e POSTa o SKU.
   * SEM exigir EAN (peças de desmonte/sucata frequentemente não têm).
   */
  static async createMagaluListing(
    userId: string,
    productId: string,
    categoryId?: string,
    accountId?: string,
  ): Promise<CreateListingResult> {
    let account: any = null;
    let product: any = null;
    try {
      account = accountId
        ? await MarketplaceRepository.findByIdAndUser(accountId, userId)
        : await MarketplaceRepository.findFirstActiveByUserAndPlatform(
            userId,
            Platform.MAGALU,
          );

      if (!account && !accountId) {
        const all = await MarketplaceRepository.findAllByUserIdAndPlatform(
          userId,
          Platform.MAGALU,
        );
        const active = (all || []).filter(
          (acc) => acc.status === AccountStatus.ACTIVE,
        );
        if (active.length > 1) {
          return {
            success: false,
            error:
              "Selecione a conta Magalu para criar o anúncio (multi-contas ativas detectadas).",
          };
        }
        account = active[0];
      }

      if (!account || !account.accessToken) {
        return {
          success: false,
          error: "Conta da Magalu não conectada ou sem credenciais válidas",
        };
      }

      // Token refresh automático (mesmo padrão de ML/Shopee).
      if (account.expiresAt < new Date()) {
        try {
          const refreshed =
            await MagaluOAuthService.refreshAccessTokenForAccount(
              account.id,
              account.refreshToken,
            );
          const updated = await MarketplaceRepository.updateTokens(account.id, {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
          });
          if (updated) account = updated as any;
        } catch (refreshErr) {
          await MarketplaceRepository.updateStatus(
            account.id,
            AccountStatus.ERROR,
          );
          console.warn(
            `[ListingUseCase] Failed to refresh Magalu token for account ${account.id}:`,
            (refreshErr as any)?.message || refreshErr,
          );
          return {
            success: false,
            error:
              "Conta da Magalu expirou ou token inválido — reconecte a conta",
          };
        }
      }

      product = await ListingUseCase.productRepository.findById(productId);
      if (!product) {
        return { success: false, error: "Produto não encontrado" };
      }
      if (typeof product.stock !== "number" || product.stock <= 0) {
        return {
          success: false,
          error:
            "Produto precisa ter estoque maior que zero para criar anúncio na Magalu",
        };
      }
      if (typeof product.price !== "number" || product.price <= 0) {
        return {
          success: false,
          error:
            "Produto precisa ter preço maior que zero para criar anúncio na Magalu",
        };
      }
      // Imagem obrigatória (paridade com ML/Shopee): sem imagem a Magalu não
      // publica — previne um create fadado ao erro/DRAFT.
      if (ListingUseCase.collectProductImageUrls(product).length === 0) {
        return {
          success: false,
          error:
            "Produto precisa ter pelo menos uma imagem para criar anúncio na Magalu",
        };
      }

      // group.id é definido pelo SELLER (agrupa variações) — não é taxonomia.
      // Produto sem variação = seu próprio SKU como group (main_variation:true).
      // channels[].id é o canal de venda do seller (obrigatório, exatamente 1):
      // resolvido do produto, do env, senão do 1º canal do seller (/channels).
      const groupId = (product as any).magaluGroupId || product.sku;
      let channelId =
        (product as any).magaluChannelId ||
        process.env.MAGALU_DEFAULT_CHANNEL_ID;
      if (!channelId) {
        try {
          const channels = await MagaluApiService.getChannels(
            account.accessToken,
          );
          channelId = channels[0]?.id;
        } catch {
          /* deixa o preflight abaixo tratar */
        }
      }
      if (!groupId || !channelId) {
        return {
          success: false,
          error:
            "Criação na Magalu requer SKU (group) e um canal de venda. Configure MAGALU_DEFAULT_CHANNEL_ID ou habilite um canal no seller.",
        };
      }

      // Resolução de categoria (best-effort): com o escopo
      // open:portfolio-categories-seller:read e um match, inclui category +
      // atributos obrigatórios (tira o SKU de DRAFT). Sem escopo/sem match,
      // cria sem categoria (DRAFT) — NÃO falha o anúncio.
      let categoryFields: {
        categoryId?: string;
        attributes?: Array<{ name: string; value: string }>;
        datasheet?: Array<{ name: string; value: string }>;
      } = { categoryId };
      try {
        const resolvedCategoryId =
          categoryId ??
          (await MagaluCategoryResolutionService.resolveCategoryId(
            account.accessToken,
            product,
          ));
        if (resolvedCategoryId) {
          const fields =
            await MagaluCategoryResolutionService.buildCategoryFields(
              account.accessToken,
              resolvedCategoryId,
              product,
            );
          categoryFields = {
            categoryId: resolvedCategoryId,
            attributes: fields.attributes,
            datasheet: fields.datasheet,
          };
          if (fields.missing.length) {
            console.warn(
              `[ListingUseCase] Magalu categoria ${resolvedCategoryId}: atributos obrigatórios sem valor (lojista completa no painel): ${fields.missing.join(", ")}`,
            );
          }
        }
      } catch (catErr) {
        console.warn(
          `[ListingUseCase] Resolução de categoria Magalu falhou (cria sem categoria/DRAFT): ${catErr instanceof Error ? catErr.message : catErr}`,
        );
      }

      const payload = MagaluPayloadBuilderService.build(product, {
        groupId,
        channelId,
        ...categoryFields,
      });
      // Rede de segurança: se o create COM categoria for rejeitado por VALIDAÇÃO
      // de payload (400/422 — ex.: atributo obrigatório faltando), recria SEM
      // categoria (DRAFT). SÓ nesses status: 401/403/409/5xx/timeout propagam —
      // retry não ajuda e poderia DUPLICAR o SKU se o 1º POST já tiver sido
      // aceito (createSku é assíncrono/202 e o sku/group.id são fixos).
      let created: Awaited<ReturnType<typeof MagaluApiService.createSku>>;
      try {
        created = await MagaluApiService.createSku(account.accessToken, payload);
      } catch (createErr) {
        const status = (createErr as { status?: number })?.status;
        const isPayloadValidation = status === 400 || status === 422;
        if (!categoryFields.categoryId || !isPayloadValidation) throw createErr;
        console.warn(
          `[ListingUseCase] create Magalu com categoria ${categoryFields.categoryId} rejeitado (${status}: ${createErr instanceof Error ? createErr.message : createErr}); retry SEM categoria (DRAFT).`,
        );
        created = await MagaluApiService.createSku(
          account.accessToken,
          MagaluPayloadBuilderService.build(product, { groupId, channelId }),
        );
      }

      // Após criar o SKU, define estoque e preço iniciais (serviços separados:
      // /portfolios/stocks e /portfolios/prices). Não falha a criação do anúncio
      // se isso der erro — o sync recorrente reaplica depois.
      try {
        await MagaluApiService.setStock(
          account.accessToken,
          product.sku,
          product.stock,
          channelId,
          { create: true },
        );
        const price = Number(product.price);
        if (Number.isFinite(price) && price > 0) {
          await MagaluApiService.setPrice(
            account.accessToken,
            product.sku,
            price,
            channelId,
            { create: true },
          );
        }
      } catch (stockPriceErr) {
        console.warn(
          `[ListingUseCase] Magalu SKU criado, mas falhou estoque/preço inicial (sku=${product.sku}):`,
          stockPriceErr instanceof Error
            ? stockPriceErr.message
            : stockPriceErr,
        );
      }

      // A IDENTIDADE de um SKU na Magalu é o PRÓPRIO SKU: o POST responde 202 sem
      // id, e listSkus/getSku/stock/price/patch usam o sku como chave. Por isso
      // gravamos o SKU como `externalListingId` — não um placeholder PENDING_ (que
      // era o padrão do ML, onde o id real só chega depois). Assim edição/pausa/
      // remoção, import e auto-detecção casam todos pela MESMA chave (sem duplicar
      // o vínculo). Só cai no placeholder se, por algum motivo, não houver SKU.
      const externalListingId = String(
        created?.id ?? created?.sku ?? product.sku ?? `PENDING_${Date.now()}`,
      );
      const permalink =
        (created?.permalink as string) || (created?.url as string) || null;

      // upsert (não create): idempotente pela chave (conta, SKU). Se uma tentativa
      // anterior gravou status "error", este sucesso REAPROVEITA a mesma linha
      // virando "active" e limpa o lastError — sem P2002 nem linha duplicada.
      const listing = await ListingRepository.upsertListing({
        productId: product.id,
        marketplaceAccountId: account.id,
        externalListingId,
        externalSku: product.sku ?? null,
        permalink,
        status: "active",
        lastError: null,
        retryEnabled: false,
        nextRetryAt: null,
      });

      return {
        success: true,
        listingId: listing.id,
        externalListingId,
        permalink: permalink ?? undefined,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Erro ao criar anúncio na Magalu";
      // Espelha ML/Shopee: grava o RESULTADO no listing para o badge aparecer
      // (com opacidade menor) e o clique mostrar o porquê da falha. NÃO
      // sobrescreve um anúncio já publicado: 409 "já cadastrado" = duplicado → o
      // listing existente fica como está (só falhas REAIS viram "error").
      // Best-effort: se a persistência falhar, ainda devolve o erro ao chamador.
      const status = (error as { status?: number })?.status;
      const isDuplicate =
        status === 409 || /já cadastrado|already exists/i.test(message);
      if (product?.sku && account?.id && !isDuplicate) {
        try {
          await ListingRepository.upsertListing({
            productId: product.id,
            marketplaceAccountId: account.id,
            externalListingId: String(product.sku),
            externalSku: product.sku,
            status: "error",
            lastError: message.slice(0, 490),
            retryEnabled: true,
            nextRetryAt: new Date(Date.now() + 5 * 60 * 1000),
          });
        } catch (persistErr) {
          console.warn(
            `[ListingUseCase] Falha ao gravar o erro do create Magalu (sku=${product.sku}):`,
            persistErr instanceof Error ? persistErr.message : persistErr,
          );
        }
      }
      return { success: false, error: message };
    }
  }

  /** Resolve uma conta Magalu ativa + token fresco (p/ endpoints de categoria). */
  private static async resolveMagaluToken(
    userId: string,
    accountId?: string,
  ): Promise<string | null> {
    let account: any = accountId
      ? await MarketplaceRepository.findByIdAndUser(accountId, userId)
      : await MarketplaceRepository.findFirstActiveByUserAndPlatform(
          userId,
          Platform.MAGALU,
        );
    if (!account) {
      const all = await MarketplaceRepository.findAllByUserIdAndPlatform(
        userId,
        Platform.MAGALU,
      );
      account =
        (all || []).find((acc) => acc.status === AccountStatus.ACTIVE) ?? null;
    }
    if (!account?.accessToken || !account?.refreshToken) return null;
    if (account.expiresAt && new Date(account.expiresAt) <= new Date()) {
      try {
        const refreshed = await MagaluOAuthService.refreshAccessTokenForAccount(
          account.id,
          account.refreshToken,
        );
        const updated = await MarketplaceRepository.updateTokens(account.id, {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
        });
        account = updated ?? { ...account, accessToken: refreshed.accessToken };
      } catch {
        return null;
      }
    }
    return account.accessToken ?? null;
  }

  /** Busca categorias Magalu por nome (combobox de categoria do modal). */
  static async searchMagaluCategories(
    userId: string,
    search: string,
    opts?: { all?: boolean },
  ): Promise<Array<{ id: string; value: string }>> {
    const term = String(search ?? "").trim();
    if (!term) return [];
    const token = await this.resolveMagaluToken(userId);
    if (!token) return [];
    const cats = await MagaluApiService.searchCategories(token, { name: term });
    // Nicho: mesma preferência de domínio (CATEGORY_ROOT_HINT) que a resolução
    // automática já aplica, para a busca manual não trazer categorias de outros
    // domínios. SOFT (fail-open-to-raw). Escape hatch: opts.all.
    const scoped = opts?.all
      ? cats
      : MagaluCategoryResolutionService.filterCategoriesByRootHint(cats);
    return scoped
      .filter((c) => c.id)
      .map((c) => ({
        id: String(c.id),
        value: c.path || c.name || String(c.id),
      }));
  }

  /**
   * Sugere a categoria Magalu de um produto pelo nome — usa a MESMA resolução do
   * create (de-para → busca + viés de domínio), então a categoria mostrada no
   * modal é a que o anúncio será publicado.
   */
  static async suggestMagaluCategory(
    userId: string,
    name: string,
  ): Promise<{ categoryId: string; path: string | null } | null> {
    const term = String(name ?? "").trim();
    if (!term) return null;
    const token = await this.resolveMagaluToken(userId);
    if (!token) return null;
    const categoryId = await MagaluCategoryResolutionService.resolveCategoryId(
      token,
      { name: term },
    );
    if (!categoryId) return null;
    let path: string | null = null;
    try {
      const found = await MagaluApiService.searchCategories(token, {
        id: categoryId,
      });
      path = found[0]?.path || found[0]?.name || null;
    } catch {
      /* path é opcional — segue só com o id */
    }
    return { categoryId, path };
  }

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

      // Recusa DETERMINÍSTICA de duplicata (mesmo guard do createMLListing):
      // se já existe anúncio VIVO deste produto nesta conta, criar de novo só
      // pode dar errado — a Shopee rejeita com "This product duplicates
      // another in your shop" E o upsert do fracasso sobrescreveria o status
      // da linha SAUDÁVEL (aconteceu em produção com o duplo-submit do bulk:
      // job 1 criou os 2 anúncios, job 2 marcou as linhas como error). `closed`
      // não bloqueia: recriar anúncio encerrado é republicação legítima; o
      // placeholder PENDING_ do retry também não (não é "vivo").
      const liveShopeeListing =
        await ListingRepository.findLiveByProductAndAccount(
          productId,
          account.id,
        );
      if (liveShopeeListing) {
        const liveDesc =
          liveShopeeListing.status === "paused" ? "pausado" : "ativo";
        // Placeholder de retry deste par NUNCA vai conseguir criar — marca
        // terminal para o cron não gastar tentativas (mesmo padrão do ML).
        try {
          const placeholder = await ListingRepository.findByProductAndAccount(
            productId,
            account.id,
          );
          if (
            placeholder &&
            placeholder.externalListingId?.startsWith("PENDING_") &&
            placeholder.retryEnabled
          ) {
            await ListingRepository.updateListing(placeholder.id, {
              status: "error",
              lastError: `[TERMINAL] Produto já tem anúncio ${liveDesc} nesta conta na Shopee (${liveShopeeListing.externalListingId}) — exclua este pendente ou encerre o anúncio existente antes de recriar`,
              retryEnabled: false,
              nextRetryAt: null,
            });
          }
        } catch (markErr) {
          console.warn(
            "[ListingUseCase] falha ao marcar placeholder Shopee duplicado como terminal:",
            markErr instanceof Error ? markErr.message : markErr,
          );
        }
        console.warn(
          JSON.stringify({
            event: "shopee.create_item.duplicate_refused",
            productId,
            accountId: account.id,
            liveExternalListingId: liveShopeeListing.externalListingId,
            liveStatus: liveShopeeListing.status,
          }),
        );
        return {
          success: false,
          skipped: true,
          listingId: liveShopeeListing.id,
          externalListingId: liveShopeeListing.externalListingId,
          error: `Produto já tem anúncio ${liveDesc} nesta conta na Shopee (${liveShopeeListing.externalListingId}). Encerre o anúncio existente antes de criar outro.`,
        };
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

      // Estoque e preço são exigidos pela Shopee também — fail-fast antes de
      // montar payload evita chamadas desperdiçadas e loop de retry.
      if (typeof product.stock !== "number" || product.stock <= 0) {
        return {
          success: false,
          error:
            "Produto precisa ter estoque maior que zero para criar anúncio na Shopee",
        };
      }
      if (typeof product.price !== "number" || product.price <= 0) {
        return {
          success: false,
          error:
            "Produto precisa ter preço maior que zero para criar anúncio na Shopee",
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

      // Valida leaf-category ANTES de upload de imagens/stages paralelos.
      // Falha cedo com mensagem que o classificador de terminais (catch
      // abaixo) reconhece, evitando gastar API calls em categorias que
      // a Shopee vai rejeitar e marcando placeholders como [TERMINAL].
      await ShopeeApiService.assertLeafCategory(
        account.accessToken,
        account.shopId,
        numericCategoryId,
      );

      // 3. Buscar atributos obrigatórios da categoria via API Shopee
      const attributeList: ShopeeItemCreatePayload["attribute_list"] = [];

      // Mapa de valores do produto para os nomes de atributos mais comuns.
      // Lookup é case-insensitive (linha ~3158: attr.attribute_name.toLowerCase()),
      // então as chaves aqui DEVEM ser lowercase. Categorias de autopeça da
      // Shopee retornam "Auto-Part Number" como atributo mandatório em várias
      // categorias (102340 Injeção, 102370 Filtros, 102416, etc) — sem o
      // mapeamento correspondente, o lookup falhava e a API rejeitava o item
      // com "Attribute Auto-Part Number is mandatory required".
      const productAttrValues: Record<string, string> = {};
      if (product.brand) productAttrValues["marca"] = product.brand;
      if (product.brand) productAttrValues["brand"] = product.brand;
      if (product.model) productAttrValues["modelo"] = product.model;
      if (product.model) productAttrValues["model"] = product.model;
      if (product.year) productAttrValues["ano"] = product.year;
      if (product.year) productAttrValues["year"] = product.year;
      if (product.partNumber) {
        productAttrValues["número de referência"] = product.partNumber;
        productAttrValues["numero de referencia"] = product.partNumber;
        productAttrValues["part number"] = product.partNumber;
        productAttrValues["reference number"] = product.partNumber;
        productAttrValues["auto-part number"] = product.partNumber;
        productAttrValues["auto part number"] = product.partNumber;
        productAttrValues["número da peça"] = product.partNumber;
        productAttrValues["numero da peca"] = product.partNumber;
        productAttrValues["part number (oem)"] = product.partNumber;
        productAttrValues["oem part number"] = product.partNumber;
        productAttrValues["oem"] = product.partNumber;
      }

      // Coletar TODAS as URLs de imagens do produto (galeria completa).
      // Shopee aceita até 9 imagens por item; preservar ordem original.
      const shopeeImageUrls = ListingUseCase.collectProductImageUrls(product)
        .slice(0, ListingUseCase.SHOPEE_MAX_IMAGES)
        .map((raw) => ListingUseCase.toAbsoluteImageUrl(raw));

      // Validar que temos pelo menos uma imagem antes de upload
      if (shopeeImageUrls.length === 0) {
        throw new Error(
          "Produto sem imagem. A Shopee exige pelo menos uma imagem para criar o anúncio.",
        );
      }

      // ── OPT-1: Executar 3 stages independentes em paralelo ──
      // categoryAttributes, imageUpload e logisticsChannels não dependem entre si.
      // Antes: sequencial (5-16s). Agora: paralelo (3-10s, limitado pelo mais lento).
      // Imagens da galeria são enviadas em paralelo (Promise.allSettled) dentro
      // do stage de upload para preservar a ordem e tolerar falhas parciais.
      console.log(
        `[ListingUseCase] Uploading ${shopeeImageUrls.length} image(s) to Shopee`,
      );

      const imageUploadStage = Promise.allSettled(
        shopeeImageUrls.map((url) =>
          ShopeeApiService.uploadImage(
            account.accessToken,
            account.shopId,
            url,
          ),
        ),
      );

      // Stage 4: catálogo persistente de atributos.
      // Tenta memória → DB → live (com retry) → harvest cross-account → DB stale.
      // Retorna null se TUDO falhar — caller emite erro terminal em vez de
      // mandar attribute_list inválida (que a Shopee rejeita por contrato).
      const fetchCategoryAttrsWithCache = async (): Promise<{
        attribute_list: any[];
        source: "live" | "memory" | "db_fresh" | "db_stale" | "harvested";
      }> => {
        const resolution =
          await ShopeeAttributeCatalogService.getCategoryAttributes(
            "BR",
            numericCategoryId,
            "pt-BR",
            {
              fetchLive: async () => {
                try {
                  return await ShopeeApiService.getCategoryAttributes(
                    account.accessToken,
                    account.shopId,
                    numericCategoryId,
                    "pt-BR",
                  );
                } catch (err) {
                  if ((err as any)?.status === 403) {
                    // Espera curta e re-tenta uma vez (cobre flakiness)
                    await new Promise((r) => setTimeout(r, 800));
                    return await ShopeeApiService.getCategoryAttributes(
                      account.accessToken,
                      account.shopId,
                      numericCategoryId,
                      "pt-BR",
                    );
                  }
                  throw err;
                }
              },
              harvest: () =>
                ListingUseCase.harvestShopeeAttrsFromAnyAccount(
                  numericCategoryId,
                ),
            },
          );
        if (!resolution) {
          // null = TODOS os caminhos falharam (memory + DB + live + harvest +
          // stale). Diferente de attribute_list: [] (categoria sem mandatory
          // attrs — caso legítimo). Fail-fast com mensagem acionável; nunca
          // emitir payload com attribute_id=0 que a Shopee rejeita.
          console.warn(
            JSON.stringify({
              event: "shopee.category_attrs.failed",
              categoryId: numericCategoryId,
              shopId: account.shopId,
              message: "no_schema_from_any_source",
            }),
          );
          throw new Error(
            `Não foi possível obter os atributos da categoria Shopee ${numericCategoryId} ` +
              `(catálogo vazio, API retornou 403, e nenhum anúncio ativo nessa categoria em ` +
              `qualquer conta para harvest). Execute: npm run shopee:sync-attrs -- ` +
              `--category=${numericCategoryId} com uma conta Shopee que tenha permissão, ou ` +
              `crie 1 anúncio manualmente nessa categoria via Seller Center.`,
          );
        }
        console.log(
          JSON.stringify({
            event: "shopee.category_attrs.resolved",
            categoryId: numericCategoryId,
            shopId: account.shopId,
            source: resolution.source,
            attrCount: resolution.attribute_list.length,
          }),
        );
        return {
          attribute_list: resolution.attribute_list,
          source: resolution.source,
        };
      };

      const [categoryAttrsResult, imageUploadResult, logisticsResult] =
        await Promise.allSettled([
          // Stage 4: Category Attributes (cache + live + stale fallback)
          fetchCategoryAttrsWithCache(),
          // Stage 5: Image Upload (multi-imagem em paralelo)
          imageUploadStage,
          // Stage 6: Logistics Channels
          ShopeeApiService.getLogisticsChannelList(
            account.accessToken,
            account.shopId,
          ),
        ]);

      // ── Processar resultados de Category Attributes ──
      if (categoryAttrsResult.status === "fulfilled") {
        const { attribute_list: attrs, source } = categoryAttrsResult.value;
        console.log(
          `[ListingUseCase] Shopee category ${numericCategoryId} has ${attrs.length} attributes (${attrs.filter((a: any) => a.is_mandatory).length} mandatory) [source=${source}]`,
        );

        for (const attr of attrs) {
          const attrNameLower = attr.attribute_name.toLowerCase();
          const productValue = productAttrValues[attrNameLower];

          if (!productValue && !attr.is_mandatory) continue;

          let valueId = 0;
          let valueName = productValue || "";

          if (
            attr.attribute_value_list &&
            attr.attribute_value_list.length > 0
          ) {
            const exactMatch = attr.attribute_value_list.find(
              (v) =>
                v.value_name.toLowerCase() ===
                (productValue || "").toLowerCase(),
            );
            if (exactMatch) {
              valueId = exactMatch.value_id;
              valueName = exactMatch.value_name;
            } else if (productValue) {
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

            if (attr.is_mandatory && !valueName) {
              const picked = ListingUseCase.pickSafeMandatoryShopeeValue(
                attr.attribute_value_list,
              );
              valueId = picked.value_id;
              valueName = picked.value_name;
            }
          } else if (attr.is_mandatory && !valueName) {
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
      } else {
        // Sem schema de atributos, mandar payload é garantia de rejeição da
        // Shopee ("Auto-Part Number is mandatory required" ou "attribute info
        // is invalid"). Fail-fast com a mensagem acionável já formatada por
        // fetchCategoryAttrsWithCache.
        const reason: any = categoryAttrsResult.reason;
        throw reason instanceof Error
          ? reason
          : new Error(String(reason || "shopee.category_attrs.unavailable"));
      }

      // ── Processar resultado dos uploads de imagens (multi-imagem) ──
      // imageUploadResult é um Promise.allSettled aninhado, então o outer
      // sempre resolve "fulfilled" com um array de PromiseSettledResult.
      // Preservamos a ordem original e aceitamos sucesso parcial:
      // só falhamos se NENHUMA imagem foi enviada com sucesso.
      const shopeeImageIds: string[] = [];
      const imageUploadFailures: string[] = [];
      if (imageUploadResult.status === "fulfilled") {
        const perImageResults = imageUploadResult.value;
        for (let i = 0; i < perImageResults.length; i++) {
          const r = perImageResults[i];
          const sourceUrl = shopeeImageUrls[i];
          if (r.status === "fulfilled") {
            const imgId = r.value.image_info.image_id;
            shopeeImageIds.push(imgId);
            console.log(
              `[ListingUseCase] Shopee image uploaded (${i + 1}/${perImageResults.length}): ${imgId}`,
            );
          } else {
            const reasonMsg =
              (r.reason as any)?.message || String(r.reason || "unknown");
            imageUploadFailures.push(`${sourceUrl}: ${reasonMsg}`);
            console.warn(
              `[ListingUseCase] Shopee image upload failed (${i + 1}/${perImageResults.length}) for ${sourceUrl}:`,
              reasonMsg,
            );
          }
        }
      } else {
        const reasonMsg =
          (imageUploadResult.reason as any)?.message ||
          String(imageUploadResult.reason || "unknown");
        imageUploadFailures.push(reasonMsg);
        console.error(
          `[ListingUseCase] Shopee image upload stage rejected:`,
          reasonMsg,
        );
      }

      if (shopeeImageIds.length === 0) {
        throw new Error(
          `Falha ao fazer upload da(s) imagem(ns) para Shopee: ${imageUploadFailures.join("; ")}`,
        );
      }

      // Shopee exige brand — fallback "Genérica" se produto não tiver marca
      const brandName = product.brand || "Genérica";

      // Mapear condição do produto para Shopee (uppercase)
      const shopeeCondition: "NEW" | "USED" =
        (product as any).quality === "NOVO" ? "NEW" : "USED";

      // ── Processar resultado de Logistics Channels (fallback vazio se falhou) ──
      // Mantemos os canais completos (com weight_limit/item_max_dimension) para
      // poder filtrar depois com base nas dimensões reais do produto.
      type ShopeeChannel = {
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
      };
      let enabledChannels: ShopeeChannel[] = [];
      if (logisticsResult.status === "fulfilled") {
        enabledChannels = logisticsResult.value.filter((ch) => ch.enabled);
        console.log(
          `[ListingUseCase] Shopee logistics channels found: ${enabledChannels.length}`,
        );
      } else {
        console.warn(
          `[ListingUseCase] Failed to fetch Shopee logistics, using empty:`,
          logisticsResult.reason?.message || logisticsResult.reason,
        );
      }

      // ── Shopee dimension normalization (channel-aware, clamp-to-envelope) ──
      // Compute the most permissive envelope across enabled channels and clamp
      // product dimensions/weight into it. Shopee rejects createItem if the
      // declared package exceeds the logistic channel limits, so we fit the
      // declaration to what the seller's channels actually accept. The physical
      // item doesn't change — the seller can still ship it — but Shopee's
      // shipping-fee estimate and channel selection use these values.
      const SHOPEE_MIN_DIM_CM = 1;

      const rawWeightKg =
        product.weightKg && product.weightKg > 0 ? product.weightKg : 1.0;
      const rawLength =
        product.lengthCm && product.lengthCm > 0 ? Math.round(product.lengthCm) : 10;
      const rawWidth =
        product.widthCm && product.widthCm > 0 ? Math.round(product.widthCm) : 10;
      const rawHeight =
        product.heightCm && product.heightCm > 0 ? Math.round(product.heightCm) : 10;

      // Envelope = most permissive per-axis limit across enabled channels.
      // A value of 0/undefined means "no limit" → represented as Infinity.
      const envelope = {
        maxSide: 0,
        maxDimSum: 0,
        maxWeight: 0,
        minWeight: Infinity,
      };
      for (const ch of enabledChannels) {
        const md = ch.item_max_dimension;
        if (md) {
          const side = Math.max(md.length || 0, md.width || 0, md.height || 0);
          if (side > envelope.maxSide) envelope.maxSide = side;
          if ((md.dimension_sum || 0) > envelope.maxDimSum)
            envelope.maxDimSum = md.dimension_sum || 0;
        } else {
          envelope.maxSide = Math.max(envelope.maxSide, 9999);
          envelope.maxDimSum = Math.max(envelope.maxDimSum, 9999);
        }
        const wl = ch.weight_limit;
        if (wl) {
          if ((wl.item_max_weight || 0) > envelope.maxWeight)
            envelope.maxWeight = wl.item_max_weight || 0;
          if (
            typeof wl.item_min_weight === "number" &&
            wl.item_min_weight < envelope.minWeight
          )
            envelope.minWeight = wl.item_min_weight;
        } else {
          envelope.maxWeight = Math.max(envelope.maxWeight, 9999);
          envelope.minWeight = Math.min(envelope.minWeight, 0);
        }
      }
      if (envelope.minWeight === Infinity) envelope.minWeight = 0;
      // Fallbacks when no channel info is available
      if (enabledChannels.length === 0 || envelope.maxSide === 0)
        envelope.maxSide = 9999;
      if (enabledChannels.length === 0 || envelope.maxDimSum === 0)
        envelope.maxDimSum = 9999;
      if (enabledChannels.length === 0 || envelope.maxWeight === 0)
        envelope.maxWeight = 9999;

      // Clamp each side to envelope maxSide
      let adjL = Math.min(rawLength, envelope.maxSide);
      let adjW = Math.min(rawWidth, envelope.maxSide);
      let adjH = Math.min(rawHeight, envelope.maxSide);
      // Clamp the largest axis down until dimension sum fits envelope.maxDimSum
      let sum = adjL + adjW + adjH;
      let safety = 0;
      while (sum > envelope.maxDimSum && safety < 10) {
        if (adjL >= adjW && adjL >= adjH)
          adjL = Math.max(SHOPEE_MIN_DIM_CM, adjL - (sum - envelope.maxDimSum));
        else if (adjW >= adjH)
          adjW = Math.max(SHOPEE_MIN_DIM_CM, adjW - (sum - envelope.maxDimSum));
        else adjH = Math.max(SHOPEE_MIN_DIM_CM, adjH - (sum - envelope.maxDimSum));
        sum = adjL + adjW + adjH;
        safety++;
      }

      // Clamp weight to envelope range
      let adjWeight = rawWeightKg;
      if (adjWeight > envelope.maxWeight) adjWeight = envelope.maxWeight;
      if (adjWeight < envelope.minWeight) adjWeight = envelope.minWeight;

      const shopeeLength = Math.max(SHOPEE_MIN_DIM_CM, Math.round(adjL));
      const shopeeWidth = Math.max(SHOPEE_MIN_DIM_CM, Math.round(adjW));
      const shopeeHeight = Math.max(SHOPEE_MIN_DIM_CM, Math.round(adjH));
      const shopeeWeightKg = Math.max(0.01, adjWeight);

      const dimsChanged =
        shopeeLength !== rawLength ||
        shopeeWidth !== rawWidth ||
        shopeeHeight !== rawHeight ||
        Math.abs(shopeeWeightKg - rawWeightKg) > 0.001;
      if (dimsChanged) {
        console.warn(
          `[ListingUseCase] Shopee dims adjusted to channel envelope: ` +
            `${rawLength}x${rawWidth}x${rawHeight}cm/${rawWeightKg}kg → ` +
            `${shopeeLength}x${shopeeWidth}x${shopeeHeight}cm/${shopeeWeightKg}kg ` +
            `(envelope maxSide=${envelope.maxSide}cm, maxSum=${envelope.maxDimSum}cm, ` +
            `weight=[${envelope.minWeight},${envelope.maxWeight}]kg)`,
        );
      }

      // ── Filtrar canais logísticos que aceitam as dimensões/peso do produto ──
      // Shopee rejeita o createItem inteiro se QUALQUER canal passado em
      // logistic_info não aceitar o item. Por isso, só enviamos canais que
      // efetivamente cabem. Se o canal não informa limites, assumimos que aceita.
      const productMaxSide = Math.max(shopeeLength, shopeeWidth, shopeeHeight);
      const productDimSum = shopeeLength + shopeeWidth + shopeeHeight;
      const channelRejections: string[] = [];
      const compatibleChannels = enabledChannels.filter((ch) => {
        const wl = ch.weight_limit;
        if (wl) {
          if (
            typeof wl.item_max_weight === "number" &&
            wl.item_max_weight > 0 &&
            shopeeWeightKg > wl.item_max_weight
          ) {
            channelRejections.push(
              `${ch.logistics_channel_name}: peso ${shopeeWeightKg}kg > máx ${wl.item_max_weight}kg`,
            );
            return false;
          }
          if (
            typeof wl.item_min_weight === "number" &&
            wl.item_min_weight > 0 &&
            shopeeWeightKg < wl.item_min_weight
          ) {
            channelRejections.push(
              `${ch.logistics_channel_name}: peso ${shopeeWeightKg}kg < mín ${wl.item_min_weight}kg`,
            );
            return false;
          }
        }
        const md = ch.item_max_dimension;
        if (md) {
          const channelMaxSide = Math.max(
            md.length || 0,
            md.width || 0,
            md.height || 0,
          );
          if (channelMaxSide > 0 && productMaxSide > channelMaxSide) {
            channelRejections.push(
              `${ch.logistics_channel_name}: lado ${productMaxSide}cm > máx ${channelMaxSide}cm`,
            );
            return false;
          }
          if (
            typeof md.dimension_sum === "number" &&
            md.dimension_sum > 0 &&
            productDimSum > md.dimension_sum
          ) {
            channelRejections.push(
              `${ch.logistics_channel_name}: soma ${productDimSum}cm > máx ${md.dimension_sum}cm`,
            );
            return false;
          }
        }
        return true;
      });

      const logisticInfo: Array<{ logistic_id: number; enabled: boolean }> =
        compatibleChannels.map((ch) => ({
          logistic_id: ch.logistics_channel_id,
          enabled: true,
        }));

      if (enabledChannels.length > 0 && compatibleChannels.length === 0) {
        const detail =
          channelRejections.length > 0
            ? ` Detalhes: ${channelRejections.join("; ")}.`
            : "";
        throw new Error(
          `Produto excede os limites de todos os canais logísticos habilitados no Shopee ` +
            `(${shopeeHeight}x${shopeeWidth}x${shopeeLength}cm, ${shopeeWeightKg}kg).${detail} ` +
            `Ajuste as dimensões/peso do produto ou habilite um canal compatível na loja.`,
        );
      }

      if (compatibleChannels.length < enabledChannels.length) {
        console.warn(
          `[ListingUseCase] Shopee logistics filtered: ${compatibleChannels.length}/${enabledChannels.length} canais compatíveis. Rejeitados: ${channelRejections.join("; ")}`,
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
        weight: shopeeWeightKg,
        dimension: {
          package_length: shopeeLength,
          package_width: shopeeWidth,
          package_height: shopeeHeight,
        },
        image: {
          image_id_list: shopeeImageIds,
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
        // retryEnabled=false: o fluxo primário é responsável pelo próprio
        // sucesso/erro. Só o catch abaixo habilita retry explicitamente se
        // a chamada falhar. Isso evita que o ListingRetryService pegue o
        // placeholder durante a janela entre criação e update final e
        // dispare uma criação duplicada.
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
          retryEnabled: false,
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
          imageIds: shopeeImageIds,
          imageCount: shopeeImageIds.length,
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

            // Re-fetch logistics with fresh token if payload has no logistics
            if (!payload.logistic_info || payload.logistic_info.length === 0) {
              try {
                const freshLogistics =
                  await ShopeeApiService.getLogisticsChannelList(
                    refreshed.access_token,
                    account.shopId,
                  );
                const freshLogisticInfo = freshLogistics
                  .filter((ch) => ch.enabled)
                  .map((ch) => ({
                    logistic_id: ch.logistics_channel_id,
                    enabled: true as const,
                  }));
                if (freshLogisticInfo.length > 0) {
                  payload.logistic_info = freshLogisticInfo;
                  console.log(
                    `[ListingUseCase] Shopee logistics re-fetched on retry: ${freshLogisticInfo.length} channels`,
                  );
                }
              } catch (logErr) {
                console.warn(
                  `[ListingUseCase] Failed to re-fetch logistics on retry:`,
                  (logErr as any)?.message || logErr,
                );
              }
            }

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

      // Classify whether this error is deterministic (no point retrying)
      const errLower = errorMsg.toLowerCase();
      const isTerminalError =
        // Oversize: product dimensions exceed all enabled logistics channels
        /excede os limites de todos os canais/i.test(errorMsg) ||
        // Duplicate: Shopee rejects because item already exists in shop
        /duplicates? another/i.test(errorMsg) ||
        /duplicate.*shop/i.test(errorMsg) ||
        // Category missing: requires manual intervention
        /selecione uma categoria/i.test(errorMsg) ||
        // Invalid category (pt + en) / non-leaf category
        /categoria.*inv[aá]lida/i.test(errorMsg) ||
        /invalid category/i.test(errorMsg) ||
        /should use leaf category/i.test(errorMsg) ||
        /leaf category/i.test(errorMsg) ||
        // Attribute mandatory missing — pode acontecer se o schema do
        // catálogo estiver incompleto/desatualizado. Retry não ajuda;
        // operador precisa rodar sync-shopee-attrs ou validar permissão.
        /attribute .* mandatory required/i.test(errorMsg) ||
        /attribute info is invalid/i.test(errorMsg) ||
        // Permission denied no get_attributes — escopo OAuth incompleto
        /permission denied/i.test(errorMsg) ||
        // Catálogo não tem schema e nada conseguiu resolver — fail-fast
        // emitido por fetchCategoryAttrsWithCache. Retry sem sync não ajuda.
        /não foi possível obter os atributos da categoria/i.test(errorMsg);

      // Atualizar placeholder com erro e decisão de retry
      try {
        const acctId = account?.id;
        if (acctId) {
          const existingListing =
            await ListingRepository.findByProductAndAccount(productId, acctId);
          if (existingListing) {
            const attempts = (existingListing.retryAttempts || 0) + 1;
            const maxAttempts = 5;
            const shouldRetry = !isTerminalError && attempts < maxAttempts;
            const backoffSeconds = [60, 120, 300, 600, 900];
            const nextDelay = backoffSeconds[Math.min(attempts - 1, backoffSeconds.length - 1)];

            await ListingRepository.updateListing(existingListing.id, {
              status: "error",
              lastError: (isTerminalError ? "[TERMINAL] " : "") + errorMsg.substring(0, 490),
              retryEnabled: shouldRetry,
              nextRetryAt: shouldRetry ? new Date(Date.now() + nextDelay * 1000) : null,
              retryAttempts: attempts,
            });

            if (isTerminalError) {
              console.warn(
                `[ListingUseCase] Shopee terminal error for product ${productId} — retry disabled: ${errorMsg.substring(0, 200)}`,
              );
            }
          }
        }
      } catch (updateErr) {
        console.error(
          `[ListingUseCase] Failed to update Shopee placeholder with error:`,
          updateErr,
        );
      }

      // Mensagens mais úteis para erros terminais conhecidos
      let userFacingError = errorMsg;
      if (/não foi possível obter os atributos da categoria/i.test(errorMsg)) {
        // Já é uma mensagem acionável formatada por fetchCategoryAttrsWithCache
        userFacingError = errorMsg;
      } else if (
        /attribute .* mandatory required/i.test(errorMsg) ||
        /attribute info is invalid/i.test(errorMsg) ||
        /permission denied/i.test(errorMsg)
      ) {
        userFacingError =
          `Shopee rejeitou o anúncio por atributos obrigatórios da categoria. ` +
          `Rode: npm run shopee:sync-attrs -- --category=<id> para popular o ` +
          `catálogo, ou re-autorize o app Dexo no Shopee Seller Center (Apps → ` +
          `Autorizações) garantindo todos os escopos. ` +
          `Erro original: ${errorMsg.substring(0, 200)}`;
      }

      return {
        success: false,
        error: userFacingError,
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

      const currentItem = await MLApiService.getItemDetails(
        account.accessToken,
        listing.externalListingId,
      );

      if (currentItem.status === "closed") {
        return { success: true };
      }

      if (quantity <= 0) {
        if (
          currentItem.status === "paused" ||
          currentItem.status === "inactive" ||
          currentItem.status === "under_review"
        ) {
          return { success: true };
        }

        if (currentItem.status === "active") {
          await MLApiService.updateItem(account.accessToken, listing.externalListingId, {
            status: "paused",
          });
          return { success: true };
        }
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
   * Remove um anúncio do Mercado Livre.
   *
   * Política estrita (substitui o "best-effort + delete local sempre" antigo):
   *  - PENDING_ / sem credenciais → delete local (não há nada remoto a fechar).
   *  - PUT /items/{id} status=closed bem-sucedido → delete local.
   *  - Erro idempotente (404, "already closed") → delete local.
   *  - Erro recuperável (429, 5xx, network) → retry exponencial 500ms/2s/8s.
   *    Se ainda falhar, NÃO deleta local, retorna retryable=true.
   *  - Erro permanente (4xx genérico, auth) → NÃO deleta local.
   */
  static async removeMLListing(
    listingId: string,
  ): Promise<{
    success: boolean;
    closedOnMarketplace: boolean;
    error?: string;
    retryable?: boolean;
  }> {
    try {
      const listing = await ListingRepository.findById(listingId);
      if (!listing) {
        return {
          success: false,
          closedOnMarketplace: false,
          error: "Vínculo não encontrado",
        };
      }

      // PENDING ou sem externalListingId: não há nada para fechar no ML.
      if (
        !listing.externalListingId ||
        listing.externalListingId.startsWith("PENDING_")
      ) {
        await ListingRepository.deleteListing(listingId);
        return { success: true, closedOnMarketplace: false };
      }

      const account = await MarketplaceRepository.findById(
        listing.marketplaceAccountId,
      );
      if (!account || !account.accessToken) {
        // Conta desconectada — não conseguimos confirmar fechamento.
        // Política estrita: NÃO deleta local. O usuário precisa reconectar
        // a conta antes de remover o anúncio.
        return {
          success: false,
          closedOnMarketplace: false,
          retryable: true,
          error:
            "Conta do Mercado Livre sem token de acesso. Reconecte a conta e tente novamente.",
        };
      }

      try {
        await withRetry(
          () =>
            MLApiService.updateItem(
              account.accessToken!,
              listing.externalListingId,
              { status: "closed" },
            ),
          { classify: classifyMLRemoveError },
        );
      } catch (closeError) {
        const c = classifyMLRemoveError(closeError);
        if (c.kind === "idempotent") {
          // ML confirma que o item não pode mais ser fechado porque já está
          // fechado / não existe mais. Trata como sucesso.
          console.log(
            `[ListingUseCase] ML listing ${listing.externalListingId} já encerrado (${c.message})`,
          );
          await ListingRepository.deleteListing(listingId);
          return { success: true, closedOnMarketplace: true };
        }

        // 403 "you are not the seller" frequentemente significa que o
        // ProductListing local está vinculado à CONTA ERRADA do mesmo
        // usuário (caso típico: importações em massa que erraram o
        // ownership). Tentamos descobrir qual conta é o dono real e
        // reparar o vínculo automaticamente antes de desistir.
        if (c.kind === "permanent" && c.status === 403) {
          const userId = listing.product?.userId;
          if (userId) {
            const repair = await findCorrectMLAccount({
              userId,
              currentAccountId: listing.marketplaceAccountId,
              externalListingId: listing.externalListingId,
            });
            if (repair.repaired && repair.newAccountId && repair.newAccountToken) {
              await ListingRepository.reassignAccount(
                listingId,
                repair.newAccountId,
              );
              void SystemLogService.logListingOwnershipRepaired(userId, listingId, {
                externalListingId: listing.externalListingId,
                oldAccountId: listing.marketplaceAccountId,
                newAccountId: repair.newAccountId,
                itemStatus: repair.itemStatus,
              });
              console.log(
                `[ListingUseCase] ownership reparado: listing ${listingId} reapontado para conta ${repair.newAccountId} (item status=${repair.itemStatus})`,
              );

              // Se o item já está closed no ML, o close pedido é
              // idempotente — basta deletar o vínculo local.
              if (repair.itemStatus === "closed") {
                await ListingRepository.deleteListing(listingId);
                return { success: true, closedOnMarketplace: true };
              }

              // Item ainda está vivo no ML: re-tenta o fechamento com o
              // token da conta correta.
              try {
                await withRetry(
                  () =>
                    MLApiService.updateItem(
                      repair.newAccountToken!,
                      listing.externalListingId,
                      { status: "closed" },
                    ),
                  { classify: classifyMLRemoveError },
                );
                await ListingRepository.deleteListing(listingId);
                return { success: true, closedOnMarketplace: true };
              } catch (retryError) {
                const cRetry = classifyMLRemoveError(retryError);
                if (cRetry.kind === "idempotent") {
                  await ListingRepository.deleteListing(listingId);
                  return { success: true, closedOnMarketplace: true };
                }
                console.warn(
                  `[ListingUseCase] reparo OK mas re-close ainda falhou (${cRetry.kind}): ${cRetry.message}`,
                );
                return {
                  success: false,
                  closedOnMarketplace: false,
                  retryable: cRetry.kind === "retryable",
                  error: cRetry.message,
                };
              }
            }
            console.log(
              `[ListingUseCase] reparo não encontrou conta correta para ${listing.externalListingId}: ${repair.reason}`,
            );
          }
        }

        console.warn(
          `[ListingUseCase] Falha ao fechar ML listing ${listing.externalListingId} (${c.kind}):`,
          c.message,
        );
        return {
          success: false,
          closedOnMarketplace: false,
          retryable: c.kind === "retryable",
          error: c.message,
        };
      }

      console.log(
        `[ListingUseCase] ML listing ${listing.externalListingId} closed successfully`,
      );
      await ListingRepository.deleteListing(listingId);
      return { success: true, closedOnMarketplace: true };
    } catch (error) {
      console.error("[ListingUseCase] Error removing ML listing:", error);
      return {
        success: false,
        closedOnMarketplace: false,
        error: error instanceof Error ? error.message : "Erro ao remover anúncio",
      };
    }
  }

  /**
   * Remove um anúncio da Shopee. Mesma política estrita de removeMLListing.
   *
   * Idempotência Shopee: error_inexist / product.error_inexist são tratados
   * como sucesso (item já não existe no marketplace).
   */
  static async removeShopeeListing(
    listingId: string,
  ): Promise<{
    success: boolean;
    closedOnMarketplace: boolean;
    error?: string;
    retryable?: boolean;
  }> {
    try {
      const listing = await ListingRepository.findById(listingId);
      if (!listing) {
        return {
          success: false,
          closedOnMarketplace: false,
          error: "Vínculo não encontrado",
        };
      }

      if (
        !listing.externalListingId ||
        listing.externalListingId.startsWith("PENDING_")
      ) {
        await ListingRepository.deleteListing(listingId);
        return { success: true, closedOnMarketplace: false };
      }

      const account = await MarketplaceRepository.findById(
        listing.marketplaceAccountId,
      );
      if (!account || !account.accessToken || !account.shopId) {
        return {
          success: false,
          closedOnMarketplace: false,
          retryable: true,
          error:
            "Conta da Shopee sem token/shop_id. Reconecte a conta e tente novamente.",
        };
      }

      const itemId = Number(listing.externalListingId);
      if (!Number.isFinite(itemId)) {
        // externalListingId malformado é problema de dados locais, não do
        // marketplace. Limpa o registro local porque não há como reconciliar.
        console.warn(
          `[ListingUseCase] Shopee externalListingId inválido: ${listing.externalListingId}`,
        );
        await ListingRepository.deleteListing(listingId);
        return { success: true, closedOnMarketplace: false };
      }

      try {
        await withRetry(
          () =>
            ShopeeApiService.deleteItem(
              account.accessToken!,
              account.shopId!,
              itemId,
            ),
          { classify: classifyShopeeRemoveError },
        );
      } catch (deleteError) {
        const c = classifyShopeeRemoveError(deleteError);
        if (c.kind === "idempotent") {
          console.log(
            `[ListingUseCase] Shopee item ${itemId} já não existe (${c.message})`,
          );
          await ListingRepository.deleteListing(listingId);
          return { success: true, closedOnMarketplace: true };
        }

        console.warn(
          `[ListingUseCase] Falha ao deletar Shopee item ${itemId} (${c.kind}):`,
          c.message,
        );
        return {
          success: false,
          closedOnMarketplace: false,
          retryable: c.kind === "retryable",
          error: c.message,
        };
      }

      console.log(
        `[ListingUseCase] Shopee item ${itemId} deleted successfully`,
      );
      await ListingRepository.deleteListing(listingId);
      return { success: true, closedOnMarketplace: true };
    } catch (error) {
      console.error("[ListingUseCase] Error removing Shopee listing:", error);
      return {
        success: false,
        closedOnMarketplace: false,
        error: error instanceof Error ? error.message : "Erro ao remover anúncio",
      };
    }
  }

  /**
   * Dispatcher: remove um anúncio escolhendo o fluxo correto pela plataforma
   * da conta vinculada. Propaga o resultado estendido (closedOnMarketplace,
   * retryable). Plataforma desconhecida = só delete local (sem nada remoto).
   */
  static async removeListing(
    listingId: string,
  ): Promise<{
    success: boolean;
    closedOnMarketplace: boolean;
    error?: string;
    retryable?: boolean;
  }> {
    const listing = await ListingRepository.findById(listingId);
    if (!listing) {
      return {
        success: false,
        closedOnMarketplace: false,
        error: "Vínculo não encontrado",
      };
    }

    const platform = listing.marketplaceAccount?.platform;
    if (platform === Platform.MERCADO_LIVRE) {
      return ListingUseCase.removeMLListing(listingId);
    }
    if (platform === Platform.SHOPEE) {
      return ListingUseCase.removeShopeeListing(listingId);
    }
    if (platform === Platform.MAGALU) {
      return ListingUseCase.removeMagaluListing(listingId);
    }

    console.warn(
      `[ListingUseCase] Plataforma desconhecida ao remover listing ${listingId}: ${platform}`,
    );
    await ListingRepository.deleteListing(listingId);
    return { success: true, closedOnMarketplace: false };
  }

  /**
   * Atualiza campos editáveis específicos de um anúncio publicado.
   *
   * Escopo intencionalmente reduzido para evitar conflito com o re-sync
   * disparado por `PUT /products/:id` (ListingDispatcher). Campos compartilhados
   * com o produto (título/descrição/preço/estoque/dimensões) NÃO são editados
   * aqui — esses devem ser ajustados pelo EditProductDialog.
   *
   * Mercado Livre: aceita listingType, itemCondition, garantia, frete, tempo de fabricação.
   * Shopee: por enquanto apenas persistência local (extensão futura).
   *
   * Faz validação de ownership: o anúncio deve pertencer ao userId informado.
   */
  static async updateListingFields(
    listingId: string,
    userId: string,
    fields: ListingFullEditInput,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const listing = await ListingRepository.findById(listingId);
      if (!listing) {
        return { success: false, error: "Anúncio não encontrado" };
      }
      if (listing.product?.userId !== userId) {
        return { success: false, error: "Acesso negado a este anúncio" };
      }

      const platform = listing.marketplaceAccount?.platform;

      if (platform === Platform.MERCADO_LIVRE) {
        return await ListingUseCase.updateMLListingFields(listing, fields);
      }

      if (platform === Platform.SHOPEE) {
        return await ListingUseCase.updateShopeeListingFields(listing, fields);
      }

      if (platform === Platform.MAGALU) {
        return await ListingUseCase.updateMagaluListingFields(listing, fields);
      }

      return {
        success: false,
        error: `Plataforma ${platform} não suportada para edição`,
      };
    } catch (error) {
      console.error("[ListingUseCase] Error updating listing fields:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Erro ao atualizar anúncio",
      };
    }
  }

  /**
   * Pausa ou reativa um anúncio publicado.
   * Aceita "active" ou "paused". Para encerrar definitivamente, usar removeListing.
   *
   * Mercado Livre: chama PUT /items/{id} com `status` mudando.
   * Shopee: ainda não suportado (apenas persistência local) — extensão futura
   * deve usar `unlist_item` quando disponível.
   *
   * Faz validação de ownership.
   */
  static async updateListingStatus(
    listingId: string,
    userId: string,
    status: "active" | "paused",
  ): Promise<{ success: boolean; error?: string; alreadyInState?: boolean }> {
    try {
      const listing = await ListingRepository.findById(listingId);
      if (!listing) {
        return { success: false, error: "Anúncio não encontrado" };
      }
      if (listing.product?.userId !== userId) {
        return { success: false, error: "Acesso negado a este anúncio" };
      }

      // Idempotência: se já está no status desejado, não chama API externa.
      // Normaliza lowercase porque o DB historicamente recebe ambos os casings.
      if (listing.status?.toLowerCase() === status) {
        return { success: true, alreadyInState: true };
      }

      // Guard comum a ambas as plataformas: anúncio precisa estar publicado.
      const platform = listing.marketplaceAccount?.platform;

      // Magalu: a publicação é assíncrona (POST 202) e o `externalListingId` fica
      // PENDING_<sku>; a chave de API é o SKU (externalSku). Considera-se
      // "publicado" quando há SKU — por isso a guarda de PENDING não se aplica.
      const isMagalu = platform === Platform.MAGALU;
      if (
        !isMagalu &&
        (!listing.externalListingId ||
          listing.externalListingId.startsWith("PENDING_"))
      ) {
        return {
          success: false,
          error: "Anúncio ainda não foi publicado no marketplace",
        };
      }

      if (platform === Platform.MERCADO_LIVRE) {
        // Reusa account incluído no findById (sem 2ª query ao banco).
        const account = listing.marketplaceAccount;
        if (!account || !account.accessToken) {
          return { success: false, error: "Conta sem credenciais válidas" };
        }

        await MLApiService.updateItem(
          account.accessToken,
          listing.externalListingId,
          { status },
        );
        await ListingRepository.updateStatus(listingId, status);
        return { success: true };
      }

      if (platform === Platform.SHOPEE) {
        const account = listing.marketplaceAccount;
        if (!account || !account.accessToken || !account.shopId) {
          return {
            success: false,
            error: "Conta Shopee sem credenciais válidas",
          };
        }

        const itemId = Number(listing.externalListingId);
        if (!Number.isFinite(itemId)) {
          return {
            success: false,
            error: "ID externo do anúncio Shopee inválido",
          };
        }

        const result = await ShopeeApiService.unlistItem(
          account.accessToken,
          account.shopId,
          [{ itemId, unlist: status === "paused" }],
        );

        if (result.failure_list.length > 0) {
          return {
            success: false,
            error: result.failure_list[0].failed_reason,
          };
        }

        await ListingRepository.updateStatus(listingId, status);
        return { success: true };
      }

      if (platform === Platform.MAGALU) {
        const account = listing.marketplaceAccount;
        const sku = listing.externalSku || listing.product?.sku;
        if (!account) {
          return { success: false, error: "Conta sem credenciais válidas" };
        }
        if (!sku) {
          return {
            success: false,
            error: "Anúncio Magalu sem SKU para atualizar",
          };
        }
        const token = await ListingUseCase.ensureFreshMagaluToken(account);
        if (!token) {
          return {
            success: false,
            error: "Conta Magalu sem token válido — reconecte a conta",
          };
        }
        // Pausar = active:false; reativar = active:true (PATCH parcial no SKU).
        await MagaluApiService.patchSku(token, sku, {
          active: status === "active",
        });
        await ListingRepository.updateStatus(listingId, status);
        return { success: true };
      }

      return {
        success: false,
        error: `Plataforma ${platform} não suportada`,
      };
    } catch (error) {
      console.error("[ListingUseCase] Error updating listing status:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Erro ao alterar status",
      };
    }
  }

  /**
   * Garante um access token Magalu válido a partir de uma conta já carregada
   * (mesmo refresh+persist de createMagaluListing). Retorna null se a conta não
   * tem token ou o refresh falha. Não lança — o chamador trata o null.
   */
  private static async ensureFreshMagaluToken(account: {
    id: string;
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: Date | null;
  }): Promise<string | null> {
    if (!account?.accessToken) return null;
    const expired = account.expiresAt
      ? new Date(account.expiresAt) <= new Date()
      : false;
    if (!expired) return account.accessToken;
    if (!account.refreshToken) return null;
    try {
      const refreshed = await MagaluOAuthService.refreshAccessTokenForAccount(
        account.id,
        account.refreshToken,
      );
      await MarketplaceRepository.updateTokens(account.id, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      });
      return refreshed.accessToken;
    } catch (err) {
      console.warn(
        `[ListingUseCase] Falha ao refrescar token Magalu da conta ${account.id}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Remove (encerra) um anúncio Magalu. A doc não expõe DELETE de SKU; o
   * equivalente a "parar de vender" é PATCH `active:false` (UNPUBLISHED). Depois
   * apaga o vínculo local. 404 (SKU já inexistente) é idempotente → sucesso.
   * Sem SKU ⇒ só apaga o vínculo local (nada a fazer no marketplace).
   */
  static async removeMagaluListing(listingId: string): Promise<{
    success: boolean;
    closedOnMarketplace: boolean;
    error?: string;
    retryable?: boolean;
  }> {
    const listing = await ListingRepository.findById(listingId);
    if (!listing) {
      return {
        success: false,
        closedOnMarketplace: false,
        error: "Vínculo não encontrado",
      };
    }
    const sku = listing.externalSku || listing.product?.sku;
    if (!sku) {
      await ListingRepository.deleteListing(listingId);
      return { success: true, closedOnMarketplace: false };
    }
    const account = await MarketplaceRepository.findById(
      listing.marketplaceAccountId,
    );
    if (!account || !account.accessToken) {
      return {
        success: false,
        closedOnMarketplace: false,
        retryable: true,
        error:
          "Conta da Magalu sem token de acesso. Reconecte a conta e tente novamente.",
      };
    }
    const token = await ListingUseCase.ensureFreshMagaluToken(account);
    if (!token) {
      return {
        success: false,
        closedOnMarketplace: false,
        retryable: true,
        error: "Conta Magalu sem token válido — reconecte a conta",
      };
    }
    try {
      await MagaluApiService.patchSku(token, sku, { active: false });
    } catch (err) {
      const status = (err as { status?: number })?.status;
      // 404 = SKU não existe mais na Magalu → tratar como já encerrado.
      if (status !== 404) {
        return {
          success: false,
          closedOnMarketplace: false,
          retryable: status === undefined || status >= 500,
          error:
            err instanceof Error
              ? err.message
              : "Erro ao remover anúncio na Magalu",
        };
      }
    }
    await ListingRepository.deleteListing(listingId);
    return { success: true, closedOnMarketplace: true };
  }

  /**
   * Edição de campos de um anúncio Magalu (PATCH parcial no SKU). Escopo mínimo:
   * title/description (os únicos campos de texto editáveis aqui). Preço/estoque
   * têm endpoints dedicados (setPrice/setStock) e fluem pelo "Editar produto".
   * Sem campos mapeáveis ⇒ no-op com sucesso (mesmo contrato do ML/Shopee).
   */
  private static async updateMagaluListingFields(
    listing: NonNullable<Awaited<ReturnType<typeof ListingRepository.findById>>>,
    fields: ListingFullEditInput,
  ): Promise<{ success: boolean; error?: string }> {
    const account = listing.marketplaceAccount;
    const sku = listing.externalSku || listing.product?.sku;
    if (!account || !account.accessToken) {
      return { success: false, error: "Conta sem credenciais válidas" };
    }
    if (!sku) {
      return { success: false, error: "Anúncio Magalu sem SKU para editar" };
    }
    const token = await ListingUseCase.ensureFreshMagaluToken(account);
    if (!token) {
      return {
        success: false,
        error: "Conta Magalu sem token válido — reconecte a conta",
      };
    }
    const patch: Record<string, unknown> = {};
    if (
      typeof fields.titleOverride === "string" &&
      fields.titleOverride.trim()
    ) {
      // Limite de título da Magalu: 150 chars.
      patch.title = fields.titleOverride.trim().slice(0, 150);
    }
    if (
      typeof fields.descriptionOverride === "string" &&
      fields.descriptionOverride.trim()
    ) {
      patch.description = fields.descriptionOverride.trim();
    }
    if (Object.keys(patch).length > 0) {
      await MagaluApiService.patchSku(token, sku, patch);
    }
    return { success: true };
  }

  /**
   * Aplica edição de campos específicos no Mercado Livre.
   * Mapeia os campos do MLListingSettings para o payload aceito pelo
   * PUT /items/{id}, faz a chamada externa e persiste localmente.
   */
  private static async updateMLListingFields(
    listing: NonNullable<Awaited<ReturnType<typeof ListingRepository.findById>>>,
    fields: ListingFullEditInput,
  ): Promise<{ success: boolean; error?: string }> {
    // Reusa o marketplaceAccount já incluído no findById (evita 2ª query
    // ao banco). O include traz a entidade completa, com accessToken.
    const account = listing.marketplaceAccount;
    if (!account || !account.accessToken) {
      return { success: false, error: "Conta sem credenciais válidas" };
    }

    if (
      !listing.externalListingId ||
      listing.externalListingId.startsWith("PENDING_")
    ) {
      return {
        success: false,
        error: "Anúncio ainda não foi publicado no Mercado Livre",
      };
    }

    // listing_type_id NÃO é modificável via PUT /items/{id} — o ML retorna
    // `field_not_updatable`. Mudança de tipo de anúncio usa endpoint dedicado
    // (POST /items/{id}/listing_type) e é tratada separadamente abaixo.
    const payload: import("../types/ml-api.types").MLItemUpdatePayload = {};

    // Overrides do produto: title, description, price, pictures
    if (fields.titleOverride !== undefined && fields.titleOverride !== null) {
      payload.title = fields.titleOverride;
    }
    if (
      fields.descriptionOverride !== undefined &&
      fields.descriptionOverride !== null
    ) {
      // descriçao tem endpoint dedicado, usado depois do PUT principal
    }
    if (fields.priceOverride !== undefined && fields.priceOverride !== null) {
      // Espelha a validação que o caminho Shopee já faz: preço <= 0 significa
      // "herdar o preço do produto", e o ML rejeita price=0 (item.price.invalid).
      const priceNum = Number(fields.priceOverride);
      if (!Number.isFinite(priceNum) || priceNum <= 0) {
        return {
          success: false,
          error:
            "Preço inválido para anúncio do Mercado Livre (deve ser número positivo)",
        };
      }
      payload.price = priceNum;
    }
    if (
      Array.isArray(fields.imageUrlsOverride) &&
      fields.imageUrlsOverride.length > 0
    ) {
      payload.pictures = fields.imageUrlsOverride.map((url) => ({
        source: url,
      }));
    }
    // Atributos override: respeita lista de imutáveis do ML após criação
    if (fields.attributesOverride && typeof fields.attributesOverride === "object") {
      const IMMUTABLE_ATTRS = new Set([
        "BRAND",
        "MODEL",
        "YEAR",
        "VEHICLE_YEAR",
        "PART_NUMBER",
        "MPN",
        "OEM",
        "SELLER_SKU",
      ]);
      const list: Array<{
        id: string;
        value_id?: string;
        value_name?: string;
      }> = [];
      for (const [id, raw] of Object.entries(fields.attributesOverride)) {
        if (!id || IMMUTABLE_ATTRS.has(id)) continue;
        if (!raw || typeof raw !== "object") continue;
        const v = raw as { value_id?: string; value_name?: string };
        const valueId =
          typeof v.value_id === "string" && v.value_id.trim().length > 0
            ? v.value_id.trim()
            : undefined;
        const valueName =
          typeof v.value_name === "string" && v.value_name.trim().length > 0
            ? v.value_name.trim()
            : undefined;
        if (!valueId && !valueName) continue;
        const entry: { id: string; value_id?: string; value_name?: string } = {
          id,
        };
        if (valueId) entry.value_id = valueId;
        if (valueName) entry.value_name = valueName;
        list.push(entry);
      }
      if (list.length > 0) {
        payload.attributes = list;
      }
    }

    if (
      fields.itemCondition !== undefined &&
      fields.itemCondition !== null &&
      fields.itemCondition !== listing.itemCondition
    ) {
      payload.condition = fields.itemCondition;
    }
    // Defesa em profundidade: comparar com estado atual do listing antes de
    // adicionar warranty/shipping/sale_terms ao payload. Se o frontend (ou
    // outro caller) mandar settings inalterados, NÃO empurramos pro ML —
    // que rejeita com `field_not_modifiable` em anúncios com vendas.
    const warrantyChanged =
      (fields.hasWarranty !== undefined &&
        fields.hasWarranty !== listing.hasWarranty) ||
      (fields.warrantyDuration !== undefined &&
        fields.warrantyDuration !== listing.warrantyDuration) ||
      (fields.warrantyUnit !== undefined &&
        fields.warrantyUnit !== listing.warrantyUnit);
    if (warrantyChanged) {
      const effectiveHasWarranty =
        fields.hasWarranty ?? listing.hasWarranty ?? false;
      const effectiveDuration =
        fields.warrantyDuration ?? listing.warrantyDuration ?? null;
      const effectiveUnit =
        fields.warrantyUnit ?? listing.warrantyUnit ?? null;
      if (effectiveHasWarranty === false) {
        payload.warranty = "Sem garantia";
      } else if (
        effectiveHasWarranty === true &&
        effectiveDuration &&
        effectiveUnit
      ) {
        payload.warranty = `Garantia do vendedor: ${effectiveDuration} ${effectiveUnit}`;
      }
    }

    const shippingChanged =
      (fields.shippingMode !== undefined &&
        fields.shippingMode !== listing.shippingMode) ||
      (fields.freeShipping !== undefined &&
        fields.freeShipping !== listing.freeShipping) ||
      (fields.localPickup !== undefined &&
        fields.localPickup !== listing.localPickup);
    if (shippingChanged) {
      payload.shipping = {
        ...(fields.shippingMode ? { mode: fields.shippingMode } : {}),
        ...(fields.freeShipping !== undefined
          ? { free_shipping: fields.freeShipping }
          : {}),
        ...(fields.localPickup !== undefined
          ? { local_pick_up: fields.localPickup }
          : {}),
      };
    }
    if (
      fields.manufacturingTime !== undefined &&
      fields.manufacturingTime !== listing.manufacturingTime
    ) {
      const value = fields.manufacturingTime;
      // ML rejeita "0 dias" ao tentar deletar/setar manufacturing_time:
      //   "Invalid value '0 dias', it should be between 1 and 60 days"
      // Só enviamos sale_terms quando o valor está dentro do range válido.
      // Para "limpar" o tempo de envio, o ML exige um value_id especial
      // que não temos genérico — então simplesmente não tocamos no campo
      // quando o usuário deixa 0.
      if (value !== null && value !== undefined && value >= 1 && value <= 60) {
        payload.sale_terms = [
          {
            id: "MANUFACTURING_TIME",
            value_name: `${value} ${value === 1 ? "dia" : "dias"}`,
          },
        ];
      }
    }

    const listingTypeChanged =
      fields.listingType !== undefined &&
      fields.listingType !== null &&
      fields.listingType !== listing.listingType;

    const descriptionChanged =
      fields.descriptionOverride !== undefined &&
      fields.descriptionOverride !== null;

    // Nada para enviar — apenas persistir caso só listingType foi enviado e
    // já é igual ao atual (no-op).
    if (
      Object.keys(payload).length === 0 &&
      !listingTypeChanged &&
      !descriptionChanged
    ) {
      // Persistir os overrides mesmo sem chamada externa (ex.: usuário só
      // mudou um campo que não vai para a API mas deve ficar gravado).
      await ListingRepository.updateListing(
        listing.id,
        buildListingPersistData(fields),
      );
      return { success: true };
    }

    const skippedByMl: string[] = [];

    if (Object.keys(payload).length > 0) {
      const tryPut = async (
        p: import("../types/ml-api.types").MLItemUpdatePayload,
      ) =>
        MLApiService.updateItem(
          account.accessToken,
          listing.externalListingId,
          p,
        );

      // Loop de retry: cada iteração detecta campos bloqueados pelo ML e os
      // remove do payload. Para até passar OU não ter mais o que retirar.
      let currentPayload: import("../types/ml-api.types").MLItemUpdatePayload =
        { ...payload };
      let succeeded = false;
      const MAX_ATTEMPTS = 4;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          await tryPut(currentPayload);
          succeeded = true;
          break;
        } catch (error) {
          const rawMessage =
            error instanceof Error ? error.message : "Erro desconhecido";
          console.error(
            `[ListingUseCase] ML updateItem attempt ${attempt + 1} failed (listingId=${listing.id}, externalId=${listing.externalListingId}):`,
            rawMessage,
            "payload:",
            JSON.stringify(currentPayload),
          );

          const lower = rawMessage.toLowerCase();
          const blockedThisRound: Array<keyof typeof currentPayload> = [];
          const labelThisRound: string[] = [];

          if (
            lower.includes("cannot modify the title") ||
            lower.includes("family_name")
          ) {
            if ("title" in currentPayload) {
              // Tentativa de republicação para items UP sem vendas/bids:
              // o ML não permite alterar `family_name` (e portanto o título)
              // de items UP existentes, então a única forma de propagar o
              // novo título é criar um anúncio novo e fechar o antigo. Mesmo
              // padrão aplicado em SyncUseCase.republishUpListing. Se a
              // republicação ocorrer, atualizamos listing.externalListingId
              // em memória e seguimos o retry com o payload restante (sem
              // `title`) apontando para o novo anúncio.
              const titleAttempted = String(
                (currentPayload as { title?: string }).title || "",
              );
              let republished = false;
              if (titleAttempted) {
                try {
                  const item = await MLApiService.getItemDetails(
                    account.accessToken,
                    listing.externalListingId,
                  );
                  const isUp = !!(
                    (item as { family_name?: string }).family_name ||
                    (item as { user_product_id?: string }).user_product_id
                  );
                  const soldQty = Number(
                    (item as { sold_quantity?: number }).sold_quantity || 0,
                  );
                  const hasBids = !!(item as { has_bids?: boolean }).has_bids;
                  if (isUp && soldQty === 0 && !hasBids) {
                    const { SyncUseCase } = await import("./sync.usercase");
                    const r = await SyncUseCase.republishUpListing({
                      userId: account.userId,
                      productId: listing.productId,
                      accountId: account.id,
                      accessToken: account.accessToken,
                      oldExternalListingId: listing.externalListingId,
                      currentItem: item,
                      newTitle: titleAttempted,
                    });
                    if (r.republished && r.newExternalListingId) {
                      // Aponta o listing local pro novo MLB-ID; o `tryPut`
                      // lê `listing.externalListingId` lazy a cada call.
                      listing.externalListingId = r.newExternalListingId;
                      delete (currentPayload as { title?: string }).title;
                      republished = true;
                      console.warn(
                        `[ListingUseCase] UP republished durante edit unitário: ${r.newExternalListingId}`,
                      );
                    }
                  } else if (isUp) {
                    console.warn(
                      JSON.stringify({
                        event: "ml.up.republish.skipped",
                        reason: "item_has_sales_or_bids",
                        listingId: listing.id,
                        externalListingId: listing.externalListingId,
                        soldQty,
                        hasBids,
                      }),
                    );
                  }
                } catch (republishErr) {
                  console.warn(
                    "[ListingUseCase] Falha ao tentar republicar UP no edit unitário; vai apenas remover title:",
                    republishErr instanceof Error
                      ? republishErr.message
                      : String(republishErr),
                  );
                }
              }
              if (!republished) {
                blockedThisRound.push("title");
                labelThisRound.push("título (anúncio com family_name)");
              } else {
                // Republicação OK — `title` já foi removido do payload e o
                // listing aponta pro novo MLB-ID. Saímos do catch e seguimos
                // para a próxima iteração do loop: se ainda restam campos
                // (price/attributes/etc.), tryPut tenta no novo anúncio; se
                // o payload ficou vazio, finalizamos com sucesso.
                if (Object.keys(currentPayload).length === 0) {
                  succeeded = true;
                  break;
                }
                continue;
              }
            }
          }
          if (
            lower.includes("warranty") &&
            (lower.includes("deprecated") || lower.includes("not_updatable"))
          ) {
            if ("warranty" in currentPayload) {
              blockedThisRound.push("warranty");
              labelThisRound.push(
                "garantia (campo deprecado pelo ML; mude via atributos da ficha técnica)",
              );
            }
          }
          if (
            lower.includes("condition") &&
            (lower.includes("not modifiable") || lower.includes("not_updatable"))
          ) {
            if ("condition" in currentPayload) {
              blockedThisRound.push("condition");
              labelThisRound.push("condição (anúncio com vendas/ofertas)");
            }
          }
          if (lower.includes("attribute") && lower.includes("invalid")) {
            if ("attributes" in currentPayload) {
              blockedThisRound.push("attributes");
              labelThisRound.push("atributos imutáveis");
            }
          }
          // Rede de segurança: se algum caller mandar shipping em anúncio
          // que não permite alterar (`field_not_modifiable: shipping is not
          // modifiable`), removemos do payload e tentamos novamente sem.
          if (
            lower.includes("shipping") &&
            (lower.includes("not modifiable") ||
              lower.includes("not_updatable") ||
              lower.includes("field_not_updatable"))
          ) {
            if ("shipping" in currentPayload) {
              blockedThisRound.push("shipping");
              labelThisRound.push(
                "frete (anúncio com vendas/ofertas — só pode ser ajustado em anúncios sem vendas)",
              );
            }
          }
          if (
            lower.includes("manufacturing_time") ||
            lower.includes("sale_terms.manufacturing")
          ) {
            if ("sale_terms" in currentPayload) {
              blockedThisRound.push("sale_terms");
              labelThisRound.push(
                "tempo de envio (valor inválido para o ML — use entre 1 e 60 dias)",
              );
            }
          }

          if (blockedThisRound.length === 0) {
            // Erro não conhecido — propaga.
            return {
              success: false,
              error: humanizeMLUpdateError(rawMessage),
            };
          }

          // Remove campos bloqueados e tenta de novo.
          const next: import("../types/ml-api.types").MLItemUpdatePayload =
            { ...currentPayload };
          for (const key of blockedThisRound) {
            delete next[key];
          }
          currentPayload = next;
          skippedByMl.push(...labelThisRound);

          if (Object.keys(currentPayload).length === 0) {
            // Nada sobrou — sair do loop. Os overrides ainda são persistidos.
            console.warn(
              "[ListingUseCase] All fields blocked by ML; nothing to send remotely.",
            );
            succeeded = true;
            break;
          }
        }
      }

      if (!succeeded) {
        return {
          success: false,
          error:
            "Não foi possível atualizar o anúncio no Mercado Livre após várias tentativas.",
        };
      }
    }

    if (descriptionChanged && fields.descriptionOverride) {
      try {
        await MLApiService.upsertDescription(
          account.accessToken,
          listing.externalListingId,
          fields.descriptionOverride,
        );
      } catch (error) {
        const rawMessage =
          error instanceof Error ? error.message : "Erro desconhecido";
        console.error("[ListingUseCase] ML upsertDescription failed:", rawMessage);
        return {
          success: false,
          error: `Falha ao atualizar descrição: ${rawMessage}`,
        };
      }
    }

    if (listingTypeChanged && fields.listingType) {
      try {
        await MLApiService.changeListingType(
          account.accessToken,
          listing.externalListingId,
          fields.listingType,
        );
      } catch (error) {
        const rawMessage =
          error instanceof Error ? error.message : "Erro desconhecido";
        console.error(
          "[ListingUseCase] ML changeListingType failed:",
          rawMessage,
        );
        // Os outros campos (PUT) já foram aplicados — persistir o que deu
        // certo no banco e reportar erro específico do tipo de anúncio.
        await ListingRepository.updateListing(listing.id, {
          ...buildListingPersistData(fields),
          listingType: undefined, // não persiste o listingType porque mudança falhou
        });
        return {
          success: false,
          error: `Demais campos foram salvos, mas não foi possível alterar o tipo do anúncio: ${humanizeMLListingTypeError(rawMessage)}`,
        };
      }
    }

    await ListingRepository.updateListing(
      listing.id,
      buildListingPersistData(fields),
    );

    // Deduplica labels (mesmo campo pode aparecer em rounds diferentes
    // do retry).
    const skipped = Array.from(new Set(skippedByMl));

    if (skipped.length > 0) {
      try {
        await SystemLogService.logWarning(
          "UPDATE_LISTING",
          `Anúncio ML ${listing.externalListingId}: campos bloqueados pelo ML: ${skipped.join(", ")}`,
          {
            userId: listing.product.userId ?? undefined,
            resource: "listing",
            resourceId: listing.id,
            details: { skipped },
          },
        );
      } catch {
        /* ignore */
      }
      return {
        success: true,
        error: `O Mercado Livre não permitiu alterar: ${skipped.join(", ")}. Esses valores ficaram salvos localmente, mas o anúncio público não foi alterado nesses campos (regra do próprio ML).`,
      };
    }

    try {
      await SystemLogService.logInfo(
        "UPDATE_LISTING",
        `Anúncio ML ${listing.externalListingId} atualizado pelo usuário`,
        {
          userId: listing.product.userId ?? undefined,
          resource: "listing",
          resourceId: listing.id,
          details: { fields: Object.keys(payload) },
        },
      );
    } catch (logError) {
      console.warn("[ListingUseCase] Falha ao registrar log:", logError);
    }

    return { success: true };
  }

  /**
   * Atualiza campos de um anúncio Shopee aplicando overrides.
   * Persiste localmente + faz POST /api/v2/product/update_item com title,
   * description, price, dimensões, peso. Categoria é tratada separadamente
   * pois a Shopee só aceita mudança via update_item.
   */
  private static async updateShopeeListingFields(
    listing: NonNullable<Awaited<ReturnType<typeof ListingRepository.findById>>>,
    fields: ListingFullEditInput,
  ): Promise<{ success: boolean; error?: string }> {
    // Reusa marketplaceAccount já incluído no findById.
    const account = listing.marketplaceAccount;
    if (!account || !account.accessToken || !account.shopId) {
      return { success: false, error: "Conta Shopee sem credenciais válidas" };
    }

    if (
      !listing.externalListingId ||
      listing.externalListingId.startsWith("PENDING_")
    ) {
      return {
        success: false,
        error: "Anúncio ainda não foi publicado na Shopee",
      };
    }

    const itemId = Number(listing.externalListingId);
    if (!Number.isFinite(itemId)) {
      return {
        success: false,
        error: "ID externo do anúncio Shopee é inválido",
      };
    }

    type ShopeeUpdate = import("../types/shopee-api.types").ShopeeItemUpdatePayload;
    const payload: ShopeeUpdate = { item_id: itemId };
    let hasItemUpdateField = false;
    let priceToApply: number | null = null;

    if (fields.titleOverride !== undefined && fields.titleOverride !== null) {
      payload.item_name = fields.titleOverride;
      hasItemUpdateField = true;
    }
    if (
      fields.descriptionOverride !== undefined &&
      fields.descriptionOverride !== null
    ) {
      payload.description = fields.descriptionOverride;
      hasItemUpdateField = true;
    }
    if (fields.priceOverride !== undefined && fields.priceOverride !== null) {
      const priceNum = Number(fields.priceOverride);
      if (!Number.isFinite(priceNum) || priceNum <= 0) {
        return {
          success: false,
          error: "Preço inválido para anúncio Shopee (deve ser número positivo)",
        };
      }
      // Preço NÃO vai pelo update_item (Shopee descarta silenciosamente
      // em vários cenários). Vai por update_price abaixo.
      priceToApply = priceNum;
    }
    if (fields.weightKgOverride !== undefined && fields.weightKgOverride !== null) {
      payload.weight = fields.weightKgOverride;
      hasItemUpdateField = true;
    }
    if (
      fields.heightCmOverride !== undefined &&
      fields.widthCmOverride !== undefined &&
      fields.lengthCmOverride !== undefined &&
      fields.heightCmOverride !== null &&
      fields.widthCmOverride !== null &&
      fields.lengthCmOverride !== null
    ) {
      payload.dimension = {
        package_height: fields.heightCmOverride,
        package_width: fields.widthCmOverride,
        package_length: fields.lengthCmOverride,
      };
      hasItemUpdateField = true;
    }

    if (hasItemUpdateField || priceToApply !== null) {
      // Pre-check: status e has_model. Se has_model=true e há mudança de
      // preço, precisamos do model_list para enviar update_price com cada
      // model_id; senão a Shopee só atualiza um modelo "fantasma".
      let currentItem: import("../types/shopee-api.types").ShopeeItem | null =
        null;
      try {
        currentItem = await ShopeeApiService.getItemBaseInfo(
          account.accessToken,
          account.shopId,
          itemId,
        );
      } catch (error) {
        // Falha em getItemBaseInfo não bloqueia — só logamos e seguimos.
        console.warn(
          `[ListingUseCase] Shopee getItemBaseInfo failed (listingId=${listing.id}, itemId=${itemId}):`,
          error instanceof Error ? error.message : error,
        );
      }

      if (currentItem) {
        const blockedStatuses: Array<typeof currentItem.status> = [
          "BANNED",
          "DELETED",
          "REVIEWING",
          "SELLER_DELETED",
        ];
        if (blockedStatuses.includes(currentItem.status)) {
          return {
            success: false,
            error: `Anúncio Shopee em status ${currentItem.status} não aceita edição. Reative o item no painel da Shopee antes.`,
          };
        }
      }

      // 1) Outros campos (title/desc/weight/dimension) via update_item.
      if (hasItemUpdateField) {
        try {
          const response = await ShopeeApiService.updateItem(
            account.accessToken,
            account.shopId,
            payload,
          );
          console.log(
            `[ListingUseCase] Shopee updateItem OK (listingId=${listing.id}, externalId=${listing.externalListingId}):`,
            "status:",
            currentItem?.status ?? "unknown",
            "has_model:",
            currentItem?.has_model ?? "unknown",
            "payload:",
            JSON.stringify(payload),
            "response_keys:",
            Object.keys(response || {}).join(","),
          );
        } catch (error) {
          const rawMessage =
            error instanceof Error ? error.message : "Erro desconhecido";
          console.error(
            `[ListingUseCase] Shopee updateItem failed (listingId=${listing.id}, externalId=${listing.externalListingId}):`,
            rawMessage,
            "payload:",
            JSON.stringify(payload),
          );
          return { success: false, error: rawMessage };
        }
      }

      // 2) Preço via /api/v2/product/update_price (endpoint dedicado).
      // update_item descarta original_price silenciosamente em vários
      // cenários — daí a separação.
      if (priceToApply !== null) {
        try {
          const priceList: Array<{
            model_id?: number;
            original_price: number;
          }> = [];
          if (currentItem?.has_model === true) {
            // Item com variações: aplica o mesmo preço a TODOS os modelos.
            // Lê model_list do currentItem (presente em getItemBaseInfo).
            const models = (currentItem as unknown as {
              model_list?: Array<{ model_id?: number }>;
            }).model_list;
            if (Array.isArray(models) && models.length > 0) {
              for (const m of models) {
                if (typeof m.model_id === "number") {
                  priceList.push({
                    model_id: m.model_id,
                    original_price: priceToApply,
                  });
                }
              }
            }
            if (priceList.length === 0) {
              return {
                success: false,
                error:
                  "Anúncio Shopee tem variações mas não foi possível ler a lista de modelos. Ajuste o preço pelo painel da Shopee.",
              };
            }
          } else {
            priceList.push({ original_price: priceToApply });
          }

          await ShopeeApiService.updatePrice(
            account.accessToken,
            account.shopId,
            itemId,
            priceList,
          );
          console.log(
            `[ListingUseCase] Shopee updatePrice OK (listingId=${listing.id}, externalId=${listing.externalListingId}):`,
            "previous:",
            currentItem?.price_info?.[0]?.current_price ?? "unknown",
            "applied:",
            priceToApply,
            "models:",
            priceList.length,
          );
        } catch (error) {
          const rawMessage =
            error instanceof Error ? error.message : "Erro desconhecido";
          console.error(
            `[ListingUseCase] Shopee updatePrice failed (listingId=${listing.id}, externalId=${listing.externalListingId}):`,
            rawMessage,
            "priceToApply:",
            priceToApply,
          );
          return { success: false, error: rawMessage };
        }
      }
    }

    await ListingRepository.updateListing(
      listing.id,
      buildListingPersistData(fields),
    );

    try {
      await SystemLogService.logInfo(
        "UPDATE_LISTING",
        `Anúncio Shopee ${listing.externalListingId} atualizado pelo usuário`,
        {
          userId: listing.product.userId ?? undefined,
          resource: "listing",
          resourceId: listing.id,
          details: { fields: Object.keys(payload) },
        },
      );
    } catch (logError) {
      console.warn("[ListingUseCase] Falha ao registrar log:", logError);
    }

    return { success: true };
  }
}

/**
 * Constrói o objeto de update para `ListingRepository.updateListing` a partir
 * do `ListingFullEditInput`. Preserva a convenção tristate: undefined = não
 * tocar; null = limpar override; valor = aplicar.
 */
function buildListingPersistData(fields: ListingFullEditInput) {
  return {
    listingType: fields.listingType,
    itemCondition: fields.itemCondition,
    hasWarranty: fields.hasWarranty,
    warrantyUnit: fields.warrantyUnit,
    warrantyDuration: fields.warrantyDuration,
    shippingMode: fields.shippingMode,
    freeShipping: fields.freeShipping,
    localPickup: fields.localPickup,
    manufacturingTime: fields.manufacturingTime,
    titleOverride: fields.titleOverride,
    descriptionOverride: fields.descriptionOverride,
    priceOverride: fields.priceOverride,
    brandOverride: fields.brandOverride,
    modelOverride: fields.modelOverride,
    yearOverride: fields.yearOverride,
    versionOverride: fields.versionOverride,
    categoryOverride: fields.categoryOverride,
    mlCategoryOverride: fields.mlCategoryOverride,
    shopeeCategoryOverride: fields.shopeeCategoryOverride,
    partNumberOverride: fields.partNumberOverride,
    qualityOverride: fields.qualityOverride,
    heightCmOverride: fields.heightCmOverride,
    widthCmOverride: fields.widthCmOverride,
    lengthCmOverride: fields.lengthCmOverride,
    weightKgOverride: fields.weightKgOverride,
    imageUrlsOverride: fields.imageUrlsOverride,
    attributesOverride: fields.attributesOverride,
    compatibilitiesOverride: fields.compatibilitiesOverride,
    sourceVehicleOverride: fields.sourceVehicleOverride,
  };
}

/**
 * Traduz erros do PUT /items do ML em mensagens amigáveis ao usuário.
 * Captura padrões `field_not_updatable: <campo> is not modifiable.` e os
 * reescreve em português, sem expor o JSON cru do ML.
 */
function humanizeMLUpdateError(rawMessage: string): string {
  const fieldNotUpdatableMatch = rawMessage.match(
    /field_not_updatable:\s*(\w+)\s+is not modifiable/i,
  );
  if (fieldNotUpdatableMatch) {
    const field = fieldNotUpdatableMatch[1];
    const friendly: Record<string, string> = {
      condition: "condição (novo/usado)",
      listing_type_id: "tipo de anúncio",
      category_id: "categoria",
      currency_id: "moeda",
    };
    const label = friendly[field] ?? field;
    return `O Mercado Livre não permite alterar ${label} para este anúncio. Geralmente esse campo só pode ser ajustado em anúncios sem vendas/ofertas.`;
  }
  return rawMessage;
}

/**
 * Mensagem específica para falhas em POST /items/{id}/listing_type.
 * O caso mais comum é tentar fazer downgrade (ex.: gold_premium → bronze).
 */
function humanizeMLListingTypeError(rawMessage: string): string {
  if (/forbidden|not.+allowed|invalid.+listing_type/i.test(rawMessage)) {
    return "o Mercado Livre não permitiu essa mudança (geralmente downgrades de tipo de anúncio são bloqueados pelo próprio ML).";
  }
  return rawMessage;
}
