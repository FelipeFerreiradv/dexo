// @vitest-environment jsdom
//
// A página "Enviar XML" MONTADA, só nos botões de download da linha:
// erro do servidor era descartado em silêncio (`if (!res.ok) return;`). Agora
// vira o toast de erro da própria página, com a frase do servidor. O nome do
// arquivo NÃO muda aqui: a página só lista notas AUTORIZADAS.
// A falha confere o TIPO do toast (erro) e que há EXATAMENTE UM, com o texto
// exato: a resposta de erro é um `Response` real, então seguir para o `blob()`
// depois do toast apareceria como um segundo toast.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// A página não importa o React (runtime automático do Next); o esbuild do
// vitest compila o JSX para o `React.createElement` clássico.
(globalThis as any).React = React;

const h = vi.hoisted(() => {
  // A flag é lida no carregamento do módulo da página.
  const flagAntes = process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED;
  process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED = "true";
  return {
    flagAntes,
    sessao: { data: { user: { email: "dona@dls.test" } }, status: "authenticated" as const },
    download: {} as Record<string, () => unknown>,
  };
});

vi.mock("next-auth/react", () => ({ useSession: () => h.sessao }));
vi.mock("next/navigation", () => {
  const router = { push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, prefetch: () => {} };
  return { useRouter: () => router, usePathname: () => "/notas-fiscais/enviar-xml", useSearchParams: () => new URLSearchParams() };
});
vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test", authHeaders: () => ({}) }));
vi.mock("@/components/ui/toast-viewport", async () => {
  const { createElement: e, Children } = await import("react");
  // O tipo do toast só existe na COR (bg-red-500 = erro, bg-green-500 =
  // sucesso): o stub o expõe em `data-type` para o teste conferir.
  const tipo = (filho: any) => {
    const classe = String(filho?.props?.className ?? "");
    if (classe.includes("bg-red-500")) return "error";
    if (classe.includes("bg-green-500")) return "success";
    return "desconhecido";
  };
  return {
    ToastViewport: (p: any) =>
      e("div", { role: "status" }, Children.map(p.children, (filho: any) => e("div", { "data-type": tipo(filho) }, filho))),
  };
});
vi.mock("@/components/page-header", async () => {
  const { createElement: e } = await import("react");
  return { PageHeader: ({ title }: any) => e("h1", null, title) };
});
vi.mock("../../app/notas-fiscais/components/nfe-status-badge", async () => {
  const { createElement: e } = await import("react");
  return { NfeStatusBadge: ({ status }: any) => e("span", null, status) };
});
vi.mock("../../app/notas-fiscais/components/nfe-send-email-dialog", () => ({ NfeSendEmailDialog: () => null }));

import EnviarXmlPage from "../../app/notas-fiscais/enviar-xml/page";

const FRASE_CANCELADA =
  "Esta nota está CANCELADA e não foi possível marcar o DANFE como cancelado. Use o XML da nota.";
const FRASE_403 = "Seu acesso a esta área foi removido pelo administrador da conta.";
const PADRAO = "Não foi possível baixar o arquivo. Tente de novo.";

const NOTA = {
  id: "autorizada", serie: 1, numero: 715, chaveAcesso: null, destinatarioNome: "Cliente", status: "AUTHORIZED",
  dataEmissao: "2026-09-24T12:00:00.000Z", createdAt: "2026-09-24T12:00:00.000Z", hasXml: true, hasDanfe: true,
};

const ok = () => ({ ok: true, status: 200, blob: async () => new Blob(["%PDF-1.4"]) });
// Resposta REAL (tem `blob()`): se a tela seguisse depois do toast de erro, o
// `blob()` do corpo já lido estouraria e daria um SEGUNDO toast — que o
// `toastsExatos()` pega.
const falha = (status: number, corpo: string) => new Response(corpo, { status });

let container: HTMLDivElement;
let root: Root;
let baixados: string[];
const urlOriginal = { criar: (URL as any).createObjectURL, revogar: (URL as any).revokeObjectURL };

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  baixados = [];
  h.download = {};
  (URL as any).createObjectURL = vi.fn(() => "blob:teste");
  (URL as any).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    baixados.push(this.download);
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("http://api.test/fiscal/nfe?")) {
      return { ok: true, status: 200, json: async () => ({ notas: [NOTA] }) };
    }
    const m = url.match(/^http:\/\/api\.test\/fiscal\/nfe\/([^/]+)\/(danfe|xml)$/);
    if (m) {
      const r = h.download[`${m[1]}/${m[2]}`];
      return r ? r() : ok();
    }
    throw new Error(`chamada inesperada: ${url}`);
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  (URL as any).createObjectURL = urlOriginal.criar;
  (URL as any).revokeObjectURL = urlOriginal.revogar;
});

afterAll(() => {
  if (h.flagAntes === undefined) delete process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED;
  else process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED = h.flagAntes;
});

async function esperar() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function montar() {
  await act(async () => { root.render(<EnviarXmlPage />); });
  await esperar();
}
async function clicar(tipo: "danfe" | "xml") {
  const icone = tipo === "danfe" ? "lucide-download" : "lucide-file-text";
  const botao = Array.from(container.querySelectorAll("tr button")).find((b) => b.querySelector(`svg.${icone}`)) as HTMLButtonElement | undefined;
  expect(botao, `botão ${tipo}`).toBeTruthy();
  await act(async () => { botao!.click(); });
  await esperar();
}
const toasts = () => container.querySelector('[role="status"]')?.textContent ?? "";
/** Cada toast na tela, com o tipo e o texto exato. */
const toastsExatos = () =>
  Array.from(container.querySelectorAll('[role="status"] > [data-type]')).map((t) => ({
    tipo: t.getAttribute("data-type"),
    texto: t.textContent,
  }));

describe("Enviar XML — erro no download aparece", () => {
  it("500 com `error`: o toast mostra a frase do servidor", async () => {
    h.download["autorizada/danfe"] = () => falha(500, JSON.stringify({ error: FRASE_CANCELADA }));
    await montar();
    await clicar("danfe");
    expect(toasts()).toContain(FRASE_CANCELADA);
    expect(toastsExatos()).toEqual([{ tipo: "error", texto: FRASE_CANCELADA }]);
    expect(baixados).toEqual([]);
  });

  it("403 PAGE_FORBIDDEN: o toast mostra o `message`", async () => {
    h.download["autorizada/xml"] = () => falha(403, JSON.stringify({ message: FRASE_403, code: "PAGE_FORBIDDEN" }));
    await montar();
    await clicar("xml");
    expect(toasts()).toContain(FRASE_403);
    expect(toastsExatos()).toEqual([{ tipo: "error", texto: FRASE_403 }]);
    expect(baixados).toEqual([]);
  });

  it("corpo que não é JSON: frase padrão", async () => {
    h.download["autorizada/danfe"] = () => falha(504, "Gateway Timeout");
    await montar();
    await clicar("danfe");
    expect(toasts()).toContain(PADRAO);
    expect(toastsExatos()).toEqual([{ tipo: "error", texto: PADRAO }]);
    expect(baixados).toEqual([]);
  });

  it("rede caída (fetch lança): frase padrão, em vez de silêncio", async () => {
    h.download["autorizada/xml"] = () => { throw new TypeError("Failed to fetch"); };
    await montar();
    await clicar("xml");
    expect(toasts()).toContain(PADRAO);
    expect(toastsExatos()).toEqual([{ tipo: "error", texto: PADRAO }]);
    expect(baixados).toEqual([]);
  });

  it("404 \"DANFE nao disponivel\": exatamente UM toast, de erro, com a frase exata, e nada baixado", async () => {
    h.download["autorizada/danfe"] = () => falha(404, JSON.stringify({ error: "DANFE nao disponivel" }));
    await montar();
    await clicar("danfe");
    expect(toastsExatos()).toEqual([{ tipo: "error", texto: "DANFE nao disponivel" }]);
    expect(baixados).toEqual([]);
  });

  it("erro técnico cru do catch da rota (várias linhas): o toast mostra só a primeira linha", async () => {
    const cru = "ENOENT: no such file or directory, open 'nfe/x.xml'\n    at async open (node:internal/fs/promises:639:25)";
    h.download["autorizada/xml"] = () => falha(500, JSON.stringify({ error: cru }));
    await montar();
    await clicar("xml");
    expect(toastsExatos()).toEqual([{ tipo: "error", texto: "ENOENT: no such file or directory, open 'nfe/x.xml'" }]);
    expect(toasts()).not.toContain("node:internal");
    expect(baixados).toEqual([]);
  });

  it("sucesso: o nome de sempre e nenhum toast", async () => {
    await montar();
    await clicar("danfe");
    await clicar("xml");
    expect(baixados).toEqual(["nfe-autorizada.pdf", "nfe-autorizada.xml"]);
    expect(toasts()).toBe("");
    expect(toastsExatos()).toEqual([]);
  });
});
