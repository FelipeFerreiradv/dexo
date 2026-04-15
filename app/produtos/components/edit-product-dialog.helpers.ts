export type MLCatOption = { id: string; value: string };

export interface VehicularProductLike {
  brand?: string | null;
  model?: string | null;
  year?: string | null;
}

const VEHICLE_ROOT_KEYWORDS = [
  "acessórios para veículos",
  "acessorios para veiculos",
  "peças de carros",
  "pecas de carros",
  "motos",
  "caminhões",
  "caminhoes",
];

export function isProductVehicular(p: VehicularProductLike): boolean {
  return !!(p.brand && p.model && p.year);
}

/**
 * Decide se uma categoria ML (por id ou por fullPath) está sob o nicho
 * veicular usando a lista de categorias disponível no frontend (mlOptions).
 *
 * Retorna:
 *  - `true`  → categoria cai sob o nicho de veículos.
 *  - `false` → categoria encontrada e claramente FORA do nicho (ex: Gin).
 *  - `"unknown"` → não foi possível decidir (lista ainda não carregou ou
 *                  categoria não está na lista). Nesse caso, o caller deve
 *                  fail-open para não bloquear o usuário por falta de dados.
 */
export function isCategoryUnderVehicleRoot(
  categoryIdOrValue: string | null | undefined,
  mlOptions: MLCatOption[],
): boolean | "unknown" {
  if (!categoryIdOrValue) return "unknown";
  if (!mlOptions || mlOptions.length === 0) return "unknown";

  const target = mlOptions.find(
    (o) => o.id === categoryIdOrValue || o.value === categoryIdOrValue,
  );
  if (!target) return "unknown";

  const firstSegment = (target.value || "")
    .split(">")[0]
    .trim()
    .toLowerCase();
  if (!firstSegment) return "unknown";

  return VEHICLE_ROOT_KEYWORDS.some((k) => firstSegment.includes(k));
}

/**
 * Sanity-check para o estado inicial do modal ao abrir um produto.
 * Se o produto é veicular e a categoria persistida cai visivelmente fora
 * do nicho, retorna `{ clear: true, warning }` para o caller limpar o
 * campo e exibir aviso.
 */
export function sanityCheckInitialMlCategory(
  product: VehicularProductLike,
  persistedMlCategory: string | null | undefined,
  mlOptions: MLCatOption[],
): { clear: boolean; warning?: string } {
  if (!isProductVehicular(product)) return { clear: false };
  if (!persistedMlCategory) return { clear: false };
  const verdict = isCategoryUnderVehicleRoot(persistedMlCategory, mlOptions);
  if (verdict === false) {
    return {
      clear: true,
      warning:
        "Categoria ML persistida não pertence ao nicho de autopeças. Selecione uma categoria válida antes de publicar.",
    };
  }
  return { clear: false };
}
