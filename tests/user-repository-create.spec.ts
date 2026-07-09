import { describe, it, expect, vi, afterEach } from "vitest";

import prisma from "@/app/lib/prisma";
import { UserRepositoryPrisma } from "@/app/repositories/user.repository";

const repo = new UserRepositoryPrisma();

const fakeRow = (over: Record<string, unknown> = {}) => ({
  id: "u1",
  email: "a@b.com",
  password: "hash",
  role: "USER",
  parentUserId: null,
  name: null,
  avatarUrl: null,
  defaultProductDescription: null,
  defaultCostPrice: null,
  defaultStock: 0,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe("UserRepositoryPrisma.create — persistência aditiva de role/defaults", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("grava role e defaultStock quando ENVIADOS", async () => {
    const create = vi
      .spyOn(prisma.user, "create")
      .mockResolvedValue(fakeRow({ role: "ADMIN", defaultStock: 5 }) as any);

    await repo.create({
      name: "Admin",
      email: "admin@x.com",
      password: "12345678",
      role: "ADMIN" as any,
      defaultCostPrice: 10,
      defaultStock: 5,
      parentUserId: null,
    });

    const data = (create.mock.calls[0][0] as any).data;
    expect(data.role).toBe("ADMIN");
    expect(data.defaultStock).toBe(5);
    expect(data.defaultCostPrice).toBe(10);
  });

  it("byte-compat: SEM role/defaultStock → chaves ausentes no INSERT (comportamento atual)", async () => {
    const create = vi
      .spyOn(prisma.user, "create")
      .mockResolvedValue(fakeRow() as any);

    // Payload equivalente ao POST /me/team/collaborators atual.
    await repo.create({
      name: "Colab",
      email: "colab@x.com",
      password: "12345678",
      parentUserId: "parent-1",
    });

    const data = (create.mock.calls[0][0] as any).data;
    expect("role" in data).toBe(false);
    expect("defaultStock" in data).toBe(false);
    // parentUserId enviado → presente (spread condicional existente)
    expect(data.parentUserId).toBe("parent-1");
  });

  it("byte-compat: defaultStock:0 ainda é gravado (guarda !== undefined, não truthiness)", async () => {
    const create = vi
      .spyOn(prisma.user, "create")
      .mockResolvedValue(fakeRow() as any);

    await repo.create({
      name: "Zero",
      email: "zero@x.com",
      password: "12345678",
      defaultStock: 0,
    });

    const data = (create.mock.calls[0][0] as any).data;
    expect("defaultStock" in data).toBe(true);
    expect(data.defaultStock).toBe(0);
  });
});
