/**
 * Helpers para a remoção (fechamento) de anúncios em marketplaces.
 *
 * Define a classificação de resultados em três categorias:
 *   - OK: marketplace confirmou (ou idempotência detectada — item já fechado /
 *     já não existe). Pode-se prosseguir com o delete local.
 *   - RETRYABLE: erro transiente (429, 5xx, timeout, erro de rede). Caller
 *     deve aplicar `withRetry` antes de desistir.
 *   - PERMANENT: erro definitivo do marketplace (4xx não-idempotente, token
 *     revogado etc.). Caller NÃO deve deletar local.
 *
 * Os classificadores leem `(error as any).status` quando disponível (anexado
 * pelos services); na ausência caem em heurística por substring na mensagem.
 */

export type RemovalErrorKind = "idempotent" | "retryable" | "permanent";

export interface RemovalErrorClassification {
  kind: RemovalErrorKind;
  message: string;
  status?: number;
}

interface AxiosLikeError {
  status?: number;
  message?: string;
  responseData?: any;
  code?: string;
}

function pickMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Classifica um erro de fechamento de anúncio do Mercado Livre.
 *
 * Idempotente (tratar como sucesso — o item já está em estado terminal e
 * o objetivo da remoção foi atingido):
 *  - 404: item não existe mais.
 *  - "already closed" / "cannot modify": item fechado anteriormente.
 *  - "not modifiable" / "item.status.not_modifiable": ML responde isso
 *    quando o item está em estado terminal `inactive` (vinha como erro
 *    `permanent` antes — bloqueando a deleção local de produtos cujo
 *    anúncio ML já foi descontinuado).
 *  - "status:inactive" / "status:closed" no payload: ML inclui o status
 *    atual entre colchetes quando rejeita update — confirma que já está
 *    no estado-alvo da remoção (ou além dele).
 *
 * Retryable:
 *  - 429, 5xx, timeout, network errors (ECONNRESET, ECONNABORTED, ETIMEDOUT).
 *
 * Permanent: outros 4xx (incluindo 401/403 — auth está fora do escopo do
 * fechamento; reauth não deve ser tentado aqui).
 */
export function classifyMLRemoveError(
  error: unknown,
): RemovalErrorClassification {
  const message = pickMessage(error);
  const e = error as AxiosLikeError;
  const status = typeof e?.status === "number" ? e.status : undefined;

  const lower = message.toLowerCase();
  const looksIdempotent =
    lower.includes("already closed") ||
    lower.includes("already_closed") ||
    lower.includes("cannot be modified") ||
    lower.includes("cannot modify") ||
    lower.includes("not modifiable") ||
    lower.includes("not_modifiable") ||
    lower.includes("status:inactive") ||
    lower.includes("status:closed") ||
    lower.includes("item not found") ||
    lower.includes("not_found") ||
    lower.includes("item_not_found");

  if (status === 404 || looksIdempotent) {
    return { kind: "idempotent", message, status };
  }

  if (
    status === 429 ||
    (typeof status === "number" && status >= 500 && status <= 599) ||
    e?.code === "ECONNRESET" ||
    e?.code === "ECONNABORTED" ||
    e?.code === "ETIMEDOUT" ||
    lower.includes("timeout") ||
    lower.includes("network") ||
    lower.includes("socket hang up")
  ) {
    return { kind: "retryable", message, status };
  }

  return { kind: "permanent", message, status };
}

/**
 * Classifica um erro de deleção de item da Shopee.
 *
 * Idempotente:
 *  - `product.error_inexist`, `error_inexist`: item já não existe.
 *  - Mensagens com "item not exist", "not found".
 *
 * Retryable:
 *  - HTTP 5xx, timeout, network.
 *  - Shopee `error.system`, `error.server`.
 *
 * Permanent: o resto.
 */
export function classifyShopeeRemoveError(
  error: unknown,
): RemovalErrorClassification {
  const message = pickMessage(error);
  const e = error as AxiosLikeError & { shopeeError?: string };
  const status = typeof e?.status === "number" ? e.status : undefined;
  const shopeeError =
    typeof e?.shopeeError === "string" ? e.shopeeError.toLowerCase() : "";

  const lower = message.toLowerCase();
  const looksIdempotent =
    shopeeError.includes("error_inexist") ||
    shopeeError.includes("product.error_inexist") ||
    lower.includes("item not exist") ||
    lower.includes("does not exist") ||
    lower.includes("not exist") ||
    lower.includes("not found");

  if (looksIdempotent) {
    return { kind: "idempotent", message, status };
  }

  if (
    (typeof status === "number" && status >= 500 && status <= 599) ||
    shopeeError.includes("error.system") ||
    shopeeError.includes("error.server") ||
    e?.code === "ECONNRESET" ||
    e?.code === "ECONNABORTED" ||
    e?.code === "ETIMEDOUT" ||
    lower.includes("timeout") ||
    lower.includes("network") ||
    lower.includes("socket hang up")
  ) {
    return { kind: "retryable", message, status };
  }

  return { kind: "permanent", message, status };
}

/**
 * Executa `fn` com retry exponencial em erros classificados como retryable.
 *
 * Backoff padrão: 500ms, 2000ms, 8000ms (3 tentativas após a inicial).
 * Aceita `sleep` injetável para testes.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    classify: (err: unknown) => RemovalErrorClassification;
    retries?: number;
    baseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const c = opts.classify(err);
      if (c.kind !== "retryable" || attempt >= retries) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(4, attempt);
      attempt += 1;
      await sleep(delay);
    }
  }
}
