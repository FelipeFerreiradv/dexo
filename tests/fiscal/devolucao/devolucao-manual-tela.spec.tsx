// @vitest-environment jsdom
//
// O quadro "Devolução manual" MONTADO de verdade (lista de Notas Emitidas).
//
// O que a DLS AUTO PEÇAS passou nele (24/09/2026) e só o teste montado prova
// que acabou:
//  - 4 × "Dados da requisição inválidos." em 3 segundos: o motivo vinha em
//    `erros[]` e a tela jogava fora; o botão criava sem arquivo escolhido;
//  - cada rascunho nascia com as 6 peças da nota na quantidade cheia, e ela
//    zerava 4 à mão (o que derrubava a tela e apagava as peças);
//  - a chave colada do DANFE (com espaços) era cortada em 44 caracteres;
//  - "45," virava "NaN" no valor unitário;
//  - na devolução de COMPRA ela digitava CNPJ e UF que a chave já dizia.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ navegacoes: [] as string[] }));
vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));
vi.mock("../../../app/notas-fiscais/lib/nfe-navegacao", () => ({ navegarPara: (u: string) => h.navegacoes.push(u) }));

import { DevolucaoManual, XML_GRANDE_DEMAIS } from "../../../app/notas-fiscais/components/devolucao-manual";
import { CONFIRA_OS_CAMPOS, ESCOLHA_UMA_PECA } from "../../../app/notas-fiscais/lib/nfe-devolucao-manual-ui";
import { calcularDvChaveAcesso } from "../../../app/fiscal/domain/chave-acesso-dv";

const API = "http://api.test";
const EMAIL = "dona@dls.test";
const CNPJ_FORNECEDOR = "11222333000181";
const base = `422609${CNPJ_FORNECEDOR}55001000991757112345678`;
const CHAVE = base + calcularDvChaveAcesso(base);
const CHAVE_DANFE = CHAVE.replace(/(\d{4})(?=\d)/g, "$1 ");

const PREVIA = {
  chaveAcesso: CHAVE,
  numero: 991757,
  serie: 1,
  emitenteCnpjCpf: CNPJ_FORNECEDOR,
  destinatarioNome: "DISAUTO DISTRIBUIDORA",
  rascunhoAberto: null as string | null,
  itens: [
    { nItem: 1, codigo: "M1", descricao: "Motor parcial", unidade: "UN", valorUnitario: 900, quantidadeOriginal: 3, devolvidaAutorizada: 0, emProcessamento: 0, emRascunho: 0, disponivel: 3, cfopOriginal: "5655", cfopSugerido: null, cfopOpcoes: [], cfopStatus: "SEM_MAPEAMENTO" },
    { nItem: 5, codigo: "F5", descricao: "Farol direito", unidade: "UN", valorUnitario: 664.58, quantidadeOriginal: 1, devolvidaAutorizada: 0, emProcessamento: 0, emRascunho: 0, disponivel: 1, cfopOriginal: "5102", cfopSugerido: "5202", cfopOpcoes: ["5202"], cfopStatus: "MAPEADO" },
    { nItem: 6, codigo: "L6", descricao: "Lanterna", unidade: "UN", valorUnitario: 200, quantidadeOriginal: 1, devolvidaAutorizada: 1, emProcessamento: 0, emRascunho: 0, disponivel: 0, cfopOriginal: "5102", cfopSugerido: "5202", cfopOpcoes: ["5202"], cfopStatus: "MAPEADO" },
  ],
};

type Resp = { status: number; body?: unknown };
let container: HTMLDivElement;
let root: Root;
let chamadas: Array<{ metodo: string; url: string; corpo: any }>;
let rotas: Record<string, Resp[]>;

const texto = () => container.textContent ?? "";
const botao = (rotulo: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === rotulo) as HTMLButtonElement | undefined;
const campo = (rotulo: string, n = 0) =>
  Array.from(container.querySelectorAll("label")).filter((l) => (l.textContent ?? "").trim().startsWith(rotulo))[n]?.querySelector("input,select") as
    | HTMLInputElement
    | HTMLSelectElement
    | undefined;
const alertas = () => Array.from(container.querySelectorAll('[role="alert"]')).map((a) => a.textContent ?? "");

async function assentar(vezes = 4) {
  for (let i = 0; i < vezes; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function clicar(el: HTMLElement | undefined) {
  if (!el) throw new Error(`elemento ausente. Texto: ${texto()}`);
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await assentar();
}
async function digitar(el: HTMLInputElement | HTMLSelectElement | undefined, valor: string) {
  if (!el) throw new Error(`campo ausente. Texto: ${texto()}`);
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, valor);
  await act(async () => { el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
  await assentar();
}
async function marcar(el: HTMLInputElement | undefined) { await clicar(el); }
async function escolherArquivo(tamanho = 5000) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: [{ name: "nota.xml", size: tamanho, text: async () => "<nfeProc>…</nfeProc>" }] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await assentar(6);
}
async function montar(url = "/notas-fiscais/emitidas") {
  window.history.replaceState({}, "", url);
  await act(async () => { root.render(<DevolucaoManual email={EMAIL} />); });
  await assentar(6);
}
const abrir = () => clicar(botao("Devolução manual"));

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  chamadas = [];
  h.navegacoes = [];
  rotas = {
    "GET /fiscal/nfe/devolucao/disponibilidade": [{ status: 200, body: { disponivel: true, companyFiscalConfigId: "cfg-dls" } }],
    "POST /fiscal/nfe/devolucao/manual/previa": [{ status: 200, body: PREVIA }],
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const metodo = init?.method ?? "GET";
    const caminho = url.replace(API, "");
    chamadas.push({ metodo, url: caminho, corpo: init?.body ? JSON.parse(String(init.body)) : undefined });
    const fila = rotas[`${metodo} ${caminho}`];
    const r = fila && (fila.length > 1 ? fila.shift() : fila[0]);
    if (!r) throw new Error(`chamada inesperada: ${metodo} ${caminho}`);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} };
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const posts = (caminho: string) => chamadas.filter((c) => c.metodo === "POST" && c.url === caminho);

describe("pelo XML — ela escolhe as peças antes de criar", () => {
  it("sem arquivo, o botão de criar fica travado (o 400 'XML vazio' de 24/09)", async () => {
    await montar();
    await abrir();
    expect(botao("Criar rascunho de devolução")!.disabled).toBe(true);
  });

  it("lido o XML, lista as peças SEM nenhuma marcada; a já devolvida não dá para marcar", async () => {
    await montar();
    await abrir();
    await escolherArquivo();
    expect(posts("/fiscal/nfe/devolucao/manual/previa")[0].corpo).toEqual({ companyFiscalConfigId: "cfg-dls", tipo: "COMPRA_SAIDA", xmlOriginal: "<nfeProc>…</nfeProc>" });
    const caixas = Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(caixas).toHaveLength(3);
    expect(caixas.every((c) => !c.checked)).toBe(true);
    expect(caixas[2].disabled).toBe(true);
    expect(texto()).toContain("NF-e 991757 (série 1) — devolução para DISAUTO DISTRIBUIDORA");
    expect(texto()).toContain("pode devolver: 3");
  });

  it("criar sem marcar nada ⇒ pede para marcar, e NÃO cria", async () => {
    await montar();
    await abrir();
    await escolherArquivo();
    await clicar(botao("Criar rascunho de devolução"));
    expect(alertas()).toContain(ESCOLHA_UMA_PECA);
    expect(posts("/fiscal/nfe/devolucao/manual")).toHaveLength(0);
  });

  it("marcou só o item 5 ⇒ o corpo leva SÓ ele, e abre o rascunho novo", async () => {
    rotas["POST /fiscal/nfe/devolucao/manual"] = [{ status: 201, body: { draftId: "n1", reutilizado: false } }];
    await montar();
    await abrir();
    await escolherArquivo();
    await marcar(container.querySelector('input[aria-label="Devolver o item 5"]') as HTMLInputElement);
    expect((container.querySelector('input[aria-label="Quantidade do item 5"]') as HTMLInputElement).value).toBe("1");
    await clicar(botao("Criar rascunho de devolução"));
    expect(posts("/fiscal/nfe/devolucao/manual")[0].corpo).toEqual({ companyFiscalConfigId: "cfg-dls", tipo: "COMPRA_SAIDA", xmlOriginal: "<nfeProc>…</nfeProc>", itens: [{ nItem: 5, quantidade: 1 }] });
    expect(h.navegacoes).toEqual(["/notas-fiscais/nfe?draft=n1"]);
  });

  it("quantidade com vírgula e acima do saldo: recusa no item, sem criar", async () => {
    await montar();
    await abrir();
    await escolherArquivo();
    await marcar(container.querySelector('input[aria-label="Devolver o item 1"]') as HTMLInputElement);
    await digitar(container.querySelector('input[aria-label="Quantidade do item 1"]') as HTMLInputElement, "3,5");
    await clicar(botao("Criar rascunho de devolução"));
    expect(texto()).toContain("Só dá para devolver 3 desta peça.");
    expect(posts("/fiscal/nfe/devolucao/manual")).toHaveLength(0);
  });

  it("já havia devolução aberta desta nota ⇒ avisa e leva a ELA (em vez de criar a 6ª)", async () => {
    rotas["POST /fiscal/nfe/devolucao/manual/previa"] = [{ status: 200, body: { ...PREVIA, rascunhoAberto: "velho" } }];
    await montar();
    await abrir();
    await escolherArquivo();
    expect(texto()).toContain("Você já tem uma devolução de compra desta nota em andamento");
    const link = Array.from(container.querySelectorAll("a")).find((a) => a.textContent === "Abrir a devolução em andamento")!;
    expect(link.getAttribute("href")).toBe("/notas-fiscais/nfe?draft=velho&reaproveitada=1");
    expect(botao("Criar rascunho de devolução")!.disabled).toBe(true);
  });

  it("servidor reaproveitou ⇒ o assistente abre com o aviso", async () => {
    rotas["POST /fiscal/nfe/devolucao/manual"] = [{ status: 200, body: { draftId: "velho", reutilizado: true } }];
    await montar();
    await abrir();
    await escolherArquivo();
    await marcar(container.querySelector('input[aria-label="Devolver o item 5"]') as HTMLInputElement);
    await clicar(botao("Criar rascunho de devolução"));
    expect(h.navegacoes).toEqual(["/notas-fiscais/nfe?draft=velho&reaproveitada=1"]);
  });

  it("arquivo acima de 1 MB: diz o que houve, não lê e não deixa criar", async () => {
    await montar();
    await abrir();
    await escolherArquivo(2_000_000);
    expect(alertas()).toContain(XML_GRANDE_DEMAIS);
    expect(posts("/fiscal/nfe/devolucao/manual/previa")).toHaveLength(0);
    expect(botao("Criar rascunho de devolução")!.disabled).toBe(true);
  });

  it("a prévia recusou o arquivo ⇒ mostra o MOTIVO do servidor, não a frase genérica", async () => {
    rotas["POST /fiscal/nfe/devolucao/manual/previa"] = [{ status: 400, body: { error: "Dados da requisição inválidos.", code: "PAYLOAD_INVALIDO", erros: [{ campo: "xmlOriginal", mensagem: "XML vazio." }] } }];
    await montar();
    await abrir();
    await escolherArquivo();
    expect(alertas()).toContain("XML vazio.");
    expect(alertas()).toContain(CONFIRA_OS_CAMPOS);
    expect(texto()).not.toContain("Dados da requisição inválidos.");
  });
});

describe("pela chave — colar do DANFE, vírgula e o fornecedor pela chave", () => {
  async function modoChave() {
    await montar();
    await abrir();
    await digitar(campo("Fonte"), "CHAVE");
  }

  it("a chave colada com espaços fica INTEIRA e é conferida ao vivo", async () => {
    await modoChave();
    const c = campo("Chave de acesso") as HTMLInputElement;
    await digitar(c, CHAVE_DANFE);
    expect(c.value).toBe(CHAVE_DANFE);
    expect(Number(c.getAttribute("maxlength"))).toBeGreaterThanOrEqual(54);
    expect(texto()).toContain("Chave conferida: NF-e nº 991757, série 1, emitida em SC.");
    await digitar(c, CHAVE_DANFE.slice(0, 44));
    expect(texto()).toContain("Faltam 8 dígitos.");
  });

  it("devolução de compra: CNPJ e UF saem da chave, travados", async () => {
    await modoChave();
    await digitar(campo("Chave de acesso"), CHAVE_DANFE);
    const doc = campo("CPF/CNPJ") as HTMLInputElement;
    const uf = campo("UF do destinatário") as HTMLInputElement;
    expect(doc.value).toBe("11.222.333/0001-81");
    expect(uf.value).toBe("SC");
    expect(doc.readOnly).toBe(true);
    expect(uf.readOnly).toBe(true);
  });

  it("'45,90' fica como ela digitou e vai como 45.9; o corpo leva o fornecedor da chave", async () => {
    rotas["POST /fiscal/nfe/devolucao/manual"] = [{ status: 201, body: { draftId: "k1", reutilizado: false } }];
    await modoChave();
    await digitar(campo("Chave de acesso"), CHAVE_DANFE);
    await digitar(campo("Destinatário"), "DISAUTO DISTRIBUIDORA");
    await digitar(campo("Item na nota original"), "5");
    await digitar(campo("Código"), "F5");
    await digitar(campo("Descrição"), "Farol direito");
    await digitar(campo("NCM"), "87081000");
    const valor = campo("Valor unitário (R$)") as HTMLInputElement;
    await digitar(valor, "45,");
    expect(valor.value).toBe("45,");
    await digitar(valor, "45,90");
    expect(valor.value).toBe("45,90");
    await clicar(Array.from(container.querySelectorAll('input[type="checkbox"]')).at(-1) as HTMLInputElement);
    await clicar(botao("Criar rascunho de devolução"));
    const corpo = posts("/fiscal/nfe/devolucao/manual")[0].corpo;
    expect(corpo.chaveAcesso).toBe(CHAVE);
    expect(corpo.itens).toEqual([{ nItem: 5, codigo: "F5", descricao: "Farol direito", ncm: "87081000", unidade: "UN", cfopOriginal: null, valorUnitario: 45.9, quantidade: 1 }]);
    expect(corpo.destinatario).toEqual({ tipoPessoa: "PJ", cpfCnpj: "11.222.333/0001-81", nome: "DISAUTO DISTRIBUIDORA", uf: "SC" });
    expect(h.navegacoes).toEqual(["/notas-fiscais/nfe?draft=k1"]);
  });

  it("digitação inválida fica no CAMPO e nada é enviado", async () => {
    await modoChave();
    await digitar(campo("Valor unitário (R$)"), "45,");
    await clicar(botao("Criar rascunho de devolução"));
    expect(posts("/fiscal/nfe/devolucao/manual")).toHaveLength(0);
    expect(alertas()).toContain("Use uma vírgula só, antes dos centavos (ex.: 1.234,56).");
    expect(alertas()).toContain("Informe a chave de acesso.");
    expect(alertas()).toContain(CONFIRA_OS_CAMPOS);
  });

  it("recusa do servidor por campo aparece no campo (UF de outro estado, 1194…)", async () => {
    rotas["POST /fiscal/nfe/devolucao/manual"] = [{ status: 400, body: { error: "Dados da requisição inválidos.", code: "PAYLOAD_INVALIDO", erros: [{ campo: "chaveAcesso", mensagem: "Esta chave é de uma nota emitida pela sua própria empresa." }, { campo: "itens[0].ncm", mensagem: "NCM com 8 dígitos." }, { campo: "tipo", mensagem: "Informe o tipo de devolução." }] } }];
    await modoChave();
    await digitar(campo("Chave de acesso"), CHAVE_DANFE);
    await digitar(campo("Destinatário"), "DISAUTO");
    await digitar(campo("Código"), "F5");
    await digitar(campo("Descrição"), "Farol");
    await digitar(campo("NCM"), "87081000");
    await digitar(campo("Valor unitário (R$)"), "10");
    await clicar(Array.from(container.querySelectorAll('input[type="checkbox"]')).at(-1) as HTMLInputElement);
    await clicar(botao("Criar rascunho de devolução"));
    expect(alertas()).toContain("Esta chave é de uma nota emitida pela sua própria empresa.");
    expect(alertas()).toContain("NCM com 8 dígitos.");
    // O que não tem campo na tela não se perde: vai na lista geral.
    expect(texto()).toContain("Informe o tipo de devolução.");
  });

  it("'Devolver pela chave' numa venda sem XML: o quadro abre preenchido com a nota do Dexo", async () => {
    rotas["GET /fiscal/nfe/n9"] = [{ status: 200, body: { nfe: { id: "n9", chaveAcesso: CHAVE, destinatarioJson: { nome: "Cliente Balcão", cpfCnpj: "52998224725", uf: "sc" }, itens: [{ numero: 2, codigo: "P2", descricao: "Porta", ncm: "87082999", unidade: "UN", cfop: "5102", valorUnitario: 350.5, quantidade: 1 }] } } }];
    await montar("/notas-fiscais/emitidas?devolverPelaChave=n9");
    expect((campo("Operação") as HTMLSelectElement).value).toBe("VENDA_ENTRADA");
    expect((campo("Fonte") as HTMLSelectElement).value).toBe("CHAVE");
    expect((campo("Chave de acesso") as HTMLInputElement).value).toBe(CHAVE);
    expect((campo("Destinatário") as HTMLInputElement).value).toBe("Cliente Balcão");
    expect((campo("UF do destinatário") as HTMLInputElement).value).toBe("SC");
    expect((campo("Item na nota original") as HTMLInputElement).value).toBe("2");
    expect((campo("Valor unitário (R$)") as HTMLInputElement).value).toBe("350,5");
  });
});
