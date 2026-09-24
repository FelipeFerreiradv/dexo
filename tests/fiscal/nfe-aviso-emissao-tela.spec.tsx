// @vitest-environment jsdom
//
// O ULTIMO passo do wizard ("Finalizar") montado DE VERDADE — com efeito,
// `fetch` e estado —, e nao so a funcao pura de texto. Mesmo motivo do
// `tests/fiscal/numeracao/ajuste-proximo-numero-tela.spec.tsx`: a funcao
// `avisoEmissao` ja tem 17 testes e nenhum deles teria pegado o defeito, porque
// o defeito estava em QUEM ALIMENTA a funcao.
//
// A mentira que este arquivo prende:
//   O `useEffect` marcava `configResolvida = true` num `finally` — ou seja,
//   TAMBEM quando a leitura da config falhava — e tinha um atalho
//   `if (!email) { setConfigResolvida(true); return; }`. Com a config NAO lida e
//   um rascunho marcado HOMOLOGACAO, o resolvedor entendia "a config ja foi
//   consultada, o rascunho e o que temos" e a tela voltava a dizer
//   "Ambiente de homologacao — sem valor fiscal" para quem emite em PRODUCAO.
//
//   O rascunho da DLS AUTO PECAS tem exatamente essa forma: a linha nasce
//   HOMOLOGACAO por historico ("hardcoded HOMOLOGACAO historically", comentario
//   do nfe-emission.usecase.ts) e so a CONFIG sabe que a emissao e real. Uma
//   queda de rede no GET bastava para a tela dizer "e so teste" no segundo antes
//   do clique que emite uma nota fiscal de verdade.
//
// Por isso os casos (b), (c) e (d) afirmam a AUSENCIA das duas palavras. Falha
// de rede, `!res.ok` e sessao sem e-mail sao tres portas diferentes para o mesmo
// estado — leitura NAO resolvida — e cada uma tem seu proprio guarda no efeito.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));

import { StepFinalizar } from "../../app/notas-fiscais/components/steps/step-finalizar";

const EMAIL = "dono@desmanche.test";

type Resposta = { ok: boolean; status: number; body: unknown } | { lancar: string };

let container: HTMLDivElement;
let root: Root;
let chamadas: string[];
let fila: Resposta[];

// Nenhum campo aqui contem a palavra "homologacao"/"teste": se ela aparecer no
// textContent, veio do bloco de aviso — que e o que se esta medindo.
const RASCUNHO_DLS = {
  serie: 1,
  tipoOperacao: "ENTRADA",
  finalidade: "DEVOLUCAO",
  destinoOperacao: "INTERNA",
  naturezaOperacao: "Devolucao de compra",
  modalidadeFrete: "SEM_FRETE",
  destinatario: { nome: "DISAUTO DISTRIBUIDORA", cpfCnpj: "11222333000181" },
  itens: [
    { numero: 1, descricao: "Farol direito", quantidade: 1, valorUnitario: 300, valorTotal: 300 },
    { numero: 2, descricao: "Lanterna traseira", quantidade: 1, valorUnitario: 200, valorTotal: 200 },
  ],
  pagamentos: [{ meio: "OUTROS", valor: 500 }],
};

const texto = () => (container.textContent ?? "").toLowerCase();

async function assentar() {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * `ambienteRascunho` fixo em HOMOLOGACAO de proposito: e a forma do rascunho da
 * DLS e o unico sinal capaz de produzir a frase errada. Sem ele nao ha o que
 * provar — o teste passaria por falta de material.
 */
async function montar(email?: string) {
  await act(async () => {
    root.render(
      <StepFinalizar
        getValues={(() => RASCUNHO_DLS) as never}
        ambienteRascunho="HOMOLOGACAO"
        email={email}
      />,
    );
  });
  await assentar();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  chamadas = [];
  fila = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      chamadas.push(url);
      const r = fila.shift();
      if (!r) throw new Error(`chamada inesperada a ${url}`);
      if ("lancar" in r) throw new Error(r.lancar);
      return { ok: r.ok, status: r.status, json: async () => r.body };
    }),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** As duas frases que NAO podem sobrar numa emissao que pode ser real. */
function naoAfirmaTeste() {
  const t = texto();
  expect(t, "a tela nao pode afirmar homologacao sem ter lido a config").not.toContain(
    "homologa",
  );
  expect(t, "a tela nao pode dizer que a nota nao vale").not.toContain("sem valor fiscal");
  expect(t).not.toContain("emissao de teste");
  expect(t).not.toContain("emissão de teste");
}

describe("passo Finalizar — config lida com sucesso", () => {
  it("(a) DLS: rascunho HOMOLOGACAO + config em PRODUCAO ⇒ o aviso afirma producao", async () => {
    fila = [{ ok: true, status: 200, body: { config: { ambiente: "PRODUCAO" } } }];
    await montar(EMAIL);

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toBe("http://api.test/fiscal/config");

    const t = texto();
    expect(t).toContain("vale de verdade");
    expect(t).toContain("produção");
    // O rascunho velho perdeu para a config, que e quem a emissao de fato usa.
    naoAfirmaTeste();
  });

  it("(e) config lida em HOMOLOGACAO ⇒ o aviso de teste, que continua certo", async () => {
    fila = [{ ok: true, status: 200, body: { config: { ambiente: "HOMOLOGACAO" } } }];
    await montar(EMAIL);

    const t = texto();
    expect(t).toContain("ambiente de homologação");
    expect(t).toContain("sem valor fiscal");
    expect(t).not.toContain("vale de verdade");
  });
});

describe("passo Finalizar — leitura da config NAO resolvida", () => {
  it("(b) rede caida (fetch rejeitado) ⇒ nada de 'homologacao' nem 'sem valor fiscal'", async () => {
    fila = [{ lancar: "Failed to fetch" }];
    await montar(EMAIL);

    // A leitura FOI tentada e falhou: nao e o estado "ainda esperando".
    expect(chamadas).toHaveLength(1);
    naoAfirmaTeste();
    // E nao e que o bloco sumiu: ele esta la, com o peso de emissao real.
    expect(texto()).toContain("confirme o ambiente antes de emitir");
    expect(texto()).toContain("o número é definitivo");
  });

  it("(c) config responde !ok (500) ⇒ idem", async () => {
    fila = [{ ok: false, status: 500, body: { error: "Erro interno" } }];
    await montar(EMAIL);

    expect(chamadas).toHaveLength(1);
    naoAfirmaTeste();
    expect(texto()).toContain("confirme o ambiente antes de emitir");
  });

  it("(d) sessao sem e-mail (GET impossivel) ⇒ idem, e sem chamada nenhuma", async () => {
    await montar(undefined);

    expect(chamadas).toHaveLength(0);
    naoAfirmaTeste();
    expect(texto()).toContain("confirme o ambiente antes de emitir");
    // Nao resolvida tambem pesa como emissao real: o numero nao volta.
    expect(texto()).toContain("o número é definitivo");
  });
});
