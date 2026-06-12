"use client";

import { useEffect, useRef } from "react";
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
 * Compatibilidade total:
 * - Só toca requisições cuja URL começa com a base da API.
 * - Só adiciona o header se houver token e se ele ainda não foi setado.
 * - Qualquer erro na ponte cai no fetch original (nunca quebra a chamada).
 *
 * Quando o servidor virar `API_AUTH_MODE=strict`, o token já estará em todas as
 * requisições do browser. (Chamadas server-side usam `authHeaders(session)`.)
 */
export function ApiAuthBridge() {
  const { data: session } = useSession();
  const tokenRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    tokenRef.current = (session as { apiToken?: string } | null)?.apiToken;
  }, [session]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if ((window as any).__dexoFetchPatched) return;

    const apiBase = getApiBaseUrl();
    const original = window.fetch.bind(window);

    const patched: typeof window.fetch = (input, init) => {
      try {
        const token = tokenRef.current;
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request)?.url;
        if (token && url && apiBase && url.startsWith(apiBase)) {
          const headers = new Headers(
            init?.headers ??
              (input instanceof Request ? input.headers : undefined),
          );
          if (!headers.has("authorization")) {
            headers.set("authorization", `Bearer ${token}`);
            return original(input, { ...(init ?? {}), headers });
          }
        }
      } catch {
        /* nunca derrubar o fetch por causa da ponte */
      }
      return original(input, init);
    };

    (window as any).__dexoFetchPatched = true;
    window.fetch = patched;

    return () => {
      window.fetch = original;
      (window as any).__dexoFetchPatched = false;
    };
  }, []);

  return null;
}
