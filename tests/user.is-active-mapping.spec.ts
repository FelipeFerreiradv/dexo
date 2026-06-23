import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Mapeamento de isActive/effectiveActive no UserRepository.
 *
 * effectiveActive = (próprio ativo) && (admin pai ativo). Só `false` explícito
 * bloqueia; null/undefined/true => liberado (default-safe). O `parent` chega via
 * include de findById/findByEmail.
 */

// O repositório importa prisma de "../lib/prisma" (resolve p/ app/lib/prisma).
// Mockamos os dois specifiers que resolvem o mesmo módulo absoluto.
const findUniqueMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/prisma", () => ({
  default: { user: { findUnique: findUniqueMock } },
}));
vi.mock("../app/lib/prisma", () => ({
  default: { user: { findUnique: findUniqueMock } },
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
    parent: null,
    ...overrides,
  };
}

describe("UserRepository — mapeamento de isActive/effectiveActive", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
  });

  it("ativo sem pai: isActive=true, effectiveActive=true", async () => {
    findUniqueMock.mockResolvedValueOnce(rawUser({ isActive: true }));
    const u = await repo.findById("u1");
    expect(u?.isActive).toBe(true);
    expect(u?.effectiveActive).toBe(true);
  });

  it("bloqueado sem pai: isActive=false, effectiveActive=false", async () => {
    findUniqueMock.mockResolvedValueOnce(rawUser({ isActive: false }));
    const u = await repo.findById("u1");
    expect(u?.isActive).toBe(false);
    expect(u?.effectiveActive).toBe(false);
  });

  it("ativo mas admin pai bloqueado: effectiveActive=false (cascata)", async () => {
    findUniqueMock.mockResolvedValueOnce(
      rawUser({
        isActive: true,
        parentUserId: "admin-1",
        parent: { isActive: false },
      }),
    );
    const u = await repo.findById("u1");
    expect(u?.isActive).toBe(true);
    expect(u?.effectiveActive).toBe(false);
  });

  it("ativo + admin pai ativo: effectiveActive=true", async () => {
    findUniqueMock.mockResolvedValueOnce(
      rawUser({
        isActive: true,
        parentUserId: "admin-1",
        parent: { isActive: true },
      }),
    );
    const u = await repo.findById("u1");
    expect(u?.effectiveActive).toBe(true);
  });

  it("isActive null (legado): tratado como liberado (default-safe)", async () => {
    findUniqueMock.mockResolvedValueOnce(rawUser({ isActive: null }));
    const u = await repo.findById("u1");
    expect(u?.isActive).toBe(true);
    expect(u?.effectiveActive).toBe(true);
  });

  it("findByEmail aplica o mesmo mapeamento", async () => {
    findUniqueMock.mockResolvedValueOnce(rawUser({ isActive: false }));
    const u = await repo.findByEmail("u1@test.com");
    expect(u?.effectiveActive).toBe(false);
  });
});
