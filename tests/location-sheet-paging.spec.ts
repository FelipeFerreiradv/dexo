import { describe, it, expect } from "vitest";
import {
  appendUniqueById,
  describeLoadMore,
  describeSelectAll,
  describeSheetCount,
  hasMoreProducts,
  nextPage,
  shouldSuggestSearch,
} from "../app/localizacoes/lib/sheet-products-paging";

/**
 * Chamado MK2 Autopeças, 09/2026.
 *
 * A gaveta "Produtos em <caixa>" pedia `limit=50` e NUNCA mandava `page`,
 * enquanto o cabeçalho mostrava o total verdadeiro. Medido em produção em
 * 15/09/2026: a MK2 tinha 160 caixas com mais de 50 peças e **11.518 peças
 * inalcançáveis pela tela** (39,3% das 29.336 endereçadas). A `1P2CX102`, a
 * caixa do vídeo do cliente, tem 168 peças — 118 invisíveis.
 *
 * ⚠️ E o "Selecionar todos" marcava só as 50 carregadas, sob esse rótulo.
 * Corrigir a paginação sem corrigir o rótulo trocaria um bug visível por um
 * destrutivo: quem lê "168 vinculados", marca tudo e manda mover, move 50.
 */

describe("appendUniqueById — concatenar páginas sem duplicar", () => {
  it("acrescenta os novos preservando a ordem de chegada", () => {
    const r = appendUniqueById(
      [{ id: "a" }, { id: "b" }],
      [{ id: "c" }, { id: "d" }],
    );
    expect(r.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("ignora itens repetidos entre páginas", () => {
    // `orderBy: name asc` sem desempate deixava a ordem indefinida dentro de um
    // grupo de nomes iguais — e num desmonte nome repetido com SKU diferente é
    // o caso normal. A mesma peça podia vir na página 1 e na 2.
    const r = appendUniqueById(
      [{ id: "a" }, { id: "b" }],
      [{ id: "b" }, { id: "c" }],
    );
    expect(r.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("não reordena o que já está na tela", () => {
    const atual = [{ id: "z" }, { id: "a" }];
    const r = appendUniqueById(atual, [{ id: "m" }]);
    expect(r.map((x) => x.id)).toEqual(["z", "a", "m"]);
  });

  it("não perde nada quando a página nova vem vazia", () => {
    expect(appendUniqueById([{ id: "a" }], [])).toHaveLength(1);
  });
});

describe("describeSelectAll — o rótulo tem de dizer o que a ação faz", () => {
  it("deixa explícito que só os carregados serão selecionados", () => {
    const r = describeSelectAll(50, 168);
    expect(r.label).toContain("50");
    expect(r.label).toMatch(/carregad/i);
    expect(r.hint).toContain("168");
  });

  // Controle negativo: quem tem 12 peças na caixa não pode ser alarmado.
  it('volta a ser "Selecionar todos" quando tudo já está carregado', () => {
    const r = describeSelectAll(12, 12);
    expect(r.label).toBe("Selecionar todos");
    expect(r.hint).toBeNull();
  });

  it("trata caixa vazia sem inventar aviso", () => {
    expect(describeSelectAll(0, 0).label).toBe("Selecionar todos");
  });
});

describe("describeSheetCount / describeLoadMore / hasMoreProducts", () => {
  it("informa quantos faltam no botão Carregar mais", () => {
    expect(describeLoadMore(50, 168)).toContain("118");
  });

  it("mostra a contagem parcial quando há peça escondida", () => {
    expect(describeSheetCount(50, 168)).toBe("Mostrando 50 de 168");
  });

  // Controle negativo: nada disso aparece quando não há o que esconder.
  it("não oferece Carregar mais quando o total já está na tela", () => {
    expect(describeLoadMore(168, 168)).toBeNull();
    expect(describeSheetCount(168, 168)).toBeNull();
    expect(hasMoreProducts(168, 168)).toBe(false);
  });

  it("não oferece Carregar mais com a lista vazia", () => {
    expect(hasMoreProducts(0, 0)).toBe(false);
    expect(hasMoreProducts(0, 30)).toBe(false);
  });
});

describe("shouldSuggestSearch — caixa grande demais para carregar aos poucos", () => {
  it("sugere a busca quando a caixa é enorme", () => {
    // A `P1-ACABAMENTODIVERSOS` da MK2 tem 4.067 peças: 81 cliques.
    expect(shouldSuggestSearch(50, 4067)).toBe(true);
  });

  it("não sugere em caixa de tamanho comum", () => {
    expect(shouldSuggestSearch(50, 168)).toBe(false);
  });

  it("não sugere quando já está tudo carregado", () => {
    expect(shouldSuggestSearch(4067, 4067)).toBe(false);
  });
});

describe("nextPage — deriva da PÁGINA, nunca da quantidade carregada", () => {
  it("pede a página 2 depois da página 1", () => {
    expect(nextPage(1)).toBe(2);
  });

  it("pede a página 4 depois da página 3", () => {
    expect(nextPage(3)).toBe(4);
  });

  /**
   * O defeito que esta assinatura elimina: derivando de
   * `sheetProducts.length`, um `appendUniqueById` que descartasse 1 repetido
   * deixaria 99 itens carregados e `floor(99/50)+1 = 2` — a página 2, que já
   * tinha sido buscada. A requisição sairia, voltaria com 50 itens já
   * conhecidos, acrescentaria zero, e o botão ficaria travado nela.
   */
  it("não regride para uma página já buscada quando houve deduplicação", () => {
    // 99 itens carregados (1 duplicata descartada) mas 2 páginas buscadas.
    const paginasBuscadas = 2;
    expect(nextPage(paginasBuscadas)).toBe(3);
    expect(nextPage(paginasBuscadas)).not.toBe(2);
  });

  it("nunca pede página menor que 2 como próxima", () => {
    expect(nextPage(0)).toBe(2);
    expect(nextPage(1)).toBe(2);
  });
});
