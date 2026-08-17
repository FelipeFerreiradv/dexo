// Fase 1.0 — regressão: editar uma conta zerava os encargos.
//
// O dano acontecia na composição de duas peças, e é por isso que o teste
// exercita as DUAS juntas:
//   1. `financeRowToFormSeed` monta o `initialData` a partir da linha;
//   2. o dialog hidrata com `reset({ ...DEFAULT_FINANCE_VALUES, ...initialData })`
//      e o submit envia o FORMULÁRIO INTEIRO no PUT.
// Um campo fora de (1) volta ao default em (2) e é regravado por cima.
//
// Antes da correção, os cinco campos abaixo não constavam do seed: multa,
// juros, tolerância e detalhes voltavam a null/"" e `periodDays` virava 30.

import { describe, it, expect } from "vitest";
import {
  financeRowToFormSeed,
  type FinanceRowForForm,
} from "../app/financeiro/lib/row-to-form";
import { DEFAULT_FINANCE_VALUES } from "../app/financeiro/lib/finance-schema";

/** Linha como a API devolve hoje, com encargos preenchidos. */
function row(over: Partial<FinanceRowForForm> = {}): FinanceRowForForm {
  return {
    id: "rec_1",
    document: "DOC-9",
    reason: "Serviço de guincho",
    paymentMethod: "PIX",
    totalAmount: 1200,
    installments: 1,
    dueDate: "2026-09-10T00:00:00.000Z",
    unidadeId: null,
    customer: { id: "cus_1", name: "Oficina do Zé", cpf: null },
    debtDetails: "Guincho + pátio 3 diárias",
    fineAmount: 50,
    finePercent: 2,
    interestPercent: 1.5,
    toleranceDays: 5,
    periodDays: 15,
    ...over,
  };
}

/** Espelha a hidratação do FinanceDialog (finance-dialog.tsx:211). */
function hydrate(seed: ReturnType<typeof financeRowToFormSeed>) {
  return { ...DEFAULT_FINANCE_VALUES, ...seed };
}

describe("Fase 1.0 — edição preserva encargos e detalhes", () => {
  it("mantém multa, juros, tolerância, detalhes e periodDays ao reabrir", () => {
    const form = hydrate(financeRowToFormSeed(row()));

    expect(form.fineAmount).toBe(50);
    expect(form.finePercent).toBe(2);
    expect(form.interestPercent).toBe(1.5);
    expect(form.toleranceDays).toBe(5);
    expect(form.debtDetails).toBe("Guincho + pátio 3 diárias");
    // O default do formulário é 30 — o valor gravado era 15.
    expect(form.periodDays).toBe(15);
  });

  it("não substitui os encargos pelos defaults do formulário", () => {
    const form = hydrate(financeRowToFormSeed(row()));

    // Guarda explícita contra a regressão: se o seed voltar a omitir os
    // campos, cada um destes vira o default e o teste acusa.
    expect(form.fineAmount).not.toBe(DEFAULT_FINANCE_VALUES.fineAmount);
    expect(form.finePercent).not.toBe(DEFAULT_FINANCE_VALUES.finePercent);
    expect(form.interestPercent).not.toBe(
      DEFAULT_FINANCE_VALUES.interestPercent,
    );
    expect(form.toleranceDays).not.toBe(DEFAULT_FINANCE_VALUES.toleranceDays);
    expect(form.debtDetails).not.toBe(DEFAULT_FINANCE_VALUES.debtDetails);
    expect(form.periodDays).not.toBe(DEFAULT_FINANCE_VALUES.periodDays);
  });

  it("preserva null gravado como null (não inventa valor)", () => {
    const form = hydrate(
      financeRowToFormSeed(
        row({
          fineAmount: null,
          finePercent: null,
          interestPercent: null,
          toleranceDays: null,
          debtDetails: null,
        }),
      ),
    );

    expect(form.fineAmount).toBeNull();
    expect(form.finePercent).toBeNull();
    expect(form.interestPercent).toBeNull();
    expect(form.toleranceDays).toBeNull();
    expect(form.debtDetails).toBeNull();
  });

  it("campo AUSENTE na resposta cai no default, nunca em null", () => {
    // Cenário de deploy: front novo + API ainda sem o campo no select. Omitir
    // é o comportamento de hoje (sem piora); gravar null seria o bug de volta,
    // agora causado pela própria correção.
    const { debtDetails: _d, ...semDebtDetails } = row();
    const form = hydrate(
      financeRowToFormSeed(semDebtDetails as FinanceRowForForm),
    );

    expect(form.debtDetails).toBe(DEFAULT_FINANCE_VALUES.debtDetails);
    // Os demais continuam vindo da linha.
    expect(form.fineAmount).toBe(50);
  });

  it("preserva os campos que já funcionavam (sem regressão)", () => {
    const seed = financeRowToFormSeed(row());

    expect(seed.id).toBe("rec_1");
    expect(seed.customerId).toBe("cus_1");
    expect(seed.document).toBe("DOC-9");
    expect(seed.reason).toBe("Serviço de guincho");
    expect(seed.paymentMethod).toBe("PIX");
    expect(seed.totalAmount).toBe(1200);
    expect(seed.installments).toBe(1);
    expect(seed.unidadeId).toBeNull();
    // dueDate continua truncado para YYYY-MM-DD (input date).
    expect(seed.dueDate).toBe("2026-09-10");
  });
});
