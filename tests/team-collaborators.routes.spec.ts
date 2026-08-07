import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";

// Prisma nunca é tocado por estas rotas (usecase + repo mockados), mas
// team.routes importa o client no topo — mock mínimo p/ evitar conexão real.
const mockPrisma = vi.hoisted(() => ({
  systemLog: {
    groupBy: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
  },
}));
vi.mock("../app/lib/prisma", () => ({ default: mockPrisma }));
vi.mock("@/app/lib/prisma", () => ({ default: mockPrisma }));

// Repositório compartilhado entre a instância da rota e a interna do UserUseCase
// (o mock de construtor devolve sempre as MESMAS fns hoisted).
const findChildrenMock = vi.hoisted(() => vi.fn());
const findChildrenPublicMock = vi.hoisted(() => vi.fn());
const findByIdMock = vi.hoisted(() => vi.fn());
const findByEmailMock = vi.hoisted(() => vi.fn());
const createMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());
// ⭐ Caminho ESTREITO de controle de acesso (isActive / pagePermissions).
// Separado de `update` de propósito no código de produção: `update` recebe
// `UserUpdate`, que é o corpo cru das rotas de autoatendimento, e enquanto
// esses campos moravam lá um colaborador se auto-liberava as páginas com um
// PUT. Ver tests/security/user-settings-mass-assignment.spec.ts.
const updateAccessControlMock = vi.hoisted(() => vi.fn());
vi.mock("../app/repositories/user.repository", () => ({
  UserRepositoryPrisma: vi.fn().mockImplementation(() => ({
    findChildren: findChildrenMock,
    findChildrenPublic: findChildrenPublicMock,
    findById: findByIdMock,
    findByEmail: findByEmailMock,
    create: createMock,
    update: updateMock,
    updateAccessControl: updateAccessControlMock,
  })),
}));

// Log de auditoria não deve escrever no banco durante o teste.
const logUserActivityMock = vi.hoisted(() => vi.fn());
vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: { logUserActivity: logUserActivityMock },
}));

// authMiddleware permissivo: anexa request.user a partir do header `x-test-user`.
// blockCollaborator é o REAL (testa admin-only de verdade).
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (req: any) => {
    const raw = req.headers["x-test-user"];
    if (raw) req.user = JSON.parse(raw);
  },
}));

import { teamRoutes } from "../app/routes/team.routes";

function buildApp() {
  const app = fastify();
  app.register(teamRoutes, { prefix: "/me/team" });
  return app;
}

function asUser(user: any) {
  return { "x-test-user": JSON.stringify(user) };
}

const ADMIN = { id: "admin-1", parentUserId: null };
const COLLAB = { id: "c1", parentUserId: "admin-1" };

function fullUser(over: Record<string, any> = {}) {
  return {
    id: "c9",
    email: "c9@x.com",
    name: "C9",
    password: "hashed-secret",
    parentUserId: "admin-1",
    avatarUrl: null,
    isActive: true,
    effectiveActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe("team collaborators routes", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
    findChildrenMock.mockReset();
    findChildrenPublicMock.mockReset();
    findByIdMock.mockReset();
    findByEmailMock.mockReset();
    createMock.mockReset();
    updateMock.mockReset();
    updateAccessControlMock.mockReset();
    logUserActivityMock.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe("GET /me/team/collaborators", () => {
    it("admin recebe filhos com isActive (projeção enxuta)", async () => {
      // findChildrenPublic devolve a projeção lean (sem senha nem default*).
      findChildrenPublicMock.mockResolvedValue([
        {
          id: "c1",
          email: "c1@x.com",
          name: "C1",
          avatarUrl: null,
          parentUserId: "admin-1",
          isActive: true,
          createdAt: new Date(),
        },
        {
          id: "c2",
          email: "c2@x.com",
          name: "C2",
          avatarUrl: null,
          parentUserId: "admin-1",
          isActive: false,
          createdAt: new Date(),
        },
      ]);

      const res = await app.inject({
        method: "GET",
        url: "/me/team/collaborators",
        headers: asUser(ADMIN),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.collaborators).toHaveLength(2);
      expect(body.collaborators[0]).toMatchObject({ id: "c1", isActive: true });
      expect(body.collaborators[1]).toMatchObject({ id: "c2", isActive: false });
      // Nunca vaza senha.
      expect(body.collaborators[0].password).toBeUndefined();
      expect(findChildrenPublicMock).toHaveBeenCalledWith("admin-1");
    });

    it("colaborador recebe 403 (blockCollaborator)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/me/team/collaborators",
        headers: asUser(COLLAB),
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).code).toBe("COLLABORATOR_FORBIDDEN");
      expect(findChildrenPublicMock).not.toHaveBeenCalled();
    });
  });

  describe("POST /me/team/collaborators", () => {
    it("cria com parentUserId FORÇADO = admin.id, ignorando o body", async () => {
      findByEmailMock.mockResolvedValue(null);
      createMock.mockResolvedValue(fullUser({ id: "new-1" }));

      const res = await app.inject({
        method: "POST",
        url: "/me/team/collaborators",
        headers: asUser(ADMIN),
        payload: {
          name: "Novo",
          email: "novo@x.com",
          password: "12345678",
          // Tentativa de injeção — deve ser ignorada.
          parentUserId: "outro-admin",
          role: "ADMIN",
          id: "forjado",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.password).toBeUndefined();
      // O usecase recebeu o vínculo do servidor, não do cliente.
      const arg = createMock.mock.calls[0][0];
      expect(arg.parentUserId).toBe("admin-1");
      expect(arg.email).toBe("novo@x.com");
      expect(logUserActivityMock).toHaveBeenCalled();
    });

    it("colaborador não pode criar sub-colaborador (403)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/me/team/collaborators",
        headers: asUser(COLLAB),
        payload: { name: "X", email: "x@x.com", password: "12345678" },
      });
      expect(res.statusCode).toBe(403);
      expect(createMock).not.toHaveBeenCalled();
    });

    it("valida nome, e-mail e senha (400)", async () => {
      const base = { name: "Ok", email: "ok@x.com", password: "12345678" };
      const cases = [
        { ...base, name: "   " },
        { ...base, email: "invalido" },
        { ...base, password: "1234567" },
      ];
      for (const payload of cases) {
        const res = await app.inject({
          method: "POST",
          url: "/me/team/collaborators",
          headers: asUser(ADMIN),
          payload,
        });
        expect(res.statusCode).toBe(400);
      }
      expect(createMock).not.toHaveBeenCalled();
    });

    it("e-mail duplicado → 409", async () => {
      findByEmailMock.mockResolvedValue(fullUser());

      const res = await app.inject({
        method: "POST",
        url: "/me/team/collaborators",
        headers: asUser(ADMIN),
        payload: { name: "Dup", email: "dup@x.com", password: "12345678" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).message).toContain("e-mail");
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /me/team/collaborators/:id", () => {
    it("edita nome de colaborador do próprio admin", async () => {
      findByIdMock.mockResolvedValue(fullUser({ id: "c1" }));
      updateMock.mockResolvedValue(fullUser({ id: "c1", name: "Renomeado" }));

      const res = await app.inject({
        method: "PATCH",
        url: "/me/team/collaborators/c1",
        headers: asUser(ADMIN),
        payload: { name: "Renomeado" },
      });

      expect(res.statusCode).toBe(200);
      const [id, patch] = updateMock.mock.calls[0];
      expect(id).toBe("c1");
      expect(patch).toEqual({ name: "Renomeado" });
      // Nunca toca parentUserId/role.
      expect(patch.parentUserId).toBeUndefined();
      expect(patch.role).toBeUndefined();
      expect(JSON.parse(res.payload).password).toBeUndefined();
    });

    it("⭐ permissões de página vão pelo caminho privilegiado, não pelo largo", async () => {
      // O admin PODE editar as permissões do próprio colaborador — este teste
      // existe para essa capacidade não se perder. E ela passa por
      // `updateAccessControl`: o caminho largo (`update`) recebe `UserUpdate`,
      // que é o corpo cru das rotas de autoatendimento, e enquanto
      // `pagePermissions` morava lá um colaborador se auto-liberava com um PUT.
      // Ver tests/security/user-settings-mass-assignment.spec.ts.
      findByIdMock.mockResolvedValue(fullUser({ id: "c1" }));
      updateMock.mockResolvedValue(fullUser({ id: "c1" }));
      updateAccessControlMock.mockResolvedValue(
        fullUser({ id: "c1", pagePermissions: { financeiro: false } }),
      );

      const res = await app.inject({
        method: "PATCH",
        url: "/me/team/collaborators/c1",
        headers: asUser(ADMIN),
        payload: { pagePermissions: { financeiro: false } },
      });

      expect(res.statusCode).toBe(200);
      expect(updateAccessControlMock).toHaveBeenCalledWith("c1", {
        pagePermissions: { financeiro: false },
      });
      // E o patch largo não recebeu as permissões.
      const [, patchLargo] = updateMock.mock.calls[0] ?? [null, {}];
      expect(patchLargo.pagePermissions).toBeUndefined();
    });

    it("alvo inexistente → 404", async () => {
      findByIdMock.mockResolvedValue(null);
      const res = await app.inject({
        method: "PATCH",
        url: "/me/team/collaborators/ghost",
        headers: asUser(ADMIN),
        payload: { name: "X" },
      });
      expect(res.statusCode).toBe(404);
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("colaborador de OUTRO admin → 403 (sem IDOR)", async () => {
      findByIdMock.mockResolvedValue(
        fullUser({ id: "outro", parentUserId: "admin-2" }),
      );
      const res = await app.inject({
        method: "PATCH",
        url: "/me/team/collaborators/outro",
        headers: asUser(ADMIN),
        payload: { name: "X" },
      });
      expect(res.statusCode).toBe(403);
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("não permite editar a si mesmo por aqui → 403", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/me/team/collaborators/admin-1",
        headers: asUser(ADMIN),
        payload: { name: "Eu" },
      });
      expect(res.statusCode).toBe(403);
      expect(findByIdMock).not.toHaveBeenCalled();
    });

    it("senha curta → 400", async () => {
      findByIdMock.mockResolvedValue(fullUser({ id: "c1" }));
      const res = await app.inject({
        method: "PATCH",
        url: "/me/team/collaborators/c1",
        headers: asUser(ADMIN),
        payload: { password: "123" },
      });
      expect(res.statusCode).toBe(400);
      expect(updateMock).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /me/team/collaborators/:id/status", () => {
    it("desativa colaborador do próprio admin", async () => {
      findByIdMock.mockResolvedValue(fullUser({ id: "c1" }));
      updateAccessControlMock.mockResolvedValue(
        fullUser({ id: "c1", isActive: false }),
      );

      const res = await app.inject({
        method: "PATCH",
        url: "/me/team/collaborators/c1/status",
        headers: asUser(ADMIN),
        payload: { isActive: false },
      });

      expect(res.statusCode).toBe(200);
      // A asserção ficou MAIS específica, não mais frouxa: além de provar que a
      // rota grava `isActive: false` em c1, ela agora prova que isso passa pelo
      // caminho privilegiado — e que o caminho largo NÃO é usado para isto.
      expect(updateAccessControlMock).toHaveBeenCalledWith("c1", {
        isActive: false,
      });
      expect(updateMock).not.toHaveBeenCalled();
      expect(JSON.parse(res.payload).isActive).toBe(false);
    });

    it("não permite auto-desativação → 403", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/me/team/collaborators/admin-1/status",
        headers: asUser(ADMIN),
        payload: { isActive: false },
      });
      expect(res.statusCode).toBe(403);
      // ⚠️ O guarda tem que olhar o metodo que a rota REALMENTE usa. Depois
      // que o status passou por `updateAccessControl`, asserir sobre
      // `updateMock` aqui seria vacuamente verdadeiro — o teste passaria
      // mesmo se a rota gravasse por cima do 403.
      expect(updateAccessControlMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("colaborador de outro admin → 403", async () => {
      findByIdMock.mockResolvedValue(
        fullUser({ id: "outro", parentUserId: "admin-2" }),
      );
      const res = await app.inject({
        method: "PATCH",
        url: "/me/team/collaborators/outro/status",
        headers: asUser(ADMIN),
        payload: { isActive: false },
      });
      expect(res.statusCode).toBe(403);
      // ⚠️ O guarda tem que olhar o metodo que a rota REALMENTE usa. Depois
      // que o status passou por `updateAccessControl`, asserir sobre
      // `updateMock` aqui seria vacuamente verdadeiro — o teste passaria
      // mesmo se a rota gravasse por cima do 403.
      expect(updateAccessControlMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("isActive ausente/!boolean → 400", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/me/team/collaborators/c1/status",
        headers: asUser(ADMIN),
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      // ⚠️ O guarda tem que olhar o metodo que a rota REALMENTE usa. Depois
      // que o status passou por `updateAccessControl`, asserir sobre
      // `updateMock` aqui seria vacuamente verdadeiro — o teste passaria
      // mesmo se a rota gravasse por cima do 403.
      expect(updateAccessControlMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
    });
  });
});
