import dotenv from "dotenv";
dotenv.config();

import { fastify } from "fastify";
import fastifyCors from "@fastify/cors";
import { userRoutes } from "../routes/user.routes";
import { productRoutes } from "../routes/product.routes";

const api = fastify({ logger: true });

api.register(fastifyCors, {
  origin: "http://localhost:3000",
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
});

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
