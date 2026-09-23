import { describe, it, expect, beforeEach } from "vitest";
import {
  beginSuggestionRequest,
  blocksAutoCategory,
  categoryPatchForAutoDetected,
  isManualCategory,
  createCategoryGuard,
  manualCategoryOrigins,
  markAuto,
  markEmpty,
  markManual,
  markRestoredCategory,
  mayApplyAutoCategory,
  mlSuggestionChipAction,
  resetCategoryGuard,
  resolveCategorySource,
  type CategoryGuardState,
} from "../app/produtos/lib/category-suggestion-guard";

/**
 * Categoria manual NUNCA é sobrescrita pela sugestão automática (22/09/2026).
 *
 * Simula a sequência real do modal: o título dispara sugestões (algumas
 * atrasadas), a pessoa escolhe outra categoria, e depois continua editando.
 */
describe("category-suggestion-guard", () => {
  let g: CategoryGuardState;
  beforeEach(() => {
    g = createCategoryGuard();
  });

  it("sugestão inicial preenche o campo vazio", () => {
    const seq = beginSuggestionRequest(g, "ml");
    expect(mayApplyAutoCategory(g, "ml", { current: "", responseSeq: seq })).toBe(
      true,
    );
    markAuto(g, "ml", "MLB111");
    expect(resolveCategorySource(g, "ml", "MLB111")).toBe("auto");
  });

  it("enquanto ninguém escolheu, a sugestão pode ATUALIZAR a própria sugestão", () => {
    markAuto(g, "ml", "MLB111");
    const seq = beginSuggestionRequest(g, "ml");
    expect(
      mayApplyAutoCategory(g, "ml", { current: "MLB111", responseSeq: seq }),
    ).toBe(true);
  });

  it("depois da escolha manual, nenhuma sugestão sobrescreve", () => {
    markAuto(g, "ml", "MLB111");
    markManual(g, "ml"); // picker: MLB222
    const seq = beginSuggestionRequest(g, "ml"); // título mudou
    expect(
      mayApplyAutoCategory(g, "ml", { current: "MLB222", responseSeq: seq }),
    ).toBe(false);
    // nem se o campo ficar vazio por outro motivo
    expect(mayApplyAutoCategory(g, "ml", { current: "" })).toBe(false);
    expect(resolveCategorySource(g, "ml", "MLB222")).toBe("manual");
  });

  it("RACE: requisição A em voo, pessoa escolhe B, A volta ⇒ A é descartada", () => {
    const seqA = beginSuggestionRequest(g, "ml");
    markManual(g, "ml"); // escolheu B enquanto A estava em voo
    expect(
      mayApplyAutoCategory(g, "ml", { current: "MLB_B", responseSeq: seqA }),
    ).toBe(false);
  });

  it("resposta atrasada de requisição antiga não sobrescreve a mais nova", () => {
    const seq1 = beginSuggestionRequest(g, "ml");
    const seq2 = beginSuggestionRequest(g, "ml");
    expect(mayApplyAutoCategory(g, "ml", { current: "", responseSeq: seq1 })).toBe(
      false,
    );
    expect(mayApplyAutoCategory(g, "ml", { current: "", responseSeq: seq2 })).toBe(
      true,
    );
  });

  it("valor posto por OUTRO caminho (catálogo, histórico) não é sobrescrito", () => {
    // Campo tem valor que não foi a sugestão automática que pôs.
    expect(mayApplyAutoCategory(g, "ml", { current: "MLB_HIST" })).toBe(false);
  });

  it("re-render / reexecução sem título novo não muda a decisão", () => {
    markManual(g, "ml");
    for (let i = 0; i < 5; i++) {
      expect(mayApplyAutoCategory(g, "ml", { current: "MLB222" })).toBe(false);
    }
  });

  it("auto-limpeza não apaga escolha manual", () => {
    markManual(g, "ml");
    markEmpty(g, "ml");
    expect(g.ml.origin).toBe("manual");
  });

  it("auto-limpeza de sugestão libera o campo para a próxima sugestão", () => {
    markAuto(g, "ml", "MLB111");
    markEmpty(g, "ml");
    expect(mayApplyAutoCategory(g, "ml", { current: "" })).toBe(true);
  });

  it("canais são independentes (manual no ML não trava a Shopee)", () => {
    markManual(g, "ml");
    expect(mayApplyAutoCategory(g, "shopee", { current: "" })).toBe(true);
    expect(mayApplyAutoCategory(g, "magalu", { current: "" })).toBe(true);
  });

  it("reabrir o modal (reset) libera tudo, mas respostas antigas continuam descartadas", () => {
    const seqAntiga = beginSuggestionRequest(g, "ml");
    markManual(g, "ml");
    resetCategoryGuard(g);
    expect(g.ml.origin).toBe("empty");
    // resposta disparada ANTES do reset chega depois: descartada
    expect(
      mayApplyAutoCategory(g, "ml", { current: "", responseSeq: seqAntiga }),
    ).toBe(false);
    // uma requisição nova, depois do reset, vale
    const seqNova = beginSuggestionRequest(g, "ml");
    expect(
      mayApplyAutoCategory(g, "ml", { current: "", responseSeq: seqNova }),
    ).toBe(true);
  });

  it("ação explícita 'usar sugestão' conta como escolha da pessoa", () => {
    markAuto(g, "ml", "MLB111");
    markManual(g, "ml"); // escolheu MLB222
    // clicou em "Usar sugestão (MLB333)": o modal grava e marca manual
    markManual(g, "ml");
    expect(resolveCategorySource(g, "ml", "MLB333")).toBe("manual");
  });

  it("blocksAutoCategory: manual bloqueia; resposta velha bloqueia; resto libera", () => {
    const s1 = beginSuggestionRequest(g, "shopee");
    expect(blocksAutoCategory(g, "shopee", s1)).toBe(false);
    const s2 = beginSuggestionRequest(g, "shopee");
    expect(blocksAutoCategory(g, "shopee", s1)).toBe(true);
    expect(blocksAutoCategory(g, "shopee", s2)).toBe(false);
    expect(blocksAutoCategory(g, "shopee")).toBe(false);
    markManual(g, "shopee");
    expect(blocksAutoCategory(g, "shopee", s2)).toBe(true);
    expect(isManualCategory(g, "shopee")).toBe(true);
    expect(isManualCategory(g, "ml")).toBe(false);
  });

  it("patch do efeito de medidas: sem escolha manual copia a categoria atual (como sempre)", () => {
    expect(
      categoryPatchForAutoDetected(
        g,
        { category: "Farol", mlCategory: "MLB1" },
        { category: "X", mlCategory: "MLB0" },
      ),
    ).toEqual({ category: "Farol", mlCategory: "MLB1" });
    expect(
      categoryPatchForAutoDetected(g, { category: null, mlCategory: "" }, {
        category: "X",
        mlCategory: "MLB0",
      }),
    ).toEqual({ category: "X", mlCategory: "MLB0" });
  });

  it("patch do efeito de medidas: com escolha manual NÃO copia", () => {
    markManual(g, "ml");
    expect(
      categoryPatchForAutoDetected(
        g,
        { category: "Retrovisor", mlCategory: "MLB_B" },
        { category: "Farol", mlCategory: "MLB_A" },
      ),
    ).toEqual({});
  });

  it("CENÁRIO DO BUG: sugestão A → pessoa escolhe B → efeito de medidas → nova sugestão C", () => {
    // Regra que os modais aplicam para gravar a sugestão automática.
    const norm = (v?: string) => (v || "").trim().toLowerCase();
    const aplicaria = (
      current: string,
      prevAuto: string | undefined,
      seq?: number,
    ) =>
      (!current || norm(prevAuto) === norm(current)) &&
      !blocksAutoCategory(g, "ml", seq);

    // 1) sugestão A aplicada
    let autoDetected: { category?: string; mlCategory?: string } = {
      mlCategory: "MLB_A",
    };
    markAuto(g, "ml", "MLB_A");
    let current = "MLB_A";
    // 2) pessoa escolhe B (o modal marca manual ANTES do onChange)
    markManual(g, "ml");
    current = "MLB_B";
    // 3) efeito de medidas roda depois do render
    autoDetected = {
      ...autoDetected,
      ...categoryPatchForAutoDetected(g, { mlCategory: current }, autoDetected),
    };
    expect(autoDetected.mlCategory).toBe("MLB_A"); // não virou "B auto"
    // 4) título mudou: sugestão C chega
    const seq = beginSuggestionRequest(g, "ml");
    expect(aplicaria(current, autoDetected.mlCategory, seq)).toBe(false);

    // Controle: sem a trava (comportamento antigo) a cópia tornava B "auto" e
    // a sugestão C sobrescrevia — o defeito relatado.
    const antigo = { mlCategory: current }; // cópia incondicional de antes
    expect(
      !current || norm(antigo.mlCategory) === norm(current),
    ).toBe(true);
  });

  it("origem vazia quando nada foi enviado", () => {
    expect(resolveCategorySource(g, "ml", "")).toBeUndefined();
    expect(resolveCategorySource(g, "ml", null)).toBeUndefined();
  });

  it("valor enviado igual ao sugerido mas escolhido de novo à mão é 'manual'", () => {
    markAuto(g, "ml", "MLB111");
    markManual(g, "ml");
    expect(resolveCategorySource(g, "ml", "MLB111")).toBe("manual");
  });
});

describe("sugestão Magalu/OLX/Facebook com número de requisição (revisão 23/09)", () => {
  it.each(["magalu", "olx", "fb"] as const)(
    "%s: resposta que chega depois de fechar o modal NÃO grava (e a nova sugestão, depois de reabrir, grava)",
    (canal) => {
      const g = createCategoryGuard();
      const velha = beginSuggestionRequest(g, canal);
      resetCategoryGuard(g); // fechou (reset do formulário zera o campo)
      // A resposta do produto A chega com o campo vazio: descartada.
      expect(mayApplyAutoCategory(g, canal, { current: "", responseSeq: velha })).toBe(false);
      resetCategoryGuard(g); // reabriu para o produto B
      const nova = beginSuggestionRequest(g, canal);
      expect(mayApplyAutoCategory(g, canal, { current: "", responseSeq: nova })).toBe(true);
    },
  );
});

describe("chip 'Usar sugestão' da categoria ML (revisão 23/09)", () => {
  const base = {
    responseIsLatest: true,
    manual: true,
    suggested: "MLB222",
    current: "MLB111",
    declined: new Set<string>(),
  };

  it("escolha manual + sugestão diferente ⇒ mostra", () => {
    expect(mlSuggestionChipAction(base)).toBe("show");
  });

  it("recusada com 'Manter minha escolha' ⇒ não volta quando o efeito roda de novo", () => {
    expect(
      mlSuggestionChipAction({ ...base, declined: new Set(["mlb222"]) }),
    ).toBe("clear");
  });

  it("título corrigido: a sugestão nova é a própria escolha ⇒ some o chip velho", () => {
    expect(mlSuggestionChipAction({ ...base, suggested: " mlb111 " })).toBe("clear");
  });

  it("título sem sugestão ⇒ some o chip velho", () => {
    expect(mlSuggestionChipAction({ ...base, suggested: null })).toBe("clear");
  });

  it("resposta atrasada (não é a última pedida) ⇒ não mexe no chip", () => {
    expect(mlSuggestionChipAction({ ...base, responseIsLatest: false })).toBe("keep");
    expect(
      mlSuggestionChipAction({ ...base, responseIsLatest: false, suggested: null }),
    ).toBe("keep");
  });

  it("sem escolha manual ⇒ não há chip (a sugestão aplica sozinha)", () => {
    expect(mlSuggestionChipAction({ ...base, manual: false })).toBe("keep");
  });
});

describe("categoria que VOLTA para o formulário (hotfix de 23/09/2026)", () => {
  it("sem origem gravada (histórico, rascunho antigo) ⇒ entra como SUGESTÃO", () => {
    for (const origem of [undefined, null, "auto", "imported", "xyz"]) {
      const g = createCategoryGuard();
      expect(markRestoredCategory(g, "ml", "MLB_FAROL", origem)).toBe("auto");
      expect(isManualCategory(g, "ml")).toBe(false);
      // a sugestão do título novo pode trocá-la…
      expect(mayApplyAutoCategory(g, "ml", { current: "MLB_FAROL" })).toBe(true);
      // …e, se ninguém mexer, o submit grava "auto"
      expect(resolveCategorySource(g, "ml", "MLB_FAROL")).toBe("auto");
    }
  });

  it("origem gravada 'manual' (rascunho do MESMO cadastro) ⇒ continua travada", () => {
    const g = createCategoryGuard();
    expect(markRestoredCategory(g, "ml", "MLB_ESCOLHIDA", "manual")).toBe("manual");
    expect(isManualCategory(g, "ml")).toBe(true);
    expect(mayApplyAutoCategory(g, "ml", { current: "MLB_ESCOLHIDA" })).toBe(false);
    expect(resolveCategorySource(g, "ml", "MLB_ESCOLHIDA")).toBe("manual");
  });

  it("campo vazio ⇒ nada muda", () => {
    const g = createCategoryGuard();
    expect(markRestoredCategory(g, "ml", "", "manual")).toBeNull();
    expect(markRestoredCategory(g, "ml", undefined)).toBeNull();
    expect(g.ml.origin).toBe("empty");
  });

  it("CENÁRIO DE PRODUÇÃO: 'Usar último' em série com peças diferentes ⇒ cada peça segue a sugestão do próprio título", () => {
    // pedal de freio copiado do cadastro da moldura: a categoria da moldura
    // entra como sugestão, a sugestão do título novo a troca, o submit é "auto"
    const g = createCategoryGuard();
    markRestoredCategory(g, "ml", "MLB_ACESSORIOS"); // histórico não passa origem
    expect(mayApplyAutoCategory(g, "ml", { current: "MLB_ACESSORIOS" })).toBe(true);
    markAuto(g, "ml", "MLB_PEDAL_FREIO"); // sugestão do título "Pedal freio…"
    expect(resolveCategorySource(g, "ml", "MLB_PEDAL_FREIO")).toBe("auto");
  });

  it("escolha no seletor DEPOIS de copiar do histórico ⇒ trava e grava 'manual' (o conserto do #359 continua)", () => {
    const g = createCategoryGuard();
    markRestoredCategory(g, "ml", "MLB_ACESSORIOS");
    markManual(g, "ml");
    expect(mayApplyAutoCategory(g, "ml", { current: "MLB_ACESSORIOS" })).toBe(false);
    expect(resolveCategorySource(g, "ml", "MLB_ACESSORIOS")).toBe("manual");
  });

  it("manualCategoryOrigins guarda SÓ as escolhas da pessoa", () => {
    const g = createCategoryGuard();
    markManual(g, "ml");
    markAuto(g, "shopee", "100");
    markManual(g, "fb");
    expect(manualCategoryOrigins(g)).toEqual({ ml: "manual", fb: "manual" });
    expect(manualCategoryOrigins(createCategoryGuard())).toEqual({});
  });

  it("ida e volta do rascunho: a escolha manual volta travada; a sugestão volta como sugestão", () => {
    const antes = createCategoryGuard();
    markManual(antes, "ml");
    markAuto(antes, "shopee", "SHP_1");
    const origens = manualCategoryOrigins(antes);
    const depois = createCategoryGuard();
    markRestoredCategory(depois, "ml", "MLB_ESCOLHIDA", origens.ml);
    markRestoredCategory(depois, "shopee", "SHP_1", origens.shopee);
    expect(isManualCategory(depois, "ml")).toBe(true);
    expect(isManualCategory(depois, "shopee")).toBe(false);
  });
});
