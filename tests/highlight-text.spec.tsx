import React from "react";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { HighlightText } from "../app/localizacoes/components/highlight-text";

describe("HighlightText", () => {
  it("destaca substring simples", () => {
    const html = renderToString(
      <HighlightText text="PRAT-02" tokens={["prat"]} />,
    );
    expect(html).toContain("<mark");
    expect(html).toContain("PRAT");
  });

  it("tokens vazios → sem <mark>, texto puro preservado", () => {
    const html = renderToString(<HighlightText text="PRAT-02" tokens={[]} />);
    expect(html).not.toContain("<mark");
    expect(html).toContain("PRAT-02");
  });

  it("destaca apesar do acento (busca acento-insensível, texto acentuado)", () => {
    const html = renderToString(
      <HighlightText text="Galpão Norte" tokens={["galpao"]} />,
    );
    expect(html).toContain("<mark");
    // o trecho destacado preserva o caractere original acentuado
    expect(html).toContain("Galpão".slice(0, 6)); // "Galpão"
  });

  it("destaca múltiplos termos no mesmo texto", () => {
    const html = renderToString(
      <HighlightText text="Armazém Norte 02" tokens={["armazem", "02"]} />,
    );
    const marks = html.match(/<mark/g) ?? [];
    expect(marks.length).toBeGreaterThanOrEqual(2);
  });

  it("texto sem match não recebe <mark>", () => {
    const html = renderToString(
      <HighlightText text="PRAT-02" tokens={["xyz"]} />,
    );
    expect(html).not.toContain("<mark");
  });
});
