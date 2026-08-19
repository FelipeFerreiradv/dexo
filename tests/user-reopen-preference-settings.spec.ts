import { describe, it, expect, vi, beforeEach } from "vitest";
import fastify from "fastify";

/**
 * Persistência da preferência `User.reopenListingsOnSaleCancel`.
 *
 * Cobre as três allowlists explícitas do caminho — `mapUser`, o spread do
 * `update` e o corpo do PUT — porque em nenhuma delas esquecer o campo gera
 * erro: o toggle simplesmente nasceria sempre ligado e nunca salvaria, sem
 * nada vermelho em lugar nenhum.
 *
 * E cobre a regra de tenant: colaborador VÊ o valor do admin (herança, não
 * cascata) e não consegue gravá-lo.
 */

const findUniqueMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/prisma", () => ({
  default: { user: { findUnique: findUniqueMock, update: updateMock } },
}));
vi.mock("../app/lib/prisma", () => ({
  default: { user: { findUnique: findUniqueMock, update: updateMock } },
}));

import { UserRepositoryPrisma } from "../app/repositories/user.repository";

const repo = new UserRepositoryPrisma();

function rawUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    email: "u1@test.com",
    password: "hash",
    role: "ADMIN",
    parentUserId: null,
    name: "U1",
    avatarUrl: null,
    createdAt: new Date("2020-01-01"),
    updatedAt: new Date("2020-01-01"),
    isActive: true,
    reopenListingsOnSaleCancel: true,
    parent: null,
    ...overrides,
  };
}

describe("mapUser — leitura da preferência", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    updateMock.mockReset();
  });

  it("ligada: raw e efetivo verdadeiros", async () => {
    findUniqueMock.mockResolvedValueOnce(rawUser());
    const u = await repo.findById("u1");
    expect(u?.reopenListingsOnSaleCancel).toBe(true);
    expect(u?.effectiveReopenListingsOnSaleCancel).toBe(true);
  });

  it("desligada: raw e efetivo falsos", async () => {
    findUniqueMock.mockResolvedValueOnce(
      rawUser({ reopenListingsOnSaleCancel: false }),
    );
    const u = await repo.findById("u1");
    expect(u?.reopenListingsOnSaleCancel).toBe(false);
    expect(u?.effectiveReopenListingsOnSaleCancel).toBe(false);
  });

  it("LEGADO — coluna ausente/null vira LIGADO (comportamento de sempre)", async () => {
    findUniqueMock.mockResolvedValueOnce(
      rawUser({ reopenListingsOnSaleCancel: null }),
    );
    const u = await repo.findById("u1");
    expect(u?.reopenListingsOnSaleCancel).toBe(true);
    expect(u?.effectiveReopenListingsOnSaleCancel).toBe(true);
  });

  it("COLABORADOR herda do admin pai — e não é cascata, é herança", async () => {
    // A linha do colaborador diz `true`, o pai diz `false`. O efetivo tem de
    // ser `false`, e não a conjunção — a preferência é do TENANT, e a linha do
    // colaborador nunca governa nada.
    findUniqueMock.mockResolvedValueOnce(
      rawUser({
        parentUserId: "admin-1",
        reopenListingsOnSaleCancel: true,
        parent: { isActive: true, reopenListingsOnSaleCancel: false },
      }),
    );
    const u = await repo.findById("u1");
    expect(u?.reopenListingsOnSaleCancel).toBe(true);
    expect(u?.effectiveReopenListingsOnSaleCancel).toBe(false);
  });

  it("colaborador com admin LIGADO enxerga ligado, mesmo com a própria linha desligada", async () => {
    findUniqueMock.mockResolvedValueOnce(
      rawUser({
        parentUserId: "admin-1",
        reopenListingsOnSaleCancel: false,
        parent: { isActive: true, reopenListingsOnSaleCancel: true },
      }),
    );
    const u = await repo.findById("u1");
    expect(u?.effectiveReopenListingsOnSaleCancel).toBe(true);
  });

  it("findByEmail aplica o mesmo mapeamento", async () => {
    findUniqueMock.mockResolvedValueOnce(
      rawUser({ reopenListingsOnSaleCancel: false }),
    );
    const u = await repo.findByEmail("u1@test.com");
    expect(u?.effectiveReopenListingsOnSaleCancel).toBe(false);
  });
});

describe("update — o campo só é gravado quando vem", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    updateMock.mockReset();
    updateMock.mockResolvedValue(rawUser());
  });

  it("presente: entra no data", async () => {
    await repo.update("u1", { reopenListingsOnSaleCancel: false } as any);
    expect(updateMock.mock.calls[0][0].data).toMatchObject({
      reopenListingsOnSaleCancel: false,
    });
  });

  it("AUSENTE: a chave nem aparece no data (spread condicional)", async () => {
    // Sem isto, salvar outra preferência qualquer sobrescreveria esta com
    // `undefined` — ou pior, com o default do formulário.
    await repo.update("u1", { name: "novo nome" } as any);
    expect(updateMock.mock.calls[0][0].data).not.toHaveProperty(
      "reopenListingsOnSaleCancel",
    );
  });
});

// ── A rota ────────────────────────────────────────────────────────────────
// A rota faz `new UserUseCase()` no corpo do plugin — não há singleton. O mock
// precisa ser a CLASSE, com o método como propriedade de instância apontando
// para um mock estável (mesmo padrão do stub de ProductUseCase em
// tests/stock-deduction-service.spec.ts).
const updateSettingsMock = vi.hoisted(() => vi.fn());
vi.mock("../app/usecases/user.usercase", () => ({
  UserUseCase: class {
    updateSettings = updateSettingsMock;
  },
}));
vi.mock("@/app/usecases/user.usercase", () => ({
  UserUseCase: class {
    updateSettings = updateSettingsMock;
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logUserActivity: vi.fn().mockResolvedValue(undefined),
    logWarning: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@/app/services/system-log.service", () => ({
  SystemLogService: {
    logUserActivity: vi.fn().mockResolvedValue(undefined),
    logWarning: vi.fn().mockResolvedValue(undefined),
  },
}));

// O middleware devolve colaborador quando o header pede.
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    const filho = request.headers["x-collaborator"] === "1";
    request.user = {
      id: filho ? "colab-1" : "admin-1",
      parentUserId: filho ? "admin-1" : null,
      dataOwnerId: "admin-1",
    };
  },
}));
vi.mock("@/app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    const filho = request.headers["x-collaborator"] === "1";
    request.user = {
      id: filho ? "colab-1" : "admin-1",
      parentUserId: filho ? "admin-1" : null,
      dataOwnerId: "admin-1",
    };
  },
}));

import { userRoutes } from "../app/routes/user.routes";

describe("PUT /users/me/settings — quem pode gravar a preferência", () => {
  beforeEach(() => {
    updateSettingsMock.mockReset();
    updateSettingsMock.mockResolvedValue(rawUser());
  });

  async function salvar(corpo: any, colaborador = false) {
    const app = fastify();
    app.register(userRoutes, { prefix: "/users" });
    const res = await app.inject({
      method: "PUT",
      url: "/users/me/settings",
      headers: {
        email: "x@test.com",
        ...(colaborador ? { "x-collaborator": "1" } : {}),
      },
      payload: corpo,
    });
    return { res, body: updateSettingsMock.mock.calls[0]?.[1] };
  }

  it("DONO: o campo chega no usecase", async () => {
    const { res, body } = await salvar({
      defaultFreeShipping: true,
      reopenListingsOnSaleCancel: false,
    });
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ reopenListingsOnSaleCancel: false });
  });

  it("COLABORADOR: o campo é descartado — mas TUDO O MAIS passa", async () => {
    // A segunda metade é a asserção que importa. Bloquear a rota inteira seria
    // a saída óbvia e uma regressão: este mesmo endpoint salva nome, avatar e
    // SENHA. O colaborador não pode perder isso.
    const { res, body } = await salvar(
      {
        defaultFreeShipping: true,
        defaultLocalPickup: false,
        reopenListingsOnSaleCancel: false,
      },
      true,
    );
    expect(res.statusCode).toBe(200);
    expect(body).not.toHaveProperty("reopenListingsOnSaleCancel");
    expect(body).toMatchObject({
      defaultFreeShipping: true,
      defaultLocalPickup: false,
    });
  });

  it("COLABORADOR sem o campo: corpo intocado", async () => {
    const { body } = await salvar({ defaultFreeShipping: true }, true);
    expect(body).toEqual({ defaultFreeShipping: true });
  });
});
