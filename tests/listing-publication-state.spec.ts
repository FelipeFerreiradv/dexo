import { describe, it, expect } from "vitest";
import {
  derivePublicationState,
  INTERRUPTED_AFTER_MS,
} from "../app/produtos/lib/listing-publication-state";
import {
  formatListingError,
  splitListingErrorMarkers,
} from "../app/produtos/lib/listing-error-format";

const NOW = new Date("2026-09-22T20:00:00.000Z");
const FAMILY_NAME_RAW =
  'Erro ao criar item: {"cause":[{"department":"items","cause_id":369,"type":"error","code":"body.required_fields","references":["body"],"message":"The body does not contains some or none of the following properties [family_name]"}],"message":"body.required_fields","error":"validation_error","status":400}';

describe("derivePublicationState", () => {
  it("anúncio no ar é publicado", () => {
    expect(
      derivePublicationState({ status: "active", externalListingId: "MLB1" }, NOW)
        .state,
    ).toBe("published");
  });

  it("id real + status vivo vence marcador velho de republicação revertida", () => {
    const v = derivePublicationState(
      {
        status: "active",
        externalListingId: "MLB1",
        lastError: "[TERMINAL][CORRIGIVEL] qualquer coisa",
      },
      NOW,
    );
    expect(v.state).toBe("sync_error");
    expect(v.canRetry).toBe(false);
  });

  it("placeholder com dado a corrigir", () => {
    const v = derivePublicationState(
      {
        status: "error",
        externalListingId: "PENDING_1",
        lastError: "[TERMINAL][CORRIGIVEL] O campo GTIN…",
        retryEnabled: false,
      },
      NOW,
    );
    expect(v.state).toBe("needs_fix");
    expect(v.canRetry).toBe(true);
  });

  it("[TERMINAL] legado também pede correção", () => {
    expect(
      derivePublicationState(
        {
          status: "error",
          externalListingId: "PENDING_1",
          lastError: "[TERMINAL] Produto sem preço",
        },
        NOW,
      ).state,
    ).toBe("needs_fix");
  });

  it("conta a reconectar (marcador novo e mensagem do PolicyAgent)", () => {
    expect(
      derivePublicationState(
        {
          status: "error",
          externalListingId: "PENDING_1",
          lastError: "[TERMINAL][RECONECTAR] Reconecte a conta",
        },
        NOW,
      ).state,
    ).toBe("auth_required");
    expect(
      derivePublicationState(
        {
          status: "error",
          externalListingId: "PENDING_1",
          lastError:
            "Conta do Mercado Livre sem permissão para publicar (PolicyAgent).",
        },
        NOW,
      ).state,
    ).toBe("auth_required");
  });

  it("falha passageira com nova tentativa marcada", () => {
    const v = derivePublicationState(
      {
        status: "error",
        externalListingId: "PENDING_1",
        lastError: "timeout",
        retryEnabled: true,
        nextRetryAt: new Date(NOW.getTime() + 60_000),
      },
      NOW,
    );
    expect(v.state).toBe("retry_scheduled");
    expect(v.canRetry).toBe(false);
  });

  it("erro sem retry e sem marcador (legado) = tentativas esgotadas", () => {
    const v = derivePublicationState(
      {
        status: "error",
        externalListingId: "PENDING_1",
        lastError: FAMILY_NAME_RAW,
        retryEnabled: false,
      },
      NOW,
    );
    expect(v.state).toBe("failed");
    expect(v.canRetry).toBe(true);
  });

  it("pending recente é 'aguardando publicação'", () => {
    expect(
      derivePublicationState(
        {
          status: "pending",
          externalListingId: "PENDING_1",
          updatedAt: new Date(NOW.getTime() - 60_000),
        },
        NOW,
      ).state,
    ).toBe("publishing");
  });

  it("pending parado há mais de 30 min sem retry = interrompida", () => {
    expect(
      derivePublicationState(
        {
          status: "pending",
          externalListingId: "PENDING_1",
          retryEnabled: false,
          updatedAt: new Date(NOW.getTime() - INTERRUPTED_AFTER_MS - 1),
        },
        NOW,
      ).state,
    ).toBe("interrupted");
  });
});

describe("formatListingError", () => {
  it("vazio ⇒ null", () => {
    expect(formatListingError(null)).toBeNull();
    expect(formatListingError("  ")).toBeNull();
  });

  it("remove marcadores e mantém o texto humano", () => {
    expect(
      formatListingError("[TERMINAL][CORRIGIVEL] Preencha o campo Marca."),
    ).toEqual({
      summary: "Preencha o campo Marca.",
      technical: null,
      markers: ["TERMINAL", "CORRIGIVEL"],
    });
  });

  it("linha de outra plataforma com JSON não vira 'Mercado Livre recusou'", () => {
    const shopeeJson =
      'Erro ao criar item: {"error":"product.error_busi","message":"item name too long"}';
    expect(formatListingError(shopeeJson, "SHOPEE")).toEqual({
      summary: shopeeJson,
      technical: null,
      markers: [],
    });
  });

  it("texto que não é JSON volta intacto (Shopee usa o mesmo prefixo)", () => {
    const shopee = "Erro ao criar item: item name too long";
    expect(formatListingError(shopee)?.summary).toBe(shopee);
    expect(formatListingError(shopee)?.technical).toBeNull();
  });

  it("JSON legado só com family_name vira frase honesta + detalhe técnico", () => {
    const f = formatListingError(FAMILY_NAME_RAW)!;
    expect(f.summary).toMatch(/motivo real não ficou registrado/);
    expect(f.summary).not.toMatch(/cause_id|\{/);
    expect(f.technical).toBe(FAMILY_NAME_RAW);
  });

  it("JSON legado com causa reconhecida usa a tradução existente", () => {
    const raw =
      'Erro ao criar item: {"cause":[{"cause_id":7711,"type":"error","code":"item.attribute.product_identifier.invalid_format","message":"Product Identifier [GTIN] contains values with invalid format: [754243m6a]"}],"status":400}';
    expect(formatListingError(raw)?.summary).toMatch(/GTIN.*754243m6a/);
  });

  it("JSON com causa desconhecida mostra a mensagem do ML e o código", () => {
    const raw =
      'Erro ao criar item: {"cause":[{"cause_id":9999,"type":"error","message":"Something odd"}],"status":400}';
    expect(formatListingError(raw)?.summary).toBe(
      "O Mercado Livre recusou a publicação: Something odd (código 9999).",
    );
  });
});

describe("splitListingErrorMarkers", () => {
  it("sem marcador", () => {
    expect(splitListingErrorMarkers("abc")).toEqual({ markers: [], text: "abc" });
  });
  it("com marcadores", () => {
    expect(splitListingErrorMarkers("[TERMINAL] x")).toEqual({
      markers: ["TERMINAL"],
      text: "x",
    });
  });
});
