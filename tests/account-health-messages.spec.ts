import { describe, expect, it } from "vitest";
import {
  dispensaCobre,
  ehDaPaginaAtual,
  formatarDiaEHora,
  mensagemDaConta,
  resumoDasOcultas,
  type AccountHealthProblem,
} from "@/app/lib/account-health-messages";

/**
 * Textos que o lojista LÊ no aviso de conta com problema — aprovados pelo dono
 * do produto em 17/09/2026. Mudar frase aqui é decisão de produto, não refactor.
 */

const parada: AccountHealthProblem = {
  id: "acc-1",
  platform: "MERCADO_LIVRE",
  accountName: "REBOOTEC",
  tipo: "parada",
  // 02/09 10:03 em São Paulo = 13:03Z
  ultimoPedidoEm: "2026-09-02T13:03:00.000Z",
  anunciosAVenda: 506,
  semBaixa: true,
};

const desconectada: AccountHealthProblem = {
  id: "acc-2",
  platform: "MERCADO_LIVRE",
  accountName: "MAGOO-PECAS",
  tipo: "desconectada",
  ultimoPedidoEm: "2026-09-02T12:50:00.000Z",
  anunciosAVenda: 2096,
  semBaixa: true,
};

describe("conta parada", () => {
  it("administrador: texto aprovado + botão para a integração", () => {
    const m = mensagemDaConta(parada, { colaborador: false });
    expect(m.titulo).toBe("Mercado Livre · REBOOTEC parou de receber pedidos.");
    expect(m.detalhe).toBe(
      "Último pedido importado em 02/09 às 10:03. 506 anúncios seguem à venda sem baixa automática de estoque.",
    );
    expect(m.acao).toEqual({
      tipo: "link",
      rotulo: "Reconectar conta",
      href: "/integracoes/mercado-livre",
    });
  });

  it("token ainda válido: NÃO afirma 'sem baixa automática' (a quantidade ainda é enviada)", () => {
    const m = mensagemDaConta({ ...parada, semBaixa: false }, { colaborador: false });
    expect(m.titulo).toBe("Mercado Livre · REBOOTEC parou de receber pedidos.");
    expect(m.detalhe).toBe("Último pedido importado em 02/09 às 10:03.");
  });

  it("resposta sem o campo semBaixa (API anterior) mantém a frase", () => {
    const { semBaixa: _omitido, ...semCampo } = parada;
    expect(mensagemDaConta(semCampo, { colaborador: false }).detalhe).toContain(
      "sem baixa automática de estoque",
    );
  });

  it("colaborador: no lugar do botão, orientação", () => {
    const m = mensagemDaConta(parada, { colaborador: true });
    expect(m.acao).toEqual({
      tipo: "texto",
      texto: "Peça ao administrador da conta para reconectar.",
    });
  });

  it("na própria página da integração não há link", () => {
    const m = mensagemDaConta(parada, {
      colaborador: false,
      naPaginaDaIntegracao: true,
    });
    expect(m.acao).toEqual({
      tipo: "texto",
      texto: "Reconecte pelo botão de conexão desta página.",
    });
  });

  it("singular, sem pedido importado e sem anúncio", () => {
    expect(
      mensagemDaConta({ ...parada, anunciosAVenda: 1, ultimoPedidoEm: null }, { colaborador: false })
        .detalhe,
    ).toBe("1 anúncio segue à venda sem baixa automática de estoque.");
    expect(
      mensagemDaConta({ ...parada, anunciosAVenda: 0, ultimoPedidoEm: null }, { colaborador: false })
        .detalhe,
    ).toBeNull();
  });

  it("conta sem nome e plataforma Shopee", () => {
    const m = mensagemDaConta(
      { ...parada, platform: "SHOPEE", accountName: "  " },
      { colaborador: false },
    );
    expect(m.titulo).toBe("Shopee · sem nome parou de receber pedidos.");
    expect((m.acao as any).href).toBe("/integracoes/shopee");
  });
});

describe("conta desconectada com anúncio à venda", () => {
  it("texto aprovado, com milhar em pt-BR", () => {
    const m = mensagemDaConta(desconectada, { colaborador: false });
    expect(m.titulo).toBe(
      "Mercado Livre · MAGOO-PECAS está desconectada, mas 2.096 anúncios continuam à venda sem baixa automática de estoque.",
    );
    expect(m.detalhe).toBe(
      "Reconecte a conta ou pause os anúncios no Mercado Livre.",
    );
  });

  it("singular", () => {
    expect(
      mensagemDaConta({ ...desconectada, anunciosAVenda: 1 }, { colaborador: false }).titulo,
    ).toBe(
      "Mercado Livre · MAGOO-PECAS está desconectada, mas 1 anúncio continua à venda sem baixa automática de estoque.",
    );
  });
});

describe("faixa do topo: formatação, dispensa e resumo", () => {
  it("dia e hora no fuso de São Paulo", () => {
    expect(formatarDiaEHora("2026-09-17T02:30:00.000Z")).toBe("16/09 às 23:30");
    expect(formatarDiaEHora("lixo")).toBe("");
  });

  it("dispensar vale até haver MAIS anúncios à venda do que na hora da dispensa", () => {
    expect(dispensaCobre("2096", 2096)).toBe(true);
    expect(dispensaCobre("2096", 1500)).toBe(true);
    expect(dispensaCobre("2096", 2097)).toBe(false);
    expect(dispensaCobre(null, 10)).toBe(false);
    expect(dispensaCobre("", 10)).toBe(false);
    expect(dispensaCobre("lixo", 10)).toBe(false);
  });

  it("na página de uma integração só as contas DELA saem da faixa", () => {
    expect(ehDaPaginaAtual("MERCADO_LIVRE", "/integracoes/mercado-livre")).toBe(true);
    expect(ehDaPaginaAtual("MERCADO_LIVRE", "/integracoes/mercado-livre/anuncios")).toBe(true);
    expect(ehDaPaginaAtual("SHOPEE", "/integracoes/mercado-livre")).toBe(false);
    expect(ehDaPaginaAtual("MERCADO_LIVRE", "/pedidos")).toBe(false);
    expect(ehDaPaginaAtual("MERCADO_LIVRE", null)).toBe(false);
  });

  it("resumo das desconectadas que não couberam", () => {
    expect(resumoDasOcultas(1)).toBe("E mais 1 conta desconectada com anúncio à venda.");
    expect(resumoDasOcultas(4)).toBe("E mais 4 contas desconectadas com anúncio à venda.");
  });
});
