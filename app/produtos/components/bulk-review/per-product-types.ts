// Contrato de tipos do modo "Revisão individual" (bulk → produto a produto).
//
// Módulo PURO (sem JSX/React) — define:
//   1. `PerProductListingConfig` — estado em memória da camada de anúncio de UM
//      produto (espelha os campos de anúncio do `productSchema` do modal).
//   2. `PerProductOverrides` — payload ADITIVO enviado DENTRO de
//      `overrideTemplate.perProductOverrides` no `POST /listings/bulk`. Quando
//      ausente, o backend se comporta byte-idêntico ao de hoje.
//   3. Builders puros (defaults → config, config map → overrides) — testáveis.
//
// O shape de `PerProductOverrideEntry` é o MESMO consumido pelo backend
// (`bulk-listing-job.repository.ts`). Mantemos uma cópia local (client-side) para
// não importar código de servidor no bundle do cliente.

import { z } from "zod";

// ---- Config por produto (estado do formulário) ---------------------------

export const perProductListingSchema = z.object({
  /** Inclui este produto no Mercado Livre (default: true quando há conta ML). */
  includeMl: z.boolean(),
  /** Inclui este produto na Shopee (default: true quando há conta Shopee). */
  includeShopee: z.boolean(),
  /** Inclui este produto no Magalu (default: true quando há conta Magalu). */
  includeMagalu: z.boolean(),
  /** Categoria automática ligada — pré-preenche categoria sugerida (override ok). */
  autoCategory: z.boolean(),

  /** Categoria ML (id EXTERNO, ex.: MLB116479 — igual ao `mlCategory` do modal). */
  mlCategory: z.string().optional(),
  /** Rótulo (caminho) da categoria ML — só exibição; não vai para o backend. */
  mlCategoryLabel: z.string().optional(),
  /** Categoria Shopee (id folha externo, ex.: SHP_102287). */
  shopeeCategory: z.string().optional(),
  /** Rótulo da categoria Shopee — só exibição. */
  shopeeCategoryLabel: z.string().optional(),
  /** Categoria Magalu (id da categoria; vazio ⇒ backend resolve no envio). */
  magaluCategory: z.string().optional(),
  /** Rótulo (caminho "A/B/C") da categoria Magalu — só exibição. */
  magaluCategoryLabel: z.string().optional(),

  /** Subconjunto das contas ML selecionadas globalmente (default: todas). */
  mlAccountIds: z.array(z.string()),
  /** Subconjunto das contas Shopee selecionadas globalmente (default: todas). */
  shopeeAccountIds: z.array(z.string()),
  /** Subconjunto das contas Magalu selecionadas globalmente (default: todas). */
  magaluAccountIds: z.array(z.string()),

  mlCatalogProductId: z.string().nullable().optional(),
  attributes: z.record(
    z.object({
      value_id: z.string().optional(),
      value_name: z.string().optional(),
    }),
  ),
  mlListingType: z.string().optional(),
  mlItemCondition: z.string().optional(),
  mlHasWarranty: z.boolean().optional(),
  mlWarrantyUnit: z.string().optional(),
  mlWarrantyDuration: z.number().int().min(1).nullable().optional(),
  mlShippingMode: z.string().optional(),
  mlFreeShipping: z.boolean().optional(),
  mlLocalPickup: z.boolean().optional(),
  mlManufacturingTime: z.number().int().min(0).nullable().optional(),
  mlListingPrice: z.number().min(0).nullable().optional(),
});

export type PerProductListingConfig = z.infer<typeof perProductListingSchema>;

/** Produto (subconjunto usado pelo hook/estado do modo Revisão). */
export interface ReviewProduct {
  id: string;
  sku: string;
  name: string;
  price: number;
  imageUrl?: string | null;
  imageUrls?: string[] | null;
  mlCategoryId?: string | null;
  shopeeCategoryId?: string | null;
}

/** Conta de marketplace (subconjunto usado nos componentes do modo Revisão). */
export interface ReviewAccountLite {
  id: string;
  accountName: string;
  status?: string;
  shopId?: number;
}

/** Opção de categoria (id externo + caminho), igual ao preview/modal. */
export interface ReviewCategoryOption {
  id: string;
  value: string;
}

// ---- Defaults globais (etapa "Defaults globais" / Regras) -----------------

export interface GlobalListingDefaults {
  autoCategory: boolean;
  mlListingType: string;
  mlItemCondition: string;
  mlFreeShipping: boolean;
}

// ---- Payload ADITIVO enviado ao backend ----------------------------------

export interface PerProductMlOverride {
  categoryId?: string;
  listingType?: string;
  itemCondition?: string;
  hasWarranty?: boolean;
  warrantyUnit?: string;
  warrantyDuration?: number;
  shippingMode?: string;
  freeShipping?: boolean;
  localPickup?: boolean;
  manufacturingTime?: number;
  listingPrice?: number;
  catalogProductId?: string;
  attributes?: Record<string, { value_id?: string; value_name?: string }>;
}

export interface PerProductShopeeOverride {
  categoryId?: string;
}

export interface PerProductMagaluOverride {
  categoryId?: string;
}

export interface PerProductOverrideEntry {
  ml?: PerProductMlOverride;
  shopee?: PerProductShopeeOverride;
  magalu?: PerProductMagaluOverride;
  /** Contas ML globais que ESTE produto NÃO publica (skip por conta). */
  disabledMlAccountIds?: string[];
  /** Contas Shopee globais que ESTE produto NÃO publica. */
  disabledShopeeAccountIds?: string[];
  /** Contas Magalu globais que ESTE produto NÃO publica. */
  disabledMagaluAccountIds?: string[];
}

export type PerProductOverrides = Record<string, PerProductOverrideEntry>;

// ---- Builders puros -------------------------------------------------------

/** Config inicial de um produto a partir dos defaults globais + contas globais. */
export function configFromDefaults(
  defaults: GlobalListingDefaults,
  globalMlIds: string[],
  globalShopeeIds: string[],
  globalMagaluIds: string[] = [],
): PerProductListingConfig {
  return {
    includeMl: globalMlIds.length > 0,
    includeShopee: globalShopeeIds.length > 0,
    includeMagalu: globalMagaluIds.length > 0,
    autoCategory: defaults.autoCategory,
    mlCategory: undefined,
    shopeeCategory: undefined,
    magaluCategory: undefined,
    mlAccountIds: [...globalMlIds],
    shopeeAccountIds: [...globalShopeeIds],
    magaluAccountIds: [...globalMagaluIds],
    mlCatalogProductId: null,
    attributes: {},
    mlListingType: defaults.mlListingType,
    mlItemCondition: defaults.mlItemCondition,
    mlHasWarranty: false,
    mlWarrantyUnit: "dias",
    mlWarrantyDuration: null,
    mlShippingMode: "me2",
    mlFreeShipping: defaults.mlFreeShipping,
    mlLocalPickup: false,
    mlManufacturingTime: null,
    mlListingPrice: null,
  };
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * Monta `perProductOverrides` a partir do mapa de configs. Só inclui entradas
 * que têm algum efeito real (categoria/atributos/ajustes ou skip de conta),
 * deixando o payload enxuto. As CONTAS continuam vindo do `requests` global; o
 * controle por produto se dá via `disabledMl/ShopeeAccountIds`.
 */
export function buildPerProductOverrides(
  map: Record<string, PerProductListingConfig>,
  globalMlIds: string[],
  globalShopeeIds: string[],
  globalMagaluIds: string[] = [],
): PerProductOverrides {
  const out: PerProductOverrides = {};

  for (const [productId, cfg] of Object.entries(map)) {
    const entry: PerProductOverrideEntry = {};

    if (globalMlIds.length > 0) {
      if (cfg.includeMl) {
        const ml = pruneUndefined({
          categoryId: cfg.mlCategory || undefined,
          listingType: cfg.mlListingType,
          itemCondition: cfg.mlItemCondition,
          hasWarranty: cfg.mlHasWarranty,
          warrantyUnit: cfg.mlHasWarranty ? cfg.mlWarrantyUnit : undefined,
          warrantyDuration:
            cfg.mlHasWarranty && cfg.mlWarrantyDuration != null
              ? cfg.mlWarrantyDuration
              : undefined,
          shippingMode: cfg.mlShippingMode,
          freeShipping: cfg.mlFreeShipping,
          localPickup: cfg.mlLocalPickup,
          manufacturingTime: cfg.mlManufacturingTime ?? undefined,
          listingPrice: cfg.mlListingPrice ?? undefined,
          catalogProductId: cfg.mlCatalogProductId ?? undefined,
          attributes:
            cfg.attributes && Object.keys(cfg.attributes).length > 0
              ? cfg.attributes
              : undefined,
        }) as PerProductMlOverride;
        if (Object.keys(ml).length > 0) entry.ml = ml;
        const disabled = globalMlIds.filter(
          (id) => !cfg.mlAccountIds.includes(id),
        );
        if (disabled.length > 0) entry.disabledMlAccountIds = disabled;
      } else {
        // Produto excluído do ML por inteiro.
        entry.disabledMlAccountIds = [...globalMlIds];
      }
    }

    if (globalShopeeIds.length > 0) {
      if (cfg.includeShopee) {
        const shopee = pruneUndefined({
          categoryId: cfg.shopeeCategory || undefined,
        }) as PerProductShopeeOverride;
        if (Object.keys(shopee).length > 0) entry.shopee = shopee;
        const disabled = globalShopeeIds.filter(
          (id) => !cfg.shopeeAccountIds.includes(id),
        );
        if (disabled.length > 0) entry.disabledShopeeAccountIds = disabled;
      } else {
        entry.disabledShopeeAccountIds = [...globalShopeeIds];
      }
    }

    if (globalMagaluIds.length > 0) {
      if (cfg.includeMagalu) {
        const magalu = pruneUndefined({
          categoryId: cfg.magaluCategory || undefined,
        }) as PerProductMagaluOverride;
        if (Object.keys(magalu).length > 0) entry.magalu = magalu;
        const disabled = globalMagaluIds.filter(
          (id) => !cfg.magaluAccountIds.includes(id),
        );
        if (disabled.length > 0) entry.disabledMagaluAccountIds = disabled;
      } else {
        entry.disabledMagaluAccountIds = [...globalMagaluIds];
      }
    }

    if (
      entry.ml ||
      entry.shopee ||
      entry.magalu ||
      (entry.disabledMlAccountIds && entry.disabledMlAccountIds.length > 0) ||
      (entry.disabledShopeeAccountIds &&
        entry.disabledShopeeAccountIds.length > 0) ||
      (entry.disabledMagaluAccountIds &&
        entry.disabledMagaluAccountIds.length > 0)
    ) {
      out[productId] = entry;
    }
  }

  return out;
}

/**
 * Número efetivo de anúncios (pares produto×conta) considerando os skips por
 * produto. Espelha exatamente a poda do dispatcher, para o `totalItems` do job
 * bater com o progresso real.
 */
export function countEffectiveItems(
  overrides: PerProductOverrides,
  productIds: string[],
  requests: Array<{
    platform: "MERCADO_LIVRE" | "SHOPEE" | "MAGALU";
    accountId: string;
  }>,
): number {
  let total = 0;
  for (const pid of productIds) {
    const ov = overrides[pid];
    for (const r of requests) {
      const disabled =
        r.platform === "MERCADO_LIVRE"
          ? ov?.disabledMlAccountIds?.includes(r.accountId)
          : r.platform === "SHOPEE"
            ? ov?.disabledShopeeAccountIds?.includes(r.accountId)
            : ov?.disabledMagaluAccountIds?.includes(r.accountId);
      if (!disabled) total++;
    }
  }
  return total;
}
