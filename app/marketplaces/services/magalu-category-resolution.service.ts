import { MagaluApiService } from "./magalu-api.service";
import { MAGALU_CONSTANTS } from "../magalu/magalu-constants";
import { MAGALU_CATEGORY_MAP } from "../magalu/magalu-category-map";
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
  /** Atributos OBRIGATÓRIOS que NÃO conseguimos preencher com precisão (não
   *  chutamos — para autopeça, valor errado de Lado/Posição = devolução). O
   *  lojista completa no painel; o create faz fallback p/ sem-categoria se a
   *  Magalu bloquear. */
  missing: string[];
}

export class MagaluCategoryResolutionService {
  /**
   * Resolve o id da categoria, em ordem de confiança:
   *  1. product.magaluCategoryId explícito — vence sempre.
   *  2. DE-PARA curado por tipo de peça (prefixo mais longo do nome) — preciso.
   *  3. busca por nome com TERMO PROGRESSIVO (nome cru → 3 → 2 → 1ª palavra),
   *     porque a busca por similaridade falha com nome específico demais.
   *  4. VIÉS DE DOMÍNIO: entre os resultados, prefere os cujo `path` começa por
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

    const mapped = this.lookupCategoryMap(product);
    if (mapped) return mapped;

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
   * De-para curado: casa o tipo da peça pelo PREFIXO mais longo do nome do
   * produto (normalizado). Ex.: nome "tampa reservatorio renault sandero 2009"
   * casa a chave "tampa reservatorio" (e não a mais curta "tampa").
   */
  private static lookupCategoryMap(product: any): string | null {
    const name = this.normalize(product?.name);
    if (!name) return null;
    let best: { len: number; id: string } | null = null;
    for (const [rawKey, id] of Object.entries(MAGALU_CATEGORY_MAP)) {
      const key = this.normalize(rawKey);
      if (!key || !id) continue;
      if (name === key || name.startsWith(`${key} `)) {
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

    const missing: string[] = [];
    const fill = (attrs: MagaluAttribute[], max: number) =>
      attrs
        .filter((a) => a.required === "required")
        .slice(0, max)
        .map((a) => {
          const value = this.valueFor(a, product);
          if (!value) {
            missing.push(a.name);
            return null;
          }
          return { name: a.name, value };
        })
        .filter((x): x is { name: string; value: string } => x !== null);

    return {
      category: { id: categoryId },
      attributes: fill(variationAttrs, 3),
      datasheet: fill(datasheetAttrs, 50),
      missing,
    };
  }

  /**
   * Valor PRECISO de um atributo a partir do produto. NÃO chuta: required sem
   * fonte confiável volta null (vira `missing`). Lado/Posição saem do NOME do
   * produto (autopeça nomeia "Esquerdo"/"Traseira"); valor errado aqui =
   * cliente recebe peça do lado trocado.
   */
  private static valueFor(
    attr: MagaluAttribute,
    product: any,
  ): string | null {
    const key = `${this.normalize(attr.name)} ${this.normalize(attr.display_name)}`;
    const has = (...terms: string[]) => terms.some((t) => key.includes(t));
    const s = (v: unknown): string | null => {
      const x = String(v ?? "").trim();
      return x ? x : null;
    };

    // montadora/fabricante = marca do veículo.
    if (has("marca", "fabricante", "montadora"))
      return s(product?.brand ?? product?.mlBrand);
    if (has("modelo")) return s(product?.model ?? product?.partNumber);
    if (has("ano")) return s(product?.year);
    if (has("lado")) return this.extractSide(product);
    if (has("posic")) return this.extractPosition(product);
    if (has("cor")) return s(product?.color);
    if (has("material")) return s(product?.material);
    if (has("garantia")) return s(product?.warranty) ?? "3 meses";
    if (has("tamanho")) return s(product?.size);
    if (has("genero", "sexo")) return "Unissex";
    return null; // sem chute: required não-mapeado fica em `missing`.
  }

  /** Lado (esquerdo/direito) extraído do nome do produto. */
  private static extractSide(product: any): string | null {
    const n = this.normalize(product?.name);
    if (/\b(esquerd[oa]|le)\b/.test(n)) return "Esquerdo";
    if (/\b(direit[oa]|ld)\b/.test(n)) return "Direito";
    return null;
  }

  /** Posição (dianteiro/traseiro) extraída do nome do produto. */
  private static extractPosition(product: any): string | null {
    const n = this.normalize(product?.name);
    if (/\b(diant|frontal)/.test(n)) return "Dianteiro";
    if (/\b(tras)/.test(n)) return "Traseiro";
    return null;
  }
}
