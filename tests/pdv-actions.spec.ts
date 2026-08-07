import { describe, it, expect } from "vitest";

import {
  buildSaleActions,
  emittedDocsFor,
  isFiscalUiEnabled,
  isPdvActionsMenuEnabled,
  isSaleCancelEnabled,
  type FiscalDocSummary,
  type SaleAction,
  type SaleStatusForActions,
} from "../app/pdv/lib/pdv-actions";

// ──────────────────────────────────────────────────────────
// Bloco D — tabela de ações do livro do dia do PDV.
//
// O requisito é explícito: "Nada de botão que erra em silêncio". Por isso a
// decisão de o que aparece / o que desabilita / por quê é uma função PURA, e
// é aqui que ela fica pinada. Dois invariantes valem para TODA combinação:
//   1. item desabilitado SEMPRE carrega um motivo legível;
//   2. nota já emitida NUNCA oferece "emitir" — vira reimprimir/consultar.
// ──────────────────────────────────────────────────────────

const ALL_STATUSES: SaleStatusForActions[] = [
  "PENDENTE",
  "PAGA",
  "VENCIDA",
  "CANCELADA",
];

function build(over: Partial<Parameters<typeof buildSaleActions>[0]> = {}) {
  return buildSaleActions({
    status: "PAGA",
    totalAmount: 500,
    nfceUi: true,
    fiscalUi: true,
    ...over,
  });
}

function pick(actions: SaleAction[], kind: SaleAction["kind"]): SaleAction {
  const found = actions.find((a) => a.kind === kind);
  if (!found) throw new Error(`ação ausente: ${kind}`);
  return found;
}

const nfceAutorizadaComPdf: FiscalDocSummary = {
  modelo: "65",
  nfeId: "nfe-65",
  status: "AUTHORIZED",
  numero: 42,
  serie: 1,
  danfeDisponivel: true,
};

describe("buildSaleActions — forma e invariantes", () => {
  it("devolve as 4 ações, sempre na mesma ordem (destrutiva por último)", () => {
    const actions = build();
    expect(actions.map((a) => a.kind)).toEqual([
      "receipt",
      "nfce",
      "nfe55",
      "reverse",
    ]);
  });

  it("todo item desabilitado carrega um motivo legível", () => {
    for (const status of ALL_STATUSES) {
      for (const totalAmount of [500, 25_000]) {
        for (const docs of [undefined, [nfceAutorizadaComPdf]]) {
          for (const action of build({ status, totalAmount, docs })) {
            if (action.disabled) {
              expect(
                action.reason,
                `${action.kind}/${status}/${totalAmount} sem motivo`,
              ).toBeTruthy();
            }
          }
        }
      }
    }
  });

  it("intent 'reprint'/'consult' sempre aponta para uma nota", () => {
    const docs: FiscalDocSummary[] = [
      nfceAutorizadaComPdf,
      {
        modelo: "55",
        nfeId: "nfe-55",
        status: "DRAFT",
        numero: 7,
        serie: 1,
        danfeDisponivel: false,
      },
    ];
    for (const action of build({ docs })) {
      if (action.intent === "reprint" || action.intent === "consult") {
        expect(action.nfeId, `${action.kind} sem nfeId`).toBeTruthy();
      }
    }
  });
});

describe("Recibo simples — sem validade fiscal", () => {
  it("está disponível em QUALQUER status, inclusive venda cancelada", () => {
    for (const status of ALL_STATUSES) {
      const receipt = pick(build({ status }), "receipt");
      expect(receipt.visible).toBe(true);
      expect(receipt.disabled).toBe(false);
      expect(receipt.intent).toBe("download");
    }
  });

  it("não depende de nenhuma flag fiscal", () => {
    const receipt = pick(build({ nfceUi: false, fiscalUi: false }), "receipt");
    expect(receipt.visible).toBe(true);
    expect(receipt.disabled).toBe(false);
  });
});

describe("NFC-e (modelo 65)", () => {
  it("some quando a UI de NFC-e está desligada", () => {
    expect(pick(build({ nfceUi: false }), "nfce").visible).toBe(false);
  });

  it("venda PAGA dentro do limite: emite", () => {
    const nfce = pick(build({ status: "PAGA", totalAmount: 9_999 }), "nfce");
    expect(nfce.disabled).toBe(false);
    expect(nfce.intent).toBe("emit");
    expect(nfce.label).toBe("Emitir NFC-e");
  });

  it.each(["PENDENTE", "VENCIDA"] as const)(
    "venda %s: bloqueada, pedindo o recebimento primeiro",
    (status) => {
      const nfce = pick(build({ status }), "nfce");
      expect(nfce.disabled).toBe(true);
      expect(nfce.reason).toContain("Receba a venda");
    },
  );

  it("venda cancelada: bloqueada", () => {
    const nfce = pick(build({ status: "CANCELADA" }), "nfce");
    expect(nfce.disabled).toBe(true);
    expect(nfce.reason).toContain("cancelada");
  });

  // Limite legal: NFCE_LIMITE_VALOR = 10_000 e a regra é ESTRITAMENTE maior
  // (finance.usecase.ts:666 usa `>`), então R$ 10.000,00 exatos ainda passam.
  it("R$ 10.000,00 exatos ainda permitem NFC-e", () => {
    expect(pick(build({ totalAmount: 10_000 }), "nfce").disabled).toBe(false);
  });

  it("acima de R$ 10.000: bloqueada e aponta para a NF-e 55", () => {
    const nfce = pick(build({ totalAmount: 10_000.01 }), "nfce");
    expect(nfce.disabled).toBe(true);
    expect(nfce.reason).toContain("R$ 10.000");
    expect(nfce.reason).toContain("55");
  });

  it("nota autorizada com DANFCE: vira reimprimir, nunca emitir de novo", () => {
    const nfce = pick(build({ docs: [nfceAutorizadaComPdf] }), "nfce");
    expect(nfce.intent).toBe("reprint");
    expect(nfce.label).toBe("Reimprimir NFC-e");
    expect(nfce.nfeId).toBe("nfe-65");
    expect(nfce.disabled).toBe(false);
  });

  // Cancelar a venda no Dexo NÃO cancela a nota (fluxos desacoplados — o
  // cancelamento fiscal tem prazo de 24h e justificativa próprios). Se a nota
  // existe, o operador precisa conseguir reimprimi-la.
  it("venda CANCELADA com nota autorizada ainda permite reimprimir", () => {
    const nfce = pick(
      build({ status: "CANCELADA", docs: [nfceAutorizadaComPdf] }),
      "nfce",
    );
    expect(nfce.intent).toBe("reprint");
    expect(nfce.disabled).toBe(false);
  });

  it("autorizada SEM PDF renderizado: consultar (POST idempotente)", () => {
    const nfce = pick(
      build({ docs: [{ ...nfceAutorizadaComPdf, danfeDisponivel: false }] }),
      "nfce",
    );
    expect(nfce.intent).toBe("consult");
    expect(nfce.label).toBe("Consultar NFC-e");
  });

  it("em processamento na SEFAZ: consultar", () => {
    const nfce = pick(
      build({
        docs: [
          { ...nfceAutorizadaComPdf, status: "PROCESSING", danfeDisponivel: false },
        ],
      }),
      "nfce",
    );
    expect(nfce.intent).toBe("consult");
  });

  it("rejeitada: oferece REEMITIR (a mesma linha é reaproveitada)", () => {
    const nfce = pick(
      build({
        docs: [
          { ...nfceAutorizadaComPdf, status: "REJECTED", danfeDisponivel: false },
        ],
      }),
      "nfce",
    );
    expect(nfce.intent).toBe("emit");
    expect(nfce.label).toBe("Reemitir NFC-e");
    expect(nfce.disabled).toBe(false);
  });

  // Estado do menu ainda fechado: sem lookup. O caminho seguro é oferecer
  // emitir — o POST é idempotente e devolve "já emitida" se for o caso.
  it("docs indefinido (menu nunca aberto) trata como sem nota", () => {
    const nfce = pick(build({ docs: undefined }), "nfce");
    expect(nfce.intent).toBe("emit");
    expect(nfce.disabled).toBe(false);
  });
});

describe("NF-e (modelo 55)", () => {
  it("some com o módulo fiscal desligado", () => {
    expect(pick(build({ fiscalUi: false }), "nfe55").visible).toBe(false);
  });

  it("é independente da flag da NFC-e", () => {
    const nfe = pick(build({ nfceUi: false, fiscalUi: true }), "nfe55");
    expect(nfe.visible).toBe(true);
    expect(nfe.disabled).toBe(false);
  });

  // O backend não exige PAGA para o rascunho (finance.usecase.ts:578-582 só
  // exige itens) — não inventamos restrição que a API não tem.
  it.each(["PENDENTE", "PAGA", "VENCIDA"] as const)(
    "venda %s permite gerar o rascunho",
    (status) => {
      const nfe = pick(build({ status }), "nfe55");
      expect(nfe.disabled).toBe(false);
      expect(nfe.intent).toBe("emit");
    },
  );

  it("venda cancelada: bloqueada", () => {
    const nfe = pick(build({ status: "CANCELADA" }), "nfe55");
    expect(nfe.disabled).toBe(true);
    expect(nfe.reason).toContain("cancelada");
  });

  it("rascunho já existe: abre em Notas Fiscais, não cria um segundo", () => {
    const nfe = pick(
      build({
        docs: [
          {
            modelo: "55",
            nfeId: "nfe-55",
            status: "DRAFT",
            numero: 7,
            serie: 1,
            danfeDisponivel: false,
          },
        ],
      }),
      "nfe55",
    );
    expect(nfe.intent).toBe("consult");
    expect(nfe.label).toContain("Notas Fiscais");
  });

  it("nota 55 autorizada com DANFE: reimprimir", () => {
    const nfe = pick(
      build({
        docs: [
          {
            modelo: "55",
            nfeId: "nfe-55",
            status: "AUTHORIZED",
            numero: 7,
            serie: 1,
            danfeDisponivel: true,
          },
        ],
      }),
      "nfe55",
    );
    expect(nfe.intent).toBe("reprint");
    expect(nfe.nfeId).toBe("nfe-55");
  });

  it("a nota 65 não contamina a ação da 55 (e vice-versa)", () => {
    const actions = build({ docs: [nfceAutorizadaComPdf] });
    expect(pick(actions, "nfe55").intent).toBe("emit");
    expect(pick(actions, "nfce").intent).toBe("reprint");
  });
});

// Bloco C reusa este mesmo menu no histórico de compras do cliente, onde não
// existe cadeia de caixa nem emitente multi-CNPJ selecionado.
describe("contexto sem caixa (nfceEmitAvailable: false)", () => {
  it("REGRESSÃO: o default é true — o PDV não muda em nada", () => {
    const semParam = pick(build(), "nfce");
    const comParamTrue = pick(build({ nfceEmitAvailable: true }), "nfce");
    expect(semParam).toEqual(comParamTrue);
    expect(semParam.disabled).toBe(false);
  });

  it("emitir NFC-e nova fica bloqueado, apontando para o PDV", () => {
    const nfce = pick(build({ nfceEmitAvailable: false }), "nfce");
    expect(nfce.intent).toBe("emit");
    expect(nfce.disabled).toBe(true);
    expect(nfce.reason).toContain("PDV");
  });

  it("reimprimir uma nota já autorizada CONTINUA disponível", () => {
    const nfce = pick(
      build({ nfceEmitAvailable: false, docs: [nfceAutorizadaComPdf] }),
      "nfce",
    );
    expect(nfce.intent).toBe("reprint");
    expect(nfce.disabled).toBe(false);
  });

  it("consultar nota em processamento CONTINUA disponível", () => {
    const nfce = pick(
      build({
        nfceEmitAvailable: false,
        docs: [
          {
            ...nfceAutorizadaComPdf,
            status: "PROCESSING",
            danfeDisponivel: false,
          },
        ],
      }),
      "nfce",
    );
    expect(nfce.intent).toBe("consult");
    expect(nfce.disabled).toBe(false);
  });

  it("recibo e NF-e 55 não são afetados (são autossuficientes)", () => {
    const actions = build({ nfceEmitAvailable: false });
    expect(pick(actions, "receipt").disabled).toBe(false);
    expect(pick(actions, "nfe55").disabled).toBe(false);
  });

  it("o motivo de status ainda ganha do motivo de contexto", () => {
    const nfce = pick(
      build({ status: "PENDENTE", nfceEmitAvailable: false }),
      "nfce",
    );
    expect(nfce.reason).toContain("Receba a venda");
  });
});

describe("Cancelar venda (Bloco E)", () => {
  it("REGRESSÃO: sem saleCancelUi a ação nem aparece", () => {
    expect(pick(build(), "reverse").visible).toBe(false);
    expect(pick(build({ saleCancelUi: false }), "reverse").visible).toBe(false);
  });

  it("venda PAGA: liberada", () => {
    const rev = pick(build({ saleCancelUi: true, status: "PAGA" }), "reverse");
    expect(rev.visible).toBe(true);
    expect(rev.disabled).toBe(false);
    expect(rev.intent).toBe("reverse");
  });

  // O backend só estorna PAGA com itens (finance.usecase.ts:497-507) — não
  // oferecemos um botão que responderia 400.
  it.each(["PENDENTE", "VENCIDA"] as const)(
    "venda %s: bloqueada (não há estoque baixado para devolver)",
    (status) => {
      const rev = pick(build({ saleCancelUi: true, status }), "reverse");
      expect(rev.disabled).toBe(true);
      expect(rev.reason).toContain("recebidas");
    },
  );

  it("venda já cancelada: bloqueada", () => {
    const rev = pick(
      build({ saleCancelUi: true, status: "CANCELADA" }),
      "reverse",
    );
    expect(rev.disabled).toBe(true);
    expect(rev.reason).toContain("já está cancelada");
  });

  it("nota emitida NÃO bloqueia o cancelamento da venda", () => {
    // São fluxos desacoplados: cancelar a venda no Dexo não cancela a nota.
    // O aviso é responsabilidade da confirmação, não um bloqueio.
    const rev = pick(
      build({ saleCancelUi: true, docs: [nfceAutorizadaComPdf] }),
      "reverse",
    );
    expect(rev.disabled).toBe(false);
  });
});

describe("emittedDocsFor — o que exige aviso ao cancelar", () => {
  it("sem notas, nada a avisar", () => {
    expect(emittedDocsFor(undefined)).toEqual([]);
    expect(emittedDocsFor([])).toEqual([]);
  });

  it("autorizada e em processamento contam", () => {
    expect(
      emittedDocsFor([
        nfceAutorizadaComPdf,
        { ...nfceAutorizadaComPdf, modelo: "55", status: "PROCESSING" },
      ]),
    ).toHaveLength(2);
  });

  it("rascunho e rejeitada NÃO contam — não existe documento no mundo", () => {
    expect(
      emittedDocsFor([
        { ...nfceAutorizadaComPdf, status: "DRAFT" },
        { ...nfceAutorizadaComPdf, modelo: "55", status: "REJECTED" },
      ]),
    ).toEqual([]);
  });
});

describe("flags — nascem desligadas", () => {
  it("o menu de ações só liga com NEXT_PUBLIC_PDV_ACTIONS_MENU_ENABLED=true", () => {
    expect(isPdvActionsMenuEnabled()).toBe(
      process.env.NEXT_PUBLIC_PDV_ACTIONS_MENU_ENABLED === "true",
    );
  });

  it("o gate da NF-e 55 é o módulo fiscal", () => {
    expect(isFiscalUiEnabled()).toBe(
      process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED === "true",
    );
  });

  it("o cancelamento de venda só liga com NEXT_PUBLIC_SALE_CANCEL_ENABLED=true", () => {
    expect(isSaleCancelEnabled()).toBe(
      process.env.NEXT_PUBLIC_SALE_CANCEL_ENABLED === "true",
    );
  });
});
