import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// GET /locations/select — validação condicional por ETag.
//
// O payload é rebaixado inteiro a cada abertura do modal de produto (53,8 KB
// comprimidos no maior tenant). Com `Cache-Control: private, no-cache` o
// navegador REVALIDA sempre — nunca serve dado velho — e, quando nada mudou,
// a resposta vira 304 sem corpo.
//
// O que estes testes travam: o corpo do 200 continua byte-idêntico ao de antes
// (zero regressão de contrato), o 304 só acontece com ETag casando, e o ETag é
// por conteúdo — logo, muda com os dados e difere entre tenants.
// ──────────────────────────────────────────────────────────

const { findManyMock, locationGroupByMock, productGroupByMock } = vi.hoisted(
  () => ({
    findManyMock: vi.fn(),
    locationGroupByMock: vi.fn(),
    productGroupByMock: vi.fn(),
  }),
);

// O objeto é repetido nas duas fábricas de propósito: `vi.mock` é içado ao topo
// do arquivo, então não pode referenciar uma const declarada aqui fora.
vi.mock("../app/lib/prisma", () => ({
  default: {
    location: {
      findMany: (...args: any[]) => findManyMock(...args),
      count: vi.fn(),
      groupBy: (...args: any[]) => locationGroupByMock(...args),
    },
    product: {
      groupBy: (...args: any[]) => productGroupByMock(...args),
    },
  },
}));
vi.mock("@/app/lib/prisma", () => ({
  default: {
    location: {
      findMany: (...args: any[]) => findManyMock(...args),
      count: vi.fn(),
      groupBy: (...args: any[]) => locationGroupByMock(...args),
    },
    product: {
      groupBy: (...args: any[]) => productGroupByMock(...args),
    },
  },
}));

// `x-owner` permite simular dois tenants no mesmo teste.
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    const owner = (request.headers["x-owner"] as string) ?? "user-1";
    request.user = { id: owner, dataOwnerId: owner };
  },
}));

import { locationRoutes } from "../app/routes/location.routes";

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(locationRoutes, { prefix: "/locations" });
  return app;
}

function row(over: Record<string, any> = {}) {
  return {
    id: "g1",
    userId: "user-1",
    code: "G1",
    description: null,
    maxCapacity: 0,
    parentId: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...over,
  };
}

/** Cenário-base: uma raiz e uma filha com capacidade. */
function cenarioPadrao(produtosNaFilha = 5) {
  findManyMock.mockResolvedValue([
    row({ id: "g1", code: "G1" }),
    row({ id: "p1", code: "PRAT-01", maxCapacity: 10, parentId: "g1" }),
  ]);
  productGroupByMock.mockResolvedValue([
    { locationId: "p1", _count: { _all: produtosNaFilha } },
  ]);
  locationGroupByMock.mockResolvedValue([
    { parentId: "g1", _count: { _all: 1 } },
  ]);
}

async function pegar(app: any, headers: Record<string, string> = {}) {
  return app.inject({
    method: "GET",
    url: "/locations/select",
    headers: { email: OWNER, ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /locations/select — ETag", () => {
  it("o 200 mantém o corpo de sempre e ganha ETag + Cache-Control", async () => {
    cenarioPadrao();
    const res = await pegar(buildApp());

    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-cache");
    expect(res.headers["etag"]).toMatch(/^W\/"/);
    expect(res.headers["content-type"]).toContain("application/json");

    // Contrato inalterado: { locations: [...] } com os mesmos campos.
    const body = res.json();
    expect(Object.keys(body)).toEqual(["locations"]);
    expect(body.locations).toHaveLength(2);
    const prat = body.locations.find((l: any) => l.id === "p1");
    // `description` nula sai como `undefined` do mapper e o JSON.stringify a
    // omite — comportamento de sempre, preservado.
    expect(prat).toEqual({
      id: "p1",
      code: "PRAT-01",
      fullPath: "G1 > PRAT-01",
      maxCapacity: 10,
      productsCount: 5,
      isFull: false,
    });
  });

  it("devolve 304 sem corpo quando o If-None-Match casa", async () => {
    cenarioPadrao();
    const app = buildApp();

    const primeira = await pegar(app);
    const etag = primeira.headers["etag"] as string;

    const segunda = await pegar(app, { "if-none-match": etag });
    expect(segunda.statusCode).toBe(304);
    expect(segunda.body).toBe("");
    expect(segunda.headers["etag"]).toBe(etag);
    expect(segunda.headers["cache-control"]).toBe("private, no-cache");
  });

  it("aceita lista de candidatos no If-None-Match", async () => {
    cenarioPadrao();
    const app = buildApp();
    const etag = (await pegar(app)).headers["etag"] as string;

    const res = await pegar(app, {
      "if-none-match": `W/"outro-qualquer", ${etag}`,
    });
    expect(res.statusCode).toBe(304);
  });

  it("ETag antigo ou ausente devolve 200 com o corpo completo", async () => {
    cenarioPadrao();
    const app = buildApp();

    const desatualizado = await pegar(app, {
      "if-none-match": 'W/"etag-de-ontem"',
    });
    expect(desatualizado.statusCode).toBe(200);
    expect(desatualizado.json().locations).toHaveLength(2);

    const semHeader = await pegar(app);
    expect(semHeader.statusCode).toBe(200);
  });

  it("o ETag acompanha o CONTEÚDO: muda quando o productsCount muda", async () => {
    const app = buildApp();

    cenarioPadrao(5);
    const antes = (await pegar(app)).headers["etag"];

    vi.clearAllMocks();
    cenarioPadrao(6); // uma peça a mais vinculada
    const depois = (await pegar(app)).headers["etag"];

    expect(depois).not.toBe(antes);
  });

  it("dados idênticos geram o MESMO ETag (é o que vira 304)", async () => {
    const app = buildApp();

    cenarioPadrao(5);
    const primeira = (await pegar(app)).headers["etag"];

    vi.clearAllMocks();
    cenarioPadrao(5);
    const segunda = (await pegar(app)).headers["etag"];

    expect(segunda).toBe(primeira);
  });

  it("tenants diferentes não compartilham ETag — sem vazamento entre contas", async () => {
    const app = buildApp();

    cenarioPadrao(5);
    const doA = (await pegar(app, { "x-owner": "user-A" })).headers[
      "etag"
    ] as string;

    // Outro tenant, outra base de localizações.
    vi.clearAllMocks();
    findManyMock.mockResolvedValue([
      row({ id: "z9", code: "OUTRO-GALPAO", userId: "user-B" }),
    ]);
    productGroupByMock.mockResolvedValue([]);
    locationGroupByMock.mockResolvedValue([]);

    const resB = await pegar(app, {
      "x-owner": "user-B",
      "if-none-match": doA, // o navegador mandaria o ETag em cache
    });

    // Não pode virar 304: o conteúdo do tenant B é outro.
    expect(resB.statusCode).toBe(200);
    expect(resB.headers["etag"]).not.toBe(doA);
    expect(resB.json().locations[0].code).toBe("OUTRO-GALPAO");
  });

  it("lista vazia continua respondendo 200 com array vazio", async () => {
    findManyMock.mockResolvedValue([]);
    productGroupByMock.mockResolvedValue([]);
    locationGroupByMock.mockResolvedValue([]);

    const res = await pegar(buildApp());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ locations: [] });
    expect(res.headers["etag"]).toBeTruthy();
  });

  it("sem autenticação continua 401, antes de qualquer consulta", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/locations/select",
    });
    expect(res.statusCode).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});
