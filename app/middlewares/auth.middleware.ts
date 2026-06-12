import { FastifyReply, FastifyRequest } from "fastify";
import { UserRepositoryPrisma } from "../repositories/user.repository";
import { extractBearer, verifyApiToken } from "../lib/api-token";

// Singleton repository to avoid re-instantiation on every request
const userRepository = new UserRepositoryPrisma();

// In-memory user cache with 60s TTL to avoid DB lookup on every authenticated
// request. Chaveado por "email:<email>" ou "id:<userId>".
const userCache = new Map<string, { user: any; expiresAt: number }>();
const USER_CACHE_TTL_MS = 60_000;

function getCached(key: string): any | null {
  const cached = userCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.user;
  return null;
}
function setCached(key: string, user: any) {
  userCache.set(key, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
}

// Resolves the "data owner" id: parent's id for collaborators, own id for admins.
function attachAuth(request: FastifyRequest, user: any) {
  const dataOwnerId = user.parentUserId ?? user.id;
  (request as any).user = { ...user, dataOwnerId };
}

/**
 * Autenticação da API.
 *
 * PR-A2: identidade verificada por TOKEN assinado (Authorization: Bearer),
 * emitido pelo NextAuth e verificado aqui. Modo controlado por API_AUTH_MODE:
 *  - "strict": SÓ aceita token válido (fecha o bypass de email).
 *  - "legacy" (default): aceita token OU o header `email` legado — preserva o
 *    comportamento atual enquanto o front migra para enviar o token. Deploy em
 *    legacy = ZERO regressão; vira strict depois que todos os call sites mandam
 *    o token (ver RELATORIO_SEGURANCA_DIAGNOSTICO.md).
 */
export const authMiddleware = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const strict = process.env.API_AUTH_MODE === "strict";

  // 1) Token Bearer (caminho seguro, sempre preferido quando presente).
  const bearer = extractBearer(
    request.headers["authorization"] as string | undefined,
  );
  if (bearer) {
    const payload = verifyApiToken(bearer);
    if (!payload) {
      return reply.status(401).send({ message: "Token inválido" });
    }
    const cacheKey = `id:${payload.sub}`;
    const cachedUser = getCached(cacheKey);
    if (cachedUser) {
      attachAuth(request, cachedUser);
      return;
    }
    const user = await userRepository.findById(payload.sub);
    if (!user) {
      return reply.status(401).send({ message: "User not found in database" });
    }
    setCached(cacheKey, user);
    attachAuth(request, user);
    return;
  }

  // 2) Sem token. Em modo strict, rejeita (fecha o bypass).
  if (strict) {
    return reply.status(401).send({ message: "Authentication required" });
  }

  // 3) Legacy: identidade pelo header/query `email` (comportamento atual).
  const headerEmail = request.headers["email"] as string | undefined;
  const queryEmail = (request.query as Record<string, unknown> | undefined)
    ?.email as string | undefined;
  const email = headerEmail ?? queryEmail;
  if (!email) {
    return reply.status(401).send({ message: "Email is required" });
  }

  const cacheKey = `email:${email}`;
  const cachedUser = getCached(cacheKey);
  if (cachedUser) {
    attachAuth(request, cachedUser);
    return;
  }

  const user = await userRepository.findByEmail(email);
  if (!user) {
    return reply.status(401).send({ message: "User not found in database" });
  }
  setCached(cacheKey, user);
  attachAuth(request, user);
};
