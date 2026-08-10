import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/lib/prisma", () => ({
  default: { systemLog: { create: async () => ({}) } },
}));

// Os usecases de negócio: espionados para PROVAR que nenhuma tool os chama.
const criarProdutoMock = vi.fn();
const atualizarProdutoMock = vi.fn();
const listarProdutosMock = vi.fn();
vi.mock("../app/usecases/product.usercase", () => ({
  ProductUseCase: class {
    create = (...a: any[]) => criarProdutoMock(...a);
    update = (...a: any[]) => atualizarProdutoMock(...a);
    listProducts = (...a: any[]) => listarProdutosMock(...a);
  },
}));

const criarClienteMock = vi.fn();
const buscarClienteMock = vi.fn();
vi.mock("../app/usecases/customer.usecase", () => ({
  CustomerUseCase: class {
    create = (...a: any[]) => criarClienteMock(...a);
    search = (...a: any[]) => buscarClienteMock(...a);
  },
}));

const proporMock = vi.fn();
vi.mock("../app/ai/acoes/acao.service", async (orig) => {
  const real = (await orig()) as any;
  return { ...real, proporAcao: (...a: any[]) => proporMock(...a) };
});

import { runTool } from "../app/ai/agent/tool-runner";
import { buildRegistry } from "../app/ai/tools/registry";
import { WRITE_TOOLS } from "../app/ai/tools/write";

// ===========================================================================
// As tools de ESCRITA. Fase 9.
//
// ⭐ A AFIRMAÇÃO QUE ESTE SPEC EXISTE PARA PROVAR: nenhuma delas escreve. Elas
// param na proposta — e a prova é que `ProductUseCase.create/update` e
// `CustomerUseCase.create` NUNCA são chamados durante a execução da tool.
//
// E a segunda: a permissão por AÇÃO soma-se à de página. Quem entra em Produtos
// mas teve a chave desligada é barrado, e o modelo recebe "SEM PERMISSÃO" — não
// um erro genérico que o convide a tentar outro caminho.
// ===========================================================================

const registry = buildRegistry(WRITE_TOOLS);

const escopo = (over?: { can?: boolean; canAction?: boolean }) =>
  ({
    dataOwnerId: "t1",
    actorId: "u1",
    can: () => over?.can ?? true,
    canAction: () => over?.canAction ?? true,
  }) as any;

const chamar = (name: string, args: any, scope = escopo()) =>
  runTool({ id: "c1", name, args } as any, {
    registry,
    scope,
    conversationId: "conv1",
  });

const PECA = {
  id: "p1",
  sku: "4821",
  name: "Cubo de roda dianteiro",
  price: 180,
  stock: 3,
  listings: [{ status: "active" }, { status: "active" }],
};

beforeEach(() => {
  criarProdutoMock.mockReset();
  atualizarProdutoMock.mockReset();
  criarClienteMock.mockReset();
  buscarClienteMock.mockReset().mockResolvedValue([]);
  listarProdutosMock.mockReset().mockResolvedValue({ products: [PECA] });
  proporMock.mockReset().mockImplementation(async (input: any) => ({
    id: "acao-1",
    tipo: input.tipo,
    preview: input.preview,
    expiraEm: "2026-08-10T12:30:00.000Z",
  }));
});

describe("⭐ nenhuma tool de escrita ESCREVE", () => {
  it("cadastrar_produto propõe e não cria", async () => {
    const r = await chamar("cadastrar_produto", {
      nome: "Farol dianteiro esquerdo",
      preco: 320,
      estoque: 1,
    });

    expect(r.ok).toBe(true);
    expect(criarProdutoMock).not.toHaveBeenCalled();
    expect(proporMock).toHaveBeenCalledTimes(1);
    expect(proporMock.mock.calls[0][0].tipo).toBe("produto.criar");
  });

  it("alterar_preco_produto propõe e não altera", async () => {
    const r = await chamar("alterar_preco_produto", { sku: "4821", preco: 240 });

    expect(r.ok).toBe(true);
    expect(atualizarProdutoMock).not.toHaveBeenCalled();
    expect(proporMock.mock.calls[0][0].payload).toEqual({
      produtoId: "p1",
      preco: 240,
      precoAnterior: 180,
    });
  });

  it("ajustar_estoque_produto propõe e não altera", async () => {
    const r = await chamar("ajustar_estoque_produto", {
      sku: "4821",
      estoque: 7,
    });

    expect(r.ok).toBe(true);
    expect(atualizarProdutoMock).not.toHaveBeenCalled();
  });

  it("cadastrar_cliente propõe e não cria", async () => {
    const r = await chamar("cadastrar_cliente", {
      nome: "Oficina do João",
      telefone: "11999998888",
    });

    expect(r.ok).toBe(true);
    expect(criarClienteMock).not.toHaveBeenCalled();
  });
});

describe("⭐ a proposta não viaja para o modelo", () => {
  it("o `content` que vai ao provedor NÃO carrega o preview nem o payload", async () => {
    const r = await chamar("alterar_preco_produto", { sku: "4821", preco: 240 });

    // O modelo recebe o id, a instrução de pedir confirmação e uma frase curta.
    expect(r.content).toContain("acao-1");
    expect(r.content).toMatch(/confirm/i);

    // ⭐ O QUE NÃO PODE VIAJAR: o id interno do alvo e a estrutura do preview.
    // O id interno daria ao modelo uma chave que ele nunca consultou; o preview
    // inteiro seria carga paga em todo turno seguinte da conversa, para uma
    // informação que já está desenhada na tela do lojista.
    expect(r.content).not.toContain("produtoId");
    expect(r.content).not.toContain("p1");
    expect(r.content).not.toContain("campos");
    expect(r.content).not.toContain("Cubo de roda");

    // ⚠️ O PREÇO DE VENDA PODE ir, e vai de propósito: é o que permite ao Bitz
    // dizer "preparei a troca de R$ 180,00 para R$ 240,00, confere?" em vez de
    // "preparei uma alteração". Ele não é dado sensível — as tools de leitura
    // já o devolvem; o proibido é `costPrice`, que não passa por aqui.
    expect(r.content).toMatch(/180/);
  });

  it("a proposta sobe por FORA, em `acao`", async () => {
    const r = await chamar("cadastrar_produto", {
      nome: "Bomba d'água",
      preco: 200,
      estoque: 2,
    });

    expect(r.acao?.id).toBe("acao-1");
    expect(r.acao?.preview.campos.map((c: any) => c.campo)).toContain(
      "Preço de venda",
    );
  });

  it("⭐ o modelo é MANDADO não dizer que já fez", async () => {
    // É o erro mais provável e o mais caro: o lojista fecha o chat achando que
    // a peça está no catálogo, e ela não está.
    const r = await chamar("cadastrar_produto", {
      nome: "Coxim",
      preco: 90,
      estoque: 1,
    });

    expect(r.content).toMatch(/NÃO diga que já foi feito/i);
  });
});

describe("⭐ o preview conta a verdade sobre o marketplace", () => {
  it("peça COM anúncio: o aviso diz quantos e que não dá para desfazer", async () => {
    await chamar("alterar_preco_produto", { sku: "4821", preco: 240 });

    const aviso = proporMock.mock.calls[0][0].preview.aviso as string;
    expect(aviso).toContain("2 anúncios");
    expect(aviso).toMatch(/marketplace/i);
    expect(aviso).toMatch(/desfazer/i);
  });

  it("peça SEM anúncio: nenhum aviso de marketplace", async () => {
    listarProdutosMock.mockResolvedValue({
      products: [{ ...PECA, listings: [] }],
    });

    await chamar("alterar_preco_produto", { sku: "4821", preco: 240 });

    const aviso = proporMock.mock.calls[0][0].preview.aviso;
    expect(aviso).toBeUndefined();
  });

  it("o `de → para` mostra o valor ATUAL, lido do catálogo", async () => {
    await chamar("ajustar_estoque_produto", { sku: "4821", estoque: 7 });

    const campos = proporMock.mock.calls[0][0].preview.campos;
    expect(campos[0]).toEqual({ campo: "Estoque", de: "3", para: "7" });
  });
});

describe("⭐ o alvo é resolvido DENTRO do tenant, e não é adivinhado", () => {
  it("⭐⭐ SKU inexistente é RESPOSTA, não falha de sistema", async () => {
    // ⚠️ Conserto de um achado. A tool LANÇAVA nesse caso, e o tool-runner
    // traduz qualquer exceção para "não consegui buscar agora, tenta de novo".
    // O lojista que digitou "9999" em vez de "4999" ouvia isso, tentava de novo,
    // ouvia a mesma coisa — e o sistema NUNCA lhe dizia que o problema era o
    // SKU. Um erro dele virava um erro aparente nosso, sem saída.
    listarProdutosMock.mockResolvedValue({ products: [] });

    const r = await chamar("alterar_preco_produto", { sku: "9999", preco: 10 });

    expect(r.ok).toBe(true);
    expect(r.acao).toBeUndefined();
    expect(proporMock).not.toHaveBeenCalled();
    // O modelo é informado da VERDADE, com o SKU, e proibido de inventar.
    expect(r.content).toContain("9999");
    expect(r.content).toMatch(/não existe peça/i);
    expect(r.content).toMatch(/NÃO invente/i);
    // E o modelo é proibido de vender isto como problema do sistema — que era
    // exatamente o que o caminho antigo fazia.
    expect(r.content).toMatch(/não houve/i);
    expect(r.content).not.toMatch(/tent(ar|e) de novo/i);
  });

  it("SKU que só bate PARCIALMENTE não serve", async () => {
    // A busca devolve por relevância; só o SKU EXATO pode virar alvo.
    listarProdutosMock.mockResolvedValue({
      products: [{ ...PECA, sku: "48210" }],
    });

    const r = await chamar("alterar_preco_produto", { sku: "4821", preco: 240 });

    expect(r.acao).toBeUndefined();
    expect(proporMock).not.toHaveBeenCalled();
  });

  it("a busca do alvo é escopada pelo tenant do SCOPE", async () => {
    await chamar("alterar_preco_produto", { sku: "4821", preco: 240 });
    expect(listarProdutosMock.mock.calls[0][0].userId).toBe("t1");
  });
});

describe("⭐ permissão: página E ação, somadas", () => {
  it("sem acesso à PÁGINA: recusa antes de qualquer I/O", async () => {
    const r = await chamar(
      "cadastrar_produto",
      { nome: "x y", preco: 1, estoque: 1 },
      escopo({ can: false }),
    );

    expect(r.ok).toBe(false);
    expect(r.failure).toBe("sem_permissao");
    expect(proporMock).not.toHaveBeenCalled();
    expect(listarProdutosMock).not.toHaveBeenCalled();
  });

  it("⭐⭐ COM a página e SEM a chave da ação: recusa igual", async () => {
    const r = await chamar(
      "alterar_preco_produto",
      { sku: "4821", preco: 240 },
      escopo({ can: true, canAction: false }),
    );

    expect(r.ok).toBe(false);
    expect(r.failure).toBe("sem_permissao");
    expect(proporMock).not.toHaveBeenCalled();
    // E o modelo é mandado NÃO tentar contornar por outro caminho.
    expect(r.content).toMatch(/NÃO tente outra ferramenta/i);
  });

  it("a recusa NÃO revela o que ele teria alterado", async () => {
    const r = await chamar(
      "alterar_preco_produto",
      { sku: "4821", preco: 240 },
      escopo({ canAction: false }),
    );
    expect(r.content).not.toContain("Cubo de roda");
    expect(r.content).not.toContain("180");
  });
});

describe("⭐ o aviso de cliente duplicado FUNCIONA", () => {
  // ⚠️ Ele era LINHA MORTA: `CustomerUseCase.search(q, userId)` é posicional e
  // estava sendo chamado com um OBJETO por trás de um `as any`. O `userId`
  // chegava `undefined`, o retorno nunca casava, e o cartão sempre mostrava o
  // texto genérico de CPF/CNPJ. Cinco lentes da revisão acharam isto.
  it("chama a busca com a assinatura POSICIONAL correta", async () => {
    await chamar("cadastrar_cliente", { nome: "Oficina do João" });
    expect(buscarClienteMock).toHaveBeenCalledWith("Oficina do João", "t1");
  });

  it("homônimo exato vira aviso no cartão", async () => {
    buscarClienteMock.mockResolvedValue([
      { name: "Oficina do João" },
      { name: "Oficina do Joao Ltda" },
    ]);

    await chamar("cadastrar_cliente", { nome: "Oficina do João" });

    const aviso = proporMock.mock.calls[0][0].preview.aviso as string;
    expect(aviso).toMatch(/já existe/i);
    expect(aviso).toMatch(/mesma pessoa/i);
  });

  it("sem homônimo, cai no aviso genérico de documento", async () => {
    buscarClienteMock.mockResolvedValue([{ name: "Outra Oficina" }]);
    await chamar("cadastrar_cliente", { nome: "Oficina do João" });
    const aviso = proporMock.mock.calls[0][0].preview.aviso as string;
    expect(aviso).toMatch(/CPF/);
  });

  it("⚠️ busca que estoura NÃO derruba a proposta", async () => {
    // O aviso é conveniência; trocar um cadastro por um erro de busca seria
    // pior. O que não pode falhar em silêncio é a escrita, e ela nem aconteceu.
    buscarClienteMock.mockRejectedValue(new Error("db fora"));
    const r = await chamar("cadastrar_cliente", { nome: "Fulano" });
    expect(r.ok).toBe(true);
    expect(proporMock).toHaveBeenCalledTimes(1);
  });
});

describe("contrato do schema", () => {
  it("toda tool de escrita é `.strict()` — chave extra é REJEITADA", async () => {
    for (const tool of WRITE_TOOLS) {
      const r = tool.args.safeParse({ __invasor__: 1 });
      expect(r.success, tool.name).toBe(false);
    }
  });

  it("⭐ nenhum schema aceita tenant, id de dono ou id interno de produto", async () => {
    // O alvo é resolvido pelo SERVIDOR a partir do SKU. Aceitar um id interno
    // deixaria o modelo apontar para uma linha que ele nunca consultou.
    for (const tool of WRITE_TOOLS) {
      const chaves = Object.keys((tool.args as any)._def.shape());
      for (const k of chaves) {
        expect(k, `${tool.name}.${k}`).not.toMatch(
          /userId|dataOwnerId|tenant|ownerId|produtoId|clienteId|^id$/i,
        );
      }
    }
  });

  it("preço e estoque negativos não passam", async () => {
    const r1 = await chamar("alterar_preco_produto", {
      sku: "4821",
      preco: -1,
    });
    expect(r1.ok).toBe(false);

    const r2 = await chamar("ajustar_estoque_produto", {
      sku: "4821",
      estoque: -5,
    });
    expect(r2.ok).toBe(false);
  });

  it("⭐ cadastrar_cliente NÃO aceita CPF nem CNPJ", async () => {
    // Documento é `CAMPO_PROIBIDO` no tool-runner: o resultado de uma tool sai
    // por HTTP para o provedor de IA, e documento não faz essa viagem.
    const r = await chamar("cadastrar_cliente", {
      nome: "Fulano",
      cpf: "12345678901",
    });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("argumentos_invalidos");
  });
});
