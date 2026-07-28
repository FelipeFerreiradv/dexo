import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { PAGE_DEFS } from "@/app/lib/page-access";

// ──────────────────────────────────────────────────────────
// Bloco D — PAGE_DEFS ganhou `href` para o redirect do guard, e o sidebar
// (components/app-sidebar.tsx) continua com a sua própria tabela.
//
// Unificar as duas mexeria num client component de ~900 linhas que renderiza em
// TODA página, e um href errado ali quebra a navegação de todo mundo, admin
// incluído. O drift é um risco de manutenção; aquilo seria um risco de
// produção. Este teste cobre o risco que sobrou, lendo o arquivo como texto
// (importá-lo arrastaria React e next/navigation para um spec de ambiente node).
// ──────────────────────────────────────────────────────────

describe("PAGE_DEFS.href não diverge do NAV_SECTIONS do sidebar", () => {
  it("todo id presente nas duas tabelas aponta para o mesmo href", () => {
    const arquivo = path.resolve(
      __dirname,
      "..",
      "components",
      "app-sidebar.tsx",
    );
    const fonte = fs.readFileSync(arquivo, "utf8");

    // Itens do menu: { id: "...", label: "...", href: "...", icon: X }
    const encontrados = new Map<string, string>();
    const re = /id:\s*"([\w-]+)"[^}]*?href:\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(fonte)) !== null) {
      // Primeira ocorrência vence: é a definição do item no NAV_SECTIONS.
      if (!encontrados.has(m[1])) encontrados.set(m[1], m[2]);
    }

    // Sanidade: se o parse quebrar, o teste não pode passar vazio.
    expect(encontrados.size).toBeGreaterThan(5);

    const divergentes: string[] = [];
    for (const def of PAGE_DEFS) {
      const doSidebar = encontrados.get(def.id);
      if (!doSidebar) continue; // "fiscal" é seção, não item — não casa por id.
      if (doSidebar !== def.href) {
        divergentes.push(
          `${def.id}: PAGE_DEFS="${def.href}" vs sidebar="${doSidebar}"`,
        );
      }
    }

    expect(divergentes).toEqual([]);
  });

  it("o href de 'fiscal' aponta para uma rota de notas fiscais", () => {
    // `fiscal` é uma SEÇÃO do menu, não um item — por isso não casa por id.
    const fiscal = PAGE_DEFS.find((p) => p.id === "fiscal")!;
    expect(fiscal.href.startsWith("/notas-fiscais/")).toBe(true);
  });
});
