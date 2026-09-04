import { describe, it, expect, vi, afterEach } from "vitest";
import {
  composeInfCpl,
  sanitizeFreeText,
  INF_CPL_MAX_LENGTH,
} from "../../app/fiscal/domain/inf-cpl";

describe("composeInfCpl", () => {
  it("vazio quando nada preenchido", () => {
    expect(composeInfCpl({})).toBe("");
    expect(
      composeInfCpl({ informacoesComplementares: null, numeroPedido: null }),
    ).toBe("");
    expect(composeInfCpl({ informacoesComplementares: "   " })).toBe("");
  });

  it("apenas pedido: 'Pedido: N' (comportamento atual)", () => {
    expect(composeInfCpl({ numeroPedido: "PED-001" })).toBe("Pedido: PED-001");
  });

  it("apenas observacao", () => {
    expect(composeInfCpl({ informacoesComplementares: "Obs livre" })).toBe(
      "Obs livre",
    );
  });

  it("ordem: observacao primeiro, depois 'Pedido: N', separador ' | '", () => {
    expect(
      composeInfCpl({ informacoesComplementares: "obs", numeroPedido: "9" }),
    ).toBe("obs | Pedido: 9");
  });

  it("trunca em INF_CPL_MAX_LENGTH", () => {
    const out = composeInfCpl({
      informacoesComplementares: "x".repeat(9000),
    });
    expect(out.length).toBe(INF_CPL_MAX_LENGTH);
  });

  it("obs longa + pedido: o Pedido sobrevive inteiro, a obs cede espaco", () => {
    const out = composeInfCpl({
      informacoesComplementares: "x".repeat(4998),
      numeroPedido: "PED-12345",
    });
    expect(out.length).toBeLessThanOrEqual(INF_CPL_MAX_LENGTH);
    expect(out.endsWith(" | Pedido: PED-12345")).toBe(true);
  });

  it("soma abaixo do limite: nada e truncado", () => {
    const out = composeInfCpl({
      informacoesComplementares: "obs curta",
      numeroPedido: "PED-1",
    });
    expect(out).toBe("obs curta | Pedido: PED-1");
  });
});

describe("sanitizeFreeText", () => {
  it("normaliza CRLF/CR para LF e faz trim", () => {
    expect(sanitizeFreeText("  a\r\nb\rc ")).toBe("a\nb\nc");
  });

  it("remove caracteres de controle, mantendo \\n e \\t", () => {
    const dirty =
      "a" +
      String.fromCharCode(0) +
      "b" +
      String.fromCharCode(7) +
      "\tc\nd" +
      String.fromCharCode(127);
    expect(sanitizeFreeText(dirty)).toBe("ab\tc\nd");
  });

  it("null/undefined/vazio viram string vazia", () => {
    expect(sanitizeFreeText(null)).toBe("");
    expect(sanitizeFreeText(undefined)).toBe("");
    expect(sanitizeFreeText("")).toBe("");
  });
});

// ── Dimensoes dos volumes (entrega frete/medidas) ──
//
// A NF-e 4.00 nao tem campo para comprimento/largura/altura: o grupo <vol> so
// aceita qVol/esp/marca/nVol/pesoL/pesoB. O infCpl e o unico canal.
describe("composeInfCpl — dimensoes dos volumes", () => {
  const VOLUMES = [{ comprimentoCm: 40, larguraCm: 30, alturaCm: 20 }];

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const ligar = () => {
  vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", "true");
};

  it("flag desligada ignora as dimensoes (infCpl byte-identico)", () => {
    vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", "false");
    expect(composeInfCpl({ volumesJson: VOLUMES })).toBe("");
    expect(
      composeInfCpl({ informacoesComplementares: "obs", volumesJson: VOLUMES }),
    ).toBe("obs");
  });

  it("sem volumes com medida o resultado nao muda", () => {
    ligar();
    expect(composeInfCpl({})).toBe("");
    expect(composeInfCpl({ volumesJson: null })).toBe("");
    expect(composeInfCpl({ volumesJson: [{ pesoBruto: 3 }] })).toBe("");
    expect(
      composeInfCpl({ numeroPedido: "PED-1", volumesJson: [{ marca: "X" }] }),
    ).toBe("Pedido: PED-1");
  });

  it("acrescenta as dimensoes quando existem", () => {
    ligar();
    expect(composeInfCpl({ volumesJson: VOLUMES })).toBe(
      "Dimensoes dos volumes: 1) C40 x L30 x A20 cm",
    );
  });

  it("ordem: observacao, dimensoes, pedido", () => {
    ligar();
    expect(
      composeInfCpl({
        informacoesComplementares: "obs",
        numeroPedido: "9",
        volumesJson: VOLUMES,
      }),
    ).toBe("obs | Dimensoes dos volumes: 1) C40 x L30 x A20 cm | Pedido: 9");
  });

  it("no limite de 5000 quem cede e a observacao, nunca pedido/dimensoes", () => {
    ligar();
    const out = composeInfCpl({
      informacoesComplementares: "x".repeat(INF_CPL_MAX_LENGTH),
      numeroPedido: "PED-001",
      volumesJson: VOLUMES,
    });
    expect(out.length).toBeLessThanOrEqual(INF_CPL_MAX_LENGTH);
    expect(out).toContain("Pedido: PED-001");
    expect(out).toContain("Dimensoes dos volumes: 1) C40 x L30 x A20 cm");
    expect(out.endsWith("Pedido: PED-001")).toBe(true);
  });
});

// Regressao achada em auditoria: sem teto, uma nota com muitos volumes fazia as
// dimensoes ocuparem os 5000 caracteres e o `.slice` final cortava o
// "Pedido: N" ao meio (ou o eliminava). Antes desta entrega o pedido NUNCA
// podia ser perdido — a invariante tinha de voltar.
describe("composeInfCpl — teto com muitos volumes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const muitosVolumes = (n: number) =>
    Array.from({ length: n }, () => ({
      comprimentoCm: 40,
      larguraCm: 30,
      alturaCm: 20,
    }));

  it.each([203, 205, 250, 1000])(
    "com %i volumes o Pedido sobrevive INTEIRO e nada estoura 5000",
    (n) => {
      vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", "true");
      const out = composeInfCpl({
        numeroPedido: "PED-001",
        volumesJson: muitosVolumes(n),
      });
      expect(out.length).toBeLessThanOrEqual(INF_CPL_MAX_LENGTH);
      expect(out.endsWith("Pedido: PED-001")).toBe(true);
      // Corte sempre em volume INTEIRO: o marcador vem logo depois de um
      // "... cm" completo, nunca no meio de uma medida.
      expect(out).toContain(" cm; (...)");
    },
  );

  it("com observacao E pedido, os dois fixos continuam intactos", () => {
    vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", "true");
    const out = composeInfCpl({
      informacoesComplementares: "obs importante",
      numeroPedido: "PED-001",
      volumesJson: muitosVolumes(500),
    });
    expect(out.length).toBeLessThanOrEqual(INF_CPL_MAX_LENGTH);
    expect(out.endsWith("Pedido: PED-001")).toBe(true);
  });

  it("poucos volumes nao ganham marcador de corte", () => {
    vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", "true");
    const out = composeInfCpl({
      numeroPedido: "PED-001",
      volumesJson: muitosVolumes(3),
    });
    expect(out).not.toContain("(...)");
    expect(out).toBe(
      "Dimensoes dos volumes: 1) C40 x L30 x A20 cm; 2) C40 x L30 x A20 cm; " +
        "3) C40 x L30 x A20 cm | Pedido: PED-001",
    );
  });
});
