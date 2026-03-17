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
import { systemLogRoutes } from "../routes/system-log.routes";
import { loggingMiddleware } from "../middlewares/logging.middleware";

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

// Temporary debug endpoint for client-side diagnostics (DEV ONLY)
const __DEBUG_LOGS: Array<{ ts: number; payload: any }> = [];
api.post("/debug/client-log", async (req, reply) => {
  try {
    const payload = await req.body;
    __DEBUG_LOGS.push({ ts: Date.now(), payload });
    // limit stored logs
    if (__DEBUG_LOGS.length > 200) __DEBUG_LOGS.shift();
    api.log.info({ msg: "client-log", payload });
    return reply.status(200).send({ ok: true });
  } catch (err) {
    api.log.error({ msg: "Error handling client log", err });
    return reply.status(500).send({ ok: false });
  }
});

// Retrieve recent client logs (DEV ONLY)
api.get("/debug/client-log", async (req, reply) => {
  return reply.status(200).send({ logs: __DEBUG_LOGS.slice(-50) });
});

import { ListingRetryService } from "../marketplaces/services/listing-retry.service";

try {
  api
    .listen({
      port: 3333,
      host: "0.0.0.0", // precisa aceitar conexões externas (ngrok/ML) para servir imagens
    })
    .then(() => {
      // start background retry loop for placeholder listings
      ListingRetryService.start();
    });
} catch (err) {
  api.log.error(err);
  process.exit(1);
}
