/**
 * Fila em memória, com concorrência limitada, para as notificações do Mercado
 * Livre (`POST /marketplace/ml/callback`).
 *
 * POR QUE. O rate limit global da API (300/min por IP) recusava as rajadas do
 * ML, que chegam de poucos IPs: 346.361 respostas 429 em setembro/2026, com pico
 * de 5.113 notificações num minuto (14/09 15:53). E o processamento era um
 * `setImmediate` por notificação, SEM limite — o 429 protegia o banco por
 * acidente. Não dava para só tirar o limite.
 *
 * DESENHO (medido antes de decidir):
 * - O ML REENVIA o que não recebe 200: `attempts` de 1 a 5 nas notificações
 *   aceitas, 7.677 retentativas só na rajada de 14/09. Então, quando a fila está
 *   cheia, a rota responde 503 e o ML tenta de novo — NUNCA responde 200 para
 *   descartar, o que perderia a notificação de vez.
 * - Coalescência: a mesma chave (tópico + recurso + vendedor) ainda NA FILA (não
 *   iniciada) é substituída pela mais recente. Seguro porque os processadores
 *   releem o estado atual no ML (pedido, item, pergunta) — a notificação só diz
 *   "algo mudou". Uma chave já EM EXECUÇÃO não é coalescida: a mudança que chegou
 *   depois precisa de nova leitura.
 */

export type EnqueueResult = "queued" | "coalesced" | "full";

export interface WebhookQueueStats {
  queued: number;
  running: number;
  processed: number;
  coalesced: number;
  rejectedFull: number;
  failed: number;
}

interface Pending {
  key: string;
  run: () => Promise<void>;
}

export class BoundedWebhookQueue {
  private readonly pending = new Map<string, Pending>();
  private running = 0;
  private readonly counters = { processed: 0, coalesced: 0, rejectedFull: 0, failed: 0 };

  constructor(
    private readonly opts: {
      concurrency: number;
      maxQueued: number;
      onError?: (key: string, err: unknown) => void;
    },
  ) {
    if (!(opts.concurrency >= 1)) throw new Error("concurrency >= 1");
    if (!(opts.maxQueued >= 1)) throw new Error("maxQueued >= 1");
  }

  /** Aceita para processar, coalesce com a pendente de mesma chave, ou recusa por lotação. */
  enqueue(key: string, run: () => Promise<void>): EnqueueResult {
    const existing = this.pending.get(key);
    if (existing) {
      existing.run = run;
      this.counters.coalesced++;
      return "coalesced";
    }
    if (this.pending.size >= this.opts.maxQueued) {
      this.counters.rejectedFull++;
      return "full";
    }
    this.pending.set(key, { key, run });
    this.pump();
    return "queued";
  }

  stats(): WebhookQueueStats {
    return { queued: this.pending.size, running: this.running, ...this.counters };
  }

  private pump(): void {
    while (this.running < this.opts.concurrency && this.pending.size > 0) {
      // Map preserva ordem de inserção: FIFO pela primeira chegada da chave.
      const [key, job] = this.pending.entries().next().value as [string, Pending];
      this.pending.delete(key);
      this.running++;
      void this.execute(job);
    }
  }

  private async execute(job: Pending): Promise<void> {
    try {
      await job.run();
      this.counters.processed++;
    } catch (err) {
      this.counters.failed++;
      this.opts.onError?.(job.key, err);
    } finally {
      this.running--;
      this.pump();
    }
  }
}

/** Chave de coalescência: mesmo tópico, mesmo recurso, mesmo vendedor. */
export function mlWebhookKey(body: {
  topic?: unknown;
  resource?: unknown;
  user_id?: unknown;
}): string {
  return `${String(body.topic ?? "")}|${String(body.resource ?? "")}|${String(body.user_id ?? "")}`;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

/** Liga a fila e o limite próprio da rota. Desligada = comportamento anterior. */
export function isMlWebhookQueueEnabled(): boolean {
  return process.env.ML_WEBHOOK_QUEUE_ENABLED === "1";
}

export const ML_WEBHOOK_QUEUE_DEFAULTS = {
  concurrency: 4,
  maxQueued: 5000,
  rateLimitPerMinute: 12000,
} as const;

export function mlWebhookQueueConfig() {
  return {
    concurrency: positiveInt(process.env.ML_WEBHOOK_QUEUE_CONCURRENCY, ML_WEBHOOK_QUEUE_DEFAULTS.concurrency),
    maxQueued: positiveInt(process.env.ML_WEBHOOK_QUEUE_MAX, ML_WEBHOOK_QUEUE_DEFAULTS.maxQueued),
    rateLimitPerMinute: positiveInt(
      process.env.ML_WEBHOOK_RATE_LIMIT_PER_MINUTE,
      ML_WEBHOOK_QUEUE_DEFAULTS.rateLimitPerMinute,
    ),
  };
}
