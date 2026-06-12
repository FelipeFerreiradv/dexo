import jwt from "jsonwebtoken";

/**
 * Token de API HS256 — fundação do PR-A2 (fechar o bypass de auth da API).
 *
 * Problema: a API Fastify confia no header `email` sem verificar nada. A solução
 * é o front enviar um token ASSINADO que a API verifica. O cookie de sessão do
 * NextAuth v4 é cifrado (JWE) e não dá para `jwt.verify` direto; por isso o
 * NextAuth emite um token HS256 IRMÃO (exposto em `session.apiToken`) e a API
 * verifica com o mesmo segredo.
 *
 * Segredo: `API_JWT_SECRET` (ou, na falta, `NEXTAUTH_SECRET`, que é obrigatório).
 */

export interface ApiTokenPayload {
  sub: string; // user id
  email?: string;
  role?: string | null;
  parentUserId?: string | null;
}

function getSecret(): string | null {
  return process.env.API_JWT_SECRET || process.env.NEXTAUTH_SECRET || null;
}

/** Assina um token de API (HS256, expira em 12h). Retorna null se sem segredo. */
export function signApiToken(payload: ApiTokenPayload): string | null {
  const secret = getSecret();
  if (!secret) return null;
  return jwt.sign(
    {
      sub: payload.sub,
      email: payload.email,
      role: payload.role ?? null,
      parentUserId: payload.parentUserId ?? null,
    },
    secret,
    { algorithm: "HS256", expiresIn: "12h" },
  );
}

/**
 * Verifica e decodifica um token de API. Algoritmo fixado em HS256 (impede
 * confusão de algoritmo / `none`). Retorna o payload ou null se inválido.
 */
export function verifyApiToken(token: string): ApiTokenPayload | null {
  const secret = getSecret();
  if (!secret || !token) return null;
  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ["HS256"],
    }) as jwt.JwtPayload;
    if (!decoded || typeof decoded.sub !== "string") return null;
    return {
      sub: decoded.sub,
      email: typeof decoded.email === "string" ? decoded.email : undefined,
      role: (decoded.role as string | null) ?? null,
      parentUserId: (decoded.parentUserId as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

/** Extrai o token do header Authorization: "Bearer <token>". */
export function extractBearer(
  authorization: string | undefined,
): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return m ? m[1] : null;
}
