import { describe, it, expect } from "vitest";

import { decideAutoReceive } from "@/app/pdv/lib/pdv-finalize";

// PDV Balcão — regra pura do switch "Receber agora". A garantia central é
// que FIADO NUNCA dispara o POST /pay (venda a prazo fica PENDENTE), e que
// com o switch desligado o comportamento é o mesmo do financeiro hoje.

describe("decideAutoReceive (PDV)", () => {
  it("FIADO nunca paga, mesmo com o switch ligado", () => {
    expect(
      decideAutoReceive({ receiveNow: true, paymentMethod: "FIADO" }),
    ).toEqual({ pay: false, reason: "fiado" });
  });

  it("FIADO com switch desligado também reporta 'fiado' (motivo dominante)", () => {
    expect(
      decideAutoReceive({ receiveNow: false, paymentMethod: "FIADO" }),
    ).toEqual({ pay: false, reason: "fiado" });
  });

  it("switch desligado => pendente para qualquer método", () => {
    expect(
      decideAutoReceive({ receiveNow: false, paymentMethod: "PIX" }),
    ).toEqual({ pay: false, reason: "switch-off" });
    expect(
      decideAutoReceive({ receiveNow: false, paymentMethod: null }),
    ).toEqual({ pay: false, reason: "switch-off" });
  });

  it("switch ligado + método efetivado (ou ausente) => paga", () => {
    expect(
      decideAutoReceive({ receiveNow: true, paymentMethod: "PIX" }),
    ).toEqual({ pay: true, reason: "ok" });
    expect(
      decideAutoReceive({ receiveNow: true, paymentMethod: "DINHEIRO" }),
    ).toEqual({ pay: true, reason: "ok" });
    expect(
      decideAutoReceive({ receiveNow: true, paymentMethod: null }),
    ).toEqual({ pay: true, reason: "ok" });
    expect(
      decideAutoReceive({ receiveNow: true, paymentMethod: undefined }),
    ).toEqual({ pay: true, reason: "ok" });
  });
});
