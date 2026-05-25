import type { Quality } from "../interfaces/product.interface";

const VALID_QUALITIES: ReadonlySet<Quality> = new Set([
  "SUCATA",
  "SEMINOVO",
  "NOVO",
  "RECONDICIONADO",
]);

export const VALID_QUALITY_LIST = "SUCATA, SEMINOVO, NOVO, RECONDICIONADO";

export class InvalidQualityError extends Error {
  constructor(value: unknown) {
    super(
      `Qualidade inválida: ${JSON.stringify(value)}. Valores aceitos: ${VALID_QUALITY_LIST}.`,
    );
    this.name = "InvalidQualityError";
  }
}

/**
 * Normaliza e valida o campo `quality` recebido do cliente da API externa.
 *
 * - `null`, `undefined`, `""` → `undefined` (campo opcional)
 * - case-insensitive: `seminovo` ou `Seminovo` viram `SEMINOVO`
 * - valor fora do enum lança InvalidQualityError com a lista de aceitos
 *
 * Não mapeia aliases (ex.: "USADO" → "SEMINOVO") porque seria ambíguo:
 * "USADO" no contexto Dexo pode ser SEMINOVO (em bom estado) OU SUCATA
 * (peça pra desmonte). O cliente da API precisa especificar.
 */
export function normalizeQuality(value: unknown): Quality | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new InvalidQualityError(value);
  }
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const upper = trimmed.toUpperCase();
  if (!VALID_QUALITIES.has(upper as Quality)) {
    throw new InvalidQualityError(value);
  }
  return upper as Quality;
}
