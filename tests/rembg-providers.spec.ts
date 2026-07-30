import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postMock = vi.fn();
vi.mock("axios", () => ({
  default: {
    post: (...args: any[]) => postMock(...args),
    isAxiosError: (err: any) => Boolean(err?.isAxiosError),
  },
}));

const reserveMock = vi.fn();
const refundMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../app/marketplaces/services/rembg-provider-usage", () => ({
  tryReserveDailySlot: (...args: any[]) => reserveMock(...args),
  refundDailySlot: (...args: any[]) => refundMock(...args),
}));

const lgpdMock = vi.fn();
vi.mock("../app/marketplaces/services/rembg-telemetry", () => ({
  recordImageSentExternal: (...args: any[]) => lgpdMock(...args),
}));

import {
  __resetRembgBreakers,
  externalRembgBreaker,
  getBreakerSnapshots,
} from "../app/marketplaces/services/rembg-breaker";
import {
  readExternalProviderConfig,
  tryExternalProviderCutout,
} from "../app/marketplaces/services/rembg-providers";

const FALLBACK_ENVS = [
  "REMBG_FALLBACK_PROVIDER",
  "REMBG_FALLBACK_API_URL",
  "REMBG_FALLBACK_API_KEY",
  "REMBG_FALLBACK_API_KEY_HEADER",
  "REMBG_FALLBACK_FILE_FIELD",
  "REMBG_FALLBACK_EXTRA_FIELDS",
  "REMBG_FALLBACK_TIMEOUT_MS",
  "REMBG_FALLBACK_MAX_PER_DAY",
  "REMBG_BREAKER_DISABLED",
];

function enableFallbackEnv() {
  process.env.REMBG_FALLBACK_API_URL = "https://sdk.photoroom.com/v1/segment";
  process.env.REMBG_FALLBACK_API_KEY = "sk-teste";
  process.env.REMBG_FALLBACK_MAX_PER_DAY = "50";
}

describe("readExternalProviderConfig", () => {
  beforeEach(() => {
    for (const k of FALLBACK_ENVS) delete process.env[k];
  });

  it("sem URL ou sem teto > 0 => null (gasto é opt-in explícito)", () => {
    expect(readExternalProviderConfig()).toBeNull();
    process.env.REMBG_FALLBACK_API_URL = "https://x.example/api";
    expect(readExternalProviderConfig()).toBeNull(); // sem teto
    process.env.REMBG_FALLBACK_MAX_PER_DAY = "0";
    expect(readExternalProviderConfig()).toBeNull(); // teto zero
  });

  it("com URL + teto: defaults servem Photoroom/remove.bg sem código novo", () => {
    enableFallbackEnv();
    const cfg = readExternalProviderConfig();
    expect(cfg).toMatchObject({
      name: "sdk.photoroom.com", // hostname quando PROVIDER não é dado
      keyHeader: "X-Api-Key", // header é case-insensitive em HTTP
      fileField: "image_file", // campo padrão dos dois fornecedores
      timeoutMs: 20000,
      maxPerDay: 50,
    });
  });

  it("parse do EXTRA_FIELDS em formato querystring", () => {
    enableFallbackEnv();
    process.env.REMBG_FALLBACK_PROVIDER = "photoroom";
    process.env.REMBG_FALLBACK_EXTRA_FIELDS = "format=png&channels=rgba";
    const cfg = readExternalProviderConfig();
    expect(cfg?.name).toBe("photoroom");
    expect(cfg?.extraFields).toEqual([
      ["format", "png"],
      ["channels", "rgba"],
    ]);
  });
});

describe("tryExternalProviderCutout (elo externo da cadeia)", () => {
  const BUF = Buffer.from("imagem-normalizada");
  const PNG = Buffer.from("png-recortado");

  beforeEach(() => {
    for (const k of FALLBACK_ENVS) delete process.env[k];
    vi.clearAllMocks();
    __resetRembgBreakers();
  });

  afterEach(() => {
    for (const k of FALLBACK_ENVS) delete process.env[k];
  });

  it("desligado (default): null sem tocar teto, breaker ou rede", async () => {
    const out = await tryExternalProviderCutout({ buf: BUF });
    expect(out).toBeNull();
    expect(reserveMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
    expect(lgpdMock).not.toHaveBeenCalled();
  });

  it("orçamento restante < 4s: nem reserva teto (deadline apertado)", async () => {
    enableFallbackEnv();
    const out = await tryExternalProviderCutout({
      buf: BUF,
      deadlineAt: Date.now() + 5_000, // sobra 5s - 3s de reserva = 2s < 4s
    });
    expect(out).toBeNull();
    expect(reserveMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("teto diário batido: null sem chamar o provedor", async () => {
    enableFallbackEnv();
    reserveMock.mockResolvedValue(false);
    const out = await tryExternalProviderCutout({ buf: BUF });
    expect(out).toBeNull();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("sucesso: PNG de volta + teto consumido + rastro LGPD + breaker fecha", async () => {
    enableFallbackEnv();
    process.env.REMBG_FALLBACK_EXTRA_FIELDS = "format=png";
    reserveMock.mockResolvedValue(true);
    postMock.mockResolvedValue({
      data: PNG,
      headers: { "content-type": "image/png" },
    });

    const out = await tryExternalProviderCutout({
      buf: BUF,
      tenantUserId: "owner1",
    });
    expect(out?.provider).toBe("sdk.photoroom.com");
    expect(Buffer.isBuffer(out?.cutout)).toBe(true);

    // `now` carimbado na reserva: o refund (se houver) devolve o slot ao
    // MESMO dia UTC — nunca ao dia seguinte na virada da meia-noite.
    expect(reserveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "sdk.photoroom.com",
        maxPerDay: 50,
        now: expect.any(Date),
      }),
    );
    // API key vai no header configurável, nunca na URL.
    const [url, , axiosOpts] = postMock.mock.calls[0];
    expect(url).toBe("https://sdk.photoroom.com/v1/segment");
    expect(axiosOpts.headers["X-Api-Key"]).toBe("sk-teste");
    expect(axiosOpts.responseType).toBe("arraybuffer");
    // Rastro LGPD SEMPRE que a imagem sai para o terceiro.
    expect(lgpdMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "sdk.photoroom.com",
        ok: true,
        tenantUserId: "owner1",
      }),
    );
  });

  it("falha de INFRA (timeout): null + LGPD com erro + breaker conta", async () => {
    enableFallbackEnv();
    reserveMock.mockResolvedValue(true);
    postMock.mockRejectedValue(
      Object.assign(new Error("timeout of 20000ms exceeded"), {
        isAxiosError: true,
        code: "ECONNABORTED",
      }),
    );

    const out = await tryExternalProviderCutout({ buf: BUF });
    expect(out).toBeNull();
    expect(lgpdMock).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: expect.stringContaining("timeout") }),
    );
    expect(getBreakerSnapshots().external.consecutiveFailures).toBe(1);
  });

  it("4xx (ex.: 402 sem créditos) NÃO abre o breaker — é problema de conta, não de infra", async () => {
    enableFallbackEnv();
    reserveMock.mockResolvedValue(true);
    postMock.mockRejectedValue(
      Object.assign(new Error("Request failed with status code 402"), {
        isAxiosError: true,
        response: { status: 402 },
      }),
    );

    const out = await tryExternalProviderCutout({ buf: BUF });
    expect(out).toBeNull();
    expect(getBreakerSnapshots().external.consecutiveFailures).toBe(0);
  });

  it("resposta não-imagem (JSON de provedor incompatível): falha clara, sem contar infra", async () => {
    enableFallbackEnv();
    reserveMock.mockResolvedValue(true);
    postMock.mockResolvedValue({
      data: Buffer.from('{"url":"https://cdn..."}'),
      headers: { "content-type": "application/json" },
    });

    const out = await tryExternalProviderCutout({ buf: BUF });
    expect(out).toBeNull();
    expect(lgpdMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining("content-type"),
      }),
    );
    expect(getBreakerSnapshots().external.consecutiveFailures).toBe(0);
  });

  it("breaker externo ABERTO: null sem gastar teto", async () => {
    enableFallbackEnv();
    for (let i = 0; i < 5; i++) {
      externalRembgBreaker.beginAttempt();
      externalRembgBreaker.recordFailure("down");
    }
    const out = await tryExternalProviderCutout({ buf: BUF });
    expect(out).toBeNull();
    expect(reserveMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("banco do teto fora do ar: fail-closed no gasto (null, sem chamada)", async () => {
    enableFallbackEnv();
    reserveMock.mockRejectedValue(new Error("pooler saturado"));
    const out = await tryExternalProviderCutout({ buf: BUF });
    expect(out).toBeNull();
    expect(postMock).not.toHaveBeenCalled();
  });
});
