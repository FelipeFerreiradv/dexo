"use client";

import { useCallback, useEffect, useState } from "react";

import {
  PRODUCT_SORTS,
  type ProductSort,
} from "@/app/interfaces/product.interface";

const STORAGE_KEY = "dexo:produtos:sort";

/** Rótulos do seletor. A ordem aqui é a ordem que aparece na tela. */
export const PRODUCT_SORT_LABELS: Record<ProductSort, string> = {
  recentes: "Mais recentes",
  sku_asc: "SKU crescente",
  sku_desc: "SKU decrescente",
};

function readStored(): ProductSort | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return (PRODUCT_SORTS as readonly string[]).includes(raw ?? "")
      ? (raw as ProductSort)
      : null;
  } catch {
    return null;
  }
}

function persist(value: ProductSort): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // localStorage pode estar bloqueado (modo privado etc.) — ignora.
  }
}

/**
 * Ordenação da lista de Produtos, persistida no localStorage. SSR-safe: o 1º
 * render usa `defaultValue` e o valor real é aplicado no mount. Espelha
 * `app/produtos/hooks/use-products-view.ts`.
 *
 * Não é escopada por usuário de propósito: é preferência de VISUALIZAÇÃO, como
 * `dexo:produtos:view` e `dexo:pedidos:view`, e não conteúdo de ninguém. O
 * escopo por usuário fica para rascunho e histórico, que carregam dado digitado.
 */
export function useProductSort(
  defaultValue: ProductSort = "recentes",
): [ProductSort, (next: ProductSort) => void] {
  const [sort, setSort] = useState<ProductSort>(defaultValue);

  useEffect(() => {
    const stored = readStored();
    if (stored !== null) setSort(stored);
  }, []);

  const setAndPersist = useCallback((next: ProductSort) => {
    setSort(next);
    persist(next);
  }, []);

  return [sort, setAndPersist];
}
