import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// P2.1 — pausar e reativar anúncio pelo Bitz.
//
// ⭐⭐ A AFIRMAÇÃO CENTRAL, e ela vale mais que todas as outras deste arquivo:
// **o Bitz nunca pausa na OLX**. Lá `updateListingStatus` chama
// `OlxApiService.deleteAd` e o anúncio é DESTRUÍDO — republicar cria outro, com
// endereço novo e sem as visualizações. A regra do dono é que o Bitz não apaga
// nada, e a ferramenta pausa nos outros quatro canais deixando a OLX para a
// tela.
//
// A segunda: nada é executado pela tool. `pauseListings` só roda no clique.
// ===========================================================================

vi.mock("../app/lib/prisma", () => ({
  default: { systemLog: { create: async () => ({}) } },
}));

const listarProdutosMock = vi.fn();
const pausarAnunciosMock = vi.fn();
vi.mock("../app/usecases/product.usercase", () => ({
  ProductUseCase: class {
    listProducts = (...a: any[]) => listarProdutosMock(...a);
    pauseListings = (...a: any[]) => pausarAnunciosMock(...a);
  },
}));

const proporMock = vi.fn();
vi.mock("../app/ai/acoes/acao.service", async (orig) => {
  const real = (await orig()) as any;
  return { ...real, proporAcao: (...a: any[]) => proporMock(...a) };
});

import { executarAcao } from "../app/ai/acoes/executores";
import { runTool } from "../app/ai/agent/tool-runner";
import { buildRegistry } from "../app/ai/tools/registry";
import { WRITE_TOOLS } from "../app/ai/tools/write";

const registry = buildRegistry(WRITE_TOOLS);

const escopo = (over?: { can?: boolean; canAction?: boolean }) =>
  ({
    dataOwnerId: "t1",
    actorId: "u1",
    can: () => over?.can ?? true,
    canAction: () => over?.canAction ?? true,
  }) as any;

const chamar = (args: any, scope = escopo()) =>
  runTool(
    { id: "c1", name: "pausar_ou_reativar_anuncio", args } as any,
    { registry, scope, conversationId: "conv1" },
  );

const anuncio = (platform: string, id = `EXT-${platform}`) => ({
  externalListingId: id,
  platform,
  status: "active",
});

const peca = (listings: any[]) => ({
  id: "p1",
  sku: "4821",
  name: "Cubo de roda dianteiro",
  listings,
});

const ultimoPayload = () => proporMock.mock.calls.at(-1)?.[0]?.payload;
const ultimoPreview = () => proporMock.mock.calls.at(-1)?.[0]?.preview;

beforeEach(() => {
  listarProdutosMock.mockReset();
  pausarAnunciosMock.mockReset().mockResolvedValue({ success: true });
  proporMock.mockReset().mockImplementation(async (input: any) => ({
    id: "acao-anuncio",
    tipo: input.tipo,
    preview: input.preview,
    expiraEm: "2026-08-13T12:30:00.000Z",
  }));
});

// ---------------------------------------------------------------------------

describe("⭐⭐ a OLX nunca é pausada pelo Bitz", () => {
  it("peça no ML e na OLX: só o ML entra na proposta", async () => {
    listarProdutosMock.mockResolvedValue({
      products: [peca([anuncio("MERCADO_LIVRE"), anuncio("OLX")])],
    });

    await chamar({ sku: "4821", situacao: "pausado" });

    const canais = ultimoPreview().campos.find(
      (c: any) => c.campo === "Canais afetados",
    ).para;
    expect(canais).toContain("Mercado Livre");
    expect(canais).not.toContain("OLX");
    // E o payload manda o executor pular a OLX.
    expect(ultimoPayload().pularOlx).toBe(true);
  });

  it("⭐ o cartão EXPLICA por que a OLX ficou de fora", async () => {
    listarProdutosMock.mockResolvedValue({
      products: [peca([anuncio("MERCADO_LIVRE"), anuncio("OLX")])],
    });
    await chamar({ sku: "4821", situacao: "pausado" });

    const aviso = ultimoPreview().aviso;
    expect(aviso).toMatch(/OLX/);
    expect(aviso).toMatch(/excluir/i);
    expect(aviso).toMatch(/anúncio novo|visualizações/i);
  });

  it("⭐⭐ peça SÓ na OLX: recusa e não propõe nada", async () => {
    listarProdutosMock.mockResolvedValue({
      products: [peca([anuncio("OLX")])],
    });

    const r = await chamar({ sku: "4821", situacao: "pausado" });

    expect(proporMock).not.toHaveBeenCalled();
    expect(r.acao).toBeUndefined();
    expect(r.content).toMatch(/EXCLUIR/);
    // E manda o modelo NÃO inventar um contorno.
    expect(r.content).toMatch(/NÃO ofereça outro caminho/i);
  });

  it("REATIVAR na OLX é permitido — recriar não é destruir", async () => {
    listarProdutosMock.mockResolvedValue({
      products: [peca([anuncio("OLX")])],
    });

    await chamar({ sku: "4821", situacao: "ativo" });

    expect(proporMock).toHaveBeenCalledTimes(1);
    expect(ultimoPayload().pularOlx).toBe(false);
    // Mas o cartão conta a consequência: volta para a fila de revisão.
    expect(ultimoPreview().aviso).toMatch(/RECRIA|fila de revisão/i);
  });

  it("sem OLX na peça, nenhum aviso de OLX — ruído ensina a ignorar aviso", async () => {
    listarProdutosMock.mockResolvedValue({
      products: [peca([anuncio("MERCADO_LIVRE"), anuncio("SHOPEE")])],
    });
    await chamar({ sku: "4821", situacao: "pausado" });
    expect(ultimoPreview().aviso).not.toMatch(/OLX/);
  });
});

describe("⭐ a tool NÃO executa", () => {
  it("propõe sem chamar pauseListings", async () => {
    listarProdutosMock.mockResolvedValue({
      products: [peca([anuncio("MERCADO_LIVRE")])],
    });

    const r = await chamar({ sku: "4821", situacao: "pausado" });
    expect(pausarAnunciosMock).not.toHaveBeenCalled();
    expect(r.acao?.tipo).toBe("anuncio.situacao");
  });
});

describe("⭐ respostas de negócio, não falhas de sistema", () => {
  it("SKU inexistente devolve o SKU e proíbe inventar", async () => {
    listarProdutosMock.mockResolvedValue({ products: [] });
    const r = await chamar({ sku: "9999", situacao: "pausado" });

    expect(r.ok).toBe(true);
    expect(proporMock).not.toHaveBeenCalled();
    expect(r.content).toContain("9999");
  });

  it("peça sem anúncio nenhum explica que não há o que pausar", async () => {
    listarProdutosMock.mockResolvedValue({ products: [peca([])] });
    const r = await chamar({ sku: "4821", situacao: "pausado" });

    expect(proporMock).not.toHaveBeenCalled();
    expect(r.content).toMatch(/não tem anúncio publicado/i);
  });

  it("⚠️ anúncio ainda em publicação (PENDING_) não conta como publicado", async () => {
    listarProdutosMock.mockResolvedValue({
      products: [peca([anuncio("MERCADO_LIVRE", "PENDING_abc")])],
    });
    const r = await chamar({ sku: "4821", situacao: "pausado" });

    // Ele nem existe no canal ainda; pausar não faz sentido.
    expect(proporMock).not.toHaveBeenCalled();
    expect(r.content).toMatch(/não tem anúncio publicado/i);
  });
});

describe("⭐ o cartão conta a consequência antes do clique", () => {
  it("diz que vale AGORA e que não há clique para desfazer", async () => {
    listarProdutosMock.mockResolvedValue({
      products: [peca([anuncio("MERCADO_LIVRE")])],
    });
    await chamar({ sku: "4821", situacao: "pausado" });

    const aviso = ultimoPreview().aviso;
    expect(aviso).toMatch(/AGORA/);
    expect(aviso).toMatch(/desfazer/i);
  });

  it("mostra de → para", async () => {
    listarProdutosMock.mockResolvedValue({
      products: [peca([anuncio("SHOPEE")])],
    });
    await chamar({ sku: "4821", situacao: "pausado" });

    const situacao = ultimoPreview().campos[0];
    expect(situacao.de).toBe("no ar");
    expect(situacao.para).toBe("fora do ar");
  });
});

describe("⭐ permissão: página E ação", () => {
  it("sem a chave da ação, recusa antes de qualquer I/O", async () => {
    const r = await chamar(
      { sku: "4821", situacao: "pausado" },
      escopo({ canAction: false }),
    );
    expect(r.ok).toBe(false);
    expect(listarProdutosMock).not.toHaveBeenCalled();
  });
});

describe("⭐⭐ o EXECUTOR respeita a exclusão do payload", () => {
  it("pausar com pularOlx manda a OLX na lista de exclusão", async () => {
    await executarAcao(
      "anuncio.situacao",
      { produtoId: "p1", situacao: "paused", pularOlx: true },
      escopo(),
    );

    expect(pausarAnunciosMock).toHaveBeenCalledWith("p1", "t1", "paused", {
      pularPlataformas: ["OLX"],
    });
  });

  it("reativar NÃO exclui canal nenhum", async () => {
    await executarAcao(
      "anuncio.situacao",
      { produtoId: "p1", situacao: "active", pularOlx: false },
      escopo(),
    );

    expect(pausarAnunciosMock).toHaveBeenCalledWith(
      "p1",
      "t1",
      "active",
      undefined,
    );
  });

  it("⚠️ a exclusão vem do PAYLOAD, não do estado de agora", async () => {
    // Entre propor e confirmar passa até meia hora. Se o executor recalculasse
    // a exclusão, uma publicação nova na OLX nesse intervalo faria o clique
    // executar algo que o lojista não leu no cartão.
    await executarAcao(
      "anuncio.situacao",
      { produtoId: "p1", situacao: "paused", pularOlx: true },
      escopo(),
    );
    // Nenhuma releitura do produto antes de agir.
    expect(listarProdutosMock).not.toHaveBeenCalled();
  });

  it("o tenant vem do escopo, nunca do payload", async () => {
    await executarAcao(
      "anuncio.situacao",
      { produtoId: "p1", situacao: "paused", pularOlx: true, userId: "outro" },
      escopo(),
    );
    expect(pausarAnunciosMock.mock.calls[0][1]).toBe("t1");
  });
});
