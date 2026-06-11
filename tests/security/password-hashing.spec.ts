import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * PR-A1 — Hashing de senha (bcryptjs) + rehash transparente no login.
 */

const legacyUser = {
  id: "u1",
  email: "u@test.com",
  password: "legacy-plain", // texto plano legado
  role: "ADMIN",
  parentUserId: null as string | null,
  name: "U",
  createdAt: new Date("2020-01-01"),
  updatedAt: new Date("2020-01-01"),
};

vi.mock("@/app/lib/prisma", () => ({
  default: {
    user: {
      findUnique: vi.fn(() => Promise.resolve(legacyUser)),
      update: vi.fn(({ data }: { data: any }) =>
        Promise.resolve({ ...legacyUser, ...data }),
      ),
      create: vi.fn(({ data }: { data: any }) =>
        Promise.resolve({ ...legacyUser, ...data }),
      ),
    },
  },
}));

import prisma from "@/app/lib/prisma";
import { hashPassword, isHashed, verifyPassword } from "../../app/lib/password";
import { UserUseCase } from "../../app/usecases/user.usercase";

describe("PR-A1: helper de senha", () => {
  it("hashPassword gera hash bcrypt detectável (≠ texto plano)", async () => {
    const h = await hashPassword("secret");
    expect(isHashed(h)).toBe(true);
    expect(h).not.toBe("secret");
  });

  it("verifyPassword valida hash correto e rejeita errado (sem rehash)", async () => {
    const h = await hashPassword("secret");
    expect(await verifyPassword("secret", h)).toEqual({
      valid: true,
      needsRehash: false,
    });
    expect(await verifyPassword("wrong", h)).toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it("verifyPassword: legado texto plano que bate sinaliza needsRehash", async () => {
    expect(await verifyPassword("plain", "plain")).toEqual({
      valid: true,
      needsRehash: true,
    });
    expect(await verifyPassword("plain", "outro")).toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it("isHashed reconhece prefixos bcrypt e rejeita texto plano", () => {
    expect(isHashed("$2b$12$abcdefghijklmnopqrstuv")).toBe(true);
    expect(isHashed("$2a$10$abcdefghijklmnopqrstuv")).toBe(true);
    expect(isHashed("senha123")).toBe(false);
    expect(isHashed(null)).toBe(false);
  });
});

describe("PR-A1: rehash transparente no login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("login com senha legada em texto plano → sucesso + regrava como hash", async () => {
    const uc = new UserUseCase();
    const user = await uc.login({
      email: "u@test.com",
      password: "legacy-plain",
    } as any);

    expect(user.id).toBe("u1");
    const updateCalls = (prisma as any).user.update.mock.calls;
    expect(updateCalls.length).toBe(1);
    // O repositório hasheia antes de persistir → o valor gravado é um hash.
    expect(isHashed(updateCalls[0][0].data.password)).toBe(true);
  });

  it("login com senha errada → lança e NÃO regrava", async () => {
    const uc = new UserUseCase();
    await expect(
      uc.login({ email: "u@test.com", password: "errada" } as any),
    ).rejects.toThrow(/Invalid password/);
    expect((prisma as any).user.update.mock.calls.length).toBe(0);
  });
});
