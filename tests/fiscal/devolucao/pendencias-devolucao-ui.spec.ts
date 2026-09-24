// O bloqueio da emissão da devolução, dito por inteiro (DLS AUTO PEÇAS, 24/09/2026).
//
// O defeito: `contextoEmissao`/`validarReserva` lançam
// `new DevolucaoError("DEVOLUCAO_INVALIDA", detalhe.issues)` e a rota serializa
// `issues` no corpo do 422 — as pendências CHEGAM ao navegador. A tela então
// jogava a lista fora e mostrava só a frase do contrato,
// "A devolução tem pendências que impedem a emissão.", num toast. A cliente
// passou o dia adivinhando qual pendência, em qual item.
//
// O que este spec prega no chão:
//  - o caso real (6 itens com a tributação a confirmar) vira UMA linha que diz
//    os itens 1 a 6 e o caminho, com os rótulos EXATOS da tela;
//  - itens diferentes de uma mesma pendência não viram seis frases repetidas;
//  - AVISO não se disfarça de impedimento;
//  - issue sem `ordem` não inventa item nenhum;
//  - lista VAZIA não faz o bloqueio sumir — 422 continua sendo 422.

import { describe, it, expect } from "vitest";
import {
  listarOrdens,
  pendenciasDeIssues,
  semPrefixoDeItem,
  viewPendencias,
  viewPendenciasDaResposta,
  viewPendenciasDoDetalhe,
  MENSAGEM_DEVOLUCAO_INVALIDA,
  MENSAGEM_PREVIA_SO_AVISOS,
  COMO_RESOLVER_SEM_DETALHE,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-pendencias-ui";
import { viewErroCalculo } from "../../../app/notas-fiscais/lib/nfe-erro-calculo-ui";
import { DEVOLUCAO_ERRO_MENSAGEM } from "../../../app/fiscal/devolucao/contrato";
import type { DevolucaoIssue } from "../../../app/fiscal/devolucao/tipos";

/** O rascunho da DLS: os 6 itens vieram do XML do FORNECEDOR (CFOP de venda
 *  dele), então `requerRevisao = true` e `confirmada = false` em todos. É o que
 *  `validarDevolucao` gera para esse estado, palavra por palavra. */
const MOTIVO_DLS = "O regime tributário do emitente difere do da nota original.";
const ISSUES_DLS: DevolucaoIssue[] = [1, 2, 3, 4, 5, 6].map((ordem) => ({
  code: "TRIBUTACAO_REVISAO_PENDENTE",
  severidade: "ERRO",
  ordem,
  mensagem: `Item ${ordem}: revise e confirme a tributação. ${MOTIVO_DLS}`,
}));

describe("pendências da devolução — o caso real da DLS AUTO PEÇAS", () => {
  it("junta os 6 itens numa linha só, dizendo quais são", () => {
    const view = viewPendencias(ISSUES_DLS, DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_INVALIDA);
    expect(view.bloqueios).toHaveLength(1);
    const [p] = view.bloqueios;
    expect(p.ordens).toEqual([1, 2, 3, 4, 5, 6]);
    expect(p.titulo).toBe("Falta confirmar a tributação dos itens 1 a 6");
    // Seis frases quase iguais era o que ela tinha de ler para descobrir que
    // eram a mesma coisa.
    expect(view.bloqueios.map((b) => b.titulo)).not.toEqual(
      ISSUES_DLS.map((i) => i.mensagem),
    );
  });

  it("diz o que fazer com os rótulos EXATOS da tela", () => {
    const [p] = viewPendencias(ISSUES_DLS).bloqueios;
    // Caixinha e botão do devolucao-editor.tsx; passo 8 do STEPS do wizard.
    expect(p.comoResolver).toContain('"Revisei a tributação deste item"');
    expect(p.comoResolver).toContain('"Salvar devolução"');
    expect(p.comoResolver).toContain('"Impostos"');
    // O caminho não pode mandá-la para um lugar que não existe.
    expect(p.comoResolver).not.toContain("Tentar novamente");
  });

  it("não repete o motivo seis vezes, mas não o perde", () => {
    const [p] = viewPendencias(ISSUES_DLS).bloqueios;
    expect(p.detalhes).toEqual(["revise e confirme a tributação. " + MOTIVO_DLS]);
  });

  it("o bloqueio é de ERRO e não sobra aviso nenhum", () => {
    const view = viewPendencias(ISSUES_DLS);
    expect(view.semDetalhe).toBe(false);
    expect(view.avisos).toEqual([]);
  });
});

describe("pendências da devolução — várias issues em itens diferentes", () => {
  const ISSUES: DevolucaoIssue[] = [
    { code: "CFOP_ESCOLHA_PENDENTE", severidade: "ERRO", ordem: 2, mensagem: "Item 2: escolha o CFOP de devolução (Rejeição 327)." },
    { code: "TRIBUTACAO_REVISAO_PENDENTE", severidade: "ERRO", ordem: 1, mensagem: "Item 1: revise e confirme a tributação." },
    { code: "SALDO_EXCEDIDO", severidade: "ERRO", ordem: 5, mensagem: "Item 5: quantidade maior que o saldo disponível para devolução (2)." },
    { code: "TRIBUTACAO_REVISAO_PENDENTE", severidade: "ERRO", ordem: 3, mensagem: "Item 3: revise e confirme a tributação." },
    { code: "PIS_CST_SAIDA_EM_ENTRADA", severidade: "AVISO", ordem: 1, mensagem: "Item 1: CST de PIS/COFINS de saída numa nota de entrada — confirme com o contador." },
  ];

  it("uma linha por pendência, com os itens de cada uma", () => {
    const { bloqueios } = viewPendencias(ISSUES);
    expect(bloqueios).toHaveLength(3);
    const porCodigo = Object.fromEntries(bloqueios.map((b) => [b.codigo, b]));
    expect(porCodigo.TRIBUTACAO_REVISAO_PENDENTE.ordens).toEqual([1, 3]);
    expect(porCodigo.TRIBUTACAO_REVISAO_PENDENTE.titulo).toBe(
      "Falta confirmar a tributação dos itens 1 e 3",
    );
    expect(porCodigo.CFOP_ESCOLHA_PENDENTE.titulo).toBe(
      "Falta escolher o CFOP de devolução do item 2",
    );
    expect(porCodigo.SALDO_EXCEDIDO.titulo).toBe(
      "A quantidade é maior do que ainda pode ser devolvido no item 5",
    );
  });

  it("o AVISO fica FORA dos bloqueios — ele não impede a emissão", () => {
    const { bloqueios, avisos } = viewPendencias(ISSUES);
    expect(bloqueios.every((b) => b.severidade === "ERRO")).toBe(true);
    expect(bloqueios.map((b) => b.codigo)).not.toContain("PIS_CST_SAIDA_EM_ENTRADA");
    expect(avisos).toHaveLength(1);
    expect(avisos[0].codigo).toBe("PIS_CST_SAIDA_EM_ENTRADA");
    expect(avisos[0].ordens).toEqual([1]);
  });
});

describe("pendências da devolução — uma issue só", () => {
  it("fala no singular e mantém o caminho", () => {
    const { bloqueios, semDetalhe } = viewPendencias([
      { code: "TRIBUTACAO_REVISAO_PENDENTE", severidade: "ERRO", ordem: 4, mensagem: "Item 4: revise e confirme a tributação." },
    ]);
    expect(semDetalhe).toBe(false);
    expect(bloqueios).toHaveLength(1);
    expect(bloqueios[0].titulo).toBe("Falta confirmar a tributação do item 4");
    expect(bloqueios[0].titulo).not.toContain("itens");
    expect(bloqueios[0].comoResolver).toContain('"Salvar devolução"');
  });
});

describe("pendências da devolução — issue sem ordem", () => {
  it("não inventa item e não deixa buraco na frase", () => {
    const { bloqueios } = viewPendencias([
      { code: "ESCOLHA_PENDENTE", severidade: "ERRO", mensagem: "Responda se a mercadoria foi entregue e devolvida pelo cliente." },
      { code: "TRIBUTACAO_REVISAO_PENDENTE", severidade: "ERRO", mensagem: "revise e confirme a tributação." },
    ]);
    const cabecalho = bloqueios.find((b) => b.codigo === "ESCOLHA_PENDENTE")!;
    expect(cabecalho.ordens).toEqual([]);
    expect(cabecalho.titulo).toBe(
      "Falta responder se a mercadoria foi entregue e devolvida pelo cliente",
    );
    // A frase de item, sem item, não pode sair com o buraco do token nem com
    // espaço sobrando antes da pontuação.
    const semItem = bloqueios.find((b) => b.codigo === "TRIBUTACAO_REVISAO_PENDENTE")!;
    expect(semItem.titulo).toBe("Falta confirmar a tributação");
    expect(semItem.titulo).not.toMatch(/\{/);
    expect(semItem.titulo).not.toMatch(/ {2}|\s$/);
    // Ordem inválida (0, 2.5, "3") é o mesmo que ordem nenhuma.
    for (const ordem of [0, 2.5, "3", null, 991]) {
      const [p] = viewPendencias([
        { code: "TRIBUTACAO_REVISAO_PENDENTE", severidade: "ERRO", ordem, mensagem: "x" },
      ]).bloqueios;
      expect(p.ordens).toEqual([]);
    }
  });
});

describe("pendências da devolução — lista vazia", () => {
  it("NÃO some com o bloqueio: 422 continua sendo 422", () => {
    for (const vazio of [[], undefined, null, "issues", {}]) {
      const view = viewPendencias(vazio, DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_INVALIDA);
      expect(view.bloqueios).toEqual([]);
      expect(view.semDetalhe).toBe(true);
      // A frase do servidor continua na tela — é o que sobrou de verdadeiro.
      expect(view.mensagem).toBe(DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_INVALIDA);
    }
  });

  it("sem frase do servidor, cai na do contrato — nunca em vazio", () => {
    const view = viewPendencias([], undefined);
    expect(view.mensagem).toBe(MENSAGEM_DEVOLUCAO_INVALIDA);
    expect(MENSAGEM_DEVOLUCAO_INVALIDA).toBe(DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_INVALIDA);
    expect(COMO_RESOLVER_SEM_DETALHE).toContain('"Salvar devolução"');
  });
});

describe("pendências da devolução — o texto tem de LER bem", () => {
  it("frase que começa pelos itens sai com maiúscula, com ou sem item", () => {
    const [comItem] = viewPendencias([
      { code: "IBS_CBS_NAO_ENVIADO", severidade: "AVISO", ordem: 2, mensagem: "Item 2: IBS/CBS da nota original não é enviado na devolução." },
    ]).avisos;
    expect(comItem.titulo).toBe(
      "O item 2 tem IBS/CBS na nota original, e a devolução não envia esse grupo",
    );
    // "…na devolução no item 2" (dois "no" seguidos) era o motivo de esta
    // entrada citar o item na frente.
    expect(comItem.titulo).not.toContain("devolução no item");
    const [semItem] = viewPendencias([
      { code: "IBS_CBS_NAO_ENVIADO", severidade: "AVISO", mensagem: "IBS/CBS não é enviado." },
    ]).avisos;
    expect(semItem.titulo.charAt(0)).toBe(semItem.titulo.charAt(0).toUpperCase());
    expect(semItem.titulo.startsWith("Tem IBS/CBS")).toBe(true);
  });

  it("detalhe que repete o título palavra por palavra não aparece duas vezes", () => {
    const [p] = viewPendencias([
      {
        code: "ORIGINAL_CANCELADA",
        severidade: "ERRO",
        // Mesmo texto do catálogo, só com ponto final e caixa diferentes.
        mensagem: "a nota original está cancelada.",
      },
    ]).bloqueios;
    expect(p.titulo).toBe("A nota original está cancelada");
    expect(p.detalhes).toEqual([]);
    // Detalhe que ACRESCENTA continua aparecendo.
    const [q] = viewPendencias([
      { code: "ORIGINAL_CANCELADA", severidade: "ERRO", mensagem: "A nota original 3519…0001 está cancelada — não há o que devolver." },
    ]).bloqueios;
    expect(q.detalhes).toHaveLength(1);
  });
});

describe("pendências da devolução — leitura defensiva do corpo", () => {
  it("issue com código desconhecido aparece crua, não some", () => {
    const [p] = viewPendencias([
      { code: "REGRA_QUE_AINDA_NAO_EXISTE", severidade: "ERRO", ordem: 7, mensagem: "Item 7: alguma regra nova." },
    ]).bloqueios;
    expect(p.titulo).toBe("Item 7: alguma regra nova.");
    expect(p.comoResolver).toBe("");
  });

  it("duas regras novas diferentes não viram uma linha só", () => {
    const { bloqueios } = viewPendencias([
      { code: "REGRA_NOVA", severidade: "ERRO", mensagem: "primeira coisa." },
      { code: "REGRA_NOVA", severidade: "ERRO", mensagem: "outra coisa." },
    ]);
    expect(bloqueios).toHaveLength(2);
  });

  it("severidade estranha conta como bloqueio — esconder é pior", () => {
    const view = viewPendencias([
      { code: "SEM_ITENS", severidade: "AVISOZINHO", mensagem: "x" },
      { code: "SEM_ITENS", mensagem: "x" },
    ]);
    expect(view.avisos).toEqual([]);
    expect(view.bloqueios).toHaveLength(1);
  });

  it('um `code` de protótipo ("constructor") não rouba texto do Object', () => {
    const [p] = viewPendencias([
      { code: "constructor", severidade: "ERRO", mensagem: "lixo na resposta." },
    ]).bloqueios;
    expect(p.titulo).toBe("lixo na resposta.");
    expect(p.comoResolver).toBe("");
  });

  it("entrada que não é issue nenhuma é descartada sem quebrar", () => {
    expect(pendenciasDeIssues([null, 7, "x", {}, [], { ordem: 2 }])).toEqual([]);
  });
});

describe("pendências da devolução — listagem dos itens", () => {
  it("faixa a partir de três seguidos; dois seguidos saem inteiros", () => {
    expect(listarOrdens([])).toBe("");
    expect(listarOrdens([4])).toBe("4");
    expect(listarOrdens([1, 2])).toBe("1 e 2");
    expect(listarOrdens([1, 2, 3])).toBe("1 a 3");
    expect(listarOrdens([1, 2, 3, 4, 5, 6])).toBe("1 a 6");
    expect(listarOrdens([1, 3, 5])).toBe("1, 3 e 5");
    expect(listarOrdens([1, 2, 3, 7])).toBe("1 a 3 e 7");
    expect(listarOrdens([1, 2, 3, 7, 8, 9, 12])).toBe("1 a 3, 7 a 9 e 12");
  });

  it("a ordem de chegada não muda o texto", () => {
    const baralhado = [6, 2, 4, 1, 5, 3].map((ordem) => ({
      code: "TRIBUTACAO_REVISAO_PENDENTE",
      severidade: "ERRO" as const,
      ordem,
      mensagem: `Item ${ordem}: revise e confirme a tributação.`,
    }));
    expect(viewPendencias(baralhado).bloqueios[0].titulo).toBe(
      "Falta confirmar a tributação dos itens 1 a 6",
    );
  });

  it('tira o "Item N:" do detalhe — o item já está no título', () => {
    expect(semPrefixoDeItem("Item 3: revise e confirme.")).toBe("revise e confirme.");
    expect(semPrefixoDeItem("Item 12:  com espaço.")).toBe("com espaço.");
    // Não pode comer texto que não é prefixo de item.
    expect(semPrefixoDeItem("Itens desalinhados: confira.")).toBe("Itens desalinhados: confira.");
    expect(semPrefixoDeItem("A nota original 123 está cancelada.")).toBe(
      "A nota original 123 está cancelada.",
    );
  });
});

describe("pendências da devolução — só o 422 da devolução muda de tela", () => {
  it("DEVOLUCAO_INVALIDA vira quadro", () => {
    const view = viewPendenciasDaResposta({
      error: DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_INVALIDA,
      code: "DEVOLUCAO_INVALIDA",
      issues: ISSUES_DLS,
    });
    expect(view).not.toBeNull();
    expect(view!.bloqueios).toHaveLength(1);
  });

  it("qualquer outro erro segue EXATAMENTE como antes (só o toast)", () => {
    for (const code of [
      "RASCUNHO_ALTERADO",
      "DEVOLUCAO_NAO_GERENCIADA",
      "NUMERACAO_CONFIRMAR_DESCARTE",
      undefined,
    ]) {
      expect(viewPendenciasDaResposta({ error: "algo", code, issues: ISSUES_DLS })).toBeNull();
    }
    expect(viewPendenciasDaResposta(null)).toBeNull();
    expect(viewPendenciasDaResposta(undefined)).toBeNull();
  });
});

describe("pendências da devolução — a prévia dentro do editor", () => {
  it("o rascunho da DLS, ainda sem salvar: bloqueado e com a lista", () => {
    const view = viewPendenciasDoDetalhe({ issues: ISSUES_DLS, podeEmitir: false });
    expect(view.bloqueado).toBe(true);
    expect(view.tom).toBe("bloqueio");
    expect(view.bloqueios[0].titulo).toBe("Falta confirmar a tributação dos itens 1 a 6");
    expect(view.mensagem).toBe(MENSAGEM_DEVOLUCAO_INVALIDA);
  });

  it("só AVISO com podeEmitir=true NÃO pinta a tela de impedimento", () => {
    const view = viewPendenciasDoDetalhe({
      podeEmitir: true,
      issues: [
        { code: "IBS_CBS_NAO_ENVIADO", severidade: "AVISO", ordem: 2, mensagem: "Item 2: IBS/CBS da nota original não é enviado na devolução." },
      ],
    });
    expect(view.bloqueado).toBe(false);
    expect(view.tom).toBe("aviso");
    expect(view.bloqueios).toEqual([]);
    // `semDetalhe` é "bloqueado E sem lista" — aqui não há bloqueio nenhum.
    expect(view.semDetalhe).toBe(false);
    expect(view.mensagem).toBe(MENSAGEM_PREVIA_SO_AVISOS);
    expect(view.avisos).toHaveLength(1);
  });

  it("`podeEmitir` ausente ou torto conta como bloqueado", () => {
    for (const podeEmitir of [undefined, null, false, "true", 1]) {
      expect(viewPendenciasDoDetalhe({ issues: [], podeEmitir }).bloqueado).toBe(true);
      expect(viewPendenciasDoDetalhe({ issues: [], podeEmitir }).semDetalhe).toBe(true);
    }
  });
});

describe("erro do passo Impostos — o mesmo corpo, a mesma lista", () => {
  const RESPOSTA = {
    error: DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_INVALIDA,
    code: "DEVOLUCAO_INVALIDA",
    issues: ISSUES_DLS,
  };

  it("ganha as pendências SEM perder nada do que já fazia", () => {
    const v = viewErroCalculo(RESPOSTA);
    // Continua passageiro: depois de confirmar a tributação, tentar de novo
    // resolve — o oposto do DEVOLUCAO_NAO_GERENCIADA.
    expect(v.permanente).toBe(false);
    expect(v.acao).toBe("TENTAR_NOVAMENTE");
    expect(v.mensagem).toBe(DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_INVALIDA);
    expect(v.pendencias?.bloqueios[0].titulo).toBe(
      "Falta confirmar a tributação dos itens 1 a 6",
    );
  });

  it("nenhum outro erro da tela ganha quadro de pendência", () => {
    expect(viewErroCalculo({ error: "x", code: "RASCUNHO_ALTERADO" }).pendencias).toBeUndefined();
    expect(
      viewErroCalculo({
        error: DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_NAO_GERENCIADA,
        code: "DEVOLUCAO_NAO_GERENCIADA",
      }).pendencias,
    ).toBeUndefined();
    expect(viewErroCalculo().pendencias).toBeUndefined();
  });
});
