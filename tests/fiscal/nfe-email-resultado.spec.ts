import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { resultadoEnvioEmail } from "../../app/notas-fiscais/lib/nfe-email-resultado";

// O diálogo "Enviar por e-mail" só olhava `success` e mostrava "E-mail enviado com
// sucesso!" — mesmo quando o servidor mandou só o XML porque o DANFE da nota
// CANCELADA não pôde ser marcado. O operador achava que o DANFE tinha ido.

describe("resultadoEnvioEmail", () => {
  it("resposta de sempre: enviado (o diálogo fecha sozinho, como antes)", () => {
    expect(resultadoEnvioEmail(true, { success: true, mensagem: "E-mail enviado para a@b.com" })).toEqual({ tipo: "enviado" });
  });

  it("DANFE omitido: enviado COM aviso, com a frase do servidor", () => {
    const mensagem = "E-mail enviado para a@b.com sem o DANFE: a nota está CANCELADA e não foi possível marcar o PDF como cancelado.";
    expect(resultadoEnvioEmail(true, { success: true, mensagem, danfeOmitido: true })).toEqual({
      tipo: "enviado-com-aviso",
      texto: mensagem,
    });
  });

  it("DANFE omitido sem mensagem: ainda avisa", () => {
    expect(resultadoEnvioEmail(true, { success: true, danfeOmitido: true })).toEqual({
      tipo: "enviado-com-aviso",
      texto: "E-mail enviado sem o DANFE.",
    });
  });

  it("só `true` liga o aviso (a chave ausente ou com outro valor é o caso de sempre)", () => {
    for (const danfeOmitido of [undefined, false, "true", 1, null]) {
      expect(resultadoEnvioEmail(true, { success: true, danfeOmitido })).toEqual({ tipo: "enviado" });
    }
  });

  it("erro: HTTP não-ok ou success falso, com a mensagem do servidor ou a padrão", () => {
    expect(resultadoEnvioEmail(false, { error: "E-mail de destino invalido" })).toEqual({
      tipo: "erro",
      texto: "E-mail de destino invalido",
    });
    expect(resultadoEnvioEmail(true, { success: false })).toEqual({ tipo: "erro", texto: "Erro ao enviar e-mail" });
    // Erro manda mais que o aviso: HTTP 500 com danfeOmitido continua erro.
    expect(resultadoEnvioEmail(false, { success: true, danfeOmitido: true, error: "x" })).toEqual({ tipo: "erro", texto: "x" });
    expect(resultadoEnvioEmail(true, null)).toEqual({ tipo: "erro", texto: "Erro ao enviar e-mail" });
  });
});

// A suíte não tem jsdom nem @testing-library/react (decisão de não adicionar
// dependência): a ligação do diálogo com o resultado é travada no TEXTO-FONTE,
// sem os comentários — que citam os mesmos nomes e não provam nada.
const DIALOGO = fs
  .readFileSync(path.resolve(__dirname, "..", "..", "app", "notas-fiscais", "components", "nfe-send-email-dialog.tsx"), "utf8")
  .split(/\r?\n/)
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

describe("NfeSendEmailDialog — ligação com o resultado", () => {
  it("com aviso: mostra o aviso e NÃO chama onSent (que é o toast 'E-mail enviado com sucesso')", () => {
    const ini = DIALOGO.indexOf('if (resultado.tipo === "enviado-com-aviso") {');
    expect(ini, "ramo do aviso não encontrado").toBeGreaterThan(-1);
    const ramo = DIALOGO.slice(ini, DIALOGO.indexOf("}", ini));
    expect(ramo).toContain("setAviso(resultado.texto);");
    expect(ramo).toContain("return;");
    expect(ramo).not.toContain("onSent(");
  });

  it("o aviso some ao fechar por QUALQUER caminho e ao trocar de nota", () => {
    expect(DIALOGO).toMatch(/useEffect\(\(\) => \{\s*setAviso\(null\);\s*\}, \[open, nfeId\]\);/);
  });

  it("envio normal segue como antes: sucesso, onSent e fechamento automático", () => {
    const ini = DIALOGO.indexOf("setSuccess(true);");
    expect(ini).toBeGreaterThan(DIALOGO.indexOf('if (resultado.tipo === "enviado-com-aviso") {'));
    const resto = DIALOGO.slice(ini, ini + 300);
    expect(resto).toMatch(/setSuccess\(true\);\s*onSent\(\);\s*setTimeout\(/);
  });
});
