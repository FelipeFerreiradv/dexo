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
