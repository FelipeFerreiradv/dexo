"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { getApiBaseUrl } from "@/lib/api";

/**
 * PR-A2 (cutover) — Ponte de autenticação da API.
 *
 * Injeta automaticamente `Authorization: Bearer <session.apiToken>` em TODA
 * chamada `fetch` que vai para a API Fastify (getApiBaseUrl). Isso evita migrar
 * os ~60 call sites um a um: eles continuam mandando `headers: { email }`
 * (legado) e esta ponte ADICIONA o token por cima.
 *
 * Robustez para o modo strict (DUAS garantias):
 * 1) O patch do `window.fetch` é instalado no CARREGAMENTO DO MÓDULO (síncrono,
 *    client-side), ANTES de qualquer componente montar.
 * 2) Se uma chamada à API dispara enquanto a SESSÃO AINDA CARREGA (boot do app
 *    shell: header/sidebar/dashboard chamam /users/me, /me/team, /orders/stats,
 *    /messages/unread-count, /dashboard/notifications na montagem, antes do
 *    useSession resolver), a ponte SEGURA a requisição até o token existir e só
 *    então injeta o Bearer — em vez de deixá-la sair sem auth (o que daria 401
 *    no modo strict). Espera no máx. ~8s; se a sessão terminar de carregar sem
 *    token (deslogado), a chamada segue sem Bearer (rota pública continua ok;
 *    rota protegida dá o 401 esperado de quem não está logado).
 *
 * Compatibilidade total:
 * - Só toca requisições cuja URL começa com a base da API.
 * - Só adiciona o header se houver token e se ele ainda não foi setado.
 * - Qualquer erro na ponte cai no fetch original (nunca quebra a chamada).
 */

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

// Estado de auth compartilhado com o patch (atualizado pelo componente).
let currentApiToken: string | undefined;
let currentStatus: AuthStatus = "loading";

// Requisições à API que chegaram antes do token resolver aguardam aqui.
let tokenWaiters: Array<() => void> = [];
function flushWaiters() {
  const waiters = tokenWaiters;
  tokenWaiters = [];
  for (const resolve of waiters) resolve();
}

// Resolve assim que houver token OU a sessão terminar de carregar (logado ou
// não). Timeout de segurança evita travar o fetch para sempre num estado raro.
function waitForToken(): Promise<void> {
  if (currentApiToken || currentStatus !== "loading") return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    tokenWaiters.push(finish);
    setTimeout(finish, 8000);
  });
}

function installFetchPatch() {
  if (typeof window === "undefined") return;
  if ((window as any).__dexoFetchPatched) return;

  let apiBase = "";
  try {
    apiBase = getApiBaseUrl();
  } catch {
    /* sem base não há o que interceptar */
  }
  if (!apiBase) return;

  const original = window.fetch.bind(window);

  const patched: typeof window.fetch = async (input, init) => {
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request)?.url;
      if (url && url.startsWith(apiBase)) {
        // Boot race: se a sessão ainda carrega e o token não chegou, segura a
        // chamada até o token existir — senão sairia sem Bearer e tomaria 401
        // no strict.
        if (!currentApiToken && currentStatus === "loading") {
          await waitForToken();
        }
        const token = currentApiToken;
        if (token) {
          const headers = new Headers(
            init?.headers ??
              (input instanceof Request ? input.headers : undefined),
          );
          if (!headers.has("authorization")) {
            headers.set("authorization", `Bearer ${token}`);
            return original(input, { ...(init ?? {}), headers });
          }
        }
      }
    } catch {
      /* nunca derrubar o fetch por causa da ponte */
    }
    return original(input, init);
  };

  (window as any).__dexoFetchPatched = true;
  window.fetch = patched;
}

// Instala assim que o módulo é avaliado no cliente (antes dos componentes).
installFetchPatch();

export function ApiAuthBridge() {
  const { data: session, status } = useSession();
  // Mantém token/status disponíveis para o patch (padrão "valor mais recente").
  currentApiToken = (session as { apiToken?: string } | null)?.apiToken;
  currentStatus = status as AuthStatus;

  // Libera as requisições que aguardavam o token assim que ele chega (ou a
  // sessão termina de carregar). Em effect p/ não chamar resolvers no render.
  useEffect(() => {
    if (currentApiToken || currentStatus !== "loading") flushWaiters();
  }, [session, status]);

  // Garante o patch mesmo se o módulo só rodou no servidor (defensivo).
  useEffect(() => {
    installFetchPatch();
  }, []);

  return null;
}
