import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

// ──────────────────────────────────────────────────────────
// IDENTIDADE DA CONTA OLX.
//
// A OLX derrubou POST /oauth_api/basic_user_info (404 do nginx de origem em
// apps.olx.com.br, 12/08/2026), que era a ÚNICA fonte de identidade da conta.
// Sem identidade o callback recusava a conexão — de propósito, porque um
// externalUserId derivado do userId do Dexo anularia a trava cross-tenant.
//
// A saída foi uma segunda fonte: o e-mail que o vendedor declara ao conectar,
// carregado pelo `state` (o callback é redirect de navegador, não tem corpo).
//
// O que este spec trava:
//   1. a OLX continua tendo PRECEDÊNCIA quando responde;
//   2. o e-mail declarado só entra quando a OLX não responde;
//   3. a trava cross-tenant continua valendo com o e-mail declarado;
//   4. sem nenhuma das duas fontes, a conexão continua sendo RECUSADA;
//   5. a chave é normalizada — senão "Loja@x" e "loja@x" viram duas contas e a
//      trava do item 3 deixaria de enxergar a colisão real.
// ──────────────────────────────────────────────────────────

import { MarketplaceUseCase } from "@/app/marketplaces/usecases/marketplace.usercase";
import { OlxOAuthService } from "@/app/marketplaces/services/olx-oauth.service";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";

const USER_ID = "user-1";
const OUTRO_USER = "user-2";
const EMAIL = "loja@exemplo.com.br";

// `generateAuthUrl` chama validateOlxConfig(), que exige as credenciais. Sem
// isto o spec só passaria em máquina com o `.env` real da OLX — `??=` para não
// atropelar quem já as tiver.
process.env.OLX_CLIENT_ID ??= "test-client-id";
process.env.OLX_CLIENT_SECRET ??= "test-client-secret";

/** Prepara um `state` real, como o POST /olx/auth faria. */
function abrirFluxo(accountEmail?: string): string {
  const { state } = OlxOAuthService.generateAuthUrl(USER_ID, accountEmail);
  return state;
}

function mockarTroca() {
  vi.spyOn(OlxOAuthService, "exchangeCodeForTokens").mockResolvedValue({
    accessToken: "token-olx",
  });
}

/** Repositório sem conta existente e sem conflito. */
function mockarRepoLimpo() {
  vi.spyOn(MarketplaceRepository, "findAllByExternalUserId").mockResolvedValue(
    [] as any,
  );
  vi.spyOn(
    MarketplaceRepository,
    "findByUserAndExternalUserId",
  ).mockResolvedValue(null as any);
  return vi
    .spyOn(MarketplaceRepository, "createAccount")
    .mockImplementation(async (data: any) => ({ id: "acc-1", ...data }) as any);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validação do e-mail declarado", () => {
  it("aceita e-mail bem formado e recusa o resto", () => {
    expect(OlxOAuthService.isValidAccountEmail("loja@exemplo.com.br")).toBe(
      true,
    );
    expect(OlxOAuthService.isValidAccountEmail("  loja@exemplo.com  ")).toBe(
      true,
    );

    expect(OlxOAuthService.isValidAccountEmail(undefined)).toBe(false);
    expect(OlxOAuthService.isValidAccountEmail("")).toBe(false);
    expect(OlxOAuthService.isValidAccountEmail("   ")).toBe(false);
    expect(OlxOAuthService.isValidAccountEmail("loja")).toBe(false);
    expect(OlxOAuthService.isValidAccountEmail("loja@exemplo")).toBe(false);
    expect(OlxOAuthService.isValidAccountEmail("loja @exemplo.com")).toBe(
      false,
    );
  });

  it("normaliza para caixa baixa e sem espaços", () => {
    expect(OlxOAuthService.normalizeAccountEmail("  Loja@Exemplo.COM  ")).toBe(
      "loja@exemplo.com",
    );
    expect(OlxOAuthService.normalizeAccountEmail(null)).toBe("");
  });
});

describe("o state carrega a identidade declarada", () => {
  it("devolve o e-mail normalizado na validação", () => {
    const state = abrirFluxo("  Loja@Exemplo.COM.BR ");
    const validacao = OlxOAuthService.validateState(state);

    expect(validacao.valid).toBe(true);
    expect(validacao.userId).toBe(USER_ID);
    expect(validacao.accountEmail).toBe(EMAIL);
  });

  it("continua de uso único", () => {
    const state = abrirFluxo(EMAIL);

    expect(OlxOAuthService.validateState(state).valid).toBe(true);
    expect(OlxOAuthService.validateState(state).valid).toBe(false);
  });

  it("não inventa e-mail quando nada foi declarado", () => {
    const state = abrirFluxo();
    expect(OlxOAuthService.validateState(state).accountEmail).toBeUndefined();
  });
});

describe("handleOlxOAuthCallback — de onde vem o externalUserId", () => {
  it("usa o e-mail declarado quando a OLX não responde", async () => {
    const state = abrirFluxo(EMAIL);
    mockarTroca();
    vi.spyOn(OlxOAuthService, "fetchBasicUserInfo").mockRejectedValue(
      new Error("Request failed with status code 404"),
    );
    const createAccount = mockarRepoLimpo();

    await MarketplaceUseCase.handleOlxOAuthCallback({
      code: "code-1",
      state,
      userId: USER_ID,
    });

    expect(createAccount).toHaveBeenCalledTimes(1);
    const salvo = createAccount.mock.calls[0][0] as any;
    expect(salvo.externalUserId).toBe(EMAIL);
    expect(salvo.platform).toBe(Platform.OLX);
    // A identidade NUNCA pode ser ancorada no userId do Dexo: isso daria uma
    // chave distinta por tenant e a trava cross-tenant viraria letra morta.
    expect(salvo.externalUserId).not.toContain(USER_ID);
  });

  it("a OLX tem precedência sobre o declarado quando responde", async () => {
    const state = abrirFluxo(EMAIL);
    mockarTroca();
    vi.spyOn(OlxOAuthService, "fetchBasicUserInfo").mockResolvedValue({
      user_name: "Loja Oficial",
      user_email: "Oficial@OLX.com.br",
    } as any);
    const createAccount = mockarRepoLimpo();

    await MarketplaceUseCase.handleOlxOAuthCallback({
      code: "code-1",
      state,
      userId: USER_ID,
    });

    const salvo = createAccount.mock.calls[0][0] as any;
    expect(salvo.externalUserId).toBe("oficial@olx.com.br");
    expect(salvo.accountName).toBe("OLX Loja Oficial");
  });

  it("recusa a conexão quando não há nenhuma das duas fontes", async () => {
    const state = abrirFluxo();
    mockarTroca();
    vi.spyOn(OlxOAuthService, "fetchBasicUserInfo").mockRejectedValue(
      new Error("Request failed with status code 404"),
    );
    const createAccount = mockarRepoLimpo();

    await expect(
      MarketplaceUseCase.handleOlxOAuthCallback({
        code: "code-1",
        state,
        userId: USER_ID,
      }),
    ).rejects.toThrow(/não foi possível identificar a conta da olx/i);

    expect(createAccount).not.toHaveBeenCalled();
  });

  it("a trava cross-tenant continua valendo com o e-mail declarado", async () => {
    const state = abrirFluxo(EMAIL);
    mockarTroca();
    vi.spyOn(OlxOAuthService, "fetchBasicUserInfo").mockRejectedValue(
      new Error("Request failed with status code 404"),
    );
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([{ id: "acc-outro", userId: OUTRO_USER }] as any);
    const createAccount = vi
      .spyOn(MarketplaceRepository, "createAccount")
      .mockResolvedValue({ id: "acc-1" } as any);

    await expect(
      MarketplaceUseCase.handleOlxOAuthCallback({
        code: "code-1",
        state,
        userId: USER_ID,
      }),
    ).rejects.toThrow(/já está vinculada a outro usuário/i);

    expect(createAccount).not.toHaveBeenCalled();
    // A busca por conflito tem que usar a chave normalizada, senão a colisão
    // real escapa por diferença de caixa.
    expect(MarketplaceRepository.findAllByExternalUserId).toHaveBeenCalledWith(
      EMAIL,
      Platform.OLX,
    );
  });

  it("reconectar a mesma conta atualiza a linha existente, não duplica", async () => {
    const state = abrirFluxo(EMAIL);
    mockarTroca();
    vi.spyOn(OlxOAuthService, "fetchBasicUserInfo").mockRejectedValue(
      new Error("Request failed with status code 404"),
    );
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([] as any);
    vi.spyOn(
      MarketplaceRepository,
      "findByUserAndExternalUserId",
    ).mockResolvedValue({ id: "acc-1", status: "ACTIVE" } as any);
    const updateTokens = vi
      .spyOn(MarketplaceRepository, "updateTokens")
      .mockResolvedValue({ id: "acc-1", status: "ACTIVE" } as any);
    const createAccount = vi
      .spyOn(MarketplaceRepository, "createAccount")
      .mockResolvedValue({ id: "acc-9" } as any);

    await MarketplaceUseCase.handleOlxOAuthCallback({
      code: "code-1",
      state,
      userId: USER_ID,
    });

    expect(updateTokens).toHaveBeenCalledTimes(1);
    expect(createAccount).not.toHaveBeenCalled();
  });
});
