import { describe, expect, it } from "vitest";

import {
  anuncioExpoeAPeca,
  contasComDoisNoAr,
  decidirBalde,
  decidirVeredito,
  eixoDe,
  falaDaMesmaPeca,
  ladoDe,
  semTokensDeUmCaractere,
  semelhancaDeNomes,
} from "../scripts/catalog-dedupe/lib/veredito-fusao";

describe("armadilha do token de 1 caractere", () => {
  it("colapsa lado esquerdo e direito escritos com uma letra", () => {
    // É exatamente o que o tokenizador da aplicação faz e o motivo de peças
    // OPOSTAS terem semelhança 1,00 em varreduras anteriores.
    expect(semTokensDeUmCaractere("Farol Dianteiro L/e")).toBe(
      semTokensDeUmCaractere("Farol Dianteiro L/d"),
    );
  });

  it("nao colapsa quando o lado vem escrito por extenso", () => {
    expect(semTokensDeUmCaractere("Farol Dianteiro Esquerdo")).not.toBe(
      semTokensDeUmCaractere("Farol Dianteiro Direito"),
    );
  });
});

describe("lado e eixo", () => {
  it("le o lado por abreviacao e por extenso", () => {
    expect(ladoDe("Macaneta Traseira Esquerda Gol")).toBe("E");
    expect(ladoDe("Macaneta Traseira Dir Gol")).toBe("D");
    expect(ladoDe("Farol L/e")).toBe("E");
  });

  it("devolve nulo quando o nome nao diz o lado ou diz os dois", () => {
    expect(ladoDe("Bomba De Agua Eletrica")).toBeNull();
    // "Par" traz os dois lados: acusar divergencia aqui separaria peca igual.
    expect(ladoDe("Kit Par Farol Esquerdo E Direito")).toBeNull();
  });

  it("separa dianteiro de traseiro", () => {
    expect(eixoDe("Parabarro Dianteiro")).toBe("DIANTEIRO");
    expect(eixoDe("Parabarro Traseiro")).toBe("TRASEIRO");
    expect(eixoDe("Modulo Central")).toBeNull();
  });
});

describe("o anuncio fala desta peca?", () => {
  it("aceita o mesmo anuncio com pequena variacao de escrita", () => {
    expect(
      falaDaMesmaPeca(
        "Macaneta Externa Traseira Esquerda Cruze Hatch 2013 V1234",
        "Maçaneta Externa Traseira Esquerda Cruze Hatch 2013 V1234",
      ),
    ).toBe(true);
  });

  it("recusa anuncio que esta vendendo outra peca", () => {
    // Caso real medido em 23/09: a ficha era um cabo e o anuncio no ar era um coxim.
    expect(
      falaDaMesmaPeca(
        "Coxim Radiador C3 Exclusive 1.6 Vvt 2016 V2278",
        "Cabo Puxador Tanque Tracker Lt 1.0 3cc Ano 2021 V1223",
      ),
    ).toBe(false);
  });

  it("nao acusa divergencia quando falta o titulo", () => {
    expect(falaDaMesmaPeca("", "Cabo Puxador Tanque")).toBe(true);
  });

  it("ignora palavras de ate duas letras ao comparar", () => {
    // Sem esse corte, "de", "do" e "1.6" aproximariam pecas sem relacao.
    expect(semelhancaDeNomes("Bomba De Agua", "Modulo De Vidro")).toBeLessThan(0.5);
  });
});

describe("anuncio no ar de verdade", () => {
  it("exige status ativo E quantidade acima de zero", () => {
    expect(anuncioExpoeAPeca({ conta: "A", statusNoMl: "active", quantidade: 1 })).toBe(true);
    expect(anuncioExpoeAPeca({ conta: "A", statusNoMl: "active", quantidade: 0 })).toBe(false);
    expect(anuncioExpoeAPeca({ conta: "A", statusNoMl: "paused", quantidade: 5 })).toBe(false);
    expect(anuncioExpoeAPeca({ conta: "A", statusNoMl: "NAO_CONFERIDO", quantidade: null })).toBe(false);
  });
});

describe("contagem de contas com dois anuncios no ar", () => {
  it("conta a conta que expoe a peca duas vezes", () => {
    expect(
      contasComDoisNoAr([
        { conta: "loja 1", statusNoMl: "active", quantidade: 1 },
        { conta: "loja 1", statusNoMl: "active", quantidade: 1 },
      ]),
    ).toBe(1);
  });

  it("nao conta um anuncio por conta, que e a publicacao normal", () => {
    expect(
      contasComDoisNoAr([
        { conta: "loja 1", statusNoMl: "active", quantidade: 1 },
        { conta: "loja 2", statusNoMl: "active", quantidade: 1 },
        { conta: "loja 3", statusNoMl: "active", quantidade: 1 },
      ]),
    ).toBe(0);
  });

  it("nao conta quando o segundo anuncio da conta esta pausado ou zerado", () => {
    expect(
      contasComDoisNoAr([
        { conta: "loja 1", statusNoMl: "active", quantidade: 1 },
        { conta: "loja 1", statusNoMl: "paused", quantidade: 1 },
        { conta: "loja 1", statusNoMl: "active", quantidade: 0 },
      ]),
    ).toBe(0);
  });
});

describe("veredito da conferencia no marketplace", () => {
  it("confirma a dupla exposicao mesmo com anuncio por conferir", () => {
    expect(
      decidirVeredito([
        { conta: "loja 1", statusNoMl: "active", quantidade: 1 },
        { conta: "loja 1", statusNoMl: "active", quantidade: 1 },
        { conta: "loja 2", statusNoMl: "NAO_CONFERIDO", quantidade: null },
      ]),
    ).toBe("DUPLA_EXPOSICAO_CONFIRMADA");
  });

  it("fica incompleto quando falta conferir e ainda nao ha colisao", () => {
    expect(
      decidirVeredito([
        { conta: "loja 1", statusNoMl: "active", quantidade: 1 },
        { conta: "loja 1", statusNoMl: "NAO_CONFERIDO", quantidade: null },
      ]),
    ).toBe("INCOMPLETO");
  });

  it("chama de espelho velho quando tudo foi conferido e nada esta no ar em dobro", () => {
    expect(
      decidirVeredito([
        { conta: "loja 1", statusNoMl: "active", quantidade: 1 },
        { conta: "loja 1", statusNoMl: "closed", quantidade: 0 },
      ]),
    ).toBe("ESPELHO_VELHO");
  });
});

describe("balde da auditoria", () => {
  const nenhum = {
    colisaoDesteGrupo: false,
    colisaoPreexistente: false,
    ladoOpostoPorTokenCurto: false,
    ladoDivergente: false,
    eixoDivergente: false,
  };

  it("manda desfazer quando a propria fusao criou a colisao", () => {
    expect(decidirBalde({ ...nenhum, colisaoDesteGrupo: true })).toBe("DESFAZER_SUGERIDO");
  });

  it("manda desfazer quando os nomes divergem em lado ou eixo", () => {
    expect(decidirBalde({ ...nenhum, ladoDivergente: true })).toBe("DESFAZER_SUGERIDO");
    expect(decidirBalde({ ...nenhum, eixoDivergente: true })).toBe("DESFAZER_SUGERIDO");
    expect(decidirBalde({ ...nenhum, ladoOpostoPorTokenCurto: true })).toBe("DESFAZER_SUGERIDO");
  });

  it("apenas revisa a colisao que ja existia antes da fusao", () => {
    // Passivo do cliente nao e defeito da fusao: tratar como igual inflaria a
    // lista de "desfazer" com caso que desfazer nao resolve.
    expect(decidirBalde({ ...nenhum, colisaoPreexistente: true })).toBe("REVISAR");
  });

  it("aprova o grupo sem nenhum sinal", () => {
    expect(decidirBalde(nenhum)).toBe("OK");
  });
});
