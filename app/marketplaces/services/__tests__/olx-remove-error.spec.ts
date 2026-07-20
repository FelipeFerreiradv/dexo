import { describe, it, expect } from "vitest";
import { classifyOlxRemoveError } from "../listing-removal.helpers";

describe("classifyOlxRemoveError", () => {
  it("trata delete accepted / id inexistente como idempotente", () => {
    expect(classifyOlxRemoveError(new Error("status accepted")).kind).toBe(
      "idempotent",
    );
    expect(classifyOlxRemoveError(new Error("ad_not_found")).kind).toBe(
      "idempotent",
    );
    expect(classifyOlxRemoveError({ status: 404, message: "x" }).kind).toBe(
      "idempotent",
    );
  });

  it("statusCode -4/-6 e REFUSED_* são permanentes", () => {
    expect(
      classifyOlxRemoveError({ olxStatusCode: -4, message: "validação" }).kind,
    ).toBe("permanent");
    expect(
      classifyOlxRemoveError({ olxStatusCode: -6, message: "sem plano" }).kind,
    ).toBe("permanent");
    expect(
      classifyOlxRemoveError(new Error("REFUSED_SUSPECT_PRICE")).kind,
    ).toBe("permanent");
    expect(classifyOlxRemoveError(new Error("NOT_ENOUGH_AD_SLOTS")).kind).toBe(
      "permanent",
    );
  });

  it("statusCode -1, 5xx, timeout e erros de imagem são retryable", () => {
    expect(
      classifyOlxRemoveError({ olxStatusCode: -1, message: "inesperado" }).kind,
    ).toBe("retryable");
    expect(classifyOlxRemoveError({ status: 503, message: "x" }).kind).toBe(
      "retryable",
    );
    expect(classifyOlxRemoveError(new Error("timeout")).kind).toBe("retryable");
    expect(
      classifyOlxRemoveError(new Error("ERROR_DOWNLOADING_IMAGE")).kind,
    ).toBe("retryable");
  });

  it("lê statusCode via responseData quando olxStatusCode ausente", () => {
    expect(
      classifyOlxRemoveError({
        responseData: { statusCode: -6 },
        message: "sem permissão",
      }).kind,
    ).toBe("permanent");
  });

  it("erro desconhecido → permanent (não deleta local por engano)", () => {
    expect(classifyOlxRemoveError(new Error("algo estranho")).kind).toBe(
      "permanent",
    );
  });
});
