// @vitest-environment jsdom
//
// O campo de ICMS do `DevolucaoEditor` MONTADO de verdade — mesmo motivo do
// `pendencias-devolucao-tela.spec.tsx` e do
// `step-impostos-devolucao-nao-gerenciada.spec.tsx` ao lado: um teste que lê o
// módulo puro prova que o texto existe, não que ele chega à tela e não que o
// que sai no corpo do PUT mudou.
//
// O caso da DLS AUTO PEÇAS (24/09/2026), ponta a ponta: emitente do Simples
// Nacional (`regimeTributario = "SIMPLES"`, CRT 1) devolvendo uma COMPRA da
// DISAUTO, que é do regime normal. Os itens nascem com CST `00` e `10` vindos do
// XML da fornecedora. O campo decidia pelo TAMANHO do texto digitado
// (`v.length === 3 ? csosn : cst`), salvava o `00`, e a recusa só vinha depois:
// "CST para emitente do Simples (Rejeição 591)". Seis rascunhos e um dia.
//
// O que só o teste MONTADO prova:
//  - `00` não é sequer oferecido no seletor de uma empresa do Simples;
//  - o valor que veio da fornecedora é mostrado como NÃO servindo, com o motivo;
//  - a tela não escolhe um código no lugar dela (o seletor nasce vazio);
//  - não dá para marcar "Revisei a tributação" enquanto o código não serve;
//  - o corpo do PUT leva `{csosn}` escolhido, e nunca mais o `{cst}` da
//    fornecedora nem um par decidido pelo tamanho do texto;
//  - a empresa fora do Simples continua com os 6 CST dela.
//
// Correção de 24/09/2026: o seletor mostra os 12 códigos da allowlist, não 7.
// 103/300/400 e 41/50 têm código próprio no XML — esconder o 400 obrigaria a
// dona da DLS a declarar 102 (tributada) numa peça NÃO tributada.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));

import { DevolucaoEditor } from "../../../app/notas-fiscais/components/devolucao-editor";
import {
  BLOQUEIO_CONFIRMAR,
  ESCOLHA_ANTES_DA_ALIQUOTA,
  ORIGEM_NOTA_ORIGINAL,
  PLACEHOLDER_ICMS,
  SEM_ALIQUOTA,
  TITULO_CODIGO_NAO_SERVE,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-icms-campo";
import { regimeEmitenteDevolucao } from "../../../app/fiscal/devolucao/tributacao";
import type { DevolucaoDetalhe, DevolucaoItemDetalhe } from "../../../app/fiscal/devolucao/contrato";
import type { TributacaoDevolucaoItem } from "../../../app/fiscal/devolucao/tipos";

const EMAIL = "dona@dls.test";
const CHAVE = "35260900011122233000181550010000007101000007108";

/** Os 12 da allowlist, na ordem em que o seletor os mostra. */
const CSOSN = ["102", "103", "300", "400", "500", "900"];
const CST = ["00", "40", "41", "50", "60", "90"];

function tributacao(icms: Partial<TributacaoDevolucaoItem["icms"]>): TributacaoDevolucaoItem {
  return {
    versao: 1,
    fonte: "XML_ORIGINAL",
    icms: { tag: null, cst: null, csosn: null, orig: 0, modBC: null, vBC: 0, pICMS: 0, vICMS: 0, ...icms },
    pis: { cst: "49", vBC: 0, p: 0, v: 0 },
    cofins: { cst: "49", vBC: 0, p: 0, v: 0 },
    ipiDevol: null,
    requerRevisao: true,
    motivosRevisao: ["REGIME_DIVERGENTE"],
    avisos: [],
    confirmada: false,
  };
}

function item(nItem: number, icms: Partial<TributacaoDevolucaoItem["icms"]>): DevolucaoItemDetalhe {
  return {
    ordem: nItem,
    chaveAcesso: CHAVE,
    nItem,
    codigo: `PECA-${nItem}`,
    descricao: nItem === 1 ? "Farol direito" : "Lanterna traseira",
    unidade: "UN",
    ncm: "87081000",
    quantidadeOriginal: 1,
    devolvidaAutorizada: 0,
    emProcessamento: 0,
    disponivel: 1,
    quantidade: 1,
    valorUnitario: 664.58,
    valor: 664.58,
    cfopOriginal: "5102",
    cfop: "5202",
    cfopStatus: "MAPEADO",
    cfopOpcoes: ["5202"],
    tributacao: tributacao(icms),
    requerRevisao: true,
  };
}

/** O rascunho da DLS: Simples Nacional, itens com CST da fornecedora. */
function detalhe(regime: string | null, itens: DevolucaoItemDetalhe[]): DevolucaoDetalhe {
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
    emitente: regimeEmitenteDevolucao(regime),
    originais: [
      {
        chaveAcesso: CHAVE,
        originalNfeId: null,
        modelo: "55",
        numero: 710,
        serie: 1,
        dataEmissao: "2026-09-10",
        destinatarioNome: "DLS AUTO PECAS",
      },
    ],
    itens,
    issues: [],
    podeEmitir: false,
  };
}

const DLS = () => detalhe("SIMPLES", [item(1, { tag: "ICMS00", cst: "00" }), item(2, { tag: null, cst: "10" })]);

let container: HTMLDivElement;
let root: Root;

const texto = () => container.textContent ?? "";
const selects = () => Array.from(container.querySelectorAll("select"));
const seletorIcms = (i = 0) => selects()[i] as HTMLSelectElement;
const opcoesDe = (s: HTMLSelectElement) => Array.from(s.options).map((o) => o.value);
const caixas = () =>
  Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];

async function assentar() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function montar(valor: DevolucaoDetalhe, step = 8) {
  await act(async () => {
    root.render(
      <DevolucaoEditor value={valor} email={EMAIL} step={step} onSaved={async () => {}} />,
    );
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

async function clicar(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await assentar();
}

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

describe("campo de ICMS na tela — DLS AUTO PEÇAS, Simples Nacional", () => {
  it("o `00` da fornecedora nem aparece como opção; só os SEIS CSOSN do Simples", async () => {
    await montar(DLS());
    const s = seletorIcms();
    expect(opcoesDe(s)).toEqual(["", ...CSOSN]);
    for (const c of CST) expect(opcoesDe(s)).not.toContain(c);
    expect(opcoesDe(s)).not.toContain("10");
    // O 400 chega à TELA: é o código da peça não tributada, e a lista de 7 o
    // escondia. Cada opção leva o rótulo dela, não o do grupo.
    expect(opcoesDe(s)).toContain("400");
    const rotulos = Array.from(s.options).map((o) => o.textContent ?? "");
    expect(rotulos.some((r) => r.startsWith("400 — ") && r.includes("Não tributada"))).toBe(true);
    expect(new Set(rotulos).size).toBe(rotulos.length);
    // Um seletor por item, no lugar do campo livre que decidia pelo tamanho.
    expect(selects()).toHaveLength(2);
    expect(s.value).toBe("");
    expect(texto()).toContain(PLACEHOLDER_ICMS);
  });

  it("diz o regime da empresa antes dos itens, uma vez", async () => {
    await montar(DLS());
    const t = texto();
    expect(t).toContain("Sua empresa é do Simples Nacional");
    expect(t).toContain("CSOSN, de 3 dígitos");
    // A orientação do topo é o único texto que enumera — uma vez, uma família só.
    expect(t).toContain("102, 103, 300, 400, 500 ou 900");
  });

  it("recusa na hora o código que veio da nota, com o motivo e sem escolher nada", async () => {
    await montar(DLS());
    const t = texto();
    expect(t).toContain(TITULO_CODIGO_NAO_SERVE);
    expect(t).toContain("00 é CST, de empresa do regime normal");
    expect(t).toContain("A sua empresa é do Simples Nacional");
    expect(t).toContain(ORIGEM_NOTA_ORIGINAL);
    // Um alerta por item incompativel, para leitor de tela.
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(2);
    // E o seletor continua vazio: o Dexo NAO elegeu um codigo parecido. Quem
    // guarda este invariante de verdade e o `icms-campo-devolucao.spec.ts`
    // ("o seletor nasce vazio"): pre-selecionar um codigo que nao esta na lista
    // deixa o `.value` "" e o `selectedIndex` 0 do mesmo jeito, entao o DOM
    // sozinho nao separa os dois casos.
    expect(seletorIcms().value).toBe("");
    expect(seletorIcms(1).value).toBe("");
  });

  it("não dá para marcar `Revisei a tributação` enquanto o código não serve", async () => {
    await montar(DLS());
    const revisei = caixas();
    expect(revisei).toHaveLength(2);
    expect(revisei[0].disabled).toBe(true);
    expect(revisei[0].checked).toBe(false);
    expect(texto()).toContain(BLOQUEIO_CONFIRMAR);
  });

  it("a alíquota de ICMS só é pedida depois da escolha", async () => {
    await montar(DLS());
    expect(texto()).toContain(ESCOLHA_ANTES_DA_ALIQUOTA);
  });

  it("escolhido o 102, a recusa some, a caixa libera e o grupo diz que não leva alíquota", async () => {
    await montar(DLS());
    await escolher(seletorIcms(), "102");
    expect(seletorIcms().value).toBe("102");
    // O item 2 continua travado — a correcao e item a item.
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(caixas()[0].disabled).toBe(false);
    expect(caixas()[1].disabled).toBe(true);
    expect(texto()).toContain(SEM_ALIQUOTA);
  });

  it("escolhido o 900, a tela passa a pedir a alíquota", async () => {
    await montar(DLS());
    const antes = container.querySelectorAll('input[type="number"]').length;
    await escolher(seletorIcms(), "900");
    const numeros = Array.from(container.querySelectorAll('input[type="number"]')) as HTMLInputElement[];
    // quantidade nao aparece no passo de impostos: os number sao as aliquotas.
    // PIS e COFINS ja tinham o campo deles: o que apareceu agora e o do ICMS.
    expect(numeros).toHaveLength(antes + 1);
    expect(texto()).not.toContain(SEM_ALIQUOTA);
  });

  it("o corpo do PUT leva o CSOSN escolhido — nunca mais o CST da fornecedora", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => DLS() }));
    vi.stubGlobal("fetch", fetchMock);
    await montar(DLS());
    await escolher(seletorIcms(), "102");
    await escolher(seletorIcms(1), "500");
    const botao = container.querySelector("button") as HTMLButtonElement;
    await clicar(botao);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/fiscal/nfe/draft/draft-dls/devolucao/itens");
    const corpo = JSON.parse(String(init.body)) as {
      itens: Array<{ tributacao?: { icms?: { cst: string | null; csosn: string | null } } }>;
    };
    expect(corpo.itens[0].tributacao?.icms).toEqual({ csosn: "102", cst: null });
    expect(corpo.itens[1].tributacao?.icms).toEqual({ csosn: "500", cst: null });
    // O CST da DISAUTO nao sai daqui de jeito nenhum.
    expect(String(init.body)).not.toContain('"cst":"00"');
    expect(String(init.body)).not.toContain('"cst":"10"');
  });

  it("sem escolha, `confirmarTributacao` não viaja `true` — é o ciclo dos seis rascunhos", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => DLS() }));
    vi.stubGlobal("fetch", fetchMock);
    const comConfirmada = DLS();
    comConfirmada.itens[0].tributacao.confirmada = true;
    await montar(comConfirmada);
    const botao = container.querySelector("button") as HTMLButtonElement;
    await clicar(botao);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const corpo = JSON.parse(String(init.body)) as {
      itens: Array<{ confirmarTributacao?: boolean; tributacao?: unknown }>;
    };
    expect(corpo.itens[0].confirmarTributacao).toBe(false);
    // E sem mexer no seletor nada de imposto e enviado: "nao mexi" continua
    // sendo nao mexer (senao o servidor gravaria ALTERADA_PELO_USUARIO).
    expect(corpo.itens[0].tributacao).toBeUndefined();
  });
});

describe("campo de ICMS na tela — empresa FORA do Simples não regride", () => {
  const NORMAL = () =>
    detalhe("LUCRO_PRESUMIDO", [item(1, { tag: "ICMS00", cst: "00", modBC: "3", pICMS: 18, vBC: 664.58, vICMS: 119.62 })]);

  it("continua com os CST — agora os 6 —, com o 00 já selecionado e sem recusa", async () => {
    await montar(NORMAL());
    const s = seletorIcms();
    expect(opcoesDe(s)).toEqual(["", ...CST]);
    for (const c of CSOSN) expect(opcoesDe(s)).not.toContain(c);
    expect(s.value).toBe("00");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(caixas()[0].disabled).toBe(false);
    expect(texto()).toContain("Sua empresa é do regime normal");
    // CST 00 leva aliquota — o campo continua la.
    expect(texto()).not.toContain(SEM_ALIQUOTA);
    expect(texto()).not.toContain(ESCOLHA_ANTES_DA_ALIQUOTA);
  });

  it("um CSOSN nesta empresa é recusado citando o CST — o espelho da DLS", async () => {
    await montar(detalhe("LUCRO_PRESUMIDO", [item(1, { tag: "ICMSSN102", csosn: "102" })]));
    expect(texto()).toContain("102 é CSOSN, de empresa do Simples Nacional");
    expect(texto()).toContain("CST, de 2 dígitos");
    // A recusa manda para a lista; a enumeração fica só na orientação do topo.
    expect(texto()).toContain("escolha um na lista");
    expect(texto()).toContain("aqui o código do ICMS é o CST, de 2 dígitos (00, 40, 41, 50, 60 ou 90)");
  });
});

describe("os outros passos do editor seguem iguais", () => {
  it("o passo 3 (quantidade e CFOP) não ganhou seletor de ICMS nem a frase do regime", async () => {
    await montar(DLS(), 3);
    expect(selects()).toHaveLength(0);
    expect(texto()).not.toContain("Sua empresa é do Simples Nacional");
    expect(texto()).toContain("Quantidade");
    expect(texto()).toContain("CFOP");
  });

  it("o passo 1 continua com escopo e entrega", async () => {
    await montar(DLS(), 1);
    expect(texto()).toContain("Escopo");
    expect(texto()).toContain("A mercadoria foi entregue e está sendo devolvida");
  });

  it("PIS e COFINS continuam campos livres de CST, intocados nesta tarefa", async () => {
    await montar(DLS());
    const t = texto();
    expect(t).toContain("PIS CST");
    expect(t).toContain("COFINS CST");
    expect(t).toContain("PIS alíquota (%)");
    expect(t).toContain("COFINS alíquota (%)");
  });
});
