import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";

// ──────────────────────────────────────────────────────────────────────────
// NULO DE COLUNA `Json` — a diferença que não aparece em lugar nenhum.
//
// Escrever `null` do JavaScript numa coluna `Json?` do Prisma grava o literal
// JSON `null`, não `NULL` do SQL. A coluna deixa de ser nula para o banco e
// passa a casar com `IS NOT NULL`.
//
// MEDIDO contra o banco de produção em 21/08/2026 (escrita numa linha real,
// lida de volta com `jsonb_typeof`, dentro de transação desfeita):
//
//   { imageUrlsOverride: null }            -> jsonb_typeof = 'null'   ❌
//   { imageUrlsOverride: Prisma.JsonNull } -> jsonb_typeof = 'null'   ❌
//   { imageUrlsOverride: Prisma.DbNull }   -> IS NULL de verdade      ✅
//
// ⚠️ POR QUE ISSO PRECISA DE TESTE, E DE UM TESTE ASSIM:
//
//  · O Prisma NÃO lança erro com `null` em campo Json — aceita calado.
//  · O log de query do Prisma serializa os DOIS como `null` nos parâmetros:
//    quem diagnosticar pelo log não vê diferença nenhuma.
//  · A LEITURA é idêntica: os dois voltam como `null` do JavaScript.
//
// Ou seja: não há erro, não há log, não há diferença observável na aplicação.
// O único lugar onde a diferença aparece é no `WHERE ... IS NOT NULL` — e foi
// lá que ela custou caro: 919 linhas de resíduo carregadas a cada troca de
// foto de produto, para encontrar 1 anúncio de verdade.
//
// Um teste de comportamento comum não pegaria a volta do defeito. Este pega
// porque afirma a IDENTIDADE do valor enviado ao Prisma (`toBe`), não o que a
// aplicação faz com ele depois.
// ──────────────────────────────────────────────────────────────────────────

vi.mock("../app/lib/prisma", () => ({
  default: {
    productListing: {
      update: vi.fn().mockResolvedValue({ id: "L1" }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    product: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

import prisma from "../app/lib/prisma";
import {
  campoJson,
  comNulosDeJsonSeguros,
  COLUNAS_JSON_DE_PRODUCT_LISTING,
} from "../app/lib/prisma-json-null";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { ProductUseCase } from "../app/usecases/product.usercase";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("campoJson", () => {
  it("`undefined` continua `undefined` — 'o chamador não mandou este campo'", () => {
    expect(campoJson(undefined)).toBeUndefined();
  });

  it("`null` vira `Prisma.DbNull` — 'o chamador mandou limpar'", () => {
    // `toBe`: tem de ser ESTE objeto. `JsonNull` também é 'um nulo do Prisma'
    // e gravaria o literal JSON `null`, que é justamente o defeito.
    expect(campoJson(null)).toBe(Prisma.DbNull);
    expect(campoJson(null)).not.toBe(Prisma.JsonNull);
  });

  it("valores reais passam intactos", () => {
    const arr = ["a", "b"];
    const obj = { OEM: { value_name: "X" } };
    expect(campoJson(arr)).toBe(arr);
    expect(campoJson(obj)).toBe(obj);
  });

  it("falsy que NÃO é null continua passando — 0, string vazia, false, []", () => {
    // O erro clássico aqui é escrever `if (!valor) return Prisma.DbNull`, que
    // transformaria `0` e `""` em nulo e apagaria dado bom.
    expect(campoJson(0)).toBe(0);
    expect(campoJson("")).toBe("");
    expect(campoJson(false)).toBe(false);
    const vazio: unknown[] = [];
    expect(campoJson(vazio)).toBe(vazio);
  });
});

describe("comNulosDeJsonSeguros", () => {
  it("só converte as colunas listadas que valem exatamente `null`", () => {
    const entrada = {
      titleOverride: null, // escalar: `null` já grava NULL do SQL
      priceOverride: null, // escalar
      imageUrlsOverride: null, // Json  -> tem de virar DbNull
      attributesOverride: null, // Json  -> tem de virar DbNull
    };
    const saida = comNulosDeJsonSeguros(
      entrada,
      COLUNAS_JSON_DE_PRODUCT_LISTING,
    );

    expect(saida.imageUrlsOverride).toBe(Prisma.DbNull);
    expect(saida.attributesOverride).toBe(Prisma.DbNull);
    // Os escalares NÃO podem ser tocados: `Prisma.DbNull` num campo String?
    // é erro de validação do Prisma, não um nulo.
    expect(saida.titleOverride).toBeNull();
    expect(saida.priceOverride).toBeNull();
  });

  it("não inventa chave que não estava no objeto", () => {
    const saida = comNulosDeJsonSeguros(
      { titleOverride: null },
      COLUNAS_JSON_DE_PRODUCT_LISTING,
    );
    expect(Object.keys(saida)).toEqual(["titleOverride"]);
    expect("imageUrlsOverride" in saida).toBe(false);
  });

  it("deixa valores reais e `undefined` como estão", () => {
    const arr = ["x"];
    const saida = comNulosDeJsonSeguros(
      { imageUrlsOverride: arr, attributesOverride: undefined },
      COLUNAS_JSON_DE_PRODUCT_LISTING,
    );
    expect(saida.imageUrlsOverride).toBe(arr);
    expect(saida.attributesOverride).toBeUndefined();
  });

  it("devolve cópia — o objeto de entrada não é mutado", () => {
    const entrada = { imageUrlsOverride: null };
    const saida = comNulosDeJsonSeguros(
      entrada,
      COLUNAS_JSON_DE_PRODUCT_LISTING,
    );
    expect(entrada.imageUrlsOverride).toBeNull();
    expect(saida).not.toBe(entrada);
  });
});

describe("ListingRepository.updateListing — edição de anúncio", () => {
  const chamada = () =>
    (prisma.productListing.update as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { data: Record<string, unknown> };

  it("limpar um override Json envia DbNull, não `null`", async () => {
    await ListingRepository.updateListing("L1", {
      imageUrlsOverride: null,
      attributesOverride: null,
      compatibilitiesOverride: null,
      compatDiagnostics: null,
    });

    const { data } = chamada();
    for (const coluna of COLUNAS_JSON_DE_PRODUCT_LISTING) {
      expect(data[coluna], `coluna ${coluna}`).toBe(Prisma.DbNull);
    }
  });

  it("não mandar o campo continua sendo `undefined` (não toca a coluna)", async () => {
    await ListingRepository.updateListing("L1", { status: "active" });

    const { data } = chamada();
    for (const coluna of COLUNAS_JSON_DE_PRODUCT_LISTING) {
      expect(data[coluna], `coluna ${coluna}`).toBeUndefined();
    }
  });

  it("gravar um override de verdade passa o valor intacto", async () => {
    const fotos = ["https://img/1.jpg", "https://img/2.jpg"];
    await ListingRepository.updateListing("L1", { imageUrlsOverride: fotos });

    expect(chamada().data.imageUrlsOverride).toBe(fotos);
  });

  it("updateCompatDiagnostics também traduz — a armadilha é a mesma", async () => {
    // Hoje nenhum caller passa null aqui (produção tem ZERO resíduo nesta
    // coluna), então este teste guarda um caso que ainda não aconteceu.
    await ListingRepository.updateCompatDiagnostics("L1", null);
    expect(chamada().data.compatDiagnostics).toBe(Prisma.DbNull);

    vi.clearAllMocks();
    const diag = { enviados: 3, gravados: 0 };
    await ListingRepository.updateCompatDiagnostics("L1", diag);
    expect(chamada().data.compatDiagnostics).toBe(diag);
  });

  it("override ESCALAR limpo continua indo como `null`", async () => {
    // Contraprova: a tradução não pode vazar para os campos que não são Json.
    await ListingRepository.updateListing("L1", {
      titleOverride: null,
      priceOverride: null,
      sourceVehicleOverride: null,
    });

    const { data } = chamada();
    expect(data.titleOverride).toBeNull();
    expect(data.priceOverride).toBeNull();
    expect(data.sourceVehicleOverride).toBeNull();
  });
});

describe("clearOverridesForEditedFields — editar a peça limpa o override", () => {
  /** Chama o método real (privado em tipo, não em runtime). */
  const limpar = async (
    oldProduct: Record<string, unknown>,
    data: Record<string, unknown>,
  ) => {
    const uc = new ProductUseCase();
    await (
      uc as unknown as {
        clearOverridesForEditedFields: (
          id: string,
          o: unknown,
          d: unknown,
        ) => Promise<void>;
      }
    ).clearOverridesForEditedFields("prod-1", oldProduct, data);
    return (
      prisma.productListing.updateMany as unknown as {
        mock: { calls: unknown[][] };
      }
    ).mock.calls[0]?.[0] as { data: Record<string, unknown> } | undefined;
  };

  it("mudar as fotos da peça limpa o override com DbNull", async () => {
    const arg = await limpar(
      { name: "Cubo", imageUrls: ["a.jpg"], attributes: { OEM: { value_name: "1" } } },
      { imageUrls: ["b.jpg"] },
    );
    expect(arg?.data.imageUrlsOverride).toBe(Prisma.DbNull);
  });

  it("mudar a ficha técnica limpa o override com DbNull", async () => {
    const arg = await limpar(
      { name: "Cubo", imageUrls: ["a.jpg"], attributes: { OEM: { value_name: "1" } } },
      { attributes: { OEM: { value_name: "2" } } },
    );
    expect(arg?.data.attributesOverride).toBe(Prisma.DbNull);
  });

  it("⚠️ TODOS os 17 overrides escalares continuam sendo limpos com `null`", async () => {
    // Esta é a contraprova que impede a correção de virar um estrago maior:
    // `Prisma.DbNull` num campo `String?` é erro de validação do Prisma, não um
    // nulo. Se `comNulosDeJsonSeguros` um dia virar heurística ("todo campo que
    // termina em Override") em vez de lista explícita, é aqui que quebra.
    //
    // ⚠️ Dispara os 19 gatilhos DE UMA VEZ, de propósito. Uma versão anterior
    // deste teste mexia em 3 campos e ainda assim se anunciava como a
    // contraprova dos escalares — cobria 3 de 17 e o nome prometia 17.
    const arg = await limpar(
      {
        name: "Cubo", description: "desc", price: 10, brand: "VW", model: "Gol",
        year: "2010", version: "1.0", category: "Suspensão",
        mlCategoryId: "MLB1", shopeeCategoryId: "SH1", partNumber: "PN1",
        quality: "USADO", heightCm: 1, widthCm: 1, lengthCm: 1, weightKg: 1,
        imageUrls: ["a.jpg"], attributes: { OEM: { value_name: "1" } },
        sourceVehicle: "Gol 2010",
      },
      {
        name: "Cubo novo", description: "outra", price: 20, brand: "Ford",
        model: "Ka", year: "2011", version: "1.6", category: "Freio",
        mlCategoryId: "MLB2", shopeeCategoryId: "SH2", partNumber: "PN2",
        quality: "NOVO", heightCm: 2, widthCm: 2, lengthCm: 2, weightKg: 2,
        imageUrls: ["b.jpg"], attributes: { OEM: { value_name: "2" } },
        sourceVehicle: "Ka 2011",
      },
    );

    const campos = Object.entries(arg?.data ?? {});
    const json = campos.filter(([k]) =>
      (COLUNAS_JSON_DE_PRODUCT_LISTING as readonly string[]).includes(k),
    );
    const escalares = campos.filter(
      ([k]) => !(COLUNAS_JSON_DE_PRODUCT_LISTING as readonly string[]).includes(k),
    );

    // A contagem é parte da asserção: se um `*Override` novo entrar na lista do
    // usecase, este número muda e o comentário de lá precisa ser revisto junto.
    expect(campos.length, "campos limpos de uma vez").toBe(19);
    expect(json.length, "colunas Json").toBe(2);
    expect(escalares.length, "colunas escalares").toBe(17);

    for (const [chave, valor] of json) {
      expect(valor, `Json ${chave}`).toBe(Prisma.DbNull);
    }
    for (const [chave, valor] of escalares) {
      expect(valor, `escalar ${chave}`).toBeNull();
    }
  });
});

/**
 * Extrai do `schema.prisma` os campos do model que são `Json?` — NULÁVEIS.
 *
 * ⚠️ O `?` é OBRIGATÓRIO na regex, e isso é uma decisão, não descuido. O tipo
 * de input do Prisma é diferente para cada caso (conferido no client gerado):
 *
 *   coluna `Json?`  →  NullableJsonNullValueInput = { DbNull, JsonNull }
 *   coluna `Json`   →  JsonNullValueInput         = {         JsonNull }
 *
 * Ou seja: `Prisma.DbNull` **não é aceito** numa coluna Json obrigatória. Se a
 * regex casasse `Json` sem `?`, a asserção de igualdade abaixo OBRIGARIA o
 * mantenedor a pôr essa coluna na lista — e a tradução passaria a gravar um
 * valor inválido, com erro de validação em runtime. A guarda estaria empurrando
 * para a resposta errada.
 *
 * `Json[]` (lista escalar) também fica de fora, e também de propósito: lista
 * escalar do Prisma não aceita `null`, então não há resíduo possível nela.
 */
function extrairJsonNulaveis(corpoDoModel: string): string[] {
  return corpoDoModel
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .map((l) => l.match(/^\s*(\w+)\s+Json\?(\s|$)/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1])
    .sort();
}

function camposJsonNulaveisDoSchema(model: string): string[] {
  const schema = fs.readFileSync(
    path.resolve(__dirname, "..", "prisma", "schema.prisma"),
    "utf8",
  );
  const bloco = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`));
  if (!bloco) throw new Error(`model ${model} não encontrado no schema`);
  return extrairJsonNulaveis(bloco[1]);
}

describe("guarda de deriva: a lista de colunas Json x o schema", () => {
  it("cobre exatamente os campos `Json?` do model ProductListing", () => {
    // O modo de falha que isto previne: alguém acrescenta uma coluna `Json?`
    // ao model, o código passa a limpá-la com `null`, e o literal JSON `null`
    // volta a entrar no banco — sem erro, sem log, sem teste vermelho.
    const doSchema = camposJsonNulaveisDoSchema("ProductListing");
    expect(doSchema.length).toBeGreaterThan(0);
    expect([...COLUNAS_JSON_DE_PRODUCT_LISTING].sort()).toEqual(doSchema);
  });

  it("a extração ignora `Json` obrigatório e `Json[]` — e sabe por quê", () => {
    // ⚠️ GUARDA DA PRÓPRIA GUARDA, e usa a MESMA função da asserção acima —
    // não uma cópia da regex. Uma versão anterior deste teste duplicava a
    // expressão aqui dentro: a regex de verdade podia ser "simplificada" de
    // volta para `Json\??` sem nada ficar vermelho, porque este teste estava
    // exercitando a cópia, não o original.
    expect(extrairJsonNulaveis("  campoNulavel   Json?")).toEqual(["campoNulavel"]);
    expect(extrairJsonNulaveis('  campoNulavel   Json?   @map("x")')).toEqual([
      "campoNulavel",
    ]);
    // obrigatório: `Prisma.DbNull` não é aceito lá (o input type é
    // JsonNullValueInput, só com JsonNull), então NÃO pode entrar na lista
    expect(extrairJsonNulaveis("  campoObrigat   Json")).toEqual([]);
    expect(extrairJsonNulaveis('  campoObrigat   Json    @default("{}")')).toEqual([]);
    // lista escalar: não aceita null, não há resíduo possível
    expect(extrairJsonNulaveis("  campoLista     Json[]")).toEqual([]);
    // comentário citando Json? não pode virar campo
    expect(extrairJsonNulaveis("  // campoFalso  Json?")).toEqual([]);
  });
});
