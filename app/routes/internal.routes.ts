import { FastifyInstance } from "fastify";
import axios from "axios";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireSuperadmin } from "../middlewares/require-superadmin.middleware";
import { getRembgGateStats } from "../marketplaces/services/rembg-gate";
import {
  getFallbackStats,
  getRecentImageEvents,
  isImageMetricsEnabled,
} from "../marketplaces/services/rembg-telemetry";

/**
 * Rotas internas de diagnóstico operacional. Guardadas por requireSuperadmin —
 * mesma convenção do /superadmin (não existe token de serviço no projeto).
 *
 * GET /internal/rembg/status: visão "agora" do pipeline de remoção de fundo
 * sem precisar de SSH — gate, sidecar (ping no /health), taxa de fallback
 * (quando IMAGE_PIPELINE_METRICS está ligado), últimos eventos e RSS do
 * processo. Os campos `breaker` e `asyncJobs` são placeholders (null) que os
 * PRs de provedores/assíncrono preenchem.
 */
export async function internalRoutes(app: FastifyInstance) {
  app.get(
    "/rembg/status",
    { preHandler: [authMiddleware, requireSuperadmin] },
    async () => {
      const sidecarUrl = process.env.REMBG_SIDECAR_URL;
      let sidecar: {
        configured: boolean;
        reachable?: boolean;
        pingMs?: number;
        health?: unknown;
        error?: string;
      } = { configured: Boolean(sidecarUrl) };
      if (sidecarUrl) {
        const t0 = Date.now();
        try {
          const resp = await axios.get(
            sidecarUrl.replace(/\/+$/, "") + "/health",
            { timeout: 1500 },
          );
          sidecar = {
            configured: true,
            reachable: true,
            pingMs: Date.now() - t0,
            health: resp.data,
          };
        } catch (err) {
          sidecar = {
            configured: true,
            reachable: false,
            pingMs: Date.now() - t0,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      const metricsEnabled = isImageMetricsEnabled();
      // Taxas vêm do SystemLog; um banco indisponível não pode derrubar o
      // endpoint de diagnóstico (é justamente quando ele mais é usado).
      let rates: {
        last1h: Awaited<ReturnType<typeof getFallbackStats>>;
        last24h: Awaited<ReturnType<typeof getFallbackStats>>;
      } | null = null;
      let ratesError: string | undefined;
      if (metricsEnabled) {
        try {
          const now = Date.now();
          const [last1h, last24h] = await Promise.all([
            getFallbackStats(new Date(now - 60 * 60 * 1000)),
            getFallbackStats(new Date(now - 24 * 60 * 60 * 1000)),
          ]);
          rates = { last1h, last24h };
        } catch (err) {
          ratesError = err instanceof Error ? err.message : String(err);
        }
      }

      const events = getRecentImageEvents();
      return {
        now: new Date().toISOString(),
        metricsEnabled,
        gate: getRembgGateStats(),
        sidecar,
        rates,
        ...(ratesError ? { ratesError } : {}),
        breaker: null,
        asyncJobs: null,
        recentEvents: events.slice(-20),
        recentErrors: events.filter((e) => !e.ok).slice(-10),
        process: {
          rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
          uptimeSec: Math.round(process.uptime()),
        },
      };
    },
  );
}
