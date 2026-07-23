import { FACEBOOK_CONSTANTS } from "../facebook/facebook-constants";
import type {
  FacebookAvailability,
  FacebookCatalogItemData,
  FacebookCondition,
} from "../types/facebook-api.types";

/**
 * Monta o `data` do item de catálogo Meta a partir de um Product do Dexo.
 * Espelha olx-payload-builder, adaptado ao contrato do Graph Catalog:
 * retailer_id=SKU, name (≤200), description, price "<amount> <currency>",
 * image_url + additional_image_urls (máx 20), brand, google_product_category.
 *
 * ⚠️ O item de catálogo EXIGE `link` (URL da página do produto). O Dexo não tem
 * vitrine pública por produto, então o `link` aponta para a PÁGINA FIXA do
 * vendedor no Facebook (FB_PRODUCT_URL_BASE) — sem sufixo /sku. Sem a base
 * configurada o build lança erro CLARO (o publish real fica bloqueado).
 */

export interface FacebookBuildItemOptions {
  /** google_product_category (resolução de categoria). */
  googleProductCategory: string;
  /** Disponibilidade inicial. Default "in stock". */
  availability?: FacebookAvailability;
  /** Quantidade a vender no Facebook (espelha o estoque). */
  quantity?: number;
}

export class FacebookPayloadBuilderService {
  static build(
    product: any,
    opts: FacebookBuildItemOptions,
  ): FacebookCatalogItemData {
    const name = this.clampMax(
      String(product?.name ?? "").trim(),
      FACEBOOK_CONSTANTS.TITLE_MAX_LENGTH,
    );
    const description = this.clampMax(
      String(product?.description ?? product?.name ?? "").trim(),
      FACEBOOK_CONSTANTS.DESCRIPTION_MAX_LENGTH,
    );
    const images = this.collectImages(product);

    const data: FacebookCatalogItemData = {
      name,
      description: description || name || "-",
      availability: opts.availability ?? "in stock",
      condition: this.mapCondition(product),
      price: this.buildPrice(product?.price),
      currency: FACEBOOK_CONSTANTS.CURRENCY,
      link: this.buildLink(product),
      google_product_category: opts.googleProductCategory,
    };

    if (images.length > 0) {
      data.image_url = images[0];
      if (images.length > 1) data.additional_image_urls = images.slice(1);
    }
    const brand = String(product?.brand ?? "").trim();
    if (brand) data.brand = brand;
    if (opts.quantity != null) {
      data.quantity_to_sell_on_facebook = Math.max(
        0,
        Math.trunc(opts.quantity),
      );
    }

    return data;
  }

  /**
   * retailer_id do item: usa o SKU do produto (chave estável para
   * CREATE/UPDATE/DELETE). Sanitiza chars problemáticos e trunca ≤100.
   */
  static buildRetailerId(product: any): string {
    const raw = String(product?.sku ?? product?.id ?? "").trim();
    const safe = raw
      .replace(/[^A-Za-z0-9_.\-]/g, "_")
      .slice(0, FACEBOOK_CONSTANTS.RETAILER_ID_MAX_LENGTH);
    return safe || "sku";
  }

  /**
   * Monta o `link` do item de catálogo. EXIGIDO pela Meta. O Dexo não tem
   * página pública por produto → todos os itens apontam para a PÁGINA FIXA do
   * vendedor (FB_PRODUCT_URL_BASE), sem sufixo /sku. Sem a base configurada,
   * lança erro claro (bloqueio conhecido).
   */
  static buildLink(_product?: any): string {
    // Lê o env em call-time (não do const capturado no import) p/ permitir setar
    // sem redeploy.
    const base = (
      process.env.FB_PRODUCT_URL_BASE ||
      FACEBOOK_CONSTANTS.PRODUCT_URL_BASE ||
      ""
    ).replace(/\/+$/, "");
    if (!base) {
      throw new Error(
        "FB_PRODUCT_URL_BASE não configurada — o item de catálogo Meta exige `link` (URL da página do produto).",
      );
    }
    return base;
  }

  /** Preço no formato "<amount> <currency>" (ex.: "199.90 BRL"). */
  private static buildPrice(price: unknown): string {
    const n = Number(price);
    const amount = Number.isFinite(n) && n > 0 ? n : 0;
    return `${amount.toFixed(2)} ${FACEBOOK_CONSTANTS.CURRENCY}`;
  }

  /** itemCondition/quality do Dexo → condition da Meta. */
  private static mapCondition(product: any): FacebookCondition {
    const raw = String(product?.itemCondition ?? product?.quality ?? "")
      .toUpperCase()
      .trim();
    if (raw === "NOVO" || raw === "NEW") return "new";
    if (raw === "RECONDICIONADO" || raw === "REFURBISHED") return "refurbished";
    return "used";
  }

  private static clampMax(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) : text;
  }

  private static collectImages(product: any): string[] {
    const urls: string[] = [];
    if (product?.imageUrl) urls.push(String(product.imageUrl));
    if (Array.isArray(product?.imageUrls)) {
      for (const u of product.imageUrls) {
        if (u) urls.push(String(u));
      }
    }
    return Array.from(new Set(urls)).slice(
      0,
      FACEBOOK_CONSTANTS.MAX_IMAGES_PER_ITEM,
    );
  }
}
