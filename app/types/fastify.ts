import { User } from "../interfaces/user.interface";

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: any;
  }
  interface FastifyRequest {
    user?: User;
  }
}
