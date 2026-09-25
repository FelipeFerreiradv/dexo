// @vitest-environment jsdom
//
// O passo 8 ("Impostos") do `DevolucaoEditor` MONTADO: PIS/COFINS, alíquotas,
// IPI devolvido, os valores calculados e o total da nota.
//
// Casos reais (DLS AUTO PEÇAS, Simples Nacional, 24/09/2026 — devolução de
// compra à DISAUTO, itens 33603-3 e 24171-7):
//  - K1: PIS/COFINS eram texto livre ("CST"); ela chutou 01/49/01/49 por 70 min.
//  - K3 / N-pis-cofins-ipi-4: digitar o CST apagava a alíquota digitada antes.
//  - K4: a alíquota do ICMS mostrava um número e salvava outro (900→102→900), e
//    a caixa apagada virava 0%.
//  - N-fluxo-6: a caixa era `defaultValue` — mostrava 1,65% com 0% gravado.
//  - N-pis-cofins-ipi-8: o 04 (monofásico) mostrava caixa de alíquota.
//  - N-pis-cofins-ipi-5/6, N-fluxo-8: nenhum valor de imposto nem o total da nota.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));

import { DevolucaoEditor } from "../../../app/notas-fiscais/components/devolucao-editor";
import {
  DICA_ALIQUOTA_COMPRA,
  IPI_NAO_DEVOLVER,
  IPI_NAO_DEVOLVER_AVISO,
  REVISAO_DEPOIS_DE_SALVAR,
  SEM_REFERENCIA_ORIGINAL,
  TITULO_TOTAIS,
  TRAVADO_IMPOSTOS,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-editor-ui";
import { BLOQUEIO_CONFIRMAR_PIS_COFINS } from "../../../app/notas-fiscais/lib/nfe-devolucao-pis-cofins-campo";
import { referenciaImpostoOriginal, normalizarImpostoOriginal, regimeEmitenteDevolucao } from "../../../app/fiscal/devolucao/tributacao";
import type { DevolucaoDetalhe, DevolucaoItemDetalhe } from "../../../app/fiscal/devolucao/contrato";
import type { TributacaoDevolucaoItem } from "../../../app/fiscal/devolucao/tipos";

const EMAIL = "dona@dls.test";
const CHAVE = "42260980689839000975550010008528991757991829";

function trib(p: Partial<TributacaoDevolucaoItem> = {}): TributacaoDevolucaoItem {
  return {
    versao: 1,
    fonte: "XML_ORIGINAL",
    icms: { tag: "ICMSSN102", cst: null, csosn: "102", orig: 0, modBC: null, vBC: 0, pICMS: 0, vICMS: 0 },
    pis: { cst: "49", vBC: 0, p: 0, v: 0 },
    cofins: { cst: "49", vBC: 0, p: 0, v: 0 },
    ipiDevol: null,
    requerRevisao: true,
    motivosRevisao: [],
    avisos: [],
    confirmada: false,
    ...p,
  };
}

const ICMS00_FORNECEDOR: TributacaoDevolucaoItem["icms"] = {
  tag: "ICMS00", cst: "00", csosn: null, orig: 0, modBC: "3", vBC: 123.56, pICMS: 12, vICMS: 14.83,
};

function item(nItem: number, t: TributacaoDevolucaoItem, extra: Partial<DevolucaoItemDetalhe> = {}): DevolucaoItemDetalhe {
  return {
    ordem: nItem === 5 ? 1 : 2,
    chaveAcesso: CHAVE,
    nItem,
    codigo: nItem === 5 ? "33603-3" : "24171-7",
    descricao: nItem === 5 ? "RETENTOR" : "BOMBA OLEO",
    unidade: "UN",
    ncm: "84133090",
    quantidadeOriginal: 1,
    devolvidaAutorizada: 0,
    emProcessamento: 0,
    disponivel: 1,
    quantidade: 1,
    valorUnitario: 123.56,
    valor: 123.56,
    cfopOriginal: "5102",
    cfop: "5202",
    cfopStatus: "ESCOLHA",
    cfopOpcoes: ["5202"],
    tributacao: t,
    requerRevisao: true,
    ...extra,
  };
}

function detalhe(regime: string, itens: DevolucaoItemDetalhe[], extra: Partial<DevolucaoDetalhe> = {}): DevolucaoDetalhe {
  return {
    draftId: "draft-dls",
    status: "DRAFT",
    tipo: "COMPRA_SAIDA",
    fonte: "XML_IMPORTADO",
    escopo: "PARCIAL",
    devolvidaAposEntrega: true,
    confirmadoSemXml: false,
    indFinal: "0",
    modoReferencia: "ITEM",
    emitente: regimeEmitenteDevolucao(regime, "COMPRA_SAIDA"),
    originais: [{ chaveAcesso: CHAVE, originalNfeId: null, modelo: "55", numero: 852899, serie: 1, dataEmissao: "2026-09-10", destinatarioNome: null }],
    itens,
    issues: [],
    podeEmitir: false,
    ...extra,
  };
}

let container: HTMLDivElement;
let root: Root;
const texto = () => container.textContent ?? "";
const linha = (nItem: number) => container.querySelector(`[data-linha="${CHAVE}#${nItem}"]`) as HTMLElement;
const sel = (nItem: number, rotulo: string) => linha(nItem).querySelector(`select[aria-label="${rotulo}"]`) as HTMLSelectElement;
const inp = (nItem: number, rotulo: string) => linha(nItem).querySelector(`input[aria-label="${rotulo}"]`) as HTMLInputElement | null;
const revisei = (nItem: number) =>
  Array.from(linha(nItem).querySelectorAll('input[type="checkbox"]')).find((c) =>
    (c.parentElement?.textContent ?? "").includes("Revisei a tributação deste item"),
  ) as HTMLInputElement;
const salvar = () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Salvar devolução") as HTMLButtonElement;
const corpoDe = (f: { mock: { calls: unknown[][] } }, n = 0) => JSON.parse(String((f.mock.calls[n] as unknown as [string, RequestInit])[1].body));

async function assentar() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
async function montar(v: DevolucaoDetalhe) {
  await act(async () => {
    root.render(<DevolucaoEditor value={v} email={EMAIL} step={8} onSaved={async () => {}} />);
  });
  await assentar();
}
async function escolher(s: HTMLSelectElement, valor: string) {
  await act(async () => {
    s.value = valor;
    s.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await assentar();
}
async function digitar(el: HTMLInputElement, valor: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, valor);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await assentar();
}
async function clicar(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await assentar();
}
function ecoar() {
  return vi.fn(async () => ({ ok: true, json: async () => ultimo }));
}
let ultimo: DevolucaoDetalhe;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe("K1 — PIS/COFINS são seletores; o 01 da DISAUTO não serve no Simples", () => {
  const DLS01 = () =>
    detalhe("SIMPLES", [
      item(5, trib({ pis: { cst: "01", vBC: 0, p: 0, v: 0 }, cofins: { cst: "01", vBC: 0, p: 0, v: 0 } })),
    ]);

  it("o seletor nasce vazio, sem 01/02, com UM quadro dizendo por quê; a revisão trava", async () => {
    await montar(DLS01());
    const pis = sel(5, "Código do PIS (CST)");
    expect(pis.value).toBe("");
    const codigos = Array.from(pis.options).map((o) => o.value);
    expect(codigos).not.toContain("01");
    expect(codigos).not.toContain("02");
    expect(codigos).toContain("49");
    expect(linha(5).textContent).toContain("O código do PIS e da COFINS deste item não serve para a sua empresa");
    expect(linha(5).querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(revisei(5).disabled).toBe(true);
    expect(linha(5).textContent).toContain(BLOQUEIO_CONFIRMAR_PIS_COFINS);
    // Sem código que sirva, não há alíquota a pedir.
    expect(inp(5, "Alíquota do PIS (%)")).toBeNull();
  });

  it("escolhido o 49 nos dois: o corpo leva {cst, p} — o par inteiro — e a revisão libera", async () => {
    ultimo = DLS01();
    const f = ecoar();
    vi.stubGlobal("fetch", f);
    await montar(DLS01());
    await escolher(sel(5, "Código do PIS (CST)"), "49");
    await escolher(sel(5, "Código da COFINS (CST)"), "49");
    expect(revisei(5).disabled).toBe(false);
    expect(inp(5, "Alíquota do PIS (%)")!.value).toBe("0");
    await clicar(salvar());
    expect(corpoDe(f).itens[0].tributacao).toEqual({ pis: { cst: "49", p: 0 }, cofins: { cst: "49", p: 0 } });
  });

  it("o texto do topo diz, uma vez, que 01/02 não servem no Simples", async () => {
    await montar(DLS01());
    expect(texto()).toContain("os códigos 01 e 02");
  });
});

describe("N-pis-cofins-ipi-8 — o 04 não leva alíquota; o seletor mostra o código gravado", () => {
  it("24171-7 com 04 gravado: seletor em 04 e nenhuma caixa de alíquota", async () => {
    await montar(detalhe("SIMPLES", [item(6, trib({ pis: { cst: "04", vBC: 0, p: 0, v: 0 }, cofins: { cst: "04", vBC: 0, p: 0, v: 0 } }))]));
    expect(sel(6, "Código do PIS (CST)").value).toBe("04");
    expect(inp(6, "Alíquota do PIS (%)")).toBeNull();
    expect(linha(6).textContent).toContain("Este código não leva alíquota: o PIS sai sem valor na nota.");
  });
});

describe("N-fluxo-6 / N-pis-cofins-ipi-4 / K3 — a caixa mostra o gravado e o corpo leva a caixa", () => {
  const NORMAL = () =>
    detalhe("LUCRO_REAL", [
      item(6, trib({
        fonte: "USUARIO",
        icms: { tag: "ICMS40", cst: "40", csosn: null, orig: 0, modBC: null, vBC: 0, pICMS: 0, vICMS: 0 },
        pis: { cst: "01", vBC: 295.88, p: 1.65, v: 4.88 },
        cofins: { cst: "01", vBC: 295.88, p: 7.6, v: 22.49 },
      })),
    ]);

  it("a alíquota é CONTROLADA e nasce do gravado (era `defaultValue`)", async () => {
    await montar(NORMAL());
    expect(inp(6, "Alíquota do PIS (%)")!.value).toBe("1.65");
    expect(inp(6, "Alíquota da COFINS (%)")!.value).toBe("7.6");
  });

  it("alíquota digitada ANTES do CST não se perde: o corpo leva as duas", async () => {
    ultimo = NORMAL();
    const f = ecoar();
    vi.stubGlobal("fetch", f);
    await montar(NORMAL());
    await digitar(inp(6, "Alíquota do PIS (%)")!, "3");
    await escolher(sel(6, "Código do PIS (CST)"), "02");
    expect(inp(6, "Alíquota do PIS (%)")!.value).toBe("3");
    await clicar(salvar());
    expect(corpoDe(f).itens[0].tributacao).toEqual({ pis: { cst: "02", p: 3 } });
  });

  it("'Desfazer alterações' volta a caixa ao GRAVADO — prova de que ela mostra o estado, não o que ficou no DOM", async () => {
    await montar(NORMAL());
    await digitar(inp(6, "Alíquota do PIS (%)")!, "3");
    const desfazer = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Desfazer alterações")!;
    await clicar(desfazer);
    expect(inp(6, "Alíquota do PIS (%)")!.value).toBe("1.65");
  });

  it("trocar só o CST leva a alíquota que a caixa mostra, e não mexe na COFINS", async () => {
    ultimo = NORMAL();
    const f = ecoar();
    vi.stubGlobal("fetch", f);
    await montar(NORMAL());
    await escolher(sel(6, "Código do PIS (CST)"), "02");
    await clicar(salvar());
    expect(corpoDe(f).itens[0].tributacao).toEqual({ pis: { cst: "02", p: 1.65 } });
  });
});

describe("K4 — a alíquota do ICMS: a tela e o corpo dizem o mesmo número", () => {
  const DLS00 = () => detalhe("SIMPLES", [item(5, trib({ icms: ICMS00_FORNECEDOR }))]);

  it("900 → digita 5 → 102 → 900: a caixa mostra 5 e o corpo leva 5", async () => {
    ultimo = DLS00();
    const f = ecoar();
    vi.stubGlobal("fetch", f);
    await montar(DLS00());
    const icms = () => sel(5, "Código do ICMS (CSOSN — Simples Nacional)");
    await escolher(icms(), "900");
    expect(inp(5, "ICMS alíquota (%)")!.value).toBe("12");
    expect(linha(5).textContent).toContain(DICA_ALIQUOTA_COMPRA);
    await digitar(inp(5, "ICMS alíquota (%)")!, "5");
    await escolher(icms(), "102");
    await escolher(icms(), "900");
    expect(inp(5, "ICMS alíquota (%)")!.value).toBe("5");
    await clicar(salvar());
    expect(corpoDe(f).itens[0].tributacao.icms).toEqual({ csosn: "900", cst: null, pICMS: 5 });
  });

  it("caixa apagada: 'Informe a alíquota', salvar travado, NENHUM PUT com 0%", async () => {
    const f = ecoar();
    vi.stubGlobal("fetch", f);
    await montar(DLS00());
    await escolher(sel(5, "Código do ICMS (CSOSN — Simples Nacional)"), "900");
    await digitar(inp(5, "ICMS alíquota (%)")!, "");
    expect(linha(5).textContent).toContain("Informe a alíquota do ICMS (de 0 a 100).");
    expect(salvar().disabled).toBe(true);
    expect(texto()).toContain(TRAVADO_IMPOSTOS);
    await clicar(salvar());
    expect(f).not.toHaveBeenCalled();
  });

  it("mudança que muda VALOR: 'Revisei' só depois de salvar e ver o valor novo", async () => {
    await montar(DLS00());
    await escolher(sel(5, "Código do ICMS (CSOSN — Simples Nacional)"), "900");
    expect(revisei(5).disabled).toBe(true);
    expect(linha(5).textContent).toContain(REVISAO_DEPOIS_DE_SALVAR);
  });
});

describe("mexer em PIS/COFINS desmarca o 'Revisei' (como o ICMS já fazia)", () => {
  it("revisado, troca o PIS para 04: a caixinha desmarca e o corpo vai sem confirmação", async () => {
    const v = detalhe("SIMPLES", [item(5, trib({ confirmada: true }))]);
    ultimo = v;
    const f = ecoar();
    vi.stubGlobal("fetch", f);
    await montar(v);
    expect(revisei(5).checked).toBe(true);
    await escolher(sel(5, "Código do PIS (CST)"), "04");
    expect(revisei(5).checked).toBe(false);
    await clicar(salvar());
    expect(corpoDe(f).itens[0]).toMatchObject({ confirmarTributacao: false, tributacao: { pis: { cst: "04", p: 0 } } });
  });
});

describe("N-pis-cofins-ipi-6 / N-fluxo-8 — os valores e o total ANTES de emitir", () => {
  const imposto = normalizarImpostoOriginal({
    ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "3", vBC: "123.56", pICMS: "12.00", vICMS: "14.83" } },
    PIS: { PISAliq: { CST: "01", vBC: "108.73", pPIS: "1.65", vPIS: "1.79" } },
    COFINS: { COFINSAliq: { CST: "01", vBC: "108.73", pCOFINS: "7.60", vCOFINS: "8.26" } },
  });
  const COM_VALORES = () =>
    detalhe(
      "SIMPLES",
      [
        item(
          5,
          trib({
            fonte: "USUARIO",
            icms: { tag: "ICMSSN900", cst: null, csosn: "900", orig: 0, modBC: "3", vBC: 123.56, pICMS: 12, vICMS: 14.83 },
            pis: { cst: "49", vBC: 108.73, p: 1.65, v: 1.79 },
          }),
          { referenciaOriginal: referenciaImpostoOriginal({ impostoOriginal: imposto, quantidadeOriginal: 1, quantidade: 1, tipo: "COMPRA_SAIDA" }) },
        ),
      ],
      {
        totais: {
          totalProdutos: 123.56, totalDesconto: 0, totalFrete: 0, totalBcIcms: 123.56, totalIcms: 14.83,
          totalPis: 1.79, totalCofins: 0, totalIpiDevol: 0, totalNota: 123.56, completo: false, itensPendentes: [1],
        },
      },
    );

  it("cada item mostra o valor de cada imposto, com a base", async () => {
    await montar(COM_VALORES());
    const t = linha(5).textContent ?? "";
    expect(t).toContain("ICMS: base R$ 123,56 × 12% = R$ 14,83");
    expect(t).toContain("PIS: base R$ 108,73 × 1,65% = R$ 1,79");
    expect(t).toContain("COFINS: sem valor na nota");
  });

  it("o imposto da nota do fornecedor aparece ao lado, como referência", async () => {
    await montar(COM_VALORES());
    const t = linha(5).textContent ?? "";
    expect(t).toContain("Na nota do fornecedor: CST 00 · base R$ 123,56 · 12% · ICMS R$ 14,83.");
    expect(t).toContain("Na nota do fornecedor: PIS CST 01 · base R$ 108,73 · 1,65% · R$ 1,79.");
  });

  it("o quadro de totais mostra o valor da nota e diz 'prévia' enquanto falta fechar", async () => {
    await montar(COM_VALORES());
    const quadro = container.querySelector(`[aria-label="${TITULO_TOTAIS}"]`)!;
    expect(quadro.textContent).toContain("Valor da nota");
    expect(quadro.textContent).toContain("R$ 123,56");
    expect(quadro.textContent).toContain("Prévia: ainda falta fechar a tributação do item 1");
    expect(quadro.textContent).toContain("R$ 14,83");
  });

  it("devolução pela chave (sem XML): diz que não há imposto original para conferir", async () => {
    await montar(detalhe("SIMPLES", [item(5, trib(), { referenciaOriginal: null })]));
    expect(linha(5).textContent).toContain(SEM_REFERENCIA_ORIGINAL);
  });
});

describe("N-pis-cofins-ipi-5 — o IPI devolvido aparece e pode ser retirado, com o aviso", () => {
  it("mostra o IPI devolvido; 'Não devolver' avisa do crédito, desmarca a revisão e manda ipiDevol:false", async () => {
    const v = detalhe("SIMPLES", [item(5, trib({ confirmada: true, ipiDevol: { pDevol: 100, vIPIDevol: 6.5 }, motivosRevisao: ["IPI_DESTACADO"] }))]);
    ultimo = v;
    const f = ecoar();
    vi.stubGlobal("fetch", f);
    await montar(v);
    expect(linha(5).textContent).toContain("IPI devolvido: 100% do IPI da nota original = R$ 6,50");
    expect(linha(5).textContent).toContain(IPI_NAO_DEVOLVER_AVISO);
    const caixa = Array.from(linha(5).querySelectorAll('input[type="checkbox"]')).find((c) =>
      (c.parentElement?.textContent ?? "").includes(IPI_NAO_DEVOLVER),
    ) as HTMLInputElement;
    expect(caixa.checked).toBe(false);
    await clicar(caixa);
    expect(revisei(5).checked).toBe(false);
    await clicar(salvar());
    expect(corpoDe(f).itens[0]).toMatchObject({ confirmarTributacao: false, tributacao: { ipiDevol: false } });
  });
});

describe("aviso de sentido e recusa do servidor", () => {
  it("CST de entrada numa devolução de compra: aviso junto do campo, sem travar", async () => {
    await montar(detalhe("LUCRO_REAL", [item(5, trib({
      icms: { tag: "ICMS40", cst: "40", csosn: null, orig: 0, modBC: null, vBC: 0, pICMS: 0, vICMS: 0 },
      pis: { cst: "50", vBC: 0, p: 0, v: 0 },
    }))]));
    expect(linha(5).textContent).toContain("O CST 50 é de entrada, e esta devolução é uma nota de saída.");
    expect(salvar().disabled).toBe(false);
  });

  it("422 do servidor com a recusa do PIS: a frase aparece na peça, sem o 'Item N:'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({
          error: "Tributação não suportada na devolução.",
          code: "TRIBUTACAO_NAO_SUPORTADA",
          issues: [{ code: "PIS_COFINS_REGIME_INCOMPATIVEL", severidade: "ERRO", ordem: 1, mensagem: "Item 1: PIS: O CST 01 é de empresa do regime normal." }],
        }),
      })),
    );
    await montar(detalhe("SIMPLES", [item(5, trib())]));
    await clicar(salvar());
    expect(linha(5).textContent).toContain("PIS: O CST 01 é de empresa do regime normal.");
    expect(texto()).toContain("O código do PIS/COFINS é de empresa do regime normal no item 1");
  });
});
