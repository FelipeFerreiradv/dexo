import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Chamado MK2 Autopeças (09/2026). Mover peça entre localizações não deixava
// rastro NENHUM: nem SystemLog, nem StockLog. O que existia era o log genérico
// do middleware, rotulado CREATE_LOCATION e com o destino "[REDACTED]".
//
// Aqui travamos o registro PRÓPRIO: origem, destino, contadores e ids — nos
// dois caminhos, sucesso e erro. O caminho de erro é obrigatório porque
// `determineActionType` passou a devolver `null` para esta rota; sem ele, a
// correção trocaria um rastro mal rotulado por NENHUM rastro de falha.
//
// Mocks precisam preceder o import das rotas.
// ──────────────────────────────────────────────────────────

// `vi.hoisted` porque as fábricas de `vi.mock` são içadas para o topo do
// arquivo: um `const` normal ainda estaria na zona morta quando a fábrica roda,
// e o erro que aparece é "Cannot access 'groupByMock' before initialization".
const { groupByMock } = vi.hoisted(() => ({ groupByMock: vi.fn() }));

vi.mock("../app/lib/prisma", () => {
  // `: any` explícito — sem ele o `$transaction` que devolve o próprio `prisma`
  // torna a inferência circular (TS7022/TS7024) assim que o objeto ganha um
  // delegate a mais que o do spec original.
  const prisma: any = {
    product: { updateMany: vi.fn(), groupBy: groupByMock },
    location: { findFirst: vi.fn() },
    $transaction: vi.fn(async (cb: any) => cb(prisma)),
  };
  return { default: prisma };
});
vi.mock("@/app/lib/prisma", () => {
  // `: any` explícito — sem ele o `$transaction` que devolve o próprio `prisma`
  // torna a inferência circular (TS7022/TS7024) assim que o objeto ganha um
  // delegate a mais que o do spec original.
  const prisma: any = {
    product: { updateMany: vi.fn(), groupBy: groupByMock },
    location: { findFirst: vi.fn() },
    $transaction: vi.fn(async (cb: any) => cb(prisma)),
  };
  return { default: prisma };
});

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logInfo: vi.fn(),
    logWarning: vi.fn(),
    logError: vi.fn(),
    log: vi.fn(),
  },
}));

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    request.user = { id: "user-owner", dataOwnerId: "user-owner" };
  },
}));

const moveProductsMock = vi.fn();
vi.mock("../app/repositories/location.repository", () => ({
  LocationRepositoryPrisma: class {
    async findById(id: string) {
      if (id === "loc-dest") {
        return {
          id: "loc-dest",
          userId: "user-owner",
          code: "CX58",
          description: undefined,
          maxCapacity: 0, // sem limite
          parentId: undefined,
          createdAt: new Date(),
          updatedAt: new Date(),
          productsCount: 0,
        };
      }
      return null; // para a recursão de buildFullPath
    }
    moveProducts = moveProductsMock;
  },
}));

import { SystemLogService } from "../app/services/system-log.service";
import { locationRoutes } from "../app/routes/location.routes";

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(locationRoutes, { prefix: "/locations" });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  groupByMock.mockResolvedValue([]);
});

describe("POST /locations/move-products — rastro da movimentação", () => {
  it("grava SystemLog com MOVE_PRODUCTS_LOCATION ao mover", async () => {
    groupByMock.mockResolvedValue([
      { locationId: "loc-origem", location: "GAL > CX1", _count: { _all: 2 } },
    ]);
    moveProductsMock.mockResolvedValue(2);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/move-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: ["p1", "p2"], targetLocationId: "loc-dest" },
    });

    expect(res.statusCode).toBe(200);
    expect(SystemLogService.logInfo).toHaveBeenCalledWith(
      "MOVE_PRODUCTS_LOCATION",
      expect.any(String),
      expect.objectContaining({
        userId: "user-owner",
        details: expect.objectContaining({
          destinoId: "loc-dest",
          movidos: 2,
          origens: [
            { locationId: "loc-origem", caminho: "GAL > CX1", quantidade: 2 },
          ],
        }),
      }),
    );
  });

  it("grava UNBIND_PRODUCTS_LOCATION ao desvincular", async () => {
    groupByMock.mockResolvedValue([
      { locationId: "loc-origem", location: "GAL > CX1", _count: { _all: 1 } },
    ]);
    moveProductsMock.mockResolvedValue(1);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/move-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: ["p1"], targetLocationId: null },
    });

    expect(res.statusCode).toBe(200);
    expect(SystemLogService.logInfo).toHaveBeenCalledWith(
      "UNBIND_PRODUCTS_LOCATION",
      expect.any(String),
      expect.objectContaining({
        details: expect.objectContaining({ destinoId: null, movidos: 1 }),
      }),
    );
  });

  it("registra também quando o movimento FALHA", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/move-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: ["p1"], targetLocationId: "loc-inexistente" },
    });

    expect(res.statusCode).toBe(404);
    // `logError` e não `logWarning`: o middleware gravava level ERROR para
    // qualquer status >= 400. Rebaixar a severidade sumiria com as falhas de
    // movimentação para quem filtra por erro — mudança de comportamento.
    expect(SystemLogService.logError).toHaveBeenCalledWith(
      "MOVE_PRODUCTS_LOCATION",
      expect.stringMatching(/Falha ao mover/i),
      expect.objectContaining({
        details: expect.objectContaining({ resultado: "erro", statusCode: 404 }),
      }),
    );
    expect(SystemLogService.logWarning).not.toHaveBeenCalled();
  });

  it("não derruba o movimento quando o log falha", async () => {
    // Auditoria nunca pode transformar um movimento bem-sucedido em 500.
    groupByMock.mockResolvedValue([]);
    moveProductsMock.mockResolvedValue(1);
    (SystemLogService.logInfo as any).mockRejectedValueOnce(
      new Error("log fora do ar"),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/move-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: ["p1"], targetLocationId: "loc-dest" },
    });

    expect(res.statusCode).toBe(200);
  });

  it("segue movendo quando a leitura de origem falha, marcando o buraco", async () => {
    // A leitura é best-effort: se o groupBy quebrar, o movimento acontece do
    // mesmo jeito e o registro diz que a origem não foi capturada.
    groupByMock.mockRejectedValue(new Error("pool esgotado"));
    moveProductsMock.mockResolvedValue(1);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/move-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: ["p1"], targetLocationId: "loc-dest" },
    });

    expect(res.statusCode).toBe(200);
    expect(moveProductsMock).toHaveBeenCalled();
    expect(SystemLogService.logInfo).toHaveBeenCalledWith(
      "MOVE_PRODUCTS_LOCATION",
      expect.any(String),
      expect.objectContaining({
        details: expect.objectContaining({ origemIndisponivel: true }),
      }),
    );
  });
});

describe("POST /locations/move-products — contrato da resposta", () => {
  // Controle negativo: o desfazer do scan (scan-receive-flow.tsx) depende de
  // `res.ok`, e a tela de localizações de `message`/`count`. Nada disso muda.
  it("mantém message e count exatamente como antes", async () => {
    groupByMock.mockResolvedValue([
      { locationId: "loc-origem", location: "CX1", _count: { _all: 2 } },
    ]);
    moveProductsMock.mockResolvedValue(2);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/move-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: ["p1", "p2"], targetLocationId: "loc-dest" },
    });

    const body = res.json();
    expect(body.count).toBe(2);
    expect(body.message).toContain("CX58");
  });

  it("acrescenta moved/alreadyThere/notFound para distinguir no-op de sucesso", async () => {
    // `count` conta linha que casou no updateMany, não peça que mudou de lugar:
    // sem estes campos, 5 peças já no destino viravam "5 movidas" em verde.
    groupByMock.mockResolvedValue([
      { locationId: "loc-dest", location: "CX58", _count: { _all: 5 } },
    ]);
    moveProductsMock.mockResolvedValue(5);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/move-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        productIds: ["p1", "p2", "p3", "p4", "p5"],
        targetLocationId: "loc-dest",
      },
    });

    const body = res.json();
    expect(body.count).toBe(5);
    expect(body.moved).toBe(0);
    expect(body.alreadyThere).toBe(5);
    expect(body.notFound).toBe(0);
  });

  it("não muda o status code em nenhum caminho de sucesso", async () => {
    groupByMock.mockResolvedValue([]);
    moveProductsMock.mockResolvedValue(0);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/move-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: ["p1"], targetLocationId: null },
    });

    // Mesmo com 0 movidas continua 200 — mudar isso quebraria o desfazer do
    // scan, que trata !res.ok como erro. Quem rebaixa o TOM é a tela.
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(0);
  });
});
