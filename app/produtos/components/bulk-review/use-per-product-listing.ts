"use client";

// Estado do modo "Revisão individual": um ÚNICO useForm reaproveitado entre
// produtos + um mapa `perProduct` que é a fonte de verdade. Ao navegar, salva o
// form atual no mapa (flush) e dá reset com a config do próximo. Init é LAZY (na
// 1ª visita): parte dos defaults globais, semeia categorias do produto e, se
// "categoria automática" estiver ligada, busca a sugestão (endpoints existentes,
// sem motor novo) preenchendo só o que estiver vazio — sem nunca sobrescrever o
// que o usuário editou.

import { useCallback, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { getApiBaseUrl } from "@/lib/api";
import {
  perProductListingSchema,
  configFromDefaults,
  type PerProductListingConfig,
  type GlobalListingDefaults,
  type ReviewProduct,
  type ReviewCategoryOption,
} from "./per-product-types";

interface UsePerProductListingArgs {
  products: ReviewProduct[];
  defaults: GlobalListingDefaults;
  globalMlIds: string[];
  globalShopeeIds: string[];
  globalMagaluIds: string[];
  mlOptions: ReviewCategoryOption[];
  email: string;
}

const EMPTY_CONFIG: PerProductListingConfig = {
  includeMl: false,
  includeShopee: false,
  includeMagalu: false,
  autoCategory: true,
  mlAccountIds: [],
  shopeeAccountIds: [],
  magaluAccountIds: [],
  attributes: {},
  mlCatalogProductId: null,
  mlListingType: "gold_special",
  mlItemCondition: "used",
  mlHasWarranty: false,
  mlWarrantyUnit: "dias",
  mlWarrantyDuration: null,
  mlShippingMode: "me2",
  mlFreeShipping: false,
  mlLocalPickup: false,
  mlManufacturingTime: null,
  mlListingPrice: null,
};

export function usePerProductListing({
  products,
  defaults,
  globalMlIds,
  globalShopeeIds,
  globalMagaluIds,
  mlOptions,
  email,
}: UsePerProductListingArgs) {
  const form = useForm<PerProductListingConfig>({
    resolver: zodResolver(perProductListingSchema),
    defaultValues: EMPTY_CONFIG,
  });

  const [index, setIndex] = useState(0);
  const [initializing, setInitializing] = useState(false);
  const [perProduct, setPerProduct] = useState<
    Record<string, PerProductListingConfig>
  >({});

  // Espelho síncrono do mapa (state é assíncrono): leitura sempre atual.
  const mapRef = useRef<Record<string, PerProductListingConfig>>({});
  const currentIdRef = useRef<string | null>(null);

  const writeConfig = useCallback(
    (id: string, cfg: PerProductListingConfig) => {
      mapRef.current = { ...mapRef.current, [id]: cfg };
      setPerProduct(mapRef.current);
    },
    [],
  );

  // Busca de categoria sugerida (ML + Shopee) via endpoints existentes.
  const fetchSuggested = useCallback(
    async (p: ReviewProduct) => {
      const out: {
        mlCategory?: string;
        mlCategoryLabel?: string;
        shopeeCategory?: string;
        shopeeCategoryLabel?: string;
        magaluCategory?: string;
        magaluCategoryLabel?: string;
      } = {};
      const base = getApiBaseUrl();
      const headers = { email } as Record<string, string>;
      if (globalMlIds.length > 0) {
        try {
          const r = await fetch(
            `${base}/marketplace/ml/category-suggest?title=${encodeURIComponent(p.name)}`,
            { headers },
          );
          if (r.ok) {
            const d = await r.json();
            const s0 = d?.suggestions?.[0];
            if (s0?.categoryId) {
              out.mlCategory = s0.categoryId as string;
              if (s0.fullPath) out.mlCategoryLabel = s0.fullPath as string;
            }
          }
        } catch {
          // fail-open: sem sugestão ⇒ usuário escolhe manualmente
        }
      }
      if (globalShopeeIds.length > 0) {
        try {
          const r = await fetch(
            `${base}/marketplace/shopee/category-suggest?title=${encodeURIComponent(p.name)}`,
            { headers },
          );
          if (r.ok) {
            const d = await r.json();
            const s0 = d?.suggestions?.[0];
            if (s0?.categoryId) {
              out.shopeeCategory = s0.categoryId as string;
              if (s0.fullPath) out.shopeeCategoryLabel = s0.fullPath as string;
            }
          }
        } catch {
          // fail-open: categoria Shopee inválida/ausente cai no preflight
        }
      }
      if (globalMagaluIds.length > 0) {
        try {
          // Magalu usa a MESMA resolução do create (de-para/busca); o endpoint
          // recebe `name=` (não `title=`) e devolve { categoryId, path }.
          const r = await fetch(
            `${base}/marketplace/magalu/category-suggest?name=${encodeURIComponent(p.name)}`,
            { headers },
          );
          if (r.ok) {
            const d = await r.json();
            if (d?.categoryId) {
              out.magaluCategory = d.categoryId as string;
              out.magaluCategoryLabel = (d.path || d.categoryId) as string;
            }
          }
        } catch {
          // fail-open: sem sugestão ⇒ backend resolve no envio (DRAFT)
        }
      }
      return out;
    },
    [email, globalMlIds.length, globalShopeeIds.length, globalMagaluIds.length],
  );

  // Preenche categorias sugeridas no form atual. onlyEmpty=true respeita o que
  // o usuário já preencheu; false (toggle explícito) sobrescreve.
  const runAutoSuggest = useCallback(
    async (p: ReviewProduct, onlyEmpty: boolean) => {
      setInitializing(true);
      try {
        const sug = await fetchSuggested(p);
        if (currentIdRef.current !== p.id) return; // navegou pra outro produto
        const cur = form.getValues();
        let changed = false;
        if (sug.mlCategory && (!onlyEmpty || !cur.mlCategory)) {
          form.setValue("mlCategory", sug.mlCategory, { shouldDirty: false });
          form.setValue("mlCategoryLabel", sug.mlCategoryLabel ?? "", {
            shouldDirty: false,
          });
          changed = true;
        }
        if (sug.shopeeCategory && (!onlyEmpty || !cur.shopeeCategory)) {
          form.setValue("shopeeCategory", sug.shopeeCategory, {
            shouldDirty: false,
          });
          form.setValue("shopeeCategoryLabel", sug.shopeeCategoryLabel ?? "", {
            shouldDirty: false,
          });
          changed = true;
        }
        if (sug.magaluCategory && (!onlyEmpty || !cur.magaluCategory)) {
          form.setValue("magaluCategory", sug.magaluCategory, {
            shouldDirty: false,
          });
          form.setValue("magaluCategoryLabel", sug.magaluCategoryLabel ?? "", {
            shouldDirty: false,
          });
          changed = true;
        }
        if (changed) writeConfig(p.id, form.getValues());
      } finally {
        if (currentIdRef.current === p.id) setInitializing(false);
      }
    },
    [fetchSuggested, form, writeConfig],
  );

  const flushCurrent = useCallback(() => {
    const id = currentIdRef.current;
    if (id) writeConfig(id, form.getValues());
  }, [form, writeConfig]);

  const loadInto = useCallback(
    (idx: number) => {
      const p = products[idx];
      if (!p) return;
      // Salva o produto atual antes de trocar.
      flushCurrent();

      let cfg = mapRef.current[p.id];
      const isNew = !cfg;
      if (!cfg) {
        cfg = configFromDefaults(
          defaults,
          globalMlIds,
          globalShopeeIds,
          globalMagaluIds,
        );
        // NÃO semear mlCategory do produto: product.mlCategoryId é um id INTERNO
        // (cuid, FK p/ MarketplaceCategory) — incompatível com o combobox/sugestão
        // (que usam id EXTERNO MLB...). Vazio ⇒ a sugestão automática preenche um id
        // externo (com nome) e, se ficar vazio, o backend usa a categoria do próprio
        // produto (resolveMLCategory via findById). shopeeCategoryId JÁ é externo
        // (SHP_...), então pode semear direto.
        if (p.shopeeCategoryId) cfg.shopeeCategory = p.shopeeCategoryId;
        writeConfig(p.id, cfg);
      }
      form.reset(cfg);
      currentIdRef.current = p.id;
      setIndex(idx);

      // Sugestão automática só na 1ª visita e só p/ categorias ainda vazias.
      if (isNew && cfg.autoCategory) {
        void runAutoSuggest(p, true);
      } else {
        setInitializing(false);
      }
    },
    [
      products,
      flushCurrent,
      defaults,
      globalMlIds,
      globalShopeeIds,
      globalMagaluIds,
      writeConfig,
      form,
      runAutoSuggest,
    ],
  );

  /** Inicializa o passo (entra no produto atual; 0 na 1ª vez). */
  const enterStep = useCallback(() => {
    loadInto(index);
  }, [loadInto, index]);

  /** Avança; retorna false se já está no último (cabe ao caller finalizar). */
  const goNext = useCallback(() => {
    if (index >= products.length - 1) {
      flushCurrent();
      return false;
    }
    loadInto(index + 1);
    return true;
  }, [index, products.length, flushCurrent, loadInto]);

  /** Volta; retorna false se já está no primeiro (caller volta de etapa). */
  const goBack = useCallback(() => {
    if (index <= 0) {
      flushCurrent();
      return false;
    }
    loadInto(index - 1);
    return true;
  }, [index, flushCurrent, loadInto]);

  /** Reaplica categoria automática ao produto atual (sobrescreve). */
  const applyAutoCategory = useCallback(() => {
    const p = products[index];
    if (p) void runAutoSuggest(p, false);
  }, [products, index, runAutoSuggest]);

  /** Salva o produto atual e devolve o mapa completo (no Finalizar). */
  const finalizeFlush = useCallback(() => {
    flushCurrent();
    return mapRef.current;
  }, [flushCurrent]);

  /** Zera tudo (ao fechar/reabrir o wizard). */
  const resetAll = useCallback(() => {
    mapRef.current = {};
    currentIdRef.current = null;
    setPerProduct({});
    setIndex(0);
    setInitializing(false);
    form.reset(EMPTY_CONFIG);
  }, [form]);

  return {
    form,
    index,
    current: products[index],
    total: products.length,
    initializing,
    perProduct,
    enterStep,
    goNext,
    goBack,
    applyAutoCategory,
    finalizeFlush,
    resetAll,
    // mlOptions repassado p/ conveniência de quem usa o hook na UI
    mlOptions,
  };
}

export type UsePerProductListingReturn = ReturnType<
  typeof usePerProductListing
>;
