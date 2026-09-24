// @vitest-environment jsdom
//
// O passo "Impostos" do wizard montado DE VERDADE (com efeito e `fetch`), pelo
// mesmo motivo do `tests/fiscal/numeracao/ajuste-proximo-numero-tela.spec.tsx`:
// um teste que lê o código prova que a linha existe, não que a tela faz o que
// promete.
//
// O caso da DLS (24/09/2026): rascunho de devolução feito À MÃO. O wizard tenta
// `GET /devolucao`, leva 404, segue como nota comum e renderiza este passo — que
// chama `/calculate`. Lá o rascunho tem `finalidade=DEVOLUCAO` e o backend
// devolve 404 DEVOLUCAO_NAO_GERENCIADA. Era aqui que ela ficava presa, clicando
// num "Tentar novamente" que repetia o mesmo 404.
//
// O que só o teste MONTADO prova:
//  - o botão que repete o erro SUMIU neste caso (e continua nos outros);
//  - no lugar dele há um caminho de saída clicável para a lista certa;
//  - o passo a passo aparece na tela, não só no módulo puro;
//  - nada fica chamando o servidor em laço.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));

import { StepImpostos } from "../../../app/notas-fiscais/components/steps/step-impostos";
import { DEVOLUCAO_ERRO_MENSAGEM } from "../../../app/fiscal/devolucao/contrato";

const EMAIL = "dono@desmanche.test";
const DRAFT = "draft-dls-devolucao";

type Resposta = { ok: boolean; status: number; body: unknown } | { lancar: string };

let container: HTMLDivElement;
let root: Root;
let chamadas: string[];
let fila: Resposta[];

const texto = () => container.textContent ?? "";
const botoes = () => Array.from(container.querySelectorAll("button"));
const links = () => Array.from(container.querySelectorAll("a"));

function acharBotao(rotulo: string): HTMLButtonElement | undefined {
  return botoes().find((b) => (b.textContent ?? "").includes(rotulo)) as
    | HTMLButtonElement
    | undefined;
}

async function assentar() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function montar() {
  await act(async () => {
    root.render(
      <StepImpostos
        getValues={(() => ({})) as never}
        draftId={DRAFT}
        email={EMAIL}
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

const RESPOSTA_NAO_GERENCIADA: Resposta = {
  ok: false,
  status: 404,
  body: {
    error: DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_NAO_GERENCIADA,
    code: "DEVOLUCAO_NAO_GERENCIADA",
  },
};

describe("passo Impostos — rascunho de devolução não gerenciada", () => {
  it("tira o botão que só repetiria o erro", async () => {
    fila = [RESPOSTA_NAO_GERENCIADA];
    await montar();

    expect(acharBotao("Tentar novamente")).toBeUndefined();
    // E não é que a tela ficou vazia: o quadro de erro está lá.
    expect(texto()).toContain("não dá para emitir por esta tela");
    // Uma chamada e ponto — sem laço de tentativa.
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toContain(`/fiscal/nfe/draft/${DRAFT}/calculate`);
  });

  it("põe no lugar um caminho de saída para a lista onde a devolução se cria", async () => {
    fila = [RESPOSTA_NAO_GERENCIADA];
    await montar();

    const saida = links().find((a) => (a.textContent ?? "").includes("Notas Emitidas"));
    expect(saida).toBeDefined();
    expect(saida!.getAttribute("href")).toBe("/notas-fiscais/emitidas");
  });

  it("mostra o passo a passo da emissão certa, com os rótulos das telas", async () => {
    fila = [RESPOSTA_NAO_GERENCIADA];
    await montar();

    const itens = Array.from(container.querySelectorAll("ol li")).map(
      (li) => li.textContent ?? "",
    );
    expect(itens.length).toBeGreaterThanOrEqual(5);

    const tudo = texto();
    expect(tudo).toContain('"Notas Emitidas"');
    expect(tudo).toContain('"Devolver total"');
    expect(tudo).toContain('"Devolver parcial"');
    expect(tudo).toContain('"Salvar devolução"');
    expect(tudo).toContain('"Emitir NF-e"');
    // Diz que o rascunho atual não se aproveita.
    expect(tudo).toContain("Não adianta tentar de novo");
  });
});

describe("passo Impostos — erro passageiro continua como antes", () => {
  it("500 do servidor mantém a mensagem dele e o 'Tentar novamente' que funciona", async () => {
    fila = [
      { ok: false, status: 500, body: { error: "Erro ao calcular impostos" } },
      { ok: true, status: 200, body: { totais: { totalNota: 1234.5 } } },
    ];
    await montar();

    expect(texto()).toContain("Erro ao calcular impostos");
    const botao = acharBotao("Tentar novamente");
    expect(botao).toBeDefined();
    // Nenhum caminho de saída aqui: repetir É a saída.
    expect(links()).toHaveLength(0);

    await act(async () => botao!.click());
    await assentar();

    expect(chamadas).toHaveLength(2);
    expect(texto()).toContain("Total da Nota");
    expect(acharBotao("Tentar novamente")).toBeUndefined();
  });

  it("rede caída (fetch rejeitado) mantém o 'Tentar novamente'", async () => {
    fila = [{ lancar: "Failed to fetch" }];
    await montar();

    expect(acharBotao("Tentar novamente")).toBeDefined();
    expect(texto()).toContain("Failed to fetch");
  });

  it("400 sem código (item sem NCM) mantém o 'Tentar novamente'", async () => {
    fila = [
      {
        ok: false,
        status: 400,
        body: {
          error:
            'Item 1 ("Farol direito") esta sem NCM. Preencha o NCM antes de calcular.',
        },
      },
    ];
    await montar();

    expect(acharBotao("Tentar novamente")).toBeDefined();
    expect(texto()).toContain("sem NCM");
    expect(links()).toHaveLength(0);
  });
});
