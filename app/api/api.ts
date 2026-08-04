// Side-effect import: roda dotenv.config() durante a FASE DE IMPORTS (ordenada),
// antes do import do prisma. Com `dotenv.config()` como statement, o hoisting de
// imports do esbuild/tsx avalia prisma.ts (que lê DATABASE_URL) ANTES do config,
// quebrando o boot em shells sem as vars já no ambiente.
import "dotenv/config";

import { loadEnvOrExit } from "../lib/env";
loadEnvOrExit();

import { fastify } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
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
import { imageRoutes } from "../routes/image.routes";
import { listingRoutes } from "../routes/listing.routes";
import { systemLogRoutes } from "../routes/system-log.routes";
import { locationRoutes } from "../routes/location.routes";
import { scanRoutes } from "../routes/scan.routes";
import { compatibilityRoutes } from "../routes/compatibility.routes";
import { scrapRoutes } from "../routes/scrap.routes";
import { customerRoutes } from "../routes/customer.routes";
import { financeRoutes } from "../routes/finance.routes";
import { budgetRoutes } from "../routes/budget.routes";
import { unidadeRoutes } from "../routes/unidade.routes";
import { fiscalRoutes } from "../routes/fiscal.routes";
import { messagesRoutes } from "../routes/messages.routes";
import { teamRoutes } from "../routes/team.routes";
import { whatsappRoutes } from "../routes/whatsapp.routes";
import { superadminRoutes } from "../routes/superadmin.routes";
import { superadminImportRoutes } from "../routes/superadmin-import.routes";
import { internalRoutes } from "../routes/internal.routes";
import { loggingMiddleware } from "../middlewares/logging.middleware";

// trustProxy: roda atrás do reverse proxy do CloudPanel (nginx). Necessário
// para que request.ip seja o IP REAL do cliente (rate-limit + logs corretos).
// Pré-requisito de segurança: a porta 3333 NÃO pode estar exposta na internet
// (ver infra/hardening/ufw-setup.sh) — senão o X-Forwarded-For é forjável.
const api = fastify({
  // redact: garante que, se algum serializer logar headers, segredos/PII não
  // vazem para o stdout/arquivo de log (defesa em profundidade — o serializer
  // padrão do Fastify já não loga headers, mas custom/erros podem).
  logger: {
    redact: {
      paths: [
        "req.headers.email",
        "req.headers.authorization",
        "req.headers.cookie",
        "headers.email",
        "headers.authorization",
        "headers.cookie",
      ],
      censor: "[REDACTED]",
    },
  },
  trustProxy: true,
});

// Security headers (helmet). CSP/CORP desligados de propósito: a API serve
// JSON + imagens em /uploads (consumidas cross-origin pelo app Next) + a doc
// OpenAPI em /api-docs — uma CSP/CORP restritiva quebraria esses fluxos. Os
// demais headers (X-Content-Type-Options, X-Frame-Options, HSTS, etc.) ficam
// ativos. A CSP do FRONT vai no next.config.ts.
api.register(fastifyHelmet, {
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false,
});

// Rate limit global por IP (anti brute-force / DoS). Generoso por padrão para
// não atrapalhar o uso normal do dashboard; ajustável via RATE_LIMIT_MAX.
// Health/readiness ficam isentos. Excede => 429.
api.register(fastifyRateLimit, {
  max: Number(process.env.RATE_LIMIT_MAX) || 300,
  timeWindow: "1 minute",
  allowList: (req) => req.url === "/health" || req.url === "/ready",
});

// Response compression (gzip/brotli) for faster API transfers
api.register(fastifyCompress, { global: true });

// CORS — falha fechado em produção: exige CORS_ORIGIN explícito (nunca o
// fallback localhost em prod). Em dev mantém o default localhost:3000.
const corsOrigin = process.env.CORS_ORIGIN;
if (process.env.NODE_ENV === "production" && !corsOrigin) {
  // eslint-disable-next-line no-console
  console.error(
    "[security] CORS_ORIGIN é obrigatório em produção (origem exata do app). Boot abortado.",
  );
  process.exit(1);
}
api.register(fastifyCors, {
  origin: corsOrigin || "http://localhost:3000",
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  // EGRESS/latência: sem `maxAge` o browser refaz o preflight OPTIONS a CADA
  // requisição cross-origin — o app inteiro paga uma ida e volta extra por
  // chamada (visível nos logs: um OPTIONS antes de cada GET). Com o cache de
  // 24h o preflight passa a ser um por origem/método/headers. Não altera
  // política de CORS nenhuma: a origem permitida continua exatamente a mesma,
  // e uma origem nova sempre gera preflight próprio.
  maxAge: 86400,
  // Permite que clientes browser cross-origin leiam os metadados do
  // POST /v1/images/process (a resposta é a imagem; os dados vão em headers).
  // Consumidores server-side (ex.: Desmont Hub) já leem qualquer header.
  exposedHeaders: [
    "X-Removed-Background",
    "X-Shadow-Applied",
    "X-Image-Format",
    "X-Image-Width",
    "X-Image-Height",
    "X-Warning",
  ],
});

// Limite PADRÃO do multipart. Dimensionado para as rotas de IMAGEM
// (/upload/image, /upload/image/edited, /upload/image/assets, /v1/images/*),
// que são as únicas abertas a qualquer usuário autenticado — sem este teto,
// qualquer conta hospedaria blobs arbitrários (ver comentário em
// upload.routes.ts).
//
// ⚠️ Rota que precisa de mais NÃO mexe aqui: o @fastify/multipart aceita
// limites por-requisição em `request.parts({limits})` e eles VENCEM o registro
// global (deepmergeAll em index.js:261). É o que a importação de bases legadas
// faz (superadmin-import.routes.ts, tetos em lib/import-limits.ts) — planilha
// de migração chega a dezenas de MB e a rota é restrita a superadmin.
api.register(fastifyMultipart, {
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB
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

// Processamento de imagem público/stateless (remoção de fundo + sombra),
// reutilizando o mesmo pipeline do /upload/image. Aditivo — não persiste em disco.
api.register(imageRoutes, {
  prefix: "/v1/images",
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

api.register(scanRoutes, {
  prefix: "/scan",
});

api.register(compatibilityRoutes, {
  prefix: "/products",
});

api.register(scrapRoutes, {
  prefix: "/scraps",
});

api.register(customerRoutes, {
  prefix: "/customers",
});

api.register(financeRoutes, {
  prefix: "/finance",
});

api.register(budgetRoutes, {
  prefix: "/budgets",
});

api.register(unidadeRoutes, {
  prefix: "/unidades",
});

api.register(fiscalRoutes, {
  prefix: "/fiscal",
});

api.register(messagesRoutes, {
  prefix: "/messages",
});

api.register(teamRoutes, {
  prefix: "/me/team",
});

// Canal WhatsApp (Cloud API) — módulo aditivo atrás de flag + gate por usuário.
api.register(whatsappRoutes, {
  prefix: "/whatsapp",
});

// Área da equipe Dexo (Superadmin) — rotas guardadas por requireSuperadmin.
api.register(superadminRoutes, {
  prefix: "/superadmin",
});

// Importação de dados legados (Superadmin) — preview/apply/status, tudo
// guardado por requireSuperadmin e escopado pelo targetUserId (admin-alvo).
api.register(superadminImportRoutes, {
  prefix: "/superadmin",
});

// Diagnóstico operacional (equipe Dexo) — ex.: GET /internal/rembg/status.
api.register(internalRoutes, {
  prefix: "/internal",
});

import { ListingRetryService } from "../marketplaces/services/listing-retry.service";
import { StockSyncRetryService } from "../marketplaces/services/stock-sync-retry.service";
import { StockReconciliationService } from "../marketplaces/services/stock-reconciliation.service";
import { ListingStatusSweepService } from "../marketplaces/services/listing-status-sweep.service";
import { OrderIngestionReconcilerService } from "../marketplaces/services/order-ingestion-reconciler.service";
import { RembgAlertService } from "../marketplaces/services/rembg-alert.service";
import {
  ImageBgWorkerService,
  isAsyncBgEnabled,
} from "../marketplaces/services/image-bg-worker.service";

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
  // SEGURANÇA: em produção, NÃO devolver a mensagem crua de erros 5xx ao cliente
  // (pode vazar query de banco, caminho de arquivo, nome de função). 4xx (erros
  // de validação) continuam informativos. O detalhe completo fica no log +
  // SystemLog, correlacionável pelo requestId.
  const isProd = process.env.NODE_ENV === "production";
  const clientMessage =
    statusCode >= 500 && isProd ? "Erro interno do servidor" : message;
  reply.status(statusCode).send({
    error: "Erro interno do servidor",
    message: clientMessage,
    requestId: request.id,
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
    (ListingStatusSweepService as any).stop?.();
    (OrderIngestionReconcilerService as any).stop?.();
    (RembgAlertService as any).stop?.();
    (ImageBgWorkerService as any).stop?.();
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
      // ATENÇÃO: os workers abaixo MUTAM MARKETPLACE (criam/atualizam anúncio,
      // empurram estoque). Com um .env de produção, subir a API na máquina de
      // alguém faz a máquina dela começar a escrever no ML/Shopee/Magalu em
      // 30-60s, concorrendo com a VPS. `BACKGROUND_WORKERS_DISABLED=1` desliga
      // o bloco inteiro — é o que torna `npm run api` seguro para testar
      // localmente. Ausente/vazio = comportamento de sempre.
      if (process.env.BACKGROUND_WORKERS_DISABLED === "1") {
        api.log.warn(
          "[api] BACKGROUND_WORKERS_DISABLED=1 — nenhum worker de fundo iniciado (sem escrita em marketplace).",
        );
        // `/ready` continua 200: a inicialização terminou como configurado.
        // Sem isso o healthcheck reportaria "degraded" por uma escolha
        // deliberada, e não por falha.
        backgroundServicesStarted = true;
        return;
      }

      // start background retry loop for placeholder listings
      ListingRetryService.start();
      // start durable cross-marketplace stock sync worker
      StockSyncRetryService.start();
      // start periodic drift reconciliation (defense in depth)
      StockReconciliationService.start();
      // start hourly marketplace→Dexo listing status sweep (mirror phase)
      if (process.env.LISTING_STATUS_SYNC_DISABLED !== "1") {
        ListingStatusSweepService.start();
      }
      // re-tenta as pendências de ingestão de pedido (OrderIngestionIssue):
      // é o que faz um pedido quarentenado entrar sozinho assim que o cliente
      // vincula o anúncio ao produto, sem ninguém rodar script
      if (process.env.ORDER_INGESTION_RECONCILER_DISABLED !== "1") {
        OrderIngestionReconcilerService.start();
      }
      // alerta de taxa de fallback do recorte — o tick é no-op enquanto
      // IMAGE_PIPELINE_METRICS estiver desligado (lê o env a cada execução).
      RembgAlertService.start();
      // worker do recorte assíncrono (PR 4) — só com UPLOAD_ASYNC_REMBG
      // ligado (o tick também re-checa o env, então .env+restart controla).
      if (isAsyncBgEnabled()) {
        ImageBgWorkerService.start();
      }
      backgroundServicesStarted = true;
    });
} catch (err) {
  api.log.error(err);
  process.exit(1);
}
