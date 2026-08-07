import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { linhasDoCard, paraLinha } from "../components/bitz/bitz-source-line";
import { ORDEM_DAS_FONTES } from "../app/ai/advisory/source-chain";

// ===========================================================================
// O card de fontes — a única parte da explicabilidade que o usuário VÊ.
//
// Duas coisas dão errado aqui, e nenhuma delas quebra nada:
//
//  1. Uma fonte de tipo que o front não conhece some sem aviso. Foi o que
//     aconteceria com TODAS as seis desta fase se o card tivesse ficado como a
//     Fase 4 o deixou (ele só desenhava `conhecimento`). A resposta viria com
//     procedência e a tela mostraria nada.
//  2. Uma fonte malformada vira uma linha malformada — "confiança undefined".
//
// Por isso os testes abaixo são chatos de propósito: cada `kind`, com e sem os
// campos opcionais.
// ===========================================================================

describe("cada tipo de fonte vira uma linha legível", () => {
  it("conhecimento", () => {
    expect(
      paraLinha({
        kind: "conhecimento",
        docId: "pedidos",
        docTitle: "Pedidos",
        heading: "Erros comuns",
      }),
    ).toEqual({
      chave: "conhecimento:Pedidos",
      texto: "Pedidos — Erros comuns",
      icone: "livro",
    });
  });

  it("conhecimento sem seção não vira travessão solto", () => {
    expect(
      paraLinha({ kind: "conhecimento", docTitle: "Pedidos" })?.texto,
    ).toBe("Pedidos");
  });

  it("proprio com e sem contagem", () => {
    expect(
      paraLinha({ kind: "proprio", label: "Peças do seu catálogo", count: 3 })
        ?.texto,
    ).toBe("Peças do seu catálogo (3)");
    expect(
      paraLinha({ kind: "proprio", label: "Texto padrão da loja", count: 0 })
        ?.texto,
    ).toBe("Texto padrão da loja");
  });

  it("plataforma diz o tamanho da amostra e a confiança em português", () => {
    expect(
      paraLinha({
        kind: "plataforma",
        sampleSize: 12,
        confidence: "media",
        matchKey: "farol|fiat|palio|*",
      })?.texto,
    ).toBe("Base consolidada do Dexo — 12 peças parecidas, confiança média");
  });

  it("plataforma com confiança desconhecida não escreve `undefined` na tela", () => {
    const linha = paraLinha({ kind: "plataforma", sampleSize: 7 });
    expect(linha?.texto).toContain("confiança —");
    expect(linha?.texto).not.toContain("undefined");
  });

  it("regra", () => {
    expect(
      paraLinha({ kind: "regra", rule: "Título do ML: 60 caracteres" }),
    ).toEqual({
      chave: "regra:Título do ML: 60 caracteres",
      texto: "Título do ML: 60 caracteres",
      icone: "balanca",
    });
  });

  it("externa nomeia o provedor por extenso, com e sem referência", () => {
    expect(
      paraLinha({ kind: "externa", provider: "mercado-livre", ref: "MLB1" })
        ?.texto,
    ).toBe("Catálogo público do Mercado Livre — MLB1");
    expect(
      paraLinha({ kind: "externa", provider: "mercado-livre" })?.texto,
    ).toBe("Catálogo público do Mercado Livre");
  });

  it("⭐ estimativa é a única com destaque visual", () => {
    const estimativa = paraLinha({
      kind: "estimativa",
      note: "Título redigido pelo Bitz.",
    });
    expect(estimativa?.destaque).toBe(true);

    for (const outra of [
      { kind: "proprio", label: "x", count: 1 },
      { kind: "plataforma", sampleSize: 5, confidence: "alta" },
      { kind: "regra", rule: "y" },
      { kind: "externa", provider: "mercado-livre" },
      { kind: "conhecimento", docTitle: "z" },
    ]) {
      expect(paraLinha(outra)?.destaque, JSON.stringify(outra)).toBeUndefined();
    }
  });
});

describe("o que NÃO vira linha", () => {
  it.each([
    ["tipo desconhecido", { kind: "adivinhei", texto: "oi" }],
    ["kind ausente", { docTitle: "x" }],
    ["conhecimento sem título", { kind: "conhecimento", docId: "x" }],
    ["proprio sem rótulo", { kind: "proprio", count: 3 }],
    ["plataforma sem amostra", { kind: "plataforma", confidence: "alta" }],
    ["regra sem texto", { kind: "regra" }],
    ["externa de outro provedor", { kind: "externa", provider: "google" }],
    ["estimativa sem nota", { kind: "estimativa" }],
    ["nulo", null],
    ["indefinido", undefined],
  ])("%s é ignorado", (_nome, entrada) => {
    expect(paraLinha(entrada as any)).toBeNull();
  });
});

describe("montagem do card", () => {
  it("mantém a ordem do servidor", () => {
    const linhas = linhasDoCard([
      { kind: "proprio", label: "A", count: 1 },
      { kind: "regra", rule: "B" },
      { kind: "estimativa", note: "C" },
    ]);
    expect(linhas.map((l) => l.texto)).toEqual(["A (1)", "B", "C"]);
  });

  it("cinco pedaços do mesmo documento viram uma linha só", () => {
    const linhas = linhasDoCard(
      Array.from({ length: 5 }, (_, i) => ({
        kind: "conhecimento",
        docTitle: "Pedidos",
        heading: `Seção ${i}`,
      })),
    );
    expect(linhas).toHaveLength(1);
  });

  it("lista vazia, nula ou só com lixo não desenha card", () => {
    expect(linhasDoCard([])).toEqual([]);
    expect(linhasDoCard(undefined)).toEqual([]);
    expect(linhasDoCard([{ kind: "xpto" }, null, 42])).toEqual([]);
  });
});

describe("⭐ o card cobre TODOS os tipos que o servidor sabe emitir", () => {
  it("nenhum tipo da cadeia de fontes some na tela", () => {
    // Este é o teste que teria pego a Fase 4 inteira: o card desenhava só
    // `conhecimento`, e as outras cinco procedências seriam calculadas no
    // servidor, gravadas no banco e ignoradas em silêncio pelo front.
    const exemplo: Record<string, any> = {
      proprio: { kind: "proprio", label: "x", count: 1 },
      plataforma: { kind: "plataforma", sampleSize: 5, confidence: "alta" },
      conhecimento: { kind: "conhecimento", docTitle: "x" },
      regra: { kind: "regra", rule: "x" },
      externa: { kind: "externa", provider: "mercado-livre" },
      estimativa: { kind: "estimativa", note: "x" },
    };

    for (const kind of ORDEM_DAS_FONTES) {
      expect(exemplo[kind], `sem exemplo para "${kind}"`).toBeTruthy();
      expect(paraLinha(exemplo[kind]), `"${kind}" some do card`).not.toBeNull();
    }
  });

  it("o .tsx é só render: a lógica mora no módulo puro", () => {
    // Se a lógica voltar para dentro do React, ela sai da cobertura — a suíte
    // roda sem jsdom e não monta componente.
    const tsx = readFileSync(
      join(__dirname, "..", "components", "bitz", "bitz-sources.tsx"),
      "utf8",
    );
    expect(tsx).toContain("linhasDoCard");
    expect(tsx).not.toMatch(/case\s+"conhecimento"/);
  });
});
