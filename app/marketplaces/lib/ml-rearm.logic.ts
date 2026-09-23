/**
 * Re-armar a publicação no ML depois que a pessoa corrige o produto.
 *
 * Antes, um anúncio recusado por dado (GTIN, ficha técnica, medidas…) era
 * retentado 5 vezes em ~14 minutos com o MESMO corpo, e morria. Quem corrigia
 * rápido às vezes pegava a janela; quem corrigia depois precisava recriar à
 * mão. Agora a recusa por dado é terminal na hora (`[TERMINAL][CORRIGIVEL]`) e
 * a EDIÇÃO do produto a re-arma — publica sozinho depois da correção.
 *
 * Só edição que pode mudar o resultado conta: estoque, localização e afins não
 * re-armam (a recusa seria a mesma).
 */

type Loose = Record<string, unknown>;

const STRING_FIELDS = [
  "name",
  "description",
  "brand",
  "model",
  "year",
  "version",
  "category",
  "partNumber",
  "quality",
  "mlCategoryId",
  "mlCategory",
  "imageUrl",
] as const;

const NUMBER_FIELDS = [
  "price",
  "heightCm",
  "widthCm",
  "lengthCm",
  "weightKg",
] as const;

/** Campos que, só por virem no pedido, podem mudar o anúncio. */
const JSON_FIELDS = [
  "attributes",
  "compatibilities",
  "compatibilityPositions",
  "imageUrls",
] as const;

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v && "toNumber" in v) {
    return (v as { toNumber(): number }).toNumber();
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function json(v: unknown): string {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return String(v);
  }
}

export function isPublishRelevantProductChange(
  data: Loose,
  before: Loose,
): boolean {
  for (const f of STRING_FIELDS) {
    const novo = data[f];
    if (novo === undefined) continue;
    if ((novo ?? null) !== (before[f] ?? null)) return true;
  }
  for (const f of NUMBER_FIELDS) {
    if (data[f] === undefined) continue;
    if (toNum(data[f]) !== toNum(before[f])) return true;
  }
  for (const f of JSON_FIELDS) {
    if (data[f] === undefined) continue;
    if (json(data[f]) !== json(before[f])) return true;
  }
  return false;
}

/** Espera antes de o cron pegar a linha re-armada (ver repositório). */
export const REARM_DELAY_MS = 5 * 60 * 1000;
