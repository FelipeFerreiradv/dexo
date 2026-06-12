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
 * Robustez para o modo strict: o patch do `window.fetch` é instalado no
 * CARREGAMENTO DO MÓDULO (síncrono, client-side), ANTES de qualquer componente
 * montar — evita a janela em que o primeiro fetch de uma página sairia sem o
 * Bearer (o que daria 401 no strict). O token vem de uma variável de módulo que
 * o componente mantém atualizada conforme a sessão carrega.
 *
 * Compatibilidade total:
 * - Só toca requisições cuja URL começa com a base da API.
 * - Só adiciona o header se houver token e se ele ainda não foi setado.
 * - Qualquer erro na ponte cai no fetch original (nunca quebra a chamada).
 */

// Token atual (atualizado pelo componente a cada mudança de sessão).
let currentApiToken: string | undefined;

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

  const patched: typeof window.fetch = (input, init) => {
    try {
      const token = currentApiToken;
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request)?.url;
      if (token && url && url.startsWith(apiBase)) {
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
}

// Instala assim que o módulo é avaliado no cliente (antes dos componentes).
installFetchPatch();

export function ApiAuthBridge() {
  const { data: session } = useSession();
  // Mantém o token disponível para o patch (já instalado). Atribuição
  // idempotente em render — padrão "valor mais recente".
  currentApiToken = (session as { apiToken?: string } | null)?.apiToken;

  // Garante o patch mesmo se o módulo só rodou no servidor (defensivo).
  useEffect(() => {
    installFetchPatch();
  }, []);

  return null;
}
