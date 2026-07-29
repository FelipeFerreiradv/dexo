import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { FastifyInstance } from "fastify";

// authMiddleware mockado para popular request.user com um papel controlado
// pelo teste. O requireSuperadmin usado é o REAL — é exatamente o gate que
// este spec precisa provar (403 para não-superadmin).
let currentUser: { id: string; role: string } | null = null;
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = currentUser;
  },
}));

// Prisma mockado: o endpoint só toca banco via getFallbackStats (e apenas com
// IMAGE_PIPELINE_METRICS ligado).
const countMock = vi.fn();
vi.mock("../app/lib/prisma", () => ({
  default: { systemLog: { count: (...args: any[]) => countMock(...args) } },
}));

// axios mockado para exercitar o ramo do ping do sidecar (sucesso E falha) —
// em produção REMBG_SIDECAR_URL está sempre configurada, então o ramo
// configurado é o único que roda de verdade.
const axiosGetMock = vi.fn();
vi.mock("axios", () => ({
  default: { get: (...args: any[]) => axiosGetMock(...args) },
}));

import { internalRoutes } from "../app/routes/internal.routes";
import {
  __resetImageTelemetry,
  recordImageOutcome,
} from "../app/marketplaces/services/rembg-telemetry";
import { __resetRembgGate } from "../app/marketplaces/services/rembg-gate";

describe("GET /internal/rembg/status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    delete process.env.REMBG_SIDECAR_URL;
    delete process.env.IMAGE_PIPELINE_METRICS;
    delete process.env.REMBG_GATE_DISABLED;
    // O gate relê o env ao ser recriado — sem limpar, env ambiente do shell
    // flakaria o assert de capacity/publicCapacity (convenção dos specs irmãos).
    delete process.env.REMBG_MAX_CONCURRENCY;
    delete process.env.REMBG_PUBLIC_MAX_CONCURRENCY;
    currentUser = null;
    countMock.mockReset();
    axiosGetMock.mockReset();
    __resetImageTelemetry();
    __resetRembgGate();

    app = fastify();
    await app.register(internalRoutes, { prefix: "/internal" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("bloqueia usuário comum (ADMIN) com 403", async () => {
    currentUser = { id: "u1", role: "ADMIN" };
    const res = await app.inject({ method: "GET", url: "/internal/rembg/status" });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("SUPERADMIN_ONLY");
  });

  it("bloqueia requisição sem usuário com 403", async () => {
    currentUser = null;
    const res = await app.inject({ method: "GET", url: "/internal/rembg/status" });
    expect(res.statusCode).toBe(403);
  });

  it("responde o snapshot para SUPERADMIN (sem sidecar configurado, métricas off)", async () => {
    currentUser = { id: "sa", role: "SUPERADMIN" };
    const res = await app.inject({ method: "GET", url: "/internal/rembg/status" });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.metricsEnabled).toBe(false);
    // Sem REMBG_SIDECAR_URL: não há ping (e não pode haver erro por isso).
    expect(body.sidecar).toEqual({ configured: false });
    // Métricas off => taxas nem são consultadas (zero toque no banco).
    expect(body.rates).toBeNull();
    expect(countMock).not.toHaveBeenCalled();
    // Placeholders dos PRs seguintes.
    expect(body.breaker).toBeNull();
    expect(body.asyncJobs).toBeNull();
    // Gate: snapshot com defaults (2/1) e nada em voo.
    expect(body.gate).toMatchObject({
      disabled: false,
      inFlight: 0,
      publicInFlight: 0,
      waiting: 0,
      capacity: 2,
      publicCapacity: 1,
    });
    expect(Array.isArray(body.recentEvents)).toBe(true);
    expect(typeof body.process.rssMb).toBe("number");
  });

  it("com métricas ligadas, consulta as janelas 1h e 24h no SystemLog", async () => {
    process.env.IMAGE_PIPELINE_METRICS = "1";
    currentUser = { id: "sa", role: "SUPERADMIN" };
    // 4 COUNTs: (removed, fallback) × (1h, 24h) — via Promise.all.
    countMock.mockResolvedValue(0);
    countMock
      .mockResolvedValueOnce(18)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(90)
      .mockResolvedValueOnce(10);

    const res = await app.inject({ method: "GET", url: "/internal/rembg/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rates.last1h).toEqual({ total: 20, fallback: 2, ratePct: 10 });
    expect(body.rates.last24h).toEqual({
      total: 100,
      fallback: 10,
      ratePct: 10,
    });
  });

  it("sidecar configurado e saudável: reachable=true com o /health embutido", async () => {
    process.env.REMBG_SIDECAR_URL = "http://127.0.0.1:8000";
    currentUser = { id: "sa", role: "SUPERADMIN" };
    axiosGetMock.mockResolvedValue({
      data: { status: "ok", model: "birefnet-general-lite" },
    });

    const res = await app.inject({ method: "GET", url: "/internal/rembg/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(axiosGetMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/health",
      expect.objectContaining({ timeout: 1500 }),
    );
    expect(body.sidecar.configured).toBe(true);
    expect(body.sidecar.reachable).toBe(true);
    expect(body.sidecar.health).toMatchObject({ model: "birefnet-general-lite" });
    expect(typeof body.sidecar.pingMs).toBe("number");
  });

  it("sidecar configurado mas MORTO: reachable=false + error, sem derrubar o endpoint", async () => {
    process.env.REMBG_SIDECAR_URL = "http://127.0.0.1:8000";
    currentUser = { id: "sa", role: "SUPERADMIN" };
    axiosGetMock.mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:8000"),
    );

    const res = await app.inject({ method: "GET", url: "/internal/rembg/status" });
    // É exatamente no incidente (sidecar fora) que o diagnóstico mais importa.
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sidecar.configured).toBe(true);
    expect(body.sidecar.reachable).toBe(false);
    expect(body.sidecar.error).toContain("ECONNREFUSED");
  });

  it("expõe os eventos do ring buffer (recentEvents/recentErrors)", async () => {
    currentUser = { id: "sa", role: "SUPERADMIN" };
    recordImageOutcome({
      source: "upload",
      lane: "internal",
      result: { removedBackground: true, format: "png" },
      durationMs: 9000,
    });
    recordImageOutcome({
      source: "public",
      lane: "public",
      result: {
        removedBackground: false,
        format: "webp",
        degradeReason: "conn_error",
      },
      durationMs: 42000,
    });

    const res = await app.inject({ method: "GET", url: "/internal/rembg/status" });
    const body = res.json();
    expect(body.recentEvents).toHaveLength(2);
    expect(body.recentErrors).toHaveLength(1);
    expect(body.recentErrors[0]).toMatchObject({
      source: "public",
      ok: false,
      reason: "conn_error",
    });
  });

  it("banco indisponível não derruba o diagnóstico (rates=null + ratesError)", async () => {
    process.env.IMAGE_PIPELINE_METRICS = "1";
    currentUser = { id: "sa", role: "SUPERADMIN" };
    countMock.mockRejectedValue(new Error("pooler saturado"));

    const res = await app.inject({ method: "GET", url: "/internal/rembg/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rates).toBeNull();
    expect(body.ratesError).toContain("pooler saturado");
  });
});
