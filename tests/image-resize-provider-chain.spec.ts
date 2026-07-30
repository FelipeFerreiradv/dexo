import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

// Cadeia local → externo DENTRO do processUploadedImage (PR 5): mockamos os
// DOIS elos no módulo de provedores; todo o resto (gate, orçamento, breaker,
// classificação de degradação, encode) roda de verdade.
const localFetchMock = vi.fn();
const tryExternalMock = vi.fn();
vi.mock("../app/marketplaces/services/rembg-providers", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    localSidecarFetch: (...args: any[]) => localFetchMock(...args),
    tryExternalProviderCutout: (...args: any[]) => tryExternalMock(...args),
  };
});

import { processUploadedImage } from "../app/marketplaces/services/image-resize.service";
import {
  __resetRembgBreakers,
  getBreakerSnapshots,
} from "../app/marketplaces/services/rembg-breaker";
import { __resetRembgGate } from "../app/marketplaces/services/rembg-gate";

async function makeJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 1200, height: 900, channels: 3, background: { r: 9, g: 9, b: 9 } },
  })
    .jpeg()
    .toBuffer();
}

async function makeCutoutPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 1200,
      height: 900,
      channels: 4,
      background: { r: 1, g: 2, b: 3, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
}

function connError(msg = "connect ECONNREFUSED 127.0.0.1:8000") {
  return Object.assign(new Error(msg), {
    isAxiosError: true,
    code: "ECONNREFUSED",
  });
}

describe("processUploadedImage — cadeia local → externo (PR 5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRembgBreakers();
    __resetRembgGate();
    process.env.REMBG_SIDECAR_URL = "http://sidecar.test:8000";
    // Retry único de conexão OFF: cada upload = exatamente 1 chamada ao
    // fetcher, o que torna a contagem do breaker determinística no teste.
    process.env.REMBG_RETRY_DISABLED = "1";
    delete process.env.REMBG_BREAKER_DISABLED;
  });

  afterEach(() => {
    delete process.env.REMBG_SIDECAR_URL;
    delete process.env.REMBG_RETRY_DISABLED;
  });

  it("local entrega: o elo externo NEM é consultado (caminho feliz intacto)", async () => {
    localFetchMock.mockResolvedValue(await makeCutoutPng());
    const result = await processUploadedImage(await makeJpeg(), {
      removeBackground: true,
    });
    expect(result.removedBackground).toBe(true);
    expect(result.usedFallbackProvider).toBeUndefined();
    expect(tryExternalMock).not.toHaveBeenCalled();
    expect(getBreakerSnapshots().local.state).toBe("CLOSED");
  });

  it("local falha, externo entrega: recorte SEM sombra + usedFallbackProvider", async () => {
    localFetchMock.mockRejectedValue(connError());
    tryExternalMock.mockResolvedValue({
      cutout: await makeCutoutPng(),
      provider: "photoroom",
    });

    const result = await processUploadedImage(await makeJpeg(), {
      removeBackground: true,
      addShadow: true,
      tenantUserId: "owner1",
    });

    expect(result.removedBackground).toBe(true);
    expect(result.format).toBe("png");
    expect(result.usedFallbackProvider).toBe(true);
    expect(result.shadowApplied).toBe(false); // externo não faz a nossa sombra
    expect(result.warning).toBeUndefined(); // recorte saiu — não é degradação
    // O elo externo recebe a imagem normalizada + contexto de LGPD/orçamento.
    expect(tryExternalMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantUserId: "owner1" }),
    );
    // A falha local contou no breaker local.
    expect(getBreakerSnapshots().local.consecutiveFailures).toBe(1);
  });

  it("local falha, externo OFF (null): degradação graceful DE SEMPRE (zero regressão)", async () => {
    localFetchMock.mockRejectedValue(connError());
    tryExternalMock.mockResolvedValue(null);

    const result = await processUploadedImage(await makeJpeg(), {
      removeBackground: true,
    });

    expect(result.removedBackground).toBe(false);
    expect(result.format).toBe("webp");
    expect(result.warning).toContain("Remoção de fundo indisponível");
    expect(result.degradeReason).toBe("conn_error");
  });

  it("5 falhas seguidas ABREM o breaker: o 6º upload pula o sidecar (breaker_open) mas ainda tenta o externo", async () => {
    localFetchMock.mockRejectedValue(connError());
    tryExternalMock.mockResolvedValue(null);

    for (let i = 0; i < 5; i++) {
      await processUploadedImage(await makeJpeg(), { removeBackground: true });
    }
    expect(localFetchMock).toHaveBeenCalledTimes(5);
    expect(getBreakerSnapshots().local.state).toBe("OPEN");

    const sixth = await processUploadedImage(await makeJpeg(), {
      removeBackground: true,
    });
    expect(localFetchMock).toHaveBeenCalledTimes(5); // sidecar NÃO foi chamado
    expect(sixth.degradeReason).toBe("breaker_open");
    expect(tryExternalMock).toHaveBeenCalledTimes(6); // cadeia segue viva
  });

  it("fetcher INJETADO (specs antigos) passa reto pelo breaker", async () => {
    const injected = vi.fn().mockRejectedValue(connError());
    tryExternalMock.mockResolvedValue(null);
    for (let i = 0; i < 6; i++) {
      const result = await processUploadedImage(await makeJpeg(), {
        removeBackground: true,
        rembgFetcher: injected,
      });
      expect(result.degradeReason).toBe("conn_error"); // nunca breaker_open
    }
    expect(injected).toHaveBeenCalledTimes(6);
    expect(getBreakerSnapshots().local.consecutiveFailures).toBe(0);
  });

  it("erro 4xx do sidecar NÃO conta para abrir o breaker", async () => {
    localFetchMock.mockRejectedValue(
      Object.assign(new Error("Request failed with status code 400"), {
        isAxiosError: true,
        response: { status: 400, data: "imagem invalida" },
      }),
    );
    tryExternalMock.mockResolvedValue(null);
    for (let i = 0; i < 6; i++) {
      await processUploadedImage(await makeJpeg(), { removeBackground: true });
    }
    expect(getBreakerSnapshots().local.state).toBe("CLOSED");
    expect(localFetchMock).toHaveBeenCalledTimes(6);
  });
});
