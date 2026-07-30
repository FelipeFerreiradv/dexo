import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (todos os efeitos externos do worker) ---------------------------
const jobFindFirst = vi.fn();
const jobUpdateMany = vi.fn();
const jobUpdate = vi.fn();
const jobFindMany = vi.fn();
vi.mock("../app/lib/prisma", () => ({
  default: {
    imageBgJob: {
      findFirst: (...a: any[]) => jobFindFirst(...a),
      updateMany: (...a: any[]) => jobUpdateMany(...a),
      update: (...a: any[]) => jobUpdate(...a),
      findMany: (...a: any[]) => jobFindMany(...a),
    },
  },
}));

const readFileMock = vi.fn();
const writeFileMock = vi.fn();
vi.mock("fs/promises", () => ({
  readFile: (...a: any[]) => readFileMock(...a),
  writeFile: (...a: any[]) => writeFileMock(...a),
}));

const processMock = vi.fn();
vi.mock("../app/marketplaces/services/image-resize.service", () => ({
  processUploadedImage: (...a: any[]) => processMock(...a),
}));

const recordOutcomeMock = vi.fn();
vi.mock("../app/marketplaces/services/rembg-telemetry", () => ({
  recordImageOutcome: (...a: any[]) => recordOutcomeMock(...a),
}));

const swapMock = vi.fn();
vi.mock("../app/marketplaces/services/image-bg-swap", () => ({
  swapImageUrlReferences: (...a: any[]) => swapMock(...a),
}));

const logErrorMock = vi.fn();
vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: { logError: (...a: any[]) => logErrorMock(...a) },
}));

import { ImageBgWorkerService } from "../app/marketplaces/services/image-bg-worker.service";

const BASE_JOB = {
  id: "job1",
  uploadUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  origFileName: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.orig.jpg",
  webpFileName: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.webp",
  addShadow: true,
  attempts: 0,
  userId: "u1",
};

function primeEmptyMaintenance() {
  // reclaim de lease (updateMany) e sweeps (findMany) sem nada a fazer.
  jobUpdateMany.mockResolvedValueOnce({ count: 0 });
  jobFindMany.mockResolvedValueOnce([]);
}

describe("ImageBgWorkerService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.UPLOAD_ASYNC_REMBG = "1";
    process.env.APP_BACKEND_URL = "http://test.local";
    delete process.env.IMAGE_BG_JOB_BUDGET_MS;
    delete process.env.IMAGE_BG_MAX_ATTEMPTS;
  });

  afterEach(() => {
    delete process.env.UPLOAD_ASYNC_REMBG;
    delete process.env.APP_BACKEND_URL;
    ImageBgWorkerService.stop();
  });

  it("killswitch: sem UPLOAD_ASYNC_REMBG o tick é um no-op absoluto", async () => {
    delete process.env.UPLOAD_ASYNC_REMBG;
    await ImageBgWorkerService.runOnce();
    expect(jobFindFirst).not.toHaveBeenCalled();
    expect(jobUpdateMany).not.toHaveBeenCalled();
  });

  it("caminho feliz: recorte pronto → PNG gravado, swap, COMPLETED com sweeps", async () => {
    primeEmptyMaintenance();
    jobFindFirst.mockResolvedValueOnce(BASE_JOB);
    jobUpdateMany.mockResolvedValueOnce({ count: 1 }); // claim CAS
    readFileMock.mockResolvedValueOnce(Buffer.from("orig"));
    processMock.mockResolvedValueOnce({
      processed: Buffer.from("png-bytes"),
      format: "png",
      removedBackground: true,
      shadowApplied: true,
      width: 800,
      height: 600,
    });
    swapMock.mockResolvedValueOnce({
      productImageUrl: 1,
      productImageUrls: 1,
      scrapImageUrls: 0,
      listingOverrides: 0,
    });
    jobUpdate.mockResolvedValueOnce({});

    await ImageBgWorkerService.runOnce();

    // Orçamento próprio, folgado (default 10min) — sem relógio de nginx.
    const processOpts = processMock.mock.calls[0][1];
    expect(processOpts.removeBackground).toBe(true);
    expect(processOpts.addShadow).toBe(true);
    expect(processOpts.lane).toBe("internal");
    expect(processOpts.deadlineAt).toBeGreaterThan(Date.now() + 500_000);
    // REGRESSÃO (revisão adversarial): sem o override, o min() do orçamento
    // prendia cada tentativa aos 60s do REMBG_TIMEOUT_MS e o "10min" era
    // ilusório — foto com round-trip >60s viraria FAILED terminal.
    expect(processOpts.rembgTimeoutMs).toBe(600_000);

    expect(String(writeFileMock.mock.calls[0][0])).toContain(
      `${BASE_JOB.uploadUuid}.png`,
    );
    expect(swapMock).toHaveBeenCalledWith({
      userId: "u1",
      oldUrl: `http://test.local/uploads/${BASE_JOB.webpFileName}`,
      newUrl: `http://test.local/uploads/${BASE_JOB.uploadUuid}.png`,
    });
    const completed = jobUpdate.mock.calls[0][0];
    expect(completed.data.status).toBe("COMPLETED");
    expect(completed.data.resultFileName).toBe(`${BASE_JOB.uploadUuid}.png`);
    expect(completed.data.swapSweepsLeft).toBe(2);
    expect(recordOutcomeMock).toHaveBeenCalledTimes(1);
    expect(recordOutcomeMock.mock.calls[0][0].source).toBe("worker");
  });

  it("degradou dentro do orçamento → volta a PENDING com backoff (nunca desiste cedo)", async () => {
    primeEmptyMaintenance();
    jobFindFirst.mockResolvedValueOnce({ ...BASE_JOB, attempts: 1 });
    jobUpdateMany.mockResolvedValueOnce({ count: 1 }); // claim
    readFileMock.mockResolvedValueOnce(Buffer.from("orig"));
    processMock.mockResolvedValueOnce({
      processed: Buffer.from("webp"),
      format: "webp",
      removedBackground: false,
      degradeReason: "conn_error",
    });
    jobUpdateMany.mockResolvedValueOnce({ count: 1 }); // volta a PENDING

    await ImageBgWorkerService.runOnce();

    const backoffCall = jobUpdateMany.mock.calls.at(-1)![0];
    expect(backoffCall.data.status).toBe("PENDING");
    expect(backoffCall.data.lastError).toContain("conn_error");
    expect(backoffCall.data.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  it("teto de tentativas → FAILED + SystemLog + telemetria de fallback", async () => {
    primeEmptyMaintenance();
    jobFindFirst.mockResolvedValueOnce({ ...BASE_JOB, attempts: 4 }); // 5ª tentativa
    jobUpdateMany.mockResolvedValueOnce({ count: 1 }); // claim
    readFileMock.mockResolvedValueOnce(Buffer.from("orig"));
    processMock.mockResolvedValueOnce({
      processed: Buffer.from("webp"),
      format: "webp",
      removedBackground: false,
      degradeReason: "timeout",
    });
    jobUpdateMany.mockResolvedValueOnce({ count: 1 }); // FAILED

    await ImageBgWorkerService.runOnce();

    const failedCall = jobUpdateMany.mock.calls.at(-1)![0];
    expect(failedCall.data.status).toBe("FAILED");
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock.mock.calls[0][0]).toBe("IMAGE_BG_JOB_FAILED");
    expect(recordOutcomeMock).toHaveBeenCalledTimes(1);
    expect(recordOutcomeMock.mock.calls[0][0].result.removedBackground).toBe(
      false,
    );
  });

  it("original sumiu do disco → FAILED terminal (retry não ajuda)", async () => {
    primeEmptyMaintenance();
    jobFindFirst.mockResolvedValueOnce(BASE_JOB);
    jobUpdateMany.mockResolvedValueOnce({ count: 1 }); // claim
    readFileMock.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }),
    );
    jobUpdateMany.mockResolvedValueOnce({ count: 1 }); // FAILED

    await ImageBgWorkerService.runOnce();

    const failedCall = jobUpdateMany.mock.calls.at(-1)![0];
    expect(failedCall.data.status).toBe("FAILED");
    expect(failedCall.data.lastError).toContain("original ausente");
    expect(processMock).not.toHaveBeenCalled();
  });

  it("job que derruba o processo não vira loop eterno: teto checado no CLAIM", async () => {
    // attempts=5 sem desfecho = 5 claims cujo processamento nunca terminou
    // (crash nativo/OOM) — sem o guard pós-claim, ficaria em
    // lease-expira→reclaim→claim para sempre.
    primeEmptyMaintenance();
    jobFindFirst.mockResolvedValueOnce({ ...BASE_JOB, attempts: 5 });
    jobUpdateMany.mockResolvedValueOnce({ count: 1 }); // claim (6ª tentativa)
    jobUpdateMany.mockResolvedValueOnce({ count: 1 }); // FAILED

    await ImageBgWorkerService.runOnce();

    expect(readFileMock).not.toHaveBeenCalled();
    const failedCall = jobUpdateMany.mock.calls.at(-1)![0];
    expect(failedCall.data.status).toBe("FAILED");
    expect(logErrorMock).toHaveBeenCalledTimes(1);
  });

  it("sweep com swap FALHO não consome o contador — só re-agenda", async () => {
    jobUpdateMany.mockResolvedValueOnce({ count: 0 }); // reclaim
    jobFindMany.mockResolvedValueOnce([
      {
        id: "job1",
        userId: "u1",
        webpFileName: "a.webp",
        resultFileName: "a.png",
        swapSweepsLeft: 2,
      },
    ]);
    swapMock.mockRejectedValueOnce(new Error("pooler fora"));
    jobUpdate.mockResolvedValueOnce({});
    jobFindFirst.mockResolvedValueOnce(null);

    await ImageBgWorkerService.runOnce();

    const resched = jobUpdate.mock.calls[0][0];
    expect(resched.data.swapSweepsLeft).toBeUndefined(); // NÃO decrementou
    expect(resched.data.nextSweepAt).toBeInstanceOf(Date);
  });

  it("claim CAS perdido (outro tick pegou) → não processa nada", async () => {
    primeEmptyMaintenance();
    jobFindFirst.mockResolvedValueOnce(BASE_JOB);
    jobUpdateMany.mockResolvedValueOnce({ count: 0 }); // CAS falhou

    await ImageBgWorkerService.runOnce();

    expect(readFileMock).not.toHaveBeenCalled();
    expect(processMock).not.toHaveBeenCalled();
  });

  it("falha do SWAP não perde o recorte: job conclui e sweeps re-tentam", async () => {
    primeEmptyMaintenance();
    jobFindFirst.mockResolvedValueOnce(BASE_JOB);
    jobUpdateMany.mockResolvedValueOnce({ count: 1 });
    readFileMock.mockResolvedValueOnce(Buffer.from("orig"));
    processMock.mockResolvedValueOnce({
      processed: Buffer.from("png"),
      format: "png",
      removedBackground: true,
      width: 800,
      height: 600,
    });
    swapMock.mockRejectedValueOnce(new Error("pooler saturado"));
    jobUpdate.mockResolvedValueOnce({});

    await ImageBgWorkerService.runOnce();

    const completed = jobUpdate.mock.calls[0][0];
    expect(completed.data.status).toBe("COMPLETED");
    expect(completed.data.lastError).toContain("swap");
    expect(completed.data.nextSweepAt).toBeInstanceOf(Date);
  });

  it("sweep vencido re-roda o swap e decrementa o contador", async () => {
    jobUpdateMany.mockResolvedValueOnce({ count: 0 }); // reclaim
    jobFindMany.mockResolvedValueOnce([
      {
        id: "job1",
        userId: "u1",
        webpFileName: "a.webp",
        resultFileName: "a.png",
        swapSweepsLeft: 2,
      },
    ]);
    swapMock.mockResolvedValueOnce({});
    jobUpdate.mockResolvedValueOnce({});
    jobFindFirst.mockResolvedValueOnce(null); // sem job novo

    await ImageBgWorkerService.runOnce();

    expect(swapMock).toHaveBeenCalledWith({
      userId: "u1",
      oldUrl: "http://test.local/uploads/a.webp",
      newUrl: "http://test.local/uploads/a.png",
    });
    const sweepUpdate = jobUpdate.mock.calls[0][0];
    expect(sweepUpdate.data.swapSweepsLeft).toBe(1);
    expect(sweepUpdate.data.nextSweepAt).toBeInstanceOf(Date);
  });
});
