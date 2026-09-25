// @vitest-environment jsdom
//
// BLOQ-2 (lado tela): reserva BLOQUEADO — 613 sem chave, consulta 100 com chave
// alheia, 101/151/155 — deixava a nota REJECTED "morta": a lista, a ficha e o
// wizard mostravam só "Nº X: BLOQUEADO" (o enum cru), sem botão nenhum. No V1 a
// mesma nota seria reemitida com número novo.
//
// Agora, SÓ na linha que traz a chave `numeracao` com BLOQUEADO:
//  - "Descartar o nº X e emitir com número novo" ⇒ POST
//    /fiscal/nfe/:id/numeracao/descartar-bloqueado; o 409
//    NUMERACAO_CONFIRMAR_DESCARTE abre a MESMA confirmação das devoluções e o
//    segundo clique repete com {confirmar:true}; no 200 a nota (de volta a
//    rascunho) abre no assistente para emitir;
//  - "Excluir rascunho" ⇒ DELETE /fiscal/nfe/draft/:id, e com a confirmação
//    ?descartarNumero=true.
// Linha V1 (sem a chave) não ganha nada: o DELETE apagaria nota V1 sem
// confirmação. Mais: A2 (legadoV1 ⇒ "Tentar novamente" neutro) e B8 ("Retomar
// emissão" chama POST /issue direto, nunca o wizard).
//
// NumeracaoActions é o componente REAL; o resto pesado da lista é stub.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;

const h = vi.hoisted(() => {
  // A lista lê a flag do "Tentar novamente" V1 no carregamento do módulo.
  const flagAntes = process.env.NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED;
  process.env.NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED = "true";
  return {
    flagAntes,
    sessao: { data: { user: { email: "dona@dls.test" } }, status: "authenticated" as const },
    navegacoes: [] as string[],
    pushes: [] as string[],
  };
});

vi.mock("next-auth/react", () => ({ useSession: () => h.sessao }));
vi.mock("next/navigation", () => {
  const router = { push: (u: string) => h.pushes.push(u), replace: () => {}, refresh: () => {}, back: () => {}, prefetch: () => {} };
  return { useRouter: () => router, usePathname: () => "/notas-fiscais/emitidas", useSearchParams: () => new URLSearchParams() };
});
vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test", authHeaders: () => ({}) }));
vi.mock("../../app/notas-fiscais/lib/nfe-navegacao", () => ({ navegarPara: (u: string) => h.navegacoes.push(u) }));
vi.mock("@/components/ui/select", async () => {
  const { createElement: e } = await import("react");
  return {
    Select: ({ children }: any) => e("div", null, children),
    SelectTrigger: ({ children }: any) => e("div", null, children),
    SelectValue: ({ placeholder }: any) => e("span", null, placeholder),
    SelectContent: ({ children }: any) => e("div", null, children),
    SelectItem: ({ value, children }: any) => e("div", { "data-item": value }, children),
  };
});
vi.mock("@/components/ui/tooltip", async () => {
  const { createElement: e, Fragment } = await import("react");
  return {
    TooltipProvider: ({ children }: any) => e(Fragment, null, children),
    Tooltip: ({ children }: any) => e(Fragment, null, children),
    TooltipTrigger: ({ children }: any) => e(Fragment, null, children),
    TooltipContent: ({ children }: any) => e("span", { "data-tooltip": "" }, children),
  };
});
vi.mock("@/components/ui/toast-viewport", async () => {
  const { createElement: e } = await import("react");
  return { ToastViewport: (p: any) => e("div", { role: "status", "data-toast": "" }, p.children) };
});
vi.mock("@/components/ui/sheet", async () => {
  const { createElement: e } = await import("react");
  return {
    Sheet: ({ open, children }: any) => (open ? e("div", null, children) : null),
    SheetContent: ({ children }: any) => e("div", null, children),
    SheetTitle: ({ children }: any) => e("h2", null, children),
  };
});
// A ficha é a REAL (fechada na lista, o Sheet de stub não desenha nada nem busca).
vi.mock("../../app/notas-fiscais/components/nfe-cancel-dialog", () => ({ NfeCancelDialog: () => null }));
vi.mock("../../app/notas-fiscais/components/nfe-send-email-dialog", () => ({ NfeSendEmailDialog: () => null }));
vi.mock("../../app/notas-fiscais/components/devolucao-manual", () => ({ DevolucaoManual: () => null }));
vi.mock("../../app/notas-fiscais/components/devolucao-actions", () => ({ DevolucaoActions: () => null }));
vi.mock("../../app/notas-fiscais/components/devolucao-vinculo", () => ({ DevolucaoVinculo: () => null }));
vi.mock("../../app/notas-fiscais/components/devolucoes-em-andamento", () => ({ DevolucoesEmAndamento: () => null }));
vi.mock("../../app/notas-fiscais/components/nfe-status-badge", async () => {
  const { createElement: e } = await import("react");
  return { NfeStatusBadge: ({ status }: any) => e("span", null, status) };
});

import { NfeList } from "../../app/notas-fiscais/components/nfe-list";
import { NfeDetailSheet } from "../../app/notas-fiscais/components/nfe-detail-sheet";
import { NumeracaoActions } from "../../app/notas-fiscais/components/numeracao-actions";

const API = "http://api.test";
const MSG_CONFIRMAR_NUMERO = "O nº 501 (série 1) está retido para conferência: confirme que ele NÃO foi autorizado na SEFAZ antes de descartá-lo";
const MSG_CONFIRMAR_DELETE = "O nº 501 (série 1) está retido para conferência: confirme que ele NÃO foi autorizado na SEFAZ antes de descartá-lo";

function linha(p: Record<string, unknown>) {
  return {
    id: "n", orderId: null, ambiente: "PRODUCAO", modelo: "55", serie: 1, numero: 700, chaveAcesso: null, tipoOperacao: "SAIDA",
    finalidade: "NORMAL", naturezaOperacao: "Venda", destinatarioNome: "Cliente", destinatarioCpfCnpj: "", totalNota: 100,
    status: "REJECTED", protocoloAutorizacao: null, dataEmissao: null, dataAutorizacao: null,
    createdAt: "2026-09-24T12:00:00.000Z", hasXml: false, hasDanfe: false, ...p,
  };
}
const BLOQUEADO = { estado: "BLOQUEADO", numero: 501, serie: 1, reutilizavel: false };

type Resp = { status: number; body?: unknown };
let container: HTMLDivElement;
let root: Root;
let chamadas: Array<{ metodo: string; url: string; body: unknown }>;
let rotas: Record<string, Resp | Resp[]>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  chamadas = [];
  h.navegacoes = [];
  h.pushes = [];
  rotas = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const metodo = init?.method ?? "GET";
    const caminho = url.replace(API, "");
    chamadas.push({ metodo, url: caminho, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const chave = caminho.startsWith("/fiscal/nfe?") ? `${metodo} /fiscal/nfe?` : caminho.startsWith("/fiscal/nfe/stats") ? "GET /fiscal/nfe/stats" : `${metodo} ${caminho}`;
    const r = rotas[chave];
    const resp = Array.isArray(r) ? (r.length > 1 ? r.shift() : r[0]) : r;
    if (!resp) throw new Error(`chamada inesperada: ${metodo} ${caminho}`);
    return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, json: async () => resp.body ?? {} };
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
afterAll(() => {
  if (h.flagAntes === undefined) delete process.env.NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED;
  else process.env.NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED = h.flagAntes;
});

async function assentar(vezes = 6) {
  for (let i = 0; i < vezes; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const texto = (el: ParentNode = container) => (el as Element).textContent ?? "";
const botoes = (el: ParentNode = container) => Array.from(el.querySelectorAll("button"));
const botao = (rotulo: string, el: ParentNode = container) => botoes(el).find((b) => (b.textContent ?? "").trim() === rotulo) as HTMLButtonElement | undefined;
async function clicar(rotulo: string, el: ParentNode = container) {
  const b = botao(rotulo, el);
  if (!b) throw new Error(`botão "${rotulo}" não está na tela. Texto: ${texto(el)}`);
  await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await assentar();
}
const posts = (sufixo: string) => chamadas.filter((c) => c.metodo === "POST" && c.url.endsWith(sufixo));
const deletes = () => chamadas.filter((c) => c.metodo === "DELETE");

describe("NumeracaoActions: BLOQUEADO tem saída (e só ele)", () => {
  async function montar(props: Record<string, unknown>) {
    await act(async () => { root.render(<NumeracaoActions id="n1" email="dona@dls.test" {...(props as any)} />); });
    await assentar();
  }

  it("texto legível no lugar do enum cru e as duas ações", async () => {
    await montar({ numeracao: BLOQUEADO });
    expect(texto()).toContain("Nº 501: retido para conferência");
    expect(texto()).not.toContain("BLOQUEADO");
    expect(botao("Descartar o nº 501 e emitir com número novo")).toBeTruthy();
    expect(botao("Excluir rascunho")).toBeTruthy();
    expect(botao("Consultar situação")).toBeUndefined();
  });

  it("Descartar: 1º POST sem confirmar ⇒ 409 ⇒ confirmação das devoluções ⇒ 2º POST {confirmar:true} ⇒ 200 ⇒ abre o assistente na MESMA nota", async () => {
    rotas["POST /fiscal/nfe/n1/numeracao/descartar-bloqueado"] = [
      { status: 409, body: { error: MSG_CONFIRMAR_NUMERO, code: "NUMERACAO_CONFIRMAR_DESCARTE", detalhes: { numero: 501, serie: 1 } } },
      { status: 200, body: { ok: true, numeroDescartado: 501, serie: 1 } },
    ];
    await montar({ numeracao: BLOQUEADO });
    await clicar("Descartar o nº 501 e emitir com número novo");
    expect(posts("/descartar-bloqueado")).toHaveLength(1);
    expect(posts("/descartar-bloqueado")[0].body).toEqual({});
    const dialogo = container.querySelector('[role="alertdialog"][aria-label="Confirmar descarte"]');
    expect(dialogo, texto()).toBeTruthy();
    expect(texto(dialogo!)).toContain(MSG_CONFIRMAR_NUMERO);
    // Nada aconteceu ainda: só a pergunta.
    expect(h.navegacoes).toEqual([]);
    const confirmar = botoes(dialogo!).find((b) => b.textContent !== "Cancelar")!;
    await act(async () => { confirmar.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await assentar();
    expect(posts("/descartar-bloqueado")).toHaveLength(2);
    expect(posts("/descartar-bloqueado")[1].body).toEqual({ confirmar: true });
    expect(h.navegacoes).toEqual(["/notas-fiscais/nfe?draft=n1"]);
  });

  it("Cancelar na confirmação ⇒ nenhum segundo POST", async () => {
    rotas["POST /fiscal/nfe/n1/numeracao/descartar-bloqueado"] = { status: 409, body: { error: MSG_CONFIRMAR_NUMERO, code: "NUMERACAO_CONFIRMAR_DESCARTE" } };
    await montar({ numeracao: BLOQUEADO });
    await clicar("Descartar o nº 501 e emitir com número novo");
    await clicar("Cancelar");
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(posts("/descartar-bloqueado")).toHaveLength(1);
    expect(botao("Descartar o nº 501 e emitir com número novo")).toBeTruthy();
  });

  it("onDescartado (o wizard) recebe o nº descartado em vez de navegar", async () => {
    rotas["POST /fiscal/nfe/n1/numeracao/descartar-bloqueado"] = [
      { status: 409, body: { error: MSG_CONFIRMAR_NUMERO, code: "NUMERACAO_CONFIRMAR_DESCARTE" } },
      { status: 200, body: { ok: true, numeroDescartado: 501, serie: 1 } },
    ];
    const recebidos: unknown[] = [];
    await montar({ numeracao: BLOQUEADO, onDescartado: (r: unknown) => recebidos.push(r) });
    await clicar("Descartar o nº 501 e emitir com número novo");
    const dialogo = container.querySelector('[role="alertdialog"]')!;
    await act(async () => { botoes(dialogo).find((b) => b.textContent !== "Cancelar")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await assentar();
    expect(recebidos).toEqual([{ numeroDescartado: 501, serie: 1 }]);
    expect(h.navegacoes).toEqual([]);
  });

  it("409 NUMERACAO_NAO_BLOQUEADA ⇒ mostra a frase do servidor, sem confirmação", async () => {
    rotas["POST /fiscal/nfe/n1/numeracao/descartar-bloqueado"] = { status: 409, body: { error: "O número desta nota não está mais retido", code: "NUMERACAO_NAO_BLOQUEADA" } };
    await montar({ numeracao: BLOQUEADO });
    await clicar("Descartar o nº 501 e emitir com número novo");
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("O número desta nota não está mais retido");
  });

  it("Excluir rascunho: DELETE ⇒ 409 ⇒ confirmação ⇒ DELETE ?descartarNumero=true ⇒ onExcluido", async () => {
    rotas["DELETE /fiscal/nfe/draft/n1"] = { status: 409, body: { error: MSG_CONFIRMAR_DELETE, code: "NUMERACAO_CONFIRMAR_DESCARTE" } };
    rotas["DELETE /fiscal/nfe/draft/n1?descartarNumero=true"] = { status: 204 };
    let excluido = 0;
    await montar({ numeracao: BLOQUEADO, onExcluido: () => { excluido++; } });
    await clicar("Excluir rascunho");
    expect(deletes().map((d) => d.url)).toEqual(["/fiscal/nfe/draft/n1"]);
    const dialogo = container.querySelector('[role="alertdialog"][aria-label="Confirmar descarte"]');
    expect(dialogo, texto()).toBeTruthy();
    expect(texto(dialogo!)).toContain(MSG_CONFIRMAR_DELETE);
    await clicar("Descartar e soltar o número", dialogo!);
    expect(deletes().map((d) => d.url)).toEqual(["/fiscal/nfe/draft/n1", "/fiscal/nfe/draft/n1?descartarNumero=true"]);
    expect(excluido).toBe(1);
  });

  it("linha SEM a chave `numeracao` (V1) ou com numeracao:null ⇒ o componente não desenha nada", async () => {
    await montar({ numeracao: undefined });
    expect(container.innerHTML).toBe("");
    await montar({ numeracao: null });
    expect(container.innerHTML).toBe("");
  });

  it("outros estados: nada de descarte (RESERVADO segue 'mantido para nova tentativa'; INCERTO só 'Consultar situação')", async () => {
    await montar({ numeracao: { estado: "RESERVADO", numero: 3, serie: 1, reutilizavel: true } });
    expect(texto()).toBe("Nº 3: mantido para nova tentativa");
    expect(botoes()).toHaveLength(0);
    await montar({ numeracao: { estado: "INCERTO", numero: 4, serie: 1, reutilizavel: false } });
    expect(texto()).toContain("Nº 4: INCERTO");
    expect(botoes().map((b) => b.textContent)).toEqual(["Consultar situação"]);
  });

  it("B8: 'Retomar emissão' ⇒ POST /issue direto e a resposta vai para onChanged", async () => {
    rotas["POST /fiscal/nfe/n1/issue"] = { status: 200, body: { success: false, status: "REJECTED", mensagem: "Rejeicao: Falha no Schema XML", numeracao: { estado: "REJEITADO", numero: 3, reutilizavel: true } } };
    const recebidos: unknown[] = [];
    await montar({ numeracao: { estado: "RESERVADO", numero: 3, serie: 1, reutilizavel: true }, retomavel: true, onChanged: (d: unknown) => recebidos.push(d) });
    await clicar("Retomar emissão");
    expect(posts("/fiscal/nfe/n1/issue")).toHaveLength(1);
    expect(texto()).toContain("Rejeicao: Falha no Schema XML");
    expect(recebidos).toHaveLength(1);
    expect(recebidos[0]).toMatchObject({ status: "REJECTED" });
    expect(h.navegacoes).toEqual([]);
  });

  it("B8: retomavel sem reserva (nunca numerada) ⇒ só o botão, sem a linha 'Nº'", async () => {
    await montar({ numeracao: undefined, retomavel: true });
    expect(botoes().map((b) => b.textContent)).toEqual(["Retomar emissão"]);
    expect(texto()).not.toContain("Nº");
  });
});

describe("lista de Notas Emitidas com o NumeracaoActions real", () => {
  const notas = [
    linha({ id: "bloq", numero: 501, destinatarioNome: "CLIENTE BLOQ", numeracao: BLOQUEADO }),
    linha({ id: "v1", numero: 50, destinatarioNome: "CLIENTE V1", reaproveitavel: true }),
    linha({ id: "legado", numero: 158, destinatarioNome: "CLIENTE LEGADO", reaproveitavel: true, legadoV1: true }),
    linha({ id: "consumido", numero: 9, destinatarioNome: "CLIENTE CONSUMIDO", reaproveitavel: true, numeracao: null }),
    linha({ id: "trav", numero: 3, status: "VALIDATING", destinatarioNome: "CLIENTE TRAVADA", numeracao: { estado: "RESERVADO", numero: 3, serie: 1, reutilizavel: true }, retomavel: true }),
  ];
  beforeEach(() => {
    rotas["GET /fiscal/nfe?"] = { status: 200, body: { notas, page: 1, limit: 10, total: notas.length, totalPages: 1 } };
    rotas["GET /fiscal/nfe/stats"] = { status: 200, body: { stats: { total: 5, autorizadas: 0, rejeitadas: 4, canceladas: 0, valorTotal: 0 } } };
  });
  async function montarLista() {
    window.history.replaceState({}, "", "/notas-fiscais/emitidas");
    await act(async () => { root.render(<NfeList />); });
    await assentar(8);
  }
  const tr = (nome: string) => Array.from(container.querySelectorAll("tbody tr")).find((l) => (l.textContent ?? "").includes(nome)) as HTMLElement;
  const tooltip = (l: HTMLElement) => l.querySelector("[data-tooltip]")?.textContent ?? null;

  it("BLOQUEADO: texto legível e as duas ações na linha; sem 'Tentar novamente'", async () => {
    await montarLista();
    const l = tr("CLIENTE BLOQ");
    expect(texto(l)).toContain("Nº 501: retido para conferência");
    expect(botao("Descartar o nº 501 e emitir com número novo", l)).toBeTruthy();
    expect(botao("Excluir rascunho", l)).toBeTruthy();
    expect(tooltip(l)).toBeNull();
  });

  it("linha V1 (sem a chave) e linha com numeracao:null: NENHUMA ação nova", async () => {
    await montarLista();
    for (const nome of ["CLIENTE V1", "CLIENTE CONSUMIDO"]) {
      const l = tr(nome);
      expect(botao("Excluir rascunho", l), nome).toBeUndefined();
      expect(botoes(l).some((b) => /Descartar/.test(b.textContent ?? "")), nome).toBe(false);
      expect(botao("Retomar emissão", l), nome).toBeUndefined();
    }
    // V1 intacta: o texto antigo; nº consumido: sem botão.
    expect(tooltip(tr("CLIENTE V1"))).toBe("Tentar novamente — reaproveita o nº 1/50");
    expect(tooltip(tr("CLIENTE CONSUMIDO"))).toBeNull();
  });

  it("A2: legadoV1 + REJECTED reaproveitável + flag ⇒ 'Tentar novamente' com rótulo NEUTRO", async () => {
    await montarLista();
    expect(tooltip(tr("CLIENTE LEGADO"))).toBe("Tentar novamente");
  });

  it("descartar pela lista abre o assistente na nota (que voltou a rascunho e some da lista)", async () => {
    rotas["POST /fiscal/nfe/bloq/numeracao/descartar-bloqueado"] = [
      { status: 409, body: { error: MSG_CONFIRMAR_NUMERO, code: "NUMERACAO_CONFIRMAR_DESCARTE" } },
      { status: 200, body: { ok: true, numeroDescartado: 501, serie: 1 } },
    ];
    await montarLista();
    await clicar("Descartar o nº 501 e emitir com número novo", tr("CLIENTE BLOQ"));
    const dialogo = tr("CLIENTE BLOQ").querySelector('[role="alertdialog"]')!;
    expect(dialogo).toBeTruthy();
    await act(async () => { botoes(dialogo).find((b) => b.textContent !== "Cancelar")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await assentar();
    expect(posts("/descartar-bloqueado").map((p) => p.body)).toEqual([{}, { confirmar: true }]);
    expect(h.navegacoes).toEqual(["/notas-fiscais/nfe?draft=bloq"]);
  });

  it("excluir pela lista recarrega a lista", async () => {
    rotas["DELETE /fiscal/nfe/draft/bloq"] = { status: 409, body: { error: MSG_CONFIRMAR_DELETE, code: "NUMERACAO_CONFIRMAR_DESCARTE" } };
    rotas["DELETE /fiscal/nfe/draft/bloq?descartarNumero=true"] = { status: 204 };
    await montarLista();
    const antes = chamadas.filter((c) => c.url.startsWith("/fiscal/nfe?")).length;
    await clicar("Excluir rascunho", tr("CLIENTE BLOQ"));
    await clicar("Descartar e soltar o número", tr("CLIENTE BLOQ"));
    expect(deletes().map((d) => d.url)).toEqual(["/fiscal/nfe/draft/bloq", "/fiscal/nfe/draft/bloq?descartarNumero=true"]);
    expect(chamadas.filter((c) => c.url.startsWith("/fiscal/nfe?")).length).toBe(antes + 1);
  });

  it("B8: 'Retomar emissão' na linha travada chama POST /issue e recarrega — nunca o wizard", async () => {
    rotas["POST /fiscal/nfe/trav/issue"] = { status: 200, body: { success: true, status: "AUTHORIZED", numero: 3, chaveAcesso: "35260912345678000190550010000000031234567890" } };
    await montarLista();
    const antes = chamadas.filter((c) => c.url.startsWith("/fiscal/nfe?")).length;
    await clicar("Retomar emissão", tr("CLIENTE TRAVADA"));
    expect(posts("/fiscal/nfe/trav/issue")).toHaveLength(1);
    expect(h.pushes).toEqual([]);
    expect(h.navegacoes).toEqual([]);
    expect(chamadas.filter((c) => c.url.startsWith("/fiscal/nfe?")).length).toBe(antes + 1);
  });
});

describe("ficha da nota com BLOQUEADO", () => {
  const NFE = { id: "bloq", modelo: "55", serie: 1, numero: 501, status: "REJECTED", finalidade: "NORMAL", tipoOperacao: "SAIDA", ambiente: "PRODUCAO", naturezaOperacao: "Venda", itens: [], totaisJson: { totalNota: 10 }, motivoRejeicao: "Nº 501 retido para conferência", numeracao: BLOQUEADO };
  beforeEach(() => {
    rotas["GET /fiscal/nfe/bloq"] = { status: 200, body: { nfe: NFE } };
    rotas["GET /fiscal/nfe/bloq/events"] = { status: 200, body: { events: [] } };
  });

  it("mostra as ações; excluir fecha a ficha e avisa a lista", async () => {
    rotas["DELETE /fiscal/nfe/draft/bloq"] = { status: 409, body: { error: MSG_CONFIRMAR_DELETE, code: "NUMERACAO_CONFIRMAR_DESCARTE" } };
    rotas["DELETE /fiscal/nfe/draft/bloq?descartarNumero=true"] = { status: 204 };
    const aberturas: boolean[] = [];
    let mudou = 0;
    await act(async () => { root.render(<NfeDetailSheet nfeId="bloq" open onOpenChange={(o) => aberturas.push(o)} onStatusChanged={() => { mudou++; }} />); });
    await assentar(8);
    expect(texto()).toContain("Nº 501: retido para conferência");
    expect(botao("Descartar o nº 501 e emitir com número novo")).toBeTruthy();
    await clicar("Excluir rascunho");
    await clicar("Descartar e soltar o número");
    expect(deletes().map((d) => d.url)).toEqual(["/fiscal/nfe/draft/bloq", "/fiscal/nfe/draft/bloq?descartarNumero=true"]);
    expect(aberturas).toEqual([false]);
    expect(mudou).toBe(1);
  });

  // Integração (revisão do G2): a ficha também repassa `retomavel` do GET /fiscal/nfe/:id — sem
  // isso a nota VALIDATING travada perdia o "Retomar emissão" na ficha em silêncio.
  it("B8: nota VALIDATING com retomavel ⇒ 'Retomar emissão' na ficha chama POST /issue direto e recarrega a ficha", async () => {
    const TRAV = { ...NFE, id: "trav", status: "VALIDATING", numeracao: { estado: "RESERVADO", numero: 501, serie: 1, reutilizavel: true }, retomavel: true };
    rotas["GET /fiscal/nfe/trav"] = { status: 200, body: { nfe: TRAV } };
    rotas["GET /fiscal/nfe/trav/events"] = { status: 200, body: { events: [] } };
    rotas["POST /fiscal/nfe/trav/issue"] = { status: 200, body: { success: true, status: "AUTHORIZED", numero: 501, serie: 1, mensagem: "NF-e autorizada" } };
    await act(async () => { root.render(<NfeDetailSheet nfeId="trav" open onOpenChange={() => {}} />); });
    await assentar(8);
    const gets = () => chamadas.filter((c) => c.metodo === "GET" && c.url === "/fiscal/nfe/trav").length;
    const antes = gets();
    await clicar("Retomar emissão");
    expect(posts("/issue").map((p) => p.url)).toEqual(["/fiscal/nfe/trav/issue"]);
    expect(h.navegacoes).toEqual([]);
    expect(gets()).toBe(antes + 1);
  });
});
