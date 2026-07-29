import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import { processUploadedImage } from "../app/marketplaces/services/image-resize.service";
import { __resetRembgGate } from "../app/marketplaces/services/rembg-gate";

/**
 * Telemetria de degradação (PR de observabilidade): as três causas do warning
 * "Remoção de fundo indisponível…" produzem a MESMA mensagem, mas o resultado
 * agora carrega `degradeReason` para separá-las sem garimpar log. Estes casos
 * provam a classificação de cada caminho — e que o caminho FELIZ não ganhou
 * nenhum campo de degradação.
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

function makeAxiosConnError(code: string, message: string): Error {
  return Object.assign(new Error(message), { isAxiosError: true, code });
}

describe("processUploadedImage — degradeReason (telemetria)", () => {
  beforeEach(() => {
    delete process.env.REMBG_SIDECAR_URL;
    delete process.env.REMBG_ENABLED;
    delete process.env.REMBG_MAX_CONCURRENCY;
    delete process.env.REMBG_PUBLIC_MAX_CONCURRENCY;
    delete process.env.REMBG_GATE_DISABLED;
    delete process.env.REMBG_RETRY_DISABLED;
    __resetRembgGate();
  });

  afterEach(() => {
    delete process.env.REMBG_RETRY_DISABLED;
    vi.restoreAllMocks();
  });

  it("caminho feliz: sem degradeReason, com sidecarMs medido", async () => {
    const buf = await makeImage(1200, 900);
    const cutout = await makeImage(800, 600, { hasAlpha: true });
    const fetcher = vi.fn().mockResolvedValue(cutout);

    const result = await processUploadedImage(buf, {
      removeBackground: true,
      rembgFetcher: fetcher,
    });

    expect(result.removedBackground).toBe(true);
    expect(result.degradeReason).toBeUndefined();
    expect(result.warning).toBeUndefined();
    expect(typeof result.sidecarMs).toBe("number");
  });

  it("propaga o X-Rembg-Timing quando o fetcher entrega via onMeta", async () => {
    const buf = await makeImage(1200, 900);
    const cutout = await makeImage(800, 600, { hasAlpha: true });
    const fetcher = vi
      .fn()
      .mockImplementation(
        async (_b: Buffer, opts?: { onMeta?: (m: { timing?: string }) => void }) => {
          opts?.onMeta?.({ timing: "decode=1.0;remove=9000.0;encode=30.0" });
          return cutout;
        },
      );

    const result = await processUploadedImage(buf, {
      removeBackground: true,
      rembgFetcher: fetcher,
    });

    expect(result.removedBackground).toBe(true);
    expect(result.sidecarTiming).toBe("decode=1.0;remove=9000.0;encode=30.0");
  });

  it("timeout do axios (ECONNABORTED) → degradeReason 'timeout'", async () => {
    const buf = await makeImage(1200, 900);
    const fetcher = vi
      .fn()
      .mockRejectedValue(
        makeAxiosConnError("ECONNABORTED", "timeout of 10000ms exceeded"),
      );

    const result = await processUploadedImage(buf, {
      removeBackground: true,
      rembgFetcher: fetcher,
    });

    expect(result.removedBackground).toBe(false);
    expect(result.degradeReason).toBe("timeout");
  });

  it("conexão recusada (retry desligado) → degradeReason 'conn_error'", async () => {
    process.env.REMBG_RETRY_DISABLED = "1";
    const buf = await makeImage(1200, 900);
    const fetcher = vi
      .fn()
      .mockRejectedValue(
        makeAxiosConnError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:8000"),
      );

    const result = await processUploadedImage(buf, {
      removeBackground: true,
      rembgFetcher: fetcher,
    });

    expect(result.removedBackground).toBe(false);
    expect(result.degradeReason).toBe("conn_error");
  });

  it("resposta HTTP 5xx → degradeReason 'http_error'", async () => {
    const buf = await makeImage(1200, 900);
    const fetcher = vi.fn().mockRejectedValue(
      Object.assign(new Error("Request failed with status code 500"), {
        isAxiosError: true,
        response: { status: 500 },
      }),
    );

    const result = await processUploadedImage(buf, {
      removeBackground: true,
      rembgFetcher: fetcher,
    });

    expect(result.removedBackground).toBe(false);
    expect(result.degradeReason).toBe("http_error");
  });

  it("erro não-axios pós-fetch (buffer ilegível) → 'processing_error'", async () => {
    const buf = await makeImage(1200, 900);
    // O fetcher resolve com lixo: o sharp lança ao ler o header do "cutout".
    const fetcher = vi.fn().mockResolvedValue(Buffer.from("not-an-image"));

    const result = await processUploadedImage(buf, {
      removeBackground: true,
      rembgFetcher: fetcher,
    });

    expect(result.removedBackground).toBe(false);
    expect(result.degradeReason).toBe("processing_error");
  });

  it("killswitch (sem sidecar e sem fetcher) → degradeReason 'killswitch'", async () => {
    process.env.REMBG_ENABLED = "false";
    const buf = await makeImage(1200, 900);

    const result = await processUploadedImage(buf, {
      removeBackground: true,
    });

    expect(result.removedBackground).toBe(false);
    expect(result.degradeReason).toBe("killswitch");
  });

  it("orçamento já esgotado antes do gate → 'budget_gate' sem chamar o fetcher", async () => {
    const buf = await makeImage(1200, 900);
    const fetcher = vi.fn();

    const result = await processUploadedImage(buf, {
      removeBackground: true,
      rembgFetcher: fetcher,
      deadlineAt: Date.now() - 1_000, // já venceu
    });

    expect(result.removedBackground).toBe(false);
    expect(result.degradeReason).toBe("budget_gate");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
