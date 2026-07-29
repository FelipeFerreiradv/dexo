/**
 * Alerta de taxa de fallback do pipeline de remoção de fundo.
 *
 * O projeto não tem infra de alerting; este é o mínimo viável no padrão dos
 * serviços in-process (StockSyncRetryService etc.): um tick periódico que
 * calcula a taxa da última 1h a partir do SystemLog e, acima do limiar,
 * registra um SystemLog ERROR (action IMAGE_FALLBACK_RATE_HIGH — visível na
 * tela de logs do admin e greppável no pm2) e, opcionalmente, dispara um
 * webhook (REMBG_ALERT_WEBHOOK_URL — formato aceito por Discord/Slack).
 *
 * Inerte por construção quando IMAGE_PIPELINE_METRICS está desligado (sem
 * dados, sem alerta) — o tick vira um no-op de leitura de env.
 *
 * Envs (todas opcionais):
 *  - REMBG_ALERT_FALLBACK_PCT: limiar em % (default 30).
 *  - REMBG_ALERT_WEBHOOK_URL: se setada, POST JSON { content } com timeout 3s.
 */

import { SystemLogService } from "../../services/system-log.service";
import { getFallbackStats, isImageMetricsEnabled } from "./rembg-telemetry";

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const MIN_SAMPLE = 5; // abaixo disso a taxa é ruído, não sinal
const ALERT_DEDUP_MS = 60 * 60 * 1000; // no máx. 1 alerta/hora
const WEBHOOK_TIMEOUT_MS = 3000;

function readThresholdPct(): number {
  const parsed = Number(process.env.REMBG_ALERT_FALLBACK_PCT);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

export class RembgAlertService {
  private static running = false;
  private static intervalId: NodeJS.Timeout | null = null;
  private static runInProgress = false;
  private static lastAlertAt = 0;

  /** Uma checagem. Exposta para testes; nunca lança. */
  static async runOnce(): Promise<void> {
    if (this.runInProgress) return;
    this.runInProgress = true;
    try {
      if (!isImageMetricsEnabled()) return;

      const since = new Date(Date.now() - 60 * 60 * 1000);
      const stats = await getFallbackStats(since);
      const threshold = readThresholdPct();
      if (
        stats.total < MIN_SAMPLE ||
        stats.ratePct === null ||
        stats.ratePct < threshold
      ) {
        return;
      }
      if (Date.now() - this.lastAlertAt < ALERT_DEDUP_MS) return;
      this.lastAlertAt = Date.now();

      const message =
        `Taxa de fallback do recorte em ${stats.ratePct}% na última hora ` +
        `(${stats.fallback}/${stats.total}; limiar ${threshold}%)`;
      await SystemLogService.logError("IMAGE_FALLBACK_RATE_HIGH", message, {
        resource: "ImagePipeline",
        details: { ...stats, thresholdPct: threshold },
      });

      const webhookUrl = (process.env.REMBG_ALERT_WEBHOOK_URL ?? "").trim();
      if (webhookUrl) {
        try {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: `[Dexo] ${message}` }),
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
          });
        } catch (err) {
          console.error(
            "[RembgAlert] webhook falhou (alerta segue no SystemLog):",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } catch (err) {
      console.error("[RembgAlert] runOnce falhou:", err);
    } finally {
      this.runInProgress = false;
    }
  }

  static start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.running) return;
    this.running = true;
    this.intervalId = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
  }

  static stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.running = false;
  }

  /** Zera o dedup entre casos de teste. */
  static __resetForTests(): void {
    this.lastAlertAt = 0;
    this.runInProgress = false;
  }
}
