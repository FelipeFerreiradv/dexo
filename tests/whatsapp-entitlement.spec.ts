import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import prisma from "@/app/lib/prisma";
import {
  isWhatsappEnabledFor,
  clearWhatsappEntitlementCache,
} from "@/app/marketplaces/whatsapp/whatsapp-entitlement.service";

// ===========================================================================
// Gate por usuário do módulo WhatsApp (flag global && User.whatsappEnabledAt)
// ===========================================================================
describe("isWhatsappEnabledFor — gate flag + plano", () => {
  beforeEach(() => {
    clearWhatsappEntitlementCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("flag global desligada: false SEM consultar o banco", async () => {
    vi.stubEnv("NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED", "");
    const spy = vi.spyOn(prisma.user, "findUnique");

    await expect(isWhatsappEnabledFor("user-1")).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("flag ligada + whatsappEnabledAt preenchido: true", async () => {
    vi.stubEnv("NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED", "true");
    vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
      whatsappEnabledAt: new Date(),
    } as any);

    await expect(isWhatsappEnabledFor("user-1")).resolves.toBe(true);
  });

  it("flag ligada + whatsappEnabledAt NULL (sem plano): false", async () => {
    vi.stubEnv("NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED", "true");
    vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
      whatsappEnabledAt: null,
    } as any);

    await expect(isWhatsappEnabledFor("user-1")).resolves.toBe(false);
  });

  it("usuário inexistente: false (fail-closed)", async () => {
    vi.stubEnv("NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED", "true");
    vi.spyOn(prisma.user, "findUnique").mockResolvedValue(null as any);

    await expect(isWhatsappEnabledFor("user-x")).resolves.toBe(false);
  });

  it("cache de 60s: segunda chamada não re-consulta o banco", async () => {
    vi.stubEnv("NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED", "true");
    const spy = vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
      whatsappEnabledAt: new Date(),
    } as any);

    await isWhatsappEnabledFor("user-1");
    await isWhatsappEnabledFor("user-1");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("clearWhatsappEntitlementCache: força re-consulta", async () => {
    vi.stubEnv("NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED", "true");
    const spy = vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
      whatsappEnabledAt: new Date(),
    } as any);

    await isWhatsappEnabledFor("user-1");
    clearWhatsappEntitlementCache();
    await isWhatsappEnabledFor("user-1");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
