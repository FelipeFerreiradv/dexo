import { describe, it, expect } from "vitest";
import { classifyFacebookRemoveError } from "../listing-removal.helpers";

function err(
  message: string,
  extra: { status?: number; code?: string; graphCode?: number } = {},
) {
  const e = new Error(message) as any;
  if (extra.status != null) e.status = extra.status;
  if (extra.code) e.code = extra.code;
  if (extra.graphCode != null) {
    e.responseData = { error: { code: extra.graphCode } };
  }
  return e;
}

describe("classifyFacebookRemoveError", () => {
  it("404 / not found → idempotent (já removido)", () => {
    expect(classifyFacebookRemoveError(err("x", { status: 404 })).kind).toBe(
      "idempotent",
    );
    expect(classifyFacebookRemoveError(err("Item does not exist")).kind).toBe(
      "idempotent",
    );
  });

  it("429 e rate-limit codes da Graph → retryable", () => {
    expect(classifyFacebookRemoveError(err("x", { status: 429 })).kind).toBe(
      "retryable",
    );
    for (const graphCode of [4, 17, 32, 613]) {
      expect(classifyFacebookRemoveError(err("rate", { graphCode })).kind).toBe(
        "retryable",
      );
    }
  });

  it("5xx / timeout / network → retryable", () => {
    expect(classifyFacebookRemoveError(err("x", { status: 503 })).kind).toBe(
      "retryable",
    );
    expect(
      classifyFacebookRemoveError(err("x", { code: "ETIMEDOUT" })).kind,
    ).toBe("retryable");
    expect(classifyFacebookRemoveError(err("socket hang up")).kind).toBe(
      "retryable",
    );
  });

  it("400/401 validação/token → permanent", () => {
    expect(classifyFacebookRemoveError(err("bad", { status: 400 })).kind).toBe(
      "permanent",
    );
    expect(
      classifyFacebookRemoveError(err("OAuthException", { status: 401 })).kind,
    ).toBe("permanent");
  });
});
