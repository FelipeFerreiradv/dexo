import { MagaluApiService } from "./magalu-api.service";
import { MAGALU_CONSTANTS } from "../magalu/magalu-constants";
import type { MagaluAttribute } from "../types/magalu-category.types";

/**
 * Resolve a categoria Magalu de um produto e preenche os atributos OBRIGATÓRIOS
 * (variação + ficha técnica) a partir dos dados do produto, com fallback.
 *
 * Filosofia: best-effort para o SKU sair de DRAFT — preenche o que dá pra mapear
 * com precisão; para required sem mapeamento, usa choices[0] ou o 1º valor do
 * example (quando parece um valor, não uma instrução). `usedFallback` lista o
 * que foi preenchido por fallback, para o lojista revisar depois.
 */

export interface MagaluCategoryFields {
  category: { id: string };
  attributes: Array<{ name: string; value: string }>;
  datasheet: Array<{ name: string; value: string }>;
  usedFallback: string[];
}

export class MagaluCategoryResolutionService {
  /**
   * Resolve o id da categoria:
   *  1. product.magaluCategoryId explícito (mapa do lojista) — vence sempre.
   *  2. busca por nome com TERMO PROGRESSIVO (nome cru → 3 → 2 → 1ª palavra),
   *     porque a busca por similaridade falha com nome específico demais.
   *  3. VIÉS DE DOMÍNIO: entre os resultados, prefere os cujo `path` começa por
   *     CATEGORY_ROOT_HINT (ex.: "Veículos e Peças"). Sem match no domínio →
   *     retorna null (SKU fica em DRAFT; não categoriza errado).
   * Com o hint vazio ("") cai no comportamento simples (1º resultado).
   */
  static async resolveCategoryId(
    accessToken: string,
    product: any,
  ): Promise<string | null> {
    const explicit = product?.magaluCategoryId;
    if (explicit) return String(explicit);

    const hint = String(
      product?.magaluCategoryRootHint ?? MAGALU_CONSTANTS.CATEGORY_ROOT_HINT,
    )
      .trim()
      .toLowerCase();

    for (const term of this.searchTerms(product)) {
      const cats = await MagaluApiService.searchCategories(accessToken, {
        name: term,
      });
      if (!cats.length) continue;
      if (!hint) return cats[0].id;
      const inDomain = cats.find((c) =>
        String(c.path ?? "")
          .toLowerCase()
          .startsWith(hint),
      );
      if (inDomain) return inDomain.id;
      // termo achou resultados mas nenhum no domínio → tenta termo mais curto.
    }
    return null;
  }

  /** Termos de busca, do mais específico ao mais genérico (dedup). */
  private static searchTerms(product: any): string[] {
    const name = String(product?.name ?? "").trim();
    if (!name) return [];
    const words = name.split(/\s+/).filter(Boolean);
    const candidates = [
      name,
      words.slice(0, 3).join(" "),
      words.slice(0, 2).join(" "),
      words[0],
    ].filter((t): t is string => Boolean(t));
    return Array.from(new Set(candidates));
  }

  /**
   * Monta { category, attributes, datasheet } com os atributos OBRIGATÓRIOS da
   * categoria preenchidos do produto. attributes (variação) ≤3, datasheet ≤50.
   */
  static async buildCategoryFields(
    accessToken: string,
    categoryId: string,
    product: any,
  ): Promise<MagaluCategoryFields> {
    const [variationAttrs, datasheetAttrs] = await Promise.all([
      MagaluApiService.getCategoryAttributes(accessToken, categoryId, true),
      MagaluApiService.getCategoryDatasheet(accessToken, categoryId, true),
    ]);

    const usedFallback: string[] = [];
    const fill = (attrs: MagaluAttribute[], max: number) =>
      attrs
        .filter((a) => a.required === "required")
        .slice(0, max)
        .map((a) => {
          const { value, fallback } = this.valueFor(a, product);
          if (value && fallback) usedFallback.push(a.name);
          return value ? { name: a.name, value } : null;
        })
        .filter((x): x is { name: string; value: string } => x !== null);

    return {
      category: { id: categoryId },
      attributes: fill(variationAttrs, 3),
      datasheet: fill(datasheetAttrs, 50),
      usedFallback,
    };
  }

  private static valueFor(
    attr: MagaluAttribute,
    product: any,
  ): { value: string | null; fallback: boolean } {
    const norm = (s: unknown) =>
      String(s ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .trim();
    const key = `${norm(attr.name)} ${norm(attr.display_name)}`;
    const has = (...terms: string[]) => terms.some((t) => key.includes(t));
    const s = (v: unknown): string | null => {
      const x = String(v ?? "").trim();
      return x ? x : null;
    };

    // Mapeamentos precisos a partir do produto Dexo.
    let mapped: string | null = null;
    if (has("marca", "fabricante"))
      mapped = s(product?.brand ?? product?.mlBrand);
    else if (has("modelo"))
      mapped = s(product?.model ?? product?.partNumber ?? product?.sku);
    else if (has("cor")) mapped = s(product?.color);
    else if (has("material")) mapped = s(product?.material);
    else if (has("garantia")) mapped = s(product?.warranty) ?? "3 meses";
    else if (has("tamanho")) mapped = s(product?.size);
    else if (has("ano")) mapped = s(product?.year);
    else if (has("genero", "sexo")) mapped = "Unissex";

    if (mapped) return { value: mapped, fallback: false };

    // Fallback: 1ª choice, ou 1º valor do example quando parece um valor.
    if (Array.isArray(attr.choices) && attr.choices.length) {
      return { value: String(attr.choices[0]), fallback: true };
    }
    const ex = String(attr.example ?? "").trim();
    if (ex.includes(",")) {
      return { value: ex.split(",")[0].trim(), fallback: true };
    }
    if (ex && ex.length <= 40) {
      return { value: ex, fallback: true };
    }
    return { value: null, fallback: false };
  }
}
