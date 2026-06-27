"use client";

import { useCallback, useEffect, useState } from "react";

export type OrdersView = "gallery" | "table";

const STORAGE_KEY = "dexo:pedidos:view";

function readStored(): OrdersView | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "gallery" || raw === "table" ? raw : null;
  } catch {
    return null;
  }
}

function persist(value: OrdersView): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // localStorage pode estar bloqueado (modo privado etc.) — ignora.
  }
}

/**
 * Preferência de visão da lista de Pedidos (Vitrine x Tabela), persistida no
 * localStorage. SSR-safe: o 1º render usa `defaultValue` e o valor real é
 * aplicado no mount. Espelha `hooks/use-add-shadow-toggle.ts`.
 */
export function useOrdersView(
  defaultValue: OrdersView = "gallery",
): [OrdersView, (next: OrdersView) => void] {
  const [view, setView] = useState<OrdersView>(defaultValue);

  useEffect(() => {
    const stored = readStored();
    if (stored !== null) setView(stored);
  }, []);

  const setAndPersist = useCallback((next: OrdersView) => {
    setView(next);
    persist(next);
  }, []);

  return [view, setAndPersist];
}
