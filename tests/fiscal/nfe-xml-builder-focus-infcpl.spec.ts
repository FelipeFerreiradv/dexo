import { describe, it, expect } from "vitest";
import { NfeXmlBuilderService } from "../../app/fiscal/generators/nfe-xml-builder.service";
import { makeConfig, makeDraft } from "./__helpers__/test-draft";

describe("NfeXmlBuilderService (Focus) — informacoes_adicionais_contribuinte", () => {
  const builder = new NfeXmlBuilderService();

  it("TRAVA de regressao: sem observacao e sem pedido a chave nao entra no payload", () => {
    const payload = builder.build(makeDraft(), makeConfig(), 1);
    expect("informacoes_adicionais_contribuinte" in payload).toBe(false);
  });

  it("apenas pedido: comportamento atual inalterado", () => {
    const payload = builder.build(
      makeDraft({ numeroPedido: "PED-001" }),
      makeConfig(),
      1,
    );
    expect(payload.informacoes_adicionais_contribuinte).toBe(
      "Pedido: PED-001",
    );
  });

  it("apenas observacao", () => {
    const payload = builder.build(
      makeDraft({ informacoesComplementares: "So a obs" }),
      makeConfig(),
      1,
    );
    expect(payload.informacoes_adicionais_contribuinte).toBe("So a obs");
  });

  it("observacao primeiro, depois o pedido", () => {
    const payload = builder.build(
      makeDraft({
        informacoesComplementares: "Obs livre",
        numeroPedido: "PED-2",
      }),
      makeConfig(),
      1,
    );
    expect(payload.informacoes_adicionais_contribuinte).toBe(
      "Obs livre | Pedido: PED-2",
    );
  });

  it("observacao so com espacos nao seta a chave", () => {
    const payload = builder.build(
      makeDraft({ informacoesComplementares: "  " }),
      makeConfig(),
      1,
    );
    expect("informacoes_adicionais_contribuinte" in payload).toBe(false);
  });
});
