import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NfeXmlBuilderService } from "../../app/fiscal/generators/nfe-xml-builder.service";
import { renderDanfeOficial } from "../../app/fiscal/generators/danfe-oficial-renderer";
import { makeConfig, makeDraft, makeItem } from "./__helpers__/test-draft";

const ligar = () => {
  vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", "true");
};
const desligar = () => {
  vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", "false");
};

// ── Provedor Focus NFe (caminho de rollback) ──
//
// A Focus monta o XML no lado dela, mas a Rejeicao 535 vale igual: o vFrete do
// total tem de bater com a soma dos itens. Por isso mandamos os DOIS niveis em
// vez de confiar que ela rateie. Nomes dos campos (`valor_frete` na nota e no
// item) conferidos em campos.focusnfe.com.br.
describe("NfeXmlBuilderService (Focus) — frete", () => {
  const builder = new NfeXmlBuilderService();

  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const somaFreteItens = (payload: any) =>
    (payload.items ?? []).reduce(
      (acc: number, i: any) =>
        acc + Math.round(Number(i.valor_frete ?? 0) * 100),
      0,
    );

  it("TRAVA de regressao: sem frete a chave nao entra no payload", () => {
    ligar();
    const payload: any = builder.build(makeDraft(), makeConfig(), 1);
    expect("valor_frete" in payload).toBe(false);
    expect(payload.items.every((i: any) => !("valor_frete" in i))).toBe(true);
  });

  it("flag desligada descarta o frete mesmo preenchido", () => {
    desligar();
    const payload: any = builder.build(
      makeDraft({ valorFrete: 50, modalidadeFrete: "CIF" }),
      makeConfig(),
      1,
    );
    expect("valor_frete" in payload).toBe(false);
    expect(somaFreteItens(payload)).toBe(0);
  });

  it("envia o frete na nota e rateado nos itens, com somas iguais", () => {
    ligar();
    const payload: any = builder.build(
      makeDraft({
        valorFrete: 10,
        modalidadeFrete: "CIF",
        itens: [
          makeItem({ numero: 1 }),
          makeItem({ numero: 2 }),
          makeItem({ numero: 3 }),
        ],
      }),
      makeConfig(),
      1,
    );
    expect(payload.valor_frete).toBe("10.00");
    expect(somaFreteItens(payload)).toBe(1000);
  });

  it("frete negativo nao vira campo (nem na nota, nem nos itens)", () => {
    ligar();
    const payload: any = builder.build(
      makeDraft({ valorFrete: -20 }),
      makeConfig(),
      1,
    );
    expect("valor_frete" in payload).toBe(false);
    expect(somaFreteItens(payload)).toBe(0);
  });

  it("nao mexe na modalidade nem no bloco de volumes ja existentes", () => {
    ligar();
    const payload: any = builder.build(
      makeDraft({
        valorFrete: 10,
        modalidadeFrete: "CIF",
        volumesJson: [
          { quantidade: 2, especie: "CAIXA", pesoLiquido: 9, pesoBruto: 10 },
        ],
      }),
      makeConfig(),
      1,
    );
    expect(payload.modalidade_frete).toBe("0");
    expect(payload.volumes).toEqual([
      {
        quantidade: "2",
        especie: "CAIXA",
        marca: undefined,
        peso_liquido: "9",
        peso_bruto: "10",
      },
    ]);
  });
});

// ── DANFE ──
//
// O spec do renderer oficial nao extrai texto do PDF (pdf-lib nao le de volta),
// entao aqui a garantia e a mesma dos demais: renderiza sem quebrar nos dois
// shapes de `totaisJson` — o novo (com totalFrete) e o legado (sem a chave, que
// cai no `?? 0`).
describe("renderDanfeOficial — valor do frete", () => {
  const CHAVE = "52251207087727000105550020000000941757171782";
  const isPdf = (b: Uint8Array) =>
    Buffer.from(b.slice(0, 5)).toString("latin1") === "%PDF-";

  const render = (totaisOver: Record<string, any>) =>
    renderDanfeOficial({
      nfe: makeDraft({
        numero: 94,
        serie: 2,
        valorFrete: 33.45,
        totaisJson: {
          totalProdutos: 100,
          totalDesconto: 0,
          totalBcIcms: 0,
          totalIcms: 0,
          totalBcIpi: 0,
          totalIpi: 0,
          totalPis: 0,
          totalCofins: 0,
          totalNota: 133.45,
          totalTributos: 0,
          ...totaisOver,
        },
      } as any),
      config: makeConfig(),
      chaveAcesso: CHAVE,
      protocolo: "152259765009974",
      dataAutorizacao: new Date("2025-12-16T16:17:33-03:00"),
    });

  it("renderiza com totalFrete preenchido", async () => {
    expect(isPdf(await render({ totalFrete: 33.45 }))).toBe(true);
  });

  it("renderiza com totaisJson legado, sem a chave totalFrete", async () => {
    expect(isPdf(await render({}))).toBe(true);
  });
});

// Achado de auditoria: a guarda de modelo existia so no builder SEFAZ. NFC-e
// nao tem frete (o proprio builder forca modFrete 9), entao nenhum dos quatro
// pontos pode deixar o frete entrar numa 65.
describe("NfeXmlBuilderService (Focus) — NFC-e nao ganha frete", () => {
  const builder = new NfeXmlBuilderService();

  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("modelo 65 ignora valorFrete mesmo com a flag ligada", () => {
    ligar();
    const payload: any = builder.build(
      makeDraft({ modelo: "65", valorFrete: 99, modalidadeFrete: "CIF" }),
      makeConfig(),
      1,
    );
    expect("valor_frete" in payload).toBe(false);
    expect(payload.items.every((i: any) => !("valor_frete" in i))).toBe(true);
  });

  it("modelo 55 continua recebendo o frete", () => {
    ligar();
    const payload: any = builder.build(
      makeDraft({ modelo: "55", valorFrete: 99, modalidadeFrete: "CIF" }),
      makeConfig(),
      1,
    );
    expect(payload.valor_frete).toBe("99.00");
  });
});
