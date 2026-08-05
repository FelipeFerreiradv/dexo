"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createDebouncedWriter } from "../lib/debounced-writer";
import {
  hasMeaningfulContent,
  isExpired,
  serializeProductForm,
  type ProductFormSnapshot,
  type SerializeInput,
} from "../lib/product-form-snapshot";
import {
  draftKey,
  readDraft,
  removeKey,
  writeDraft,
  type DraftScope,
} from "../lib/product-form-storage";

/** Janela de validade do rascunho. Expirado é descartado sem perguntar nada. */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/** Debounce do autosave. Uma rajada de digitação vira UMA escrita. */
export const DRAFT_DEBOUNCE_MS = 600;

export interface UseProductDraftOptions {
  /** `false` desliga persistência e a pergunta de restauração por completo. */
  enabled: boolean;
  /** `parentUserId ?? id` da sessão. `null` => não persiste nada. */
  owner: string | null;
  /** Contexto de abertura: cada um tem o seu próprio rascunho. */
  scope: DraftScope;
  /**
   * Modal aberto? A leitura acontece a CADA abertura, não uma vez no mount.
   *
   * O `CreateProductDialog` fica montado junto com a lista de produtos e só
   * alterna `open` — ele não desmonta ao fechar. Lendo só no mount, o rascunho
   * gravado ao fechar o modal só era oferecido depois de recarregar a página,
   * o que justamente elimina o caso mais comum da feature: fechar sem querer
   * e reabrir em seguida. Medido no navegador em 05/08/2026.
   */
  open: boolean;
  /** Injetável para teste. */
  now?: () => number;
}

export interface UseProductDraft {
  /** Há rascunho válido para oferecer nesta abertura? */
  hasDraft: boolean;
  /** O rascunho pendente (para o diálogo mostrar o que será restaurado). */
  draft: ProductFormSnapshot | null;
  /** Agenda uma gravação (debounced). Seguro chamar a cada tecla. */
  save: (input: Omit<SerializeInput, "now">) => void;
  /** Grava agora o que estiver pendente — usado ao fechar o modal. */
  flush: () => void;
  /** Marca o rascunho como consumido e devolve o snapshot. */
  restore: () => ProductFormSnapshot | null;
  /** Descarte explícito pelo usuário: apaga e não pergunta de novo. */
  discard: () => void;
  /** Limpeza silenciosa (submit bem-sucedido). */
  clear: () => void;
}

/**
 * Rascunho automático do formulário de novo produto.
 *
 * Decisões que importam:
 *  - a chave é escopada por usuário E por contexto de abertura, então o
 *    rascunho do cadastro normal nunca aparece no fluxo de NF-e nem no de
 *    sucata travada (onde o modal abre pré-preenchido por um contexto externo);
 *  - `sku` nunca é persistido (ver `NEVER_PERSISTED_FIELDS`): ele é revalidado
 *    a cada abertura e restaurá-lo faria o submit tomar o caminho manual;
 *  - a leitura acontece uma vez, no mount, como manda o padrão SSR-safe do
 *    projeto (`use-products-view.ts`);
 *  - toda operação de storage é `try/catch` lá embaixo: falhar em persistir
 *    nunca impede o cadastro.
 */
export function useProductDraft({
  enabled,
  owner,
  scope,
  open,
  now = Date.now,
}: UseProductDraftOptions): UseProductDraft {
  const [draft, setDraft] = useState<ProductFormSnapshot | null>(null);
  const key = owner ? draftKey(owner, scope) : null;
  const keyRef = useRef(key);
  keyRef.current = key;

  const writer = useMemo(
    () =>
      createDebouncedWriter<ProductFormSnapshot>((snapshot) => {
        const k = keyRef.current;
        if (!k) return;
        writeDraft(k, snapshot);
      }, DRAFT_DEBOUNCE_MS),
    [],
  );

  // Leitura a cada abertura (SSR-safe: o 1º render nunca toca em window).
  // Dentro de UMA abertura o efeito não roda de novo, então responder a
  // pergunta (restaurar/descartar) não faz ela voltar.
  useEffect(() => {
    if (!enabled || !key) {
      setDraft(null);
      return;
    }
    // Fechado: não lê e não mexe no que já está em memória. Quem grava ao
    // fechar é o `flush`; a próxima abertura relê.
    if (!open) return;
    const stored = readDraft(key);
    if (!stored) return;
    // Expirado ou sem conteúdo de verdade => some sem perguntar.
    if (
      isExpired(stored, now(), DRAFT_TTL_MS) ||
      !hasMeaningfulContent(stored)
    ) {
      removeKey(key);
      return;
    }
    setDraft(stored);
  }, [enabled, key, open, now]);

  useEffect(() => () => writer.cancel(), [writer]);

  const save = useCallback(
    (input: Omit<SerializeInput, "now">) => {
      if (!enabled || !keyRef.current) return;
      const snapshot = serializeProductForm({ ...input, now: now() });
      // Modal aberto e fechado sem digitar nada não vira rascunho.
      if (!hasMeaningfulContent(snapshot)) return;
      writer.schedule(snapshot);
    },
    [enabled, now, writer],
  );

  const flush = useCallback(() => {
    if (!enabled) return;
    writer.flush();
  }, [enabled, writer]);

  const clear = useCallback(() => {
    writer.cancel();
    if (keyRef.current) removeKey(keyRef.current);
    setDraft(null);
  }, [writer]);

  const discard = useCallback(() => {
    clear();
  }, [clear]);

  const restore = useCallback(() => {
    const snapshot = draft;
    setDraft(null);
    return snapshot;
  }, [draft]);

  return {
    hasDraft: enabled && draft !== null,
    draft,
    save,
    flush,
    restore,
    discard,
    clear,
  };
}
