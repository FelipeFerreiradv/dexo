import CategoryRepository from "../repositories/category.repository";
import { MLApiService } from "./ml-api.service";

export type CategoryResolutionSource = "explicit" | "product" | "imported";

export interface CategoryResolutionResult {
  externalId: string;
  fullPath?: string | null;
  source: CategoryResolutionSource;
}

export const ML_VEHICLE_ROOT_EXTERNAL_ID = "MLB5672";

export interface DomainGuardResult {
  ok: boolean;
  rootExternalId?: string;
  fullPath?: string;
  reason?: "not_in_tree" | "outside_root";
}

export interface ConditionCoherenceResult {
  ok: boolean;
  allowedConditions?: string[];
  reason?: "unknown" | "incompatible";
}

const conditionCache = new Map<
  string,
  { conditions: string[] | null; ts: number }
>();
const CONDITION_CACHE_TTL_MS = 10 * 60 * 1000;

const vehicleRootSetCache = new Map<
  string,
  { set: Set<string>; ts: number }
>();
const VEHICLE_ROOT_SET_TTL_MS = 10 * 60 * 1000;

export function __resetCategoryGuardCacheForTests() {
  conditionCache.clear();
  vehicleRootSetCache.clear();
}

/**
 * Carrega (e cacheia) o conjunto de externalIds que descendem da raiz
 * veicular (MLB1747) usando a árvore local. Uma chamada, reaproveitada
 * por todos os callers durante o TTL.
 */
async function loadVehicleRootSet(
  siteId: string = "MLB",
  rootExternalId: string = ML_VEHICLE_ROOT_EXTERNAL_ID,
): Promise<Set<string>> {
  const key = `${siteId}:${rootExternalId}`;
  const now = Date.now();
  const cached = vehicleRootSetCache.get(key);
  if (cached && now - cached.ts < VEHICLE_ROOT_SET_TTL_MS) {
    return cached.set;
  }
  const categories = await CategoryRepository.listWithParents(siteId);
  const set = new Set<string>();
  if (!categories.length) {
    vehicleRootSetCache.set(key, { set, ts: now });
    return set;
  }
  const byParent = new Map<string, string[]>();
  for (const c of categories) {
    const p = (c as any).parentExternalId as string | null;
    if (!p) continue;
    const arr = byParent.get(p) || [];
    arr.push(c.externalId);
    byParent.set(p, arr);
  }
  const queue: string[] = [rootExternalId];
  set.add(rootExternalId);
  while (queue.length) {
    const id = queue.shift()!;
    const children = byParent.get(id) || [];
    for (const child of children) {
      if (!set.has(child)) {
        set.add(child);
        queue.push(child);
      }
    }
  }
  vehicleRootSetCache.set(key, { set, ts: now });
  return set;
}

/**
 * Máscara de leitura: para produtos veiculares (brand+model+year) cuja
 * `mlCategoryId` persistida caia fora do nicho veicular (MLB1747), zera
 * os campos ML no objeto retornado. NÃO escreve no DB — apenas mascara
 * na resposta. Falha-aberto: se a árvore não estiver sincronizada (set
 * vazio), não mascara nada para não bloquear usuário por falta de dados.
 */
const VEHICLE_CATEGORY_KEYWORDS = [
  "veícul",
  "veicul",
  "acessórios para ve",
  "acessorios para ve",
  "peças de carro",
  "pecas de carro",
  "motor",
  "suspensão",
  "suspensao",
  "freio",
  "carroceria",
  "automotiv",
  "auto peça",
  "auto peca",
  "autopeç",
  "autopec",
];

function looksLikeVehicularCategoryString(value?: string | null): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return VEHICLE_CATEGORY_KEYWORDS.some((kw) => v.includes(kw));
}

export async function maskCorruptVehicleCategoriesInProducts<
  T extends {
    brand?: string | null;
    model?: string | null;
    year?: string | null;
    category?: string | null;
    mlCategory?: string | null;
    mlCategoryId?: string | null;
    mlCategorySource?: string | null;
  },
>(products: T[]): Promise<T[]> {
  if (!products || products.length === 0) return products;
  const hasVehicularCandidate = products.some(
    (p) =>
      !!(p.brand && p.model && p.year) &&
      !!(p.mlCategory || p.mlCategoryId || p.category),
  );
  if (!hasVehicularCandidate) return products;
  const set = await loadVehicleRootSet();
  for (const p of products) {
    if (!(p.brand && p.model && p.year)) continue;

    if (set.size > 0) {
      const candidate = (p.mlCategory || p.mlCategoryId || "") as string;
      if (candidate && !set.has(candidate)) {
        (p as any).mlCategory = null;
        (p as any).mlCategoryId = null;
        (p as any).mlCategorySource = null;
        (p as any).mlCategoryChosenAt = null;
      }
    }

    if (p.category && !looksLikeVehicularCategoryString(p.category)) {
      (p as any).category = null;
    }
  }
  return products;
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

  /**
   * Verifica se um externalId está sob a raiz de Veículos (MLB1747).
   * Usa a árvore local sincronizada (CategoryRepository.listWithParents).
   * Se a categoria não estiver na árvore (sincronização incompleta), retorna
   * `ok: true` com `reason: "not_in_tree"` para fail-open — não queremos
   * bloquear publicação por DB incompleto. Os chamadores podem usar o
   * `reason` para logar um alerta.
   */
  static async assertWithinVehicleRoot(
    externalId: string,
    rootExternalId: string = ML_VEHICLE_ROOT_EXTERNAL_ID,
  ): Promise<DomainGuardResult> {
    if (!externalId) {
      return { ok: false, reason: "not_in_tree" };
    }
    const siteId = externalId.slice(0, 3);
    const categories = await CategoryRepository.listWithParents(siteId);
    if (!categories.length) {
      return { ok: true, reason: "not_in_tree" };
    }
    const byExternal = new Map(categories.map((c) => [c.externalId, c]));
    const start = byExternal.get(externalId);
    if (!start) {
      return { ok: true, reason: "not_in_tree" };
    }

    let current: any = start;
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current.externalId)) break;
      visited.add(current.externalId);
      if (current.externalId === rootExternalId) {
        return {
          ok: true,
          rootExternalId,
          fullPath: start.fullPath || undefined,
        };
      }
      if (!current.parentExternalId) break;
      current = byExternal.get(current.parentExternalId);
    }

    return {
      ok: false,
      rootExternalId,
      fullPath: start.fullPath || undefined,
      reason: "outside_root",
    };
  }

  /**
   * Verifica coerência entre uma categoria ML e um valor de `condition`
   * (ex: "new", "used"). Busca `settings.item_conditions` via
   * `MLApiService.getCategory` com cache TTL. Fail-open em caso de erro
   * de rede ou dados ausentes (retorna ok=true com reason="unknown").
   */
  static async assertConditionCoherent(
    externalId: string,
    condition: string,
  ): Promise<ConditionCoherenceResult> {
    if (!externalId || !condition) {
      return { ok: true, reason: "unknown" };
    }

    const now = Date.now();
    const cached = conditionCache.get(externalId);
    let allowed: string[] | null = null;

    if (cached && now - cached.ts < CONDITION_CACHE_TTL_MS) {
      allowed = cached.conditions;
    } else {
      try {
        const res: any = await MLApiService.getCategory(externalId);
        if (res && !res.error) {
          const raw = res?.settings?.item_conditions;
          if (Array.isArray(raw) && raw.length > 0) {
            allowed = raw.map((c: any) => String(c).toLowerCase());
          } else {
            allowed = null;
          }
        } else {
          allowed = null;
        }
      } catch {
        allowed = null;
      }
      conditionCache.set(externalId, { conditions: allowed, ts: now });
    }

    if (!allowed || allowed.length === 0) {
      return { ok: true, reason: "unknown" };
    }

    if (allowed.includes(condition.toLowerCase())) {
      return { ok: true, allowedConditions: allowed };
    }

    return {
      ok: false,
      allowedConditions: allowed,
      reason: "incompatible",
    };
  }
}
