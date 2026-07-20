import {
  OLX_CATEGORY_MAP,
  OLX_DEFAULT_CATEGORY_ID,
} from "../olx/olx-category-map";

/**
 * Resolve o código INTEIRO de categoria OLX de um produto.
 *
 * Espelha magalu-category-resolution, mas SIMPLIFICADO: a OLX usa códigos
 * inteiros fixos (não uma árvore consultável por nome via API como a Magalu),
 * então a resolução é puramente OFFLINE — de-para curado + default. Isso também
 * a torna testável e utilizável sem credenciais (não faz I/O).
 *
 * Na OLX a `category` de autopeça é o TIPO DE VEÍCULO (2101 carros / 2102
 * caminhões / 2103 motos / 2104 barcos / 2105 ônibus); o tipo de peça vai nos
 * `params`. Ordem de confiança:
 *  1. product.olxCategoryId explícito — vence sempre.
 *  2. DE-PARA de veículo por palavra no nome (olx-category-map).
 *  3. OLX_DEFAULT_CATEGORY_ID (2101 carros — o grosso da Jotabê).
 */
export class OlxCategoryResolutionService {
  static resolveCategoryId(product: any): number | null {
    const explicit = product?.olxCategoryId;
    if (explicit != null && Number.isFinite(Number(explicit))) {
      return Number(explicit);
    }

    const mapped = this.lookupCategoryMap(product);
    if (mapped != null) return mapped;

    return OLX_DEFAULT_CATEGORY_ID;
  }

  /**
   * De-para de veículo: casa a PALAVRA (word-boundary) no nome do produto — a
   * chave mais longa vence. Ex.: "Retrovisor Moto Honda" casa "moto" (2103);
   * "Suporte do Motor Gol" NÃO casa "moto" (fica no default carro).
   */
  private static lookupCategoryMap(product: any): number | null {
    const name = this.normalize(product?.name);
    if (!name) return null;
    let best: { len: number; id: number } | null = null;
    for (const [rawKey, id] of Object.entries(OLX_CATEGORY_MAP)) {
      const key = this.normalize(rawKey);
      if (!key || id == null) continue;
      const re = new RegExp(
        `\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      );
      if (re.test(name)) {
        if (!best || key.length > best.len) best = { len: key.length, id };
      }
    }
    return best?.id ?? null;
  }

  /** minúsculas, sem acento, trim — para casamento de termos. */
  private static normalize(s: unknown): string {
    return String(s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .trim();
  }

  /**
   * `params` por-categoria do anúncio de autopeça OLX. Chaves REAIS do portal
   * (/anuncio/api/autoparts, 2026-07-20):
   *   - condition (ÚNICO obrigatório): "1"=Novo, "2"=Usado.
   *   - parts_name_cars | parts_name_motos | parts_name_boats: tipo de peça; a
   *     chave depende do veículo (categoria). Valor genérico "peça" por veículo.
   * Opcionais (carcolor, exchange) são omitidos: valor errado em autopeça vira
   * devolução, e a OLX rejeita param enviado vazio/0.
   */
  static buildAdParams(
    product: any,
    categoryId: number,
  ): Record<string, string> {
    const params: Record<string, string> = {
      condition: this.mapCondition(product?.quality),
    };
    const partKey = this.partsNameKey(categoryId);
    if (partKey) params[partKey] = this.defaultPartValue(categoryId);
    return params;
  }

  /** Novo → "1"; qualquer outro (usado/sucata/desmonte) → "2". */
  private static mapCondition(quality?: string): string {
    return String(quality ?? "").toUpperCase() === "NOVO" ? "1" : "2";
  }

  /** Chave de tipo-de-peça conforme o veículo da categoria. */
  private static partsNameKey(categoryId: number): string | null {
    switch (categoryId) {
      case 2103:
        return "parts_name_motos";
      case 2104:
        return "parts_name_boats";
      case 2101:
      case 2102:
      case 2105:
        return "parts_name_cars";
      default:
        return null; // categoria não-autopeça conhecida → sem parts_name
    }
  }

  /** Valor genérico "peça" por veículo (opções da tabela do portal). */
  private static defaultPartValue(categoryId: number): string {
    if (categoryId === 2103) return "10"; // Peças de motos
    if (categoryId === 2104) return "11"; // Barcos: Outros (sem genérico "peças")
    return "4"; // Carros/caminhões/ônibus: Peças automotivas
  }
}
