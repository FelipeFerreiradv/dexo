import { describe, it, expect } from "vitest";

import { hasPageAccess } from "@/app/lib/page-access";

const admin = { parentUserId: null, role: "ADMIN" as const };
const superadmin = { parentUserId: null, role: "SUPERADMIN" as const };
const collab = (perms?: Record<string, boolean> | null) => ({
  parentUserId: "admin-1",
  role: "USER" as const,
  pagePermissions: perms ?? null,
});

describe("hasPageAccess", () => {
  it("usuário nulo → false", () => {
    expect(hasPageAccess(null, "produtos")).toBe(false);
    expect(hasPageAccess(undefined, "produtos")).toBe(false);
  });

  it("admin/superadmin (sem parentUserId) → sempre true", () => {
    expect(hasPageAccess(admin, "produtos")).toBe(true);
    expect(hasPageAccess(admin, "financeiro")).toBe(true);
    expect(hasPageAccess(superadmin, "logs")).toBe(true);
    // mesmo com um mapa restritivo, admin ignora
    expect(
      hasPageAccess({ ...admin, pagePermissions: { produtos: false } }, "produtos"),
    ).toBe(true);
  });

  it("colaborador com pagePermissions null/ausente → tudo liberado (zero regressão)", () => {
    expect(hasPageAccess(collab(null), "produtos")).toBe(true);
    expect(hasPageAccess(collab(undefined), "financeiro")).toBe(true);
    expect(hasPageAccess(collab({}), "logs")).toBe(true);
  });

  it("colaborador com pageId=false → bloqueado; demais liberados", () => {
    const c = collab({ financeiro: false });
    expect(hasPageAccess(c, "financeiro")).toBe(false);
    expect(hasPageAccess(c, "produtos")).toBe(true);
    expect(hasPageAccess(c, "mensagens")).toBe(true);
  });

  it("colaborador: pageId=true explícito → liberado", () => {
    expect(hasPageAccess(collab({ produtos: true }), "produtos")).toBe(true);
  });

  it("dashboard é SEMPRE acessível (anti-loop), mesmo se marcado false", () => {
    expect(hasPageAccess(collab({ dashboard: false }), "dashboard")).toBe(true);
  });
});
