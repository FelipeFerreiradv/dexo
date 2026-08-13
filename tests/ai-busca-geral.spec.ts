import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// P3.3 — a busca geral, para quando o lojista NÃO sabe o que o código é.
//
// ⭐⭐ A AFIRMAÇÃO QUE ESTE SPEC EXISTE PARA PROVAR: silêncio nunca vira
// afirmação.
//
// Três coisas diferentes fazem uma área ficar de fora — falta de permissão,
// exclusão por custo e consulta que estourou — e nenhuma delas pode chegar ao
// lojista como "esse código não existe no sistema". Se acontecer, ele fecha a
// tela e vai procurar o papel; se aparecer como "não verifiquei em Clientes",
// ele pergunta para quem tem acesso. É a diferença entre uma busca e uma mentira.
// ===========================================================================

const listProductsMock = vi.fn();
const getOrdersMock = vi.fn();
const searchCustomersMock = vi.fn();
const listScrapsMock = vi.fn();

vi.mock("../app/usecases/product.usercase", () => ({
  ProductUseCase: class {
    listProducts = (...a: any[]) => listProductsMock(...a);
  },
}));
vi.mock("../app/marketplaces/usecases/order.usercase", () => ({
  OrderUseCase: { getOrders: (...a: any[]) => getOrdersMock(...a) },
}));
vi.mock("../app/usecases/customer.usecase", () => ({
  CustomerUseCase: class {
    // ⭐ `searchLean`, e o nome importa: a auditoria de egress de 13/08/2026
    // trocou o `search` (42 colunas do `Customer`, com CPF, RG e endereço) por
    // uma busca de cinco colunas. O `search` cheio continua existindo para o
    // combobox de cliente e para `buscar_cliente`, que mostra o documento
    // mascarado — este mock existir sozinho prova que a busca geral não o usa.
    searchLean = (...a: any[]) => searchCustomersMock(...a);
    search = () => {
      throw new Error(
        "busca_geral não pode usar `search`: ele traz o Customer inteiro, com CPF e endereço",
      );
    };
  },
}));
vi.mock("../app/usecases/scrap.usercase", () => ({
  ScrapUseCase: class {
    listScraps = (...a: any[]) => listScrapsMock(...a);
  },
}));

import { buscaGeral } from "../app/ai/tools/read/busca-geral";

const escopo = (paginas: string[] | "todas") =>
  ({
    dataOwnerId: "t1",
    actorId: "u1",
    isAdmin: true,
    can: (p: string) => paginas === "todas" || paginas.includes(p),
    canAction: () => true,
  }) as any;

const TODAS = "todas" as const;

const chamar = (termo: string, paginas: string[] | "todas" = TODAS) =>
  buscaGeral.handler({ termo } as any, escopo(paginas)) as Promise<any>;

/** O motivo pelo qual cada área ficou de fora, por nome de área. */
const motivos = (r: any): Record<string, string> =>
  Object.fromEntries(
    (r.naoProcuradoEm ?? []).map((a: any) => [a.area, a.motivo]),
  );

beforeEach(() => {
  listProductsMock.mockReset().mockResolvedValue({ products: [], total: 0 });
  getOrdersMock.mockReset().mockResolvedValue({ orders: [], total: 0 });
  searchCustomersMock.mockReset().mockResolvedValue([]);
  listScrapsMock.mockReset().mockResolvedValue({ scraps: [], total: 0 });
});

// ---------------------------------------------------------------------------

describe("⭐⭐ silêncio nunca vira afirmação", () => {
  it("sem acesso a Clientes, a área sai como NÃO PROCURADA — não como vazia", async () => {
    const r = await chamar("4520-A", ["produtos", "pedidos", "sucatas"]);

    expect(motivos(r).clientes).toMatch(/não tem acesso/i);
    // E a consulta nem sai: o dado não passa por lugar nenhum.
    expect(searchCustomersMock).not.toHaveBeenCalled();
  });

  it("⭐ área que ESTOURA vira 'não olhei', nunca 'não achei'", async () => {
    getOrdersMock.mockRejectedValue(new Error("pool esgotado"));

    const r = await chamar("4520-A");

    expect(motivos(r).pedidos).toMatch(/falhou/i);
    // E o turno continua de pé com o que as outras áreas responderam.
    expect(r.encontradoEm).toBeDefined();
  });

  it("⚠️ Localizações é sempre declarada como não consultada, com o motivo", async () => {
    const r = await chamar("A-12");

    expect(motivos(r)["localizações"]).toMatch(/buscar_localizacao/);
  });

  it("⭐ mesmo ENCONTRANDO, a lista de não-procuradas continua no resultado", async () => {
    // O erro fácil seria só avisar quando não acha nada. "Achei em peças" não
    // autoriza ninguém a concluir que não é também uma prateleira.
    listProductsMock.mockResolvedValue({
      products: [{ id: "p1", sku: "4520-A", name: "Farol" }],
      total: 1,
    });

    const r = await chamar("4520-A");

    expect(r.encontradoEm).toContain("peças");
    expect(motivos(r)["localizações"]).toBeDefined();
  });

  it("nada encontrado: a instrução PROÍBE dizer que não existe", async () => {
    const r = await chamar("zzz999");

    expect(r.encontradoEm).toEqual([]);
    expect(r.instrucao).toMatch(/NÃO diga que o código NÃO EXISTE/i);
  });

  it("algo encontrado: a instrução proíbe afirmar sobre as não consultadas", async () => {
    listProductsMock.mockResolvedValue({
      products: [{ id: "p1", sku: "4520-A" }],
      total: 1,
    });

    const r = await chamar("4520-A");

    expect(r.instrucao).toMatch(/NÃO afirme nada sobre as áreas/i);
  });
});

describe("⭐ ela procura nas quatro áreas ao mesmo tempo", () => {
  it("com acesso total, as quatro consultas saem", async () => {
    await chamar("4520-A");

    expect(listProductsMock).toHaveBeenCalled();
    expect(getOrdersMock).toHaveBeenCalled();
    expect(searchCustomersMock).toHaveBeenCalled();
    expect(listScrapsMock).toHaveBeenCalled();
  });

  it("só as áreas COM resultado entram em `encontradoEm`", async () => {
    listProductsMock.mockResolvedValue({
      products: [{ id: "p1", sku: "4520-A" }],
      total: 1,
    });
    listScrapsMock.mockResolvedValue({
      scraps: [{ id: "s1", brand: "VW", model: "Gol", plate: "ABC1D23" }],
      total: 1,
    });

    const r = await chamar("4520-A");

    expect(r.encontradoEm).toEqual(
      expect.arrayContaining(["peças", "sucatas"]),
    );
    expect(r.encontradoEm).not.toContain("pedidos");
  });

  it("⚠️ a amostra é curta — o que se quer aqui é o ONDE, não a lista", async () => {
    listProductsMock.mockResolvedValue({
      products: [{ id: "1" }, { id: "2" }, { id: "3" }],
      total: 900,
    });

    const r = await chamar("farol");
    const pecas = r.resultados.find((a: any) => a.area === "peças");

    // O total real é dito; a amostra é que fica pequena.
    expect(pecas.total).toBe(900);
    expect(pecas.itens.length).toBeLessThanOrEqual(3);
    expect(listProductsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3 }),
    );
  });
});

describe("⭐ isolamento e privacidade", () => {
  it("as quatro consultas são escopadas pelo tenant do escopo", async () => {
    await chamar("4520-A");

    expect(listProductsMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "t1" }),
    );
    expect(listScrapsMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "t1" }),
    );
    expect(getOrdersMock).toHaveBeenCalledWith("t1", expect.anything());
    expect(searchCustomersMock).toHaveBeenCalledWith("4520-A", "t1", 3);
  });

  it("⭐⭐ o documento do cliente NÃO SAI DO BANCO — não é só filtrado depois", () => {
    // A versão anterior desta tool lia o `Customer` inteiro (42 colunas: CPF,
    // RG, nascimento, endereço completo, 13 campos de entrega) e projetava três
    // deles em JavaScript. O dado não chegava ao modelo, mas trafegava do
    // Supabase até a API a cada busca. Agora a projeção é do lado do banco.
    const repo = readFileSync(
      join(__dirname, "..", "app/repositories/customer.repository.ts"),
      "utf8",
    );
    const lean = repo.slice(repo.indexOf("async searchLean"));
    const select = lean.slice(lean.indexOf("select: {"), lean.indexOf("}) as any"));

    for (const proibido of ["cpf", "cnpj", "rg", "birthDate", "address", "delivery"]) {
      expect(select, `\`${proibido}\` na projeção da busca geral`).not.toContain(
        proibido,
      );
    }
    expect(select).toContain("city: true");
  });

  it("⚠️ NÃO devolve documento do cliente, nem mascarado", async () => {
    searchCustomersMock.mockResolvedValue([
      {
        id: "c1",
        name: "João",
        city: "Curitiba",
        document: "12345678909",
        email: "joao@x.com",
        phone: "41999998888",
      },
    ]);

    const r = await chamar("João");
    const cru = JSON.stringify(r);

    expect(cru).not.toContain("12345678909");
    expect(cru).not.toContain("•••");
    expect(cru).not.toContain("joao@x.com");
    expect(cru).not.toContain("41999998888");
  });
});

describe("⭐ a tool não escreve e não inventa busca", () => {
  it("termo vazio pede o termo em vez de varrer a base", async () => {
    const r = (await buscaGeral.handler({} as any, escopo(TODAS))) as any;

    expect(r.precisoDeUmTermo).toBe(true);
    expect(listProductsMock).not.toHaveBeenCalled();
    expect(getOrdersMock).not.toHaveBeenCalled();
  });

  it("é declarada como leitura", () => {
    expect(buscaGeral.kind).toBe("read");
    expect((buscaGeral as any).action).toBeUndefined();
  });
});
