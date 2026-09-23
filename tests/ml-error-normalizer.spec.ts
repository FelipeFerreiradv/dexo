import { describe, it, expect } from "vitest";
import { normalizeMLError } from "../app/marketplaces/lib/ml-error-normalizer";

/** Erro como o MLApiService.createItem lança: Error + `mlError` = corpo do ML. */
function mlErr(body: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(`Erro ao criar item: ${JSON.stringify(body)}`), {
    mlError: body,
    ...extra,
  });
}

describe("normalizeMLError", () => {
  it("400 required_fields (family_name) ⇒ VALIDATION, não retentável, campo extraído", () => {
    const n = normalizeMLError({
      err: mlErr({
        cause: [
          {
            cause_id: 369,
            type: "error",
            code: "body.required_fields",
            message:
              "The body does not contains some or none of the following properties [family_name]",
          },
        ],
        message: "body.required_fields",
        error: "validation_error",
        status: 400,
      }),
      step: "initial",
      categoryId: "MLB192571",
    });
    expect(n).toMatchObject({
      provider: "mercadolivre",
      operation: "create_item",
      kind: "VALIDATION",
      httpStatus: 400,
      code: "validation_error",
      causeIds: [369],
      causeCodes: ["body.required_fields"],
      fields: ["family_name"],
      retryable: false,
      userActionRequired: true,
      timedOut: false,
      step: "initial",
      categoryId: "MLB192571",
    });
  });

  it("avisos (306/4053) não entram nas causas nem nos campos", () => {
    const n = normalizeMLError({
      err: mlErr({
        status: 400,
        cause: [
          {
            cause_id: 3702,
            type: "error",
            code: "item.attribute.invalid_sanitary_registry_value",
            message: 'O valor que você inseriu em "Número de registro/certificação INMETRO" está incorreto.',
          },
          {
            cause_id: 306,
            type: "warning",
            code: "item.attributes.omitted",
            message: "Attribute INLET_CONNECTION_DIAMETER with value 1 was omitted.",
          },
        ],
      }),
    });
    expect(n.kind).toBe("VALIDATION");
    expect(n.causeIds).toEqual([3702]);
    expect(n.fields).not.toContain("INLET_CONNECTION_DIAMETER");
  });

  it("attributes required (147) extrai todos os campos citados", () => {
    const n = normalizeMLError({
      err: mlErr({
        status: 400,
        cause: [
          {
            cause_id: 147,
            type: "error",
            code: "item.attributes.missing_required",
            message:
              "The attributes [BRAND, PART_NUMBER] are required for category MLB63463 and channel marketplace.",
          },
        ],
      }),
    });
    expect(n.fields).toEqual(["BRAND", "PART_NUMBER"]);
  });

  it("3706 (reenvie a foto) é TRANSIENT, retentável", () => {
    const n = normalizeMLError({
      err: mlErr({
        status: 400,
        cause: [
          {
            cause_id: 3706,
            type: "error",
            code: "item.pictures.unavailable",
            message: "Ocorreu um erro ao processar a foto. Por favor, envie-a novamente.",
          },
        ],
      }),
    });
    expect(n.kind).toBe("TRANSIENT");
    expect(n.retryable).toBe(true);
    expect(n.userActionRequired).toBe(false);
  });

  it("3706 junto de um erro de dado continua VALIDATION", () => {
    const n = normalizeMLError({
      err: mlErr({
        status: 400,
        cause: [
          { cause_id: 3706, type: "error", message: "foto" },
          { cause_id: 7711, type: "error", message: "GTIN" },
        ],
      }),
    });
    expect(n.kind).toBe("VALIDATION");
  });

  it("400 sem causa (title inválido com cause:[]) ⇒ VALIDATION", () => {
    const n = normalizeMLError({
      err: mlErr({ status: 400, error: "body.invalid_fields", cause: [] }),
    });
    expect(n.kind).toBe("VALIDATION");
  });

  it("401 ⇒ AUTH", () => {
    expect(
      normalizeMLError({ err: mlErr({ status: 401, message: "invalid access token" }) })
        .kind,
    ).toBe("AUTH");
  });

  it("403 PolicyAgent ⇒ AUTH; 403 genérico ⇒ VALIDATION", () => {
    expect(
      normalizeMLError({
        err: mlErr({
          status: 403,
          code: "PA_UNAUTHORIZED_RESULT_FROM_POLICIES",
          blocked_by: "PolicyAgent",
        }),
      }).kind,
    ).toBe("AUTH");
    expect(
      normalizeMLError({ err: mlErr({ status: 403, message: "forbidden" }) }).kind,
    ).toBe("VALIDATION");
  });

  it("404 ⇒ VALIDATION (recurso/categoria inexistente)", () => {
    expect(normalizeMLError({ err: mlErr({ status: 404 }) }).kind).toBe(
      "VALIDATION",
    );
  });

  it("409 ⇒ VALIDATION", () => {
    expect(normalizeMLError({ err: mlErr({ status: 409 }) }).kind).toBe(
      "VALIDATION",
    );
  });

  it("429 ⇒ RATE_LIMIT retentável", () => {
    const n = normalizeMLError({ err: mlErr({ status: 429 }) });
    expect(n.kind).toBe("RATE_LIMIT");
    expect(n.retryable).toBe(true);
  });

  it("5xx ⇒ TRANSIENT retentável", () => {
    for (const status of [500, 502, 503, 504]) {
      const n = normalizeMLError({ err: mlErr({ status }) });
      expect(n.kind).toBe("TRANSIENT");
      expect(n.retryable).toBe(true);
    }
  });

  it("status vindo do axios (mlHttpStatus) vence o corpo ausente", () => {
    const e = Object.assign(new Error("Erro ao criar item: Request failed"), {
      mlHttpStatus: 503,
    });
    expect(normalizeMLError({ err: e }).kind).toBe("TRANSIENT");
  });

  it("timeout do withTimeout ⇒ UNKNOWN com timedOut (pode ter criado no ML)", () => {
    const n = normalizeMLError({
      err: new Error("Timeout (ML createItem) after 15000ms"),
    });
    expect(n.kind).toBe("UNKNOWN");
    expect(n.timedOut).toBe(true);
    expect(n.retryable).toBe(true);
  });

  it("timeout de rede (ECONNABORTED/ETIMEDOUT) ⇒ UNKNOWN com timedOut", () => {
    for (const code of ["ECONNABORTED", "ETIMEDOUT"]) {
      const n = normalizeMLError({
        err: Object.assign(new Error("x"), { mlNetworkCode: code }),
      });
      expect(n.kind).toBe("UNKNOWN");
      expect(n.timedOut).toBe(true);
    }
  });

  it("rede caída (ECONNRESET) ⇒ TRANSIENT", () => {
    const n = normalizeMLError({
      err: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    });
    expect(n.kind).toBe("TRANSIENT");
    expect(n.networkCode).toBe("ECONNRESET");
  });

  it("sem evidência nenhuma ⇒ UNKNOWN retentável, sem ação do usuário", () => {
    const n = normalizeMLError({ err: new Error("algo estranho") });
    expect(n.kind).toBe("UNKNOWN");
    expect(n.userActionRequired).toBe(false);
    expect(n.httpStatus).toBeNull();
  });

  it("aceita valores não-Error sem quebrar", () => {
    expect(normalizeMLError({ err: "texto" }).kind).toBe("UNKNOWN");
    expect(normalizeMLError({ err: null }).kind).toBe("UNKNOWN");
    expect(normalizeMLError({ err: undefined }).kind).toBe("UNKNOWN");
  });
});
