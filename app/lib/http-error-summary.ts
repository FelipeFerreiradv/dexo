import axios from "axios";

/**
 * Resumo SEGURO de um erro HTTP para ir ao log.
 *
 * POR QUE EXISTE. `console.error("…", error)` com um AxiosError imprime o
 * objeto inteiro — `config.headers`, o `_header` cru do socket e a requisição —
 * e com eles o `Authorization: Bearer APP_USR-…` do Mercado Livre. Medido em
 * produção em 16/09/2026: 11.994 linhas com o token em UM arquivo de 50 MB do
 * `dexo-sync-orders-error`, que girava a cada ~40–60 min (o log de erro do sync
 * guardava só ~5 h de história por causa desse volume).
 *
 * O que sai daqui: status, código, a mensagem que o servidor remoto devolveu e
 * o caminho da URL SEM query string (a Shopee assina com `access_token` na
 * query). Nunca headers, config ou corpo da requisição. Qualquer coisa com cara
 * de token que escape por mensagem ainda passa por `redactSecrets`.
 */

const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const ML_TOKEN = /\b(APP_USR|TG)-[A-Za-z0-9-]{10,}/g;
const QUERY_TOKEN = /\b(access_token|refresh_token)=[^&\s"']+/gi;

export function redactSecrets(text: string): string {
  return text
    .replace(BEARER, "$1[REDACTED]")
    .replace(ML_TOKEN, "[REDACTED]")
    .replace(QUERY_TOKEN, "$1=[REDACTED]");
}

function remoteMessage(data: unknown): string | undefined {
  if (typeof data === "string") return data.trim() || undefined;
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  const parts = [d.error, d.message].filter(
    (x): x is string => typeof x === "string" && x.trim().length > 0,
  );
  return parts.length ? parts.join(": ") : undefined;
}

export function describeHttpError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const parts: string[] = [];
    const status = err.response?.status;
    if (status) parts.push(`status=${status}`);
    if (err.code) parts.push(`code=${err.code}`);
    const remote = remoteMessage(err.response?.data);
    parts.push(`message="${(remote ?? err.message ?? "").slice(0, 300)}"`);
    const url = err.config?.url;
    if (url) parts.push(`path=${url.split("?")[0].replace(/^https?:\/\/[^/]+/, "")}`);
    return redactSecrets(parts.join(" "));
  }
  if (err instanceof Error) return redactSecrets(err.message);
  return redactSecrets(String(err));
}

/**
 * O token foi recusado? Aceita tanto o AxiosError cru (401) quanto o `Error`
 * que os serviços relançam só com a mensagem do ML ("invalid access token"),
 * que é como `getItemReviewSummary` devolve.
 *
 * 403 fica DE FORA de propósito: o ML responde 403 para item de outro vendedor
 * (anúncio vinculado à conta errada), e tratar isso como token morto pararia a
 * conta inteira por causa de um anúncio.
 */
export function isAuthHttpError(err: unknown): boolean {
  if (axios.isAxiosError(err) && err.response?.status === 401) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /invalid access token|invalid_token/i.test(msg);
}
