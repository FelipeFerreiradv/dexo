import { OLX_CONSTANTS } from "../olx/olx-constants";
import type { OlxAd, OlxAdType } from "../types/olx-api.types";

/**
 * Monta o `OlxAd` (item do ad_list do autoupload) a partir de um Product do
 * Dexo. Espelha magalu-payload-builder, adaptado ao contrato REAL da OLX
 * (import.html): id=SKU, Subject=título (2-90), Body=descrição (2-6000),
 * price INTEIRO (sem decimais), images[] (máx 20, 1ª=principal).
 *
 * ⚠️ `Phone` e `zipcode` NÃO vêm do produto — são do vendedor/conta. O chamador
 * (usecase) os injeta via `opts`. `category` vem da resolução de categoria.
 */

export interface OlxBuildAdOptions {
  /** Código INTEIRO da categoria OLX (resolução de categoria). */
  categoryId: number;
  /** Telefone do vendedor: 10-11 dígitos (DDD + número). */
  phone: string;
  /** CEP do vendedor (string numérica). */
  zipcode: string;
  /** s=particular, u=profissional. Default "u" (loja Jotabê é PJ/profissional). */
  type?: OlxAdType;
  /** Ocultar telefone no anúncio. */
  phoneHidden?: boolean;
  /** params por-categoria (marca/modelo/ano etc.), quando resolvidos. */
  params?: OlxAd["params"];
}

export class OlxPayloadBuilderService {
  static build(product: any, opts: OlxBuildAdOptions): OlxAd {
    const id = this.buildId(product);
    const subject = this.clampMin(
      String(product?.name ?? "").trim(),
      OLX_CONSTANTS.TITLE_MIN_LENGTH,
      OLX_CONSTANTS.TITLE_MAX_LENGTH,
    );
    const body = this.clampMin(
      String(product?.description ?? product?.name ?? "").trim(),
      OLX_CONSTANTS.DESCRIPTION_MIN_LENGTH,
      OLX_CONSTANTS.DESCRIPTION_MAX_LENGTH,
    );

    return {
      id,
      operation: "insert",
      category: opts.categoryId,
      Subject: subject,
      Body: body,
      Phone: this.sanitizePhone(opts.phone),
      type: opts.type ?? "u",
      price: this.toIntPrice(product?.price),
      zipcode: this.sanitizeDigits(opts.zipcode),
      ...(opts.phoneHidden != null ? { phone_hidden: opts.phoneHidden } : {}),
      ...(opts.params ? { params: opts.params } : {}),
      images: this.collectImages(product),
    };
  }

  /**
   * `id` do ad_list: 1-19 chars [A-Za-z0-9_{}-]. Usa o SKU do produto,
   * sanitizado (chars inválidos viram "_"), truncado a 19. É a chave estável
   * para insert/delete/edição (idempotência). SKU vazio ou > 19 chars ganha um
   * sufixo hash determinístico p/ evitar colisão de prefixo.
   */
  static buildId(product: any): string {
    const raw = String(product?.sku ?? product?.id ?? "").trim();
    const sanitized = raw.replace(/[^A-Za-z0-9_{}-]/g, "_");

    if (sanitized.length > 0 && sanitized.length <= OLX_CONSTANTS.ID_MAX_LENGTH) {
      return sanitized;
    }

    const hashSuffix = OlxPayloadBuilderService.djb2Base36(raw, 4);

    if (sanitized.length === 0) {
      return `sku_${hashSuffix}`;
    }

    const PREFIX_LEN = OLX_CONSTANTS.ID_MAX_LENGTH - 1 - 4; // 14
    return `${sanitized.slice(0, PREFIX_LEN)}_${hashSuffix}`;
  }

  /**
   * Hash djb2 do texto (32 bits não-sinalizado), expresso em base36,
   * zero-padded à esquerda até `len` chars.
   */
  private static djb2Base36(text: string, len: number): string {
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = (Math.imul(h, 33) ^ text.charCodeAt(i)) >>> 0;
    }
    return h.toString(36).padStart(len, "0").slice(-len);
  }

  /** Preço em INTEIRO (a OLX não aceita decimais). Arredonda p/ o real. */
  private static toIntPrice(price: unknown): number {
    const n = Number(price);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }

  /** Garante min-length (pad simples) e max-length (truncagem). */
  private static clampMin(text: string, min: number, max: number): string {
    let t = text;
    if (t.length > max) t = t.slice(0, max);
    // Sem texto suficiente → repete/completa p/ satisfazer o mínimo da OLX.
    while (t.length < min) t = t.length ? `${t} ${t}`.slice(0, max) : "-";
    return t;
  }

  private static sanitizePhone(phone: string): string {
    return this.sanitizeDigits(phone).slice(0, 11);
  }

  private static sanitizeDigits(v: string): string {
    return String(v ?? "").replace(/\D/g, "");
  }

  private static collectImages(product: any): string[] {
    const urls: string[] = [];
    if (product?.imageUrl) urls.push(String(product.imageUrl));
    if (Array.isArray(product?.imageUrls)) {
      for (const u of product.imageUrls) {
        if (u) urls.push(String(u));
      }
    }
    return Array.from(new Set(urls)).slice(0, OLX_CONSTANTS.MAX_IMAGES_PER_AD);
  }
}
