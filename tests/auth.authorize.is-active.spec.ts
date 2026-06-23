import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Bloqueio do login novo no callback `authorize` do NextAuth.
 *
 * Senha válida + effectiveActive === false => lança ACCOUNT_DISABLED (o form
 * mostra a mensagem específica). Caminhos existentes (senha errada => null,
 * login válido => objeto do usuário) permanecem intactos.
 */

vi.mock("@/app/lib/prisma", () => ({ default: {} }));
vi.mock("../app/lib/prisma", () => ({ default: {} }));

const findByEmailMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());
vi.mock("../app/repositories/user.repository", () => ({
  UserRepositoryPrisma: vi.fn().mockImplementation(() => ({
    findByEmail: findByEmailMock,
    update: updateMock,
  })),
}));

const verifyPasswordMock = vi.hoisted(() => vi.fn());
vi.mock("../app/lib/password", () => ({
  verifyPassword: verifyPasswordMock,
  hashPassword: vi.fn(),
  isHashed: vi.fn(),
}));

vi.mock("../app/lib/api-token", () => ({
  signApiToken: vi.fn(() => "token"),
  extractBearer: vi.fn(),
  verifyApiToken: vi.fn(),
}));

import { authOptions } from "../app/lib/auth";

// NextAuth v4 normaliza um wrapper em `provider.authorize`; o callback async
// original (o nosso) fica em `provider.options.authorize`.
const authorize = (authOptions.providers[0] as any).options.authorize as (
  c: Record<string, string>,
) => Promise<any>;

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    email: "u1@x.com",
    password: "hash",
    name: "U1",
    avatarUrl: null,
    parentUserId: null,
    role: "ADMIN",
    isActive: true,
    effectiveActive: true,
    ...overrides,
  };
}

describe("authorize — bloqueio por effectiveActive", () => {
  beforeEach(() => {
    findByEmailMock.mockReset();
    verifyPasswordMock.mockReset();
    updateMock.mockReset();
  });

  it("senha válida + bloqueado (effectiveActive false) => lança ACCOUNT_DISABLED", async () => {
    findByEmailMock.mockResolvedValueOnce(
      activeUser({ isActive: false, effectiveActive: false }),
    );
    verifyPasswordMock.mockResolvedValueOnce({
      valid: true,
      needsRehash: false,
    });

    await expect(
      authorize({ email: "u1@x.com", password: "pw" }),
    ).rejects.toThrow("ACCOUNT_DISABLED");
  });

  it("colaborador com admin pai bloqueado (effectiveActive false) => lança ACCOUNT_DISABLED", async () => {
    findByEmailMock.mockResolvedValueOnce(
      activeUser({
        id: "collab",
        parentUserId: "admin-1",
        role: "USER",
        isActive: true,
        effectiveActive: false,
      }),
    );
    verifyPasswordMock.mockResolvedValueOnce({
      valid: true,
      needsRehash: false,
    });

    await expect(
      authorize({ email: "u1@x.com", password: "pw" }),
    ).rejects.toThrow("ACCOUNT_DISABLED");
  });

  it("senha válida + ativo => retorna o objeto do usuário (inalterado)", async () => {
    findByEmailMock.mockResolvedValueOnce(activeUser());
    verifyPasswordMock.mockResolvedValueOnce({
      valid: true,
      needsRehash: false,
    });

    const res = await authorize({ email: "u1@x.com", password: "pw" });

    expect(res?.id).toBe("u1");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("senha incorreta => retorna null (comportamento preservado)", async () => {
    findByEmailMock.mockResolvedValueOnce(activeUser());
    verifyPasswordMock.mockResolvedValueOnce({
      valid: false,
      needsRehash: false,
    });

    const res = await authorize({ email: "u1@x.com", password: "wrong" });

    expect(res).toBeNull();
  });
});
