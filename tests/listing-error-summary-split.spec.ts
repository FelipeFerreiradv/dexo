import { describe, it, expect } from "vitest";
import {
  formatListingError,
  splitListingErrorSummary,
} from "../app/produtos/lib/listing-error-format";
import { summarizeValueBlocks } from "../app/marketplaces/lib/ml-attribute-value-validation.logic";

/**
 * Card do anúncio (23/09/2026): a mensagem com vários campos a corrigir vinha
 * num parágrafo corrido e, espremida pelos botões, ficava ilegível. Agora
 * vira cabeçalho + um item por campo. Os textos abaixo são os GRAVADOS em
 * produção (recuperação dos anúncios), não montados à mão.
 */
const DOIS =
  '[TERMINAL][CORRIGIVEL] A ficha técnica tem 2 valores a corrigir: O campo "Largura" precisa de número com unidade (ex.: "10 cm") e está com "45". Informe a unidade na ficha técnica ou apague o valor. O campo "Comprimento" precisa de número com unidade (ex.: "10 cm") e está com "50". Informe a unidade na ficha técnica ou apague o valor.';
const TRES_MISTO =
  '[TERMINAL][CORRIGIVEL] A ficha técnica tem 3 valores a corrigir: O campo Código universal de produto aceita só código de barras (EAN/UPC, com 8, 12, 13 ou 14 dígitos) e está com "1". Apague o valor ou informe o código de barras. O campo "Ângulo máximo de abertura" precisa de número com unidade (ex.: "10 °") e está com "2". Informe a unidade na ficha técnica ou apague o valor. O campo "Código QR de Informações Regulatórias" da ficha técnica é do tipo imagem e está com o texto "1". Apague o valor.';

const partes = (lastError: string) =>
  splitListingErrorSummary(formatListingError(lastError, "MERCADO_LIVRE")!.summary);

describe("splitListingErrorSummary", () => {
  it("2 campos gravados em produção ⇒ cabeçalho + 2 itens, cada um inteiro", () => {
    const p = partes(DOIS);
    expect(p.lead).toBe("A ficha técnica tem 2 valores a corrigir:");
    expect(p.items).toEqual([
      'O campo "Largura" precisa de número com unidade (ex.: "10 cm") e está com "45". Informe a unidade na ficha técnica ou apague o valor.',
      'O campo "Comprimento" precisa de número com unidade (ex.: "10 cm") e está com "50". Informe a unidade na ficha técnica ou apague o valor.',
    ]);
    expect(p.tail).toBeNull();
  });

  it("campos de tipos diferentes (código de barras sem aspas, unidade, imagem) ⇒ 3 itens", () => {
    const p = partes(TRES_MISTO);
    expect(p.items).toHaveLength(3);
    expect(p.items[0]).toMatch(/^O campo Código universal de produto/);
    expect(p.items[1]).toMatch(/^O campo "Ângulo máximo de abertura"/);
    expect(p.items[2]).toMatch(/^O campo "Código QR/);
  });

  it("mensagem montada na publicação (com fecho) ⇒ itens + fecho separado", () => {
    const texto = summarizeValueBlocks([
      { attributeId: "A", attributeName: "Largura", severity: "block", code: "X", message: 'O campo "Largura" precisa de número com unidade (ex.: "10 cm") e está com "1". Informe a unidade na ficha técnica ou apague o valor.', value: "1" },
      { attributeId: "B", attributeName: "Lado", severity: "block", code: "Y", message: 'O valor "Esquerda" do campo "Lado" não existe nesta categoria do Mercado Livre (opções: Direito, Esquerdo). Escolha uma das opções na ficha técnica.', value: "Esquerda" },
    ] as never)!;
    const p = splitListingErrorSummary(texto);
    expect(p.lead).toMatch(/^A ficha técnica tem 2 valores que o Mercado Livre não aceita:$/);
    expect(p.items).toHaveLength(2);
    expect(p.items[1]).toMatch(/^O valor "Esquerda"/);
    expect(p.tail).toBe("Depois de corrigir, a publicação é retomada.");
  });

  it("mensagens de obrigatório (lado, posição, valor informado, preenchimento) também viram itens", () => {
    const t =
      "A ficha técnica tem 4 valores a corrigir: " +
      "Esta categoria exige o lado da peça. Selecione Direito ou Esquerdo antes de publicar o anúncio. " +
      "O lado da peça informado não é aceito por esta categoria. Selecione Direito ou Esquerdo antes de publicar o anúncio. " +
      'O valor informado em "Posição" não é aceito por esta categoria do Mercado Livre. Escolha uma das opções da lista antes de continuar. ' +
      "Esta categoria do Mercado Livre exige o preenchimento do Part Number. Preencha esse campo antes de continuar.";
    const p = splitListingErrorSummary(t);
    expect(p.items).toHaveLength(4);
    expect(p.items[0]).toMatch(/^Esta categoria exige o lado/);
    expect(p.items[1]).toMatch(/^O lado da peça informado.*antes de publicar o anúncio\.$/);
    expect(p.items[2]).toMatch(/^O valor informado em "Posição"/);
    expect(p.items[3]).toMatch(/^Esta categoria do Mercado Livre exige o preenchimento do Part Number/);
  });

  it("mensagem de um campo só, ou qualquer outro texto, volta inteira (sem lista)", () => {
    for (const t of [
      'O campo "Altura" precisa de número com unidade (ex.: "10 cm") e está com "1". Informe a unidade na ficha técnica ou apague o valor.',
      "Esta categoria do Mercado Livre exige o preenchimento do Part Number. Preencha esse campo antes de continuar.",
      "Produto sem estoque (stock=0) — corrija no cadastro e recrie o anúncio.",
      "",
    ]) {
      expect(splitListingErrorSummary(t)).toEqual({ lead: t, items: [], tail: null });
    }
  });

  it("cabeçalho de lista mas um item só (texto inesperado) ⇒ volta inteira", () => {
    const t = "A ficha técnica tem 2 valores a corrigir: texto sem o começo conhecido.";
    expect(splitListingErrorSummary(t)).toEqual({ lead: t, items: [], tail: null });
  });
});
