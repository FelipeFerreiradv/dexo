import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Telemetria mockada: o alerta é puro consumo de getFallbackStats +
// isImageMetricsEnabled — aqui controlamos os dois.
const statsMock = vi.fn();
let metricsEnabled = true;
vi.mock("../app/marketplaces/services/rembg-telemetry", () => ({
  getFallbackStats: (...args: any[]) => statsMock(...args),
  isImageMetricsEnabled: () => metricsEnabled,
}));

import { RembgAlertService } from "../app/marketplaces/services/rembg-alert.service";
import { SystemLogService } from "../app/services/system-log.service";

describe("RembgAlertService", () => {
  beforeEach(() => {
    metricsEnabled = true;
    statsMock.mockReset();
    delete process.env.REMBG_ALERT_FALLBACK_PCT;
    delete process.env.REMBG_ALERT_WEBHOOK_URL;
    RembgAlertService.__resetForTests();
  });

  afterEach(() => {
    RembgAlertService.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("inerte com IMAGE_PIPELINE_METRICS desligado (nem consulta stats)", async () => {
    metricsEnabled = false;
    await RembgAlertService.runOnce();
    expect(statsMock).not.toHaveBeenCalled();
  });

  it("taxa abaixo do limiar (default 30%) não alerta", async () => {
    statsMock.mockResolvedValue({ total: 20, fallback: 4, ratePct: 20 });
    const logError = vi
      .spyOn(SystemLogService, "logError")
      .mockResolvedValue(undefined as any);
    await RembgAlertService.runOnce();
    expect(logError).not.toHaveBeenCalled();
  });

  it("amostra pequena (<5) não alerta mesmo com taxa alta", async () => {
    statsMock.mockResolvedValue({ total: 3, fallback: 3, ratePct: 100 });
    const logError = vi
      .spyOn(SystemLogService, "logError")
      .mockResolvedValue(undefined as any);
    await RembgAlertService.runOnce();
    expect(logError).not.toHaveBeenCalled();
  });

  it("acima do limiar: alerta 1x e deduplica dentro da janela de 1h", async () => {
    statsMock.mockResolvedValue({ total: 10, fallback: 5, ratePct: 50 });
    const logError = vi
      .spyOn(SystemLogService, "logError")
      .mockResolvedValue(undefined as any);

    await RembgAlertService.runOnce();
    await RembgAlertService.runOnce(); // segunda checagem logo em seguida

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0][0]).toBe("IMAGE_FALLBACK_RATE_HIGH");
    expect(logError.mock.calls[0][1]).toContain("50%");
  });

  it("limiar configurável via REMBG_ALERT_FALLBACK_PCT", async () => {
    process.env.REMBG_ALERT_FALLBACK_PCT = "60";
    statsMock.mockResolvedValue({ total: 10, fallback: 5, ratePct: 50 });
    const logError = vi
      .spyOn(SystemLogService, "logError")
      .mockResolvedValue(undefined as any);
    await RembgAlertService.runOnce();
    expect(logError).not.toHaveBeenCalled();
  });

  it("dispara o webhook quando configurado; falha do webhook não lança", async () => {
    process.env.REMBG_ALERT_WEBHOOK_URL = "https://hooks.example/abc";
    statsMock.mockResolvedValue({ total: 10, fallback: 6, ratePct: 60 });
    vi.spyOn(SystemLogService, "logError").mockResolvedValue(undefined as any);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await RembgAlertService.runOnce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://hooks.example/abc");
    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(init.body).content).toContain("60%");

    // Webhook quebrado: runOnce continua sem lançar (alerta já está no log).
    RembgAlertService.__resetForTests();
    fetchMock.mockRejectedValue(new Error("rede fora"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    await expect(RembgAlertService.runOnce()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
  });
});
