import { MAGALU_CONSTANTS } from "../magalu/magalu-constants";

/**
 * Monta o payload de criação de SKU no portfólio da Magalu a partir de um
 * Product do Dexo.
 *
 * Decisão (Entrega E): criação direta no portfólio (POST /seller/v1/portfolios/skus)
 * SEM exigir EAN — boa parte do estoque (peças de desmonte/sucata) não tem GTIN.
 * O `ean` só é incluído quando existe.
 *
 * ATENÇÃO: o contrato EXATO do payload da Magalu não pôde ser confirmado sem
 * Sandbox. Os nomes de campos seguem o padrão documentado e estão marcados como
 * TBD; os atributos obrigatórios variam por categoria e devem ser validados.
 */
export interface MagaluSkuPayload {
  title: string;
  description?: string;
  sku: string;
  ean?: string;
  price: number;
  quantity: number;
  category_id?: string;
  images: string[];
  attributes?: Record<string, unknown>;
  dimensions?: {
    weight?: number;
    height?: number;
    width?: number;
    length?: number;
  };
}

export class MagaluPayloadBuilderService {
  static build(product: any, categoryId?: string): MagaluSkuPayload {
    const clamp = (text: string, max: number) =>
      text && text.length > max ? text.slice(0, max) : text;

    const images = this.collectImages(product);

    const ean =
      (product?.ean as string) || (product?.gtin as string) || undefined;

    return {
      title: clamp(String(product?.name ?? ""), MAGALU_CONSTANTS.TITLE_MAX_LENGTH),
      description: clamp(
        String(product?.description ?? product?.name ?? ""),
        MAGALU_CONSTANTS.DESCRIPTION_MAX_LENGTH,
      ),
      sku: String(product?.sku ?? ""),
      // SEM EAN passa (opcional). Só inclui quando existe.
      ...(ean ? { ean } : {}),
      price: Number(product?.price ?? 0),
      quantity: Number(product?.stock ?? 0),
      category_id: categoryId ?? product?.magaluCategoryId ?? undefined,
      images,
      // TODO(categoria): atributos obrigatórios variam por categoria — validar
      // no Sandbox e preencher conforme getCategoryAttributes.
      attributes: {},
      dimensions: {
        weight: this.toNumberOrUndefined(product?.weightKg),
        height: this.toNumberOrUndefined(product?.heightCm),
        width: this.toNumberOrUndefined(product?.widthCm),
        length: this.toNumberOrUndefined(product?.lengthCm),
      },
    };
  }

  private static collectImages(product: any): string[] {
    const urls: string[] = [];
    if (product?.imageUrl) urls.push(String(product.imageUrl));
    if (Array.isArray(product?.imageUrls)) {
      for (const u of product.imageUrls) {
        if (u) urls.push(String(u));
      }
    }
    // Dedup preservando a ordem, limitado ao máximo de imagens por SKU.
    return Array.from(new Set(urls)).slice(0, MAGALU_CONSTANTS.MAX_IMAGES_PER_SKU);
  }

  private static toNumberOrUndefined(value: unknown): number | undefined {
    if (value == null) return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
}
