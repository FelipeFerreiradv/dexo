import { User } from "../interfaces/user.interface";

// AuthenticatedUser estende User com o campo derivado dataOwnerId.
// dataOwnerId = parentUserId ?? id (resolvido pelo authMiddleware).
// Para admins puros, dataOwnerId === id (zero regressão).
// Para colaboradores, dataOwnerId === parentUserId, escopando queries de dados ao admin pai.
export type AuthenticatedUser = User & { dataOwnerId: string };

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: any;
  }
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}
