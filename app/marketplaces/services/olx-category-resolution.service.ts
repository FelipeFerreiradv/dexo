import {
  OLX_CATEGORY_MAP,
  OLX_DEFAULT_CATEGORY_ID,
} from "../olx/olx-category-map";
import { tabelaDePecaDaCategoria } from "../olx/olx-part-map";

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
    const tabela = tabelaDePecaDaCategoria(categoryId);
    if (tabela) params[tabela.chave] = this.resolvePartValue(product, categoryId);
    return params;
  }

  /**
   * Tipo de peça (`parts_name_*`) a partir do nome do produto.
   *
   * Era uma constante: toda peça de carro saía como "4" (Peças automotivas).
   * Medido no catálogo real, isso está CERTO para 98,4% — a tabela da OLX é
   * comercial e grossa, e maçaneta/farol/motor/freio são mesmo "Peças
   * automotivas". O que se ganha são os 1,64% que a OLX separa no filtro e que
   * hoje se escondem no genérico: pneus, rodas, calotas, som e GPS.
   *
   * ⚠️ NÃO-REGRESSÃO: sem casamento, devolve o MESMO valor de antes. O payload
   * de 98,4% dos anúncios continua byte a byte idêntico.
   */
  static resolvePartValue(product: any, categoryId: number): string {
    const tabela = tabelaDePecaDaCategoria(categoryId);
    if (!tabela) return "";
    return this.lookupNoMapa(product, tabela.mapa) ?? tabela.padrao;
  }

  /** Mesmo casamento por palavra do de-para de veículo: chave mais longa vence. */
  private static lookupNoMapa(
    product: any,
    mapa: Record<string, string>,
  ): string | null {
    const name = this.normalize(product?.name);
    if (!name) return null;
    let best: { len: number; value: string } | null = null;
    for (const [rawKey, value] of Object.entries(mapa)) {
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

  /** Novo → "1"; qualquer outro (usado/sucata/desmonte) → "2". */
  private static mapCondition(quality?: string): string {
    return String(quality ?? "").toUpperCase() === "NOVO" ? "1" : "2";
  }

}
