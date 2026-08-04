/**
 * Auto-desativação de conta Shopee com autorização morta.
 *
 * O risco desta feature é o INVERSO do bug que ela conserta: `status: ERROR`
 * remove a conta do laço de sync (`sync-orders-and-metrics-loop.ts` filtra por
 * ACTIVE), então um falso positivo pararia a ingestão de um vendedor que está
 * funcionando. Por isso a maior parte destes testes afirma o que NÃO deve
 * desativar.
 *
 * Os dois códigos terminais foram confirmados contra a API de produção em
 * 04/08/2026, sondando as 5 contas Shopee que estavam com token vencido.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.SHOPEE_PARTNER_ID = "2000001";
  process.env.SHOPEE_PARTNER_KEY = "a".repeat(64);
});

import axios from "axios";
import { ShopeeOAuthService } from "@/app/marketplaces/services/shopee-oauth.service";
import prisma from "@/app/lib/prisma";

vi.mock("axios");
const mockedAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

/** Resposta real da Shopee: erro de auth chega como HTTP 403 com corpo. */
function shopeeAuthError(code: string, message: string) {
  return {
    isAxiosError: true,
    message: `Request failed with status code 403`,
    response: { status: 403, data: { error: code, message, request_id: "r-1" } },
  };
}

let updateMany: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // A feature nasce desligada na suíte; cada caso liga explicitamente.
  process.env.SHOPEE_AUTO_DEACTIVATE_DISABLED = "0";
  (mockedAxios as any).post = vi.fn();
  (mockedAxios as any).isAxiosError = (e: any) => !!e && e.isAxiosError === true;
  updateMany = vi.fn();
  updateMany.mockResolvedValue({ count: 1 });
  vi.spyOn(prisma.marketplaceAccount, "updateMany").mockImplementation(
    updateMany as never,
  );
  // O mutex guarda promises por shopId entre testes — sem limpar, o 2º caso
  // com o mesmo shopId reusaria a promise do 1º.
  (ShopeeOAuthService as any).refreshesInFlight?.clear?.();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SHOPEE_AUTO_DEACTIVATE_DISABLED;
});

describe("desativa quando a autorização morreu de vez", () => {
  it("shop_no_linked → marca ERROR (a loja desvinculou o app)", async () => {
    (mockedAxios as any).post.mockRejectedValue(
      shopeeAuthError("shop_no_linked", "Partner and shop has no linked."),
    );

    await expect(
      ShopeeOAuthService.refreshAccessToken("rt", 111),
    ).rejects.toThrow(/renovar token/);

    expect(updateMany).toHaveBeenCalledWith({
      where: { shopId: 111, platform: "SHOPEE", status: "ACTIVE" },
      data: { status: "ERROR" },
    });
  });

  it("refresh_token_expired → marca ERROR", async () => {
    (mockedAxios as any).post.mockRejectedValue(
      shopeeAuthError("refresh_token_expired", "Your refresh_token expired."),
    );
    await expect(
      ShopeeOAuthService.refreshAccessToken("rt", 222),
    ).rejects.toThrow();
    expect(updateMany).toHaveBeenCalledOnce();
  });

  it("preserva o código do parceiro no erro lançado", async () => {
    (mockedAxios as any).post.mockRejectedValue(
      shopeeAuthError("shop_no_linked", "Partner and shop has no linked."),
    );
    const err = await ShopeeOAuthService.refreshAccessToken("rt", 333).catch(
      (e) => e,
    );
    // Sem o código é impossível distinguir "loja desvinculou" de "IP fora da
    // whitelist" olhando só o log.
    expect((err as { shopeeError?: string }).shopeeError).toBe("shop_no_linked");
    expect((err as { status?: number }).status).toBe(403);
  });
});

describe("NÃO desativa — falso positivo pararia um vendedor que funciona", () => {
  const naoTerminais: Array<[string, string]> = [
    ["source_ip_undeclared", "Request Source IP (1.2.3.4) is undeclared."],
    ["error_sign", "wrong sign"],
    ["error_param", "Wrong parameters"],
    ["error_auth", "generic auth problem"],
  ];

  for (const [code, msg] of naoTerminais) {
    it(`${code} → NÃO marca ERROR`, async () => {
      (mockedAxios as any).post.mockRejectedValue(shopeeAuthError(code, msg));
      await expect(
        ShopeeOAuthService.refreshAccessToken("rt", 444),
      ).rejects.toThrow();
      expect(updateMany).not.toHaveBeenCalled();
    });
  }

  it("erro de rede (sem resposta) → NÃO marca ERROR", async () => {
    (mockedAxios as any).post.mockRejectedValue({
      isAxiosError: true,
      code: "ECONNRESET",
      message: "socket hang up",
      response: undefined,
    });
    await expect(
      ShopeeOAuthService.refreshAccessToken("rt", 555),
    ).rejects.toThrow();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("kill-switch ligado → NÃO marca, mesmo em código terminal", async () => {
    process.env.SHOPEE_AUTO_DEACTIVATE_DISABLED = "1";
    (mockedAxios as any).post.mockRejectedValue(
      shopeeAuthError("shop_no_linked", "Partner and shop has no linked."),
    );
    await expect(
      ShopeeOAuthService.refreshAccessToken("rt", 666),
    ).rejects.toThrow();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refresh com SUCESSO não toca no status (caminho feliz intacto)", async () => {
    (mockedAxios as any).post.mockResolvedValue({
      data: {
        access_token: "novo",
        refresh_token: "novo-rt",
        expire_in: 14400,
        shop_id: 777,
      },
    });

    const r = await ShopeeOAuthService.refreshAccessToken("rt", 777);
    expect(r.access_token).toBe("novo");
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("marcar é best-effort", () => {
  it("falha no banco não muda o erro que sobe", async () => {
    vi.spyOn(prisma.marketplaceAccount, "updateMany").mockRejectedValue(
      new Error("banco fora"),
    );
    (mockedAxios as any).post.mockRejectedValue(
      shopeeAuthError("shop_no_linked", "Partner and shop has no linked."),
    );

    // Continua lançando o erro de refresh, não o do banco.
    await expect(
      ShopeeOAuthService.refreshAccessToken("rt", 888),
    ).rejects.toThrow(/renovar token/);
  });
});
