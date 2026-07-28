import { describe, it, expect, vi, beforeEach } from "vitest";

// ──────────────────────────────────────────────────────────
// Bloco D — gate de API. Sem ele o bloqueio seria cosmético: esconder o item no
// menu e barrar o Server Component não impede um GET direto em
// /dashboard/account-stats ou /dashboard/report.pdf.
// ──────────────────────────────────────────────────────────

vi.mock("../app/lib/prisma", () => ({
  default: { user: { findUnique: vi.fn() } },
}));

import prisma from "../app/lib/prisma";
import { requirePageAccess } from "../app/middlewares/require-page-access.middleware";

function makeReply() {
  const reply: any = {
    statusCode: null as number | null,
    body: null as any,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(body: any) {
      reply.body = body;
      return reply;
    },
  };
  return reply;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requirePageAccess", () => {
  it("admin passa direto, sem nenhuma query", async () => {
    const reply = makeReply();
    await requirePageAccess("dashboard")(
      { user: { id: "u1", parentUserId: null } } as any,
      reply,
    );
    expect(reply.statusCode).toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("colaborador sem pagePermissions gravado passa (zero regressão)", async () => {
    const reply = makeReply();
    await requirePageAccess("dashboard")(
      { user: { id: "u2", parentUserId: "admin-1", pagePermissions: null } } as any,
      reply,
    );
    expect(reply.statusCode).toBeNull();
  });

  it("colaborador com mapa legado (sem a chave dashboard) passa", async () => {
    const reply = makeReply();
    await requirePageAccess("dashboard")(
      {
        user: {
          id: "u3",
          parentUserId: "admin-1",
          pagePermissions: { financeiro: false },
        },
      } as any,
      reply,
    );
    expect(reply.statusCode).toBeNull();
  });

  it("colaborador com dashboard=false recebe 403 PAGE_FORBIDDEN", async () => {
    const reply = makeReply();
    await requirePageAccess("dashboard")(
      {
        user: {
          id: "u4",
          parentUserId: "admin-1",
          pagePermissions: { dashboard: false },
        },
      } as any,
      reply,
    );
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toMatchObject({
      code: "PAGE_FORBIDDEN",
      pageId: "dashboard",
    });
  });

  it("sem request.user não responde nada (401 é papel do authMiddleware)", async () => {
    const reply = makeReply();
    await requirePageAccess("dashboard")({} as any, reply);
    expect(reply.statusCode).toBeNull();
  });

  it("com { fresh: true } lê do banco e bloqueia pelo valor novo", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      parentUserId: "admin-1",
      role: "USER",
      pagePermissions: { dashboard: false },
    } as any);
    const reply = makeReply();
    await requirePageAccess("dashboard", { fresh: true })(
      {
        user: {
          id: "u5",
          parentUserId: "admin-1",
          // Cache do authMiddleware ainda diz liberado.
          pagePermissions: {},
        },
      } as any,
      reply,
    );
    expect(prisma.user.findUnique).toHaveBeenCalled();
    expect(reply.statusCode).toBe(403);
  });

  it("falha na leitura fresca não abre nem fecha por acidente", async () => {
    vi.mocked(prisma.user.findUnique).mockRejectedValue(new Error("db down"));
    const reply = makeReply();
    await requirePageAccess("dashboard", { fresh: true })(
      {
        user: {
          id: "u6",
          parentUserId: "admin-1",
          pagePermissions: { dashboard: false },
        },
      } as any,
      reply,
    );
    // Segue com o que o authMiddleware tinha — que aqui já bloqueava.
    expect(reply.statusCode).toBe(403);
  });
});
