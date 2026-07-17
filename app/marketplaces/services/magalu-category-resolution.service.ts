import { MagaluApiService } from "./magalu-api.service";
import { MAGALU_CONSTANTS } from "../magalu/magalu-constants";
import { MAGALU_CATEGORY_MAP } from "../magalu/magalu-category-map";
import { extractPartType, extractPosition } from "../lib/title-parse";
import { AMBIGUOUS_LABELS } from "../lib/category-inference/map-generation";
import {
  basePartTypeKey,
  lookupPartTypeCategory,
} from "../lib/category-inference/part-type-category-map";
import { isCompoundTitle } from "../lib/category-inference/title-guards";
import type {
  MagaluAttribute,
  MagaluCategory,
} from "../types/magalu-category.types";

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

/**
 * Cache por TERMO da busca ao vivo de categorias (a taxonomia da Magalu é
 * global do marketplace, não por seller — se um 2º seller com árvore própria
 * aparecer, chavear a cache por conta). TTL curto: taxonomia muda raramente,
 * mas não vale arriscar categoria extinta em cache longo.
 */
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX = 500;
const searchCache = new Map<string, { data: MagaluCategory[]; exp: number }>();

export class MagaluCategoryResolutionService {
  /**
   * Resolve o id da categoria, em ordem de confiança:
   *  1.   product.magaluCategoryId explícito — vence sempre.
   *  2.   DE-PARA curado por tipo de peça (prefixo mais longo do nome) — preciso.
   *  2.5. Mapa do motor de inferência por TIPO DE PEÇA extraído do título
   *       (não exige prefixo — pega "Par de Faróis Palio"). Resolve sem
   *       nenhuma chamada de API quando a entrada tem magaluId curado.
   *  3.   busca por nome com TERMO PROGRESSIVO, agora liderada pelos termos
   *       CANÔNICOS do tipo de peça ("cubo de roda" antes do nome cru — a
   *       busca por similaridade da Magalu acerta muito mais com o termo
   *       canônico do que com título específico demais).
   *  4.   VIÉS DE DOMÍNIO: entre os resultados, prefere os cujo `path` começa
   *       por CATEGORY_ROOT_HINT (ex.: "Veículos e Peças"). Sem match no
   *       domínio → retorna null (SKU fica em DRAFT; não categoriza errado).
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

    const inference = this.partTypeInference(product);
    if (inference?.hit?.entry.magaluId)
      return String(inference.hit.entry.magaluId);

    // normalize() (sem acento) nos DOIS lados — a árvore real pode vir com
    // acentuação/casing divergente; comparar acento-insensível evita perder o
    // domínio e deixar tudo em DRAFT.
    const hint = this.normalize(
      product?.magaluCategoryRootHint ?? MAGALU_CONSTANTS.CATEGORY_ROOT_HINT,
    );

    for (const term of this.searchTerms(product, inference)) {
      const cats = await this.searchCategoriesCached(accessToken, term);
      if (!cats.length) continue;
      if (!hint) return cats[0].id;
      const inDomain = cats.find((c) =>
        this.normalize(c.path).startsWith(hint),
      );
      if (inDomain) return inDomain.id;
      // termo achou resultados mas nenhum no domínio → tenta termo mais curto.
    }
    return null;
  }

  /**
   * Filtro SOFT de nicho por CATEGORY_ROOT_HINT para a BUSCA MANUAL de
   * categorias: mantém os resultados cujo `path` começa pelo hint. Se isso
   * esvaziar uma lista não-vazia (ou o hint estiver vazio), devolve a lista
   * crua (fail-open-to-raw) — não sumir categoria legítima. Casa a busca
   * manual com a resolução automática (resolveCategoryId), que já usa o hint.
   */
  static filterCategoriesByRootHint(
    cats: MagaluCategory[],
    hintOverride?: string,
  ): MagaluCategory[] {
    const hint = this.normalize(
      hintOverride ?? MAGALU_CONSTANTS.CATEGORY_ROOT_HINT,
    );
    if (!hint || !cats.length) return cats;
    const inDomain = cats.filter((c) =>
      this.normalize(c.path).startsWith(hint),
    );
    return inDomain.length > 0 ? inDomain : cats;
  }

  /**
   * Tipo de peça extraído do título + entrada do mapa de inferência. null
   * quando o tipo é desconhecido, ambíguo ("tampa", "suporte") ou o título é
   * COMPOSTO (componente de outra peça — "REATOR farol" não pode virar busca
   * por "farol": o viés de domínio não salvaria, Faróis está no domínio).
   */
  private static partTypeInference(product: any) {
    const name = String(product?.name ?? "");
    const folded = extractPartType(name);
    if (!folded) return null;
    const position = extractPosition(name);
    const baseLabel = basePartTypeKey(folded, position);
    if (AMBIGUOUS_LABELS.has(baseLabel)) return null;
    if (isCompoundTitle(name, folded)) return null;
    return {
      baseLabel,
      hit: lookupPartTypeCategory(folded, position),
    };
  }

  /**
   * Termos de busca, do mais específico ao mais genérico (dedup). Termos
   * canônicos do tipo de peça vêm PRIMEIRO (magaluTerm curado, depois o
   * label-base de-kebabado: "cubo-de-roda" → "cubo de roda"); a cauda atual
   * (nome cru → 3 → 2 → 1ª palavra) permanece como fallback integral.
   */
  private static searchTerms(
    product: any,
    inference: ReturnType<
      typeof MagaluCategoryResolutionService.partTypeInference
    > = null,
  ): string[] {
    const name = String(product?.name ?? "").trim();
    if (!name) return [];
    const words = name.split(/\s+/).filter(Boolean);
    const canonical: string[] = [];
    if (inference) {
      if (inference.hit?.entry.magaluTerm)
        canonical.push(inference.hit.entry.magaluTerm);
      canonical.push(inference.baseLabel.replace(/-/g, " "));
    }
    const candidates = [
      ...canonical,
      name,
      words.slice(0, 3).join(" "),
      words.slice(0, 2).join(" "),
      words[0],
    ].filter((t): t is string => Boolean(t));
    return Array.from(new Set(candidates));
  }

  /** Busca ao vivo com cache Map+TTL por termo normalizado. */
  private static async searchCategoriesCached(
    accessToken: string,
    term: string,
  ): Promise<MagaluCategory[]> {
    const key = this.normalize(term);
    const cached = searchCache.get(key);
    if (cached && cached.exp > Date.now()) return cached.data;
    const cats = await MagaluApiService.searchCategories(accessToken, {
      name: term,
    });
    if (searchCache.size >= SEARCH_CACHE_MAX) {
      const first = searchCache.keys().next().value;
      if (first !== undefined) searchCache.delete(first);
    }
    searchCache.set(key, { data: cats, exp: Date.now() + SEARCH_CACHE_TTL_MS });
    return cats;
  }

  /** Apenas para testes — limpa o cache de busca por termo. */
  static __clearSearchCache() {
    searchCache.clear();
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
    // Mapeia TODOS os required PRIMEIRO (registrando os sem valor em `missing`),
    // e só então aplica o limite da API — assim um required preenchível além do
    // índice `max` não é descartado antes de ser tentado. O que tiver valor mas
    // estourar o limite também entra em `missing` (visibilidade pro lojista).
    const fill = (attrs: MagaluAttribute[], max: number) => {
      const filled: Array<{ name: string; value: string }> = [];
      for (const a of attrs.filter((x) => x.required === "required")) {
        const value = this.valueFor(a, product);
        if (value) filled.push({ name: a.name, value });
        else missing.push(a.name);
      }
      if (filled.length > max) {
        for (const f of filled.slice(max)) missing.push(f.name);
      }
      return filled.slice(0, max);
    };

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
    // "ano" ANTES de "modelo": um campo combinado "Ano/Modelo" deve virar ano,
    // não o modelo (has() é substring, "ano/modelo" contém "modelo").
    if (has("ano")) return s(product?.year);
    if (has("modelo")) return s(product?.model ?? product?.partNumber);
    if (has("lado")) return this.extractSide(product);
    if (has("posic")) return this.extractPosition(product);
    if (has("cor")) return s(product?.color);
    if (has("material")) return s(product?.material);
    if (has("garantia")) return s(product?.warranty) ?? "3 meses";
    if (has("tamanho")) return s(product?.size);
    return null; // sem chute: required não-mapeado fica em `missing`.
  }

  /**
   * Lado extraído do nome — SÓ por extenso (esquerdo/direito). Abreviações
   * "le"/"ld" são ambíguas demais p/ um campo crítico (Lado errado = devolução;
   * ex.: "Le Mans" → falso "Esquerdo"); sem extenso → null → `missing` (lojista
   * confirma). Nome com AMBOS os lados (par) → null (ambíguo).
   */
  private static extractSide(product: any): string | null {
    const n = this.normalize(product?.name);
    const left = /\b(esquerd[oa])\b/.test(n);
    const right = /\b(direit[oa])\b/.test(n);
    if (left === right) return null; // nenhum ou ambos → indefinido
    return left ? "Esquerdo" : "Direito";
  }

  /** Posição (dianteiro/traseiro) do nome; ambos/nenhum → null (ambíguo). */
  private static extractPosition(product: any): string | null {
    const n = this.normalize(product?.name);
    const front = /\b(diant|frontal)/.test(n);
    const rear = /\btras/.test(n);
    if (front === rear) return null;
    return front ? "Dianteiro" : "Traseiro";
  }
}
