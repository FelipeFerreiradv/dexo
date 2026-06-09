"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "dexo:upload:addShadow";

function readStored(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    return raw === "true" || raw === "1";
  } catch {
    return null;
  }
}

function persist(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // localStorage pode estar bloqueado (modo privado etc.) — ignora.
  }
}

/**
 * Lê e escreve no localStorage a preferência do usuário sobre adicionar
 * automaticamente a sombra de contato no upload. SSR-safe: o primeiro
 * render usa `defaultValue` e o valor real do localStorage é aplicado no
 * mount. Espelha `use-remove-background-toggle` (mesma UX/persistência).
 *
 * A sombra exige o recorte (alpha): a UI desabilita este toggle quando
 * "remover fundo" está desligado, e o backend ignora `addShadow` nesse caso.
 */
export function useAddShadowToggle(
  defaultValue = true,
): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(defaultValue);

  useEffect(() => {
    const stored = readStored();
    if (stored !== null) setValue(stored);
  }, []);

  const setAndPersist = useCallback((next: boolean) => {
    setValue(next);
    persist(next);
  }, []);

  return [value, setAndPersist];
}
