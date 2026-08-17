// FASE 16 — a guarda de edição passa a decidir por VALOR MUDADO.
//
// O DEFEITO QUE ISTO FECHA
// `blockedFieldsOnPaidSale` filtrava `f in data` — presença de chave. Só que
// `totalAmount` tem default `0` no schema do formulário e o diálogo do
// Financeiro reenvia a lista de itens INTEIRA em toda edição de venda de
// balcão. Resultado: com a flag ligada, corrigir só o documento de uma venda
// paga tomava 409 — enquanto a mensagem de erro prometia, com todas as
// letras, que documento, cliente, vencimento e vendedor seguiam editáveis.
// Uma guarda que mente é pior que uma guarda ausente: manda o operador tentar
// de novo.
//
// Também colidia com a decisão do bloco do vendedor ("sempre corrigível com
// registro"): com a trava ligada, corrigir o vendedor de uma venda recebida
// era impossível.
//
// ⚠️ NENHUM teste existente foi tocado. Os 18 casos de
// `tests/finance-edit-guard.spec.ts` continuam verdes SEM ALTERAÇÃO — e isso
// é o problema que este arquivo resolve: nenhum deles envia o mesmo valor,
// então a regra nova nasceria sem uma linha de cobertura.

import { describe, it, expect } from "vitest";

import {
  blockedFieldsOnPaidSale,
  mesmoTotal,
  mesmosItens,
  mesmosPagamentos,
} from "../app/financeiro/lib/sale-edit-guard";

const ON = { SALE_EDIT_GUARD_ENABLED: "1" };

/** Como o repositório devolve a venda: com id, createdAt e product juntos. */
const ANTES = {
  totalAmount: 100,
  items: [
    {
      id: "ri-1",
      productId: "p-1",
      description: null,
      quantity: 2,
      unitPrice: 25,
      createdAt: new Date("2026-01-01"),
      autoCreatedProduct: false,
      product: { id: "p-1", sku: "SKU-1", name: "Farol" },
    },
    {
      id: "ri-2",
      productId: null,
      description: "Parafuso avulso",
      quantity: 1,
      unitPrice: 50,
      createdAt: new Date("2026-01-01"),
      autoCreatedProduct: false,
      product: null,
    },
  ],
  payments: [
    { id: "rp-1", method: "PIX", amount: 60, createdAt: new Date() },
    { id: "rp-2", method: "CREDITO", amount: 40, createdAt: new Date() },
  ],
};

/** Como o formulário manda de volta: sem id, sem createdAt, sem product. */
const PAYLOAD_IGUAL = {
  totalAmount: 100,
  items: [
    { productId: "p-1", quantity: 2, unitPrice: 25 },
    {
      productId: null,
      description: "Parafuso avulso",
      quantity: 1,
      unitPrice: 50,
    },
  ],
  payments: [
    { method: "PIX", amount: 60 },
    { method: "CREDITO", amount: 40 },
  ],
};

describe("O save que não muda nada PASSA", () => {
  it("payload equivalente ao estado atual não bloqueia NADA", () => {
    // É o caso que reproduz o defeito: hoje isto devolvia
    // ["items","totalAmount","payments"] e o operador tomava 409 sem ter
    // mudado uma vírgula.
    expect(blockedFieldsOnPaidSale(PAYLOAD_IGUAL, "PAGA", ON, ANTES)).toEqual(
      [],
    );
  });

  it("corrigir SÓ o documento de uma venda paga passa", () => {
    // O cenário que a mensagem de erro sempre prometeu que funcionava.
    const so_documento = { ...PAYLOAD_IGUAL, document: "NF 1234" };
    expect(blockedFieldsOnPaidSale(so_documento, "PAGA", ON, ANTES)).toEqual(
      [],
    );
  });

  it("corrigir SÓ o vendedor de uma venda paga passa", () => {
    // Conflito direto com o bloco B, que decidiu "sempre corrigível com
    // registro". Antes desta correção, os dois blocos se contradiziam.
    const so_vendedor = { ...PAYLOAD_IGUAL, sellerUserId: "u-9" };
    expect(blockedFieldsOnPaidSale(so_vendedor, "PAGA", ON, ANTES)).toEqual([]);
  });

  it("Decimal do Prisma chega como string e é o MESMO dinheiro", () => {
    // `totalAmount` volta do banco como "100.00"; o formulário manda 100.
    // Comparar cru diria "mudou" em todo save.
    const antes = { ...ANTES, totalAmount: "100.00" as unknown as number };
    expect(blockedFieldsOnPaidSale(PAYLOAD_IGUAL, "PAGA", ON, antes)).toEqual(
      [],
    );
  });

  it("itens REORDENADOS não são alteração", () => {
    // Reordenar linha na tela não move estoque nem dinheiro. Acusar isso
    // devolveria o bloqueio universal por outro caminho.
    const trocado = {
      ...PAYLOAD_IGUAL,
      items: [...PAYLOAD_IGUAL.items].reverse(),
    };
    expect(blockedFieldsOnPaidSale(trocado, "PAGA", ON, ANTES)).toEqual([]);
  });

  it("campos extras na linha (id, product) não contam como mudança", () => {
    // O PDV reenvia a linha com `product` embutido. Comparar o objeto inteiro
    // acusaria mudança em 100% dos saves — o bug trocando de causa.
    const gordo = {
      ...PAYLOAD_IGUAL,
      items: [
        {
          id: "ri-1",
          productId: "p-1",
          quantity: 2,
          unitPrice: 25,
          product: { id: "p-1", sku: "SKU-1", name: "Farol" },
        },
        {
          id: "ri-2",
          productId: null,
          description: "Parafuso avulso",
          quantity: 1,
          unitPrice: 50,
        },
      ],
    };
    expect(blockedFieldsOnPaidSale(gordo, "PAGA", ON, ANTES)).toEqual([]);
  });

  it("pagamentos reordenados não são alteração", () => {
    const trocado = {
      ...PAYLOAD_IGUAL,
      payments: [...PAYLOAD_IGUAL.payments].reverse(),
    };
    expect(blockedFieldsOnPaidSale(trocado, "PAGA", ON, ANTES)).toEqual([]);
  });
});

describe("O save que muda de verdade CONTINUA bloqueado", () => {
  it("quantidade 2 → 3 bloqueia", () => {
    // É o dano original: o estoque não se move no PUT, então a venda passa a
    // dizer 3 sem que 1 tenha saído do pátio — e o estorno devolve 3.
    const d = {
      ...PAYLOAD_IGUAL,
      items: [
        { productId: "p-1", quantity: 3, unitPrice: 25 },
        PAYLOAD_IGUAL.items[1],
      ],
    };
    expect(blockedFieldsOnPaidSale(d, "PAGA", ON, ANTES)).toEqual(["items"]);
  });

  it("preço unitário 25 → 24,99 bloqueia (diferença de UM centavo)", () => {
    const d = {
      ...PAYLOAD_IGUAL,
      items: [
        { productId: "p-1", quantity: 2, unitPrice: 24.99 },
        PAYLOAD_IGUAL.items[1],
      ],
    };
    expect(blockedFieldsOnPaidSale(d, "PAGA", ON, ANTES)).toEqual(["items"]);
  });

  it("remover um item de dois bloqueia", () => {
    const d = { ...PAYLOAD_IGUAL, items: [PAYLOAD_IGUAL.items[0]] };
    expect(blockedFieldsOnPaidSale(d, "PAGA", ON, ANTES)).toEqual(["items"]);
  });

  it("esvaziar a lista de itens bloqueia", () => {
    // `items: []` é justamente o payload que apagava as linhas sem devolver
    // estoque — a assimetria com o DELETE que motivou o bloco inteiro.
    const d = { ...PAYLOAD_IGUAL, items: [] };
    expect(blockedFieldsOnPaidSale(d, "PAGA", ON, ANTES)).toEqual(["items"]);
  });

  it("trocar a peça mantendo quantidade e preço bloqueia", () => {
    const d = {
      ...PAYLOAD_IGUAL,
      items: [
        { productId: "p-OUTRA", quantity: 2, unitPrice: 25 },
        PAYLOAD_IGUAL.items[1],
      ],
    };
    expect(blockedFieldsOnPaidSale(d, "PAGA", ON, ANTES)).toEqual(["items"]);
  });

  it("mudar a descrição do item MANUAL bloqueia", () => {
    // Item sem productId é identificado pela descrição — se ela não entrasse
    // na chave, trocar "Parafuso" por "Motor completo" passaria batido.
    const d = {
      ...PAYLOAD_IGUAL,
      items: [
        PAYLOAD_IGUAL.items[0],
        {
          productId: null,
          description: "Motor completo",
          quantity: 1,
          unitPrice: 50,
        },
      ],
    };
    expect(blockedFieldsOnPaidSale(d, "PAGA", ON, ANTES)).toEqual(["items"]);
  });

  it("trocar a SUCATA de origem do item bloqueia", () => {
    // Sem `scrapId` na chave, dava para remanejar de qual lote a peça saiu numa
    // venda já recebida — a contagem do lote muda sem passar por estorno.
    // As duas telas repõem o campo, então exigi-lo não gera 409 falso.
    const antes = {
      ...ANTES,
      items: [{ ...ANTES.items[0], scrapId: "s-1" }, ANTES.items[1]],
    };
    const d = {
      ...PAYLOAD_IGUAL,
      items: [
        { productId: "p-1", quantity: 2, unitPrice: 25, scrapId: "s-OUTRA" },
        PAYLOAD_IGUAL.items[1],
      ],
    };
    expect(blockedFieldsOnPaidSale(d, "PAGA", ON, antes)).toEqual(["items"]);
  });

  it("mesma sucata reenviada NÃO bloqueia", () => {
    const antes = {
      ...ANTES,
      items: [{ ...ANTES.items[0], scrapId: "s-1" }, ANTES.items[1]],
    };
    const d = {
      ...PAYLOAD_IGUAL,
      items: [
        { productId: "p-1", quantity: 2, unitPrice: 25, scrapId: "s-1" },
        PAYLOAD_IGUAL.items[1],
      ],
    };
    expect(blockedFieldsOnPaidSale(d, "PAGA", ON, antes)).toEqual([]);
  });

  it("total 100 → 120 bloqueia", () => {
    const d = { ...PAYLOAD_IGUAL, totalAmount: 120 };
    expect(blockedFieldsOnPaidSale(d, "PAGA", ON, ANTES)).toEqual([
      "totalAmount",
    ]);
  });

  it("trocar a FORMA de pagamento bloqueia", () => {
    const d = {
      ...PAYLOAD_IGUAL,
      payments: [
        { method: "DINHEIRO", amount: 60 },
        { method: "CREDITO", amount: 40 },
      ],
    };
    expect(blockedFieldsOnPaidSale(d, "PAGA", ON, ANTES)).toEqual(["payments"]);
  });

  it("remanejar valor entre as formas bloqueia (o total nem muda)", () => {
    const d = {
      ...PAYLOAD_IGUAL,
      payments: [
        { method: "PIX", amount: 70 },
        { method: "CREDITO", amount: 30 },
      ],
    };
    expect(blockedFieldsOnPaidSale(d, "PAGA", ON, ANTES)).toEqual(["payments"]);
  });

  it("vários campos mudados saem NA ORDEM de PROTECTED_WHEN_PAID", () => {
    const d = {
      items: [{ productId: "p-1", quantity: 9, unitPrice: 25 }],
      totalAmount: 999,
      payments: [{ method: "PIX", amount: 999 }],
    };
    expect(blockedFieldsOnPaidSale(d, "PAGA", ON, ANTES)).toEqual([
      "items",
      "totalAmount",
      "payments",
    ]);
  });
});

describe("Na dúvida, BLOQUEIA — o lado seguro do erro", () => {
  it("sem o estado anterior, volta a decidir por presença", () => {
    // Contrato, não acidente: sem o `antes` não há como afirmar que nada
    // mudou, e a guarda existe para o caso em que a dúvida é cara.
    expect(blockedFieldsOnPaidSale(PAYLOAD_IGUAL, "PAGA", ON)).toEqual([
      "items",
      "totalAmount",
      "payments",
    ]);
    expect(blockedFieldsOnPaidSale(PAYLOAD_IGUAL, "PAGA", ON, null)).toEqual([
      "items",
      "totalAmount",
      "payments",
    ]);
  });

  it("total não numérico bloqueia em vez de passar", () => {
    const d = { totalAmount: "abc" as unknown as number };
    expect(blockedFieldsOnPaidSale(d, "PAGA", ON, ANTES)).toEqual([
      "totalAmount",
    ]);
  });

  it("items que não é array bloqueia", () => {
    const d = { items: null as unknown as unknown[] };
    expect(blockedFieldsOnPaidSale(d, "PAGA", ON, ANTES)).toEqual(["items"]);
  });

  it("linha sem quantidade/preço utilizáveis bloqueia", () => {
    const d = {
      ...PAYLOAD_IGUAL,
      items: [
        { productId: "p-1", quantity: NaN, unitPrice: 25 },
        PAYLOAD_IGUAL.items[1],
      ],
    };
    expect(blockedFieldsOnPaidSale(d, "PAGA", ON, ANTES)).toEqual(["items"]);
  });

  it("`installmentPlan` continua bloqueando por PRESENÇA, mesmo com o antes", () => {
    // Não há com o quê comparar: ele não é coluna nem relação, é uma INSTRUÇÃO
    // de "recrie as parcelas". Mandá-lo numa venda paga é querer reescrever a
    // cobrança que gerou o dinheiro que entrou.
    const d = { ...PAYLOAD_IGUAL, installmentPlan: {} };
    expect(blockedFieldsOnPaidSale(d, "PAGA", ON, ANTES)).toEqual([
      "installmentPlan",
    ]);
  });
});

describe("O que a correção NÃO pode ter mexido", () => {
  it("flag desligada continua devolvendo vazio, com ou sem o antes", () => {
    expect(blockedFieldsOnPaidSale(PAYLOAD_IGUAL, "PAGA", {}, ANTES)).toEqual(
      [],
    );
    const mudou = { ...PAYLOAD_IGUAL, totalAmount: 999 };
    expect(blockedFieldsOnPaidSale(mudou, "PAGA", {}, ANTES)).toEqual([]);
  });

  it("só PAGA bloqueia — os outros status seguem totalmente editáveis", () => {
    const mudou = { ...PAYLOAD_IGUAL, totalAmount: 999 };
    for (const st of ["PENDENTE", "VENCIDA", "CANCELADA", null, undefined]) {
      expect(
        blockedFieldsOnPaidSale(mudou, st as string | null, ON, ANTES),
      ).toEqual([]);
    }
  });
});

describe("Os comparadores, isolados", () => {
  it("mesmoTotal compara em CENTAVOS", () => {
    expect(mesmoTotal(100, "100.00")).toBe(true);
    expect(mesmoTotal(0.1 + 0.2, 0.3)).toBe(true); // o clássico do float
    expect(mesmoTotal(100, 100.01)).toBe(false);
  });

  it("mesmoTotal com valor inutilizável devolve false (= mudou = bloqueia)", () => {
    expect(mesmoTotal(undefined, 100)).toBe(false);
    expect(mesmoTotal(100, undefined)).toBe(false);
  });

  it("mesmosItens/mesmosPagamentos: lista vazia dos dois lados é igual", () => {
    expect(mesmosItens([], [])).toBe(true);
    expect(mesmosPagamentos([], [])).toBe(true);
  });

  it("tamanhos diferentes nunca são iguais", () => {
    expect(
      mesmosItens([], [{ productId: "p", quantity: 1, unitPrice: 1 }]),
    ).toBe(false);
  });
});
