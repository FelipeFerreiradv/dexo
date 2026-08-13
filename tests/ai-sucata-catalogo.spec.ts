import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// Bitz — cadastro de SUCATA e pendências do CATÁLOGO.
//
// ⭐ AS DUAS AFIRMAÇÕES QUE ESTE SPEC EXISTE PARA PROVAR:
//
//  1. `cadastrar_sucata` NÃO cadastra. Ela resolve a marca, normaliza a placa,
//     monta o cartão e para. `ScrapUseCase.create` nunca é chamado durante a
//     execução da tool — quem chama é o executor, depois do clique.
//  2. Nada é inventado. Quando o catálogo não sabe a marca, a tool PERGUNTA em
//     vez de escolher — e quando a placa não tem formato de placa, ela DIZ que
//     não vai gravar, em vez de deixar o campo sumir do cartão.
// ===========================================================================

const produtoCountMock = vi.fn();
const produtoFindManyMock = vi.fn();
const clienteCountMock = vi.fn();
const clienteFindManyMock = vi.fn();
vi.mock("../app/lib/prisma", () => ({
  default: {
    systemLog: { create: async () => ({}) },
    product: {
      count: (...a: any[]) => produtoCountMock(...a),
      findMany: (...a: any[]) => produtoFindManyMock(...a),
    },
    customer: {
      count: (...a: any[]) => clienteCountMock(...a),
      findMany: (...a: any[]) => clienteFindManyMock(...a),
    },
  },
}));

const criarSucataMock = vi.fn();
const listarSucatasMock = vi.fn();
vi.mock("../app/usecases/scrap.usercase", () => ({
  ScrapUseCase: class {
    create = (...a: any[]) => criarSucataMock(...a);
    listScraps = (...a: any[]) => listarSucatasMock(...a);
  },
}));

const listarProdutosMock = vi.fn();
vi.mock("../app/usecases/product.usercase", () => ({
  ProductUseCase: class {
    listProducts = (...a: any[]) => listarProdutosMock(...a);
  },
}));

const criarClienteMock = vi.fn();
const buscarClienteMock = vi.fn();
const listarClientesMock = vi.fn();
vi.mock("../app/usecases/customer.usecase", () => ({
  CustomerUseCase: class {
    create = (...a: any[]) => criarClienteMock(...a);
    search = (...a: any[]) => buscarClienteMock(...a);
    list = (...a: any[]) => listarClientesMock(...a);
  },
}));

const proporMock = vi.fn();
vi.mock("../app/ai/acoes/acao.service", async (orig) => {
  const real = (await orig()) as any;
  return { ...real, proporAcao: (...a: any[]) => proporMock(...a) };
});

import { runTool } from "../app/ai/agent/tool-runner";
import { READ_TOOLS } from "../app/ai/tools/read";
import { buildRegistry } from "../app/ai/tools/registry";
import { WRITE_TOOLS } from "../app/ai/tools/write";
import { marcasDoModelo } from "../app/ai/tools/write/sucatas";
import {
  getModelsForBrand,
  getVehicleBrands,
} from "../app/lib/vehicle-catalog";

const registry = buildRegistry([...READ_TOOLS, ...WRITE_TOOLS]);

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

/** O payload que foi para `proporAcao` na última chamada. */
const ultimoPayload = () => proporMock.mock.calls.at(-1)?.[0]?.payload;
/** O preview que foi para `proporAcao` na última chamada. */
const ultimoPreview = () => proporMock.mock.calls.at(-1)?.[0]?.preview;

beforeEach(() => {
  criarSucataMock.mockReset();
  listarSucatasMock.mockReset().mockResolvedValue({ scraps: [], total: 0 });
  listarProdutosMock.mockReset().mockResolvedValue({ products: [], total: 0 });
  criarClienteMock.mockReset();
  buscarClienteMock.mockReset().mockResolvedValue([]);
  listarClientesMock.mockReset().mockResolvedValue({ customers: [] });
  produtoCountMock.mockReset().mockResolvedValue(0);
  produtoFindManyMock.mockReset().mockResolvedValue([]);
  proporMock.mockReset().mockImplementation(async (input: any) => ({
    id: "acao-sucata",
    tipo: input.tipo,
    preview: input.preview,
    expiraEm: "2026-08-12T12:30:00.000Z",
  }));
});

// ---------------------------------------------------------------------------

describe("⭐ cadastrar_sucata NÃO cadastra", () => {
  it("propõe e não cria", async () => {
    const r = await chamar("cadastrar_sucata", { modelo: "Gol", ano: "2015" });

    expect(criarSucataMock).not.toHaveBeenCalled();
    expect(proporMock).toHaveBeenCalledTimes(1);
    expect(r.acao?.tipo).toBe("sucata.criar");
  });

  it("⭐ o payload NÃO carrega o tenant — ele entra no executor, pelo escopo", async () => {
    await chamar("cadastrar_sucata", { modelo: "Gol" });
    const payload = ultimoPayload();
    expect(JSON.stringify(payload)).not.toMatch(/userId|dataOwnerId|t1/);
  });
});

describe("⭐⭐ a marca sai do catálogo, nunca de um palpite", () => {
  it("só o modelo já resolve a marca", async () => {
    await chamar("cadastrar_sucata", { modelo: "Gol", ano: "2015" });
    expect(ultimoPayload().sucata.brand).toBe("Volkswagen");
    expect(ultimoPayload().sucata.model).toBe("Gol");
  });

  it("resolve sem depender de acento nem de caixa", async () => {
    await chamar("cadastrar_sucata", { modelo: "ONIX" });
    expect(ultimoPayload().sucata.brand).toBe("Chevrolet");
  });

  it("⭐ modelo DESCONHECIDO pergunta a marca — e não propõe nada", async () => {
    const r = await chamar("cadastrar_sucata", { modelo: "Xyzzyca" });

    expect(proporMock).not.toHaveBeenCalled();
    expect(r.acao).toBeUndefined();
    expect(JSON.stringify(r)).toMatch(/MARCA/i);
    // A frase precisa PROIBIR a escolha por conta própria: sem isso o modelo
    // "ajuda" preenchendo a marca que achar mais provável.
    expect(JSON.stringify(r)).toMatch(/não escolha/i);
  });

  it("a marca DITADA pelo usuário vence o catálogo", async () => {
    await chamar("cadastrar_sucata", { modelo: "Gol", marca: "Volksvagen" });
    expect(ultimoPayload().sucata.brand).toBe("Volksvagen");
  });

  it("a marca resolvida vai para o modelo, para ele poder repetir e o dono conferir", async () => {
    const r = await chamar("cadastrar_sucata", { modelo: "Strada" });
    expect(JSON.stringify(r)).toContain("Fiat");
  });
});

describe("⭐ o ramo AMBÍGUO existe e funciona (catálogo injetado)", () => {
  // ⚠️ O que estes testes cobrem é a DECISÃO (`marcasDoModelo`), com índice
  // injetado. O ramo equivalente DENTRO do handler de `cadastrar_sucata` é
  // inalcançável com o catálogo de hoje — uma mutação que o desliga sobrevive,
  // e isso está registrado no arquivo da tool em vez de disfarçado aqui.
  // Quem protege aquele ramo é o teste de INVARIANTE logo abaixo: no dia em que
  // o catálogo ganhar um modelo repetido, ele falha e manda conferir.
  const indiceFalso = new Map<string, string[]>([
    ["ranger", ["Ford", "Volkswagen"]],
    ["gol", ["Volkswagen"]],
  ]);

  it("modelo em duas marcas devolve as DUAS candidatas", () => {
    expect(marcasDoModelo("Ranger", indiceFalso)).toEqual([
      "Ford",
      "Volkswagen",
    ]);
  });

  it("modelo de marca única devolve uma só", () => {
    expect(marcasDoModelo("Gol", indiceFalso)).toEqual(["Volkswagen"]);
  });

  it("modelo ausente devolve lista vazia, nunca undefined", () => {
    expect(marcasDoModelo("Inexistente", indiceFalso)).toEqual([]);
  });
});

describe("⭐ INVARIANTE do catálogo real", () => {
  it("nenhum nome de modelo existe em duas marcas", () => {
    // Se este teste falhar, NÃO é para relaxá-lo: significa que o catálogo
    // ganhou um modelo ambíguo e que o ramo de desambiguação de
    // `cadastrar_sucata` passou a ser alcançável de verdade. Confira se a
    // pergunta que a tool faz está boa antes de seguir.
    const porModelo = new Map<string, string[]>();
    for (const marca of getVehicleBrands()) {
      for (const modelo of getModelsForBrand(marca)) {
        const k = modelo.toLowerCase();
        porModelo.set(k, [...(porModelo.get(k) ?? []), marca]);
      }
    }
    const ambiguos = [...porModelo.entries()].filter(([, m]) => m.length > 1);
    expect(ambiguos).toEqual([]);
  });
});

describe("⭐ a placa é normalizada — e o que não passa é DITO", () => {
  it("sobe para maiúsculas e tira o hífen, como o importador faz", async () => {
    await chamar("cadastrar_sucata", { modelo: "Gol", placa: "abc-1d23" });
    expect(ultimoPayload().sucata.plate).toBe("ABC1D23");
  });

  it("⚠️ placa inválida NÃO some calada: o cartão avisa que não vai gravar", async () => {
    await chamar("cadastrar_sucata", { modelo: "Gol", placa: "12" });

    expect(ultimoPayload().sucata.plate).toBeNull();
    expect(ultimoPreview().aviso).toMatch(/não vai ser gravada/i);
    // E o campo não aparece na lista de campos, porque não vai ser gravado.
    const campos = ultimoPreview().campos.map((c: any) => c.campo);
    expect(campos).not.toContain("Placa");
  });

  it("sem placa, nenhum aviso de placa", async () => {
    await chamar("cadastrar_sucata", { modelo: "Gol" });
    expect(ultimoPreview().aviso).not.toMatch(/não vai ser gravada/i);
  });
});

describe("⭐ aviso de placa repetida", () => {
  it("avisa quando já existe sucata com a mesma placa", async () => {
    listarSucatasMock.mockResolvedValue({
      scraps: [{ id: "s1", plate: "ABC-1D23" }],
      total: 1,
    });

    await chamar("cadastrar_sucata", { modelo: "Gol", placa: "ABC1D23" });
    expect(ultimoPreview().aviso).toMatch(/já existe uma sucata com esta placa/i);
  });

  it("compara NORMALIZADO — 'ABC-1D23' no banco casa 'abc1d23' ditado", async () => {
    listarSucatasMock.mockResolvedValue({
      scraps: [{ id: "s1", plate: "ABC-1D23" }],
      total: 1,
    });
    await chamar("cadastrar_sucata", { modelo: "Gol", placa: "abc1d23" });
    expect(ultimoPreview().aviso).toMatch(/já existe/i);
  });

  it("placa diferente não vira aviso", async () => {
    listarSucatasMock.mockResolvedValue({
      scraps: [{ id: "s1", plate: "XYZ9K88" }],
      total: 1,
    });
    await chamar("cadastrar_sucata", { modelo: "Gol", placa: "ABC1D23" });
    expect(ultimoPreview().aviso).not.toMatch(/já existe/i);
  });

  it("⚠️ busca que ESTOURA não derruba a proposta", async () => {
    listarSucatasMock.mockRejectedValue(new Error("pool esgotado"));

    const r = await chamar("cadastrar_sucata", {
      modelo: "Gol",
      placa: "ABC1D23",
    });
    // A proposta continua de pé — só sem o aviso de conveniência.
    expect(r.acao?.tipo).toBe("sucata.criar");
    expect(ultimoPreview().aviso).not.toMatch(/já existe/i);
  });

  it("a busca de repetidas é escopada pelo tenant do SCOPE", async () => {
    await chamar("cadastrar_sucata", { modelo: "Gol", placa: "ABC1D23" });
    expect(listarSucatasMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "t1" }),
    );
  });
});

describe("⭐ o cartão conta a verdade sobre o que a sucata é", () => {
  it("diz que ela nasce VAZIA — nenhuma peça, nenhum estoque, nenhum financeiro", async () => {
    await chamar("cadastrar_sucata", { modelo: "Gol" });
    const aviso = ultimoPreview().aviso;
    expect(aviso).toMatch(/nasce VAZIA/i);
    expect(aviso).toMatch(/estoque/i);
    expect(aviso).toMatch(/financeiro/i);
  });

  it("diz o que ficou de fora e onde completar", async () => {
    await chamar("cadastrar_sucata", { modelo: "Gol" });
    const aviso = ultimoPreview().aviso;
    expect(aviso).toMatch(/chassi/i);
    expect(aviso).toMatch(/renavam/i);
    expect(aviso).toMatch(/tela de Sucatas/i);
  });

  it("todo campo que vai para o banco aparece no cartão", async () => {
    await chamar("cadastrar_sucata", {
      modelo: "Gol",
      ano: "2015",
      versao: "1.0",
      cor: "Prata",
      placa: "ABC1D23",
      apelido: "Gol bola azul",
      lote: "77",
      custo: 4500,
      custosExtras: 300,
    });

    const preenchidos = Object.entries(ultimoPayload().sucata)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k]) => k);
    // 10 campos de negócio + a marca resolvida.
    expect(preenchidos).toHaveLength(10);
    expect(ultimoPreview().campos).toHaveLength(10);
  });

  it("valores em reais aparecem formatados, não como número cru", async () => {
    await chamar("cadastrar_sucata", { modelo: "Gol", custo: 4500 });
    const custo = ultimoPreview().campos.find(
      (c: any) => c.campo === "Valor de compra",
    );
    expect(custo.para).toMatch(/4\.500,00/);
  });
});

describe("⭐ o schema recusa o que não pode entrar", () => {
  const recusados = [
    { chassi: "9BWZZZ377VT004251" },
    { renavam: "12345678901" },
    { numeroDoMotor: "ABC123" },
    { observacao: "comprado do Zé" },
    { chaveDeAcesso: "1".repeat(44) },
    { userId: "outro-tenant" },
  ];

  it.each(recusados)("rejeita %s", async (extra) => {
    const r = await chamar("cadastrar_sucata", { modelo: "Gol", ...extra });
    expect(r.ok).toBe(false);
    expect(proporMock).not.toHaveBeenCalled();
    expect(criarSucataMock).not.toHaveBeenCalled();
  });
});

describe("⭐ permissão: página E ação, somadas", () => {
  it("sem acesso a Sucatas: recusa antes de qualquer I/O", async () => {
    const r = await chamar(
      "cadastrar_sucata",
      { modelo: "Gol" },
      escopo({ can: false }),
    );
    expect(r.ok).toBe(false);
    expect(listarSucatasMock).not.toHaveBeenCalled();
    expect(proporMock).not.toHaveBeenCalled();
  });

  it("⭐⭐ COM a página e SEM a chave da ação: recusa igual", async () => {
    const r = await chamar(
      "cadastrar_sucata",
      { modelo: "Gol" },
      escopo({ canAction: false }),
    );
    expect(r.ok).toBe(false);
    expect(proporMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("⭐ pendencias_do_catalogo", () => {
  it("sem-anuncio devolve TRÊS números, não um", async () => {
    listarProdutosMock
      .mockResolvedValueOnce({ products: [], total: 77480 })
      .mockResolvedValueOnce({ products: [], total: 48671 })
      .mockResolvedValueOnce({ products: [], total: 79452 });

    const r = await chamar("pendencias_do_catalogo", { escopo: "sem-anuncio" });
    const bloco = JSON.parse(r.content).pecasSemAnuncio;

    // ⭐ Sem o denominador, "77.480" faria o Bitz anunciar uma catástrofe onde
    // existe uma escolha comercial. Sem o recorte de estoque, o número é
    // inacionável.
    expect(bloco.total).toBe(77480);
    expect(bloco.comEstoqueDisponivel).toBe(48671);
    expect(bloco.totalDePecasNoCatalogo).toBe(79452);
    expect(bloco.comoInterpretar).toMatch(/normal/i);
  });

  it("a AMOSTRA de sem-anuncio é das peças COM estoque", async () => {
    await chamar("pendencias_do_catalogo", { escopo: "sem-anuncio" });
    const chamadaDaAmostra = listarProdutosMock.mock.calls.find(
      (c) => (c[0] as any)?.limit > 1,
    )?.[0] as any;

    expect(chamadaDaAmostra.publicationStatus).toBe("NO_LISTING");
    expect(chamadaDaAmostra.stockStatus).toBe("IN_STOCK");
  });

  it("⭐ reusa o filtro da TELA, e não um vocabulário próprio de status", async () => {
    await chamar("pendencias_do_catalogo", { escopo: "anuncios-pausados" });
    // "pausado" no Dexo é ["paused","unlist"] — pedir ao usecase é o que
    // impede a tool de perder as linhas `unlist` em silêncio.
    expect(listarProdutosMock).toHaveBeenCalledWith(
      expect.objectContaining({ publicationStatus: "PAUSED", userId: "t1" }),
    );
  });

  it("pausados: o total conta PEÇAS, e o texto diz isso", async () => {
    listarProdutosMock.mockResolvedValue({ products: [], total: 40 });
    const r = await chamar("pendencias_do_catalogo", {
      escopo: "anuncios-pausados",
    });
    const bloco = JSON.parse(r.content).pecasComAnuncioPausado;

    expect(bloco.total).toBe(40);
    expect(bloco.aUnidadeEPeca).toMatch(/peças, não anúncios/i);
    // A data não pode ser vendida como "pausado desde".
    expect(bloco.atencao).toMatch(/última alteração/i);
  });

  it("⚠️ lê `platform` do PRIMEIRO NÍVEL — o objeto vem achatado", async () => {
    listarProdutosMock.mockResolvedValue({
      total: 1,
      products: [
        {
          sku: "4821",
          name: "Farol",
          price: 180,
          stock: 2,
          listings: [
            { status: "paused", platform: "SHOPEE", updatedAt: new Date() },
            { status: "unlist", platform: "OLX", updatedAt: new Date() },
            { status: "active", platform: "MERCADO_LIVRE" },
          ],
        },
      ],
    });

    const r = await chamar("pendencias_do_catalogo", {
      escopo: "anuncios-pausados",
    });
    const item = JSON.parse(r.content).pecasComAnuncioPausado.itens[0];

    // Só os pausados, e `unlist` conta como pausado.
    expect(item.anunciosPausados).toHaveLength(2);
    expect(item.anunciosPausados.map((a: any) => a.canal)).toEqual([
      "SHOPEE",
      "OLX",
    ]);
  });

  it("sem-localizacao exige os DOIS campos vazios", async () => {
    await chamar("pendencias_do_catalogo", { escopo: "sem-localizacao" });
    const where = produtoCountMock.mock.calls[0][0].where;

    expect(where.userId).toBe("t1");
    expect(where.locationId).toBeNull();
    // Prateleira vazia E endereço em texto vazio. Só um dos dois seria meia
    // verdade: com qualquer um preenchido o lojista acha a peça.
    expect(where.OR).toEqual([{ location: null }, { location: "" }]);
  });

  it("⭐ a projeção NUNCA devolve custo nem margem", async () => {
    listarProdutosMock.mockResolvedValue({
      total: 1,
      products: [
        {
          sku: "4821",
          name: "Farol",
          price: 180,
          stock: 2,
          costPrice: 90,
          markup: 2,
          listings: [],
        },
      ],
    });

    const r = await chamar("pendencias_do_catalogo", { escopo: "sem-anuncio" });
    expect(r.ok).toBe(true);
    expect(r.content).not.toMatch(/costPrice|markup|custo/i);
    expect(r.content).not.toContain("90");
  });

  it("escopo 'tudo' traz os três blocos", async () => {
    const r = await chamar("pendencias_do_catalogo", {});
    const dados = JSON.parse(r.content);
    expect(Object.keys(dados).sort()).toEqual([
      "pecasComAnuncioPausado",
      "pecasSemAnuncio",
      "pecasSemLocalizacao",
    ]);
  });

  it("sem acesso a Produtos: recusa antes de qualquer I/O", async () => {
    const r = await chamar(
      "pendencias_do_catalogo",
      { escopo: "sem-anuncio" },
      escopo({ can: false }),
    );
    expect(r.ok).toBe(false);
    expect(listarProdutosMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("⭐ P1.2 — vincular a peça ao lote de onde ela saiu", () => {
  const PECA = { id: "p1", sku: "4821", name: "Cubo de roda", scrapId: null };
  const LOTE = {
    id: "s9",
    brand: "Volkswagen",
    model: "Gol",
    year: "2015",
    plate: "ABC1D23",
  };

  const comPecaELote = (lotes: any[] = [LOTE]) => {
    listarProdutosMock.mockResolvedValue({ products: [PECA], total: 1 });
    listarSucatasMock.mockResolvedValue({ scraps: lotes, total: lotes.length });
  };

  it("propõe e NÃO vincula", async () => {
    comPecaELote();
    const r = await chamar("vincular_peca_a_sucata", {
      sku: "4821",
      sucata: "ABC1D23",
    });

    expect(r.acao?.tipo).toBe("produto.vincular-sucata");
    expect(ultimoPayload()).toEqual({ produtoId: "p1", sucataId: "s9" });
  });

  it("⭐⭐ o cartão promete que NÃO vai para marketplace — e isso é verdade do usecase", async () => {
    comPecaELote();
    await chamar("vincular_peca_a_sucata", { sku: "4821", sucata: "ABC1D23" });

    const aviso = ultimoPreview().aviso;
    expect(aviso).toMatch(/não mexe em preço, estoque nem anúncio/i);
    expect(aviso).toMatch(/marketplace nenhum/i);
  });

  it("⭐ SKU inexistente é RESPOSTA de negócio, não falha", async () => {
    listarProdutosMock.mockResolvedValue({ products: [], total: 0 });
    const r = await chamar("vincular_peca_a_sucata", {
      sku: "9999",
      sucata: "ABC1D23",
    });

    expect(r.acao).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.content).toContain("9999");
    expect(r.content).toMatch(/não invente/i);
  });

  it("⭐⭐ AMBIGUIDADE pergunta, nunca escolhe a primeira", async () => {
    // Três Gol no pátio. Escolher um vincularia a peça ao carro errado, e o
    // erro só apareceria no retorno daquele lote, semanas depois.
    comPecaELote([
      LOTE,
      { ...LOTE, id: "s10", plate: "XYZ9K88" },
      { ...LOTE, id: "s11", nickname: "Gol bola azul", plate: null },
    ]);

    const r = await chamar("vincular_peca_a_sucata", {
      sku: "4821",
      sucata: "Gol",
    });

    expect(proporMock).not.toHaveBeenCalled();
    expect(r.content).toMatch(/3 sucatas/i);
    expect(r.content).toMatch(/não escolha/i);
    // E lista as opções para o modelo poder repeti-las.
    expect(r.content).toContain("XYZ9K88");
  });

  it("⭐⭐ P1.4 — a ambiguidade vira BOTÕES, um por candidata", async () => {
    comPecaELote([
      LOTE,
      { ...LOTE, id: "s10", plate: "XYZ9K88" },
      { ...LOTE, id: "s11", nickname: "Gol bola azul", plate: null },
    ]);

    const r = await chamar("vincular_peca_a_sucata", {
      sku: "4821",
      sucata: "Gol",
    });

    const opcoes = r.opcoes as Array<{ rotulo: string; enviar: string }>;
    expect(opcoes).toHaveLength(3);
    // O rótulo é o que o lojista LÊ.
    expect(opcoes[0].rotulo).toContain("ABC1D23");
    // ⚠️ E o envio reconstrói a frase inteira: mandar só a placa obrigaria o
    // modelo a lembrar de qual peça se falava, que é onde ele erra.
    expect(opcoes[0].enviar).toContain("4821");
    expect(opcoes[0].enviar).toContain("ABC1D23");
  });

  it("⭐ o botão usa o identificador MAIS ESPECÍFICO, senão vira laço", async () => {
    // Reenviar "Gol 2015" cairia na mesma pergunta para sempre. Placa primeiro,
    // apelido depois — o que sobra é justamente o termo que gerou a ambiguidade.
    comPecaELote([
      { ...LOTE, id: "s11", nickname: "Gol bola azul", plate: null },
      { ...LOTE, id: "s12", plate: "XYZ9K88", nickname: null },
    ]);

    const r = await chamar("vincular_peca_a_sucata", {
      sku: "4821",
      sucata: "Gol",
    });

    const opcoes = r.opcoes as Array<{ rotulo: string; enviar: string }>;
    expect(opcoes[0].enviar).toContain("Gol bola azul");
    expect(opcoes[1].enviar).toContain("XYZ9K88");
  });

  it("⭐⭐ as opções NÃO viajam para o provedor de IA", async () => {
    comPecaELote([LOTE, { ...LOTE, id: "s10", plate: "XYZ9K88" }]);
    const r = await chamar("vincular_peca_a_sucata", {
      sku: "4821",
      sucata: "Gol",
    });

    // `content` é o que vai ao modelo. As opções saem por FORA, como a `acao` —
    // o modelo já recebe a lista na instrução, e mandá-la duas vezes seria
    // pagar o mesmo token duas vezes.
    const paraOModelo = JSON.parse(r.content);
    expect(paraOModelo.opcoes).toBeUndefined();
    expect(r.opcoes).toBeTruthy();
  });

  it("⭐ o modelo é MANDADO não repetir a lista, já que os botões aparecem", async () => {
    comPecaELote([LOTE, { ...LOTE, id: "s10", plate: "XYZ9K88" }]);
    const r = await chamar("vincular_peca_a_sucata", {
      sku: "4821",
      sucata: "Gol",
    });
    expect(r.content).toMatch(/botões de escolha já aparecem/i);
  });

  it("caso SEM ambiguidade não gera botão nenhum", async () => {
    comPecaELote();
    const r = await chamar("vincular_peca_a_sucata", {
      sku: "4821",
      sucata: "ABC1D23",
    });
    expect(r.opcoes).toBeUndefined();
  });

  it("sucata não encontrada pergunta a placa", async () => {
    comPecaELote([]);
    const r = await chamar("vincular_peca_a_sucata", {
      sku: "4821",
      sucata: "Fusca",
    });
    expect(proporMock).not.toHaveBeenCalled();
    expect(r.content).toMatch(/placa|apelido/i);
  });

  it("⭐⭐ exige as DUAS páginas: sem Sucatas, recusa mesmo tendo Produtos", async () => {
    comPecaELote();
    const so_produtos = {
      dataOwnerId: "t1",
      actorId: "u1",
      can: (p: string) => p !== "sucatas",
      canAction: () => true,
    } as any;

    const r = await chamar(
      "vincular_peca_a_sucata",
      { sku: "4821", sucata: "ABC1D23" },
      so_produtos,
    );

    expect(proporMock).not.toHaveBeenCalled();
    expect(r.content).toMatch(/Sucatas/);
    // E não foi buscar o lote — a recusa vem antes do I/O de sucata.
    expect(listarSucatasMock).not.toHaveBeenCalled();
  });

  it("peça que TROCA de lote mostra o 'de' no cartão", async () => {
    listarProdutosMock.mockResolvedValue({
      products: [{ ...PECA, scrapId: "s-antigo" }],
      total: 1,
    });
    listarSucatasMock.mockResolvedValue({ scraps: [LOTE], total: 1 });

    await chamar("vincular_peca_a_sucata", { sku: "4821", sucata: "ABC1D23" });
    expect(ultimoPreview().campos[0].de).toBeTruthy();
  });

  it("o payload não carrega o tenant", async () => {
    comPecaELote();
    await chamar("vincular_peca_a_sucata", { sku: "4821", sucata: "ABC1D23" });
    expect(JSON.stringify(ultimoPayload())).not.toMatch(/t1|userId/);
  });
});

describe("⭐ P1.1 — 'o que foi cadastrado hoje?'", () => {
  it("peças: converte dias em janela ROLANTE e passa createdFrom", async () => {
    await chamar("buscar_produto", { cadastradasNosUltimosDias: 1 });

    const filtro = listarProdutosMock.mock.calls.at(-1)?.[0] as any;
    expect(filtro.createdFrom).toBeInstanceOf(Date);
    // ~24h atrás, com folga para o tempo de execução do teste.
    const horas = (Date.now() - filtro.createdFrom.getTime()) / 3_600_000;
    expect(horas).toBeGreaterThan(23.9);
    expect(horas).toBeLessThan(24.1);
    // Sem termo de busca: a pergunta é sobre período, não sobre nome.
    expect(filtro.search).toBeUndefined();
  });

  it("peças: o rótulo do período fala em HORAS, não em 'hoje'", async () => {
    const r = await chamar("buscar_produto", { cadastradasNosUltimosDias: 1 });
    // ⚠️ "hoje" sugeriria corte à meia-noite, que não é o que a consulta faz.
    expect(JSON.parse(r.content).periodo).toMatch(/últimas 24 horas/i);
  });

  it("peças: busca por texto continua funcionando igual", async () => {
    await chamar("buscar_produto", { consulta: "farol gol" });
    const filtro = listarProdutosMock.mock.calls.at(-1)?.[0] as any;
    expect(filtro.search).toBe("farol gol");
    expect(filtro.createdFrom).toBeUndefined();
  });

  it("⭐ sem consulta E sem período, PERGUNTA em vez de despejar o catálogo", async () => {
    const r = await chamar("buscar_produto", {});
    expect(JSON.parse(r.content).precisoDeUmFiltro).toBe(true);
    // E não gastou uma ida ao banco para descobrir isso.
    expect(listarProdutosMock).not.toHaveBeenCalled();
  });

  it("clientes: período usa a LISTAGEM, que aceita data — não o typeahead", async () => {
    await chamar("buscar_cliente", { cadastradosNosUltimosDias: 7 });

    // `search` (typeahead) não aceita período; `list` aceita.
    expect(buscarClienteMock).not.toHaveBeenCalled();
    const [filtros, tenant] = listarClientesMock.mock.calls.at(-1) as any[];
    expect(filtros.createdFrom).toBeInstanceOf(Date);
    expect(tenant).toBe("t1");
  });

  it("clientes: busca por nome continua no typeahead", async () => {
    buscarClienteMock.mockResolvedValue([]);
    await chamar("buscar_cliente", { consulta: "João" });
    expect(buscarClienteMock).toHaveBeenCalledWith("João", "t1");
    expect(listarClientesMock).not.toHaveBeenCalled();
  });

  it("clientes: sem nada, pergunta", async () => {
    const r = await chamar("buscar_cliente", {});
    expect(JSON.parse(r.content).precisoDeUmFiltro).toBe(true);
    expect(buscarClienteMock).not.toHaveBeenCalled();
    expect(listarClientesMock).not.toHaveBeenCalled();
  });

  it("⭐⭐ o REPOSITÓRIO honra o createdFrom — não basta a tool mandar", async () => {
    // ⚠️ Este teste nasceu de uma mutação SOBREVIVENTE: eu provava que a tool
    // passava `createdFrom` e nada provava que o `where` chegava ao banco.
    // Apagar a linha do repositório deixava a suíte verde, e o Bitz
    // responderia "3 clientes hoje" contando a base inteira.
    const { CustomerRepository } = await import(
      "../app/repositories/customer.repository"
    );
    clienteFindManyMock.mockResolvedValue([]);
    clienteCountMock.mockResolvedValue(0);

    const desde = new Date("2026-08-11T00:00:00.000Z");
    await new CustomerRepository().findAll({ createdFrom: desde } as any, "t1");

    const where = clienteFindManyMock.mock.calls[0][0].where;
    expect(where.userId).toBe("t1");
    expect(where.createdAt).toEqual({ gte: desde });
  });

  it("⭐ o documento continua MASCARADO no recorte por período", async () => {
    listarClientesMock.mockResolvedValue({
      customers: [
        { id: "c1", name: "João", personType: "PF", cpf: "52998224725" },
      ],
    });
    const r = await chamar("buscar_cliente", { cadastradosNosUltimosDias: 1 });
    expect(r.content).not.toContain("52998224725");
  });
});

describe("⭐ cadastrar_cliente: o documento ditado não some mais em silêncio", () => {
  it("a instrução MANDA o modelo dizer que o documento não entrou", async () => {
    const r = await chamar("cadastrar_cliente", { nome: "João da Silva" });
    // ⚠️ Sem esta frase, quem escreve "cadastra o João, CPF 123..." confirma o
    // cartão achando que o documento entrou, e descobre na emissão da nota.
    expect(r.content).toMatch(/DOCUMENTO NÃO FOI INCLUÍDO/i);
    expect(r.content).toMatch(/tela de Clientes/i);
  });
});

describe("⭐ cadastrar_cliente: duplicado por nome E por telefone", () => {
  it("nome igual com acento e caixa diferentes vira aviso", async () => {
    buscarClienteMock.mockResolvedValue([
      { id: "c1", name: "JOAO DA SILVA" },
    ]);
    await chamar("cadastrar_cliente", { nome: "João da Silva" });
    expect(ultimoPreview().aviso).toMatch(/mesmo nome/i);
  });

  it("⭐ telefone igual com NOME DIFERENTE também vira aviso", async () => {
    buscarClienteMock.mockResolvedValue([]);
    listarClientesMock.mockResolvedValue({
      customers: [{ id: "c9", name: "Oficina do Zé", phone: "11999999999" }],
    });

    await chamar("cadastrar_cliente", {
      nome: "João da Silva",
      telefone: "(11) 99999-9999",
    });
    expect(ultimoPreview().aviso).toMatch(/mesmo telefone/i);
  });

  it("o mesmo cliente achado pelas duas buscas conta UMA vez", async () => {
    const mesmo = { id: "c1", name: "João da Silva", phone: "11999999999" };
    buscarClienteMock.mockResolvedValue([mesmo]);
    listarClientesMock.mockResolvedValue({ customers: [mesmo] });

    await chamar("cadastrar_cliente", {
      nome: "João da Silva",
      telefone: "11999999999",
    });
    const aviso = ultimoPreview().aviso;
    expect(aviso).toMatch(/um cliente com este mesmo nome/i);
    expect(aviso).not.toMatch(/mesmo telefone/i);
  });

  it("telefone curto demais não dispara a segunda busca", async () => {
    await chamar("cadastrar_cliente", { nome: "João", telefone: "1199" });
    expect(listarClientesMock).not.toHaveBeenCalled();
  });

  it("⚠️ o aviso de duplicado NÃO engole o aviso de documento", async () => {
    buscarClienteMock.mockResolvedValue([{ id: "c1", name: "João da Silva" }]);
    await chamar("cadastrar_cliente", { nome: "João da Silva" });

    const aviso = ultimoPreview().aviso;
    // Com `??` o segundo sumia exatamente no cartão em que os dois importam.
    expect(aviso).toMatch(/mesmo nome/i);
    expect(aviso).toMatch(/CPF, CNPJ/i);
  });

  it("⚠️ busca que estoura não derruba a proposta", async () => {
    buscarClienteMock.mockRejectedValue(new Error("pool esgotado"));
    const r = await chamar("cadastrar_cliente", { nome: "João" });
    expect(r.acao?.tipo).toBe("cliente.criar");
  });
});
