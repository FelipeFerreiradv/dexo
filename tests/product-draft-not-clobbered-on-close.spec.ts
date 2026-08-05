import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ──────────────────────────────────────────────────────────
// O rascunho não pode ser sobrescrito por um snapshot do formulário JÁ ZERADO.
//
// `handleClose` chama `reset()`, e o `reset()` dispara a assinatura do
// react-hook-form de forma SÍNCRONA — com `open` ainda true, porque
// `setOpen(false)` só acontece no fim da função. Sem trava, o autosave agendava
// um snapshot com todos os campos vazios e, 600 ms depois, gravava por cima do
// rascunho bom.
//
// O snapshot vazio passava no portão porque `hasMeaningfulContent` devolve true
// na PRIMEIRA linha quando há compatibilidades, e elas ainda estão em
// `draftExtrasRef` nesse instante (o `setCompatibilities([])` só chega no render
// seguinte). Por isso o defeito só aparecia em produto COM compatibilidade — o
// caso real do Felipe tinha 15, vindas da sugestão da base interna.
//
// Medido no navegador em 05/08/2026, com 2 compatibilidades no estado:
//   com a trava  -> depois de fechar: nome, part number e preço preservados
//   sem a trava  -> depois de fechar: name "", partNumber "", price 0,
//                   compatibilidades 2 (exatamente o sintoma relatado)
//
// A suíte não tem jsdom nem @testing-library/react (decisão de não adicionar
// dependência), então a propriedade é travada no TEXTO-FONTE — mesmo padrão de
// tests/cors-config.spec.ts e tests/product-draft-reads-on-open.spec.ts.
// ──────────────────────────────────────────────────────────

const MODAL = fs.readFileSync(
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

describe("o autosave não grava por cima do rascunho ao fechar", () => {
  it("`saveDraftNow` sai cedo enquanto o modal está fechando", () => {
    const inicio = MODAL.indexOf("const saveDraftNow");
    expect(inicio, "não encontrei saveDraftNow").toBeGreaterThan(-1);
    const corpo = MODAL.slice(inicio, inicio + 1200);
    expect(corpo).toContain("if (draftClosingRef.current) return;");
  });

  it("`handleClose` liga a trava ANTES do reset e grava ANTES da trava", () => {
    const inicio = MODAL.indexOf("const handleClose");
    expect(inicio, "não encontrei handleClose").toBeGreaterThan(-1);
    // Sem os comentários: os três nomes aparecem no texto explicativo antes de
    // aparecerem como chamada, e a ordem do COMENTÁRIO não prova nada.
    const corpo = MODAL.slice(inicio, inicio + 2500)
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");

    const posFlush = corpo.indexOf("draft.flush()");
    const posTrava = corpo.indexOf("draftClosingRef.current = true");
    const posReset = corpo.indexOf("reset()");

    expect(posFlush, "handleClose não chama draft.flush()").toBeGreaterThan(-1);
    expect(posTrava, "handleClose não liga draftClosingRef").toBeGreaterThan(
      -1,
    );
    expect(posReset, "handleClose não chama reset()").toBeGreaterThan(-1);

    // flush primeiro: é o que persiste o que o usuário digitou.
    expect(posFlush).toBeLessThan(posTrava);
    // trava antes do reset: o reset dispara a assinatura do RHF na hora.
    expect(posTrava).toBeLessThan(posReset);
  });

  it("a trava é liberada quando o modal reabre", () => {
    // Sem isto, o autosave ficaria desligado para sempre depois do 1º
    // fechamento e o rascunho nunca mais seria gravado.
    expect(MODAL).toContain("draftClosingRef.current = false");
  });

  it("`hasMeaningfulContent` continua tratando compatibilidade como conteúdo", () => {
    // A trava é a correção certa justamente porque esta regra deve continuar:
    // quem só adicionou compatibilidades TEM trabalho a salvar.
    const fonte = fs.readFileSync(
      path.resolve(
        __dirname,
        "..",
        "app",
        "produtos",
        "lib",
        "product-form-snapshot.ts",
      ),
      "utf8",
    );
    expect(fonte).toContain(
      "if (snapshot.compatibilities.length > 0) return true;",
    );
  });
});
