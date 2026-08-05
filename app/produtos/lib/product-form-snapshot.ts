/**
 * Serializador ÚNICO do formulário de novo produto — usado pelo rascunho
 * automático (Bloco 4) e pelo histórico de cadastros (Bloco 3).
 *
 * Um serializador só, duas políticas: o que é PERSISTIDO é o mesmo nos dois
 * casos; o que é APLICADO de volta muda (o rascunho restaura tudo, o histórico
 * copia só o que faz sentido repetir entre peças parecidas).
 *
 * Puro: sem React, sem `window`, sem rede. O acesso a storage vive em
 * `product-form-storage.ts`.
 */

/** Versão do payload. Snapshot de versão desconhecida é descartado em silêncio. */
export const SNAPSHOT_VERSION = 1;

/**
 * Campos do formulário que NUNCA são serializados.
 *
 * `sku` é o mais importante e o mais perigoso: ele é único por tenant
 * (`@@unique([userId, sku])`) e vem do servidor a cada abertura
 * (`fetchNextSku` popula `autoSuggestedSkuRef`). O `onSubmit` decide entre
 * `autoSku: true` (campo vazio ou igual à sugestão) e SKU manual comparando o
 * valor digitado com essa ref. Restaurar um SKU velho faria o submit tomar o
 * caminho manual e enviar um código que outro cadastro já pode ter consumido.
 */
export const NEVER_PERSISTED_FIELDS = ["sku"] as const;

/**
 * Campos que o HISTÓRICO nunca copia, mesmo estando no snapshot.
 *
 *  - `sku`         nunca chega aqui: não é sequer persistido
 *                  (`NEVER_PERSISTED_FIELDS`). É único por tenant, vem do
 *                  servidor a cada abertura, e restaurar um antigo faria o
 *                  submit tomar o caminho de SKU manual.
 *  - `imageUrl` / `imageUrls`  a imagem é do produto físico, nunca do anterior.
 *  - `costPrice` / `markup`  o custo é da peça específica, e o markup é
 *                  derivado dele — copiar um sem o outro produz margem errada.
 *  - ids e códigos únicos (`mlCatalogProductId`, `scrapId`).
 *
 * `partNumber`, `stock`, `name` e `price` SAÍRAM desta lista em 05/08/2026 a
 * pedido do Felipe: quem cadastra peças parecidas em sequência quer esses
 * campos pré-preenchidos. A política de merge continua sendo a mesma —
 * `applyProductHistory` só preenche campo VAZIO e nunca sobrescreve o que o
 * usuário digitou (ver `tryFillString` / `tryFillNumber`).
 */
export const HISTORY_BLOCKED_FIELDS = [
  "sku",
  "imageUrl",
  "imageUrls",
  "costPrice",
  "markup",
  "mlCatalogProductId",
  "scrapId",
] as const;

export interface CompatibilitySnapshot {
  brand: string;
  model: string;
  yearFrom?: number | null;
  yearTo?: number | null;
  version?: string | null;
}

export interface ProductFormSnapshot {
  /** Versão do payload. */
  v: number;
  /** Momento da serialização (epoch ms) — base do TTL do rascunho. */
  savedAt: number;
  /** Valores do react-hook-form, menos os campos nunca persistidos. */
  values: Record<string, unknown>;
  /** Estado que vive FORA do react-hook-form e vai no payload do submit. */
  compatibilities: CompatibilitySnapshot[];
  /** Sucata vinculada (vira `scrapId`). */
  scrap: { id: string; label?: string } | null;
  /** Rótulo exibido da categoria Magalu (o id está em `values.magaluCategory`). */
  magaluCategoryLabel: string | null;
  /** Seção em que o usuário estava (índice do scroll). */
  currentStep: number | null;
  /** Só para exibir no histórico — nunca reaplicado. */
  label: { name: string; sku: string | null };
}

export interface SerializeInput {
  values: Record<string, unknown>;
  compatibilities: CompatibilitySnapshot[];
  scrap?: { id: string; label?: string } | null;
  magaluCategoryLabel?: string | null;
  currentStep?: number | null;
  /** Injetado para manter a função pura e testável com relógio fixo. */
  now: number;
}

/**
 * Monta o snapshot. Nada de base64, blob, token ou PII além do que o próprio
 * usuário digitou — as imagens já são URLs devolvidas pelo `/upload/image`,
 * então entram como string e custam nada.
 */
export function serializeProductForm(
  input: SerializeInput,
): ProductFormSnapshot {
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.values ?? {})) {
    if ((NEVER_PERSISTED_FIELDS as readonly string[]).includes(k)) continue;
    if (v === undefined) continue;
    values[k] = v;
  }

  return {
    v: SNAPSHOT_VERSION,
    savedAt: input.now,
    values,
    compatibilities: (input.compatibilities ?? []).map((c) => ({
      brand: c.brand,
      model: c.model,
      yearFrom: c.yearFrom ?? null,
      yearTo: c.yearTo ?? null,
      version: c.version ?? null,
    })),
    scrap: input.scrap ?? null,
    magaluCategoryLabel: input.magaluCategoryLabel ?? null,
    currentStep: input.currentStep ?? null,
    label: {
      name: String(input.values?.name ?? "").trim(),
      sku: (input.values?.sku as string | undefined)?.trim() || null,
    },
  };
}

/**
 * Valida um snapshot vindo do storage. Devolve `null` para qualquer coisa que
 * não seja exatamente o formato esperado — JSON corrompido, versão
 * desconhecida, campos com o tipo errado. Descarte SILENCIOSO: o usuário não
 * precisa saber que havia um rascunho ilegível.
 */
export function parseSnapshot(raw: unknown): ProductFormSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<ProductFormSnapshot>;
  if (s.v !== SNAPSHOT_VERSION) return null;
  if (typeof s.savedAt !== "number" || !Number.isFinite(s.savedAt)) return null;
  if (!s.values || typeof s.values !== "object" || Array.isArray(s.values)) {
    return null;
  }
  return {
    v: SNAPSHOT_VERSION,
    savedAt: s.savedAt,
    values: s.values as Record<string, unknown>,
    compatibilities: Array.isArray(s.compatibilities) ? s.compatibilities : [],
    scrap: s.scrap ?? null,
    magaluCategoryLabel: s.magaluCategoryLabel ?? null,
    currentStep: typeof s.currentStep === "number" ? s.currentStep : null,
    label: {
      name: String(s.label?.name ?? ""),
      sku: s.label?.sku ?? null,
    },
  };
}

/** Snapshot expirado? `ttlMs <= 0` desliga a expiração. */
export function isExpired(
  snapshot: ProductFormSnapshot,
  now: number,
  ttlMs: number,
): boolean {
  if (ttlMs <= 0) return false;
  return now - snapshot.savedAt > ttlMs;
}

/**
 * O formulário tem algo digitado que valha a pena guardar?
 *
 * Evita gravar rascunho de um modal que só foi aberto e fechado: os
 * `defaultValues` sozinhos não são rascunho. `description` e `costPrice` ficam
 * de fora da conta porque a abertura os pré-preenche sozinha
 * (`fetchDefaultDescription`), e `stock`/`price` porque têm default numérico.
 */
const MEANINGFUL_FIELDS = [
  "name",
  "brand",
  "model",
  "year",
  "version",
  "category",
  "partNumber",
  "sourceVehicle",
  "quality",
  "location",
  "locationId",
  "imageUrl",
  "mlCategory",
  "shopeeCategory",
  "magaluCategory",
] as const;

export function hasMeaningfulContent(snapshot: ProductFormSnapshot): boolean {
  if (snapshot.compatibilities.length > 0) return true;
  const attrs = snapshot.values.attributes;
  if (attrs && typeof attrs === "object" && Object.keys(attrs).length > 0) {
    return true;
  }
  const urls = snapshot.values.imageUrls;
  if (Array.isArray(urls) && urls.length > 0) return true;
  return MEANINGFUL_FIELDS.some((f) => {
    const v = snapshot.values[f];
    return typeof v === "string" ? v.trim().length > 0 : Boolean(v);
  });
}
