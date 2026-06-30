import { MAGALU_CONSTANTS } from "../magalu/magalu-constants";

/**
 * Monta o payload de criação de SKU no portfólio da Magalu a partir de um
 * Product do Dexo (POST /seller/v1/portfolios/skus).
 *
 * Schema VALIDADO contra a doc/API real (2026-06-29):
 *  - SEM price/quantity (preço e estoque são serviços separados).
 *  - `group.id` (obrigatório) e `channels[].id` (obrigatório, exatamente 1) são
 *    IDs da taxonomia/canal do seller → vêm via `opts` (resolução de categoria/
 *    canal é responsabilidade do chamador).
 *  - `category` é OPCIONAL (anyOf null) — só inclui se vier.
 *  - `dimensions`: exatamente 2 entradas (product + package), cada eixo {unit,value}.
 *  - `images`: >=1, { reference, type:"image/jpeg" } (único type aceito).
 *  - `identifiers` + `has_ean`: sem EAN → identifiers [] e has_ean false.
 *  - `condition`: NEW/USED/REMANUFACTURED (desmonte/sucata → USED).
 */

export interface MagaluCreateSkuOptions {
  /** group.id (obrigatório pela API) — taxonomia de produto da Magalu. */
  groupId: string;
  /** channels[].id (obrigatório, exatamente 1) — canal de venda do seller. */
  channelId: string;
  /** category.id (opcional). */
  categoryId?: string;
}

interface MagaluMeasure {
  unit: string;
  value: number;
}
interface MagaluDimension {
  name: "product" | "package";
  height: MagaluMeasure;
  length: MagaluMeasure;
  width: MagaluMeasure;
  weight: MagaluMeasure;
}

export interface MagaluSkuPayload {
  active: boolean;
  attributes: Array<{ name: string; value: string }>;
  brand: string;
  category?: { id: string };
  channels: Array<{ id: string }>;
  condition: "NEW" | "USED" | "REMANUFACTURED";
  datasheet: Array<{ name: string; value: string }>;
  description: string;
  dimensions: MagaluDimension[];
  extra_data: Array<{ name: string; value: string }>;
  fulfillment: boolean;
  group: { id: string; main_variation: boolean };
  has_ean: boolean;
  identifiers: Array<{ type: "ean" | "isbn"; value: string }>;
  images: Array<{ reference: string; type: "image/jpeg" }>;
  perishable: boolean;
  podcasts: Array<{ reference: string; type: string }>;
  sku: string;
  title: string;
  type: "product";
  videos: Array<{ reference: string; type: string }>;
}

export class MagaluPayloadBuilderService {
  static build(product: any, opts: MagaluCreateSkuOptions): MagaluSkuPayload {
    const clamp = (text: string, max: number) =>
      text && text.length > max ? text.slice(0, max) : text;

    const ean = String(product?.ean ?? product?.gtin ?? "").trim();
    const ncm = String(product?.ncm ?? "").trim();
    const brand =
      String(
        product?.brand ?? product?.mlBrand ?? product?.vehicleBrand ?? "",
      ).trim() || "Genérico";

    return {
      active: true,
      // Atributos por categoria — vazio por ora (TBD: preencher conforme a
      // categoria/ficha técnica exigir, via API de Categorias e Atributos).
      attributes: [],
      brand: clamp(brand, 100),
      ...(opts.categoryId ? { category: { id: opts.categoryId } } : {}),
      channels: [{ id: opts.channelId }],
      condition: this.mapCondition(product?.quality),
      datasheet: [],
      description: clamp(
        String(product?.description ?? product?.name ?? ""),
        MAGALU_CONSTANTS.DESCRIPTION_MAX_LENGTH,
      ),
      dimensions: this.buildDimensions(product),
      extra_data: ncm ? [{ name: "ncm", value: clamp(ncm, 50) }] : [],
      fulfillment: false,
      group: { id: opts.groupId, main_variation: true },
      has_ean: Boolean(ean),
      identifiers: ean ? [{ type: "ean", value: ean }] : [],
      images: this.collectImages(product).map((reference) => ({
        reference,
        type: "image/jpeg" as const,
      })),
      perishable: false,
      podcasts: [],
      sku: clamp(String(product?.sku ?? ""), 32),
      title: clamp(String(product?.name ?? ""), MAGALU_CONSTANTS.TITLE_MAX_LENGTH),
      type: "product",
      videos: [],
    };
  }

  /** Desmonte/sucata → USED; "novo" → NEW. Default USED (perfil do cliente). */
  private static mapCondition(
    quality?: string,
  ): "NEW" | "USED" | "REMANUFACTURED" {
    return String(quality ?? "").toUpperCase() === "NOVO" ? "NEW" : "USED";
  }

  /** Exatamente 2 dimensões (product + package). Peso em GRAMAS, eixos em cm. */
  private static buildDimensions(product: any): MagaluDimension[] {
    const cm = (v: unknown, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const grams = () => {
      const kg = Number(product?.weightKg);
      return Number.isFinite(kg) && kg > 0 ? Math.round(kg * 1000) : 500;
    };
    const make = (name: "product" | "package"): MagaluDimension => ({
      name,
      height: { unit: "cm", value: cm(product?.heightCm, 10) },
      length: { unit: "cm", value: cm(product?.lengthCm, 10) },
      width: { unit: "cm", value: cm(product?.widthCm, 10) },
      weight: { unit: "g", value: grams() },
    });
    return [make("product"), make("package")];
  }

  private static collectImages(product: any): string[] {
    const urls: string[] = [];
    if (product?.imageUrl) urls.push(String(product.imageUrl));
    if (Array.isArray(product?.imageUrls)) {
      for (const u of product.imageUrls) {
        if (u) urls.push(String(u));
      }
    }
    return Array.from(new Set(urls)).slice(0, MAGALU_CONSTANTS.MAX_IMAGES_PER_SKU);
  }
}
