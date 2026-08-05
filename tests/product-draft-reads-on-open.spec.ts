import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ──────────────────────────────────────────────────────────
// O rascunho e o histórico do modal de produto leem o `localStorage` dentro de
// um `useEffect`. O `CreateProductDialog` fica montado junto com a lista de
// produtos e só alterna a prop `open` — ele NÃO desmonta ao fechar. Enquanto o
// efeito dependia só de `[enabled, key]`, a leitura acontecia uma única vez, no
// mount: o rascunho gravado ao fechar o modal só era oferecido depois de
// recarregar a página, o que elimina justamente o caso mais comum da feature
// (fechar sem querer e reabrir em seguida).
//
// Medido no navegador em 05/08/2026, com o rascunho presente no localStorage:
//   fechar + reabrir na mesma página  -> pergunta NÃO aparecia
//   recarregar a página + abrir       -> pergunta aparecia
//
// A suíte não tem jsdom nem @testing-library/react (decisão de não adicionar
// dependência), então não há como renderizar o hook e observar o efeito. Este
// spec trava a propriedade no TEXTO-FONTE — mesmo padrão de
// tests/cors-config.spec.ts e tests/dashboard-routes-page-gate.spec.ts — para
// que remover `open` das dependências volte a quebrar o teste, e não o usuário.
// ──────────────────────────────────────────────────────────

const ler = (arquivo: string) =>
  fs.readFileSync(
    path.resolve(__dirname, "..", "app", "produtos", "hooks", arquivo),
    "utf8",
  );

const FONTE_RASCUNHO = ler("use-product-draft.ts");
const FONTE_HISTORICO = ler("use-product-history.ts");

/**
 * Extrai o array de dependências do `useEffect` que faz a leitura do storage.
 * Casa o primeiro `}, [...]);` depois da chamada de leitura.
 */
function dependenciasDoEfeitoDeLeitura(fonte: string, leitura: string): string {
  const inicio = fonte.indexOf(leitura);
  expect(
    inicio,
    `não encontrei a chamada de leitura ${leitura} na fonte`,
  ).toBeGreaterThan(-1);
  const resto = fonte.slice(inicio);
  const m = resto.match(/\}\s*,\s*\[([^\]]*)\]\s*\)/);
  expect(m, "não encontrei o array de dependências do efeito").toBeTruthy();
  return (m as RegExpMatchArray)[1];
}

describe("rascunho e histórico releem o storage a cada abertura", () => {
  it("o efeito de leitura do rascunho depende de `open`", () => {
    const deps = dependenciasDoEfeitoDeLeitura(
      FONTE_RASCUNHO,
      "readDraft(key)",
    );
    expect(deps).toMatch(/\bopen\b/);
  });

  it("o efeito de leitura do histórico depende de `open`", () => {
    const deps = dependenciasDoEfeitoDeLeitura(
      FONTE_HISTORICO,
      "readHistory(key)",
    );
    expect(deps).toMatch(/\bopen\b/);
  });

  it("os dois hooks exigem `open` na assinatura", () => {
    // Se alguém tornar a prop opcional, o call site pode esquecer de passá-la
    // e o bug volta silenciosamente — o TypeScript não reclamaria.
    expect(FONTE_RASCUNHO).toMatch(/^\s{2}open: boolean;/m);
    expect(FONTE_HISTORICO).toMatch(/^\s{2}open: boolean;/m);
  });

  it("com o modal fechado o efeito não lê o storage", () => {
    // Ler com `open === false` faria a pergunta de restauração disparar
    // enquanto o modal está fechado, e voltaria a aparecer sozinha depois de
    // o usuário já ter respondido.
    expect(FONTE_RASCUNHO).toContain("if (!open) return;");
    expect(FONTE_HISTORICO).toContain("if (!open) return;");
  });

  it("o modal passa `open` para os dois hooks", () => {
    const modal = fs.readFileSync(
      path.resolve(
        __dirname,
        "..",
        "app",
        "produtos",
        "components",
        "create-product-dialog.tsx",
      ),
      "utf8",
    );
    const trecho = modal.slice(
      modal.indexOf("useProductDraft({"),
      modal.indexOf("const [askRestoreDraft"),
    );
    // duas ocorrências: uma por hook
    expect(trecho.match(/^\s+open,$/gm)?.length).toBe(2);
  });
});
