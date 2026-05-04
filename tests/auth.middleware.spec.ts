import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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
  return {
    headers,
    query: {},
    user: undefined,
  } as any;
}

function makeReply() {
  const reply: any = {};
  reply.status = vi.fn().mockReturnValue(reply);
  reply.send = vi.fn().mockReturnValue(reply);
  return reply;
}

describe("authMiddleware — derivação de dataOwnerId", () => {
  beforeEach(() => {
    findByEmailMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Emails únicos por teste evitam que o cache TTL de 60s do middleware esconda
  // a chamada findByEmail entre testes (cache é por email).
  it("admin sem parentUserId: dataOwnerId === id (zero regressão)", async () => {
    findByEmailMock.mockResolvedValueOnce({
      id: "admin-1",
      email: "admin-a@x.com",
      parentUserId: null,
      role: "ADMIN",
    });
    const req = makeRequest({ email: "admin-a@x.com" });

    await authMiddleware(req, makeReply());

    expect(req.user.id).toBe("admin-1");
    expect(req.user.dataOwnerId).toBe("admin-1");
    expect(req.user.parentUserId).toBeNull();
  });

  it("colaborador com parentUserId: dataOwnerId === parentUserId", async () => {
    findByEmailMock.mockResolvedValueOnce({
      id: "collab-9",
      email: "collab-a@x.com",
      parentUserId: "admin-1",
      role: "USER",
    });
    const req = makeRequest({ email: "collab-a@x.com" });

    await authMiddleware(req, makeReply());

    expect(req.user.id).toBe("collab-9");
    expect(req.user.dataOwnerId).toBe("admin-1");
  });

  it("retorna 401 quando email header está ausente", async () => {
    const reply = makeReply();
    await authMiddleware(makeRequest(), reply);
    expect(reply.status).toHaveBeenCalledWith(401);
  });

  it("retorna 401 quando usuário não existe no banco", async () => {
    findByEmailMock.mockResolvedValueOnce(null);
    const reply = makeReply();
    await authMiddleware(makeRequest({ email: "ghost-a@x.com" }), reply);
    expect(reply.status).toHaveBeenCalledWith(401);
  });
});
