import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock do prisma: getFallbackStats faz 2 COUNTs; aqui controlamos o retorno e
// garantimos que nenhum teste toca banco de verdade.
const countMock = vi.fn();
vi.mock("../app/lib/prisma", () => ({
  default: { systemLog: { count: (...args: any[]) => countMock(...args) } },
}));

import { SystemLogService } from "../app/services/system-log.service";
import {
  __resetImageTelemetry,
  getFallbackStats,
  getRecentImageEvents,
  isImageMetricsEnabled,
  recordImageOutcome,
} from "../app/marketplaces/services/rembg-telemetry";

const okResult = {
  removedBackground: true,
  format: "png" as const,
  width: 800,
  height: 600,
  sidecarMs: 9100,
  sidecarTiming: "remove=9000.0",
};

const fallbackResult = {
  removedBackground: false,
  format: "webp" as const,
  width: 800,
  height: 600,
  degradeReason: "budget_gate" as const,
};

describe("rembg-telemetry", () => {
  beforeEach(() => {
    delete process.env.IMAGE_PIPELINE_METRICS;
    __resetImageTelemetry();
    countMock.mockReset();
  });

  afterEach(() => {
    delete process.env.IMAGE_PIPELINE_METRICS;
    vi.restoreAllMocks();
  });

  it("killswitch: com IMAGE_PIPELINE_METRICS ausente, NADA é escrito em banco", () => {
    const logInfo = vi
      .spyOn(SystemLogService, "logInfo")
      .mockResolvedValue(undefined as any);
    const logWarning = vi
      .spyOn(SystemLogService, "logWarning")
      .mockResolvedValue(undefined as any);

    expect(isImageMetricsEnabled()).toBe(false);
    recordImageOutcome({
      source: "upload",
      lane: "internal",
      result: okResult,
      durationMs: 9500,
    });
    recordImageOutcome({
      source: "upload",
      lane: "internal",
      result: fallbackResult,
      durationMs: 42000,
    });

    expect(logInfo).not.toHaveBeenCalled();
    expect(logWarning).not.toHaveBeenCalled();
    // O ring buffer in-process continua funcionando (diagnóstico "agora").
    const events = getRecentImageEvents();
    expect(events).toHaveLength(2);
    expect(events[0].ok).toBe(true);
    expect(events[1].ok).toBe(false);
    expect(events[1].reason).toBe("budget_gate");
  });

  it("com métricas ligadas: sucesso → IMAGE_BG_REMOVED, degradação → IMAGE_BG_FALLBACK", () => {
    process.env.IMAGE_PIPELINE_METRICS = "1";
    const logInfo = vi
      .spyOn(SystemLogService, "logInfo")
      .mockResolvedValue(undefined as any);
    const logWarning = vi
      .spyOn(SystemLogService, "logWarning")
      .mockResolvedValue(undefined as any);

    recordImageOutcome({
      source: "upload",
      lane: "internal",
      result: okResult,
      durationMs: 9500,
      userId: "u1",
    });
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo.mock.calls[0][0]).toBe("IMAGE_BG_REMOVED");
    const infoOpts = logInfo.mock.calls[0][2] as any;
    expect(infoOpts.userId).toBe("u1");
    expect(infoOpts.details).toMatchObject({
      source: "upload",
      lane: "internal",
      durationMs: 9500,
      sidecarMs: 9100,
      sidecarTiming: "remove=9000.0",
    });

    recordImageOutcome({
      source: "public",
      lane: "public",
      result: fallbackResult,
      durationMs: 42000,
    });
    expect(logWarning).toHaveBeenCalledTimes(1);
    expect(logWarning.mock.calls[0][0]).toBe("IMAGE_BG_FALLBACK");
    const warnOpts = logWarning.mock.calls[0][2] as any;
    expect(warnOpts.details).toMatchObject({
      source: "public",
      lane: "public",
      reason: "budget_gate",
    });
  });

  it("ring buffer é limitado a 50 eventos (mais antigos caem)", () => {
    for (let i = 0; i < 60; i++) {
      recordImageOutcome({
        source: "upload",
        lane: "internal",
        result: okResult,
        durationMs: i,
      });
    }
    const events = getRecentImageEvents();
    expect(events).toHaveLength(50);
    // Os 10 primeiros (durationMs 0..9) foram descartados.
    expect(events[0].durationMs).toBe(10);
    expect(events[49].durationMs).toBe(59);
  });

  it("telemetria nunca lança — erro interno vira console.error", () => {
    process.env.IMAGE_PIPELINE_METRICS = "1";
    vi.spyOn(SystemLogService, "logInfo").mockImplementation(() => {
      throw new Error("boom síncrono");
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    expect(() =>
      recordImageOutcome({
        source: "upload",
        lane: "internal",
        result: okResult,
        durationMs: 100,
      }),
    ).not.toThrow();
    expect(consoleError).toHaveBeenCalled();
  });

  it("getFallbackStats calcula a taxa com os 2 COUNTs (removed, fallback)", async () => {
    countMock.mockResolvedValueOnce(8).mockResolvedValueOnce(2);
    const stats = await getFallbackStats(new Date(Date.now() - 3_600_000));
    expect(stats).toEqual({ total: 10, fallback: 2, ratePct: 20 });

    // Janela vazia: taxa é null (não 0 — ausência de dado ≠ taxa zero).
    countMock.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    const empty = await getFallbackStats(new Date());
    expect(empty).toEqual({ total: 0, fallback: 0, ratePct: null });
  });
});
