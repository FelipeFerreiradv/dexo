import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// P2.3 — completar o bloco fiscal da sucata a partir da NF-e.
//
// ⭐⭐ A AFIRMAÇÃO QUE ESTE SPEC EXISTE PARA PROVAR: a transcrição do modelo é
// CONFERIDA, não confiada.
//
// A leitura do anexo (Fase 8) vira TEXTO no contexto, não um objeto que a tool
// possa referenciar — então os 44 dígitos da chave de acesso chegam aqui
// copiados por um LLM. Uma chave com um dígito trocado é PIOR que chave
// nenhuma: aponta para outra nota, ou para nada, e ninguém percebe.
//
// A defesa é o dígito verificador — módulo 11 sobre os 43 primeiros —, e o
// validador é `parseChave`, o MESMO que a emissão de NF-e usa. Não há um
// segundo algoritmo aqui para divergir do primeiro.
// ===========================================================================

vi.mock("../app/lib/prisma", () => ({
  default: { systemLog: { create: async () => ({}) } },
}));

const listarSucatasMock = vi.fn();
const atualizarSucataMock = vi.fn();
vi.mock("../app/usecases/scrap.usercase", () => ({
  ScrapUseCase: class {
    listScraps = (...a: any[]) => listarSucatasMock(...a);
    update = (...a: any[]) => atualizarSucataMock(...a);
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

const registry = buildRegistry(WRITE_TOOLS);

const escopo = () =>
  ({
    dataOwnerId: "t1",
    actorId: "u1",
    can: () => true,
    canAction: () => true,
  }) as any;

const chamar = (args: any) =>
  runTool(
    { id: "c1", name: "completar_fiscal_da_sucata", args } as any,
    { registry, scope: escopo(), conversationId: "conv1" },
  );

const LOTE = {
  id: "s9",
  brand: "Volkswagen",
  model: "Gol",
  year: "2015",
  plate: "ABC1D23",
};

// ⭐ Chave REAL, com DV que fecha. Conferida contra `calcularDV` antes de
// entrar aqui — uma chave inventada tornaria o teste do caminho feliz inútil.
const CHAVE_BOA = "31260751195502000156650040000000021521124598";
/** A mesma chave com UM dígito trocado no meio — o erro típico de cópia. */
const CHAVE_TORTA = "31260751195502000156650040000000021521124588";

const ultimoPayload = () => proporMock.mock.calls.at(-1)?.[0]?.payload;
const ultimoPreview = () => proporMock.mock.calls.at(-1)?.[0]?.preview;

beforeEach(() => {
  listarSucatasMock.mockReset().mockResolvedValue({ scraps: [LOTE], total: 1 });
  atualizarSucataMock.mockReset();
  proporMock.mockReset().mockImplementation(async (input: any) => ({
    id: "acao-fiscal",
    tipo: input.tipo,
    preview: input.preview,
    expiraEm: "2026-08-13T12:30:00.000Z",
  }));
});

// ---------------------------------------------------------------------------

describe("⭐⭐ o dígito verificador pega a transcrição errada", () => {
  it("chave com DV correto passa", async () => {
    const r = await chamar({ sucata: "ABC1D23", chaveDeAcesso: CHAVE_BOA });
    expect(r.acao?.tipo).toBe("sucata.fiscal");
    expect(ultimoPayload().fiscal.accessKey).toBe(CHAVE_BOA);
  });

  it("⭐⭐ UM dígito trocado é RECUSADO — e o cadastro não acontece", async () => {
    const r = await chamar({ sucata: "ABC1D23", chaveDeAcesso: CHAVE_TORTA });

    expect(proporMock).not.toHaveBeenCalled();
    expect(r.content).toMatch(/dígito verificador/i);
    // E o modelo é PROIBIDO de "corrigir" chutando outro dígito.
    expect(r.content).toMatch(/NÃO tente adivinhar/i);
  });

  it("chave curta é recusada com a contagem, para o modelo saber o que houve", async () => {
    const r = await chamar({ sucata: "ABC1D23", chaveDeAcesso: "312607511955" });
    expect(proporMock).not.toHaveBeenCalled();
    expect(r.content).toContain("12");
    expect(r.content).toMatch(/44/);
    expect(r.content).toMatch(/não complete com zeros/i);
  });

  it("aceita a chave com pontuação — o que vale são os dígitos", async () => {
    await chamar({
      sucata: "ABC1D23",
      chaveDeAcesso: `${CHAVE_BOA.slice(0, 4)} ${CHAVE_BOA.slice(4)}`,
    });
    expect(ultimoPayload().fiscal.accessKey).toBe(CHAVE_BOA);
  });
});

describe("⭐ o CNPJ do fornecedor também é conferido", () => {
  it("CNPJ inválido é recusado", async () => {
    const r = await chamar({
      sucata: "ABC1D23",
      cnpjDoFornecedor: "11222333000100",
    });
    expect(proporMock).not.toHaveBeenCalled();
    expect(r.content).toMatch(/CNPJ/);
    expect(r.content).toMatch(/NÃO invente/i);
  });

  it("CNPJ válido entra só com os dígitos", async () => {
    await chamar({
      sucata: "ABC1D23",
      cnpjDoFornecedor: "11.222.333/0001-81",
    });
    expect(ultimoPayload().fiscal.supplierCnpj).toBe("11222333000181");
  });
});

describe("⭐ o cartão assume que os valores foram COPIADOS", () => {
  it("manda conferir campo a campo e diz o que a máquina NÃO conferiu", async () => {
    await chamar({
      sucata: "ABC1D23",
      chaveDeAcesso: CHAVE_BOA,
      numeroDaNota: "12345",
      valorDoIcms: 1234.5,
    });

    const aviso = ultimoPreview().aviso;
    expect(aviso).toMatch(/CAMPO A CAMPO/i);
    // ⭐ A honestidade que importa: dizer QUAIS campos não têm conferência.
    expect(aviso).toMatch(/não têm como ser conferidos/i);
    // E que isto não mexe em nota nenhuma.
    expect(aviso).toMatch(/não emite nem altera nota/i);
  });

  it("dinheiro aparece formatado, para vírgula fora de lugar saltar aos olhos", async () => {
    await chamar({ sucata: "ABC1D23", valorDoIcms: 1234.5 });
    const icms = ultimoPreview().campos.find((c: any) => c.campo === "ICMS");
    expect(icms.para).toMatch(/1\.234,50/);
  });

  it("data aparece no formato do lojista", async () => {
    await chamar({ sucata: "ABC1D23", dataDeEmissao: "2026-08-13" });
    const d = ultimoPreview().campos.find((c: any) => c.campo === "Emissão");
    expect(d.para).toBe("13/08/2026");
  });

  it("data em formato errado é recusada antes de virar lixo no banco", async () => {
    const r = await chamar({ sucata: "ABC1D23", dataDeEmissao: "13/08/2026" });
    expect(proporMock).not.toHaveBeenCalled();
    expect(r.content).toMatch(/AAAA-MM-DD/);
  });

  it("só os campos informados vão para o cartão e para o payload", async () => {
    await chamar({ sucata: "ABC1D23", numeroDaNota: "12345" });
    expect(ultimoPreview().campos).toHaveLength(1);
    expect(Object.keys(ultimoPayload().fiscal)).toEqual(["nfeNumber"]);
  });
});

describe("⭐ a tool NÃO escreve", () => {
  it("propõe sem chamar ScrapUseCase.update", async () => {
    await chamar({ sucata: "ABC1D23", chaveDeAcesso: CHAVE_BOA });
    expect(atualizarSucataMock).not.toHaveBeenCalled();
  });
});

describe("⭐ respostas de negócio", () => {
  it("sem dado nenhum de nota, não propõe", async () => {
    const r = await chamar({ sucata: "ABC1D23" });
    expect(proporMock).not.toHaveBeenCalled();
    expect(r.content).toMatch(/anexar o XML|ditar os dados/i);
  });

  it("sucata não encontrada pergunta, não escolhe", async () => {
    listarSucatasMock.mockResolvedValue({ scraps: [], total: 0 });
    const r = await chamar({ sucata: "Fusca", numeroDaNota: "1" });
    expect(proporMock).not.toHaveBeenCalled();
    expect(r.content).toMatch(/NÃO escolha uma sucata/i);
  });

  it("⭐ ambiguidade vira BOTÕES, como no vínculo", async () => {
    listarSucatasMock.mockResolvedValue({
      scraps: [LOTE, { ...LOTE, id: "s10", plate: "XYZ9K88" }],
      total: 2,
    });

    const r = await chamar({ sucata: "Gol", numeroDaNota: "1" });
    expect(proporMock).not.toHaveBeenCalled();
    expect(r.opcoes).toHaveLength(2);
  });

  it("⚠️ busca que estoura não vira falha de sistema", async () => {
    listarSucatasMock.mockRejectedValue(new Error("pool esgotado"));
    const r = await chamar({ sucata: "ABC1D23", numeroDaNota: "1" });
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/tentar de novo/i);
  });

  it("a busca é escopada pelo tenant do scope", async () => {
    await chamar({ sucata: "ABC1D23", numeroDaNota: "1" });
    expect(listarSucatasMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "t1" }),
    );
  });
});
