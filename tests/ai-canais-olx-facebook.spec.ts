import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

// ===========================================================================
// A COBERTURA DO BITZ PARA OLX E FACEBOOK.
//
// O que estes testes olham, e que "o resultado está certo" não olharia:
//
//  1. Que o canal existe em TODA tool que aceita canal — o defeito que este
//     arquivo previne é o silencioso: um canal entra em `CANAIS`, três tools
//     continuam com a lista literal antiga, e o modelo simplesmente nunca
//     consegue pedir OLX. Nada quebra, nada loga, ninguém descobre.
//
//  2. Que o número que o Bitz DIZ é o número que o publicador USA. Não basta
//     a regra citar "90 caracteres": ela tem de citar a constante, e a
//     constante tem de ser a que o builder aplica. Por isso o teste do preço
//     da OLX não confere um texto — ele PUBLICA R$ 180,50 pelo builder real e
//     confere que saiu 181.
//
//  3. Que o que NÃO existe continua não existindo. OLX e Facebook não geram
//     pedido; um filtro que os aceitasse devolveria "0 pedidos", e zero é a
//     pior resposta possível porque parece certa.
// ===========================================================================

const H = vi.hoisted(() => ({
  chamadas: [] as string[],
  produtos: [] as any[],
}));

vi.mock("../app/usecases/product.usercase", () => ({
  ProductUseCase: class {
    async listProducts() {
      H.chamadas.push("catalogoProprio");
      return {
        products: H.produtos,
        total: H.produtos.length,
        totalPages: 1,
      };
    }
  },
}));

vi.mock("../app/marketplaces/usecases/internal-suggestion.usecase", () => ({
  InternalSuggestionUseCase: {
    suggestFromTitle: async () => {
      H.chamadas.push("baseConsolidada");
      return { suggestion: null, reason: "insufficient_sample" };
    },
  },
}));

vi.mock("../app/marketplaces/services/category-suggestion.service", () => ({
  CategorySuggestionService: {
    suggestFromProduct: async () => {
      H.chamadas.push("motorDeCategorias");
      return { normalizedTitle: "", tokens: [], suggestions: [] };
    },
  },
}));

vi.mock("../app/marketplaces/services/ml-api.service", () => ({
  MLApiService: {
    suggestCategoryId: async () => {
      H.chamadas.push("classificadorDoML");
      return null;
    },
  },
}));

vi.mock("../app/lib/prisma", () => ({
  default: {
    systemLog: { create: async () => ({}) },
    user: { findUnique: async () => null },
    marketplaceCategory: { findUnique: async () => null },
    productCompatibility: { findMany: async () => [] },
  },
}));

// A tool de escrita não escreve — ela PROPÕE. O que interessa aqui é o
// `preview` que ela monta, que é literalmente o que o lojista lê antes de
// clicar em Confirmar.
const proporMock = vi.fn(async (args: any) => ({ id: "acao-1", ...args }));
vi.mock("../app/ai/acoes/acao.service", async (orig) => {
  const real = (await orig()) as any;
  return { ...real, proporAcao: (...a: any[]) => (proporMock as any)(...a) };
});

import { scopeFromRequest } from "../app/ai/core/scope";
import {
  CANAIS,
  NOME_DO_CANAL,
  regrasDeDescricao,
  regrasDePreco,
  regrasDeTitulo,
  type Canal,
} from "../app/ai/advisory/channel-rules";
import { KNOWLEDGE_DOCS } from "../app/ai/knowledge/docs";
import { sugerirCategoria } from "../app/ai/tools/advisory/categoria";
import { sugerirDescricao } from "../app/ai/tools/advisory/descricao";
import { sugerirPreco } from "../app/ai/tools/advisory/preco";
import { sugerirTitulo } from "../app/ai/tools/advisory/titulo";
import { buscarPedido } from "../app/ai/tools/read/pedidos";
import { buscarProduto } from "../app/ai/tools/read/produtos";
import { ajustarEstoqueDoProduto } from "../app/ai/tools/write/produtos";
import { PAGE_DEFS } from "../app/lib/page-access";
import { FACEBOOK_CONSTANTS } from "../app/marketplaces/facebook/facebook-constants";
import { OLX_AUTOPARTS_CATEGORY } from "../app/marketplaces/olx/olx-category-map";
import { OLX_CONSTANTS } from "../app/marketplaces/olx/olx-constants";
import { FacebookCategoryResolutionService } from "../app/marketplaces/services/facebook-category-resolution.service";
import { OlxCategoryResolutionService } from "../app/marketplaces/services/olx-category-resolution.service";
import { OlxPayloadBuilderService } from "../app/marketplaces/services/olx-payload-builder.service";

const scope = scopeFromRequest({
  user: { id: "a", dataOwnerId: "TENANT-A", parentUserId: null },
} as any)!;

const CONTENT_DIR = join(__dirname, "..", "app", "ai", "knowledge", "content");
const PAGE_IDS = new Set(PAGE_DEFS.map((p) => p.id));

/** As tools que recebem canal e por isso precisam aceitar os cinco. */
const TOOLS_COM_CANAL = [
  { nome: "sugerir_titulo", tool: sugerirTitulo, extra: { descricao: "farol" } },
  {
    nome: "sugerir_descricao",
    tool: sugerirDescricao,
    extra: { descricao: "farol" },
  },
  {
    nome: "sugerir_categoria",
    tool: sugerirCategoria,
    extra: { titulo: "farol palio" },
  },
  { nome: "sugerir_preco", tool: sugerirPreco, extra: { titulo: "farol" } },
];

const NOVOS: Canal[] = ["olx", "facebook"];

describe("⭐ o Bitz reconhece os cinco canais", () => {
  it("CANAIS tem OLX e Facebook, e cada um tem nome legível", () => {
    for (const canal of NOVOS) {
      expect(CANAIS).toContain(canal);
      expect(NOME_DO_CANAL[canal].length).toBeGreaterThan(2);
    }
    expect(CANAIS).toHaveLength(5);
  });

  // ⭐ A trava do defeito silencioso. Se alguém acrescentar um canal em CANAIS
  // e esquecer de trocar um `z.enum` literal numa tool, é AQUI que aparece —
  // não em produção, com o modelo dizendo "não conheço esse canal".
  it.each(TOOLS_COM_CANAL)(
    "$nome aceita todo canal de CANAIS no schema",
    ({ tool, extra }) => {
      for (const canal of CANAIS) {
        const r = tool.args.safeParse({ ...extra, canal });
        expect(r.success, `${tool.name} recusou "${canal}"`).toBe(true);
      }
    },
  );

  it("nenhuma tool aceita canal inventado", () => {
    for (const { tool, extra } of TOOLS_COM_CANAL) {
      expect(tool.args.safeParse({ ...extra, canal: "amazon" }).success).toBe(
        false,
      );
    }
  });

  it.each(NOVOS)("%s tem regra de título e de descrição com conteúdo", (c) => {
    expect(regrasDeTitulo(c).length).toBeGreaterThan(0);
    expect(regrasDeDescricao(c).length).toBeGreaterThan(0);
    for (const r of [...regrasDeTitulo(c), ...regrasDeDescricao(c)]) {
      expect(r.rule.length).toBeGreaterThan(10);
      expect(r.detalhe.length).toBeGreaterThan(30);
    }
  });
});

describe("⭐ os números batem com o publicador real", () => {
  it("o teto de título da OLX é o da constante que o builder aplica", () => {
    const texto = regrasDeTitulo("olx")
      .map((r) => `${r.rule} ${r.detalhe}`)
      .join(" ");
    expect(texto).toContain(String(OLX_CONSTANTS.TITLE_MAX_LENGTH));

    // E a constante é mesmo o corte: 200 caracteres viram 90.
    const ad = OlxPayloadBuilderService.build(
      { name: "x".repeat(200), sku: "F1", price: 10 },
      { categoryId: 2101, phone: "21999999999", zipcode: "20000000" },
    );
    expect(ad.Subject).toHaveLength(OLX_CONSTANTS.TITLE_MAX_LENGTH);
  });

  it("o teto de descrição da OLX é o da constante", () => {
    const texto = regrasDeDescricao("olx")
      .map((r) => `${r.rule} ${r.detalhe}`)
      .join(" ");
    expect(texto).toContain(String(OLX_CONSTANTS.DESCRIPTION_MAX_LENGTH));
  });

  it("os tetos do Facebook são os das constantes", () => {
    expect(
      regrasDeTitulo("facebook")
        .map((r) => r.detalhe)
        .join(" "),
    ).toContain(String(FACEBOOK_CONSTANTS.TITLE_MAX_LENGTH));
    expect(
      regrasDeDescricao("facebook")
        .map((r) => r.detalhe)
        .join(" "),
    ).toContain(String(FACEBOOK_CONSTANTS.DESCRIPTION_MAX_LENGTH));
  });

  // ⭐ O teste que não confere texto: confere o COMPORTAMENTO que o texto
  // descreve. Se um dia a OLX passar a aceitar centavos e alguém tirar o
  // arredondamento do builder, este teste cai e a regra vira mentira detectada.
  it("a OLX arredonda o preço — e a regra diz exatamente isso", () => {
    const meio = OlxPayloadBuilderService.build(
      { name: "Farol", sku: "F1", price: 180.5 },
      { categoryId: 2101, phone: "21999999999", zipcode: "20000000" },
    );
    const baixo = OlxPayloadBuilderService.build(
      { name: "Farol", sku: "F1", price: 180.49 },
      { categoryId: 2101, phone: "21999999999", zipcode: "20000000" },
    );
    expect(meio.price).toBe(181);
    expect(baixo.price).toBe(180);

    const regra = regrasDePreco("olx");
    expect(regra).toHaveLength(1);
    expect(regra[0].detalhe).toContain("181");
    expect(regra[0].detalhe).toContain("180");
  });

  it("os outros quatro canais não inventam regra de preço", () => {
    for (const canal of CANAIS.filter((c) => c !== "olx")) {
      expect(regrasDePreco(canal), canal).toHaveLength(0);
    }
  });

  it("peça sem descrição publica o nome — e a regra avisa", () => {
    const ad = OlxPayloadBuilderService.build(
      { name: "Farol Dianteiro Palio", sku: "F1", price: 10 },
      { categoryId: 2101, phone: "21999999999", zipcode: "20000000" },
    );
    expect(ad.Body).toBe("Farol Dianteiro Palio");
    expect(
      regrasDeDescricao("olx")
        .map((r) => r.rule)
        .join(" "),
    ).toMatch(/NOME/);
  });
});

describe("⭐ categoria: a mesma função da tela", () => {
  it("OLX devolve o id que o resolvedor real devolve", async () => {
    for (const nome of [
      "Retrovisor Moto Honda",
      "Suporte do Motor Gol",
      "Farol Palio",
      "Lanterna de caminhao",
    ]) {
      const esperado = OlxCategoryResolutionService.resolveCategoryId({
        name: nome,
      });
      const r: any = await sugerirCategoria.handler(
        { titulo: nome, canal: "olx" },
        scope,
      );
      expect(r.categoria.id, nome).toBe(String(esperado));
      expect(r.temSugestao).toBe(true);
    }
  });

  it('"motor" não é "moto" — e a resposta do Bitz respeita isso', async () => {
    const moto: any = await sugerirCategoria.handler(
      { titulo: "Retrovisor Moto Honda", canal: "olx" },
      scope,
    );
    const motor: any = await sugerirCategoria.handler(
      { titulo: "Suporte do Motor Gol", canal: "olx" },
      scope,
    );
    expect(moto.categoria.id).toBe(String(OLX_AUTOPARTS_CATEGORY.MOTORCYCLES));
    expect(motor.categoria.id).toBe(String(OLX_AUTOPARTS_CATEGORY.CARS));
  });

  it("Facebook devolve a taxonomia que o resolvedor real devolve", async () => {
    for (const nome of ["Retrovisor Moto Honda", "Farol Palio", "Helice lancha"]) {
      const esperado = FacebookCategoryResolutionService.resolveCategory({
        name: nome,
      });
      const r: any = await sugerirCategoria.handler(
        { titulo: nome, canal: "facebook" },
        scope,
      );
      expect(r.categoria.caminho, nome).toBe(esperado);
    }
  });

  // Pina o rótulo legível contra os códigos reais: entrou código novo em
  // OLX_AUTOPARTS_CATEGORY sem nome, este teste cai antes de o lojista receber
  // "categoria 2106" sem tradução.
  it("todo código de categoria da OLX tem nome legível", async () => {
    const nomes = new Map<number, string>();
    for (const id of Object.values(OLX_AUTOPARTS_CATEGORY)) {
      const r: any = await sugerirCategoria.handler(
        { titulo: "peca generica", canal: "olx" },
        scope,
      );
      // O handler só devolve o rótulo do id resolvido; a cobertura de TODOS os
      // códigos é conferida pelo mapa, lido do próprio módulo.
      expect(r.categoria.caminho).toBeTruthy();
      nomes.set(id, r.categoria.caminho);
    }
    const modulo = readFileSync(
      join(__dirname, "..", "app", "ai", "tools", "advisory", "categoria.ts"),
      "utf8",
    );
    for (const chave of Object.keys(OLX_AUTOPARTS_CATEGORY)) {
      expect(modulo, `${chave} sem rótulo`).toContain(
        `OLX_AUTOPARTS_CATEGORY.${chave}`,
      );
    }
  });

  // ⭐ Nem banco, nem classificador do ML, nem base consolidada. A resolução é
  // função pura do nome — cobrar rede por ela seria pagar por nada.
  it("OLX e Facebook não gastam nenhuma fonte da cadeia", async () => {
    H.chamadas.length = 0;
    await sugerirCategoria.handler({ titulo: "farol", canal: "olx" }, scope);
    await sugerirCategoria.handler(
      { titulo: "farol", canal: "facebook" },
      scope,
    );
    expect(H.chamadas).toEqual([]);
  });

  it("explica o modelo do canal, não só devolve um código", async () => {
    const olx: any = await sugerirCategoria.handler(
      { titulo: "farol", canal: "olx" },
      scope,
    );
    expect(olx.explicacao).toMatch(/TIPO DE VE[ÍI]CULO/i);
    const fb: any = await sugerirCategoria.handler(
      { titulo: "farol", canal: "facebook" },
      scope,
    );
    expect(fb.explicacao).toMatch(/google/i);
  });
});

describe("⭐ o que estes canais NÃO fazem", () => {
  it("buscar_pedido recusa OLX e Facebook como filtro", () => {
    for (const p of ["OLX", "FACEBOOK"]) {
      expect(
        buscarPedido.args.safeParse({ plataforma: p }).success,
        `aceitou ${p}`,
      ).toBe(false);
    }
    for (const p of ["MERCADO_LIVRE", "SHOPEE", "MAGALU"]) {
      expect(buscarPedido.args.safeParse({ plataforma: p }).success).toBe(true);
    }
  });

  it("e a descrição manda DIZER isso em vez de responder zero", () => {
    expect(buscarPedido.description).toMatch(/OLX e Facebook N[ÃA]O entram/i);
    expect(buscarPedido.description).toMatch(/em vez de responder zero/i);
  });

  it("a prévia de título não é inventada para Shopee e Magalu", async () => {
    // Nesses dois o título publicado é MONTADO pelo sistema; mostrar o nome
    // cortado como "prévia" seria mostrar um texto que ninguém vai ver.
    for (const canal of ["shopee", "magalu"] as const) {
      const r: any = await sugerirTitulo.handler(
        { descricao: "x".repeat(150), canal },
        scope,
      );
      expect(r.atencao, canal).toBeUndefined();
    }
  });

  it("mas OLX e Facebook mostram o corte, porque o nome vai cru", async () => {
    const olx: any = await sugerirTitulo.handler(
      { descricao: "x".repeat(150), canal: "olx" },
      scope,
    );
    expect(olx.atencao).toContain("OLX");
    expect(olx.atencao).toContain("x".repeat(OLX_CONSTANTS.TITLE_MAX_LENGTH));

    const fb: any = await sugerirTitulo.handler(
      { descricao: "x".repeat(250), canal: "facebook" },
      scope,
    );
    expect(fb.atencao).toContain("Facebook");
  });

  it("os dois avisam que o sistema NÃO acrescenta marca/modelo/ano", async () => {
    for (const canal of NOVOS) {
      // O rótulo curto é o que vai para o card de fontes...
      expect(
        regrasDeTitulo(canal)
          .map((r) => r.rule)
          .join(" "),
        canal,
      ).toMatch(/N[ÃA]O acrescenta marca/i);

      // ...e o detalhe é o que o modelo repassa ao lojista. Os dois precisam
      // dizer que o que não está no NOME não aparece no anúncio — é a
      // consequência prática, e é o oposto do conselho da Shopee.
      const r: any = await sugerirTitulo.handler(
        { descricao: "farol", canal },
        scope,
      );
      expect(r.regrasDoCanal.join(" "), canal).toMatch(/no nome/i);
    }
  });

  it("e é o OPOSTO do que a Shopee recomenda — a diferença é o ponto", () => {
    // Na Shopee repetir marca/modelo desperdiça caracteres porque o sistema já
    // os anexa. Na OLX e no Facebook, omitir significa que eles não existem.
    expect(
      regrasDeTitulo("shopee")
        .map((r) => r.rule)
        .join(" "),
    ).toMatch(/j[áa] s[ãa]o acrescentados/i);
  });
});

describe("⭐ buscar_produto diz EM QUE CANAL a peça está", () => {
  // O objeto que `listProducts` devolve é o do mapeador real
  // (product.repository.ts:235-255): `platform` no primeiro nível, SEM
  // `marketplaceAccount`. Reproduzir essa forma aqui é o que faz o teste valer
  // — com um objeto inventado, a projeção "certa" e a "errada" passariam igual.
  const pecaComAnuncios = {
    id: "p1",
    sku: "F001",
    name: "Farol Dianteiro Palio",
    price: 250,
    stock: 1,
    listings: [
      { platform: "OLX", marketplaceAccountId: "c1", status: "active" },
      { platform: "FACEBOOK", marketplaceAccountId: "c2", status: "paused" },
      { platform: "MERCADO_LIVRE", marketplaceAccountId: "c3", status: "active" },
    ],
  };

  it("devolve a plataforma de cada anúncio, OLX e Facebook inclusive", async () => {
    H.produtos = [pecaComAnuncios];
    const r: any = await buscarProduto.handler({ consulta: "farol" }, scope);
    const canais = r.itens[0].anuncios.map((a: any) => a.plataforma);
    expect(canais).toEqual(["OLX", "FACEBOOK", "MERCADO_LIVRE"]);
    H.produtos = [];
  });

  // A regressão que este teste tranca: antes, a projeção lia
  // `l.marketplaceAccount?.platform` num objeto que não tem esse campo, e
  // `plataforma` vinha null em TODA peça e em TODO canal. Passava despercebido
  // porque `situacao` continuava certo — a linha parecia preenchida.
  it("e NUNCA devolve a plataforma nula quando o anúncio existe", async () => {
    H.produtos = [pecaComAnuncios];
    const r: any = await buscarProduto.handler({ consulta: "farol" }, scope);
    for (const a of r.itens[0].anuncios) {
      expect(a.plataforma).not.toBeNull();
      expect(a.situacao).not.toBeNull();
    }
    H.produtos = [];
  });

  it("não devolve campo que o select da listagem nunca busca", async () => {
    H.produtos = [pecaComAnuncios];
    const r: any = await buscarProduto.handler({ consulta: "farol" }, scope);
    // `conta` e `erro` não existem neste payload: mantê-los seria pagar token
    // para o modelo ler null e concluir que não há erro nenhum.
    expect(Object.keys(r.itens[0].anuncios[0]).sort()).toEqual([
      "plataforma",
      "situacao",
    ]);
    H.produtos = [];
  });

  it("e a descrição da tool de detalhe não promete o erro que ela não tem", async () => {
    const { detalheProduto } = await import("../app/ai/tools/read/produtos");
    expect(detalheProduto.description).not.toMatch(/com o erro/i);
    expect(detalheProduto.description).toMatch(/diagnostico_operacional/);
  });
});

describe("⭐ zerar o estoque: a ficha conta a consequência REAL do canal", () => {
  const peca = (listings: any[]) => ({
    id: "p1",
    sku: "F001",
    name: "Farol Dianteiro Palio",
    price: 250,
    stock: 3,
    listings,
  });
  const naOlx = [{ platform: "OLX", marketplaceAccountId: "c1", status: "active" }];
  const soNoMl = [
    { platform: "MERCADO_LIVRE", marketplaceAccountId: "c3", status: "active" },
  ];

  async function avisoDe(listings: any[], estoque: number) {
    H.produtos = [peca(listings)];
    proporMock.mockClear();
    await ajustarEstoqueDoProduto.handler(
      { sku: "F001", estoque },
      scope,
      undefined as any,
    );
    H.produtos = [];
    return proporMock.mock.calls[0][0].preview.aviso as string | undefined;
  }

  // A regressão que este teste tranca: o aviso de estoque zero era o `else` do
  // aviso de marketplace (`??`), então peça COM anúncio nunca era avisada — o
  // único caso em que zerar tem consequência.
  it("peça anunciada e estoque 0 recebe OS DOIS avisos, não um", async () => {
    const aviso = await avisoDe(soNoMl, 0);
    expect(aviso).toMatch(/1 anúncio publicado/);
    expect(aviso).toMatch(/indisponível para venda/);
  });

  it("com anúncio na OLX, diz que o anúncio será EXCLUÍDO", async () => {
    const aviso = await avisoDe(naOlx, 0);
    expect(aviso).toMatch(/EXCLUI o anúncio/);
    expect(aviso).toMatch(/não existe pausar/);
    expect(aviso).toMatch(/anúncio novo/);
  });

  it("sem anúncio na OLX, NÃO assusta com exclusão", async () => {
    const aviso = await avisoDe(soNoMl, 0);
    expect(aviso).not.toMatch(/EXCLUI/);
  });

  it("estoque maior que zero não ganha aviso de zero (nem na OLX)", async () => {
    const aviso = await avisoDe(naOlx, 5);
    expect(aviso).toMatch(/1 anúncio publicado/);
    expect(aviso).not.toMatch(/indisponível para venda/);
    expect(aviso).not.toMatch(/EXCLUI/);
  });

  it("peça sem anúncio nenhum continua com o aviso simples de sempre", async () => {
    const aviso = await avisoDe([], 0);
    expect(aviso).toBe("Estoque zero deixa a peça indisponível para venda.");
  });
});

describe("⭐ zero regressão nos canais que já existiam", () => {
  it("o Mercado Livre continua com a prévia sanitizada", async () => {
    const r: any = await sugerirTitulo.handler(
      { descricao: "Farol D/E (novo) Palio", canal: "mercado_livre" },
      scope,
    );
    expect(r.atencao).toContain("Farol D E novo Palio");
  });

  it("a descrição do ML continua sendo a do ML, e não a de outro canal", () => {
    const texto = regrasDeDescricao("mercado_livre")
      .map((r) => r.rule)
      .join(" ");
    expect(texto).toMatch(/Mercado Livre/);
    expect(texto).not.toMatch(/OLX|Facebook/);
  });

  it("Shopee e Magalu não herdaram regra da OLX nem do Facebook", () => {
    for (const canal of ["shopee", "magalu"] as const) {
      const texto = [...regrasDeTitulo(canal), ...regrasDeDescricao(canal)]
        .map((r) => `${r.rule} ${r.detalhe}`)
        .join(" ");
      expect(texto, canal).not.toMatch(/OLX|Facebook/);
    }
  });

  it("sugerir_preco sem canal responde exatamente como antes", () => {
    const r = sugerirPreco.args.safeParse({ titulo: "farol palio" });
    expect(r.success).toBe(true);
    expect((r as any).data.canal).toBeUndefined();
  });
});

describe("⭐ a base de conhecimento cobre os dois canais", () => {
  const olx = KNOWLEDGE_DOCS.find((d) => d.id === "anuncios-olx");
  const fb = KNOWLEDGE_DOCS.find((d) => d.id === "anuncios-facebook");

  it("os dois documentos estão no manifesto, apontando para a página certa", () => {
    expect(olx?.page).toBe("olx");
    expect(fb?.page).toBe("facebook");
    expect(PAGE_IDS.has(olx!.page)).toBe(true);
    expect(PAGE_IDS.has(fb!.page)).toBe(true);
  });

  it("o documento da OLX conta o que dói: sem pedido, e pausar é excluir", () => {
    const md = readFileSync(join(CONTENT_DIR, "anuncios-olx.md"), "utf8");
    expect(md).toMatch(/pausar na olx é excluir/i);
    expect(md).toMatch(/n[ãa]o devolve pedido/i);
    expect(md).toMatch(/arredonda/i);
  });

  it("o do Facebook separa catálogo de Marketplace clássico", () => {
    const md = readFileSync(join(CONTENT_DIR, "anuncios-facebook.md"), "utf8");
    expect(md).toMatch(/n[ãa]o é o marketplace do facebook/i);
    expect(md).toMatch(/checkout no brasil/i);
    expect(md).toMatch(/estoque zero n[ãa]o apaga/i);
  });
});
