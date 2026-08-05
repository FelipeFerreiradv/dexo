/**
 * Ordem das páginas no PDF combinado do lote de etiquetas de envio.
 *
 * Este ponto NÃO foi alterado pelo bloco de ordem das etiquetas — ele já estava
 * correto. O spec existe para travar isso: `generateLabelsBatch` usa um worker
 * pool com escrita INDEXADA (`results[i] = raw`) e o `Promise.all` é sobre os
 * WORKERS, não sobre os resultados. Uma refatoração ingênua para
 * `Promise.all(orderIds.map(...))` continuaria passando, mas trocar por
 * `results.push(raw)` (ordem de conclusão) quebraria aqui.
 *
 * O teste que pega o bug é o de latências desiguais: o último pedido do lote
 * resolve primeiro. Se a ordem do PDF dependesse da ordem de conclusão, as
 * páginas sairiam embaralhadas.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockMergePdfs, mockComposeA4 } = vi.hoisted(() => ({
  mockMergePdfs: vi.fn(),
  mockComposeA4: vi.fn(),
}));

vi.mock("../app/marketplaces/shipping/pdf-merge", () => ({
  mergePdfs: mockMergePdfs,
  composeA4: mockComposeA4,
}));

import { ShippingLabelUseCase } from "../app/marketplaces/usecases/shipping-label.usecase";

const usecase = ShippingLabelUseCase as any;

/** Buffer identificável por pedido: o conteúdo é o próprio orderId. */
const bufferFor = (orderId: string) => Buffer.from(orderId, "utf8");
const readOrder = (buffers: Buffer[]) => buffers.map((b) => b.toString("utf8"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Instala os stubs do pipeline por pedido. `latencyByOrder` controla quanto
 * cada pedido demora dentro de `produceRawLabel`, e `failing` marca pedidos que
 * devem estourar.
 */
function stubPipeline(
  options: {
    latencyByOrder?: Record<string, number>;
    failing?: Set<string>;
  } = {},
) {
  const { latencyByOrder = {}, failing = new Set<string>() } = options;

  usecase.resolveContext = vi.fn(async (_userId: string, orderId: string) => ({
    order: { id: orderId },
  }));

  usecase.produceRawLabel = vi.fn(async (ctx: any) => {
    const orderId = ctx.order.id as string;
    const delay = latencyByOrder[orderId] ?? 0;
    if (delay > 0) await sleep(delay);
    if (failing.has(orderId)) {
      throw new Error(`falha proposital em ${orderId}`);
    }
    return bufferFor(orderId);
  });

  usecase.finalizeLabel = vi.fn(async () => undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMergePdfs.mockImplementation(async (buffers: Buffer[]) =>
    Buffer.concat(buffers),
  );
  mockComposeA4.mockImplementation(async (pdf: Buffer) => pdf);
});

describe("generateLabelsBatch — ordem das páginas", () => {
  it("preserva a ordem dos orderIds do request", async () => {
    stubPipeline();
    const ids = ["p1", "p2", "p3", "p4"];

    const out = await ShippingLabelUseCase.generateLabelsBatch(
      "user-1",
      ids,
      "THERMAL",
    );

    expect(out.count).toBe(4);
    expect(readOrder(mockMergePdfs.mock.calls[0][0])).toEqual(ids);
  });

  it("mantém a ordem MESMO com latências invertidas (o teste que pega o bug)", async () => {
    // O primeiro pedido é o mais lento e o último é o mais rápido: se o código
    // consumisse os resultados pela ordem de conclusão, sairia p4, p3, p2, p1.
    stubPipeline({
      latencyByOrder: { p1: 80, p2: 50, p3: 20, p4: 0 },
    });
    const ids = ["p1", "p2", "p3", "p4"];

    const out = await ShippingLabelUseCase.generateLabelsBatch(
      "user-1",
      ids,
      "THERMAL",
    );

    expect(out.count).toBe(4);
    expect(readOrder(mockMergePdfs.mock.calls[0][0])).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
    ]);
  });

  it("com mais pedidos que a concorrência (5), a ordem continua a do request", async () => {
    // 12 pedidos, latência decrescente: força várias rodadas do worker pool com
    // conclusões fora de ordem em todas elas.
    const ids = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);
    const latencyByOrder: Record<string, number> = {};
    ids.forEach((id, i) => {
      latencyByOrder[id] = (12 - i) * 5;
    });
    stubPipeline({ latencyByOrder });

    const out = await ShippingLabelUseCase.generateLabelsBatch(
      "user-1",
      ids,
      "THERMAL",
    );

    expect(out.count).toBe(12);
    expect(readOrder(mockMergePdfs.mock.calls[0][0])).toEqual(ids);
  });

  it("falha no meio do lote não desloca as páginas dos vizinhos", async () => {
    stubPipeline({
      latencyByOrder: { p1: 40, p2: 10, p3: 30, p4: 0 },
      failing: new Set(["p2"]),
    });

    const out = await ShippingLabelUseCase.generateLabelsBatch(
      "user-1",
      ["p1", "p2", "p3", "p4"],
      "THERMAL",
    );

    expect(out.count).toBe(3);
    expect(out.failures.map((f) => f.orderId)).toEqual(["p2"]);
    // p2 sai do PDF, mas p1, p3 e p4 mantêm a ordem relativa do request.
    expect(readOrder(mockMergePdfs.mock.calls[0][0])).toEqual([
      "p1",
      "p3",
      "p4",
    ]);
  });

  it("lote inteiro falhando devolve pdf nulo e não chama o merge", async () => {
    stubPipeline({ failing: new Set(["p1", "p2"]) });

    const out = await ShippingLabelUseCase.generateLabelsBatch(
      "user-1",
      ["p1", "p2"],
      "THERMAL",
    );

    expect(out.pdf).toBeNull();
    expect(out.count).toBe(0);
    expect(mockMergePdfs).not.toHaveBeenCalled();
  });

  it("A4 compõe a partir do PDF já combinado, na mesma ordem", async () => {
    stubPipeline({ latencyByOrder: { p1: 30, p2: 0 } });

    await ShippingLabelUseCase.generateLabelsBatch(
      "user-1",
      ["p1", "p2"],
      "A4",
    );

    expect(readOrder(mockMergePdfs.mock.calls[0][0])).toEqual(["p1", "p2"]);
    // composeA4 recebe o merge pronto (não os buffers soltos) + 3 por folha.
    expect(mockComposeA4).toHaveBeenCalledTimes(1);
    expect(mockComposeA4.mock.calls[0][0].toString("utf8")).toBe("p1p2");
    expect(mockComposeA4.mock.calls[0][1]).toBe(3);
  });

  it("lote vazio não chama o pipeline nem o merge", async () => {
    stubPipeline();

    const out = await ShippingLabelUseCase.generateLabelsBatch(
      "user-1",
      [],
      "THERMAL",
    );

    expect(out.pdf).toBeNull();
    expect(out.count).toBe(0);
    expect(usecase.resolveContext).not.toHaveBeenCalled();
    expect(mockMergePdfs).not.toHaveBeenCalled();
  });
});
