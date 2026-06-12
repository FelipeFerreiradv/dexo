/**
 * URL base da API backend (Fastify).
 *
 * No lado do cliente usa NEXT_PUBLIC_API_URL (definida no painel da Vercel).
 * No lado do servidor usa API_URL (variável privada) com fallback para a pública.
 * Em desenvolvimento, cai para http://localhost:3333.
 */
export function getApiBaseUrl(): string {
  // server-side pode usar variável privada
  if (typeof window === "undefined") {
    return (
      process.env.API_URL ??
      process.env.NEXT_PUBLIC_API_URL ??
      "http://localhost:3333"
    );
  }
  // client-side só enxerga NEXT_PUBLIC_*
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3333";
}

/**
 * PR-A2 — monta os headers de autenticação para chamar a API Fastify.
 *
 * Envia o token assinado (Authorization: Bearer) que a API verifica, e mantém
 * o header `email` legado durante a migração (a API em modo "legacy" aceita os
 * dois; vira "strict" depois). Migre os ~60 call sites de
 * `headers: { email }` para `headers: authHeaders(session)`.
 *
 * Uso:
 *   const { data: session } = useSession();
 *   fetch(url, { headers: authHeaders(session) })
 */
export function authHeaders(
  session: {
    user?: { email?: string | null } | null;
    apiToken?: string;
  } | null,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  const email = session?.user?.email;
  if (email) headers.email = email; // legado (removível ao virar strict)
  const token = (session as any)?.apiToken as string | undefined;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}
