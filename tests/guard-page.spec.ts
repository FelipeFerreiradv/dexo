import { describe, it, expect, vi, beforeEach } from "vitest";

// ──────────────────────────────────────────────────────────
// Bloco D — o redirect do guard não pode entrar em loop.
//
// Este arquivo codifica a prova: todo redirect emitido aponta para uma página
// que, com o MESMO estado de permissões, não redireciona de volta — ou para a
// rota neutra, que é terminal por construção.
// ──────────────────────────────────────────────────────────

class RedirectError extends Error {
  constructor(public destino: string) {
    super(`REDIRECT:${destino}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    // O `redirect` real do Next lança para interromper o render; o mock
    // reproduz isso para que o código depois dele não execute.
    throw new RedirectError(destino);
  },
}));

vi.mock("@/app/lib/prisma", () => ({
  default: { user: { findUnique: vi.fn() } },
}));

import prisma from "@/app/lib/prisma";
import { assertPageAccess } from "@/app/lib/guard-page";
import {
  PAGE_DEFS,
  NO_ACCESS_HREF,
  hasPageAccess,
  pageHref,
  type PageId,
} from "@/app/lib/page-access";

function sessionDe(parentUserId: string | null) {
  return { user: { id: "u-1", parentUserId, role: "USER" } } as any;
}

/** Executa o guard e devolve o destino do redirect (ou null se passou). */
async function capturaRedirect(
  session: any,
  pageId: PageId,
): Promise<string | null> {
  try {
    await assertPageAccess(session, pageId);
    return null;
  } catch (err) {
    if (err instanceof RedirectError) return err.destino;
    throw err;
  }
}

function mockPerms(perms: Record<string, boolean> | null) {
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    parentUserId: "admin-1",
    role: "USER",
    pagePermissions: perms,
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  // As páginas com feature flag precisam existir para os cenários abaixo.
  process.env.NEXT_PUBLIC_PDV_ENABLED = "true";
  process.env.NEXT_PUBLIC_MAGALU_INTEGRATION_ENABLED = "true";
  process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED = "true";
});

describe("assertPageAccess", () => {
  it("admin passa sem redirect E sem query (preserva a otimização)", async () => {
    const destino = await capturaRedirect(sessionDe(null), "dashboard");
    expect(destino).toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("colaborador com a página liberada passa", async () => {
    mockPerms({ financeiro: false });
    expect(await capturaRedirect(sessionDe("admin-1"), "dashboard")).toBeNull();
  });

  it("Dashboard bloqueado redireciona para a primeira página liberada", async () => {
    mockPerms({ dashboard: false });
    expect(await capturaRedirect(sessionDe("admin-1"), "dashboard")).toBe(
      "/produtos",
    );
  });

  it("nunca redireciona para a própria página bloqueada", async () => {
    mockPerms({ dashboard: false, produtos: false });
    const destino = await capturaRedirect(sessionDe("admin-1"), "produtos");
    expect(destino).not.toBe("/produtos");
    expect(destino).toBe("/sucatas");
  });

  it("com TODAS as páginas desligadas cai em /sem-acesso", async () => {
    const tudo: Record<string, boolean> = {};
    for (const p of PAGE_DEFS) tudo[p.id] = false;
    mockPerms(tudo);
    expect(await capturaRedirect(sessionDe("admin-1"), "dashboard")).toBe(
      NO_ACCESS_HREF,
    );
  });

  it("colaborador sem pagePermissions não é redirecionado de lugar nenhum", async () => {
    mockPerms(null);
    for (const p of PAGE_DEFS) {
      expect(await capturaRedirect(sessionDe("admin-1"), p.id)).toBeNull();
    }
  });

  describe("invariante: o destino nunca redireciona de volta", () => {
    const cenarios: Array<Record<string, boolean>> = [
      { dashboard: false },
      { dashboard: false, produtos: false },
      { dashboard: false, produtos: false, sucatas: false },
      { financeiro: false, logs: false },
    ];

    it("varre todas as páginas em cada cenário", async () => {
      for (const perms of cenarios) {
        for (const bloqueada of PAGE_DEFS) {
          mockPerms(perms);
          const destino = await capturaRedirect(
            sessionDe("admin-1"),
            bloqueada.id,
          );
          if (destino === null) continue;
          if (destino === NO_ACCESS_HREF) continue;

          // O destino corresponde a um PageId conhecido...
          const alvo = PAGE_DEFS.find((p) => p.href === destino);
          expect(alvo).toBeTruthy();
          // ...diferente da página bloqueada...
          expect(alvo!.id).not.toBe(bloqueada.id);
          // ...e permitido com o MESMO estado de permissões, logo o guard
          // daquela página retorna sem redirecionar.
          expect(
            hasPageAccess(
              { parentUserId: "admin-1", role: "USER", pagePermissions: perms },
              alvo!.id,
            ),
          ).toBe(true);
          expect(pageHref(alvo!.id)).toBe(destino);
        }
      }
    });
  });
});
