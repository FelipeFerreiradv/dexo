/**
 * Os rótulos dos seletores de imposto da devolução dizem o que a TABELA OFICIAL
 * diz de cada código — revisão fiscal de 24/09/2026.
 *
 * Os rótulos são para a dona do desmanche (número primeiro, explicação simples
 * depois), mas o SIGNIFICADO tem de ser o da tabela: rótulo que descreve errado
 * um código fiscal leva a escolher o código errado, e a SEFAZ autoriza assim
 * mesmo (ela não confere CST de PIS/COFINS com a operação).
 *
 * Caso que motivou: o 49 dizia "o código das vendas do Simples, sem PIS/COFINS
 * na nota". Pela tabela, 49 é "Outras operações de saída", de QUALQUER regime —
 * o PISOutr leva base e alíquota, e a própria tela pede a alíquota dele. Para uma
 * empresa do regime normal devolvendo compra, o rótulo dizia que o código não
 * era dela.
 *
 * Fonte: tabela de CST do PIS/COFINS (Anexo Único da IN RFB 1.009/2010, a que o
 * leiaute da NF-e usa) e o Código de Situação Tributária do ICMS do Convênio
 * s/nº de 1970 (tabela B, com o CSOSN do Simples).
 */
import { describe, expect, it } from "vitest";

import {
  CODIGOS_ICMS_DEVOLUCAO,
  ROTULOS_PIS_COFINS_DEVOLUCAO,
} from "../../../app/fiscal/devolucao/tributacao";
import type { CstPisCofinsDevolucao, TagIcmsDevolucao } from "../../../app/fiscal/devolucao/tipos";

/** O que a tabela oficial diz de cada CST de PIS/COFINS, em trechos que o rótulo TEM de conter. */
const PIS_COFINS_OFICIAL: Readonly<Record<CstPisCofinsDevolucao, readonly string[]>> = {
  "01": ["alíquota básica"],
  "02": ["alíquota diferenciada"],
  "04": ["Monofásica", "revenda"],
  "06": ["Alíquota zero"],
  "07": ["Isenta"],
  "08": ["Sem incidência"],
  "09": ["suspensão"],
  "49": ["Outras operações de saída"],
  "50": ["direito a crédito", "só a receita tributada no mercado interno"],
  "51": ["direito a crédito", "só a receita não tributada no mercado interno"],
  "52": ["direito a crédito", "só a receita de exportação"],
  "53": ["direito a crédito", "tributadas e não tributadas no mercado interno"],
  "54": ["direito a crédito", "tributadas no mercado interno e de exportação"],
  "55": ["direito a crédito", "não tributadas no mercado interno e de exportação"],
  "56": ["direito a crédito", "tributadas, não tributadas e de exportação"],
  "60": ["Crédito presumido", "só a receita tributada no mercado interno"],
  "61": ["Crédito presumido", "só a receita não tributada no mercado interno"],
  "62": ["Crédito presumido", "só a receita de exportação"],
  "63": ["Crédito presumido", "tributadas e não tributadas no mercado interno"],
  "64": ["Crédito presumido", "tributadas no mercado interno e de exportação"],
  "65": ["Crédito presumido", "não tributadas no mercado interno e de exportação"],
  "66": ["Crédito presumido", "tributadas, não tributadas e de exportação"],
  "67": ["Crédito presumido", "outras operações"],
  "70": ["sem direito a crédito"],
  "71": ["isenção"],
  "72": ["suspensão"],
  "73": ["alíquota zero"],
  "74": ["sem incidência"],
  "75": ["substituição tributária"],
  "98": ["Outras entradas"],
  "99": ["Outras operações"],
};

/** Tabela B do ICMS: CSOSN (Simples) e CST (regime normal), só os que a devolução emite. */
const ICMS_OFICIAL: Readonly<Record<string, readonly string[]>> = {
  "102": ["Simples", "sem crédito"],
  "103": ["Isenta", "faixa de receita"],
  "300": ["Imune"],
  "400": ["Não tributada"],
  "500": ["já cobrado antes", "substituição tributária"],
  "900": ["Outros"],
  "00": ["Tributada integralmente"],
  "40": ["Isenta"],
  "41": ["Não tributada"],
  "50": ["Suspensão"],
  "60": ["já cobrado antes", "substituição tributária"],
  "90": ["Outras"],
};

describe("PIS/COFINS: cada rótulo diz o que a tabela oficial diz do código", () => {
  it.each(Object.entries(PIS_COFINS_OFICIAL))("CST %s", (codigo, trechos) => {
    const rotulo = ROTULOS_PIS_COFINS_DEVOLUCAO[codigo as CstPisCofinsDevolucao];
    expect(rotulo.startsWith(`${codigo} — `)).toBe(true);
    for (const t of trechos) expect(rotulo.toLowerCase()).toContain(t.toLowerCase());
  });

  it("a tabela acima cobre todos os rótulos (código novo sem conferência quebra aqui)", () => {
    expect(Object.keys(PIS_COFINS_OFICIAL).sort()).toEqual(Object.keys(ROTULOS_PIS_COFINS_DEVOLUCAO).sort());
  });

  it("rótulo de código de SAÍDA (01–49) não fala em entrada, e os de ENTRADA (50–98) não se vendem como saída", () => {
    for (const [codigo, rotulo] of Object.entries(ROTULOS_PIS_COFINS_DEVOLUCAO)) {
      const n = Number(codigo);
      if (n <= 49) expect(rotulo.toLowerCase()).not.toContain("entrada");
      if (n >= 50 && n <= 98) expect(rotulo.toLowerCase()).not.toContain("saída");
    }
  });

  it("49 é código de saída de qualquer regime: o rótulo não o diz exclusivo do Simples", () => {
    const r49 = ROTULOS_PIS_COFINS_DEVOLUCAO["49"];
    expect(r49).toMatch(/^49 — Outras operações de saída/);
    // A menção ao Simples, quando houver, é qualificada ("no Simples, …"), não a definição do código.
    expect(r49).not.toMatch(/^49 — [^(]*Simples/);
  });
});

describe("ICMS: cada rótulo diz o que a tabela B diz do CST/CSOSN", () => {
  const todos = (Object.keys(CODIGOS_ICMS_DEVOLUCAO) as TagIcmsDevolucao[]).flatMap((tag) => CODIGOS_ICMS_DEVOLUCAO[tag]);

  it.each(Object.entries(ICMS_OFICIAL))("%s", (codigo, trechos) => {
    const opcao = todos.find((o) => o.codigo === codigo);
    expect(opcao, `sem rótulo para ${codigo}`).toBeDefined();
    expect(opcao!.rotulo.startsWith(`${codigo} — `)).toBe(true);
    for (const t of trechos) expect(opcao!.rotulo.toLowerCase()).toContain(t.toLowerCase());
  });

  it("a tabela acima cobre todos os códigos de ICMS oferecidos", () => {
    expect(todos.map((o) => o.codigo).sort()).toEqual(Object.keys(ICMS_OFICIAL).sort());
  });
});
