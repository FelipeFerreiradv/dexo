import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/lib/prisma", () => ({ default: {} }));

const criarProdutoMock = vi.fn();
const atualizarProdutoMock = vi.fn();
const vincularSucataMock = vi.fn();
vi.mock("../app/usecases/product.usercase", () => ({
  ProductUseCase: class {
    create = (...a: any[]) => criarProdutoMock(...a);
    update = (...a: any[]) => atualizarProdutoMock(...a);
    linkScrap = (...a: any[]) => vincularSucataMock(...a);
  },
}));

const criarSucataMock = vi.fn();
vi.mock("../app/usecases/scrap.usercase", () => ({
  ScrapUseCase: class {
    create = (...a: any[]) => criarSucataMock(...a);
  },
}));

const criarClienteMock = vi.fn();
vi.mock("../app/usecases/customer.usecase", () => ({
  CustomerUseCase: class {
    create = (...a: any[]) => criarClienteMock(...a);
  },
}));

import {
  executarAcao,
  TIPOS_EXECUTAVEIS,
} from "../app/ai/acoes/executores";

// ===========================================================================
// Os EXECUTORES — quem de fato escreve, depois do clique.
//
// ⚠️ ESTE SPEC EXISTE PORQUE A REVISÃO ADVERSARIAL APONTOU A LACUNA: em todos
// os outros specs da fase o `executarAcao` está mockado, então o código que
// realmente toca o banco de negócio nunca era exercido. Aqui os usecases é que
// são dublês, e o executor roda de verdade.
//
// O que ele protege:
//   1. ⭐ o tenant vem do ESCOPO, nunca do payload;
//   2. ⭐ o lote é MELHOR-ESFORÇO: uma linha ruim não invalida as boas;
//   3. `createdByUserId` é o ATOR — senão "Criado por" fica "—";
//   4. tipo desconhecido é falha DURA, nunca silêncio.
// ===========================================================================

const escopo = () =>
  ({
    dataOwnerId: "tenant-1",
    actorId: "ator-9",
    can: () => true,
    canAction: () => true,
  }) as any;

beforeEach(() => {
  criarProdutoMock.mockReset().mockImplementation(async (d: any) => ({
    id: `p-${d.name}`,
  }));
  atualizarProdutoMock.mockReset().mockResolvedValue({});
  criarClienteMock.mockReset().mockResolvedValue({ id: "c1" });
});

describe("⭐ o tenant sai do ESCOPO, nunca do payload", () => {
  it("criar produto: o payload não consegue trocar de loja", async () => {
    await executarAcao(
      "produto.criar",
      { produto: { name: "Farol", userId: "OUTRO_TENANT" } },
      escopo(),
    );

    const enviado = criarProdutoMock.mock.calls[0][0];
    expect(enviado.userId).toBe("tenant-1");
    expect(enviado.createdByUserId).toBe("ator-9");
    expect(enviado.autoSku).toBe(true);
  });

  it("alterar preço: o `userId` da chamada é o tenant do escopo", async () => {
    await executarAcao(
      "produto.preco",
      { produtoId: "p1", preco: 240 },
      escopo(),
    );

    expect(atualizarProdutoMock).toHaveBeenCalledWith(
      "p1",
      { price: 240 },
      "tenant-1",
    );
  });

  it("ajustar estoque manda `stock`, e só ele", async () => {
    await executarAcao(
      "produto.estoque",
      { produtoId: "p1", estoque: 7, estoqueAnterior: 3 },
      escopo(),
    );

    expect(atualizarProdutoMock.mock.calls[0][1]).toEqual({ stock: 7 });
  });

  it("criar cliente idem", async () => {
    await executarAcao(
      "cliente.criar",
      { cliente: { name: "Oficina", userId: "OUTRO" } },
      escopo(),
    );
    expect(criarClienteMock.mock.calls[0][0].userId).toBe("tenant-1");
  });
});

describe("⭐⭐ o LOTE é melhor-esforço, com relatório", () => {
  const lote = (n: number) => ({
    itens: Array.from({ length: n }, (_, i) => ({
      name: `Peca ${i}`,
      price: 10,
      stock: 1,
    })),
  });

  it("caminho feliz: cria todas e relata", async () => {
    const r = await executarAcao("produto.criar-lote", lote(3), escopo());

    expect(criarProdutoMock).toHaveBeenCalledTimes(3);
    expect(r.relatorio).toEqual({ criadas: 3, total: 3, falhas: [] });
    // O id da PRIMEIRA — não existe "o id do lote".
    expect(r.resultId).toBe("p-Peca 0");
  });

  it("⭐⭐ uma linha ruim NÃO invalida as boas", async () => {
    // Decisão do dono: 28 peças boas não podem ser descartadas por causa de 2.
    criarProdutoMock.mockImplementation(async (d: any) => {
      if (d.name === "Peca 1") throw new Error("Produto com esse sku já existe");
      return { id: `p-${d.name}` };
    });

    const r = await executarAcao("produto.criar-lote", lote(3), escopo());

    expect(criarProdutoMock).toHaveBeenCalledTimes(3);
    expect(r.relatorio?.criadas).toBe(2);
    expect(r.relatorio?.total).toBe(3);
    expect(r.relatorio?.falhas).toEqual([
      { nome: "Peca 1", motivo: "Produto com esse sku já existe" },
    ]);
  });

  it("⭐ o lote NÃO para na primeira falha", async () => {
    // Parar deixaria as peças 2..30 fora sem ninguém dizer por quê.
    criarProdutoMock.mockRejectedValue(new Error("tudo falhou"));

    const r = await executarAcao("produto.criar-lote", lote(4), escopo());

    expect(criarProdutoMock).toHaveBeenCalledTimes(4);
    expect(r.relatorio?.criadas).toBe(0);
    expect(r.relatorio?.falhas).toHaveLength(4);
    expect(r.resultId).toBeNull();
  });

  it("⭐ SEQUENCIAL: uma reserva de SKU por vez", async () => {
    // `createWithAutoSku` reserva o SKU com um UPDATE atômico na linha do User.
    // Trinta reservas em paralelo disputariam a MESMA linha, e o ganho de tempo
    // viraria contenção de lock.
    const ordem: string[] = [];
    criarProdutoMock.mockImplementation(async (d: any) => {
      ordem.push(`inicio:${d.name}`);
      await new Promise((r) => setTimeout(r, 1));
      ordem.push(`fim:${d.name}`);
      return { id: `p-${d.name}` };
    });

    await executarAcao("produto.criar-lote", lote(3), escopo());

    expect(ordem).toEqual([
      "inicio:Peca 0",
      "fim:Peca 0",
      "inicio:Peca 1",
      "fim:Peca 1",
      "inicio:Peca 2",
      "fim:Peca 2",
    ]);
  });

  it("⭐⭐ cada peça leva TODOS os campos de negócio, não só o nome", async () => {
    // ⚠️ Conserto de um achado: trocar o `...item` por `name: item.name`
    // sobrevivia à suíte, e em produção criaria 25 registros só com nome —
    // preço zerado (com o precedente do "price=0 fantasma" neste repo) e
    // estoque nulo.
    await executarAcao(
      "produto.criar-lote",
      {
        itens: [
          {
            name: "Farol",
            price: 320,
            stock: 1,
            brand: "VW",
            model: "Gol",
            year: "2012",
            category: "Iluminação",
            partNumber: "5U0945095",
          },
        ],
      },
      escopo(),
    );

    expect(criarProdutoMock.mock.calls[0][0]).toEqual({
      name: "Farol",
      price: 320,
      stock: 1,
      brand: "VW",
      model: "Gol",
      year: "2012",
      category: "Iluminação",
      partNumber: "5U0945095",
      // E o que o SERVIDOR acrescenta, que o payload nunca carrega.
      userId: "tenant-1",
      createdByUserId: "ator-9",
      autoSku: true,
    });
  });

  it("⭐⭐ o motivo NÃO leva dump de ORM para o cartão", async () => {
    // ⚠️ Conserto de um achado: o texto cru ia para a tela do lojista e para o
    // corpo HTTP — "Invalid `prisma.product.create()` invocation: { data: {
    // name:" —, carregando nome de coluna e pedaço do dado. E o teste antigo,
    // que se chamava "sem SQL", só media o TAMANHO: um dump de 100 caracteres
    // passava inteiro.
    criarProdutoMock.mockRejectedValue(
      new Error(
        "Invalid `prisma.product.create()` invocation: { data: { name: 'Farol', price: 320 } }",
      ),
    );

    const r = await executarAcao("produto.criar-lote", lote(1), escopo());
    const motivo = r.relatorio!.falhas[0].motivo;

    expect(motivo).not.toMatch(/prisma|invocation|data:|price/i);
    expect(motivo.length).toBeLessThanOrEqual(120);
    expect(motivo.length).toBeGreaterThan(5);
  });

  it("código de erro do Prisma (P2002) também não vaza", async () => {
    criarProdutoMock.mockRejectedValue(
      new Error("P2002: Unique constraint failed on the fields"),
    );
    const r = await executarAcao("produto.criar-lote", lote(1), escopo());
    expect(r.relatorio!.falhas[0].motivo).not.toMatch(/P2002|constraint/i);
  });

  it("⭐ mas a mensagem HUMANA do usecase da casa PASSA", async () => {
    // "Produto com esse sku já existe" é escrita para gente e é exatamente o
    // que o lojista precisa ler para corrigir aquela linha.
    criarProdutoMock.mockRejectedValue(
      new Error("Produto com esse sku já existe"),
    );
    const r = await executarAcao("produto.criar-lote", lote(1), escopo());
    expect(r.relatorio!.falhas[0].motivo).toBe("Produto com esse sku já existe");
  });

  it("lote vazio não estoura", async () => {
    const r = await executarAcao("produto.criar-lote", { itens: [] }, escopo());
    expect(r.relatorio).toEqual({ criadas: 0, total: 0, falhas: [] });
    expect(criarProdutoMock).not.toHaveBeenCalled();
  });
});

describe("contrato", () => {
  it("⭐ tipo desconhecido é falha DURA, nunca silêncio", async () => {
    // Rollback de versão pode deixar no banco uma `action` que este deploy não
    // conhece. "Confirmada" sem ter feito nada seria a pior saída.
    await expect(
      executarAcao("produto.explodir" as any, {}, escopo()),
    ).rejects.toThrow(/desconhecida/i);
  });

  it("⭐ sucata: o tenant vem do escopo e o AUTOR é o ator", async () => {
    criarSucataMock.mockResolvedValue({ id: "s-1" });
    await executarAcao(
      "sucata.criar",
      { sucata: { brand: "VW", model: "Gol" } },
      escopo(),
    );

    const arg = criarSucataMock.mock.calls[0][0];
    expect(arg.userId).toBe("tenant-1");
    // ⚠️ Sem isto a tela de Sucatas mostraria o dono da conta como autor de
    // tudo que o balconista ditar ao Bitz.
    expect(arg.createdByUserId).toBe("ator-9");
  });

  it("⭐ vínculo com sucata usa linkScrap — NÃO update (que dispararia sync)", async () => {
    vincularSucataMock.mockResolvedValue({ id: "p-1" });
    const r = await executarAcao(
      "produto.vincular-sucata",
      { produtoId: "p-1", sucataId: "s-9" },
      escopo(),
    );

    expect(vincularSucataMock).toHaveBeenCalledWith("p-1", "s-9", "tenant-1");
    // O caminho de update é o que limpa override, grava stock log e sincroniza
    // marketplace. Nada disso deve acontecer por trocar a origem da peça.
    expect(atualizarProdutoMock).not.toHaveBeenCalled();
    expect(r.resultId).toBe("p-1");
  });

  it("os tipos executáveis são exatamente os nove declarados", () => {
    expect([...TIPOS_EXECUTAVEIS].sort()).toEqual([
      // A única que toca o CANAL e não o catálogo. A OLX fica de fora do
      // pausar, e a exclusão vem do payload.
      "anuncio.situacao",
      "cliente.criar",
      // Fase 11 — a única que não escreve em tabela de negócio. O executor dela
      // é exercido em `ai-memoria.spec.ts`, com a memória mockada.
      "memoria.criar",
      "produto.criar",
      "produto.criar-lote",
      "produto.estoque",
      "produto.preco",
      // Vincular a peça ao lote. NÃO passa por `update()`, então não dispara
      // sync de marketplace nem stock log.
      "produto.vincular-sucata",
      // Dar entrada num lote de sucata. Sem efeito colateral: o insert não gera
      // peça, não mexe em estoque e não lança nada no financeiro.
      "sucata.criar",
    ]);
  });
});
