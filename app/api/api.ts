import dotenv from "dotenv";
dotenv.config();

import { fastify } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { join } from "path";
import { userRoutes } from "../routes/user.routes";
import { productRoutes } from "../routes/product.routes";
import { marketplaceRoutes } from "../routes/marketplace.routes";
import { dashboardRoutes } from "../routes/dashboard.routes";
import { orderRoutes } from "../routes/order.routes";
import { uploadRoutes } from "../routes/upload.routes";
import { listingRoutes } from "../routes/listing.routes";

const api = fastify({ logger: true });

api.register(fastifyCors, {
  origin: "http://localhost:3000",
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
});

api.register(fastifyMultipart, {
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});

api.register(fastifyStatic, {
  root: join(process.cwd(), "public"),
  prefix: "/",
});

api.register(userRoutes, {
  prefix: "/users",
});

api.register(productRoutes, {
  prefix: "/products",
});

api.register(marketplaceRoutes, {
  prefix: "/marketplace",
});

api.register(dashboardRoutes, {
  prefix: "/dashboard",
});

api.register(orderRoutes, {
  prefix: "/orders",
});

api.register(uploadRoutes, {
  prefix: "/upload",
});

api.register(listingRoutes, {
  prefix: "/listings",
});

try {
  api.listen({
    port: 3333,
  });
} catch (err) {
  api.log.error(err);
  process.exit(1);
}
