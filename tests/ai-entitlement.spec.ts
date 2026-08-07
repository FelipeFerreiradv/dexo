import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import prisma from "@/app/lib/prisma";
import {
  isAiEnabledFor,
  clearAiEntitlementCache,
} from "@/app/ai/entitlement/ai-entitlement.service";

// ===========================================================================
// Gate por usuário do módulo Bitz (flag global && User.aiEnabledAt)
//
// Espelho fiel de tests/whatsapp-entitlement.spec.ts — o gate do Bitz é uma
// cópia deliberada do gate do WhatsApp, então os invariantes provados são os
// mesmos. Se um dos dois mudar de comportamento, é bug, não evolução.
// ===========================================================================
describe("isAiEnabledFor — gate flag + plano", () => {
  beforeEach(() => {
    clearAiEntitlementCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("flag global desligada: false SEM consultar o banco", async () => {
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "");
    const spy = vi.spyOn(prisma.user, "findUnique");

    await expect(isAiEnabledFor("user-1")).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("flag ligada + aiEnabledAt preenchido: true", async () => {
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
    vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
      aiEnabledAt: new Date(),
    } as any);

    await expect(isAiEnabledFor("user-1")).resolves.toBe(true);
  });

  it("flag ligada + aiEnabledAt NULL (sem plano): false", async () => {
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
    vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
      aiEnabledAt: null,
    } as any);

    await expect(isAiEnabledFor("user-1")).resolves.toBe(false);
  });

  it("usuário inexistente: false (fail-closed)", async () => {
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
    vi.spyOn(prisma.user, "findUnique").mockResolvedValue(null as any);

    await expect(isAiEnabledFor("user-x")).resolves.toBe(false);
  });

  it("dataOwnerId vazio: false SEM consultar o banco", async () => {
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
    const spy = vi.spyOn(prisma.user, "findUnique");

    await expect(isAiEnabledFor("")).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("consulta SEMPRE pelo dataOwnerId recebido (colaborador herda do pai)", async () => {
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
    const spy = vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
      aiEnabledAt: new Date(),
    } as any);

    // O chamador passa request.user.dataOwnerId (= parentUserId do colaborador).
    await isAiEnabledFor("admin-pai-1");

    // O INVARIANTE deste teste é o `where`: a consulta usa o dataOwnerId
    // recebido, e não o id do ator. É o que faz o colaborador herdar do pai.
    //
    // ⚠️ O `select` ganhou `aiDailyLimit` quando o teto por cliente entrou: o
    // serviço passou a devolver acesso E cota, e lê as duas colunas da mesma
    // linha numa consulta só — duas seriam duas idas ao banco por mensagem. A
    // asserção segue exata (e portanto mais específica que antes), de propósito:
    // uma coluna a mais aqui é egress novo em caminho quente e merece ser vista
    // em revisão.
    expect(spy).toHaveBeenCalledWith({
      where: { id: "admin-pai-1" },
      select: { aiEnabledAt: true, aiDailyLimit: true },
    });
  });

  it("cache de 60s: segunda chamada não re-consulta o banco", async () => {
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
    const spy = vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
      aiEnabledAt: new Date(),
    } as any);

    await isAiEnabledFor("user-1");
    await isAiEnabledFor("user-1");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("cache é por tenant: outro dataOwnerId re-consulta", async () => {
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
    const spy = vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
      aiEnabledAt: new Date(),
    } as any);

    await isAiEnabledFor("tenant-a");
    await isAiEnabledFor("tenant-b");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("clearAiEntitlementCache: força re-consulta", async () => {
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
    const spy = vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
      aiEnabledAt: new Date(),
    } as any);

    await isAiEnabledFor("user-1");
    clearAiEntitlementCache();
    await isAiEnabledFor("user-1");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
