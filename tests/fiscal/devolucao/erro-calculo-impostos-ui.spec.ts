// A decisão de tela do erro do passo "Impostos" (DLS AUTO PEÇAS, 24/09/2026).
//
// O defeito: rascunho de devolução feito À MÃO, sem linha em `NfeDevolucao`. O
// `/calculate` responde 404 DEVOLUCAO_NAO_GERENCIADA e a tela mostrava só a
// frase do servidor ("Este rascunho não é uma devolução gerenciada.") com um
// botão "Tentar novamente" que repetia o MESMO 404 para sempre.
//
// O que este spec prega no chão:
//  - só este código perde o "Tentar novamente" — todos os outros do contrato
//    seguem passageiros (se alguém promover mais um, o teste cai);
//  - a mensagem NÃO é a do servidor: ela diz o que houve e o caminho certo;
//  - o passo a passo cita os rótulos EXATOS das telas por onde ela tem de ir.

import { describe, it, expect } from "vitest";
import {
  viewErroCalculo,
  isErroCalculoPermanente,
  MENSAGEM_CALCULO_GENERICA,
  LINK_NOTAS_EMITIDAS,
  ROTULO_IR_PARA_NOTAS_EMITIDAS,
} from "../../../app/notas-fiscais/lib/nfe-erro-calculo-ui";
import {
  DEVOLUCAO_ERRO_CODIGOS,
  DEVOLUCAO_ERRO_MENSAGEM,
} from "../../../app/fiscal/devolucao/contrato";

const RESPOSTA_404 = {
  error: DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_NAO_GERENCIADA,
  code: "DEVOLUCAO_NAO_GERENCIADA",
};

describe("erro do cálculo de impostos — rascunho de devolução não gerenciada", () => {
  it("é permanente e troca o retry pelo caminho de saída", () => {
    const v = viewErroCalculo(RESPOSTA_404);
    expect(v.codigo).toBe("DEVOLUCAO_NAO_GERENCIADA");
    expect(v.permanente).toBe(true);
    expect(v.acao).toBe("IR_PARA_NOTAS_EMITIDAS");
    // A ação é o que a tela lê para decidir; "TENTAR_NOVAMENTE" aqui seria o bug de volta.
    expect(v.acao).not.toBe("TENTAR_NOVAMENTE");
  });

  it("não repassa a frase do servidor — ela é um beco sem saída", () => {
    const v = viewErroCalculo(RESPOSTA_404);
    expect(v.mensagem).not.toBe(DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_NAO_GERENCIADA);
    expect(v.titulo).toBeTruthy();
    // Diz por que não adianta repetir, e para onde ir.
    expect(v.mensagem).toContain("Não adianta tentar de novo");
    expect(v.mensagem).toContain("nota de venda original");
    // Diz que o rascunho é de antes da funcionalidade e não dá para aproveitar.
    expect(v.mensagem).toContain("começado à mão");
    expect(v.mensagem).toContain("não dá para aproveitar este rascunho");
  });

  it("traz o passo a passo com os rótulos exatos das telas", () => {
    const { passos } = viewErroCalculo(RESPOSTA_404);
    expect(passos.length).toBeGreaterThanOrEqual(5);
    const tudo = passos.join(" \n ");
    // Menu (app-sidebar.tsx)
    expect(tudo).toContain('"Notas Emitidas"');
    // Botões que MONTAM a devolução (devolucao-actions.tsx)
    expect(tudo).toContain('"Devolver total"');
    expect(tudo).toContain('"Devolver parcial"');
    // Botão do editor (devolucao-editor.tsx) e o do rodapé do wizard
    expect(tudo).toContain('"Salvar devolução"');
    expect(tudo).toContain('"Emitir NF-e"');
    // Ordem: achar a nota original vem ANTES de clicar em devolver.
    const iOriginal = passos.findIndex((p) => p.includes("VENDA original"));
    const iDevolver = passos.findIndex((p) => p.includes('"Devolver total"'));
    expect(iOriginal).toBeGreaterThanOrEqual(0);
    expect(iDevolver).toBeGreaterThan(iOriginal);
  });

  it("o link de saída aponta para a lista onde os botões existem", () => {
    // `/notas-fiscais` redireciona para o WIZARD (page.tsx); a lista é /emitidas.
    expect(LINK_NOTAS_EMITIDAS).toBe("/notas-fiscais/emitidas");
    expect(LINK_NOTAS_EMITIDAS).not.toBe("/notas-fiscais");
    expect(LINK_NOTAS_EMITIDAS).not.toBe("/notas-fiscais/nfe");
    expect(ROTULO_IR_PARA_NOTAS_EMITIDAS).toContain("Notas Emitidas");
  });
});

describe("erro do cálculo de impostos — o que continua passageiro", () => {
  it("RASCUNHO_ALTERADO mantém o retry e a mensagem do servidor", () => {
    const v = viewErroCalculo({
      error: DEVOLUCAO_ERRO_MENSAGEM.RASCUNHO_ALTERADO,
      code: "RASCUNHO_ALTERADO",
    });
    expect(v.permanente).toBe(false);
    expect(v.acao).toBe("TENTAR_NOVAMENTE");
    expect(v.mensagem).toBe(DEVOLUCAO_ERRO_MENSAGEM.RASCUNHO_ALTERADO);
    expect(v.passos).toEqual([]);
    expect(v.titulo).toBeNull();
  });

  it("de todos os códigos do contrato, só um é permanente", () => {
    const permanentes = DEVOLUCAO_ERRO_CODIGOS.filter((c) =>
      viewErroCalculo({ code: c, error: DEVOLUCAO_ERRO_MENSAGEM[c] }).permanente,
    );
    expect(permanentes).toEqual(["DEVOLUCAO_NAO_GERENCIADA"]);
  });

  it("erro sem código (400 do NCM/CFOP, 500 cru) segue com o retry e o texto do servidor", () => {
    const semCodigo = viewErroCalculo({
      error: 'Item 1 ("Farol direito") esta sem NCM. Preencha o NCM antes de calcular.',
    });
    expect(semCodigo.codigo).toBeNull();
    expect(semCodigo.permanente).toBe(false);
    expect(semCodigo.acao).toBe("TENTAR_NOVAMENTE");
    expect(semCodigo.mensagem).toContain("sem NCM");
  });

  it("código desconhecido não vira permanente por acidente", () => {
    const v = viewErroCalculo({ code: "CODIGO_QUE_NAO_EXISTE", error: "seja lá o que for" });
    expect(v.permanente).toBe(false);
    expect(v.acao).toBe("TENTAR_NOVAMENTE");
    expect(v.mensagem).toBe("seja lá o que for");
  });

  it("corpo vazio, nulo ou com tipos errados cai no genérico de sempre", () => {
    for (const entrada of [undefined, null, {}, { error: "   " }, { error: 42, code: 404 }]) {
      const v = viewErroCalculo(entrada as never);
      expect(v.codigo).toBeNull();
      expect(v.permanente).toBe(false);
      expect(v.mensagem).toBe(MENSAGEM_CALCULO_GENERICA);
      expect(v.acao).toBe("TENTAR_NOVAMENTE");
    }
  });

  it("o fallback do chamador (rede caída) é respeitado", () => {
    expect(viewErroCalculo({}, "Erro ao calcular").mensagem).toBe("Erro ao calcular");
    expect(viewErroCalculo({ error: "Failed to fetch" }, "Erro ao calcular").mensagem).toBe(
      "Failed to fetch",
    );
  });
});

describe("isErroCalculoPermanente", () => {
  it("só o código da devolução não gerenciada", () => {
    expect(isErroCalculoPermanente("DEVOLUCAO_NAO_GERENCIADA")).toBe(true);
    expect(isErroCalculoPermanente("DEVOLUCAO_INVALIDA")).toBe(false);
    expect(isErroCalculoPermanente("")).toBe(false);
    expect(isErroCalculoPermanente(undefined)).toBe(false);
    expect(isErroCalculoPermanente(null)).toBe(false);
  });

  it("não confunde herança de Object com código conhecido", () => {
    // `PERMANENTES["toString"]` existe no protótipo: sem hasOwnProperty, isto
    // devolveria true e o operador perderia o retry por causa de um lixo.
    expect(isErroCalculoPermanente("toString")).toBe(false);
    expect(isErroCalculoPermanente("constructor")).toBe(false);
    expect(viewErroCalculo({ code: "constructor" }).permanente).toBe(false);
  });
});
