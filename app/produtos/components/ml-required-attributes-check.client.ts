// Cliente fino da checagem de atributos obrigatórios do Mercado Livre.
//
// Módulo PURO (sem React): testável em node, porque a suíte não tem jsdom.
//
// Contrato de segurança — FAIL-OPEN em tudo:
//   - flag desligada no servidor, 404 (front novo com API antiga), erro de rede,
//     timeout ou resposta inesperada → `null` = "não validar", e o fluxo segue
//     exatamente como antes;
//   - nunca lança.
//
// Com a flag desligada o front NÃO faz o POST de checagem nem espera rede no
// envio: o GET /status é consultado ao ABRIR a tela (aquecimento, em cache de
// módulo por 60 s) e o envio só lê o último valor conhecido, sem await. Sem
// resposta ainda, falha ou `enabled:false` → não valida, não liga spinner e não
// atrasa o POST /products nem a confirmação da massa.

import { diffMlFicha, type MlFicha } from "@/app/produtos/lib/ml-ficha.logic";

export interface MlRequiredCheckValue {
  value_id?: string;
  value_name?: string;
}

export interface MlRequiredCheckItem {
  key: string;
  productId?: string;
  product?: {
    name?: string;
    sku?: string;
    brand?: string;
    model?: string;
    year?: string;
    partNumber?: string;
    quality?: string;
    attributes?: Record<string, MlRequiredCheckValue>;
    mlCatalogProductId?: string;
  };
  categoryId?: string;
  /** `null` = campo do produto apagado na revisão. */
  attributeOverrides?: Record<string, MlRequiredCheckValue | null>;
}

export interface MlRequiredCheckIssue {
  attributeId: string;
  attributeName: string;
  reason: "missing" | "invalid_value";
  message: string;
}

export interface MlRequiredCheckResult {
  key: string;
  status: "ok" | "blocked" | "unknown";
  unknownReason?: string;
  categoryId: string | null;
  blocking: MlRequiredCheckIssue[];
  warnings: MlRequiredCheckIssue[];
  message: string | null;
}

/** Tamanho máximo de lote aceito pelo endpoint. */
export const ML_REQUIRED_CHECK_BATCH = 200;
/** Nenhuma chamada desta camada pode segurar o envio por mais que isto. */
export const ML_REQUIRED_CHECK_TIMEOUT_MS = 8000;
/** Validade do cache do GET /status. */
export const ML_REQUIRED_STATUS_TTL_MS = 60_000;

type FetchLike = typeof fetch;

const fetchImpl = (): FetchLike | null =>
  typeof fetch === "function" ? fetch : null;

async function fetchComTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const f = fetchImpl();
  if (!f) throw new Error("fetch indisponível");
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // ignora
      }
      reject(new Error("timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      f(url, { ...init, ...(controller ? { signal: controller.signal } : {}) }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let statusCache: {
  key: string;
  at: number;
  value: Promise<boolean>;
  /**
   * Último valor RESPONDIDO para esta (API, usuário), lido sem await no envio.
   * `null` = nunca respondeu. Sobrevive à revalidação: enquanto o GET novo não
   * volta, o envio segue com o valor anterior.
   */
  known: boolean | null;
} | null = null;

/** Só para testes. */
export function _resetMlRequiredStatusCache(): void {
  statusCache = null;
}

/**
 * AQUECIMENTO (abertura do modal/wizard): a checagem está ligada no servidor?
 * Uma consulta a cada 60 s por (API, usuário); as chamadas concorrentes
 * compartilham a mesma promessa. Qualquer falha → false (não validar).
 *
 * Os caminhos de ENVIO não chamam isto — leem `getKnownMlRequiredAttrsEnabled`,
 * que não faz rede. Senão, com a sessão aberta por mais de 60 s (o normal ao
 * preencher um produto), o clique pagaria um GET serial antes do POST.
 */
export function fetchMlRequiredAttrsEnabled(
  baseUrl: string,
  email: string,
  now: number = Date.now(),
): Promise<boolean> {
  const key = `${baseUrl}|${email}`;
  if (
    statusCache &&
    statusCache.key === key &&
    now - statusCache.at < ML_REQUIRED_STATUS_TTL_MS
  ) {
    return statusCache.value;
  }
  const anterior =
    statusCache && statusCache.key === key ? statusCache.known : null;
  const entrada: NonNullable<typeof statusCache> = {
    key,
    at: now,
    value: Promise.resolve(false),
    known: anterior,
  };
  entrada.value = (async () => {
    let enabled = false;
    try {
      const res = await fetchComTimeout(
        `${baseUrl}/marketplace/ml/required-attributes/status`,
        { method: "GET", headers: { email } },
        ML_REQUIRED_CHECK_TIMEOUT_MS,
      );
      if (res.ok) {
        const data = (await res.json()) as { enabled?: unknown } | null;
        enabled = data?.enabled === true;
      }
    } catch {
      enabled = false;
    }
    entrada.known = enabled;
    return enabled;
  })();
  statusCache = entrada;
  return entrada.value;
}

/**
 * ENVIO: último valor conhecido do status, SEM rede e sem TTL (vale a sessão
 * inteira; quem renova é o aquecimento). `null` = ainda sem resposta — quem
 * chama trata como desligada e segue sem esperar (fail-open: o backend ainda
 * barra antes do POST ao ML).
 */
export function getKnownMlRequiredAttrsEnabled(
  baseUrl: string,
  email: string,
): boolean | null {
  const key = `${baseUrl}|${email}`;
  return statusCache && statusCache.key === key ? statusCache.known : null;
}

/**
 * POST da checagem, em lotes de 200. `null` = não validar (flag desligada,
 * falha, timeout). Não consulta o /status — quem chama decide antes (ver
 * `checkMlRequiredAttributes`).
 */
export async function postMlRequiredAttributesCheck(
  baseUrl: string,
  email: string,
  items: MlRequiredCheckItem[],
): Promise<Map<string, MlRequiredCheckResult> | null> {
  if (!Array.isArray(items) || items.length === 0) return new Map();
  const out = new Map<string, MlRequiredCheckResult>();
  try {
    for (let i = 0; i < items.length; i += ML_REQUIRED_CHECK_BATCH) {
      const lote = items.slice(i, i + ML_REQUIRED_CHECK_BATCH);
      const res = await fetchComTimeout(
        `${baseUrl}/marketplace/ml/required-attributes/check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", email },
          body: JSON.stringify({ items: lote }),
        },
        ML_REQUIRED_CHECK_TIMEOUT_MS,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        enabled?: unknown;
        results?: unknown;
      } | null;
      if (data?.enabled !== true || !Array.isArray(data.results)) return null;
      for (const r of data.results as MlRequiredCheckResult[]) {
        if (r && typeof r.key === "string") out.set(r.key, r);
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Caminho de ENVIO das telas: só faz o POST quando o último status conhecido é
 * `true`. Desligada, sem resposta ainda ou falha → `null` (não validar) sem
 * nenhum round-trip — nem o GET /status. `null` = não validar.
 */
export async function checkMlRequiredAttributes(
  baseUrl: string,
  email: string,
  items: MlRequiredCheckItem[],
): Promise<Map<string, MlRequiredCheckResult> | null> {
  if (getKnownMlRequiredAttrsEnabled(baseUrl, email) !== true) return null;
  return postMlRequiredAttributesCheck(baseUrl, email, items);
}

/** Resultado do rascunho do modal que barra a criação (bloqueado COM mensagem). */
export function shouldBlockMlDraft(
  result: MlRequiredCheckResult | null | undefined,
): boolean {
  return (
    result?.status === "blocked" &&
    typeof result.message === "string" &&
    result.message.length > 0
  );
}

/**
 * Contador de requisição da checagem do wizard: cada disparo pega um "bilhete";
 * só o bilhete mais recente pode gravar o resultado. `invalidate` (reabertura
 * do wizard) torna velhos todos os bilhetes em voo.
 */
export function createMlCheckSequencer(): {
  next: () => () => boolean;
  invalidate: () => void;
} {
  let seq = 0;
  return {
    next: () => {
      const meu = ++seq;
      return () => meu === seq;
    },
    invalidate: () => {
      seq++;
    },
  };
}

/**
 * Chave do que foi avaliado para um produto na revisão individual: categoria +
 * ficha (ordenada, para a ordem das chaves não mudar a chave). O wizard só
 * exclui do lote o produto cuja chave no envio é a MESMA que foi avaliada — se
 * o operador (ou a sugestão automática) mudou algo depois, reavalia.
 */
export function mlRequiredCheckKey(
  categoryId: string | undefined | null,
  attributeOverrides?: Record<string, MlRequiredCheckValue | null> | null,
): string {
  const ficha = attributeOverrides ?? {};
  const ordenada: Record<string, MlRequiredCheckValue | null> = {};
  for (const id of Object.keys(ficha).sort()) {
    const v = ficha[id];
    if (v === null) {
      ordenada[id] = null;
      continue;
    }
    ordenada[id] = {
      ...(v.value_id !== undefined ? { value_id: v.value_id } : {}),
      ...(v.value_name !== undefined ? { value_name: v.value_name } : {}),
    };
  }
  return `${(categoryId ?? "").trim()}|${JSON.stringify(ordenada)}`;
}

/** Resultado por produto guardado pelo wizard. */
export interface MlBlockedEntry {
  message: string;
  /** `mlRequiredCheckKey` avaliada; ausente no modo rápido (sem ficha). */
  key?: string;
}

/**
 * Mapa produto → bloqueio a partir da resposta. Só `blocked` com mensagem entra;
 * `unknown` e `ok` não excluem nada (fail-open).
 */
export function buildMlBlockedMap(
  results: Map<string, MlRequiredCheckResult> | null,
  keysByProduct?: Record<string, string>,
): Record<string, MlBlockedEntry> {
  const out: Record<string, MlBlockedEntry> = {};
  if (!results) return out;
  for (const [pid, r] of results) {
    if (r?.status === "blocked" && typeof r.message === "string" && r.message) {
      out[pid] = {
        message: r.message,
        ...(keysByProduct?.[pid] !== undefined ? { key: keysByProduct[pid] } : {}),
      };
    }
  }
  return out;
}

/**
 * Avisos por linha para produtos que não puderam ser validados por falta de
 * categoria (mesma sugestão do servidor falhou). Não bloqueia.
 */
export function buildMlUnresolvedMap(
  results: Map<string, MlRequiredCheckResult> | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!results) return out;
  for (const [pid, r] of results) {
    if (r?.status === "unknown" && r.unknownReason === "category_unresolved") {
      out[pid] = ML_REQUIRED_UNRESOLVED_WARNING;
    }
  }
  return out;
}

export const ML_REQUIRED_UNRESOLVED_WARNING =
  "Não foi possível validar os campos obrigatórios do Mercado Livre: sem categoria.";

/** Cabeçalho da lista de não validados no diálogo de confirmação da revisão. */
export const ML_REQUIRED_UNRESOLVED_REVIEW_HEADER =
  "Produtos que serão enviados ao Mercado Livre sem validar os campos obrigatórios (não bloqueia):";

/**
 * No envio: quais bloqueados podem ser excluídos com segurança e quais foram
 * avaliados com outra categoria/ficha (precisam de nova checagem).
 * Entrada sem `key` (modo rápido) é sempre válida.
 */
export function splitMlBlockedByKey(
  blocked: Record<string, MlBlockedEntry>,
  currentKeys: Record<string, string> | null,
): { excluded: string[]; stale: string[] } {
  const excluded: string[] = [];
  const stale: string[] = [];
  for (const [pid, entry] of Object.entries(blocked)) {
    if (entry.key === undefined || currentKeys === null) {
      excluded.push(pid);
    } else if (currentKeys[pid] === entry.key) {
      excluded.push(pid);
    } else {
      stale.push(pid);
    }
  }
  return { excluded, stale };
}

/** O mínimo da config por produto da Revisão individual que a checagem lê. */
export interface MlReviewConfigLite {
  includeMl?: boolean;
  mlCategory?: string;
  attributes?: Record<string, MlRequiredCheckValue>;
}

/**
 * Itens da checagem no modo Revisão individual, com a MESMA categoria e ficha
 * que o dispatch vai usar (`perProductOverrides[pid].ml`). Produto excluído do
 * ML não é avaliado; produto sem config vai só pelo id (o create resolve a
 * categoria pelo cadastro, como o endpoint).
 */
export function buildMlReviewCheckItems(
  productIds: string[],
  map: Record<string, MlReviewConfigLite>,
  /**
   * Ficha gravada de cada produto: com ela vai só a diferença + os campos
   * apagados — a MESMA ficha que `buildPerProductOverrides` envia.
   */
  fichaSeeds?: Record<string, MlFicha>,
): { items: MlRequiredCheckItem[]; keys: Record<string, string> } {
  const items: MlRequiredCheckItem[] = [];
  const keys: Record<string, string> = {};
  for (const productId of productIds) {
    const cfg = map[productId];
    if (cfg?.includeMl === false) continue;
    const categoryId = (cfg?.mlCategory || "").trim() || undefined;
    const attributeOverrides = fichaSeeds
      ? diffMlFicha(fichaSeeds[productId] ?? {}, cfg?.attributes)
      : cfg?.attributes && Object.keys(cfg.attributes).length > 0
        ? cfg.attributes
        : undefined;
    items.push({
      key: productId,
      productId,
      ...(categoryId ? { categoryId } : {}),
      ...(attributeOverrides ? { attributeOverrides } : {}),
    });
    keys[productId] = mlRequiredCheckKey(categoryId, attributeOverrides);
  }
  return { items, keys };
}

/**
 * A categoria/ficha que vai no envio é a mesma que foi avaliada? Qualquer
 * produto novo, sumido ou com chave diferente = diverge (reavaliar).
 */
export function mlCheckKeysDiverge(
  evaluated: Record<string, string>,
  current: Record<string, string>,
): boolean {
  const a = Object.keys(evaluated);
  const b = Object.keys(current);
  if (a.length !== b.length) return true;
  return b.some((pid) => evaluated[pid] !== current[pid]);
}

/** Todos os produtos avaliados para o ML estão bloqueados? (lista vazia → não) */
export function allMlProductsBlocked(
  productIds: string[],
  blocked: Record<string, MlBlockedEntry>,
): boolean {
  return productIds.length > 0 && productIds.every((pid) => !!blocked[pid]);
}

/**
 * M12: o lote não tem o que enviar — só contas do ML selecionadas e todos os
 * produtos avaliados bloqueados. Com qualquer outra plataforma o lote segue
 * (as outras recebem os produtos).
 */
export function mlLoteSemNadaParaEnviar(i: {
  mlAccounts: number;
  otherAccounts: number;
  productIds: string[];
  blocked: Record<string, MlBlockedEntry>;
}): boolean {
  return (
    i.mlAccounts > 0 &&
    i.otherAccounts === 0 &&
    allMlProductsBlocked(i.productIds, i.blocked)
  );
}

/**
 * Decisão do ENVIO do wizard: quais produtos saem do ML neste lote.
 *
 * Revisão individual (`current` presente) com algo avaliado: se a categoria ou
 * a ficha mudou depois da checagem (sugestão automática, edição), reavalia
 * antes (`recheck`). Só exclui o produto cuja chave avaliada é a MESMA do
 * envio — resultado de uma avaliação com outra categoria/ficha não exclui.
 * Modo rápido (`current` null): entradas sem chave, exclui o que bloqueou.
 * Sempre restrito aos produtos selecionados.
 */
export async function resolveMlExclusionsForSubmit(i: {
  blocked: Record<string, MlBlockedEntry>;
  evaluatedKeys: Record<string, string> | null;
  current: { items: MlRequiredCheckItem[]; keys: Record<string, string> } | null;
  selectedIds: string[];
  recheck: (
    items: MlRequiredCheckItem[],
    keys: Record<string, string>,
  ) => Promise<Record<string, MlBlockedEntry>>;
}): Promise<{ excluded: string[]; blocked: Record<string, MlBlockedEntry> }> {
  let blocked = i.blocked;
  let currentKeys: Record<string, string> | null = null;
  if (i.current && i.evaluatedKeys) {
    currentKeys = i.current.keys;
    if (mlCheckKeysDiverge(i.evaluatedKeys, i.current.keys)) {
      blocked = await i.recheck(i.current.items, i.current.keys);
    }
  }
  const selecionados = new Set(i.selectedIds);
  const excluded = splitMlBlockedByKey(blocked, currentKeys).excluded.filter(
    (pid) => selecionados.has(pid),
  );
  return { excluded, blocked };
}

/**
 * Falhas que "Tentar novamente os falhos" ainda pode resolver: as terminais por
 * atributo obrigatório do ML repetiriam o bloqueio (a rota de retry também as
 * pula). Linhas sem `code` contam como sempre.
 */
export function countRetryableBulkFailures(
  results: ReadonlyArray<{ success: boolean; code?: string }>,
  failedItems: number,
): number {
  const definitivas = results.filter(
    (r) => !r.success && r.code === ML_REQUIRED_ATTRS_ERROR_CODE_CLIENT,
  ).length;
  return Math.max(0, failedItems - definitivas);
}

/** M11 — faixa da revisão. */
export function mlBlockedBannerMessage(n: number): string {
  return `${n} produto(s) não serão enviados ao Mercado Livre porque a ficha técnica precisa de correção. Os demais anúncios seguem normalmente.`;
}

/** M12 — todos bloqueados e nenhuma outra plataforma. */
export const ML_ALL_BLOCKED_MESSAGE =
  "Nenhum anúncio do Mercado Livre pode ser enviado: a ficha técnica de todos os produtos selecionados precisa de correção (campo obrigatório vazio ou valor que o Mercado Livre não aceita). Corrija os produtos ou remova as contas do Mercado Livre.";

/** M14 — cabeçalho da lista no diálogo de confirmação. */
export function mlExcludedConfirmMessage(n: number): string {
  // Não é só "falta": valor inválido (medida sem unidade, código de barras)
  // também bloqueia, e o texto antigo mandava procurar campo vazio.
  return `${n} anúncio(s) do Mercado Livre não serão enviados porque a ficha técnica precisa de correção:`;
}

/** Código gravado na linha do relatório pelo backend (espelha o servidor). */
export const ML_REQUIRED_ATTRS_ERROR_CODE_CLIENT =
  "ML_REQUIRED_ATTRIBUTES_MISSING";
