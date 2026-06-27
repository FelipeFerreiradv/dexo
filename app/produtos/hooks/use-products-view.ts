"use client";

import { useCallback, useEffect, useState } from "react";

export type ProductsView = "catalog" | "list";

const STORAGE_KEY = "dexo:produtos:view";

function readStored(): ProductsView | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "catalog" || raw === "list" ? raw : null;
  } catch {
    return null;
  }
}

function persist(value: ProductsView): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // localStorage pode estar bloqueado (modo privado etc.) — ignora.
  }
}

/**
 * Preferência de visão da lista de Produtos (Catálogo x Lista), persistida no
 * localStorage. SSR-safe: o 1º render usa `defaultValue` e o valor real é
 * aplicado no mount. Espelha `app/pedidos/hooks/use-orders-view.ts`.
 */
export function useProductsView(
  defaultValue: ProductsView = "catalog",
): [ProductsView, (next: ProductsView) => void] {
  const [view, setView] = useState<ProductsView>(defaultValue);

  useEffect(() => {
    const stored = readStored();
    if (stored !== null) setView(stored);
  }, []);

  const setAndPersist = useCallback((next: ProductsView) => {
    setView(next);
    persist(next);
  }, []);

  return [view, setAndPersist];
}
