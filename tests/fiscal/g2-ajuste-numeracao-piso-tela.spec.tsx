// @vitest-environment jsdom
//
// B6: o card de ajuste do próximo número, quando o wizard o mostra depois do 409
// SEQUENCIA_ATRAS_DA_SEFAZ, nasce ABERTO (`abertoInicial`) e mostra o mínimo que
// a SEFAZ indicou (`pisoSugerido`) só como TEXTO de apoio. O campo do número
// continua em branco: o ajuste é irreversível e o número certo é o que a pessoa
// conferiu no portal (o mínimo pode estar abaixo do último usado pelo CNPJ).
// Sem as props novas, o card é o de sempre (fechado, sem o texto) — a tela de
// configuração não muda.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));
vi.mock("@/components/ui/select", async () => {
  const { createElement: h } = await import("react");
  return {
    Select: ({ value, children }: any) => h("div", { "data-testid": "select", "data-value": value }, children),
    SelectTrigger: ({ children, id }: any) => h("div", { id }, children),
    SelectValue: () => null,
    SelectContent: ({ children }: any) => h("div", null, children),
    SelectItem: ({ value, children }: any) => h("div", { "data-item": value }, children),
  };
});
vi.mock("@/components/ui/alert-dialog", async () => {
  const { createElement: h } = await import("react");
  return {
    AlertDialog: ({ open, children }: any) => (open ? h("div", { "data-testid": "dialogo" }, children) : null),
    AlertDialogContent: ({ children }: any) => h("div", null, children),
    AlertDialogHeader: ({ children }: any) => h("div", null, children),
    AlertDialogFooter: ({ children }: any) => h("div", null, children),
    AlertDialogTitle: ({ children }: any) => h("div", null, children),
    AlertDialogDescription: ({ children }: any) => h("div", null, children),
    AlertDialogCancel: ({ children }: any) => h("button", null, children),
  };
});

import { AjusteNumeracaoCard } from "../../app/notas-fiscais/components/steps/ajuste-numeracao-card";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ serie: 1, ambiente: "PRODUCAO", proximoNumero: 13 }) })));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function montar(props: Partial<React.ComponentProps<typeof AjusteNumeracaoCard>> = {}) {
  await act(async () => {
    root.render(<AjusteNumeracaoCard userEmail="dona@dls.test" configExists companyId="cfg-dls" ambientePadrao="PRODUCAO" seriePadrao={1} {...props} />);
  });
  await act(async () => { await Promise.resolve(); });
}
const texto = () => container.textContent ?? "";

describe("AjusteNumeracaoCard com abertoInicial + pisoSugerido (wizard, B6)", () => {
  it("nasce aberto, com série/ambiente do 409, o número EM BRANCO e o mínimo só como texto", async () => {
    await montar({ abertoInicial: true, pisoSugerido: 14 });
    const proximo = container.querySelector("#ajuste-proximo") as HTMLInputElement | null;
    expect(proximo, texto()).toBeTruthy();
    expect(proximo!.value).toBe("");
    expect((container.querySelector("#ajuste-serie") as HTMLInputElement).value).toBe("1");
    expect(container.querySelector('[data-testid="select"]')?.getAttribute("data-value")).toBe("PRODUCAO");
    expect(texto()).toContain("14");
    expect(texto()).toMatch(/portal da SEFAZ/);
    // Aberto de cara: o botão de abrir não aparece.
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Ajustar próximo número")).toBe(false);
  });

  it("sem as props novas: o card de sempre — fechado e sem o texto do mínimo", async () => {
    await montar();
    expect(container.querySelector("#ajuste-proximo")).toBeNull();
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Ajustar próximo número")).toBe(true);
    expect(texto()).not.toMatch(/precisa ser/);
  });

  it("abertoInicial sem piso: aberto, sem inventar mínimo", async () => {
    await montar({ abertoInicial: true });
    expect(container.querySelector("#ajuste-proximo")).toBeTruthy();
    expect(texto()).not.toMatch(/precisa ser/);
  });
});
