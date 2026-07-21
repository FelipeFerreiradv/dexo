import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Mocks que precisam preceder o import das rotas
// ──────────────────────────────────────────────────────────

vi.mock("../app/lib/prisma", () => {
  // Sem `$transaction`: `createBulk` não abre transação (o INSERT com
  // ON CONFLICT já é atômico), e declará-la aqui criaria a referência
  // circular que dispara TS7022 nos specs mais antigos.
  return {
    default: {
      location: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        createManyAndReturn: vi.fn(),
      },
    },
  };
});

vi.mock("@/app/lib/prisma", () => {
  // Sem `$transaction`: `createBulk` não abre transação (o INSERT com
  // ON CONFLICT já é atômico), e declará-la aqui criaria a referência
  // circular que dispara TS7022 nos specs mais antigos.
  return {
    default: {
      location: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        createManyAndReturn: vi.fn(),
      },
    },
  };
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
    const userId = email === "owner@test.com" ? "user-owner" : "user-other";
    request.user = { id: userId, dataOwnerId: userId };
  },
}));

// `createBulk` fala direto com o prisma (como `createLean`); o repositório só
// precisa existir para instanciar o use case.
vi.mock("../app/repositories/location.repository", () => ({
  LocationRepositoryPrisma: class {
    async findById() {
      return null;
    }
  },
}));

import prisma from "../app/lib/prisma";
import { locationRoutes } from "../app/routes/location.routes";
import {
  MAX_LOCATIONS_PER_ROW,
  MAX_ROWS_PER_BATCH,
  MAX_TOTAL_LOCATIONS,
} from "../app/localizacoes/lib/bulk-locations";

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(locationRoutes, { prefix: "/locations" });
  return app;
}

function post(app: ReturnType<typeof buildApp>, payload: any, email = OWNER) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (email) headers.email = email;
  return app.inject({ method: "POST", url: "/locations/bulk", headers, payload });
}

/**
 * Arma o `findMany` por FORMATO da query (a consulta de pais usa `id.in`, a de
 * códigos existentes usa `code.in`). Encadear `mockResolvedValueOnce` não
 * serve aqui: a consulta de pais só acontece quando alguma faixa tem mãe, e um
 * "once" não consumido vazaria para o teste seguinte.
 */
function armFindMany({
  parents = [] as Array<{ id: string }>,
  existing = [] as Array<{ code: string }>,
} = {}) {
  (prisma as any).location.findMany.mockImplementation(async ({ where }: any) => {
    if (where?.id?.in) return parents;
    if (where?.code?.in) return existing;
    return [];
  });
}

/** Insert devolve exatamente o que foi pedido (caminho sem concorrência). */
function armInsertEcho() {
  (prisma as any).location.createManyAndReturn.mockImplementation(
    async ({ data }: any) =>
      data.map((d: any, i: number) => ({ id: `loc-${i + 1}`, code: d.code })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  armFindMany();
  armInsertEcho();
});

describe("POST /locations/bulk — criação", () => {
  it("cria a faixa inteira e responde 201", async () => {
    const res = await post(buildApp(), {
      rows: [{ prefix: "PRT-", start: 1, end: 3 }],
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.summary).toMatchObject({
      requested: 3,
      created: 3,
      skipped: 0,
      failed: 0,
    });
    expect(body.created.map((c: any) => c.code)).toEqual([
      "PRT-1",
      "PRT-2",
      "PRT-3",
    ]);

    const call = (prisma as any).location.createManyAndReturn.mock.calls[0][0];
    expect(call.skipDuplicates).toBe(true);
    expect(call.data[0]).toMatchObject({
      userId: "user-owner",
      code: "PRT-1",
      parentId: null,
      maxCapacity: 0,
      description: null,
    });
  });

  it("aplica zeros à esquerda nas siglas gravadas", async () => {
    const res = await post(buildApp(), {
      rows: [{ prefix: "prt-", start: 1, end: 3, padding: 2 }],
    });

    expect(res.statusCode).toBe(201);
    const call = (prisma as any).location.createManyAndReturn.mock.calls[0][0];
    expect(call.data.map((d: any) => d.code)).toEqual([
      "PRT-01",
      "PRT-02",
      "PRT-03",
    ]);
  });

  it("leva capacidade e descrição da faixa para cada localização", async () => {
    await post(buildApp(), {
      rows: [
        {
          prefix: "PRT-",
          start: 1,
          end: 2,
          maxCapacity: 10,
          description: "  Prateleira  ",
        },
      ],
    });

    const call = (prisma as any).location.createManyAndReturn.mock.calls[0][0];
    expect(call.data.every((d: any) => d.maxCapacity === 10)).toBe(true);
    expect(call.data.every((d: any) => d.description === "Prateleira")).toBe(true);
  });

  it("usa a mãe de cada faixa depois de validá-la no tenant", async () => {
    armFindMany({ parents: [{ id: "pai-1" }, { id: "pai-2" }] });

    const res = await post(buildApp(), {
      rows: [
        { prefix: "PRT-", start: 1, end: 2, parentId: "pai-1" },
        { prefix: "CX-", start: 1, end: 1, parentId: "pai-2" },
      ],
    });

    expect(res.statusCode).toBe(201);
    const parentQuery = (prisma as any).location.findMany.mock.calls[0][0];
    expect(parentQuery.where).toMatchObject({
      userId: "user-owner",
      id: { in: ["pai-1", "pai-2"] },
    });

    const call = (prisma as any).location.createManyAndReturn.mock.calls[0][0];
    expect(call.data.find((d: any) => d.code === "PRT-1").parentId).toBe("pai-1");
    expect(call.data.find((d: any) => d.code === "CX-1").parentId).toBe("pai-2");
  });
});

describe("POST /locations/bulk — duplicados não quebram o lote", () => {
  it("reporta as siglas que já existiam e cria o resto", async () => {
    armFindMany({ existing: [{ code: "PRT-2" }] });

    const res = await post(buildApp(), {
      rows: [{ prefix: "PRT-", start: 1, end: 3 }],
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.summary).toMatchObject({ created: 2, skipped: 1 });
    expect(body.skipped).toEqual([{ code: "PRT-2", reason: "ja_existe" }]);

    const call = (prisma as any).location.createManyAndReturn.mock.calls[0][0];
    expect(call.data.map((d: any) => d.code)).toEqual(["PRT-1", "PRT-3"]);
  });

  it("trata a corrida: o que o INSERT não devolveu vira pulado, sem 500", async () => {
    // Pré-check limpo, mas outra sessão criou PRT-2 antes do INSERT
    // → ON CONFLICT DO NOTHING devolve só os dois que entraram.
    (prisma as any).location.createManyAndReturn.mockResolvedValue([
      { id: "loc-1", code: "PRT-1" },
      { id: "loc-3", code: "PRT-3" },
    ]);

    const res = await post(buildApp(), {
      rows: [{ prefix: "PRT-", start: 1, end: 3 }],
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.summary).toMatchObject({ created: 2, skipped: 1 });
    expect(body.skipped).toEqual([{ code: "PRT-2", reason: "ja_existe" }]);
  });

  it("lote inteiro já existente responde 200 e nem chama o insert", async () => {
    armFindMany({ existing: [{ code: "PRT-1" }, { code: "PRT-2" }] });

    const res = await post(buildApp(), {
      rows: [{ prefix: "PRT-", start: 1, end: 2 }],
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toMatchObject({ created: 0, skipped: 2 });
    expect((prisma as any).location.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("mãe de outro tenant vira falha reportada, sem entrar no insert", async () => {
    armFindMany({ parents: [] }); // o pai informado não pertence ao tenant

    const res = await post(buildApp(), {
      rows: [
        { prefix: "PRT-", start: 1, end: 1, parentId: "pai-de-outro" },
        { prefix: "CX-", start: 1, end: 1 },
      ],
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.failed).toEqual([
      { code: "PRT-1", error: "Localização pai não encontrada" },
    ]);
    const call = (prisma as any).location.createManyAndReturn.mock.calls[0][0];
    expect(call.data.map((d: any) => d.code)).toEqual(["CX-1"]);
  });
});

describe("POST /locations/bulk — validação", () => {
  it.each([
    ["corpo sem rows", {}],
    ["rows vazio", { rows: [] }],
    ["rows não é array", { rows: "PRT-" }],
  ])("400 quando %s", async (_label, payload) => {
    const res = await post(buildApp(), payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Lista de faixas é obrigatória");
    expect((prisma as any).location.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("400 ao estourar o teto do lote", async () => {
    const rows = ["A-", "B-", "C-"].map((prefix) => ({
      prefix,
      start: 1,
      end: MAX_LOCATIONS_PER_ROW,
    }));
    const res = await post(buildApp(), { rows });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(String(MAX_TOTAL_LOCATIONS));
  });

  it("400 quando o fim é menor que o início, apontando a faixa", async () => {
    const res = await post(buildApp(), {
      rows: [
        { prefix: "PRT-", start: 1, end: 2 },
        { prefix: "CX-", start: 9, end: 1 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Faixa 2");
  });

  it("400 quando a sigla gerada passa de 20 caracteres", async () => {
    const res = await post(buildApp(), {
      rows: [{ prefix: "A".repeat(19), start: 1, end: 99 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("20 caracteres");
  });

  it("400 quando duas faixas geram a mesma sigla", async () => {
    const res = await post(buildApp(), {
      rows: [
        { prefix: "PRT-", start: 1, end: 5 },
        { prefix: "PRT-", start: 3, end: 8 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect((prisma as any).location.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("400 quando há faixas demais", async () => {
    const rows = Array.from({ length: MAX_ROWS_PER_BATCH + 1 }, (_, i) => ({
      prefix: `P${i}-`,
      start: 1,
      end: 1,
    }));
    const res = await post(buildApp(), { rows });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(String(MAX_ROWS_PER_BATCH));
  });

  it("400 quando a capacidade é negativa", async () => {
    const res = await post(buildApp(), {
      rows: [{ prefix: "PRT-", start: 1, end: 2, maxCapacity: -1 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.toLowerCase()).toContain("capacidade");
  });

  it("rejeita faixa absurda de imediato, sem tentar expandi-la", async () => {
    const inicio = Date.now();
    const res = await post(buildApp(), {
      rows: [{ prefix: "A-", start: 1, end: 2_000_000_000 }],
    });
    // Expandir antes de checar o teto travaria o processo inteiro.
    expect(Date.now() - inicio).toBeLessThan(2000);
    expect(res.statusCode).toBe(400);
    expect((prisma as any).location.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("mãe informada como string vazia é tratada como raiz", async () => {
    const res = await post(buildApp(), {
      rows: [{ prefix: "PRT-", start: 1, end: 2, parentId: "" }],
    });

    expect(res.statusCode).toBe(201);
    const call = (prisma as any).location.createManyAndReturn.mock.calls[0][0];
    // FK vazia faria o Postgres derrubar o lote inteiro.
    expect(call.data.every((d: any) => d.parentId === null)).toBe(true);
  });

  it("401 sem o header de identificação", async () => {
    const res = await post(
      buildApp(),
      { rows: [{ prefix: "PRT-", start: 1, end: 1 }] },
      "",
    );
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /locations/bulk — escopo de tenant", () => {
  it("toda leitura e escrita usa o dataOwnerId de quem chamou", async () => {
    armFindMany({ parents: [{ id: "pai-1" }] });

    await post(
      buildApp(),
      { rows: [{ prefix: "PRT-", start: 1, end: 2, parentId: "pai-1" }] },
      "outro@test.com",
    );

    for (const call of (prisma as any).location.findMany.mock.calls) {
      expect(call[0].where.userId).toBe("user-other");
    }
    const insert = (prisma as any).location.createManyAndReturn.mock.calls[0][0];
    expect(insert.data.every((d: any) => d.userId === "user-other")).toBe(true);
  });
});
