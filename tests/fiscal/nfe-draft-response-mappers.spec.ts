import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRAVA ESTRUTURAL: existem DOIS mapeadores de NfeEmitida -> NfeDraftResponse.
 *
 *  1. `toDraftResponse` em app/repositories/nfe.repository.ts — usado pelo
 *     rascunho, pela listagem e pelo inicio da emissao;
 *  2. `loadNfe` em app/usecases/nfe-emission.usecase.ts — escrito a mao, e o
 *     que alimenta o BUILDER DE XML (`nfeWithNumero`).
 *
 * Um campo novo que entre so no primeiro fica gravado no banco e some na hora
 * de montar o XML — o defeito e SILENCIOSO: como os campos novos entram como
 * opcionais em NfeDraftResponse (para nao quebrar construtores antigos), o
 * `tsc` nao acusa a omissao, e nenhum teste de unidade dos dois lados percebe.
 * Foi exatamente o que aconteceu com `valorFrete`.
 *
 * Este teste compara os CONJUNTOS DE CHAVES das duas projecoes. E estrutural de
 * proposito: a invariante que ele protege tambem e estrutural ("as duas
 * projecoes tem de concordar"), nao um calculo.
 */

const ROOT = join(__dirname, "..", "..");

/** Chaves de 1o nivel do objeto devolvido pela funcao indicada. */
function chavesDaProjecao(arquivo: string, inicioFn: RegExp): Set<string> {
  const src = readFileSync(join(ROOT, arquivo), "utf8");
  const i = src.search(inicioFn);
  if (i < 0) throw new Error(`funcao nao encontrada em ${arquivo}`);
  const corpo = src.slice(i);
  const r = corpo.indexOf("return {");
  if (r < 0) throw new Error(`"return {" nao encontrado em ${arquivo}`);

  const chaves = new Set<string>();
  let profundidade = 0;
  for (const linha of corpo.slice(r).split(/\r?\n/)) {
    const m = linha.match(/^\s{4,6}([A-Za-z_][A-Za-z0-9_]*):/);
    const abre = (linha.match(/[{[(]/g) ?? []).length;
    const fecha = (linha.match(/[}\])]/g) ?? []).length;
    if (profundidade === 1 && m) chaves.add(m[1]);
    profundidade += abre - fecha;
    if (profundidade <= 0 && chaves.size > 0) break;
  }
  return chaves;
}

// Chaves que legitimamente NAO existem no loadNfe:
//  · reaproveitavel        — derivado (lookupCStat), nao e coluna;
//  · companyFiscalConfigId — o emitente e resolvido antes, a partir do draft
//    carregado pelo repositorio (`findDraftById`); o loadNfe so reidrata a nota
//    ja com numero para montar o XML.
const AUSENCIAS_ACEITAS = new Set(["reaproveitavel", "companyFiscalConfigId"]);

describe("mapeadores de NfeDraftResponse", () => {
  const doRepo = chavesDaProjecao(
    "app/repositories/nfe.repository.ts",
    /function toDraftResponse/,
  );
  const doLoadNfe = chavesDaProjecao(
    "app/usecases/nfe-emission.usecase.ts",
    /private async loadNfe/,
  );

  it("os dois mapeadores foram encontrados e nao estao vazios", () => {
    expect(doRepo.size).toBeGreaterThan(20);
    expect(doLoadNfe.size).toBeGreaterThan(20);
  });

  it("loadNfe projeta todo campo que o repositorio projeta", () => {
    const faltando = [...doRepo].filter(
      (k) => !doLoadNfe.has(k) && !AUSENCIAS_ACEITAS.has(k),
    );
    expect(
      faltando,
      "Campos presentes em toDraftResponse e AUSENTES em loadNfe. " +
        "Eles chegam ao banco e somem na montagem do XML. Copie-os para o " +
        "loadNfe (app/usecases/nfe-emission.usecase.ts) ou, se a ausencia for " +
        "proposital, documente em AUSENCIAS_ACEITAS.",
    ).toEqual([]);
  });

  it("loadNfe nao inventa campo que o repositorio nao tem", () => {
    const sobrando = [...doLoadNfe].filter((k) => !doRepo.has(k));
    expect(sobrando).toEqual([]);
  });

  it("valorFrete esta nos dois (o campo que motivou esta trava)", () => {
    expect(doRepo.has("valorFrete")).toBe(true);
    expect(doLoadNfe.has("valorFrete")).toBe(true);
  });
});
