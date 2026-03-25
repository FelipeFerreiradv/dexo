import { parseTitleToFields } from "@/app/lib/product-parser";
import CategoryRepository from "../repositories/category.repository";
import CategoryAliasRepository from "../repositories/category-alias.repository";

type AttributeSuggestion = {
  brand?: string;
  model?: string;
  year?: string;
  partNumber?: string;
};

type MeasurementSuggestion = {
  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightKg?: number;
};

export type CategorySuggestion = {
  categoryId: string;
  fullPath: string;
  score: number;
  source: "alias" | "keyword";
  attributes?: AttributeSuggestion;
  measurements?: MeasurementSuggestion;
  title?: string;
};

type AliasEntry = Awaited<
  ReturnType<typeof CategoryAliasRepository.listWithCategory>
>[number];

type CategoryEntry = Awaited<
  ReturnType<typeof CategoryRepository.listWithParents>
>[number];

export class CategorySuggestionService {
  private static aliasCacheMap = new Map<
    string,
    { loadedAt: number; items: AliasEntry[] }
  >();
  private static categoryCacheMap = new Map<
    string,
    { loadedAt: number; items: CategoryEntry[] }
  >();
  private static readonly CACHE_MS = 5 * 60 * 1000;

  private static normalize(text?: string): string {
    return (text || "")
      .toString()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  private static tokenize(text: string): string[] {
    const STOPWORDS = new Set([
      "de",
      "da",
      "do",
      "das",
      "dos",
      "para",
      "pra",
      "por",
      "com",
      "sem",
      "na",
      "no",
      "nas",
      "nos",
      "em",
      "uma",
      "um",
      "e",
      "ou",
      "peça",
      "peca",
      "kit",
      "autopecas",
      "autopeças",
    ]);

    const ABBREV: Record<string, string> = {
      vw: "volkswagen",
      gm: "chevrolet",
      chev: "chevrolet",
      mb: "mercedes",
      mbz: "mercedes",
      mercedesbenz: "mercedes",
      vag: "volkswagen",
    };

    const cleaned = this.normalize(text).replace(/[^a-z0-9\s]/g, " ");
    return cleaned
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => ABBREV[t] || t)
      .filter((t) => !STOPWORDS.has(t));
  }

  private static parseTokens(str?: string | null): string[] {
    if (!str) return [];
    return str
      .split(/[,\s]+/)
      .map((t) => this.normalize(t))
      .filter(Boolean);
  }

  private static async loadAliases(siteId: string) {
    const cached = this.aliasCacheMap.get(siteId);
    if (cached && Date.now() - cached.loadedAt < this.CACHE_MS) {
      return cached.items;
    }
    const items = await CategoryAliasRepository.listWithCategory(siteId);
    this.aliasCacheMap.set(siteId, { loadedAt: Date.now(), items });
    return items;
  }

  private static async loadCategories(siteId: string) {
    const cached = this.categoryCacheMap.get(siteId);
    if (cached && Date.now() - cached.loadedAt < this.CACHE_MS) {
      return cached.items;
    }
    const items = await CategoryRepository.listWithParents(siteId);
    this.categoryCacheMap.set(siteId, { loadedAt: Date.now(), items });
    return items;
  }

  private static buildParentMaps(categories: CategoryEntry[]) {
    const byExternal = new Map<string, CategoryEntry>();
    const byParent = new Map<string, CategoryEntry[]>();

    for (const c of categories) {
      byExternal.set(c.externalId, c);
      if (c.parentExternalId) {
        const list = byParent.get(c.parentExternalId) || [];
        list.push(c);
        byParent.set(c.parentExternalId, list);
      }
    }

    return { byExternal, byParent };
  }

  private static ensureLeafLocal(
    externalId: string,
    categories: CategoryEntry[],
    prebuiltMaps?: {
      byExternal: Map<string, CategoryEntry>;
      byParent: Map<string, CategoryEntry[]>;
    },
  ): CategoryEntry | null {
    const { byExternal, byParent } =
      prebuiltMaps || this.buildParentMaps(categories);
    let current = byExternal.get(externalId);
    if (!current) return null;

    while (byParent.has(current.externalId)) {
      const children = byParent.get(current.externalId)!;
      if (!children.length) break;
      const outros =
        children.find((c) =>
          this.normalize(c.fullPath || c.name).includes("outros"),
        ) || children[0];
      current = outros;
    }
    return current;
  }

  private static buildTitleSuggestion(
    attrs: AttributeSuggestion,
    tokens: string[],
    originalTitle: string,
  ): string | undefined {
    const pieceTokens = tokens.filter(
      (t) =>
        t !== this.normalize(attrs.brand) &&
        t !== this.normalize(attrs.model) &&
        t !== this.normalize(attrs.year) &&
        t !== this.normalize(attrs.partNumber),
    );
    const piece =
      pieceTokens.length > 0
        ? pieceTokens.map((t) => t[0]?.toUpperCase() + t.slice(1)).join(" ")
        : originalTitle;

    const parts = [
      attrs.brand,
      attrs.model,
      piece,
      attrs.year,
      attrs.partNumber ? `| ${attrs.partNumber}` : undefined,
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    return parts || undefined;
  }

  private static scoreAliasMatch(opts: {
    tokens: string[];
    aliasTokens: string[];
    synonymTokens: string[];
    patterns: any;
    rawText: string;
  }) {
    const { tokens, aliasTokens, synonymTokens, patterns, rawText } = opts;
    const norm = (s: string) => this.normalize(s);
    const tokenSet = new Set(tokens);
    const intersect = aliasTokens.filter((t) => tokenSet.has(t));
    const synonymHits = synonymTokens.filter((t) => tokenSet.has(t));

    let score = intersect.length * 2 + synonymHits.length;

    const attr: AttributeSuggestion = {};

    if (patterns?.brand) {
      const brandNorm = norm(patterns.brand);
      if (tokenSet.has(brandNorm)) score += 3;
      attr.brand = patterns.brand;
    }

    if (patterns?.model) {
      const modelNorm = norm(patterns.model);
      if (tokenSet.has(modelNorm)) score += 2;
      attr.model = patterns.model;
    }

    if (patterns?.years) {
      const years: string[] = Array.isArray(patterns.years)
        ? patterns.years
        : [patterns.years];
      const yearHit = years.find((y) => tokenSet.has(norm(y)));
      if (yearHit) {
        score += 1;
        attr.year = yearHit;
      }
    }

    if (patterns?.partNumber) {
      const pnNorm = norm(patterns.partNumber);
      if (pnNorm && rawText.includes(pnNorm)) {
        score += 3;
        attr.partNumber = patterns.partNumber;
      }
    }

    const measurements: MeasurementSuggestion | undefined =
      patterns?.measurements;

    return { score, attr, measurements };
  }

  static async suggestFromTitle(
    title: string,
    siteId = "MLB",
  ): Promise<{
    normalizedTitle: string;
    tokens: string[];
    suggestions: CategorySuggestion[];
  }> {
    const startedAt = Date.now();
    const normalizedTitle = this.normalize(title);
    const tokens = this.tokenize(title);
    const aliasEntries = await this.loadAliases(siteId);
    const categories = await this.loadCategories(siteId);
    const parentMaps = this.buildParentMaps(categories);
    const { brand, model, year } = parseTitleToFields(title);
    const baseAttr: AttributeSuggestion = { brand, model, year };
    const suggestions = new Map<string, CategorySuggestion>();

    for (const alias of aliasEntries) {
      const aliasTokens = this.parseTokens(alias.tokens);
      const synonymTokens = this.parseTokens(alias.synonyms);
      const patterns = (() => {
        try {
          return alias.brandModelPatterns
            ? JSON.parse(alias.brandModelPatterns)
            : null;
        } catch {
          return null;
        }
      })();

      const { score, attr, measurements } = this.scoreAliasMatch({
        tokens,
        aliasTokens,
        synonymTokens,
        patterns,
        rawText: normalizedTitle,
      });

      if (!alias.marketplaceCategory?.externalId || score <= 0) continue;

      const leaf = this.ensureLeafLocal(
        alias.marketplaceCategory.externalId,
        categories,
        parentMaps,
      );
      if (!leaf?.externalId) continue;

      const mergedAttr: AttributeSuggestion = {
        ...baseAttr,
        ...attr,
        year: attr.year || baseAttr.year,
      };

      const titleSuggestion = this.buildTitleSuggestion(
        mergedAttr,
        tokens,
        title,
      );

      const existing = suggestions.get(leaf.externalId);
      if (!existing || existing.score < score) {
        suggestions.set(leaf.externalId, {
          categoryId: leaf.externalId,
          fullPath: leaf.fullPath || leaf.name,
          score,
          source: "alias",
          attributes: mergedAttr,
          measurements,
          title: titleSuggestion,
        });
      }
    }

    // Fallback: keywords on category fullPath
    if (suggestions.size === 0) {
      for (const cat of categories) {
        const catTokens = this.tokenize(cat.fullPath || cat.name || "");
        const hits = catTokens.filter((t) => tokens.includes(t));
        if (!hits.length) continue;
        const leaf = this.ensureLeafLocal(
          cat.externalId,
          categories,
          parentMaps,
        );
        if (!leaf?.externalId) continue;
        const score = hits.length;
        const existing = suggestions.get(leaf.externalId);
        if (!existing || existing.score < score) {
          suggestions.set(leaf.externalId, {
            categoryId: leaf.externalId,
            fullPath: leaf.fullPath || leaf.name,
            score,
            source: "keyword",
            attributes: baseAttr,
          });
        }
      }
    }

    const sorted = Array.from(suggestions.values()).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.fullPath || "").length - (a.fullPath || "").length;
    });

    const elapsed = Date.now() - startedAt;
    if (elapsed > 3000) {
      console.warn(
        `[CategorySuggestionService] suggestFromTitle lento: ${elapsed}ms (title="${title}")`,
      );
    }

    return {
      normalizedTitle,
      tokens,
      suggestions: sorted.slice(0, 5),
    };
  }
}

export default CategorySuggestionService;
