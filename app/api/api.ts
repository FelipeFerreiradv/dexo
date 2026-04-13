import dotenv from "dotenv";
dotenv.config();

import { loadEnvOrExit } from "../lib/env";
loadEnvOrExit();

import { fastify } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastifyCompress from "@fastify/compress";
import { join } from "path";
import prisma from "../lib/prisma";
import { SystemLogService } from "../services/system-log.service";
import { userRoutes } from "../routes/user.routes";
import { productRoutes } from "../routes/product.routes";
import { marketplaceRoutes } from "../routes/marketplace.routes";
import { dashboardRoutes } from "../routes/dashboard.routes";
import { orderRoutes } from "../routes/order.routes";
import { uploadRoutes } from "../routes/upload.routes";
import { listingRoutes } from "../routes/listing.routes";
import { systemLogRoutes } from "../routes/system-log.routes";
import { locationRoutes } from "../routes/location.routes";
import { compatibilityRoutes } from "../routes/compatibility.routes";
import { scrapRoutes } from "../routes/scrap.routes";
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

api.register(compatibilityRoutes, {
  prefix: "/products",
});

api.register(scrapRoutes, {
  prefix: "/scraps",
});

import { ListingRetryService } from "../marketplaces/services/listing-retry.service";
import { StockSyncRetryService } from "../marketplaces/services/stock-sync-retry.service";
import { StockReconciliationService } from "../marketplaces/services/stock-reconciliation.service";

// -----------------------------------------------------------------
// Health e readiness
// -----------------------------------------------------------------

const SERVER_STARTED_AT = Date.now();
const SERVICE_VERSION =
  process.env.npm_package_version || process.env.APP_VERSION || "unknown";

let backgroundServicesStarted = false;

api.get("/health", async () => ({
  status: "ok",
  uptimeMs: Date.now() - SERVER_STARTED_AT,
  version: SERVICE_VERSION,
  now: new Date().toISOString(),
}));

api.get("/ready", async (_req, reply) => {
  const checks: Record<string, { ok: boolean; error?: string }> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { ok: true };
  } catch (err: any) {
    checks.database = { ok: false, error: err?.message ?? String(err) };
  }

  checks.backgroundServices = { ok: backgroundServicesStarted };

  const allOk = Object.values(checks).every((c) => c.ok);
  reply.status(allOk ? 200 : 503).send({
    status: allOk ? "ready" : "degraded",
    checks,
  });
});

// -----------------------------------------------------------------
// Handler global de erro do Fastify
// -----------------------------------------------------------------

api.setErrorHandler(async (error: any, request, reply) => {
  const message: string = error?.message ?? String(error);
  const statusCode: number =
    typeof error?.statusCode === "number" ? error.statusCode : 500;
  api.log.error(
    { err: error, path: request.url, method: request.method },
    "request error",
  );
  try {
    await SystemLogService.logError(
      "SYSTEM_ERROR",
      `${request.method} ${request.url}: ${message}`,
      {
        resource: "Request",
        resourceId: request.id,
        details: {
          method: request.method,
          url: request.url,
          statusCode,
        },
      },
    );
  } catch {
    // swallow — não deixa falha de log derrubar o handler.
  }
  reply.status(statusCode).send({
    error: "Erro interno do servidor",
    message,
  });
});

// -----------------------------------------------------------------
// Handlers globais de processo
// -----------------------------------------------------------------

process.on("unhandledRejection", async (reason: any) => {
  const msg =
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  api.log.error({ reason }, "unhandledRejection");
  try {
    await SystemLogService.logError(
      "SYSTEM_ERROR",
      `unhandledRejection: ${msg}`,
    );
  } catch {}
});

process.on("uncaughtException", async (err: Error) => {
  api.log.fatal({ err }, "uncaughtException");
  try {
    await SystemLogService.logError(
      "SYSTEM_ERROR",
      `uncaughtException: ${err.stack ?? err.message}`,
    );
  } catch {}
  // Exceção não-capturada deixa o processo em estado inconsistente;
  // melhor sair gracioso e deixar o supervisor reiniciar.
  await gracefulShutdown("uncaughtException", 1);
});

// -----------------------------------------------------------------
// Graceful shutdown
// -----------------------------------------------------------------

let shuttingDown = false;
async function gracefulShutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  api.log.info({ signal }, "shutting down gracefully");
  try {
    (ListingRetryService as any).stop?.();
    (StockSyncRetryService as any).stop?.();
    (StockReconciliationService as any).stop?.();
  } catch (err) {
    api.log.error({ err }, "error stopping background services");
  }
  try {
    await api.close();
  } catch (err) {
    api.log.error({ err }, "error closing fastify");
  }
  try {
    await prisma.$disconnect();
  } catch (err) {
    api.log.error({ err }, "error disconnecting prisma");
  }
  process.exit(exitCode);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

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
      // start durable cross-marketplace stock sync worker
      StockSyncRetryService.start();
      // start periodic drift reconciliation (defense in depth)
      StockReconciliationService.start();
      backgroundServicesStarted = true;
    });
} catch (err) {
  api.log.error(err);
  process.exit(1);
}
