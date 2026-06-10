import { describe, expect, it, vi } from "vitest";
import {
  classifyMLRemoveError,
  classifyShopeeRemoveError,
  withRetry,
} from "../app/marketplaces/services/listing-removal.helpers";

describe("classifyMLRemoveError", () => {
  it("classifies 404 as idempotent", () => {
    const err = Object.assign(new Error("Erro ao atualizar item: not found"), {
      status: 404,
    });
    expect(classifyMLRemoveError(err)).toMatchObject({ kind: "idempotent" });
  });

  it("classifies 'already closed' message as idempotent regardless of status", () => {
    const err = Object.assign(
      new Error("Erro ao atualizar item: item is already closed"),
      { status: 400 },
    );
    expect(classifyMLRemoveError(err)).toMatchObject({ kind: "idempotent" });
  });

  it("classifies 'cannot be modified' as idempotent", () => {
    const err = new Error(
      "Erro ao atualizar item: cannot be modified (already finalized)",
    );
    expect(classifyMLRemoveError(err)).toMatchObject({ kind: "idempotent" });
  });

  it("classifies ML 'item.status.not_modifiable' + status:inactive as idempotent (regression: deleção falhava para items já inativos no ML)", () => {
    // Erro EXATO retornado pelo ML quando o item está em estado terminal
    // `inactive` e tentamos PUT /items/{id} {status: closed}. Antes do fix
    // este erro era classificado como `permanent` e bloqueava a deleção
    // local — frustrando o usuário que via "Cannot update item" no toast.
    const err = Object.assign(
      new Error(
        "Erro ao atualizar item: Cannot update item MLB4358822301 [status:inactive, has_bids:false] (validation_error | item.status.not_modifiable: status is not modifiable.)",
      ),
      { status: 400 },
    );
    expect(classifyMLRemoveError(err)).toMatchObject({ kind: "idempotent" });
  });

  it("classifies 'status:closed' bracket marker as idempotent (alternative ML status format)", () => {
    const err = Object.assign(
      new Error(
        "Erro ao atualizar item: Cannot update item MLB1234567890 [status:closed, has_bids:true]",
      ),
      { status: 400 },
    );
    expect(classifyMLRemoveError(err)).toMatchObject({ kind: "idempotent" });
  });

  it("classifies 'not modifiable' as idempotent regardless of bracket presence", () => {
    const err = Object.assign(
      new Error("Erro ao atualizar item: status is not modifiable"),
      { status: 400 },
    );
    expect(classifyMLRemoveError(err)).toMatchObject({ kind: "idempotent" });
  });

  it("classifies 429 as retryable", () => {
    const err = Object.assign(new Error("Erro ao atualizar item: rate limit"), {
      status: 429,
    });
    expect(classifyMLRemoveError(err)).toMatchObject({ kind: "retryable" });
  });

  it("classifies 5xx as retryable", () => {
    const err = Object.assign(new Error("Erro ao atualizar item: bad gateway"), {
      status: 502,
    });
    expect(classifyMLRemoveError(err)).toMatchObject({ kind: "retryable" });
  });

  it("classifies network/timeout errors as retryable via code", () => {
    const err = Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:443"), {
      code: "ETIMEDOUT",
    });
    expect(classifyMLRemoveError(err)).toMatchObject({ kind: "retryable" });
  });

  it("classifies generic 4xx as permanent", () => {
    const err = Object.assign(
      new Error("Erro ao atualizar item: invalid token"),
      { status: 401 },
    );
    expect(classifyMLRemoveError(err)).toMatchObject({ kind: "permanent" });
  });

  it("classifies unknown errors as permanent", () => {
    expect(classifyMLRemoveError(new Error("something weird"))).toMatchObject({
      kind: "permanent",
    });
  });
});

describe("classifyShopeeRemoveError", () => {
  it("classifies error_inexist as idempotent", () => {
    const err = Object.assign(new Error("Erro ao deletar item: item inexist"), {
      shopeeError: "error_inexist",
    });
    expect(classifyShopeeRemoveError(err)).toMatchObject({
      kind: "idempotent",
    });
  });

  it("classifies product.error_inexist as idempotent", () => {
    const err = Object.assign(
      new Error("Erro ao deletar item: item does not exist"),
      { shopeeError: "product.error_inexist" },
    );
    expect(classifyShopeeRemoveError(err)).toMatchObject({
      kind: "idempotent",
    });
  });

  it("classifies 5xx as retryable", () => {
    const err = Object.assign(new Error("Shopee API 500: server error"), {
      status: 500,
    });
    expect(classifyShopeeRemoveError(err)).toMatchObject({ kind: "retryable" });
  });

  it("classifies error.system shopee codes as retryable", () => {
    const err = Object.assign(new Error("Erro ao deletar item"), {
      shopeeError: "error.system",
    });
    expect(classifyShopeeRemoveError(err)).toMatchObject({ kind: "retryable" });
  });

  it("classifies network timeout as retryable", () => {
    const err = Object.assign(new Error("connect ECONNABORTED"), {
      code: "ECONNABORTED",
    });
    expect(classifyShopeeRemoveError(err)).toMatchObject({ kind: "retryable" });
  });

  it("classifies generic shopee error as permanent", () => {
    const err = Object.assign(new Error("Erro ao deletar item: invalid sig"), {
      shopeeError: "error.auth",
    });
    expect(classifyShopeeRemoveError(err)).toMatchObject({ kind: "permanent" });
  });
});

describe("withRetry", () => {
  it("returns immediately on success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await withRetry(fn, {
      classify: () => ({ kind: "retryable", message: "" }),
      sleep,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rethrows immediately on permanent error without retry", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("permanent"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      withRetry(fn, {
        classify: () => ({ kind: "permanent", message: "permanent" }),
        sleep,
      }),
    ).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rethrows immediately on idempotent error without retry", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("already closed"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      withRetry(fn, {
        classify: () => ({ kind: "idempotent", message: "already closed" }),
        sleep,
      }),
    ).rejects.toThrow("already closed");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries up to 3 times on retryable error with exponential backoff", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("retry me"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      withRetry(fn, {
        classify: () => ({ kind: "retryable", message: "retry" }),
        sleep,
        baseDelayMs: 500,
      }),
    ).rejects.toThrow("retry me");
    expect(fn).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 500);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
    expect(sleep).toHaveBeenNthCalledWith(3, 8000);
  });

  it("succeeds on a retry attempt after transient failures", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("done");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await withRetry(fn, {
      classify: () => ({ kind: "retryable", message: "transient" }),
      sleep,
    });
    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
