import dotenv from "dotenv";
dotenv.config();

import { fastify } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastifyCompress from "@fastify/compress";
import { join } from "path";
import { userRoutes } from "../routes/user.routes";
import { productRoutes } from "../routes/product.routes";
import { marketplaceRoutes } from "../routes/marketplace.routes";
import { dashboardRoutes } from "../routes/dashboard.routes";
import { orderRoutes } from "../routes/order.routes";
import { uploadRoutes } from "../routes/upload.routes";
import { listingRoutes } from "../routes/listing.routes";
import { systemLogRoutes } from "../routes/system-log.routes";
import { locationRoutes } from "../routes/location.routes";
import { loggingMiddleware } from "../middlewares/logging.middleware";

const api = fastify({ logger: true });

// Response compression (gzip/brotli) for faster API transfers
api.register(fastifyCompress, { global: true });

api.register(fastifyCors, {
  origin: process.env.CORS_ORIGIN || "http://localhost:3000",
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

// Middleware de logging - deve ser registrado antes das rotas
api.addHook("onRequest", loggingMiddleware);

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

api.register(systemLogRoutes, {
  prefix: "/system-logs",
});

api.register(locationRoutes, {
  prefix: "/locations",
});

import { ListingRetryService } from "../marketplaces/services/listing-retry.service";

const PORT = Number(process.env.PORT) || 3333;

try {
  api
    .listen({
      port: PORT,
      host: "0.0.0.0",
    })
    .then(() => {
      // start background retry loop for placeholder listings
      ListingRetryService.start();
    });
} catch (err) {
  api.log.error(err);
  process.exit(1);
}
