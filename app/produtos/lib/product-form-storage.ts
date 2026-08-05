/**
 * Acesso ao `localStorage` do rascunho e do histórico do modal de produto.
 *
 * Segue o padrão canônico do projeto (`app/produtos/hooks/use-products-view.ts`):
 * guarda `typeof window === "undefined"` para SSR e `try/catch` silencioso em
 * TODA operação, porque o storage pode estar bloqueado (modo privado), cheio
 * (quota) ou desabilitado por política. Falha de persistência NUNCA pode
 * impedir o cadastro.
 *
 * ── Escopo por usuário (inaugura o padrão no repo) ──
 * Nenhuma chave existente é escopada: `dexo:produtos:view`, `dexo:pedidos:view`
 * e as demais são globais ao navegador. Aqui não pode ser: um cadastro em
 * andamento é conteúdo do usuário, e dois usuários no mesmo navegador (balcão,
 * máquina compartilhada da loja) não podem enxergar o rascunho um do outro.
 *
 * O dono do dado no backend é `dataOwnerId` (`auth.middleware.ts`:
 * `parentUserId ?? id`). No front esse campo não existe pronto — a expressão
 * equivalente é `session.user.parentUserId ?? session.user.id`, que é o que
 * `scopeKeyFor` espera receber. Sem identidade, não persiste nada.
 */

import {
  parseSnapshot,
  type ProductFormSnapshot,
} from "./product-form-snapshot";

const PREFIX = "dexo:produtos";

/** Contexto de abertura do modal. Cada um tem seu próprio rascunho. */
export type DraftScope = "manual" | "nfe" | "scrap";

/**
 * Identidade do dono do rascunho. `null` quando a sessão ainda não carregou —
 * nesse caso não lemos nem gravamos, em vez de cair num balde compartilhado.
 */
export function scopeKeyFor(
  parentUserId: string | null | undefined,
  userId: string | null | undefined,
): string | null {
  const owner = (parentUserId || userId || "").trim();
  return owner ? owner : null;
}

export function draftKey(owner: string, scope: DraftScope): string {
  return `${PREFIX}:draft:v1:${owner}:${scope}`;
}

export function historyKey(owner: string): string {
  return `${PREFIX}:history:v1:${owner}`;
}

function readRaw(key: string): unknown {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    // JSON corrompido ou storage bloqueado — trata como "não existe".
    return null;
  }
}

function writeRaw(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota estourada, modo privado, storage desabilitado — degrada em
    // silêncio. Nunca propaga para o fluxo de cadastro.
  }
}

export function removeKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignora
  }
}

// ── Rascunho ────────────────────────────────────────────────────────────────

export function readDraft(key: string): ProductFormSnapshot | null {
  return parseSnapshot(readRaw(key));
}

export function writeDraft(key: string, snapshot: ProductFormSnapshot): void {
  writeRaw(key, snapshot);
}

// ── Histórico ───────────────────────────────────────────────────────────────

/** Teto de snapshots guardados. O mais antigo sai quando estoura. */
export const HISTORY_MAX_ENTRIES = 5;

/**
 * Teto de tamanho por snapshot serializado. Um cadastro com muitas
 * compatibilidades e ficha técnica cheia passa fácil de 10 KB; acima disto o
 * ganho de guardar não compensa o risco de estourar a quota do domínio inteiro
 * (que derrubaria também as preferências de visão).
 *
 * ATENÇÃO ao nome: a comparação é contra `serialized.length`, que conta
 * unidades UTF-16, não bytes. Para texto ASCII os dois coincidem; com acento e
 * emoji o teto real em bytes chega a ser o dobro. Fica assim de propósito — o
 * número é uma salvaguarda folgada, não um limite exato, e apertá-lo passaria a
 * descartar snapshots que hoje são guardados. Auditado em 05/08/2026.
 */
export const HISTORY_MAX_ENTRY_BYTES = 48 * 1024;

export function readHistory(key: string): ProductFormSnapshot[] {
  const raw = readRaw(key);
  if (!Array.isArray(raw)) return [];
  const out: ProductFormSnapshot[] = [];
  for (const item of raw) {
    const parsed = parseSnapshot(item);
    // Entrada inválida ou de versão desconhecida some sem derrubar as outras.
    if (parsed) out.push(parsed);
  }
  return out.slice(0, HISTORY_MAX_ENTRIES);
}

/**
 * Insere no topo e descarta o mais antigo ao estourar o teto. Snapshot grande
 * demais é ignorado — silenciosamente, porque o histórico é conveniência.
 */
export function pushHistory(
  key: string,
  snapshot: ProductFormSnapshot,
): ProductFormSnapshot[] {
  let serialized = "";
  try {
    serialized = JSON.stringify(snapshot);
  } catch {
    return readHistory(key);
  }
  if (serialized.length > HISTORY_MAX_ENTRY_BYTES) {
    return readHistory(key);
  }
  const next = [snapshot, ...readHistory(key)].slice(0, HISTORY_MAX_ENTRIES);
  writeRaw(key, next);
  return next;
}

export function clearHistory(key: string): void {
  removeKey(key);
}
