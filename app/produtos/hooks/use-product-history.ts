"use client";

import { useCallback, useEffect, useState } from "react";

import {
  serializeProductForm,
  type ProductFormSnapshot,
  type SerializeInput,
} from "../lib/product-form-snapshot";
import {
  clearHistory,
  historyKey,
  pushHistory,
  readHistory,
  HISTORY_MAX_ENTRIES,
} from "../lib/product-form-storage";

export interface UseProductHistoryOptions {
  /** `false` esconde a feature por completo. */
  enabled: boolean;
  /** `parentUserId ?? id` da sessão. `null` => não lê nem grava. */
  owner: string | null;
  now?: () => number;
}

export interface UseProductHistory {
  entries: ProductFormSnapshot[];
  /** Grava o snapshot do cadastro que acabou de ser submetido com sucesso. */
  record: (input: Omit<SerializeInput, "now">) => void;
  clear: () => void;
}

/**
 * Histórico dos últimos cadastros bem-sucedidos (teto em
 * `HISTORY_MAX_ENTRIES`), para reaproveitar num cadastro parecido.
 *
 * ── Por que o snapshot do FORMULÁRIO, e não uma consulta ao banco ──
 * O `Product` no banco não guarda boa parte do que o usuário preencheu aqui:
 * contas de marketplace selecionadas, tipo de anúncio, garantia, modo de
 * envio, frete grátis, retirada, tempo de fabricação, atributos dinâmicos do
 * ML e as compatibilidades editadas na hora. Reconstituir isso exigiria juntar
 * `Product` + `ProductListing` + `ProductCompatibility` + contas, e ainda
 * assim viria incompleto. O snapshot do form é fiel e custa zero query.
 *
 * (Um endpoint de "últimos produtos do tenant" cobriria o caso de trocar de
 * máquina — fica como complemento proposto, não substituto.)
 */
export function useProductHistory({
  enabled,
  owner,
  now = Date.now,
}: UseProductHistoryOptions): UseProductHistory {
  const [entries, setEntries] = useState<ProductFormSnapshot[]>([]);
  const key = owner ? historyKey(owner) : null;

  // Leitura única no mount, como o padrão do projeto manda.
  useEffect(() => {
    if (!enabled || !key) {
      setEntries([]);
      return;
    }
    setEntries(readHistory(key));
  }, [enabled, key]);

  const record = useCallback(
    (input: Omit<SerializeInput, "now">) => {
      if (!enabled || !key) return;
      const snapshot = serializeProductForm({ ...input, now: now() });
      setEntries(pushHistory(key, snapshot));
    },
    [enabled, key, now],
  );

  const clear = useCallback(() => {
    if (key) clearHistory(key);
    setEntries([]);
  }, [key]);

  return { entries, record, clear };
}

export { HISTORY_MAX_ENTRIES };
