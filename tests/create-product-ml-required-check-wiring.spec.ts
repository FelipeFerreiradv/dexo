import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ──────────────────────────────────────────────────────────
// Fiação da checagem de atributos obrigatórios do ML nas telas.
//
// A lógica está provada em tests/ml-required-attributes-logic.spec.ts,
// tests/ml-required-attrs-check-route.spec.ts,
// tests/ml-required-attributes-check-client.spec.ts e
// tests/bulk-ml-required-exclusions.spec.ts. Aqui só a ORDEM, que é o que
// importa e que nenhum teste de lógica enxerga: a suíte não tem jsdom nem
// @testing-library/react, então a propriedade é travada no TEXTO-FONTE (mesmo
// padrão de tests/product-draft-not-clobbered-on-close.spec.ts).
//
// No modal: a checagem roda ANTES do POST /products — bloquear depois deixaria
// o produto criado, e o próximo clique criaria um SEGUNDO (autoSku).
// ──────────────────────────────────────────────────────────

const ler = (...partes: string[]) =>
  fs.readFileSync(path.resolve(__dirname, "..", ...partes), "utf8");

const MODAL = ler("app", "produtos", "components", "create-product-dialog.tsx");
const WIZARD = ler("app", "produtos", "components", "bulk-listing-wizard.tsx");

describe("create-product-dialog — checagem de obrigatórios do ML", () => {
  const inicio = MODAL.indexOf("const onSubmit = async");
  const fim = MODAL.indexOf("const response = await fetch(`${getApiBaseUrl()}/products`", inicio);

  it("fica dentro do onSubmit, antes do POST /products e depois do guard do Facebook", () => {
    expect(inicio, "não encontrei onSubmit").toBeGreaterThan(-1);
    expect(fim, "não encontrei o POST /products").toBeGreaterThan(inicio);
    const corpo = MODAL.slice(inicio, fim);
    const guardFacebook = corpo.indexOf(
      "Selecione ao menos uma conta do Facebook para criar o anúncio.",
    );
    const checagem = corpo.indexOf("await checkMlRequiredAttributes(");
    expect(guardFacebook).toBeGreaterThan(-1);
    expect(checagem, "checagem fora do onSubmit ou depois do POST").toBeGreaterThan(
      guardFacebook,
    );
  });

  it("só roda com anúncio ML e, bloqueado, sai ANTES de criar (setIsSubmitting(false) + return)", () => {
    const corpo = MODAL.slice(inicio, fim);
    const bloco = corpo.slice(corpo.indexOf("if (data.createMLListing) {\r\n        const catMl") >= 0
      ? corpo.indexOf("if (data.createMLListing) {\r\n        const catMl")
      : corpo.indexOf("if (data.createMLListing) {\n        const catMl"));
    expect(bloco.length).toBeGreaterThan(0);
    const trecho = bloco.slice(0, 2000);
    // A decisão é a função pura testada em node (shouldBlockMlDraft), chamada
    // SEM negação; o ramo que ela abre zera o submit e retorna.
    const decisao = trecho.indexOf("if (obrigatorios && shouldBlockMlDraft(obrigatorios)) {");
    expect(decisao).toBeGreaterThan(-1);
    const ramo = trecho.slice(decisao, trecho.indexOf("return;", decisao) + "return;".length);
    expect(ramo).toContain("setIsSubmitting(false);");
    expect(ramo.endsWith("return;")).toBe(true);
  });

  it("D5: o envio não consulta o status (sem round-trip antes do POST /products)", () => {
    const corpo = MODAL.slice(inicio, fim);
    expect(corpo).not.toContain("fetchMlRequiredAttrsEnabled(");
    // O aquecimento existe, mas fora do onSubmit e só com ML marcado.
    const aquecimento = MODAL.indexOf("void fetchMlRequiredAttrsEnabled(");
    expect(aquecimento).toBeGreaterThan(-1);
    expect(aquecimento < inicio || aquecimento > fim).toBe(true);
    const efeito = MODAL.slice(MODAL.lastIndexOf("useEffect(", aquecimento), aquecimento);
    expect(efeito).toContain("!watchCreateMLListing");
  });
});

describe("bulk-listing-wizard — checagem de obrigatórios do ML", () => {
  it("o envio aplica withDisabledMlAccounts ANTES do POST /listings/bulk", () => {
    const inicio = WIZARD.indexOf("const handleSubmit = async");
    const post = WIZARD.indexOf("/listings/bulk`", inicio);
    const exclusao = WIZARD.indexOf("withDisabledMlAccounts(", inicio);
    expect(inicio).toBeGreaterThan(-1);
    expect(exclusao).toBeGreaterThan(inicio);
    expect(exclusao).toBeLessThan(post);
  });

  it("a checagem só faz o POST depois de confirmar que está ligada, SEM esperar rede (sem spinner com ela desligada)", () => {
    const inicio = WIZARD.indexOf("const runMlRequiredCheck = async");
    const fimFn = WIZARD.indexOf("const handleNext = async", inicio);
    const corpo = WIZARD.slice(inicio, fimFn);
    const status = corpo.indexOf("if (getKnownMlRequiredAttrsEnabled(base, email) !== true) {");
    const loading = corpo.indexOf("setMlCheckLoading(true)");
    const postCheck = corpo.indexOf("await postMlRequiredAttributesCheck(");
    expect(status).toBeGreaterThan(-1);
    expect(loading).toBeGreaterThan(status);
    expect(postCheck).toBeGreaterThan(loading);
    // D5: nenhum await de status no caminho do Finalizar/etapa 3.
    expect(corpo).not.toContain("fetchMlRequiredAttrsEnabled(");
    // O ramo desligado retorna ANTES de ligar o spinner.
    const ramo = corpo.slice(status, corpo.indexOf("return {};", status));
    expect(ramo).not.toContain("setMlCheckLoading(true)");
  });

  it("aquecimento do status depende do booleano de conta ML (trocar de conta não refaz o GET)", () => {
    const aquecimento = WIZARD.indexOf("void fetchMlRequiredAttrsEnabled(");
    expect(aquecimento).toBeGreaterThan(-1);
    const deps = WIZARD.slice(aquecimento, WIZARD.indexOf("]);", aquecimento) + 3);
    expect(deps).toContain("[open, email, temContaMl]);");
  });

  it("descarta resposta de checagem antiga: o portão do sequenciador vem ANTES de gravar", () => {
    const inicio = WIZARD.indexOf("const runMlRequiredCheck = async");
    const corpo = WIZARD.slice(inicio, inicio + 2500);
    const bilhete = corpo.indexOf("const ultima = mlCheckSeqRef.current.next();");
    const portao = corpo.indexOf("if (!ultima()) return;");
    const grava = corpo.indexOf("mlBlockedRef.current = blocked;");
    expect(bilhete).toBeGreaterThan(-1);
    expect(portao).toBeGreaterThan(bilhete);
    expect(grava).toBeGreaterThan(portao);
    // Reabrir o wizard invalida as checagens em voo.
    expect(WIZARD).toContain("mlCheckSeqRef.current.invalidate();");
  });

  it("envio: exclusões pela função pura, com reavaliação pelo próprio runMlRequiredCheck", () => {
    const inicio = WIZARD.indexOf("const handleSubmit = async");
    const post = WIZARD.indexOf("/listings/bulk`", inicio);
    const corpo = WIZARD.slice(inicio, post);
    const decide = corpo.indexOf("await resolveMlExclusionsForSubmit({");
    expect(decide).toBeGreaterThan(-1);
    const chamada = corpo.slice(decide, corpo.indexOf("});", decide));
    expect(chamada).toContain("blocked: mlBlockedRef.current,");
    expect(chamada).toContain("evaluatedKeys: mlEvaluatedKeysRef.current,");
    expect(chamada).toContain(
      "buildMlReviewCheckItems(idsSelecionados, reviewMap, reviewSeeds)",
    );
    expect(chamada).toContain("recheck: runMlRequiredCheck,");
    const exclusao = corpo.indexOf("withDisabledMlAccounts(", decide);
    expect(corpo.slice(exclusao, exclusao + 200)).toContain("excluidosDoMl,");
  });

  it("M12 nos dois modos e D3 no relatório usam as funções puras", () => {
    // A condição INTEIRA do if é a função pura, e o ramo barra a confirmação.
    const m12 = WIZARD.match(
      /if \(\s*mlLoteSemNadaParaEnviar\(\{[\s\S]*?\}\)\s*\)\s*\{\s*setSubmitError\(ML_ALL_BLOCKED_MESSAGE\);\s*return;\s*\}\s*setConfirmOpen\(true\);/g,
    );
    expect(m12?.length).toBe(2);
    const inicioProgress = WIZARD.indexOf("function StepProgress(");
    const progress = WIZARD.slice(inicioProgress);
    expect(progress).toContain("countRetryableBulkFailures(");
    expect(progress).toContain("{isTerminal && falhasReprocessaveis > 0 && (");
    expect(progress).not.toContain("snapshot.failedItems > 0 &&");
  });

  it("D4 na revisão: a confirmação lista os não validados por falta de categoria (sem entrar na contagem de excluídos)", () => {
    const dialogo = WIZARD.slice(WIZARD.indexOf("<AlertDialog open={confirmOpen}"));
    const bloco = dialogo.indexOf('{mode === "review" && mlUnresolvedIds.length > 0 && (');
    expect(bloco).toBeGreaterThan(-1);
    expect(dialogo.slice(bloco, bloco + 1200)).toContain("ML_REQUIRED_UNRESOLVED_REVIEW_HEADER");
    // A contagem de pares excluídos continua só com os bloqueados.
    expect(WIZARD).toContain("const mlExcludedPairs = mlBlockedIds.length * selectedMlIds.size;");
  });

  it("D8: rodapé da revisão fica ocupado enquanto a sugestão automática inicializa (checagem ligada)", () => {
    const rodape = WIZARD.indexOf('{step < 4 && mode === "review" && (');
    expect(rodape).toBeGreaterThan(-1);
    const trecho = WIZARD.slice(rodape, WIZARD.indexOf("onBack={handleReviewBack}", rodape));
    expect(trecho).toContain("mlCheckLoading ||");
    expect(trecho).toContain("(mlCheckEnabled && pp.initializing)");
  });
});
