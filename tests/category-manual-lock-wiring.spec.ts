import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ──────────────────────────────────────────────────────────
// Fiação da trava de categoria manual nos modais de produto (22/09/2026).
//
// A regra está provada em tests/category-suggestion-guard.spec.ts. Aqui só a
// FIAÇÃO — a suíte não tem jsdom, então a propriedade é travada no
// TEXTO-FONTE (mesmo padrão de create-product-ml-required-check-wiring.spec.ts).
//
// O defeito: o efeito de medidas copiava a categoria ATUAL (inclusive a
// escolhida à mão) para o registro de auto-detectados; a sugestão seguinte a
// tratava como automática e sobrescrevia.
// ──────────────────────────────────────────────────────────

const ler = (...partes: string[]) =>
  fs.readFileSync(path.resolve(__dirname, "..", ...partes), "utf8");

const CREATE = ler("app", "produtos", "components", "create-product-dialog.tsx");
const EDIT = ler("app", "produtos", "components", "edit-product-dialog.tsx");

/** Trecho a partir de `ancora` com até `tamanho` caracteres. */
function trecho(fonte: string, ancora: string, tamanho = 1500): string {
  const i = fonte.indexOf(ancora);
  expect(i, `âncora não encontrada: ${ancora}`).toBeGreaterThan(-1);
  return fonte.slice(i, i + tamanho);
}

describe("create-product-dialog — trava de categoria manual", () => {
  it("seletor ML marca manual ANTES do onChange", () => {
    const t = trecho(CREATE, 'markCategoryManual("ml");', 200);
    expect(t.indexOf("field.onChange(cat.id)")).toBeGreaterThan(0);
  });

  it.each(["shopee", "magalu", "olx", "fb"])(
    "seletor %s marca manual ANTES do onChange",
    (canal) => {
      const t = trecho(CREATE, `markCategoryManual("${canal}");`, 200);
      expect(t).toMatch(/field\.onChange\((cat|o)\.id\)/);
    },
  );

  it("efeito de medidas NÃO copia mais a categoria incondicionalmente", () => {
    // O padrão antigo, literal, não pode voltar.
    expect(CREATE).not.toMatch(
      /mlCategory:\s*watchMlCategory \|\| autoDetectedRef\.current\?\.mlCategory,\s*\n\s*\};/,
    );
    expect(CREATE).toContain("...categoryPatchForAutoDetected(");
  });

  it("sugestão do servidor respeita a trava e a ordem das requisições", () => {
    const t = trecho(CREATE, "const mlBlocked = blocksAutoCategory(", 900);
    expect(t).toContain('"ml"');
    expect(t).toContain("mlSeq");
    expect(t).toMatch(/&& !mlBlocked\)/);
    expect(t).toContain("setPendingMlSuggestion(");
    expect(CREATE).toContain(
      'const mlSeq = beginSuggestionRequest(categoryGuardRef.current, "ml");',
    );
  });

  it("sugestão Shopee do servidor respeita a trava", () => {
    expect(CREATE).toContain(
      '!blocksAutoCategory(categoryGuardRef.current, "shopee", shopeeSeq)',
    );
  });

  it("parser do título não grava ML nem rótulo com a categoria travada", () => {
    expect(CREATE).toMatch(
      /\(\(!currentMlCategory \|\| isPrevAutoMl\) && !mlLockedByUser\)/,
    );
    expect(CREATE).toMatch(/isPrevAutoMl && currentMlCategory && !mlLockedByUser/);
    expect(CREATE).toMatch(/const shouldUpdateCategory =\s*\n\s*!mlLockedByUser &&/);
  });

  it.each([
    ["magalu", "magaluCategory"],
    ["olx", "olxCategory"],
    ["fb", "facebookCategory"],
  ])("sugestão %s só grava se a trava permitir", (canal, campo) => {
    expect(CREATE).toContain(
      `!mayApplyAutoCategory(categoryGuardRef.current, "${canal}", {\n            current: getValues("${campo}"),`.replace(
        /\n/g,
        CREATE.includes("\r\n") ? "\r\n" : "\n",
      ),
    );
  });

  // ⚠️ Mudança intencional (hotfix de 23/09/2026): rascunho e histórico
  // TRAVAVAM toda categoria que voltava — o "Usar último" grudava a categoria
  // da peça anterior em toda a série. Agora a origem decide: o rascunho (mesmo
  // cadastro) grava e devolve as escolhas manuais; o histórico (outro
  // produto) não passa origem e entra como sugestão. Regra provada em
  // tests/category-suggestion-guard.spec.ts.
  it("rascunho devolve a ORIGEM gravada ANTES dos setValue", () => {
    const rascunho = trecho(CREATE, "const restoreSnapshotIntoForm = useCallback(", 900);
    const marca = rascunho.indexOf("markRestoredCategories(");
    const laco = rascunho.indexOf("for (const [field, value] of Object.entries(snapshot.values))");
    expect(marca).toBeGreaterThan(-1);
    expect(laco).toBeGreaterThan(marca);
    expect(rascunho.slice(marca, laco)).toContain("snapshot.categoryOrigins");
  });

  it("histórico entra como SUGESTÃO (sem origem) ANTES dos setValue", () => {
    const historico = trecho(CREATE, "const handleApplyHistory = useCallback(", 1600);
    const marcaH = historico.indexOf("markRestoredCategories(");
    const lacoH = historico.indexOf("for (const field of applied)");
    expect(marcaH).toBeGreaterThan(-1);
    expect(lacoH).toBeGreaterThan(marcaH);
    const chamada = historico.slice(marcaH, lacoH);
    expect(chamada).not.toContain("categoryOrigins");
    expect(chamada).not.toContain("Source");
    expect(historico).not.toContain("markCategoryManual(");
  });

  it("o rascunho grava as escolhas manuais da sessão", () => {
    const salvar = trecho(CREATE, "const saveDraftNow = useCallback(", 1800);
    expect(salvar).toContain("categoryOrigins: manualCategoryOrigins(categoryGuardRef.current)");
  });

  it("categoria restaurada como sugestão fica registrada como auto-detectada (a sugestão do título pode trocá-la)", () => {
    const f = trecho(CREATE, "const markRestoredCategories = useCallback(", 2200);
    expect(f).toContain("markRestoredCategory(");
    expect(f).toContain("mlCategory: String(v)");
    expect(f).toContain("shopeeCategory: String(v)");
  });

  it("abrir e fechar o modal zeram a trava", () => {
    const n = CREATE.split("resetCategoryGuard(categoryGuardRef.current);").length - 1;
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it("origem enviada: escolha manual é 'manual'", () => {
    const t = trecho(CREATE, "const mlCategorySourceToSend = data.mlCategory", 300);
    expect(t).toContain('isManualCategory(categoryGuardRef.current, "ml")');
  });
});

describe("edit-product-dialog — trava de categoria manual", () => {
  it("seletores ML marcam manual ANTES do onChange", () => {
    const partes = EDIT.split('markManual(categoryGuardRef.current, "ml");');
    expect(partes.length - 1).toBe(2);
    for (const depois of partes.slice(1)) {
      expect(depois.slice(0, 200)).toContain("field.onChange(opt.id)");
    }
  });

  it("efeito de medidas usa o patch com trava nos dois ramos", () => {
    expect(EDIT.split("...categoryPatchForAutoDetected(").length - 1).toBe(2);
    expect(EDIT).not.toMatch(
      /mlCategory: watchMlCategory \|\| autoDetectedRef\.current\?\.mlCategory,/,
    );
  });

  it("origem enviada: escolha manual é 'manual'", () => {
    const t = trecho(EDIT, "const mlCategorySourceToSend = data.mlCategory", 300);
    expect(t).toContain('isManualCategory(categoryGuardRef.current, "ml")');
  });
});
