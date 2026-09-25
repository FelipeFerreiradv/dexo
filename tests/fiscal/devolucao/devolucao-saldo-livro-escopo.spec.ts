/**
 * Módulos puros do saldo usados pelo caso de uso (G2):
 * - `quantidadeOriginalDoLivro`/`itensOriginaisComLivro` (K6): a devolução pela chave,
 *   sem a quantidade da nota, usa a que uma devolução montada do XML já gravou.
 * - `escopoDaDevolucao` (N-saldo-ledger-1): o escopo é derivado, nunca pedido.
 * - `issueSaldoExcedido` (N-saldo-ledger-3): a recusa de saldo diz o item e o número.
 */
import { describe, expect, it } from "vitest";
import {
  escopoDaDevolucao, issueSaldoExcedido, itensOriginaisComLivro, quantidadeOriginalDoLivro, type LinhaSaldoDevolucao,
} from "../../../app/fiscal/devolucao/saldo";
import { CHAVE_DISAUTO } from "./devolucao-caso-de-uso-fixtures";

/** Outra chave: a mesma com o último dígito trocado. */
const OUTRA_CHAVE = CHAVE_DISAUTO.slice(0, 43) + (CHAVE_DISAUTO.endsWith("9") ? "8" : "9");

const l = (over: Partial<LinhaSaldoDevolucao>): LinhaSaldoDevolucao => ({
  chave: CHAVE_DISAUTO, nItem: 6, quantidade: "1", statusDevolucao: "AUTHORIZED", devolucaoNfeId: "d1", ...over,
});

describe("quantidadeOriginalDoLivro", () => {
  it("usa só devolução montada do XML (DEXO/XML_IMPORTADO), nunca número digitado à mão (MANUAL)", () => {
    expect(quantidadeOriginalDoLivro([l({ fonteDevolucao: "XML_IMPORTADO", quantidadeOriginal: "3.0000" })], CHAVE_DISAUTO, 6)).toBe(3);
    expect(quantidadeOriginalDoLivro([l({ fonteDevolucao: "DEXO", quantidadeOriginal: 2 })], CHAVE_DISAUTO, 6)).toBe(2);
    expect(quantidadeOriginalDoLivro([l({ fonteDevolucao: "MANUAL", quantidadeOriginal: "5" })], CHAVE_DISAUTO, 6)).toBeNull();
    expect(quantidadeOriginalDoLivro([l({ quantidadeOriginal: "5" })], CHAVE_DISAUTO, 6)).toBeNull();
  });

  it("só do mesmo item e da mesma chave (aceita o prefixo 'NFe' da Focus); vale a maior; nula/zero não conta", () => {
    const linhas = [
      l({ fonteDevolucao: "XML_IMPORTADO", quantidadeOriginal: "1", nItem: 5 }),
      l({ fonteDevolucao: "XML_IMPORTADO", quantidadeOriginal: "4", chave: "NFe" + CHAVE_DISAUTO }),
      l({ fonteDevolucao: "XML_IMPORTADO", quantidadeOriginal: "2" }),
      l({ fonteDevolucao: "XML_IMPORTADO", quantidadeOriginal: null }),
      l({ fonteDevolucao: "XML_IMPORTADO", quantidadeOriginal: "0" }),
      l({ fonteDevolucao: "XML_IMPORTADO", quantidadeOriginal: "9", chave: OUTRA_CHAVE }),
    ];
    expect(quantidadeOriginalDoLivro(linhas, CHAVE_DISAUTO, 6)).toBe(4);
    expect(quantidadeOriginalDoLivro(linhas, CHAVE_DISAUTO, 5)).toBe(1);
    expect(quantidadeOriginalDoLivro(linhas, CHAVE_DISAUTO, 7)).toBeNull();
  });

  it("itensOriginaisComLivro: a quantidade do snapshot vale; desconhecida (0/null) vem do livro", () => {
    const linhas = [l({ fonteDevolucao: "XML_IMPORTADO", quantidadeOriginal: "1" })];
    expect(itensOriginaisComLivro([{ nItem: 6, quantidade: 0 }, { nItem: 5, quantidade: 2 }, { nItem: 4, quantidade: null }], linhas, CHAVE_DISAUTO))
      .toEqual([{ nItem: 6, quantidade: 1 }, { nItem: 5, quantidade: 2 }, { nItem: 4, quantidade: null }]);
  });
});

const s = (nItem: number, quantidadeOriginal: number | null, disponivel: number | null, extra: Record<string, number> = {}) => ({
  nItem, quantidadeOriginal, disponivel, devolvidaAutorizada: 0, emProcessamento: 0, emRascunho: 0, ...extra,
});

describe("escopoDaDevolucao: TOTAL só quando a nota volta INTEIRA nesta devolução", () => {
  it("todos os itens com a quantidade cheia e nada devolvido antes: TOTAL (4 casas: 1 = '1.0000')", () => {
    expect(escopoDaDevolucao({ saldos: [s(5, 1, 1), s(6, 3, 3)], itens: [{ nItem: 5, quantidade: "1.0000" }, { nItem: 6, quantidade: 3 }] })).toBe("TOTAL");
  });
  it("faltou um item, ou veio com menos: PARCIAL", () => {
    expect(escopoDaDevolucao({ saldos: [s(5, 1, 1), s(6, 3, 3)], itens: [{ nItem: 6, quantidade: 3 }] })).toBe("PARCIAL");
    expect(escopoDaDevolucao({ saldos: [s(5, 1, 1), s(6, 3, 3)], itens: [{ nItem: 5, quantidade: 1 }, { nItem: 6, quantidade: 2 }] })).toBe("PARCIAL");
  });
  it("outra devolução já levou parte (autorizada ou em envio): devolver o resto é PARCIAL", () => {
    expect(escopoDaDevolucao({ saldos: [s(6, 3, 2, { devolvidaAutorizada: 1 })], itens: [{ nItem: 6, quantidade: 2 }] })).toBe("PARCIAL");
  });
  it("outra devolução autorizada DEPOIS que ela salvou a lista cheia: não é mais total (PUT do cabeçalho relê o saldo)", () => {
    expect(escopoDaDevolucao({ saldos: [s(6, 1, 0, { devolvidaAutorizada: 1 })], itens: [{ nItem: 6, quantidade: 1 }] })).toBe("PARCIAL");
  });
  it("quantidade original desconhecida (pela chave) ou lista vazia: PARCIAL — não dá para provar que é total", () => {
    expect(escopoDaDevolucao({ saldos: [s(6, null, null)], itens: [{ nItem: 6, quantidade: 1 }] })).toBe("PARCIAL");
    expect(escopoDaDevolucao({ saldos: [], itens: [] })).toBe("PARCIAL");
  });
  it("com chave nos dois lados, casa pela chave também", () => {
    expect(escopoDaDevolucao({ saldos: [{ ...s(6, 1, 1), chaveAcesso: CHAVE_DISAUTO }], itens: [{ chaveAcesso: OUTRA_CHAVE, nItem: 6, quantidade: 1 }] })).toBe("PARCIAL");
    expect(escopoDaDevolucao({ saldos: [{ ...s(6, 1, 1), chaveAcesso: CHAVE_DISAUTO }], itens: [{ chaveAcesso: CHAVE_DISAUTO, nItem: 6, quantidade: 1 }] })).toBe("TOTAL");
  });
});

describe("issueSaldoExcedido: a recusa diz a peça, o pedido, o que resta e onde está o resto", () => {
  it("sem saldo nenhum: manda tirar o item", () => {
    expect(issueSaldoExcedido({ ordem: 2, nItemOriginal: 6, codigo: "24171-7", pedida: 1, saldo: { disponivel: 0, devolvidaAutorizada: 1, emProcessamento: 0 } })).toEqual({
      code: "SALDO_EXCEDIDO", severidade: "ERRO", ordem: 2,
      mensagem: "Item 2: 24171-7 (item 6 da nota original): este item não tem mais saldo para devolver (1 já devolvido em NF-e autorizada). Tire o item desta devolução.",
    });
  });
  it("com saldo menor que o pedido: diz os dois números e o que está em envio (vírgula decimal)", () => {
    expect(issueSaldoExcedido({ ordem: 1, nItemOriginal: 1, codigo: "OLEO", pedida: 2.5, saldo: { disponivel: 1.5, devolvidaAutorizada: 0, emProcessamento: 1.5 } }).mensagem)
      .toBe("Item 1: OLEO (item 1 da nota original): a quantidade 2,5 passa do que ainda pode ser devolvido, que é 1,5 (1,5 numa devolução em envio à SEFAZ).");
  });
  it("saldo desconhecido: compara com a quantidade da nota original", () => {
    expect(issueSaldoExcedido({ ordem: 1, nItemOriginal: 3, codigo: "X", pedida: 4, saldo: null, quantidadeOriginal: 3 }).mensagem)
      .toBe("Item 1: X (item 3 da nota original): a quantidade 4 passa da quantidade da nota original, que é 3.");
  });
});
