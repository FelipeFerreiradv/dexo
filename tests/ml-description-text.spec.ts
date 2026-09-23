import { describe, it, expect } from "vitest";
import {
  descriptionHasSymbols,
  isInvalidDescriptionCharError,
  MLDescriptionNotSavedError,
  sanitizeMLDescription,
} from "../app/marketplaces/lib/ml-description-text";

/**
 * Descrição com emoji ficava VAZIA no Mercado Livre (23/09/2026, SKU 7167 de
 * um cliente: "⚠️ ATENÇÃO E OBSERVAÇÕES IMPORTANTES" na descrição
 * padrão). Ver app/marketplaces/lib/ml-description-text.ts.
 */
describe("sanitizeMLDescription", () => {
  it("descrição comum volta IDÊNTICA (acento, pontuação, espaços, quebras, ©®™)", () => {
    const t =
      "Peça original — usada.\n\n• Garantia de 90 dias…  “testada”\nBosch® Magneti™ ©2024\n\tFim";
    for (const mode of ["basico", "estrito"] as const) {
      const r = sanitizeMLDescription(t, mode);
      expect(r.removed).toBe(0);
      expect(r.text).toBe(t);
    }
  });

  it("básico: tira o seletor de variação do ⚠️ e o emoji fora do plano básico (🚗)", () => {
    expect(sanitizeMLDescription("⚠️ ATENÇÃO: só hidráulica", "basico")).toEqual({
      text: "⚠ ATENÇÃO: só hidráulica",
      removed: 1,
    });
    expect(sanitizeMLDescription("🚗 Mercado das Peças ATUBA\n\nBem-vindo!", "basico")).toEqual({
      text: "Mercado das Peças ATUBA\n\nBem-vindo!",
      removed: 1,
    });
  });

  it("estrito: tira também os símbolos pictográficos do plano básico (⚠ ✅ ✔ ❌ ➡)", () => {
    const r = sanitizeMLDescription("⚠️ ATENÇÃO\n✅ Testada ✔ ok ❌ sem nota ➡ confira", "estrito");
    expect(r.text).toBe("ATENÇÃO\nTestada ok sem nota confira");
    expect(r.text).not.toMatch(/[←-⯿️]/);
  });

  it("básico mantém ✅ (plano básico, sem seletor); estrito tira", () => {
    expect(sanitizeMLDescription("✅ Testada", "basico").text).toBe("✅ Testada");
    expect(sanitizeMLDescription("✅ Testada", "estrito").text).toBe("Testada");
  });

  it("emoji composto (família com junção, tom de pele) e tecla 1️⃣ somem por inteiro", () => {
    expect(sanitizeMLDescription("Família 👨‍👩‍👧 feliz 👍🏽 item 1️⃣", "basico").text).toBe(
      "Família feliz item 1",
    );
  });

  it("letras 'em negrito' de rede social viram letras comuns (não somem)", () => {
    const r = sanitizeMLDescription("𝗣𝗘𝗖̧𝗔 𝗢𝗥𝗜𝗚𝗜𝗡𝗔𝗟 🚗\n𝐆𝐀𝐑𝐀𝐍𝐓𝐈𝐀 𝐃𝐄 𝟗𝟎 𝐃𝐈𝐀𝐒", "basico");
    expect(r.text).toBe("PEÇA ORIGINAL\nGARANTIA DE 90 DIAS");
  });

  it("espaço só é arrumado onde algo saiu: alinhamento e recuo do resto ficam", () => {
    const t = "🚗 Loja\nCódigo OEM:      12345\n    - item recuado\nPreço:\t\tR$ 10  ";
    expect(sanitizeMLDescription(t, "basico").text).toBe(
      "Loja\nCódigo OEM:      12345\n    - item recuado\nPreço:\t\tR$ 10  ",
    );
    // só o seletor sai: nada mais muda
    expect(sanitizeMLDescription("©️ Loja  ATUBA", "basico").text).toBe("© Loja  ATUBA");
  });

  it("emoji colado entre palavras vira um espaço; no fim da linha não deixa espaço sobrando", () => {
    expect(sanitizeMLDescription("Peça🚗Original", "basico").text).toBe("Peça Original");
    expect(sanitizeMLDescription("texto 🚗 mais", "basico").text).toBe("texto mais");
    expect(sanitizeMLDescription("fim 🚗\nfim 🚗", "basico").text).toBe("fim\nfim");
  });

  it("estrito tira também ★ ✓ ● ► → ≥ (símbolos que não são emoji)", () => {
    expect(sanitizeMLDescription("★ Top ✓ ok ● item ► seta → ≥ 2", "estrito").text).toBe(
      "Top ok item seta 2",
    );
  });

  it("vazio / nulo não quebra", () => {
    expect(sanitizeMLDescription("")).toEqual({ text: "", removed: 0 });
    expect(sanitizeMLDescription(null)).toEqual({ text: "", removed: 0 });
  });
});

describe("descriptionHasSymbols", () => {
  it("texto comum ⇒ false (não ganha leitura a mais no ML)", () => {
    expect(descriptionHasSymbols("Peça — usada • 90 dias… “ok” ®™©")).toBe(false);
  });
  it("símbolo ou emoji ⇒ true", () => {
    for (const t of ["⚠ atenção", "✅ ok", "🚗 loja", "seta ➡", "● item", "★ top"]) {
      expect(descriptionHasSymbols(t)).toBe(true);
    }
  });
  it("letra de outro alfabeto ou caractere invisível não é símbolo ⇒ false", () => {
    for (const t of ["部品 original", "\uFEFFPeça", "① item"]) {
      expect(descriptionHasSymbols(t)).toBe(false);
    }
  });
});

describe("isInvalidDescriptionCharError", () => {
  it("reconhece o erro de caractere do ML (cause 398)", () => {
    expect(
      isInvalidDescriptionCharError(
        new Error(
          'Erro ao atualizar descrição (PUT): {"cause":[{"cause_id":398,"code":"item.description.type.invalid","message":"The description must be in plain text"}]}',
        ),
      ),
    ).toBe(true);
    expect(isInvalidDescriptionCharError(new Error("401 invalid_token"))).toBe(false);
  });
});

describe("MLDescriptionNotSavedError", () => {
  it("guarda o motivo e diz que ficou VAZIA", () => {
    const e = new MLDescriptionNotSavedError("MLB1", "empty_after_write");
    expect(e).toBeInstanceOf(Error);
    expect(e.reason).toBe("empty_after_write");
    expect(e.message).toMatch(/MLB1 VAZIA/);
  });
});
