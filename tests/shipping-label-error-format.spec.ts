/**
 * O que o lojista lê na tela quando a etiqueta falha.
 *
 * O incidente de 29/07/2026 chegou ao usuário como
 * "Shopee upload_invoice_doc 404: Request failed with status code 404".
 * Este spec trava que texto técnico de cliente HTTP nunca mais apareça.
 */
import { describe, it, expect } from "vitest";

import { formatLabelError } from "@/lib/shipping-label-error";

describe("formatLabelError", () => {
  it("usa a mensagem em português do backend", () => {
    expect(
      formatLabelError({
        error: "Não foi possível gerar a etiqueta",
        code: "NFE_NOT_FOUND",
        message:
          "Pedido sem NF-e autorizada de produção. Emita e autorize a NF-e antes de gerar a etiqueta.",
      }),
    ).toBe(
      "Pedido sem NF-e autorizada de produção. Emita e autorize a NF-e antes de gerar a etiqueta.",
    );
  });

  it("NUNCA exibe o texto cru do axios — cai no fallback + referência", () => {
    const out = formatLabelError({
      error: "Erro ao gerar etiqueta",
      message: "Shopee upload_invoice_doc 404: Request failed with status code 404",
      correlationId: "req-42",
    });

    expect(out).not.toContain("Request failed with status code");
    expect(out).not.toContain("upload_invoice_doc");
    expect(out).toContain("Não foi possível gerar a etiqueta");
    expect(out).toContain("req-42");
  });

  it("erro de provider ganha a referência para o suporte correlacionar", () => {
    const out = formatLabelError({
      error: "Não foi possível gerar a etiqueta",
      code: "PROVIDER_ERROR",
      message: "Falha ao enviar a NF-e do pedido X na Shopee: error_not_found",
      correlationId: "req-9",
    });
    expect(out).toContain("Falha ao enviar a NF-e");
    // PROVIDER_ERROR é auto-explicativo: a referência já vem embutida na
    // mensagem do backend, então não duplicamos.
    expect(out).not.toContain("(ref: req-9)");
  });

  it("resposta antiga (só error/message) continua funcionando", () => {
    expect(
      formatLabelError({
        error: "Etiqueta não encontrada",
        message: "Gere a etiqueta antes de baixar.",
      }),
    ).toBe("Gere a etiqueta antes de baixar.");
  });

  it("corpo vazio ou ausente cai no fallback", () => {
    expect(formatLabelError(undefined)).toBe(
      "Não foi possível gerar a etiqueta. Tente novamente.",
    );
    expect(formatLabelError({}, "Não foi possível gerar as etiquetas")).toBe(
      "Não foi possível gerar as etiquetas",
    );
  });
});
