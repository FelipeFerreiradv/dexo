import { afterEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * "Tentar novamente" das pendências de importação NUNCA funcionou: o front
 * mandava `Content-Type: application/json` sem corpo, e o Fastify recusa isso
 * ANTES de chegar na rota (400 FST_ERR_CTP_EMPTY_JSON_BODY). Em produção, as
 * 22 chamadas desde maio/2026 voltaram 400 — nenhuma chegou a re-tentar nada.
 * O mesmo padrão estava no "gerar rascunho fiscal" do diálogo do financeiro.
 */

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    if (!request.headers["email"]) return reply.status(401).send({ message: "Email is required" });
    request.user = { id: "owner", dataOwnerId: "owner" };
  },
}));
vi.mock("@/app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    if (!request.headers["email"]) return reply.status(401).send({ message: "Email is required" });
    request.user = { id: "owner", dataOwnerId: "owner" };
  },
}));

import prisma from "../app/lib/prisma";
import { orderRoutes } from "../app/routes/order.routes";
import { OrderIngestionReconcilerService } from "../app/marketplaces/services/order-ingestion-reconciler.service";

function buildApp() {
  const app = fastify();
  app.register(orderRoutes, { prefix: "/orders" });
  return app;
}

function setup() {
  vi.spyOn((prisma as any).orderIngestionIssue, "findFirst").mockResolvedValue({ id: "iss-1" });
  return vi.spyOn(OrderIngestionReconcilerService, "retryOne").mockResolvedValue({ resolved: true });
}

describe("POST /orders/ingestion-issues/:id/retry sem corpo", () => {
  afterEach(() => vi.restoreAllMocks());

  it("controle: Content-Type JSON com corpo vazio é recusado antes da rota (o defeito de produção)", async () => {
    const retry = setup();
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/orders/ingestion-issues/iss-1/retry",
      headers: { email: "dono@x.com", "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("FST_ERR_CTP_EMPTY_JSON_BODY");
    expect(retry).not.toHaveBeenCalled();
  });

  it("sem Content-Type (como o front agora envia) a rota executa a re-tentativa", async () => {
    const retry = setup();
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/orders/ingestion-issues/iss-1/retry",
      headers: { email: "dono@x.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, resolved: true });
    expect(retry).toHaveBeenCalledWith("iss-1");
  });
});

describe("guarda de regressão nos dois pontos do front", () => {
  // Não prova comportamento (isso é o teste de rota acima); só impede que o
  // Content-Type JSON volte a estas duas chamadas sem corpo.
  const trecho = (arquivo: string, url: string) => {
    const src = readFileSync(join(__dirname, "..", arquivo), "utf8");
    const i = src.indexOf(url);
    expect(i).toBeGreaterThan(-1);
    return src.slice(i, src.indexOf(");", i));
  };

  it("orders-list: retry da pendência", () => {
    const call = trecho("app/pedidos/components/orders-list.tsx", "/orders/ingestion-issues/${issueId}/retry");
    expect(call).not.toMatch(/["']content-type["']\s*:/i);
  });

  it("finance-dialog: rascunho fiscal", () => {
    const call = trecho("app/financeiro/components/finance-dialog.tsx", "/finance/receivables/${initialData.id}/fiscal-draft");
    expect(call).not.toMatch(/["']content-type["']\s*:/i);
  });
});
