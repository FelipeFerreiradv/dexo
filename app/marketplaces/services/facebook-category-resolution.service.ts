import {
  FACEBOOK_CATEGORY_MAP,
  FACEBOOK_DEFAULT_CATEGORY,
} from "../facebook/facebook-category-map";

/**
 * Resolve o `google_product_category` de um produto para o catálogo Meta.
 *
 * Espelha olx-category-resolution: puramente OFFLINE (de-para curado + default),
 * sem I/O — testável e utilizável sem credenciais. A Meta não expõe árvore de
 * categoria consultável por API; o google_product_category é o sinal padrão.
 *
 * Ordem de confiança:
 *  1. product.fbCategory / product.googleProductCategory explícito — vence.
 *  2. DE-PARA de veículo por palavra no nome (facebook-category-map).
 *  3. FACEBOOK_DEFAULT_CATEGORY (Motor Vehicle Parts — o grosso da Jotabê).
 */
export class FacebookCategoryResolutionService {
  static resolveCategory(product: any): string {
    const explicit = product?.fbCategory ?? product?.googleProductCategory;
    if (typeof explicit === "string" && explicit.trim()) {
      return explicit.trim();
    }

    const mapped = this.lookupCategoryMap(product);
    if (mapped) return mapped;

    return FACEBOOK_DEFAULT_CATEGORY;
  }

  /**
   * De-para de veículo: casa a PALAVRA (word-boundary) no nome do produto — a
   * chave mais longa vence. Ex.: "Retrovisor Moto Honda" casa "moto"; "Suporte
   * do Motor Gol" NÃO casa "moto" (fica no default carro).
   */
  private static lookupCategoryMap(product: any): string | null {
    const name = this.normalize(product?.name);
    if (!name) return null;
    let best: { len: number; value: string } | null = null;
    for (const [rawKey, value] of Object.entries(FACEBOOK_CATEGORY_MAP)) {
      const key = this.normalize(rawKey);
      if (!key || !value) continue;
      const re = new RegExp(
        `\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      );
      if (re.test(name)) {
        if (!best || key.length > best.len) best = { len: key.length, value };
      }
    }
    return best?.value ?? null;
  }

  /** minúsculas, sem acento, trim — para casamento de termos. */
  private static normalize(s: unknown): string {
    return String(s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .trim();
  }
}
