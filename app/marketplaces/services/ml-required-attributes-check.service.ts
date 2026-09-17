/**
 * Checagem de atributos obrigatórios do ML para o FRONT (modal de produto e
 * anúncio em massa), por POST /marketplace/ml/required-attributes/check.
 *
 * Não reimplementa nada: cada item passa por
 * `ListingUseCase.evaluateMLRequiredAttributesForProduct`, o MESMO motor que o
 * create usa para bloquear antes do POST /items (mesma categoria efetiva, mesma
 * montagem de atributos, mesma regra). O front só mostra o resultado.
 *
 * Somente leitura: não renova token nem chama API de conta. O catálogo usa a
 * API pública (ou app token) e a sugestão de categoria é o domain_discovery
 * público. Uma query só para os produtos salvos (select enxuto).
 */
import { ListingUseCase } from "../usecases/listing.usercase";
import { ProductRepositoryPrisma } from "../../repositories/product.repository";
import { parseTitleToFields } from "../../lib/product-parser";
import {
  shouldSkipMlRequiredBlockForCatalog,
  type MLRequiredAttributeIssue,
  type MLRequiredAttributesStatus,
} from "../lib/ml-required-attributes.logic";

export const ML_REQUIRED_CHECK_MAX_ITEMS = 200;
const CONCORRENCIA = 4;

type ValorAtributo = { value_id?: string; value_name?: string };

export interface MlRequiredCheckDraftProduct {
  name?: string;
  sku?: string;
  brand?: string;
  model?: string;
  year?: string;
  partNumber?: string;
  quality?: string;
  attributes?: Record<string, ValorAtributo>;
  mlCatalogProductId?: string;
}

export interface MlRequiredCheckRequestItem {
  key: string;
  productId?: string;
  product?: MlRequiredCheckDraftProduct;
  categoryId?: string;
  attributeOverrides?: Record<string, ValorAtributo>;
}

export interface MlRequiredCheckResultItem {
  key: string;
  status: MLRequiredAttributesStatus;
  unknownReason?: string;
  categoryId: string | null;
  blocking: MLRequiredAttributeIssue[];
  warnings: MLRequiredAttributeIssue[];
  message: string | null;
}

const ehObjeto = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Valida o corpo. Devolve os itens ou a mensagem do 400. Não confia em nada
 * do cliente: só string onde é string, só objeto (não array) onde é objeto.
 */
export function parseMlRequiredCheckBody(
  body: unknown,
): { items: MlRequiredCheckRequestItem[] } | { error: string } {
  const items = ehObjeto(body) ? body.items : undefined;
  if (!Array.isArray(items) || items.length === 0) {
    return { error: "items deve ser um array não-vazio" };
  }
  if (items.length > ML_REQUIRED_CHECK_MAX_ITEMS) {
    return {
      error: `Máximo de ${ML_REQUIRED_CHECK_MAX_ITEMS} itens por requisição`,
    };
  }
  const out: MlRequiredCheckRequestItem[] = [];
  for (let idx = 0; idx < items.length; idx++) {
    const raw: unknown = items[idx];
    if (!ehObjeto(raw)) return { error: `items[${idx}] inválido` };
    if (typeof raw.key !== "string" || !raw.key.trim()) {
      return { error: `items[${idx}].key deve ser string não-vazia` };
    }
    const temProductId =
      typeof raw.productId === "string" && raw.productId.trim().length > 0;
    const temProduct = ehObjeto(raw.product);
    if (!temProductId && !temProduct) {
      return { error: `items[${idx}] precisa de productId ou product` };
    }
    if (raw.categoryId !== undefined && typeof raw.categoryId !== "string") {
      return { error: `items[${idx}].categoryId deve ser string` };
    }
    if (raw.attributeOverrides !== undefined && !ehObjeto(raw.attributeOverrides)) {
      return { error: `items[${idx}].attributeOverrides deve ser objeto` };
    }
    out.push({
      key: raw.key,
      productId: temProductId ? (raw.productId as string) : undefined,
      product: temProduct
        ? (raw.product as MlRequiredCheckDraftProduct)
        : undefined,
      categoryId: raw.categoryId as string | undefined,
      attributeOverrides: raw.attributeOverrides as
        | Record<string, ValorAtributo>
        | undefined,
    });
  }
  return { items: out };
}

const texto = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/**
 * Rascunho do modal → produto como o create o veria DEPOIS do POST /products.
 * Marca/modelo/ano vazios são preenchidos pelo título, espelhando o
 * `applyUserDefaults` de product.usercase — sem isso o ano que o servidor
 * extrairia do nome contaria como ausente e bloquearia à toa.
 */
export function buildMlRequiredDraftProduct(
  draft: MlRequiredCheckDraftProduct,
): Record<string, unknown> {
  const product: Record<string, unknown> = {
    name: texto(draft.name) ?? "",
    sku: texto(draft.sku),
    brand: texto(draft.brand) || undefined,
    model: texto(draft.model) || undefined,
    year: texto(draft.year) || undefined,
    partNumber: texto(draft.partNumber) || undefined,
    quality: texto(draft.quality) || undefined,
    attributes: ehObjeto(draft.attributes) ? draft.attributes : undefined,
    mlCatalogProductId: texto(draft.mlCatalogProductId) || undefined,
  };
  try {
    const detectado = parseTitleToFields(String(product.name || ""));
    if (!product.brand && detectado.brand) product.brand = detectado.brand;
    if (!product.model && detectado.model) product.model = detectado.model;
    if (!product.year && detectado.year) product.year = detectado.year;
  } catch {
    // Heurística não pode derrubar a checagem.
  }
  return product;
}

/**
 * Anúncio de catálogo ligado + produto vinculado: o create NÃO bloqueia antes
 * do POST (ver shouldSkipMlRequiredBlockForCatalog). O front espelha isso
 * rebaixando os bloqueios para aviso, para não barrar o que o back publica.
 */
function rebaixarSeCatalogo(
  r: MlRequiredCheckResultItem,
  product: Record<string, unknown>,
): MlRequiredCheckResultItem {
  if (
    r.status !== "blocked" ||
    !shouldSkipMlRequiredBlockForCatalog(product.mlCatalogProductId)
  ) {
    return r;
  }
  return {
    ...r,
    status: "ok",
    warnings: [...r.warnings, ...r.blocking],
    blocking: [],
    message: null,
  };
}

export async function runMlRequiredAttributesCheck(
  userId: string,
  items: MlRequiredCheckRequestItem[],
): Promise<MlRequiredCheckResultItem[]> {
  const ids = Array.from(
    new Set(
      items
        .map((i) => i.productId)
        .filter((id): id is string => typeof id === "string" && !!id),
    ),
  );
  const salvos =
    ids.length > 0
      ? await new ProductRepositoryPrisma().findMlRequiredAttrsInput(ids, userId)
      : [];
  const porId = new Map(salvos.map((p) => [p.id, p]));

  const categoryCache = new Map<
    string,
    Promise<{ resolvedCategoryId: string; categoryIdForML: string } | null>
  >();
  const results: MlRequiredCheckResultItem[] = new Array(items.length);

  const avaliar = async (item: MlRequiredCheckRequestItem) => {
    const product: Record<string, unknown> | undefined = item.productId
      ? (porId.get(item.productId) as Record<string, unknown> | undefined)
      : item.product
        ? buildMlRequiredDraftProduct(item.product)
        : undefined;
    if (!product) {
      return {
        key: item.key,
        status: "unknown" as const,
        unknownReason: "product_not_found",
        categoryId: null,
        blocking: [],
        warnings: [],
        message: null,
      };
    }
    try {
      const ev = await ListingUseCase.evaluateMLRequiredAttributesForProduct({
        product,
        categoryId: item.categoryId?.trim() || undefined,
        attributeOverrides: item.attributeOverrides ?? null,
        categoryCache,
      });
      const r: MlRequiredCheckResultItem = {
        key: item.key,
        status: ev.status,
        ...(ev.unknownReason ? { unknownReason: ev.unknownReason } : {}),
        categoryId: ev.categoryId,
        blocking: ev.blocking,
        warnings: ev.warnings,
        message: ev.message,
      };
      return rebaixarSeCatalogo(r, product);
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "ml.required_attrs.check_item_failed",
          key: item.key,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return {
        key: item.key,
        status: "unknown" as const,
        unknownReason: "evaluation_failed",
        categoryId: null,
        blocking: [],
        warnings: [],
        message: null,
      };
    }
  };

  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await avaliar(items[idx]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCORRENCIA, items.length) }, () =>
      worker(),
    ),
  );
  return results;
}
