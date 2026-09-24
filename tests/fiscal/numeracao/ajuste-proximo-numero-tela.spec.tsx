// @vitest-environment jsdom
//
// O card de ajuste do próximo número montado DE VERDADE (com efeitos e
// `fetch`), não só lido — mesmo motivo do `tests/scrap-link-section.spec.tsx`:
// um teste que lê o código prova que a linha existe, não que ela faz o que diz.
//
// O que só um teste montado prova aqui:
//  - a primeira chamada vai SEM `confirmar` e NADA mais acontece até a resposta;
//  - o corpo é CONGELADO no 409: mexer no formulário por trás do diálogo não
//    troca o que será aplicado (o efeito é irreversível — o contador não volta);
//  - a confirmação reenvia o MESMO corpo com `confirmar: true`;
//  - o texto que o operador lê no erro é o DO SERVIDOR, não um genérico.
//
// O Radix é substituído por stubs: Select precisa de ResizeObserver/PointerEvent
// (que o jsdom não tem) e o AlertDialog usa portal. O que se afirma deles é o
// contrato — QUAL value o card mostra e QUANDO o diálogo aparece.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const EMAIL = "dono@desmanche.test";
const CFG = "cfg-abc";

vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));

// Sem JSX nas fábricas de propósito: elas são içadas para antes dos imports, e
// o JSX compilado referenciaria um `React` que ainda não existe ali.
vi.mock("@/components/ui/select", async () => {
  const { createElement: h } = await import("react");
  return {
    // `onValueChange` exposto num botão por opção: sem isso dá para afirmar o
    // que o card MOSTRA, mas não o que acontece quando o operador TROCA.
    Select: ({ value, children, onValueChange }: any) =>
      h(
        "div",
        { "data-testid": "select", "data-value": value },
        children,
        h(
          "div",
          { "data-testid": "opcoes" },
          ["55", "65", "PRODUCAO", "HOMOLOGACAO"].map((v) =>
            h(
              "button",
              {
                key: v,
                type: "button",
                "data-escolher": v,
                onClick: () => onValueChange?.(v),
              },
              "",
            ),
          ),
        ),
      ),
    SelectTrigger: ({ children, id }: any) => h("div", { id }, children),
    SelectValue: () => null,
    SelectContent: ({ children }: any) => h("div", null, children),
    SelectItem: ({ value, children }: any) => h("div", { "data-item": value }, children),
  };
});

vi.mock("@/components/ui/alert-dialog", async () => {
  const { createElement: h } = await import("react");
  return {
    // Fechado ⇒ nada no DOM: é assim que o teste distingue "revisou" de "aplicou".
    AlertDialog: ({ open, children }: any) =>
      open ? h("div", { "data-testid": "dialogo" }, children) : null,
    AlertDialogContent: ({ children }: any) => h("div", null, children),
    AlertDialogHeader: ({ children }: any) => h("div", null, children),
    AlertDialogFooter: ({ children }: any) => h("div", null, children),
    AlertDialogTitle: ({ children }: any) => h("div", null, children),
    AlertDialogDescription: ({ children }: any) => h("div", null, children),
    AlertDialogCancel: ({ children }: any) => h("button", null, children),
  };
});

import { AjusteNumeracaoCard } from "../../../app/notas-fiscais/components/steps/ajuste-numeracao-card";

const MSG_409 =
  "O próximo número da série 1 (modelo 55, produção, CNPJ 11222333000181) passará de 100 para 5000: 4900 número(s) ficarão sem uso e essa lacuna pode exigir inutilização junto à SEFAZ. O contador nunca retrocede — isto não pode ser desfeito. Confirme para aplicar.";

const RESPOSTA_409 = {
  error: MSG_409,
  code: "NUMERACAO_CONFIRMAR_AJUSTE",
  detalhes: {
    companyFiscalConfigId: CFG,
    emitenteDocumento: "11222333000181",
    ambiente: "PRODUCAO",
    modelo: "55",
    serie: 1,
    proximoNumeroAtual: 100,
    proximoNumeroSolicitado: 5000,
    numerosPulados: 4900,
    requerInutilizacao: true,
  },
};

const RESPOSTA_200 = {
  success: true,
  ajuste: {
    companyFiscalConfigId: CFG,
    emitenteDocumento: "11222333000181",
    ambiente: "PRODUCAO",
    modelo: "55",
    serie: 1,
    proximoNumeroAnterior: 100,
    proximoNumero: 5000,
    numerosPulados: 4900,
    motivo: "migracao do sistema antigo - ultima nota foi a 4999",
    ajustadoEm: "2026-09-23T12:00:00.000Z",
  },
};

let container: HTMLDivElement;
let root: Root;
let chamadas: Array<{ url: string; method: string; body: any }>;
let filaPost: Array<{ ok: boolean; body: unknown }>;

const posts = () => chamadas.filter((c) => c.method === "POST");
const texto = () => container.textContent ?? "";
const dialogo = () => container.querySelector('[data-testid="dialogo"]');

function botao(rotulo: string): HTMLButtonElement {
  const alvo = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(rotulo),
  );
  if (!alvo) throw new Error(`botão "${rotulo}" não está na tela`);
  return alvo as HTMLButtonElement;
}

/** Digita como o navegador: setter nativo + evento que o React escuta. */
function digitar(seletor: string, valor: string) {
  const el = container.querySelector(seletor) as HTMLInputElement | HTMLTextAreaElement;
  if (!el) throw new Error(`campo ${seletor} não está na tela`);
  const proto =
    el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, valor);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function assentar() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function montar(props: Partial<React.ComponentProps<typeof AjusteNumeracaoCard>> = {}) {
  await act(async () => {
    root.render(
      <AjusteNumeracaoCard
        userEmail={EMAIL}
        configExists
        companyId={CFG}
        ambientePadrao="PRODUCAO"
        seriePadrao={1}
        {...props}
      />,
    );
  });
  await assentar();
}

/** Abre o formulário e preenche número e motivo (a série já vem do padrão). */
async function preencher(proximoNumero = "5000", motivo = RESPOSTA_200.ajuste.motivo) {
  await act(async () => botao("Ajustar próximo número").click());
  await act(async () => digitar("#ajuste-proximo", proximoNumero));
  await act(async () => digitar("#ajuste-motivo", motivo));
}

async function clicar(rotulo: string) {
  await act(async () => botao(rotulo).click());
  await assentar();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  chamadas = [];
  filaPost = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: any) => {
      const method = init?.method ?? "GET";
      chamadas.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (method === "GET") {
        // Preview do contador (modelo 55, ambiente salvo da config).
        return {
          ok: true,
          status: 200,
          json: async () => ({ serie: 1, ambiente: "PRODUCAO", proximoNumero: 100 }),
        };
      }
      const r = filaPost.shift();
      if (!r) throw new Error(`POST inesperado: ${JSON.stringify(init?.body)}`);
      return { ok: r.ok, status: r.ok ? 200 : 409, json: async () => r.body };
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("card de ajuste — quando ele aparece", () => {
  it("empresa ainda não salva: card nenhum (não existe contador para mover)", async () => {
    await montar({ configExists: false });
    expect(texto()).toBe("");
  });

  it("nasce FECHADO: quem veio mexer na série não esbarra num campo que pula numeração", async () => {
    await montar();
    expect(texto()).toContain("Ajustar o próximo número de uma série");
    expect(container.querySelector("#ajuste-proximo")).toBeNull();
    expect(container.querySelector("#ajuste-motivo")).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("aberto, o botão só libera com o motivo preenchido", async () => {
    await montar();
    await act(async () => botao("Ajustar próximo número").click());
    expect(botao("Revisar ajuste").disabled).toBe(true);

    await act(async () => digitar("#ajuste-proximo", "5000"));
    expect(botao("Revisar ajuste").disabled).toBe(true); // ainda sem motivo

    await act(async () => digitar("#ajuste-motivo", "curto"));
    expect(botao("Revisar ajuste").disabled).toBe(true);

    await act(async () => digitar("#ajuste-motivo", RESPOSTA_200.ajuste.motivo));
    expect(botao("Revisar ajuste").disabled).toBe(false);
    expect(posts()).toHaveLength(0);
  });
});

describe("confirmação em dois passos", () => {
  it("primeira chamada vai SEM confirmar, com o escopo explícito, e nada é aplicado", async () => {
    filaPost.push({ ok: false, body: RESPOSTA_409 });
    await montar();
    await preencher();
    expect(dialogo()).toBeNull();

    await clicar("Revisar ajuste");

    expect(posts()).toHaveLength(1);
    expect(posts()[0].url).toBe("http://api.test/fiscal/nfe/proximo-numero/ajuste");
    expect(posts()[0].body).toEqual({
      companyFiscalConfigId: CFG,
      ambiente: "PRODUCAO",
      modelo: "55",
      serie: 1,
      proximoNumero: 5000,
      motivo: RESPOSTA_200.ajuste.motivo,
      confirmar: false,
    });
    // Ambiente e modelo enviados são os que a tela mostra — nada assumido.
    const selects = Array.from(container.querySelectorAll('[data-testid="select"]'));
    expect(selects.map((s) => s.getAttribute("data-value"))).toEqual(["PRODUCAO", "55"]);
  });

  it("o 409 abre o diálogo com a MENSAGEM DO SERVIDOR, o de→para e o aviso da SEFAZ", async () => {
    filaPost.push({ ok: false, body: RESPOSTA_409 });
    await montar();
    await preencher();
    await clicar("Revisar ajuste");

    const d = dialogo();
    expect(d).not.toBeNull();
    const lido = d!.textContent ?? "";
    expect(lido).toContain(MSG_409);
    expect(lido).toContain("11.222.333/0001-81");
    expect(lido).toContain("Produção");
    expect(lido).toContain("100");
    expect(lido).toContain("5000");
    expect(lido).toContain("4900");
    expect(lido).toContain("inutilizado");
    // Revisar não escreve: continua UMA chamada só.
    expect(posts()).toHaveLength(1);
  });

  it("mexer no formulário por trás do diálogo NÃO troca o que será aplicado", async () => {
    filaPost.push({ ok: false, body: RESPOSTA_409 });
    filaPost.push({ ok: true, body: RESPOSTA_200 });
    await montar();
    await preencher();
    await clicar("Revisar ajuste");

    // Diálogo aberto, operador esbarra no campo e troca o número.
    await act(async () => digitar("#ajuste-proximo", "999999"));

    await clicar("Confirmar e avançar o contador");

    expect(posts()).toHaveLength(2);
    // O MESMO corpo revisado, com confirmar: true — 5000, não 999999.
    expect(posts()[1].body).toEqual({ ...posts()[0].body, confirmar: true });
    expect(posts()[1].body.proximoNumero).toBe(5000);
  });

  it("aplicado: fecha o diálogo, avisa em português claro e zera o formulário", async () => {
    filaPost.push({ ok: false, body: RESPOSTA_409 });
    filaPost.push({ ok: true, body: RESPOSTA_200 });
    await montar();
    await preencher();
    await clicar("Revisar ajuste");
    await clicar("Confirmar e avançar o contador");

    expect(dialogo()).toBeNull();
    const aviso = container.querySelector('[role="status"]')?.textContent ?? "";
    expect(aviso).toContain("5000");
    expect(aviso).toContain("4900");
    // Reaplicar por engano pularia mais números ainda.
    expect((container.querySelector("#ajuste-proximo") as HTMLInputElement).value).toBe("");
    expect((container.querySelector("#ajuste-motivo") as HTMLTextAreaElement).value).toBe("");
  });

  it("'Voltar' fecha o diálogo sem aplicar nada", async () => {
    filaPost.push({ ok: false, body: RESPOSTA_409 });
    await montar();
    await preencher();
    await clicar("Revisar ajuste");
    expect(dialogo()).not.toBeNull();

    await clicar("Voltar");
    expect(posts()).toHaveLength(1);
  });
});

describe("erros do servidor chegam ao operador com o texto do servidor", () => {
  it("SEQUENCIA_NAO_RETROCEDE: mostra a instrução do servidor e corrige o número na tela", async () => {
    const error =
      "O próximo número da série 1 (modelo 55, produção) já está em 5200: o contador só avança, nunca volta — número já usado não pode ser emitido de novo. Informe um número maior que 5200.";
    filaPost.push({
      ok: false,
      body: {
        error,
        code: "SEQUENCIA_NAO_RETROCEDE",
        detalhes: { proximoNumeroAtual: 5200, proximoNumeroSolicitado: 5000 },
      },
    });
    await montar();
    await preencher();
    await clicar("Revisar ajuste");

    expect(dialogo()).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(error);
    // A tela aprendeu o número real (o preview do 55 dizia 100).
    expect(texto()).toContain("5200");
  });

  it("404 de emitente de outro tenant: mensagem do servidor, sem diálogo", async () => {
    filaPost.push({
      ok: false,
      body: { error: "Empresa não encontrada", code: "EMITENTE_NAO_ENCONTRADO" },
    });
    await montar();
    await preencher();
    await clicar("Revisar ajuste");

    expect(dialogo()).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Empresa não encontrada",
    );
  });
});

describe("trocar o tipo de nota troca a série junto", () => {
  // A NFC-e do PDV numera separado da NF-e e tem `serieNfce` própria na mesma
  // tela de configuração. Manter a série da NF-e no campo ao escolher "nota do
  // PDV" ajustaria o contador da série ERRADA — a mesma família de erro de
  // mexer no CNPJ errado, só que no eixo da série, e igualmente irreversível.
  // Há mais de um Select na tela (Ambiente, Tipo de nota): escolher pelo
  // primeiro `[data-escolher]` clicaria no campo errado e o teste passaria por
  // engano. Ancora no Select que contém o gatilho daquele campo.
  const escolher = (campoId: string, valor: string) =>
    act(async () => {
      const gatilho = container.querySelector(`#${campoId}`);
      const select = gatilho?.closest('[data-testid="select"]');
      const botaoOpcao = select?.querySelector(`[data-escolher="${valor}"]`);
      if (!botaoOpcao) throw new Error(`opção ${valor} não está no campo ${campoId}`);
      (botaoOpcao as HTMLButtonElement).click();
    });
  const serieNaTela = () =>
    (container.querySelector("#ajuste-serie") as HTMLInputElement).value;

  it("NF-e usa serieNfe e NFC-e usa serieNfce", async () => {
    await montar({ seriePadrao: 4, serieNfcePadrao: 7 });
    await act(async () => botao("Ajustar próximo número").click());
    expect(serieNaTela()).toBe("4");

    await escolher("ajuste-modelo", "65");
    expect(serieNaTela()).toBe("7");

    await escolher("ajuste-modelo", "55");
    expect(serieNaTela()).toBe("4");
  });

  it("sem serieNfce informada, a nota do PDV cai na série 1 — nunca na da NF-e", async () => {
    await montar({ seriePadrao: 9, serieNfcePadrao: null });
    await act(async () => botao("Ajustar próximo número").click());
    await escolher("ajuste-modelo", "65");
    expect(serieNaTela()).toBe("1");
  });

  it("o corpo enviado leva a série do tipo de nota escolhido", async () => {
    await montar({ seriePadrao: 4, serieNfcePadrao: 7 });
    await act(async () => botao("Ajustar próximo número").click());
    await escolher("ajuste-modelo", "65");
    await act(async () => digitar("#ajuste-proximo", "5000"));
    await act(async () => digitar("#ajuste-motivo", RESPOSTA_200.ajuste.motivo));
    filaPost = [{ ok: false, body: RESPOSTA_409 }];
    await clicar("Revisar ajuste");
    expect(posts()[0].body).toMatchObject({ modelo: "65", serie: 7 });
  });
});

describe("escopo por emitente", () => {
  it("sem companyId explícito manda null (CNPJ padrão) e lê o preview da config padrão", async () => {
    filaPost.push({ ok: false, body: RESPOSTA_409 });
    await montar({ companyId: null });
    await preencher();
    await clicar("Revisar ajuste");

    expect(posts()[0].body.companyFiscalConfigId).toBeNull();
    for (const get of chamadas.filter((c) => c.method === "GET")) {
      expect(get.url).not.toContain("companyId=");
    }
  });

  it("com companyId, TODA chamada carrega o emitente — leitura e escrita", async () => {
    filaPost.push({ ok: false, body: RESPOSTA_409 });
    await montar({ companyId: "cfg-outra" });
    await preencher();
    // Deixa o preview (debounce de 350ms) acontecer.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    await clicar("Revisar ajuste");

    const gets = chamadas.filter((c) => c.method === "GET");
    expect(gets.length).toBeGreaterThan(0);
    for (const get of gets) expect(get.url).toContain("companyId=cfg-outra");
    expect(posts()[0].body.companyFiscalConfigId).toBe("cfg-outra");
  });
});
