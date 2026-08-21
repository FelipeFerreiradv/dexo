/**
 * Ponte mínima entre a aba de Mensagens e o badge da sidebar.
 *
 * O badge (`components/app-sidebar.tsx`) tem poll próprio de 60 s. Sem este
 * aviso, abrir uma conversa zerava o número da LINHA na hora e o da SIDEBAR só
 * até um minuto depois — parte do "some e volta" que a cliente relatou.
 *
 * `CustomEvent` de `window` em vez de contexto ou estado global: as duas
 * árvores de componentes não se conhecem, e nenhuma delas precisa passar a
 * conhecer. Sem provider novo, sem prop drilling, sem dependência de ordem de
 * montagem.
 */
export const UNREAD_CHANGED_EVENT = "dexo:messages-unread-changed";

/** Rajadas (ler várias conversas em sequência) viram um aviso só. */
const DEBOUNCE_MS = 500;
let ultimoAviso = 0;

/** Avisa que a contagem de não lidas mudou no servidor. No-op no SSR. */
export function notifyUnreadChanged(): void {
  if (typeof window === "undefined") return;
  const agora = Date.now();
  if (agora - ultimoAviso < DEBOUNCE_MS) return;
  ultimoAviso = agora;
  window.dispatchEvent(new CustomEvent(UNREAD_CHANGED_EVENT));
}

/** Assina o aviso; devolve o cancelamento para usar no cleanup do efeito. */
export function subscribeUnreadChanged(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(UNREAD_CHANGED_EVENT, cb);
  return () => window.removeEventListener(UNREAD_CHANGED_EVENT, cb);
}
