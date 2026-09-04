import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NfeXmlBuilderSefazService } from "../../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { makeConfig, makeDraft, makeItem } from "../__helpers__/test-draft";

const FIXED_DH = new Date("2026-05-14T15:00:00-03:00");

function ligar() {
  vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", "true");
}
function desligar() {
  vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", "false");
}

/** Soma, em centavos, os vFrete que aparecem dentro dos prod dos itens. */
function somaVFreteItens(xml: string): number {
  const dets = xml.match(/<det\b[\s\S]*?<\/det>/g) ?? [];
  return dets.reduce((acc, det) => {
    const m = det.match(/<vFrete>([\d.]+)<\/vFrete>/);
    return acc + (m ? Math.round(Number(m[1]) * 100) : 0);
  }, 0);
}

/** Valor de uma tag dentro do bloco ICMSTot. */
function icmsTot(xml: string, tag: string): string | null {
  const bloco = xml.match(/<ICMSTot>[\s\S]*?<\/ICMSTot>/)?.[0] ?? "";
  return bloco.match(new RegExp("<" + tag + ">([^<]*)</" + tag + ">"))?.[1] ?? null;
}

describe("NfeXmlBuilderSefazService — frete e volumes", () => {
  const builder = new NfeXmlBuilderSefazService();
  const build = (draft: any, config = makeConfig()) =>
    builder.build({ draft, config, numero: 1, dhEmi: FIXED_DH, cNF: "87654321" })
      .xml;

  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── Cenário 1 / 6: nota sem os dados novos ──

  describe("controle negativo — nota sem frete e sem volumes", () => {
    it("flag LIGADA produz XML byte-identico ao da flag desligada", () => {
      const draft = makeDraft();
      desligar();
      const semFlag = build(draft);
      vi.unstubAllEnvs();
      ligar();
      const comFlag = build(draft);
      expect(comFlag).toBe(semFlag);
    });

    it("mantem vFrete 0.00 e nao emite vol", () => {
      ligar();
      const xml = build(makeDraft());
      expect(icmsTot(xml, "vFrete")).toBe("0.00");
      expect(icmsTot(xml, "vNF")).toBe("100.00");
      expect(xml).not.toContain("<vol>");
      expect(xml).toContain("<modFrete>9</modFrete>");
    });
  });

  // ── Kill-switch ──

  describe("flag desligada — nada do novo aparece", () => {
    it("descarta frete e volumes preenchidos", () => {
      desligar();
      const xml = build(
        makeDraft({
          valorFrete: 50,
          modalidadeFrete: "CIF",
          volumesJson: [{ quantidade: 2, especie: "CAIXA", pesoBruto: 12.5 }],
        }),
      );
      expect(icmsTot(xml, "vFrete")).toBe("0.00");
      expect(xml).not.toContain("<vol>");
      expect(somaVFreteItens(xml)).toBe(0);
    });
  });

  // ── Cenário 3 / 4 / 5: volumes com peso ──

  describe("grupo vol", () => {
    beforeEach(ligar);

    it("emite um vol por volume, na ordem do XSD", () => {
      const xml = build(
        makeDraft({
          volumesJson: [
            {
              quantidade: 2,
              especie: "CAIXA",
              marca: "DEXO",
              numeracao: "001",
              pesoLiquido: 9.5,
              pesoBruto: 10.25,
            },
          ],
        }),
      );
      expect(xml).toContain(
        "<vol><qVol>2</qVol><esp>CAIXA</esp><marca>DEXO</marca>" +
          "<nVol>001</nVol><pesoL>9.500</pesoL><pesoB>10.250</pesoB></vol>",
      );
    });

    it("vol e o ULTIMO filho de transp, depois de transporta", () => {
      const xml = build(
        makeDraft({
          modalidadeFrete: "CIF",
          transportadoraJson: { cpfCnpj: "12345678000199", nome: "TRANSP X" },
          volumesJson: [{ quantidade: 1, especie: "PALLET" }],
        }),
      );
      const transp = xml.match(/<transp>[\s\S]*?<\/transp>/)?.[0] ?? "";
      expect(transp.indexOf("<modFrete>")).toBeLessThan(
        transp.indexOf("<transporta>"),
      );
      expect(transp.indexOf("</transporta>")).toBeLessThan(
        transp.indexOf("<vol>"),
      );
      expect(transp.endsWith("</vol></transp>")).toBe(true);
    });

    it("emite varios volumes preservando a ordem da lista", () => {
      const xml = build(
        makeDraft({
          volumesJson: [
            { quantidade: 1, especie: "CAIXA" },
            { quantidade: 3, especie: "PALLET" },
          ],
        }),
      );
      expect((xml.match(/<vol>/g) ?? []).length).toBe(2);
      expect(xml.indexOf("CAIXA")).toBeLessThan(xml.indexOf("PALLET"));
    });

    it("omite campos ausentes em vez de emitir tag vazia", () => {
      const xml = build(makeDraft({ volumesJson: [{ pesoBruto: 7 }] }));
      expect(xml).toContain("<vol><pesoB>7.000</pesoB></vol>");
      expect(xml).not.toContain("<qVol>");
      expect(xml).not.toContain("<esp>");
      expect(xml).not.toContain("<pesoL>");
    });

    it("ignora volume sem nenhum dado util (nao cria vol vazio)", () => {
      const xml = build(
        makeDraft({
          volumesJson: [
            { quantidade: null, especie: "", pesoBruto: 0 },
            { marca: "   " },
            {},
            null,
          ],
        }),
      );
      expect(xml).not.toContain("<vol>");
    });

    it("descarta peso e quantidade nao positivos", () => {
      const xml = build(
        makeDraft({
          volumesJson: [
            { quantidade: -1, especie: "CAIXA", pesoBruto: -5, pesoLiquido: 0 },
          ],
        }),
      );
      expect(xml).toContain("<vol><esp>CAIXA</esp></vol>");
    });

    it("volumesJson invalido nao quebra a montagem", () => {
      for (const v of [null, "texto", 42, {}]) {
        expect(() => build(makeDraft({ volumesJson: v as any }))).not.toThrow();
      }
    });
  });

  // ── Cenário 2: valor do frete ──

  describe("valor do frete", () => {
    beforeEach(ligar);

    it("soma dos vFrete dos itens bate com o vFrete do total (Rejeicao 535)", () => {
      const xml = build(
        makeDraft({
          valorFrete: 10,
          modalidadeFrete: "CIF",
          itens: [
            makeItem({ numero: 1 }),
            makeItem({ numero: 2 }),
            makeItem({ numero: 3 }),
          ],
          totaisJson: null,
        }),
      );
      expect(icmsTot(xml, "vFrete")).toBe("10.00");
      expect(somaVFreteItens(xml)).toBe(1000);
    });

    it("fecha a conta tambem em rateio nao exato entre muitos itens", () => {
      const itens = Array.from({ length: 7 }, (_, i) =>
        makeItem({
          numero: i + 1,
          quantidade: 1,
          valorUnitario: 3,
          valorTotal: 3,
        }),
      );
      const xml = build(
        makeDraft({ valorFrete: 0.05, itens, totaisJson: null }),
      );
      expect(icmsTot(xml, "vFrete")).toBe("0.05");
      expect(somaVFreteItens(xml)).toBe(5);
    });

    it("vFrete do item vem ANTES de vDesc (ordem do XSD)", () => {
      const xml = build(
        makeDraft({
          valorFrete: 20,
          itens: [makeItem({ numero: 1, desconto: 5 })],
          totaisJson: null,
        }),
      );
      const prod = xml.match(/<prod>[\s\S]*?<\/prod>/)?.[0] ?? "";
      expect(prod).toContain("<vFrete>");
      expect(prod).toContain("<vDesc>");
      expect(prod.indexOf("<vUnTrib>")).toBeLessThan(prod.indexOf("<vFrete>"));
      expect(prod.indexOf("<vFrete>")).toBeLessThan(prod.indexOf("<vDesc>"));
    });

    it("vNF inclui o frete quando o totaisJson ja foi calculado com ele", () => {
      const xml = build(
        makeDraft({
          valorFrete: 25,
          totaisJson: {
            totalProdutos: 100,
            totalDesconto: 0,
            totalBcIcms: 0,
            totalIcms: 0,
            totalBcIpi: 0,
            totalIpi: 0,
            totalPis: 0,
            totalCofins: 0,
            totalFrete: 25,
            totalNota: 125,
            totalTributos: 0,
          },
        }),
      );
      expect(icmsTot(xml, "vFrete")).toBe("25.00");
      expect(icmsTot(xml, "vNF")).toBe("125.00");
    });

    it("completa o vNF quando o totaisJson e anterior a flag (sem totalFrete)", () => {
      // makeDraft traz totaisJson com totalNota 100 e SEM totalFrete — o caso
      // de um rascunho calculado antes de a flag ser ligada.
      const xml = build(makeDraft({ valorFrete: 25 }));
      expect(icmsTot(xml, "vFrete")).toBe("25.00");
      expect(icmsTot(xml, "vNF")).toBe("125.00");
    });

    it("frete zero/nulo/negativo nao emite vFrete de item", () => {
      for (const v of [0, null, -30]) {
        const xml = build(makeDraft({ valorFrete: v as any }));
        expect(icmsTot(xml, "vFrete"), "frete " + v).toBe("0.00");
        expect(somaVFreteItens(xml), "frete " + v).toBe(0);
        expect(icmsTot(xml, "vNF"), "frete " + v).toBe("100.00");
      }
    });
  });

  // ── NFC-e permanece intocada ──

  describe("modelo 65 (NFC-e)", () => {
    beforeEach(ligar);

    it("ignora frete e volumes, mantendo modFrete 9 e sem vol", () => {
      const xml = build(
        makeDraft({
          modelo: "65",
          modalidadeFrete: "CIF",
          valorFrete: 99,
          volumesJson: [{ quantidade: 1, especie: "CAIXA", pesoBruto: 3 }],
          destinatarioJson: null,
        }),
      );
      expect(xml).toContain("<transp><modFrete>9</modFrete></transp>");
      expect(xml).not.toContain("<vol>");
      expect(icmsTot(xml, "vFrete")).toBe("0.00");
      expect(somaVFreteItens(xml)).toBe(0);
    });
  });
});

// Achado de auditoria: o teto de 5000 era aplicado ANTES do filtro de volume
// vazio, entao entradas vazias no comeco da lista gastavam as vagas e
// descartavam volumes uteis que vinham depois.
describe("teto de volumes aplicado DEPOIS do filtro", () => {
  const builder = new NfeXmlBuilderSefazService();
  const build = (draft: any) =>
    builder.build({
      draft,
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "87654321",
    }).xml;

  beforeEach(() => {
    ligar();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("volumes vazios no inicio nao consomem as vagas dos uteis", () => {
    const vazios = Array.from({ length: 5000 }, () => ({}));
    const xml = build(
      makeDraft({
        volumesJson: [...vazios, { quantidade: 7, especie: "PALLET" }],
      }),
    );
    expect(xml).toContain("<vol><qVol>7</qVol><esp>PALLET</esp></vol>");
    expect((xml.match(/<vol>/g) ?? []).length).toBe(1);
  });

  it("o teto de 5000 continua valendo sobre os volumes uteis", () => {
    const muitos = Array.from({ length: 5002 }, (_, i) => ({
      quantidade: i + 1,
    }));
    const xml = build(makeDraft({ volumesJson: muitos }));
    expect((xml.match(/<vol>/g) ?? []).length).toBe(5000);
  });
});
