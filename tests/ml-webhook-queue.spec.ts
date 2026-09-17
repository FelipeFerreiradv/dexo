import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoundedWebhookQueue,
  ML_WEBHOOK_QUEUE_DEFAULTS,
  isMlWebhookQueueEnabled,
  mlWebhookKey,
  mlWebhookQueueConfig,
} from "../app/marketplaces/services/ml-webhook-queue";

/** Promessa controlável para segurar um job "em execução". */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("BoundedWebhookQueue", () => {
  it("nunca roda mais que `concurrency` jobs ao mesmo tempo", async () => {
    const q = new BoundedWebhookQueue({ concurrency: 2, maxQueued: 100 });
    const gates = Array.from({ length: 5 }, () => deferred());
    let ativos = 0;
    let pico = 0;
    gates.forEach((g, i) =>
      q.enqueue(`k${i}`, async () => {
        ativos++;
        pico = Math.max(pico, ativos);
        await g.promise;
        ativos--;
      }),
    );
    await tick();
    expect(q.stats()).toMatchObject({ running: 2, queued: 3 });
    for (const g of gates) {
      g.resolve();
      await tick();
      await tick();
    }
    expect(pico).toBe(2);
    expect(q.stats()).toMatchObject({ running: 0, queued: 0, processed: 5 });
  });

  it("coalesce a mesma chave AINDA NA FILA: roda só a versão mais recente", async () => {
    const q = new BoundedWebhookQueue({ concurrency: 1, maxQueued: 100 });
    const segura = deferred();
    const chamadas: string[] = [];
    q.enqueue("ocupa", async () => {
      await segura.promise;
    });
    expect(q.enqueue("items|/items/MLB1|9", async () => void chamadas.push("v1"))).toBe("queued");
    expect(q.enqueue("items|/items/MLB1|9", async () => void chamadas.push("v2"))).toBe("coalesced");
    segura.resolve();
    await tick();
    await tick();
    expect(chamadas).toEqual(["v2"]);
    expect(q.stats()).toMatchObject({ coalesced: 1, processed: 2 });
  });

  it("NÃO coalesce chave que já está em execução (a mudança nova precisa de nova leitura)", async () => {
    const q = new BoundedWebhookQueue({ concurrency: 1, maxQueued: 100 });
    const segura = deferred();
    const chamadas: string[] = [];
    q.enqueue("k", async () => {
      chamadas.push("primeira");
      await segura.promise;
    });
    await tick();
    expect(q.enqueue("k", async () => void chamadas.push("segunda"))).toBe("queued");
    segura.resolve();
    await tick();
    await tick();
    expect(chamadas).toEqual(["primeira", "segunda"]);
  });

  it("fila cheia recusa ('full') em vez de crescer sem limite", async () => {
    const q = new BoundedWebhookQueue({ concurrency: 1, maxQueued: 2 });
    const segura = deferred();
    q.enqueue("rodando", async () => {
      await segura.promise;
    });
    await tick();
    expect(q.enqueue("a", async () => {})).toBe("queued");
    expect(q.enqueue("b", async () => {})).toBe("queued");
    expect(q.enqueue("c", async () => {})).toBe("full");
    // coalescer não depende de vaga
    expect(q.enqueue("a", async () => {})).toBe("coalesced");
    expect(q.stats()).toMatchObject({ queued: 2, rejectedFull: 1 });
    segura.resolve();
  });

  it("job que falha não trava a fila e é reportado", async () => {
    const onError = vi.fn();
    const q = new BoundedWebhookQueue({ concurrency: 1, maxQueued: 10, onError });
    const ok = vi.fn();
    q.enqueue("ruim", async () => {
      throw new Error("boom");
    });
    q.enqueue("bom", async () => ok());
    await tick();
    await tick();
    await tick();
    expect(onError).toHaveBeenCalledWith("ruim", expect.any(Error));
    expect(ok).toHaveBeenCalledTimes(1);
    expect(q.stats()).toMatchObject({ failed: 1, processed: 1, running: 0 });
  });

  it("valida parâmetros", () => {
    expect(() => new BoundedWebhookQueue({ concurrency: 0, maxQueued: 1 })).toThrow();
    expect(() => new BoundedWebhookQueue({ concurrency: 1, maxQueued: 0 })).toThrow();
  });
});

describe("configuração", () => {
  afterEach(() => {
    delete process.env.ML_WEBHOOK_QUEUE_ENABLED;
    delete process.env.ML_WEBHOOK_QUEUE_CONCURRENCY;
    delete process.env.ML_WEBHOOK_QUEUE_MAX;
    delete process.env.ML_WEBHOOK_RATE_LIMIT_PER_MINUTE;
  });

  it("desligada por padrão; liga só com '1'", () => {
    expect(isMlWebhookQueueEnabled()).toBe(false);
    process.env.ML_WEBHOOK_QUEUE_ENABLED = "true";
    expect(isMlWebhookQueueEnabled()).toBe(false);
    process.env.ML_WEBHOOK_QUEUE_ENABLED = "1";
    expect(isMlWebhookQueueEnabled()).toBe(true);
  });

  it("valores inválidos caem no padrão", () => {
    process.env.ML_WEBHOOK_QUEUE_CONCURRENCY = "0";
    process.env.ML_WEBHOOK_QUEUE_MAX = "abc";
    expect(mlWebhookQueueConfig()).toEqual({
      concurrency: ML_WEBHOOK_QUEUE_DEFAULTS.concurrency,
      maxQueued: ML_WEBHOOK_QUEUE_DEFAULTS.maxQueued,
      rateLimitPerMinute: ML_WEBHOOK_QUEUE_DEFAULTS.rateLimitPerMinute,
    });
  });

  it("chave junta tópico, recurso e vendedor", () => {
    expect(mlWebhookKey({ topic: "orders_v2", resource: "/orders/1", user_id: 42 })).toBe("orders_v2|/orders/1|42");
    expect(mlWebhookKey({})).toBe("||");
  });
});
