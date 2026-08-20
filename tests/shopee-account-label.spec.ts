// Rótulo das contas Shopee: nome da loja no lugar do Shopee ID.
//
// O que este spec trava:
//
//  1. O FALLBACK NÃO PODE SUMIR. Se a API da Shopee não responder (6 das 35
//     contas em produção estão com token inválido), a conta tem de continuar
//     com o rótulo histórico e a conexão tem de concluir. Perder o nome é
//     aceitável; perder a conta, não.
//  2. A MARCA NÃO PODE DUPLICAR. "Shopee Autopeças" não vira
//     "SHOPEE Shopee Autopeças".
//  3. O GENÉRICO TEM DE SER RECONHECÍVEL. É o que impede a auto-cura de
//     escrever por cima de um nome que alguém escolheu à mão.

import { describe, it, expect } from "vitest";

import {
  isGenericShopeeAccountName,
  nextShopeeAccountName,
  shopeeAccountLabel,
  shopeeFallbackAccountName,
} from "../app/marketplaces/lib/shopee-account-label";

const SHOP_ID = 1547916297; // uma das contas reais de produção

describe("shopeeAccountLabel — o nome da loja, com a marca na frente", () => {
  it("nome normal ganha o prefixo SHOPEE", () => {
    expect(shopeeAccountLabel("JOTABE AUTOPECAS", SHOP_ID)).toBe(
      "SHOPEE JOTABE AUTOPECAS",
    );
  });

  it("PRESERVA a caixa do nome — só o prefixo é maiúsculo", () => {
    // Forçar toUpperCase destruiria o que a Shopee devolveu.
    expect(shopeeAccountLabel("Jotabe Autopeças", SHOP_ID)).toBe(
      "SHOPEE Jotabe Autopeças",
    );
  });

  it("NÃO duplica a marca quando a loja já se chama Shopee alguma coisa", () => {
    expect(shopeeAccountLabel("Shopee Autopeças", SHOP_ID)).toBe(
      "SHOPEE Autopeças",
    );
    expect(shopeeAccountLabel("shopee moto peças", SHOP_ID)).toBe(
      "SHOPEE moto peças",
    );
    expect(shopeeAccountLabel("SHOPEE Xaxim", SHOP_ID)).toBe("SHOPEE Xaxim");
  });

  it("'Shopeeiros' NÃO é a marca — o \\b evita comer o começo do nome", () => {
    expect(shopeeAccountLabel("Shopeeiros Auto", SHOP_ID)).toBe(
      "SHOPEE Shopeeiros Auto",
    );
  });

  it("espaço em volta é aparado", () => {
    expect(shopeeAccountLabel("  Xaxim Pecas  ", SHOP_ID)).toBe(
      "SHOPEE Xaxim Pecas",
    );
  });

  it("FALLBACK: sem nome, mantém exatamente o rótulo histórico", () => {
    // Byte a byte igual ao que `marketplace.usercase` gravava antes — é o que
    // garante que uma conta cujo token morreu não fique sem rótulo.
    const historico = `Shopee Shop ${SHOP_ID}`;
    expect(shopeeAccountLabel(undefined, SHOP_ID)).toBe(historico);
    expect(shopeeAccountLabel(null, SHOP_ID)).toBe(historico);
    expect(shopeeAccountLabel("", SHOP_ID)).toBe(historico);
    expect(shopeeAccountLabel("   ", SHOP_ID)).toBe(historico);
    expect(shopeeFallbackAccountName(SHOP_ID)).toBe(historico);
  });

  it("nenhum rótulo produzido é o Shopee ID cru", () => {
    for (const nome of ["Loja A", "shopee b", "  C  "]) {
      expect(shopeeAccountLabel(nome, SHOP_ID)).not.toContain(String(SHOP_ID));
    }
  });
});

describe("isGenericShopeeAccountName — protege o nome escolhido a dedo", () => {
  it("reconhece o rótulo que 35/35 contas de produção tinham", () => {
    expect(isGenericShopeeAccountName("Shopee Shop 1547916297")).toBe(true);
    expect(isGenericShopeeAccountName("Shopee Shop 690138776")).toBe(true);
  });

  it("nome já corrigido NÃO é genérico — a auto-cura não o sobrescreve", () => {
    expect(isGenericShopeeAccountName("SHOPEE JOTABE AUTOPECAS")).toBe(false);
    expect(isGenericShopeeAccountName("Loja do Ze")).toBe(false);
  });

  it("não confunde variações parecidas com o genérico", () => {
    expect(isGenericShopeeAccountName("Shopee Shop")).toBe(false);
    expect(isGenericShopeeAccountName("Shopee Shop abc")).toBe(false);
    expect(isGenericShopeeAccountName("Minha Shopee Shop 123")).toBe(false);
    expect(isGenericShopeeAccountName(null)).toBe(false);
    expect(isGenericShopeeAccountName(undefined)).toBe(false);
  });

  it("o que o fallback produz É reconhecido como genérico (ida e volta)", () => {
    // Sem isto, uma conta que caiu no fallback nunca seria curada depois.
    expect(isGenericShopeeAccountName(shopeeFallbackAccountName(SHOP_ID))).toBe(
      true,
    );
    expect(isGenericShopeeAccountName(shopeeAccountLabel(null, SHOP_ID))).toBe(
      true,
    );
  });
});

// A regra composta da auto-cura, no lugar em que a rota e o script a leem.
describe("nextShopeeAccountName — quando (e se) renomear", () => {
  const GENERICO = `Shopee Shop ${SHOP_ID}`;

  it("generico + nome descoberto ⇒ renomeia", () => {
    expect(nextShopeeAccountName(GENERICO, "Jotabe", SHOP_ID)).toBe(
      "SHOPEE Jotabe",
    );
  });

  it("nome escolhido a mao NUNCA e sobrescrito, mesmo com a API respondendo", () => {
    expect(nextShopeeAccountName("Loja do Ze", "Jotabe", SHOP_ID)).toBeNull();
    expect(
      nextShopeeAccountName("SHOPEE Jotabe", "Outro Nome", SHOP_ID),
    ).toBeNull();
  });

  it("API sem nome ⇒ NAO grava (evita um UPDATE por ciclo gravando o mesmo)", () => {
    expect(nextShopeeAccountName(GENERICO, undefined, SHOP_ID)).toBeNull();
    expect(nextShopeeAccountName(GENERICO, "", SHOP_ID)).toBeNull();
    expect(nextShopeeAccountName(GENERICO, "   ", SHOP_ID)).toBeNull();
  });

  it("IDEMPOTENTE: aplicar duas vezes nao produz segunda escrita", () => {
    const primeiro = nextShopeeAccountName(GENERICO, "Jotabe", SHOP_ID)!;
    expect(primeiro).toBe("SHOPEE Jotabe");
    expect(nextShopeeAccountName(primeiro, "Jotabe", SHOP_ID)).toBeNull();
  });
});
