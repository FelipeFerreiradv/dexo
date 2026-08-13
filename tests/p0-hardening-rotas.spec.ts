import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ===========================================================================
// P0 — o endurecimento das rotas de Sucatas e Clientes.
//
// ⭐⭐ AS DUAS AFIRMAÇÕES QUE ESTE SPEC EXISTE PARA PROVAR, E A SEGUNDA IMPORTA
// TANTO QUANTO A PRIMEIRA:
//
//  1. O colaborador que o administrador barrou de uma página é barrado TAMBÉM
//     na API. Antes, esconder o menu não impedia um `curl`.
//  2. E quem NÃO foi barrado continua trabalhando. `GET /customers` e
//     `GET /scraps` alimentam comboboxes do Financeiro e do cadastro de peça —
//     fechá-los pela página "dona" tiraria a tela de gente que tem Financeiro e
//     não tem Clientes. Medido em produção: 9 colaboradores com `sucatas:false`
//     e 6 com `clientes:false`, de 81.
// ===========================================================================

vi.mock("../app/lib/prisma", () => {
  const prisma: any = {
    scrap: {
      findFirst: vi.fn().mockResolvedValue({ id: "s-1" }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      update: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    location: { findFirst: vi.fn().mockResolvedValue(null) },
    customer: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findUnique: vi.fn() },
    product: { updateMany: vi.fn() },
  };
  return { default: prisma };
});

// O ator vem por header, para cada teste montar o colaborador que quiser.
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    const perms = request.headers["x-perms"];
    request.user = {
      id: "colab-1",
      dataOwnerId: "user-owner",
      parentUserId: request.headers["x-admin"] ? null : "user-owner",
      pagePermissions: perms ? JSON.parse(String(perms)) : null,
    };
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logInfo: vi.fn().mockResolvedValue(undefined),
    logWarning: vi.fn().mockResolvedValue(undefined),
    logError: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

import prisma from "../app/lib/prisma";
import { scrapRoutes } from "../app/routes/scrap.routes";
import { customerRoutes } from "../app/routes/customer.routes";
import { ScrapRepositoryPrisma } from "../app/repositories/scrap.repository";

function app() {
  const a = fastify();
  a.register(scrapRoutes, { prefix: "/scraps" });
  a.register(customerRoutes, { prefix: "/customers" });
  return a;
}

/** Cabeçalhos de um colaborador com as permissões dadas. */
const colab = (perms: Record<string, boolean> | null) => ({
  email: "colab@test.com",
  ...(perms ? { "x-perms": JSON.stringify(perms) } : {}),
});
const admin = { email: "admin@test.com", "x-admin": "1" };

const LINHA = {
  id: "s-1",
  userId: "user-owner",
  brand: "VW",
  model: "Gol",
  year: null,
  version: null,
  color: null,
  plate: null,
  chassis: null,
  engineNumber: null,
  renavam: null,
  lot: null,
  deregistrationCert: null,
  nickname: null,
  cost: null,
  extraCosts: null,
  paymentMethod: null,
  locationId: null,
  ncm: null,
  supplierCnpj: null,
  accessKey: null,
  issueDate: null,
  entryDate: null,
  nfeNumber: null,
  nfeProtocol: null,
  operationNature: null,
  nfeSeries: null,
  fiscalModel: null,
  icmsValue: null,
  icmsCtValue: null,
  freightMode: null,
  issuePurpose: null,
  imageUrls: [],
  status: "AVAILABLE",
  logisticsStatus: "IN_YARD",
  notes: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  location: null,
  _count: { products: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  (prisma as any).scrap.create.mockResolvedValue(LINHA);
  (prisma as any).scrap.findFirst.mockResolvedValue({ id: "s-1" });
  (prisma as any).scrap.findMany.mockResolvedValue([]);
  (prisma as any).scrap.count.mockResolvedValue(0);
  (prisma as any).location.findFirst.mockResolvedValue(null);
  (prisma as any).customer.findFirst.mockResolvedValue(null);
  (prisma as any).customer.findMany.mockResolvedValue([]);
  (prisma as any).customer.count.mockResolvedValue(0);
  (prisma as any).customer.create.mockResolvedValue({ id: "c-1", name: "X" });
});

// ---------------------------------------------------------------------------

describe("⭐ P0.1 — o bloqueio de página deixa de ser cosmético", () => {
  it("colaborador barrado de Sucatas NÃO cria sucata pela API", async () => {
    const r = await app().inject({
      method: "POST",
      url: "/scraps",
      headers: colab({ sucatas: false }),
      payload: { brand: "VW", model: "Gol" },
    });

    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe("PAGE_FORBIDDEN");
    // E não chegou perto do banco.
    expect((prisma as any).scrap.create).not.toHaveBeenCalled();
  });

  it("barrado de Sucatas também não apaga, não edita e não move no pipeline", async () => {
    for (const [method, url] of [
      ["PUT", "/scraps/s-1"],
      ["PATCH", "/scraps/s-1/logistics-status"],
      ["DELETE", "/scraps/s-1"],
    ] as const) {
      const r = await app().inject({
        method,
        url,
        headers: colab({ sucatas: false }),
        payload: { logisticsStatus: "ON_LIFT" },
      });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("colaborador barrado de Clientes não cria, não edita e não apaga cliente", async () => {
    for (const [method, url] of [
      ["POST", "/customers"],
      ["PUT", "/customers/c-1"],
      ["DELETE", "/customers/c-1"],
    ] as const) {
      const r = await app().inject({
        method,
        url,
        headers: colab({ clientes: false }),
        payload: { name: "João" },
      });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("⭐⭐ NÃO REGRESSÃO: quem tem Financeiro e NÃO tem Clientes continua com o combobox", async () => {
    // `customer-combobox.tsx` do Financeiro chama estas duas. Barrá-las por
    // `clientes` tiraria a escolha de cliente de uma venda — de 6 pessoas reais.
    for (const url of ["/customers?limit=20", "/customers/search?q=joao"]) {
      const r = await app().inject({
        method: "GET",
        url,
        headers: colab({ clientes: false, financeiro: true }),
      });
      expect(r.statusCode, url).toBe(200);
    }
  });

  it("⭐⭐ NÃO REGRESSÃO: quem tem Financeiro ou Produtos e não tem Sucatas continua listando lotes", async () => {
    // O combobox de sucata do Financeiro e o vínculo de lote no cadastro de
    // peça usam `GET /scraps`. São 9 pessoas reais.
    const combinacoes: Record<string, boolean>[] = [
      { sucatas: false, financeiro: true },
      { sucatas: false, produtos: true },
    ];
    for (const perms of combinacoes) {
      const r = await app().inject({
        method: "GET",
        url: "/scraps?limit=10",
        headers: colab(perms),
      });
      expect(r.statusCode, JSON.stringify(perms)).toBe(200);
    }
  });

  it("mas quem não tem NENHUMA das páginas que usam o endpoint é barrado", async () => {
    const r = await app().inject({
      method: "GET",
      url: "/customers?limit=20",
      headers: colab({ clientes: false, financeiro: false }),
    });
    expect(r.statusCode).toBe(403);
  });

  it("colaborador SEM pagePermissions passa em tudo, exatamente como antes", async () => {
    const r = await app().inject({
      method: "POST",
      url: "/scraps",
      headers: colab(null),
      payload: { brand: "VW", model: "Gol" },
    });
    expect(r.statusCode).toBe(201);
  });

  it("admin passa em tudo, sem tocar no banco para checar permissão", async () => {
    const r = await app().inject({
      method: "POST",
      url: "/scraps",
      headers: admin,
      payload: { brand: "VW", model: "Gol" },
    });
    expect(r.statusCode).toBe(201);
    expect((prisma as any).user.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("⭐ P1.3 — a sucata passa a saber quem deu entrada nela", () => {
  it("grava o ATOR, não o dono da conta", async () => {
    const r = await app().inject({
      method: "POST",
      url: "/scraps",
      headers: colab(null),
      payload: { brand: "VW", model: "Gol" },
    });
    expect(r.statusCode).toBe(201);

    // ⚠️ O colaborador tem `id: colab-1` e `dataOwnerId: user-owner`. Gravar o
    // segundo diria que o admin cadastrou o lote — que é justamente o defeito
    // que já existiu em `Product` e deixou "Criado por" mostrando "—".
    const data = (prisma as any).scrap.create.mock.calls[0][0].data;
    expect(data.createdByUserId).toBe("colab-1");
    expect(data.userId).toBe("user-owner");
  });
});

describe("⭐ P0.2 — enum inválido é 400, não 500", () => {
  it.each([
    ["status", { status: "LIXO" }],
    ["logisticsStatus", { logisticsStatus: "VOANDO" }],
  ])("POST com %s inválido devolve 400 e não toca no banco", async (_n, extra) => {
    const r = await app().inject({
      method: "POST",
      url: "/scraps",
      headers: admin,
      payload: { brand: "VW", model: "Gol", ...extra },
    });

    // ⚠️ Antes isto estourava no Prisma e virava 500 — erro de servidor para o
    // que é erro de quem chamou.
    expect(r.statusCode).toBe(400);
    expect((prisma as any).scrap.create).not.toHaveBeenCalled();
  });

  it("PUT com enum inválido devolve 400", async () => {
    const r = await app().inject({
      method: "PUT",
      url: "/scraps/s-1",
      headers: admin,
      payload: { brand: "VW", status: "SUMIU" },
    });
    expect(r.statusCode).toBe(400);
  });

  it("valor VÁLIDO do enum continua passando", async () => {
    const r = await app().inject({
      method: "POST",
      url: "/scraps",
      headers: admin,
      payload: {
        brand: "VW",
        model: "Gol",
        status: "AVAILABLE",
        logisticsStatus: "ON_LIFT",
      },
    });
    expect(r.statusCode).toBe(201);
  });

  it("sem os campos, o default continua valendo", async () => {
    const r = await app().inject({
      method: "POST",
      url: "/scraps",
      headers: admin,
      payload: { brand: "VW", model: "Gol" },
    });
    expect(r.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------

describe("⭐ P0.3 — dígito verificador de CPF/CNPJ na API", () => {
  it("CPF com 11 dígitos e DV inválido é REJEITADO", async () => {
    const r = await app().inject({
      method: "POST",
      url: "/customers",
      headers: admin,
      payload: { name: "João", cpf: "11111111111" },
    });

    // ⚠️ Este é o payload exato que entrava antes: comprimento certo, DV errado.
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/CPF inválido/i);
    expect((prisma as any).customer.create).not.toHaveBeenCalled();
  });

  it("CPF válido passa", async () => {
    const r = await app().inject({
      method: "POST",
      url: "/customers",
      headers: admin,
      payload: { name: "João", cpf: "529.982.247-25" },
    });
    expect(r.statusCode).toBe(201);
  });

  it("CNPJ com DV inválido é rejeitado; o válido passa", async () => {
    const ruim = await app().inject({
      method: "POST",
      url: "/customers",
      headers: admin,
      payload: { name: "Oficina", cnpj: "11222333000100" },
    });
    expect(ruim.statusCode).toBe(400);

    const bom = await app().inject({
      method: "POST",
      url: "/customers",
      headers: admin,
      payload: { name: "Oficina", cnpj: "11.222.333/0001-81" },
    });
    expect(bom.statusCode).toBe(201);
  });

  it("cliente sem documento continua entrando", async () => {
    const r = await app().inject({
      method: "POST",
      url: "/customers",
      headers: admin,
      payload: { name: "João" },
    });
    expect(r.statusCode).toBe(201);
  });

  it("⭐⭐ o USECASE não endureceu — importador e auto-cliente seguem passando", async () => {
    // A validação mora na ROTA de propósito. O importador de planilhas, o
    // auto-cliente de pedidos e o da NF-e chamam o usecase direto e recebem o
    // documento como o cliente/marketplace mandou. Endurecer aqui transformaria
    // "linha com CPF torto" em "importação que falha".
    const { CustomerUseCase } = await import("../app/usecases/customer.usecase");
    const criado = await new CustomerUseCase().create({
      name: "Importado",
      cpf: "11111111111",
      userId: "user-owner",
    } as any);
    expect(criado).toBeTruthy();
    expect((prisma as any).customer.create).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("⭐ P0.4 — a prateleira tem de ser do mesmo dono", () => {
  const repo = new ScrapRepositoryPrisma();

  it("locationId de OUTRO tenant é recusado na criação", async () => {
    (prisma as any).location.findFirst.mockResolvedValue(null);

    await expect(
      repo.create({
        userId: "user-owner",
        brand: "VW",
        model: "Gol",
        locationId: "loc-de-outro",
      } as any),
    ).rejects.toThrow(/Localização inválida/i);

    expect((prisma as any).scrap.create).not.toHaveBeenCalled();
  });

  it("a checagem é escopada pelo dono da sucata", async () => {
    (prisma as any).location.findFirst.mockResolvedValue({ id: "loc-1" });
    await repo.create({
      userId: "user-owner",
      brand: "VW",
      model: "Gol",
      locationId: "loc-1",
    } as any);

    expect((prisma as any).location.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loc-1", userId: "user-owner" },
      }),
    );
  });

  it("prateleira do PRÓPRIO dono passa", async () => {
    (prisma as any).location.findFirst.mockResolvedValue({ id: "loc-1" });
    await expect(
      repo.create({
        userId: "user-owner",
        brand: "VW",
        model: "Gol",
        locationId: "loc-1",
      } as any),
    ).resolves.toBeTruthy();
  });

  it("sucata SEM localização não paga consulta nenhuma", async () => {
    await repo.create({
      userId: "user-owner",
      brand: "VW",
      model: "Gol",
    } as any);
    expect((prisma as any).location.findFirst).not.toHaveBeenCalled();
  });

  it("o PUT também é guardado", async () => {
    (prisma as any).location.findFirst.mockResolvedValue(null);
    (prisma as any).scrap.findFirst.mockResolvedValue({ id: "s-1" });

    await expect(
      repo.update("s-1", { locationId: "loc-de-outro" } as any, "user-owner"),
    ).rejects.toThrow(/Localização inválida/i);
  });

  it("locationId inválido vira 400 na rota, não 500", async () => {
    (prisma as any).location.findFirst.mockResolvedValue(null);
    const r = await app().inject({
      method: "POST",
      url: "/scraps",
      headers: admin,
      payload: { brand: "VW", model: "Gol", locationId: "loc-de-outro" },
    });
    expect(r.statusCode).toBe(400);
  });
});
