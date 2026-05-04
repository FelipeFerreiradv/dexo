import { FastifyReply, FastifyRequest } from "fastify";
import { UserRepositoryPrisma } from "../repositories/user.repository";

// Singleton repository to avoid re-instantiation on every request
const userRepository = new UserRepositoryPrisma();

// In-memory user cache with 60s TTL to avoid DB lookup on every authenticated request
const userCache = new Map<string, { user: any; expiresAt: number }>();
const USER_CACHE_TTL_MS = 60_000;

// Resolves the "data owner" id: parent's id for collaborators, own id for admins.
// Admins (no parentUserId) get dataOwnerId === id, preserving existing query behavior.
function attachAuth(request: FastifyRequest, user: any) {
  const dataOwnerId = user.parentUserId ?? user.id;
  request.user = { ...user, dataOwnerId };
}

export const authMiddleware = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const headerEmail = request.headers["email"] as string | undefined;
  const queryEmail = (request.query as Record<string, unknown> | undefined)
    ?.email as string | undefined;
  const apiEmail = headerEmail ?? queryEmail;
  if (!apiEmail) {
    return reply.status(401).send({ message: "Email is required" });
  }

  const email = apiEmail;

  // Check cache first
  const cached = userCache.get(email);
  if (cached && cached.expiresAt > Date.now()) {
    attachAuth(request, cached.user);
    return;
  }

  const user = await userRepository.findByEmail(email);

  if (!user) {
    return reply.status(401).send({ message: "User not found in database" });
  }

  // Store in cache
  userCache.set(email, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });

  // Anexar usuário ao request para usar em outras rotas
  attachAuth(request, user);
};
