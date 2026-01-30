import dotenv from "dotenv";
dotenv.config();

import { fastify } from "fastify";
import { userRoutes } from "../routes/user.routes";
import { productRoutes } from "../routes/product.routes";

const api = fastify({ logger: true });

api.register(userRoutes, {
  prefix: "/users",
});

api.register(productRoutes, {
  prefix: "/products",
});

try {
  api.listen({
    port: 3333,
  });
} catch (err) {
  api.log.error(err);
  process.exit(1);
}
