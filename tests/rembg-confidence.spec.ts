import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import { processUploadedImage } from "../app/marketplaces/services/image-resize.service";
import { __resetRembgGate } from "../app/marketplaces/services/rembg-gate";

/**
 * Score de confiança em MODO OBSERVAÇÃO (PR 3): o sidecar expõe o score via
 * onMeta e o serviço (a) propaga em `sidecarConfidence` (aditivo) e (b) loga
 * a decisão HIPOTÉTICA de roteamento atrás de REMBG_CONFIDENCE_LOG. Nada
 * disso muda pixel, formato ou decisão do pipeline.
 */

async function makeImage(
  width: number,
  height: number,
  opts?: { hasAlpha?: boolean },
): Promise<Buffer> {
  const channels = opts?.hasAlpha ? 4 : 3;
  return sharp({
    create: {
      width,
      height,
      channels: channels as 3 | 4,
      background: opts?.hasAlpha
        ? { r: 0, g: 0, b: 0, alpha: 0 }
        : { r: 200, g: 50, b: 50 },
    },
  })
    .png()
    .toBuffer();
}

function fetcherWithConfidence(cutout: Buffer, confidence: number) {
  return vi
    .fn()
    .mockImplementation(
      async (
        _b: Buffer,
        opts?: {
          onMeta?: (m: {
            timing?: string;
            confidence?: number;
            signals?: string;
          }) => void;
        },
      ) => {
        opts?.onMeta?.({ confidence, signals: "amb=0.3;ncomp=4" });
        return cutout;
      },
    );
}

describe("processUploadedImage — score de confiança (observação)", () => {
  beforeEach(() => {
    delete process.env.REMBG_SIDECAR_URL;
    delete process.env.REMBG_ENABLED;
    delete process.env.REMBG_CONFIDENCE_LOG;
    delete process.env.REMBG_CONFIDENCE_THRESHOLD;
    __resetRembgGate();
  });

  afterEach(() => {
    delete process.env.REMBG_CONFIDENCE_LOG;
    delete process.env.REMBG_CONFIDENCE_THRESHOLD;
    vi.restoreAllMocks();
  });

  it("propaga sidecarConfidence no resultado (aditivo)", async () => {
    const buf = await makeImage(1200, 900);
    const cutout = await makeImage(800, 600, { hasAlpha: true });

    const result = await processUploadedImage(buf, {
      removeBackground: true,
      rembgFetcher: fetcherWithConfidence(cutout, 0.42),
    });

    expect(result.removedBackground).toBe(true);
    expect(result.sidecarConfidence).toBe(0.42);
  });

  it("sem confidence no meta, o campo fica ausente (fetcher antigo)", async () => {
    const buf = await makeImage(1200, 900);
    const cutout = await makeImage(800, 600, { hasAlpha: true });
    const fetcher = vi.fn().mockResolvedValue(cutout);

    const result = await processUploadedImage(buf, {
      removeBackground: true,
      rembgFetcher: fetcher,
    });

    expect(result.sidecarConfidence).toBeUndefined();
  });

  it("killswitch: sem REMBG_CONFIDENCE_LOG, NENHUM log de observação", async () => {
    const buf = await makeImage(1200, 900);
    const cutout = await makeImage(800, 600, { hasAlpha: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await processUploadedImage(buf, {
      removeBackground: true,
      rembgFetcher: fetcherWithConfidence(cutout, 0.42),
    });

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("[rembg-confidence]"))).toBe(false);
  });

  it("com log ligado: abaixo do limiar => WOULD_REROUTE (nunca acionado)", async () => {
    process.env.REMBG_CONFIDENCE_LOG = "true";
    const buf = await makeImage(1200, 900);
    const cutout = await makeImage(800, 600, { hasAlpha: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await processUploadedImage(buf, {
      removeBackground: true,
      rembgFetcher: fetcherWithConfidence(cutout, 0.42),
    });

    // A decisão é LOGADA, não tomada: o recorte segue entregue normalmente.
    expect(result.removedBackground).toBe(true);
    const line = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("[rembg-confidence]"));
    expect(line).toContain("conf=0.42");
    expect(line).toContain("decision=WOULD_REROUTE");
    expect(line).toContain("threshold=0.55");
    expect(line).toContain("signals=amb=0.3;ncomp=4");
  });

  it("acima do limiar => decision=OK; limiar configurável por env", async () => {
    process.env.REMBG_CONFIDENCE_LOG = "true";
    process.env.REMBG_CONFIDENCE_THRESHOLD = "0.3";
    const buf = await makeImage(1200, 900);
    const cutout = await makeImage(800, 600, { hasAlpha: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await processUploadedImage(buf, {
      removeBackground: true,
      rembgFetcher: fetcherWithConfidence(cutout, 0.42),
    });

    const line = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("[rembg-confidence]"));
    expect(line).toContain("decision=OK");
    expect(line).toContain("threshold=0.3");
  });
});
