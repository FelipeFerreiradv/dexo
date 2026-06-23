import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Bloqueio de sessões já abertas no authMiddleware.
 *
 * Usuário com effectiveActive === false recebe 403 "Conta desativada" (≠ 401).
 * Bloqueado nunca é cacheado => barrado em toda request. Emails únicos por teste
 * evitam que o cache TTL de 60s do middleware vaze entre testes.
 */

vi.mock("@/app/lib/prisma", () => ({ default: {} }));
vi.mock("../app/lib/prisma", () => ({ default: {} }));

const findByEmailMock = vi.hoisted(() => vi.fn());

vi.mock("../app/repositories/user.repository", () => ({
  UserRepositoryPrisma: vi.fn().mockImplementation(() => ({
    findByEmail: findByEmailMock,
  })),
}));

import { authMiddleware } from "../app/middlewares/auth.middleware";

function makeRequest(headers: Record<string, string> = {}) {
  return { headers, query: {}, user: undefined } as any;
}

function makeReply() {
  const reply: any = {};
  reply.status = vi.fn().mockReturnValue(reply);
  reply.send = vi.fn().mockReturnValue(reply);
  return reply;
}

describe("authMiddleware — bloqueio por effectiveActive", () => {
  beforeEach(() => {
    findByEmailMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("usuário ativo (effectiveActive true) passa normalmente", async () => {
    findByEmailMock.mockResolvedValueOnce({
      id: "u-act-1",
      email: "act-1@x.com",
      parentUserId: null,
      role: "ADMIN",
      isActive: true,
      effectiveActive: true,
    });
    const req = makeRequest({ email: "act-1@x.com" });
    const reply = makeReply();

    await authMiddleware(req, reply);

    expect(reply.status).not.toHaveBeenCalled();
    expect(req.user.id).toBe("u-act-1");
  });

  it("usuário bloqueado (effectiveActive false) recebe 403 Conta desativada", async () => {
    findByEmailMock.mockResolvedValueOnce({
      id: "u-blk-1",
      email: "blk-1@x.com",
      parentUserId: null,
      role: "ADMIN",
      isActive: false,
      effectiveActive: false,
    });
    const reply = makeReply();

    await authMiddleware(makeRequest({ email: "blk-1@x.com" }), reply);

    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Conta desativada" }),
    );
  });

  it("colaborador cujo admin pai está bloqueado (effectiveActive false) recebe 403", async () => {
    findByEmailMock.mockResolvedValueOnce({
      id: "collab-blk",
      email: "collab-blk@x.com",
      parentUserId: "admin-blk",
      role: "USER",
      isActive: true, // o próprio está ativo, mas o pai não
      effectiveActive: false,
    });
    const reply = makeReply();

    await authMiddleware(makeRequest({ email: "collab-blk@x.com" }), reply);

    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it("bloqueado NÃO é cacheado: a 2ª request recarrega do banco e barra de novo", async () => {
    findByEmailMock.mockResolvedValue({
      id: "u-blk-2",
      email: "blk-2@x.com",
      parentUserId: null,
      role: "ADMIN",
      isActive: false,
      effectiveActive: false,
    });
    const r1 = makeReply();
    const r2 = makeReply();

    await authMiddleware(makeRequest({ email: "blk-2@x.com" }), r1);
    await authMiddleware(makeRequest({ email: "blk-2@x.com" }), r2);

    expect(findByEmailMock).toHaveBeenCalledTimes(2);
    expect(r1.status).toHaveBeenCalledWith(403);
    expect(r2.status).toHaveBeenCalledWith(403);
  });
});
