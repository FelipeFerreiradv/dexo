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
});
