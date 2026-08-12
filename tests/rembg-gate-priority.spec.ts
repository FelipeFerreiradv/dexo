import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetRembgGate,
  acquireRembgSlot,
  getRembgGateStats,
} from "../app/marketplaces/services/rembg-gate";

/**
 * Prioridade da lane interna e desligamento da lane pública.
 *
 * Contexto (12/08/2026): o Desmont Hub passou de ~700 para ~7.500 img/dia via
 * `POST /v1/images/process` e ocupou o sidecar 24h/dia. A cota reservada
 * garantia que o interno CONSEGUISSE um slot, não que o conseguisse PRIMEIRO —
 * todo slot liberado acordava o público, que estava sempre pronto. A fila do
 * cliente chegou a 55 min.
 */
describe("rembg-gate — prioridade do interno e kill-switch da lane pública", () => {
  beforeEach(() => {
    delete process.env.REMBG_GATE_DISABLED;
    delete process.env.REMBG_MAX_CONCURRENCY;
    delete process.env.REMBG_PUBLIC_MAX_CONCURRENCY;
    __resetRembgGate();
  });

  afterEach(() => {
    delete process.env.REMBG_MAX_CONCURRENCY;
    delete process.env.REMBG_PUBLIC_MAX_CONCURRENCY;
    __resetRembgGate();
  });

  /**
   * Resolveu já, sem depender de timer? Drena microtasks em vez de correr
   * contra `Promise.resolve`: `acquireRembgSlot` é `async` e adota a promise
   * interna, então uma corrida perderia por alguns ticks e daria falso negativo.
   */
  async function settledNow<T>(
    p: Promise<T>,
  ): Promise<{ done: boolean; value?: T }> {
    let done = false;
    let value: T | undefined;
    void p.then((v) => {
      done = true;
      value = v;
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    return { done, value };
  }

  it("REMBG_PUBLIC_MAX_CONCURRENCY=0 desliga a lane pública e desiste NA HORA", async () => {
    process.env.REMBG_MAX_CONCURRENCY = "2";
    process.env.REMBG_PUBLIC_MAX_CONCURRENCY = "0";
    __resetRembgGate();

    expect(getRembgGateStats().publicCapacity).toBe(0);

    // Orçamento generoso de propósito: mesmo assim não pode enfileirar, senão
    // a requisição ficaria ~38s pendurada para degradar do mesmo jeito.
    const slot = await settledNow(acquireRembgSlot("public", 30_000));
    expect(slot.done).toBe(true);
    expect(slot.value).toBeNull();

    // E não deixou waiter para trás.
    expect(getRembgGateStats().waiting).toBe(0);
    // O interno segue usando a capacidade inteira.
    const internal = await acquireRembgSlot("internal", 30_000);
    expect(internal).not.toBeNull();
    internal?.release();
  });

  it("com cota 0, o público NÃO consome capacidade nem quando o sidecar está livre", async () => {
    process.env.REMBG_MAX_CONCURRENCY = "2";
    process.env.REMBG_PUBLIC_MAX_CONCURRENCY = "0";
    __resetRembgGate();

    const a = await acquireRembgSlot("public", 5_000);
    const b = await acquireRembgSlot("public", 5_000);
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(getRembgGateStats().inFlight).toBe(0);
  });

  it("slot liberado vai para o waiter INTERNO, mesmo com o público na frente da fila", async () => {
    process.env.REMBG_MAX_CONCURRENCY = "2";
    process.env.REMBG_PUBLIC_MAX_CONCURRENCY = "1";
    __resetRembgGate();

    // Lota a capacidade com tráfego interno.
    const held1 = await acquireRembgSlot("internal", 0);
    const held2 = await acquireRembgSlot("internal", 0);
    expect(held1).not.toBeNull();
    expect(held2).not.toBeNull();

    // O público entra na fila PRIMEIRO — é o cenário que dava o empate.
    const publicPromise = acquireRembgSlot("public", 10_000);
    const internalPromise = acquireRembgSlot("internal", 10_000);
    expect(getRembgGateStats().waiting).toBe(2);

    held1!.release();

    const internalResult = await settledNow(internalPromise);
    const publicResult = await settledNow(publicPromise);

    expect(internalResult.done).toBe(true);
    expect(internalResult.value).not.toBeNull();
    // O público continua esperando: não fura a fila do cliente.
    expect(publicResult.done).toBe(false);

    (internalResult.value as { release(): void }).release();
    held2!.release();
    const publicFinally = await publicPromise;
    expect(publicFinally).not.toBeNull();
    publicFinally?.release();
  });

  it("sem waiter interno, o público é admitido normalmente (sem regressão)", async () => {
    process.env.REMBG_MAX_CONCURRENCY = "2";
    process.env.REMBG_PUBLIC_MAX_CONCURRENCY = "1";
    __resetRembgGate();

    const held = await acquireRembgSlot("internal", 0);
    expect(held).not.toBeNull();

    const publicPromise = acquireRembgSlot("public", 10_000);
    const publicSlot = await settledNow(publicPromise);
    // Ainda havia 1 de 2 slots livres e ninguém interno esperando.
    expect(publicSlot.done).toBe(true);
    expect(publicSlot.value).not.toBeNull();

    (publicSlot.value as { release(): void }).release();
    held!.release();
  });

  it("a reserva continua valendo: o público nunca passa da própria cota", async () => {
    process.env.REMBG_MAX_CONCURRENCY = "2";
    process.env.REMBG_PUBLIC_MAX_CONCURRENCY = "1";
    __resetRembgGate();

    const p1 = await acquireRembgSlot("public", 0);
    const p2 = await acquireRembgSlot("public", 0);
    expect(p1).not.toBeNull();
    expect(p2).toBeNull(); // cota pública esgotada, embora haja slot livre

    // ...e o slot que sobrou é do interno.
    const internal = await acquireRembgSlot("internal", 0);
    expect(internal).not.toBeNull();

    p1?.release();
    internal?.release();
  });

  it("REMBG_PUBLIC_MAX_CONCURRENCY inválido cai no default 1", async () => {
    process.env.REMBG_MAX_CONCURRENCY = "2";
    process.env.REMBG_PUBLIC_MAX_CONCURRENCY = "abc";
    __resetRembgGate();
    expect(getRembgGateStats().publicCapacity).toBe(1);

    process.env.REMBG_PUBLIC_MAX_CONCURRENCY = "-1";
    __resetRembgGate();
    expect(getRembgGateStats().publicCapacity).toBe(1);
  });

  it("o kill-switch do gate ignora tudo, inclusive a cota 0", async () => {
    process.env.REMBG_GATE_DISABLED = "1";
    process.env.REMBG_PUBLIC_MAX_CONCURRENCY = "0";
    __resetRembgGate();

    const slot = await acquireRembgSlot("public", 0);
    expect(slot).not.toBeNull();
    delete process.env.REMBG_GATE_DISABLED;
  });
});
