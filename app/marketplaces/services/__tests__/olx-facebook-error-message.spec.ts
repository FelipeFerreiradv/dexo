import { describe, expect, it } from "vitest";

import {
  formatMarketplaceError,
  humanizeMarketplaceError,
} from "../olx-facebook-error-message.service";

describe("humanizeMarketplaceError — OLX", () => {
  it("traduz o statusCode -4 (validação de conteúdo)", () => {
    const msg = humanizeMarketplaceError(
      "OLX",
      "OLX recusou o import: statusCode -4",
    );
    expect(msg).toMatch(/validação de conteúdo/i);
  });

  it("traduz o statusCode -6 (permissão/plano)", () => {
    expect(
      humanizeMarketplaceError("OLX", "OLX recusou o import: statusCode -6"),
    ).toMatch(/permissão/i);
  });

  it("traduz REFUSED_SUSPECT_PRICE", () => {
    expect(
      humanizeMarketplaceError("OLX", "OLX recusou o anúncio: REFUSED_SUSPECT_PRICE"),
    ).toMatch(/preço suspeito/i);
  });

  it("traduz falta de vaga no plano", () => {
    expect(
      humanizeMarketplaceError("OLX", "NOT_ENOUGH_AD_SLOTS"),
    ).toMatch(/vagas de anúncio/i);
  });
});

describe("humanizeMarketplaceError — Facebook", () => {
  it("traduz token expirado/revogado", () => {
    expect(
      humanizeMarketplaceError(
        "FACEBOOK",
        'Erro: [{"message":"Error validating access token: Session has expired"}]',
      ),
    ).toMatch(/token do facebook expirou/i);
  });

  it("traduz Invalid parameter", () => {
    expect(
      humanizeMarketplaceError(
        "FACEBOOK",
        'Facebook rejeitou o item: [{"message":"Invalid parameter"}]',
      ),
    ).toMatch(/recusou algum campo/i);
  });

  it("traduz limite de chamadas", () => {
    expect(
      humanizeMarketplaceError("FACEBOOK", "(#4) Too many calls"),
    ).toMatch(/limite de chamadas/i);
  });
});

describe("conservadorismo", () => {
  it("plataforma sem regras devolve null (ML/Shopee/Magalu intocados)", () => {
    expect(
      humanizeMarketplaceError("MERCADO_LIVRE", "statusCode -4"),
    ).toBeNull();
    expect(humanizeMarketplaceError("SHOPEE", "Invalid parameter")).toBeNull();
    expect(humanizeMarketplaceError("MAGALU", "qualquer coisa")).toBeNull();
  });

  it("erro não reconhecido devolve null", () => {
    expect(
      humanizeMarketplaceError("OLX", "algo totalmente inesperado aqui"),
    ).toBeNull();
  });

  it("formatMarketplaceError preserva o texto original quando não traduz", () => {
    const cru = "algo totalmente inesperado aqui";
    expect(formatMarketplaceError("OLX", cru)).toBe(cru);
  });

  it("formatMarketplaceError mantém o detalhe técnico junto da tradução", () => {
    const out = formatMarketplaceError("OLX", "statusCode -4");
    expect(out).toMatch(/validação de conteúdo/i);
    expect(out).toContain("statusCode -4");
  });
});
