// PDV Balcão — decisão pura de "receber agora" na finalização da venda.
//
// Módulo puro (sem imports de React/fetch) para ser testável em node,
// seguindo a convenção do repo (tests/pdv-finalize.spec.ts).
//
// Regras:
//  - FIADO SEMPRE fica pendente (venda a prazo por definição), mesmo com o
//    switch "Receber agora" ligado — vence qualquer outra condição.
//  - Switch desligado => pendente (mesmo comportamento do financeiro hoje:
//    a baixa de estoque acontece só quando alguém marca como paga).
//  - Demais casos => receber agora (o caller encadeia o POST /pay existente;
//    markPaid é idempotente, então retry em falha é seguro).

export type FinalizeReason = "ok" | "fiado" | "switch-off";

export interface FinalizeDecision {
  pay: boolean;
  reason: FinalizeReason;
}

export function decideAutoReceive(opts: {
  receiveNow: boolean;
  paymentMethod: string | null | undefined;
}): FinalizeDecision {
  if (opts.paymentMethod === "FIADO") return { pay: false, reason: "fiado" };
  if (!opts.receiveNow) return { pay: false, reason: "switch-off" };
  return { pay: true, reason: "ok" };
}
