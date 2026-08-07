import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { FastifyInstance } from "fastify";

// authMiddleware mockado para popular request.user com um tenant controlado
// pelo teste. O gate usado (requireAiEnabled / isAiEnabledFor) é o REAL — é
// exatamente o que este spec precisa provar. Mesmo padrão de
// tests/internal.routes.spec.ts:4-12.
let currentUser: { id: string; dataOwnerId: string } | null = null;
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = currentUser;
  },
}));

// Prisma mockado: o gate só toca banco em user.findUnique({select:{aiEnabledAt}}).
const findUniqueMock = vi.fn();
vi.mock("../app/lib/prisma", () => ({
  default: {
    user: { findUnique: (...args: any[]) => findUniqueMock(...args) },
  },
}));

import { aiRoutes } from "../app/routes/ai.routes";
import { authMiddleware } from "../app/middlewares/auth.middleware";
import { requireAiEnabled } from "../app/ai/entitlement/require-ai-enabled";
import { clearAiEntitlementCache } from "../app/ai/entitlement/ai-entitlement.service";

describe("rotas /ai/* — gate Premium", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    currentUser = null;
    findUniqueMock.mockReset();
    clearAiEntitlementCache();

    app = fastify();
    await app.register(aiRoutes, { prefix: "/ai" });

    // Rota descartável que exercita o preHandler REAL na mesma composição que
    // as rotas de negócio vão usar (auth primeiro, gate depois). É assim que
    // provamos o contrato do 403 na Fase 1, antes de existir qualquer rota
    // que faça algo.
    app.get(
      "/ai/__probe",
      { preHandler: [authMiddleware, requireAiEnabled] },
      async () => ({ ok: true }),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  // -------------------------------------------------------------------------
  // GET /ai/entitlement — sonda da UI. NUNCA 403: "não contratado" é legítimo.
  // -------------------------------------------------------------------------
  describe("GET /ai/entitlement", () => {
    it("flag global desligada: 200 {enabled:false} sem tocar o banco", async () => {
      vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "");
      currentUser = { id: "u1", dataOwnerId: "t1" };

      const res = await app.inject({ method: "GET", url: "/ai/entitlement" });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: false });
      expect(findUniqueMock).not.toHaveBeenCalled();
    });

    it("flag ligada + sem plano: 200 {enabled:false}", async () => {
      vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
      currentUser = { id: "u1", dataOwnerId: "t1" };
      findUniqueMock.mockResolvedValue({ aiEnabledAt: null });

      const res = await app.inject({ method: "GET", url: "/ai/entitlement" });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: false });
    });

    it("flag ligada + plano ativo: 200 {enabled:true}", async () => {
      vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
      currentUser = { id: "u1", dataOwnerId: "t1" };
      findUniqueMock.mockResolvedValue({ aiEnabledAt: new Date() });

      const res = await app.inject({ method: "GET", url: "/ai/entitlement" });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: true });
    });

    it("sem usuário autenticado: 401", async () => {
      vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
      currentUser = null;

      const res = await app.inject({ method: "GET", url: "/ai/entitlement" });

      expect(res.statusCode).toBe(401);
    });

    it("usa o dataOwnerId (colaborador herda do admin pai), não o id do ator", async () => {
      vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
      currentUser = { id: "colaborador-9", dataOwnerId: "admin-pai-1" };
      findUniqueMock.mockResolvedValue({ aiEnabledAt: new Date() });

      await app.inject({ method: "GET", url: "/ai/entitlement" });

      expect(findUniqueMock).toHaveBeenCalledWith({
        where: { id: "admin-pai-1" },
        select: { aiEnabledAt: true },
      });
    });
  });

  // -------------------------------------------------------------------------
  // requireAiEnabled — 403 no namespace próprio do módulo.
  // -------------------------------------------------------------------------
  describe("requireAiEnabled", () => {
    it("flag global desligada: 403 AI_DISABLED", async () => {
      vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "");
      currentUser = { id: "u1", dataOwnerId: "t1" };

      const res = await app.inject({ method: "GET", url: "/ai/__probe" });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("AI_DISABLED");
    });

    it("flag ligada mas tenant sem plano: 403 AI_DISABLED", async () => {
      vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
      currentUser = { id: "u1", dataOwnerId: "t1" };
      findUniqueMock.mockResolvedValue({ aiEnabledAt: null });

      const res = await app.inject({ method: "GET", url: "/ai/__probe" });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("AI_DISABLED");
    });

    it("flag ligada + plano ativo: passa para o handler", async () => {
      vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
      currentUser = { id: "u1", dataOwnerId: "t1" };
      findUniqueMock.mockResolvedValue({ aiEnabledAt: new Date() });

      const res = await app.inject({ method: "GET", url: "/ai/__probe" });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });

    it("sem usuário: não responde 403 (o authMiddleware já respondeu 401)", async () => {
      vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
      currentUser = null;

      const res = await app.inject({ method: "GET", url: "/ai/__probe" });

      // O hook sai cedo sem escrever na reply; o handler segue.
      expect(res.statusCode).toBe(200);
      expect(findUniqueMock).not.toHaveBeenCalled();
    });
  });
});
