import { describe, it, expect } from "vitest";

// ──────────────────────────────────────────────────────────
// Bloco D — destino de redirect de quem foi bloqueado.
//
// O curto-circuito que tornava o Dashboard inbloqueável existia por um motivo
// real: `assertPageAccess` redirecionava para "/" e "/" É o Dashboard.
// `firstAllowedPage` substitui esse alvo fixo — e precisa nunca devolver uma
// página que redirecione de volta, o que inclui as páginas que não existem
// quando a feature flag está desligada.
// ──────────────────────────────────────────────────────────

import {
  firstAllowedPage,
  isPageRoutable,
  pageHref,
  PAGE_DEFS,
  NO_ACCESS_HREF,
  type PageId,
} from "@/app/lib/page-access";

const admin = { parentUserId: null, role: "ADMIN" as const };
const collab = (perms?: Record<string, boolean> | null) => ({
  parentUserId: "admin-1",
  role: "USER" as const,
  pagePermissions: perms ?? null,
});

/** Env sem nenhuma feature flag ligada (o pior caso para o redirect). */
const SEM_FLAGS: Record<string, string | undefined> = {};
/** Env com todas as flags ligadas. */
const COM_FLAGS: Record<string, string | undefined> = {
  NEXT_PUBLIC_PDV_ENABLED: "true",
  NEXT_PUBLIC_MAGALU_INTEGRATION_ENABLED: "true",
  NEXT_PUBLIC_FISCAL_MODULE_ENABLED: "true",
};

/** Desliga todas as páginas menos as listadas. */
function apenas(...ids: PageId[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of PAGE_DEFS) out[p.id] = ids.includes(p.id);
  return out;
}

describe("pageHref e PAGE_DEFS", () => {
  it("todo PageId tem href começando com /", () => {
    for (const p of PAGE_DEFS) {
      expect(p.href.startsWith("/")).toBe(true);
      expect(pageHref(p.id)).toBe(p.href);
    }
  });

  it("nenhum href colide com a rota neutra", () => {
    for (const p of PAGE_DEFS) {
      expect(p.href).not.toBe(NO_ACCESS_HREF);
    }
  });

  it("hrefs são únicos (dois PageIds não apontam para a mesma rota)", () => {
    const hrefs = PAGE_DEFS.map((p) => p.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe("isPageRoutable", () => {
  it("página sem flag existe sempre", () => {
    const produtos = PAGE_DEFS.find((p) => p.id === "produtos")!;
    expect(isPageRoutable(produtos, SEM_FLAGS)).toBe(true);
  });

  it("página com flag só existe quando a flag vale 'true'", () => {
    const fiscal = PAGE_DEFS.find((p) => p.id === "fiscal")!;
    expect(isPageRoutable(fiscal, SEM_FLAGS)).toBe(false);
    expect(isPageRoutable(fiscal, COM_FLAGS)).toBe(true);
    expect(
      isPageRoutable(fiscal, { NEXT_PUBLIC_FISCAL_MODULE_ENABLED: "1" }),
    ).toBe(false);
  });
});

describe("firstAllowedPage", () => {
  it("admin cai no Dashboard (primeiro da ordem do menu)", () => {
    expect(firstAllowedPage(admin, { env: SEM_FLAGS })).toBe("dashboard");
  });

  it("colaborador sem permissões gravadas cai no Dashboard", () => {
    expect(firstAllowedPage(collab(null), { env: SEM_FLAGS })).toBe(
      "dashboard",
    );
  });

  it("com o Dashboard desligado, cai em Produtos (a próxima do menu)", () => {
    expect(
      firstAllowedPage(collab({ dashboard: false }), { env: SEM_FLAGS }),
    ).toBe("produtos");
  });

  it("nunca devolve a página excluída — varrendo todo PAGE_DEFS", () => {
    for (const p of PAGE_DEFS) {
      const alvo = firstAllowedPage(collab(null), {
        exclude: p.id,
        env: COM_FLAGS,
      });
      expect(alvo).not.toBe(p.id);
    }
  });

  it("todas as páginas desligadas → null (o caso que leva a /sem-acesso)", () => {
    const tudoDesligado: Record<string, boolean> = {};
    for (const p of PAGE_DEFS) tudoDesligado[p.id] = false;
    expect(firstAllowedPage(collab(tudoDesligado), { env: COM_FLAGS })).toBe(
      null,
    );
  });

  it("usuário nulo → null", () => {
    expect(firstAllowedPage(null)).toBe(null);
    expect(firstAllowedPage(undefined)).toBe(null);
  });

  describe("anti-loop por feature flag", () => {
    it("só 'fiscal' liberado + módulo fiscal DESLIGADO → null", () => {
      // Este é o loop que o briefing não previu: as páginas de notas fiscais
      // fazem redirect("/") quando a flag está off. Mandar o colaborador para
      // lá produziria / → /notas-fiscais/nfe → / → ... infinitamente.
      expect(
        firstAllowedPage(collab(apenas("fiscal")), { env: SEM_FLAGS }),
      ).toBe(null);
    });

    it("só 'fiscal' liberado + módulo fiscal LIGADO → fiscal", () => {
      expect(
        firstAllowedPage(collab(apenas("fiscal")), { env: COM_FLAGS }),
      ).toBe("fiscal");
    });

    it("só 'pdv' liberado + PDV desligado → null (evita 404)", () => {
      expect(firstAllowedPage(collab(apenas("pdv")), { env: SEM_FLAGS })).toBe(
        null,
      );
      expect(firstAllowedPage(collab(apenas("pdv")), { env: COM_FLAGS })).toBe(
        "pdv",
      );
    });

    it("só 'magalu' liberado + integração desligada → null", () => {
      expect(
        firstAllowedPage(collab(apenas("magalu")), { env: SEM_FLAGS }),
      ).toBe(null);
      expect(
        firstAllowedPage(collab(apenas("magalu")), { env: COM_FLAGS }),
      ).toBe("magalu");
    });
  });

  describe("invariante do redirect", () => {
    it("o alvo é sempre uma página permitida, existente e diferente da bloqueada", () => {
      // Varre combinações determinísticas de permissões e prova a propriedade
      // que sustenta a ausência de loop.
      const cenarios: Array<Record<string, boolean>> = [
        apenas("produtos"),
        apenas("logs"),
        apenas("dashboard"),
        apenas("produtos", "financeiro"),
        apenas("fiscal", "pdv"),
        { dashboard: false },
        { dashboard: false, produtos: false },
      ];

      for (const perms of cenarios) {
        for (const bloqueada of PAGE_DEFS) {
          const user = collab(perms);
          const alvo = firstAllowedPage(user, {
            exclude: bloqueada.id,
            env: COM_FLAGS,
          });
          if (alvo === null) continue;
          expect(alvo).not.toBe(bloqueada.id);
          const def = PAGE_DEFS.find((p) => p.id === alvo)!;
          expect(isPageRoutable(def, COM_FLAGS)).toBe(true);
          expect(perms[alvo] !== false).toBe(true);
        }
      }
    });
  });
});
