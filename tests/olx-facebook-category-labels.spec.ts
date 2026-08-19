import { describe, expect, it } from "vitest";

// ──────────────────────────────────────────────────────────
// CATEGORIA NA TELA: nome em português, nunca código nem inglês.
//
// Dois defeitos distintos, reportados no primeiro uso real:
//
// 1. OLX mostrava número ("2101"). A lista de categorias devolvia como rótulo a
//    CHAVE de OLX_CATEGORY_MAP — que é a palavra usada para casar no nome do
//    produto ("moto", "caminhao"), não o nome da categoria. E, como a tela só
//    carregava a lista depois de 2 letras digitadas, o campo pré-preenchido
//    pela sugestão não achava rótulo nenhum e caía no id cru.
//
// 2. Facebook mostrava inglês. O valor é o caminho da taxonomia do Google, que
//    só existe em inglês — e era exibido como veio.
//
// ⚠️ A ARMADILHA QUE ESTE SPEC GUARDA: no Facebook o valor ENVIADO à Meta tem
// de continuar em inglês. Traduzir o path faria a Meta recusar o item. Por isso
// tradução é camada de EXIBIÇÃO, e os casos abaixo travam essa separação.
// ──────────────────────────────────────────────────────────

import {
  OLX_AUTOPARTS_CATEGORY,
  OLX_CATEGORY_LABEL,
  OLX_CATEGORY_MAP,
} from "@/app/marketplaces/olx/olx-category-map";
import {
  FACEBOOK_CATEGORY_LABEL,
  FACEBOOK_CATEGORY_MAP,
  FACEBOOK_DEFAULT_CATEGORY,
} from "@/app/marketplaces/facebook/facebook-category-map";

describe("OLX — as cinco categorias têm nome legível", () => {
  it("todo código usado pela resolução tem rótulo", () => {
    const usados = new Set(Object.values(OLX_CATEGORY_MAP));
    for (const id of usados) {
      expect(OLX_CATEGORY_LABEL[id], `categoria ${id} sem rótulo`).toBeTruthy();
    }
  });

  it("os rótulos são nomes, não as palavras de casamento nem números", () => {
    expect(OLX_CATEGORY_LABEL[OLX_AUTOPARTS_CATEGORY.CARS]).toBe(
      "Carros, vans e utilitários",
    );
    expect(OLX_CATEGORY_LABEL[OLX_AUTOPARTS_CATEGORY.MOTORCYCLES]).toBe(
      "Motos",
    );

    // O que a tela mostrava antes: a chave de casamento ("moto") e o id cru.
    const palavrasDeCasamento = new Set(Object.keys(OLX_CATEGORY_MAP));
    for (const rotulo of Object.values(OLX_CATEGORY_LABEL)) {
      expect(palavrasDeCasamento.has(rotulo)).toBe(false);
      expect(/^\d+$/.test(rotulo)).toBe(false);
    }
  });

  it("dá para achar pelo nome, que é como o operador procura", () => {
    const acha = (termo: string) =>
      Object.values(OLX_CATEGORY_LABEL).filter((l) =>
        l.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(termo),
      );
    expect(acha("moto")).toContain("Motos");
    expect(acha("onibus")).toContain("Ônibus");
    expect(acha("carro")).toContain("Carros, vans e utilitários");

    // ⚠️ O caso que o rótulo sozinho NÃO resolve: "caminhao" (como o operador
    // digita, no singular) não está contido em "caminhoes". Por isso a rota
    // também casa contra as palavras de OLX_CATEGORY_MAP, como sinônimos.
    expect(acha("caminhao")).toEqual([]);
    expect(Object.keys(OLX_CATEGORY_MAP)).toContain("caminhao");
    expect(OLX_CATEGORY_MAP["caminhao"]).toBe(OLX_AUTOPARTS_CATEGORY.TRUCKS);
  });
});

describe("Facebook — rótulo em português, valor em inglês", () => {
  it("todo caminho usado pela resolução tem rótulo em português", () => {
    const usados = new Set(Object.values(FACEBOOK_CATEGORY_MAP));
    usados.add(FACEBOOK_DEFAULT_CATEGORY);
    for (const path of usados) {
      expect(FACEBOOK_CATEGORY_LABEL[path], `sem rótulo: ${path}`).toBeTruthy();
    }
  });

  it("o rótulo NÃO carrega o path em inglês", () => {
    for (const rotulo of Object.values(FACEBOOK_CATEGORY_LABEL)) {
      expect(rotulo).not.toContain("Vehicles & Parts");
      expect(rotulo).not.toContain(">");
    }
  });

  it("o VALOR enviado à Meta continua sendo o path do Google, em inglês", () => {
    // Este é o caso que impede a "tradução" de vazar para o que sai na API. Se
    // alguém traduzir a chave em vez do rótulo, a Meta recusa o item — e o
    // items_batch responde HTTP 200 mesmo assim, então ninguém veria.
    for (const path of Object.keys(FACEBOOK_CATEGORY_LABEL)) {
      expect(path.startsWith("Vehicles & Parts >")).toBe(true);
    }
    expect(FACEBOOK_DEFAULT_CATEGORY.startsWith("Vehicles & Parts >")).toBe(
      true,
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // NENHUM RÓTULO DO FACEBOOK PODE SER CÓPIA DE UM DA OLX.
  //
  // A primeira versão destes textos rotulou MOTOR_VEHICLE_PARTS como "Peças de
  // carros, vans e utilitários" — a redação da categoria 2101 da OLX. Nas telas
  // em que os dois canais aparecem um embaixo do outro ficou parecendo que
  // diziam a mesma coisa, e o dono perguntou (com razão) se a categoria do
  // Facebook tinha sido trocada. Não tinha: só o rótulo estava errado.
  //
  // Errado de fato, não apenas confuso: na taxonomia do Google, "Motor Vehicle
  // Parts" é a cesta de TODO veículo automotor — inclusive caminhão e ônibus,
  // que na OLX são categorias separadas (2102 e 2105). O rótulo antigo levava a
  // concluir que peça de caminhão precisaria de outra categoria no Facebook.
  //
  // Os dois canais classificam por eixos diferentes — OLX por TIPO DE VEÍCULO,
  // Meta por TIPO DE PEÇA — então rótulo igual é sinal de erro, não de acerto.
  it("a categoria padrão da Meta NÃO pode ser rotulada como a 2101 da OLX", () => {
    // ⚠️ A primeira versão deste caso reprovava QUALQUER rótulo do Facebook
    // parecido com um da OLX. Passava do ponto: "Peças de motos" vs "Motos"
    // está certo — a 2103 da OLX e MOTORCYCLE_PARTS cobrem o mesmo conjunto de
    // veículos, e é bom que se pareçam.
    //
    // A invariante de verdade é sobre COBERTURA, não sobre semelhança: só a
    // categoria padrão da Meta FUNDE três categorias da OLX (2101 carros, 2102
    // caminhões, 2105 ônibus). Só ela, portanto, não pode herdar a redação de
    // uma delas — foi exatamente o que aconteceu.
    const rotuloMeta = FACEBOOK_CATEGORY_LABEL[FACEBOOK_DEFAULT_CATEGORY];
    const normalizar = (t: string) =>
      t
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/^pecas de\s+/, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

    const fundidas = [
      OLX_CATEGORY_LABEL[OLX_AUTOPARTS_CATEGORY.CARS],
      OLX_CATEGORY_LABEL[OLX_AUTOPARTS_CATEGORY.TRUCKS],
      OLX_CATEGORY_LABEL[OLX_AUTOPARTS_CATEGORY.BUSES],
    ];

    for (const daOlx of fundidas) {
      expect(
        normalizar(rotuloMeta),
        `o rótulo da categoria padrão da Meta é a redação da OLX "${daOlx}", mas ` +
          "na Meta essa categoria cobre as TRÊS (carro, caminhão e ônibus)",
      ).not.toBe(normalizar(daOlx));
    }
  });

    it("a categoria padrão da Meta diz que cobre caminhão e ônibus", () => {
    // É o que a diferencia da 2101 da OLX, e o que o operador precisa saber para
    // não sair procurando uma categoria de caminhão no Facebook — não existe.
    const rotulo = FACEBOOK_CATEGORY_LABEL[FACEBOOK_DEFAULT_CATEGORY];
    const semAcento = rotulo
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    expect(semAcento).toContain("caminh");
    expect(semAcento).toContain("onibus");
  });
});

describe("a SUGESTÃO automática também devolve nome, não código", () => {
  // ⚠️ Era aqui que a primeira correção errou o alvo: eu consertei a LISTA
  // (GET /categories) e o que a tela mostra vem da SUGESTÃO
  // (GET /category-suggest), que é outro caminho. O modal faz
  // `label = data.path || data.categoryId` — com `path` nulo (OLX) ele exibia
  // "2101", e com `path` em inglês (Facebook) exibia a hierarquia do Google.
  //
  // Estes casos travam o CONTRATO que a tela consome: para todo código que a
  // resolução pode devolver, existe rótulo em português.
  it("OLX: todo código resolvível tem nome para o `path` da sugestão", () => {
    for (const id of new Set(Object.values(OLX_CATEGORY_MAP))) {
      const path = OLX_CATEGORY_LABEL[id] ?? null;
      expect(
        path,
        `categoria ${id} devolveria path nulo → tela mostra o número`,
      ).toBeTruthy();
      expect(/^\d+$/.test(String(path))).toBe(false);
    }
  });

  it("Facebook: todo caminho resolvível tem nome em português para o `path`", () => {
    const resolviveis = new Set(Object.values(FACEBOOK_CATEGORY_MAP));
    resolviveis.add(FACEBOOK_DEFAULT_CATEGORY);
    for (const cat of resolviveis) {
      const path = FACEBOOK_CATEGORY_LABEL[cat] ?? cat;
      expect(path).not.toContain("Vehicles & Parts");
      expect(path).not.toBe(cat);
    }
  });
});
