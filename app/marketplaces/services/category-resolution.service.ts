import CategoryRepository from "../repositories/category.repository";
import { MLApiService } from "./ml-api.service";

export type CategoryResolutionSource = "explicit" | "product" | "imported";

export interface CategoryResolutionResult {
  externalId: string;
  fullPath?: string | null;
  source: CategoryResolutionSource;
}

/**
 * Resolvedor determinístico de categoria.
 * Regra: só aceita categoria já persistida ou explicitamente informada;
 * não faz recategorização por heurística. Se não houver categoria válida, falha.
 */
export class CategoryResolutionService {
  /**
   * Mapa de IDs do catálogo estático (ML_CATALOG) para IDs reais do ML.
   * Usado como fallback quando IDs sintéticos (ex: "MLB1748-01") do frontend
   * não existem na base de dados sincronizada.
   */
  private static readonly CATALOG_TO_ML_MAP: Record<string, string> = {
    // Motor e Peças → Peças de Carros > Motor (MLB114766)
    "MLB1747": "MLB114766",
    "MLB1747-01": "MLB114766",
    "MLB1747-02": "MLB114766",
    // Suspensão → Peças de Carros > Suspensão e Direção (MLB22648)
    "MLB1748": "MLB22648",
    "MLB1748-01": "MLB22648",
    "MLB1748-02": "MLB22648",
    // Freios → Peças de Carros > Freios (MLB6789)
    "MLB1749": "MLB6789",
    "MLB1749-01": "MLB6789",
    // Elétrica Automotiva → Peças de Carros > Sistema Elétrico (MLB440216)
    "MLB1750": "MLB440216",
    "MLB1750-01": "MLB440216",
    // Carroceria e Lataria → Peças de Carros > Carroceria (MLB191835)
    "MLB1754": "MLB191835",
    "MLB1754-01": "MLB191835",
    // Cubo de Roda → Peças de Carros > Suspensão e Direção (MLB22648)
    "MLB1765-01": "MLB22648",
  };

  /**
   * Resolve categoria do Mercado Livre.
   * @param explicitCategoryId externalId informado pelo caller (opcional)
   * @param product objeto de produto com mlCategoryId/fullPath persistidos
   * @param validateWithMLAPI se true, faz uma checagem leve na API do ML
   */
  static async resolveMLCategory(options: {
    explicitCategoryId?: string;
    product?: any;
    validateWithMLAPI?: boolean;
  }): Promise<CategoryResolutionResult> {
    const { explicitCategoryId, product, validateWithMLAPI = false } = options;

    const normalizeId = (id?: string) =>
      id ? id.toString().trim() : undefined;

    // 1) categoria explícita enviada na requisição (sempre tratada como externalId)
    const explicit = normalizeId(explicitCategoryId);
    if (explicit) {
      let cat = await CategoryRepository.findByExternalId(explicit);
      // fallback: se vier com sufixo "-NN" inexistente, tenta ID base
      if (!cat && explicit.includes("-")) {
        const baseId = explicit.split("-")[0];
        cat = await CategoryRepository.findByExternalId(baseId);
      }
      // fallback: mapear IDs do catálogo estático para IDs reais do ML
      if (!cat && this.CATALOG_TO_ML_MAP[explicit]) {
        cat = await CategoryRepository.findByExternalId(this.CATALOG_TO_ML_MAP[explicit]);
      }
      if (!cat) {
        throw new Error(
          `Categoria fornecida (${explicit}) não está sincronizada. Sincronize categorias ou escolha outra.`,
        );
      }
      const leaf = await this.ensureLeaf(cat.externalId, validateWithMLAPI);
      return {
        externalId: leaf.externalId,
        fullPath: leaf.fullPath || cat.fullPath,
        source: "explicit",
      };
    }

    // 2) categoria persistida no produto (FK para MarketplaceCategory)
    const productCategoryId = normalizeId(product?.mlCategoryId);
    if (productCategoryId) {
      const cat = await CategoryRepository.findById(productCategoryId);
      if (!cat || !cat.externalId) {
        throw new Error(
          "Categoria do produto está inválida ou sem externalId. Edite o produto e escolha uma categoria válida.",
        );
      }
      const leaf = await this.ensureLeaf(cat.externalId, validateWithMLAPI);
      return {
        externalId: leaf.externalId,
        fullPath: leaf.fullPath || cat.fullPath,
        source: "product",
      };
    }

    throw new Error(
      "Produto não possui categoria do Mercado Livre. Defina uma categoria no produto antes de publicar.",
    );
  }

  /**
   * Garante que a categoria seja um leaf com listing_allowed. Se receber uma
   * categoria pai, tenta descer para "Outros" ou para o primeiro filho elegível.
   */
  private static async ensureLeaf(
    externalId: string,
    shouldValidate: boolean,
  ): Promise<{ externalId: string; fullPath?: string }> {
    if (!shouldValidate) return { externalId };

    try {
      const res = await MLApiService.getCategory(externalId);
      if (!res || (res as any).error) {
        throw new Error(
          `Categoria ${externalId} não encontrada no ML. Escolha outra categoria.`,
        );
      }
      const cat = res as any;
      const fullPath: string | undefined = Array.isArray(cat.path_from_root)
        ? cat.path_from_root.map((p: any) => p.name).join(" > ")
        : undefined;

      const children = Array.isArray(cat.children_categories)
        ? cat.children_categories
        : [];
      const isLeaf =
        (cat.settings?.listing_allowed ?? false) === true &&
        children.length === 0;

      if (isLeaf) {
        return { externalId: cat.id, fullPath };
      }

      const child =
        children.find(
          (c: any) => c.name?.toLowerCase().trim() === "outros",
        ) || children[0];

      if (!child?.id) {
        throw new Error(
          `Categoria ${externalId} não permite publicação (não é leaf). Escolha uma categoria filha.`,
        );
      }

      return await this.ensureLeaf(child.id, shouldValidate);
    } catch (err) {
      // fallback: usar árvore local; se tiver sufixo "-NN", tentar baseId
      const baseId = externalId.includes("-")
        ? externalId.split("-")[0]
        : externalId;

      const local =
        (await this.ensureLeafLocalOnly(externalId)) ||
        (await this.ensureLeafLocalOnly(baseId));

      if (local) return local;

      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Falha ao validar categoria ${externalId} no ML: ${msg}`,
      );
    }
  }

  /**
   * Variante que usa apenas a Ã¡rvore local para achar um leaf vÃ¡lido.
   * Útil quando a API do ML responde 404/429 e queremos um fallback seguro.
   */
  static async ensureLeafLocalOnly(
    externalId: string,
  ): Promise<{ externalId: string; fullPath?: string } | null> {
    const siteId = externalId.slice(0, 3); // ex: MLB
    const categories = await CategoryRepository.listWithParents(siteId);
    if (!categories.length) return null;

    const byExternal = new Map(categories.map((c) => [c.externalId, c]));
    const byParent = new Map<string, any[]>();
    for (const c of categories) {
      if (!c.parentExternalId) continue;
      const arr = byParent.get(c.parentExternalId) || [];
      arr.push(c);
      byParent.set(c.parentExternalId, arr);
    }

    const pickLeaf = (extId: string) => {
      let current = byExternal.get(extId);
      if (!current) return null;
      while (byParent.has(current.externalId)) {
        const children = byParent.get(current.externalId)!;
        if (!children.length) break;
        const outros =
          children.find((c) =>
            (c.fullPath || c.name || "").toLowerCase().includes("outros"),
          ) || children[0];
        current = outros;
      }
      return current;
    };

    const baseId = externalId.includes("-")
      ? externalId.split("-")[0]
      : externalId;

    const leaf = pickLeaf(externalId) || pickLeaf(baseId);
    if (!leaf) return null;

    return { externalId: leaf.externalId, fullPath: leaf.fullPath };
  }
}
