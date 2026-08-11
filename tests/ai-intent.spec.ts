import { describe, expect, it } from "vitest";

import { classifyIntent } from "../app/ai/agent/intent";

// ===========================================================================
// Classificação de intenção — quem decide se o turno paga RAG.
//
// A assimetria testada aqui é deliberada e vale repetir: na dúvida, BUSCA.
// Um falso positivo custa tokens; um falso negativo custa uma resposta errada
// sobre o sistema, que é o pior defeito que este agente pode ter.
// ===========================================================================

const kind = (m: string) => classifyIntent(m).kind;
const rag = (m: string) => classifyIntent(m).needsRag;

describe("conversa: nem base, nem consulta", () => {
  it.each([
    "oi",
    "Olá!",
    "bom dia",
    "boa tarde",
    "valeu",
    "obrigado",
    "blz",
    "ok",
    "entendi",
    "tchau",
  ])("%s", (m) => {
    expect(kind(m)).toBe("conversa");
    expect(rag(m)).toBe(false);
  });

  it("mensagem vazia não busca nada", () => {
    expect(rag("")).toBe(false);
    expect(rag("   ")).toBe(false);
  });
});

describe("dúvida: precisa da base de conhecimento", () => {
  it.each([
    "Como eu emito etiquetas no Dexo?",
    "onde fica a tela de sucatas",
    "o que é o PDV balcão",
    "pra que serve a localização",
    "por que meu anúncio está pausado?",
    "deu erro ao publicar no mercado livre",
    "não consigo conectar a shopee",
    "como configuro a nota fiscal",
    "a NFC-e foi rejeitada, e agora?",
    "como cadastro uma peça",
  ])("%s", (m) => {
    expect(kind(m)).toBe("duvida");
    expect(rag(m)).toBe(true);
  });
});

describe("dados: número do próprio negócio, sem RAG", () => {
  it.each([
    "quanto eu vendi em julho",
    "quantos produtos eu tenho cadastrados",
    "total faturado no mês",
    "me mostra as peças com estoque baixo",
    "quanto tenho a receber",
    "quais contas estão vencidas",
    "top 10 mais vendidos",
    "relatório de vendas do último trimestre",
  ])("%s", (m) => {
    expect(kind(m)).toBe("dados");
    expect(rag(m)).toBe(false);
  });
});

describe("a fronteira entre 'dados' e 'dúvida'", () => {
  it("'como eu vejo quanto vendi' é dúvida de operação, não relatório", () => {
    // Tem "quanto", mas o que a pessoa quer é o CAMINHO na tela.
    expect(kind("como eu vejo quanto vendi no mês passado?")).toBe("duvida");
    expect(rag("como eu vejo quanto vendi no mês passado?")).toBe(true);
  });

  it("'onde vejo o total a receber' também é dúvida", () => {
    expect(kind("onde eu vejo o total a receber?")).toBe("duvida");
  });

  it("mas 'quanto tenho a receber' continua sendo pedido de número", () => {
    expect(kind("quanto tenho a receber?")).toBe("dados");
  });
});

describe("o default é buscar", () => {
  it.each([
    "anúncio pausado",
    "sucata",
    "etiqueta térmica",
    "aquela peça do gol",
    "e sobre o financeiro",
  ])("frase solta '%s' cai em dúvida e paga RAG", (m) => {
    expect(kind(m)).toBe("duvida");
    expect(rag(m)).toBe(true);
  });
});
