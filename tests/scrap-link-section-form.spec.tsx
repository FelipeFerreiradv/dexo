// @vitest-environment jsdom
//
// O seletor de sucata DENTRO DE UM <form>, com o Radix de verdade.
//
// Este spec existe por causa de um furo metodológico que custou um deploy
// inteiro: o outro spec (`scrap-link-section.spec.tsx`) substitui o Select por
// um dublê, então prova que a seção PASSA o valor certo — nunca que o Radix o
// aceita. E o defeito estava exatamente aí.
//
// O MECANISMO, no código do Radix (`react-select/dist/index.mjs`):
//
//   const isFormControl = trigger ? form || !!trigger.closest("form") : true;
//
// Dentro de um <form>, o Radix monta um <select> NATIVO espelhando o seletor,
// para o formulário enxergar o campo. E o `SelectBubbleInput` sincroniza assim:
//
//   if (prevValue !== value) { setValue.call(select, value);
//                              select.dispatchEvent(new Event("change")); }
//
// e o Root devolve isso para a aplicação: `onChange: (e) => setValue(e.target.value)`.
//
// Se o `value` muda no MESMO commit em que a <option> daquela sucata aparece, o
// <select> nativo ainda não a conhece. O browser recusa o valor, cai na PRIMEIRA
// <option> — "Sem sucata" — e devolve ISSO pelo `change`. O seletor apagava o
// vínculo que acabara de ler, e a tela dizia "Sem sucata" para uma peça
// vinculada.
//
// O <select> nativo é o oráculo honesto aqui: se ele está sincronizado, não há
// eco espúrio para apagar nada. Por isso é ele que os casos abaixo medem.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Polyfills que o Radix exige e o jsdom não traz.
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as any).DOMRect = class {
  constructor(
    public x = 0,
    public y = 0,
    public width = 0,
    public height = 0,
  ) {}
  top = 0;
  left = 0;
  right = 0;
  bottom = 0;
  static fromRect() {
    return new (globalThis as any).DOMRect();
  }
  toJSON() {
    return {};
  }
};
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
if (!(globalThis as any).PointerEvent) {
  (globalThis as any).PointerEvent = class extends Event {};
}

const PRODUTO = "cmt1sqmas037o18lp9n6k5rzr"; // SKU 6368 do caso real
const SUCATA = "cmrpmx6f0039y18i6s5c9f6gy"; // FORD FUSION 2009 (HHW1478)

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { email: "anuncio1.akitem@gmail.com" } },
  }),
}));
vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));

import { ScrapLinkSection } from "../app/produtos/components/scrap-link-section";

const VINCULADO = {
  scrapId: SUCATA,
  scrapLabel: "FORD FUSION 2009",
  marketplaceSales: 0,
  counterSales: 0,
  pinnedCounterSales: 0,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

// O <select> nativo do Radix vive num portal fora do container. Sem limpar o
// body entre os casos, `querySelector("select")` devolveria o do caso anterior
// e o spec mediria a árvore errada.
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** O <select> que o Radix cria por estarmos dentro de um formulário. */
function selectNativo(): HTMLSelectElement | null {
  return document.querySelector("select");
}

function trigger(): string {
  return document.querySelector("#edit-scrap-link")?.textContent ?? "";
}

async function montarEmForm(corpo: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => corpo })),
  );
  await act(async () => {
    root.render(
      <form>
        <ScrapLinkSection productId={PRODUTO} onToast={() => {}} />
      </form>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

describe("ScrapLinkSection dentro de <form> — o caso que quebrou em produção", () => {
  it("REGRESSÃO: o <select> nativo fica com o ID da sucata, não com 'Sem sucata'", async () => {
    await montarEmForm(VINCULADO);

    const nativo = selectNativo();
    expect(nativo).not.toBeNull();

    // O coração do bug. Com o valor aplicado no mesmo commit da <option>, aqui
    // vinha "__none__" — e era esse valor que voltava pelo `change` e apagava
    // o vínculo da tela.
    expect(nativo!.value).toBe(SUCATA);
    expect(nativo!.value).not.toBe("__none__");

    // E a <option> precisa existir, senão o browser recusaria de novo.
    const options = Array.from(nativo!.options).map((o) => o.value);
    expect(options).toContain(SUCATA);
  });

  it("o rótulo do lote aparece no seletor", async () => {
    await montarEmForm(VINCULADO);
    expect(trigger()).toContain("FORD FUSION 2009");
    expect(trigger()).not.toBe("Sem sucata");
  });

  it("sem vínculo: o nativo fica em 'Sem sucata' — que aí é a verdade", async () => {
    await montarEmForm({ ...VINCULADO, scrapId: null, scrapLabel: null });

    expect(selectNativo()!.value).toBe("__none__");
    expect(trigger()).toContain("Sem sucata");
  });

  it("erro na leitura: o nativo não afirma vínculo nenhum e o seletor trava", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    await act(async () => {
      root.render(
        <form>
          <ScrapLinkSection productId={PRODUTO} onToast={() => {}} />
        </form>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(trigger()).not.toContain("Sem sucata");
    expect(trigger()).toMatch(/não carregado|nao carregado/i);
  });

  it("fora de <form> continua correto (o Radix nem cria o <select> nativo)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => VINCULADO,
      })),
    );
    await act(async () => {
      root.render(<ScrapLinkSection productId={PRODUTO} onToast={() => {}} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(selectNativo()).toBeNull();
    expect(trigger()).toContain("FORD FUSION 2009");
  });
});
