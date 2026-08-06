import { describe, expect, it } from "vitest";

import {
  ML_TITLE_FALLBACK,
  buildMLTitleFrom,
  compareMLTitles,
  isMaterialMLTitleChange,
  normalizeMLTitleForCompare,
  sanitizeMLTitle,
} from "@/app/marketplaces/lib/ml-title";

// Valores REAIS medidos em produção no anúncio que originou o bug
// (tenant Mesquita Autopeças, SKU 500542, categoria MLB101763 "Portas").
const NOME_PRODUTO = "PORTA DIANTEIRA DIREITA BYD DOLPHIN PLUS 2024 2025 2026";
const FAMILY_NAME_ML = "Porta Dianteira Direita Byd Dolphin Plus 2024 2025 2026";
const TITLE_ML =
  "Porta Dianteira Direita Byd Dolphin Plus 2024 2025 2026 Dianteira Direita Branco";

describe("sanitizeMLTitle — paridade com o ListingUseCase.sanitizeTitle", () => {
  it("preserva acentos e hífen", () => {
    expect(sanitizeMLTitle("Reservatório do Pára-brisa")).toBe(
      "Reservatório do Pára-brisa",
    );
  });

  it("troca pontuação por espaço e colapsa", () => {
    expect(sanitizeMLTitle("Farol  Dianteiro / Direito!")).toBe(
      "Farol Dianteiro Direito",
    );
    expect(sanitizeMLTitle("Porta Diant. Esq. (Original, s/ Vidro)")).toBe(
      "Porta Diant Esq Original s Vidro",
    );
  });

  it("trunca em 60 e apara a borda", () => {
    const longo = "A".repeat(70);
    expect(sanitizeMLTitle(longo)).toHaveLength(60);
    expect(sanitizeMLTitle("x".repeat(59) + "   y")).toBe("x".repeat(59));
  });

  it("cai para o SKU quando não sobra nada, e para 'Produto' sem SKU", () => {
    expect(sanitizeMLTitle("!!!", "SKU-1")).toBe("SKU-1");
    expect(sanitizeMLTitle("!!!")).toBe(ML_TITLE_FALLBACK);
    expect(sanitizeMLTitle(null)).toBe(ML_TITLE_FALLBACK);
  });

  it("é IDEMPOTENTE — é o que impede a republicação de derivar a cada rodada", () => {
    const entradas = [
      NOME_PRODUTO,
      "Porta Diant. Esq. (Original, s/ Vidro)",
      "Reservatório do Pára-brisa",
      "A".repeat(70),
      "!!!",
    ];
    for (const e of entradas) {
      const uma = sanitizeMLTitle(e, "SKU-1");
      expect(sanitizeMLTitle(uma, "SKU-1")).toBe(uma);
    }
  });

  it("buildMLTitleFrom usa name e cai para o sku", () => {
    expect(buildMLTitleFrom({ name: NOME_PRODUTO, sku: "500542" })).toBe(
      NOME_PRODUTO,
    );
    expect(buildMLTitleFrom({ name: "///", sku: "500542" })).toBe("500542");
  });
});

describe("normalizeMLTitleForCompare — a ordem NFD antes da pontuação", () => {
  it("não parte a palavra no acento", () => {
    // Se a classe de pontuação rodasse ANTES do NFD, a marca combinante
    // sobraria como não-letra e "Reservatório" viraria "reservato rio".
    expect(normalizeMLTitleForCompare("Reservatório")).toBe("reservatorio");
    expect(normalizeMLTitleForCompare("Câmbio Citroën")).toBe("cambio citroen");
  });

  it("remove pontuação e hífen e colapsa espaço", () => {
    expect(normalizeMLTitleForCompare("Farol-Dianteiro / Direito!")).toBe(
      "farol dianteiro direito",
    );
  });
});

describe("compareMLTitles", () => {
  it("CASO DO VÍDEO: caixa alta vs family_name Title-Case-ado → exact", () => {
    const cmp = compareMLTitles(NOME_PRODUTO, FAMILY_NAME_ML);
    expect(cmp.equivalent).toBe(true);
    expect(cmp.reason).toBe("exact");
  });

  it("CASO DO VÍDEO: title com os atributos anexados pelo ML → remote_contains_desired", () => {
    const cmp = compareMLTitles(NOME_PRODUTO, TITLE_ML);
    expect(cmp.equivalent).toBe(true);
    expect(cmp.reason).toBe("remote_contains_desired");
  });

  it("ignora acento e pontuação", () => {
    expect(
      compareMLTitles("Reservatório do Pára-brisa", "Reservatorio Do Para Brisa")
        .reason,
    ).toBe("exact");
    expect(
      compareMLTitles("Farol Dianteiro (Direito)", "Farol Dianteiro Direito")
        .reason,
    ).toBe("exact");
  });

  it("tolera truncamento — remoto é prefixo do desejado", () => {
    const desejado = "Porta Dianteira Direita Byd Dolphin Plus 2024";
    const remoto = "Porta Dianteira Direita Byd";
    const cmp = compareMLTitles(desejado, remoto);
    expect(cmp.equivalent).toBe(true);
    expect(cmp.reason).toBe("desired_contains_remote");
  });

  it("piso de contenção impede engolir um desejado curto", () => {
    const cmp = compareMLTitles("Porta", "Porta Dianteira Direita Byd Dolphin");
    expect(cmp.equivalent).toBe(false);
    expect(cmp.reason).toBe("different");
  });

  it("piso 0 reproduz o includes() sem piso do caminho de criacao", () => {
    // O caminho pós-criação passa 0 porque o `includes()` que ele tinha inline
    // nunca teve piso — herdar o default mudaria a decisão em 12 dos 220.737
    // anúncios ativos ("friso c4", "11609", "497 Preto"...).
    const cmp = compareMLTitles("friso c4", "Friso C4 Preto Dianteiro", 0);
    expect(cmp.equivalent).toBe(true);
    expect(cmp.reason).toBe("remote_contains_desired");
  });

  it("renomeação de verdade → different", () => {
    const cmp = compareMLTitles(
      "Farol Dianteiro Gol G5 2010",
      "Porta Dianteira Byd Dolphin 2024",
    );
    expect(cmp.equivalent).toBe(false);
    expect(cmp.reason).toBe("different");
  });

  // Trios (Product.name, ML family_name, ML title) lidos da API do ML em
  // anúncios VIVOS da conta JOTABE-AUTOPECAS. Todos os três seriam
  // classificados como "título mudou" pela comparação crua (`name !== title`)
  // e republicariam a cada save. Nenhum teve renomeação.
  const CASOS_REAIS: Array<[string, string, string]> = [
    [
      "maçaneta externa traseira direita volkswagen gol fox 2012",
      "Maçaneta Externa Traseira Direita Volkswagen Gol Fox 2012",
      "Maçaneta Externa Traseira Direita Volkswagen Gol Fox 2012 Prata/metálico Traseira",
    ],
    [
      "maçaneta externa traseira direita volkswagen gol fox 2012",
      "Maçaneta Externa Traseira Direita Volkswagen Gol Fox 2012",
      "Maçaneta Externa Traseira Direita Volkswagen Gol Fox 2012 Preto Traseira",
    ],
    [
      "Bomba direção hidráulica Ford fiesta 1.0 2011",
      "Bomba Direção Hidráulica Ford Fiesta 1 0 2011",
      "Bomba Direção Hidráulica Ford Fiesta 1 0 2011",
    ],
    [NOME_PRODUTO, FAMILY_NAME_ML, TITLE_ML],
  ];

  it.each(CASOS_REAIS)(
    "anúncio real de produção não é mais classificado como renomeado: %s",
    (name, familyName, title) => {
      const desejado = buildMLTitleFrom({ name, sku: "X" });

      // A comparação crua de hoje classifica os quatro como "mudou".
      expect(name !== title).toBe(true);

      // A corrigida reconhece os dois lados como o mesmo título.
      expect(compareMLTitles(desejado, familyName).equivalent).toBe(true);
      expect(compareMLTitles(desejado, title).equivalent).toBe(true);
    },
  );

  it("fail-closed: lado vazio nunca manda agir", () => {
    expect(compareMLTitles("", "qualquer coisa")).toMatchObject({
      equivalent: true,
      reason: "empty_desired",
    });
    expect(compareMLTitles("qualquer coisa", "")).toMatchObject({
      equivalent: true,
      reason: "empty_remote",
    });
  });
});

describe("isMaterialMLTitleChange", () => {
  it("reordenação não é material", () => {
    expect(
      isMaterialMLTitleChange(
        "Porta Dianteira Direita Gol",
        "Direita Porta Gol Dianteira",
      ),
    ).toBe(false);
  });

  it("acrescentar palavra genérica não é material", () => {
    expect(
      isMaterialMLTitleChange(
        "Porta Dianteira Direita Gol",
        "Porta Dianteira Direita Gol Usado",
      ),
    ).toBe(false);
  });

  it("trocar o ano É material", () => {
    expect(
      isMaterialMLTitleChange(
        "Porta Dianteira Gol 2024",
        "Porta Dianteira Gol 2025",
      ),
    ).toBe(true);
  });

  it("acrescentar o modelo É material", () => {
    expect(
      isMaterialMLTitleChange(
        "Porta Dianteira Gol G5",
        "Porta Dianteira Gol",
      ),
    ).toBe(true);
  });

  it("fail-closed com lado sem tokens", () => {
    expect(isMaterialMLTitleChange("", "Porta Dianteira")).toBe(false);
    expect(isMaterialMLTitleChange("Porta Dianteira", "")).toBe(false);
  });
});
