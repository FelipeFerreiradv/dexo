// @vitest-environment jsdom
//
// BLOCO J — a seção de vínculo de lote, montada DE VERDADE (com efeitos e
// `fetch`), não só lida.
//
// Por que este spec existe: em 20/08/2026 a seção mostrou "Sem sucata" para uma
// peça vinculada. O backend estava certo — `Product.scrapId` gravado, quatro
// `GET /scrap-link → 200` no log de produção, e o corpo
// `{"scrapId":"cmrpmx…","scrapLabel":"FORD FUSION 2009"}` visto no DevTools ao
// lado da tela dizendo o contrário. O defeito estava entre a resposta chegar e
// o componente pintá-la.
//
// Um teste que só lesse o código-fonte provaria que a linha existe, não que ela
// calcula certo. Por isso aqui o componente é montado num DOM real (jsdom) e o
// `fetch` é controlado: o que se afirma é o que o operador VÊ depois do ciclo.
//
// O Radix Select é substituído por um stub que expõe `value`/`placeholder`/
// `disabled` como atributos. Não é para fugir do trabalho: o Radix precisa de
// ResizeObserver e PointerEvent, que o jsdom não tem, e o contrato que quebrou
// foi justamente QUAL value/placeholder a seção manda para o seletor.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Sem isto o React avisa "not configured to support act(...)" e as atualizações
// de estado disparadas dentro de `act` não são garantidamente drenadas — o
// teste passaria por sorte de agendamento, não por comportamento.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const EMAIL = "anuncio1.akitem@gmail.com";
const PRODUTO = "cmt1sqmas037o18lp9n6k5rzr"; // SKU 6368 do caso real
const SUCATA = "cmrpmx6f0039y18i6s5c9f6gy"; // FORD FUSION 2009 (HHW1478)

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { email: EMAIL } } }),
}));

vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));

// Stub do Select: guarda no DOM o que a seção decidiu mostrar.
//
// Sem JSX aqui de propósito: a fábrica de `vi.mock` é içada para ANTES dos
// imports, e o JSX compilado referenciaria um `React` que ainda não existe
// nesse instante ("React is not defined"). `createElement` importado dentro da
// própria fábrica não tem esse problema.
vi.mock("@/components/ui/select", async () => {
  const { createElement: h } = await import("react");
  return {
    Select: ({ value, disabled, children }: any) =>
      h(
        "div",
        {
          "data-testid": "select",
          "data-value": value,
          "data-disabled": String(!!disabled),
        },
        children,
      ),
    SelectTrigger: ({ children }: any) => h("div", null, children),
    SelectValue: ({ placeholder }: any) =>
      h("span", { "data-testid": "placeholder" }, placeholder),
    SelectContent: ({ children }: any) => h("div", null, children),
    SelectItem: ({ value, children }: any) =>
      h("div", { "data-item": value }, children),
  };
});

import { ScrapLinkSection } from "../app/produtos/components/scrap-link-section";

const CORPO_VINCULADO = {
  scrapId: SUCATA,
  scrapLabel: "FORD FUSION 2009",
  marketplaceSales: 0,
  counterSales: 0,
  pinnedCounterSales: 0,
};

let container: HTMLDivElement;
let root: Root;

/** Monta a seção e deixa os efeitos (incluindo o fetch) assentarem. */
async function montar() {
  await act(async () => {
    root.render(<ScrapLinkSection productId={PRODUTO} onToast={() => {}} />);
  });
  // Uma volta a mais para o `await res.json()` resolver antes das asserções.
  await act(async () => {
    await Promise.resolve();
  });
}

const select = () => container.querySelector('[data-testid="select"]')!;
const placeholder = () =>
  container.querySelector('[data-testid="placeholder"]')?.textContent ?? "";
const textoVisivel = () => container.textContent ?? "";

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("ScrapLinkSection — o seletor não pode mentir sobre o lote", () => {
  it("REGRESSÃO 20/08: 200 com scrapId ⇒ mostra a sucata, não 'Sem sucata'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => CORPO_VINCULADO,
      })),
    );

    await montar();

    // Este era o bug: o mesmo corpo chegava e a tela dizia "Sem sucata".
    expect(select().getAttribute("data-value")).toBe(SUCATA);
    expect(select().getAttribute("data-value")).not.toBe("__none__");
    expect(select().getAttribute("data-disabled")).toBe("false");
    // E o rótulo do lote tem de estar entre as opções mesmo sem a lista de
    // sucatas ter sido carregada (ela só carrega ao abrir o seletor).
    expect(textoVisivel()).toContain("FORD FUSION 2009");
  });

  it("200 com scrapId null ⇒ aí sim 'Sem sucata', e dá para alterar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ...CORPO_VINCULADO,
          scrapId: null,
          scrapLabel: null,
        }),
      })),
    );

    await montar();

    expect(select().getAttribute("data-value")).toBe("__none__");
    expect(select().getAttribute("data-disabled")).toBe("false");
  });

  it("404 ⇒ mostra ERRO e trava o seletor; jamais 'Sem sucata'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      })),
    );

    await montar();

    expect(select().getAttribute("data-value")).toBe("");
    expect(select().getAttribute("data-disabled")).toBe("true");
    expect(placeholder()).not.toBe("Sem sucata");
    expect(textoVisivel()).toContain("Tentar de novo");
  });

  it("500 ⇒ idem: erro visível, seletor travado", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );

    await montar();

    expect(select().getAttribute("data-disabled")).toBe("true");
    expect(textoVisivel()).toMatch(/servidor/i);
    expect(textoVisivel()).toContain("Tentar de novo");
  });

  it("falha de rede ⇒ erro visível (o `catch {}` antigo engolia isto)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await montar();

    expect(select().getAttribute("data-disabled")).toBe("true");
    expect(textoVisivel()).toContain("Tentar de novo");
  });

  it("'Tentar de novo' RECUPERA: erro → clique → vínculo na tela", async () => {
    // O coração da correção. Antes, uma leitura perdida era terminal: `info`
    // ficava null para sempre e nada refazia a busca.
    let chamada = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        chamada += 1;
        if (chamada === 1) {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => CORPO_VINCULADO };
      }),
    );

    await montar();
    expect(select().getAttribute("data-disabled")).toBe("true");

    const botao = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Tentar de novo"),
    )!;
    expect(botao).toBeTruthy();

    await act(async () => {
      botao.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(chamada).toBe(2);
    expect(select().getAttribute("data-value")).toBe(SUCATA);
    expect(select().getAttribute("data-disabled")).toBe("false");
    expect(textoVisivel()).not.toContain("Tentar de novo");
  });

  it("CONTROLE NEGATIVO: no 1º frame ainda não há resposta ⇒ 'Carregando', não 'Sem sucata'", async () => {
    // Sem este caso, os testes acima passariam mesmo que a seção continuasse
    // nascendo em NO_SCRAP — que era exatamente o defeito.
    let liberar: (v: any) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            liberar = resolve;
          }),
      ),
    );

    await act(async () => {
      root.render(<ScrapLinkSection productId={PRODUTO} onToast={() => {}} />);
    });

    expect(select().getAttribute("data-value")).toBe("");
    expect(select().getAttribute("data-disabled")).toBe("true");
    expect(placeholder()).toMatch(/carregando/i);
    expect(placeholder()).not.toBe("Sem sucata");

    // E, quando a resposta enfim chega, a tela se corrige.
    await act(async () => {
      liberar({ ok: true, status: 200, json: async () => CORPO_VINCULADO });
      await Promise.resolve();
    });
    expect(select().getAttribute("data-value")).toBe(SUCATA);
  });
});
