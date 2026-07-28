import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ──────────────────────────────────────────────────────────
// O gate `requirePageAccess("dashboard")` protege os NÚMEROS do Dashboard —
// faturamento, receita por conta, top produtos, estatística de anúncios.
//
// Duas rotas moram sob o mesmo prefixo /dashboard mas NÃO são a página:
//   /dashboard/search        → busca global do menu lateral (app-sidebar)
//   /dashboard/notifications → sino do cabeçalho (app-header)
// Ambas aparecem em TODAS as páginas. Bloqueá-las tiraria busca e notificações
// do colaborador — muito além do que o cliente pediu. Este teste trava essa
// distinção, que é fácil de perder num "aplica o preHandler em todas".
// ──────────────────────────────────────────────────────────

const FONTE = fs.readFileSync(
  path.resolve(__dirname, "..", "app", "routes", "dashboard.routes.ts"),
  "utf8",
);

/** Extrai [rota, preHandler] de cada fastify.get do arquivo. */
function rotasComPreHandler(): Array<{ rota: string; preHandler: string }> {
  const out: Array<{ rota: string; preHandler: string }> = [];
  const re =
    /fastify\.get\(\s*"([^"]+)"\s*,\s*\{\s*preHandler:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(FONTE)) !== null) {
    out.push({ rota: m[1], preHandler: m[2].replace(/\s+/g, " ").trim() });
  }
  return out;
}

const ROTAS_SEM_GATE = new Set(["/search", "/notifications"]);

describe("dashboard.routes — escopo do requirePageAccess", () => {
  const rotas = rotasComPreHandler();

  it("o parse encontrou as rotas (guarda contra teste vazio)", () => {
    expect(rotas.length).toBeGreaterThanOrEqual(10);
  });

  it("busca global e sino do cabeçalho NÃO exigem acesso ao Dashboard", () => {
    for (const nome of ROTAS_SEM_GATE) {
      const r = rotas.find((x) => x.rota === nome);
      expect(r, `rota ${nome} sumiu de dashboard.routes.ts`).toBeTruthy();
      expect(
        r!.preHandler.includes("requirePageAccess"),
        `${nome} é transversal (aparece em todas as páginas) e não pode exigir acesso ao Dashboard`,
      ).toBe(false);
    }
  });

  it("todas as demais rotas de /dashboard exigem acesso ao Dashboard", () => {
    const desprotegidas = rotas
      .filter((r) => !ROTAS_SEM_GATE.has(r.rota))
      .filter((r) => !r.preHandler.includes('requirePageAccess("dashboard")'))
      .map((r) => r.rota);

    expect(desprotegidas).toEqual([]);
  });

  it("report.pdf está protegido (reexpõe receita e produtividade da equipe)", () => {
    const r = rotas.find((x) => x.rota === "/report.pdf");
    expect(r).toBeTruthy();
    expect(r!.preHandler).toContain('requirePageAccess("dashboard")');
  });

  it("toda rota mantém o authMiddleware", () => {
    for (const r of rotas) {
      expect(r.preHandler, `rota ${r.rota}`).toContain("authMiddleware");
    }
  });
});
