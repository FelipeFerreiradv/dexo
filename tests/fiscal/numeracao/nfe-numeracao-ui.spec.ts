import { describe, expect, it } from "vitest";
import {
  MSG_EM_ANDAMENTO,
  desfechoConsulta,
  desfechoEmissao,
  mostrarTentarNovamente,
  podeConsultarSituacao,
  respostaEmAndamento,
  rotuloTentarNovamente,
  type LinhaTentarNovamente,
  type RespostaNumeracao,
} from "../../../app/notas-fiscais/lib/nfe-numeracao-ui";

// Decisões de tela da numeração V2 (lista + wizard), em node.
// Linhas/respostas SEM a chave `numeracao` são V1: comparadas com um ORÁCULO que
// reproduz, linha a linha, o código anterior de nfe-list.tsx / nfe-wizard.tsx.

// ── Oráculos V1 (código de antes, copiado) ──
function listaV1Antes(nota: LinhaTentarNovamente, flag: boolean): boolean {
  return !!(flag && nota.status === "REJECTED" && nota.reaproveitavel);
}
function handleEmitirAntes(ok: boolean, data: RespostaNumeracao) {
  const out = { numeracao: undefined as unknown, confirmar: false, toast: null as null | { msg: string; type: string }, redirect: false };
  if (data.numeracao) out.numeracao = data.numeracao;
  if (!ok) {
    if (data.code === "NUMERACAO_CONFIRMAR_DESCARTE") out.confirmar = true;
    out.toast = { msg: data.error || "Erro ao emitir NF-e", type: "error" };
    return out;
  }
  if (data.success) {
    if (data.status === "AUTHORIZED") {
      out.toast = { msg: `NF-e ${data.numero} autorizada! Chave: ${data.chaveAcesso?.slice(0, 20)}...`, type: "success" };
      out.redirect = true;
    } else out.toast = { msg: data.mensagem || "NF-e enviada, aguardando SEFAZ", type: "info" };
  } else out.toast = { msg: data.mensagem || "NF-e rejeitada pela SEFAZ", type: "error" };
  return out;
}

const STATUS = ["DRAFT", "VALIDATING", "SIGNING", "SENDING", "AUTHORIZED", "REJECTED", "DENIED", "CANCELLED"];

describe("lista: botão 'Tentar novamente'", () => {
  it("linha V1 (sem a chave numeracao): idêntica ao código anterior em toda a matriz", () => {
    let casos = 0;
    for (const status of STATUS)
      for (const reaproveitavel of [true, false, undefined])
        for (const flag of [true, false]) {
          const nota: LinhaTentarNovamente = { status, serie: 1, numero: 7, ...(reaproveitavel === undefined ? {} : { reaproveitavel }) };
          expect(mostrarTentarNovamente(nota, flag), JSON.stringify({ nota, flag })).toBe(listaV1Antes(nota, flag));
          casos++;
        }
    expect(casos).toBe(STATUS.length * 3 * 2);
    // Mesmo texto que o JSX antigo produzia ("reaproveita o nº{" "}{serie}/{numero}").
    expect(rotuloTentarNovamente({ status: "REJECTED", serie: 2, numero: 15, reaproveitavel: true })).toBe("Tentar novamente — reaproveita o nº 2/15");
  });

  it("V2, recusa pré-envio do Focus (422): REJECTED + RESERVADO sem cStat ⇒ botão, mesmo com reaproveitavel:false e flag NEXT_PUBLIC desligada", () => {
    const nota: LinhaTentarNovamente = { status: "REJECTED", serie: 1, numero: 1, reaproveitavel: false, numeracao: { estado: "RESERVADO", numero: 1, serie: 1, reutilizavel: true } };
    expect(mostrarTentarNovamente(nota, false)).toBe(true);
    expect(mostrarTentarNovamente(nota, true)).toBe(true);
    expect(rotuloTentarNovamente(nota)).toBe("Tentar novamente — mantém o nº 1");
  });

  it("V2, rejeição SEFAZ com nº mantido (REJEITADO) ⇒ botão com 'mantém o nº N'", () => {
    const nota: LinhaTentarNovamente = { status: "REJECTED", serie: 1, numero: 2, reaproveitavel: true, numeracao: { estado: "REJEITADO", numero: 2, serie: 1, reutilizavel: true } };
    expect(mostrarTentarNovamente(nota, false)).toBe(true);
    expect(rotuloTentarNovamente(nota)).toBe("Tentar novamente — mantém o nº 2");
  });

  it("V2 com o nº consumido (206/205/301-303 ⇒ numeracao null): SEM botão, mesmo com reaproveitavel V1 true e flag ligada", () => {
    const nota: LinhaTentarNovamente = { status: "REJECTED", serie: 1, numero: 1, reaproveitavel: true, numeracao: null };
    expect(mostrarTentarNovamente(nota, true)).toBe(false);
  });

  it("V2: reserva não reutilizável ou nota fora de REJECTED ⇒ sem botão", () => {
    expect(mostrarTentarNovamente({ status: "REJECTED", serie: 1, numero: 3, numeracao: { estado: "BLOQUEADO", numero: 3, reutilizavel: false } }, true)).toBe(false);
    expect(mostrarTentarNovamente({ status: "REJECTED", serie: 1, numero: 3, numeracao: { estado: "INCERTO", numero: 3 } }, true)).toBe(false);
    for (const status of STATUS.filter((s) => s !== "REJECTED"))
      expect(mostrarTentarNovamente({ status, serie: 1, numero: 3, numeracao: { estado: "RESERVADO", numero: 3, reutilizavel: true } }, true), status).toBe(false);
  });
});

describe("wizard: desfecho de POST /issue", () => {
  it("resposta V1 (sem numeracao/emAndamento): idêntica ao handleEmitir anterior em toda a matriz", () => {
    let casos = 0;
    for (const ok of [true, false])
      for (const success of [true, false, undefined])
        for (const status of [...STATUS, undefined])
          for (const mensagem of ["msg do provedor", undefined])
            for (const code of ["NUMERACAO_CONFIRMAR_DESCARTE", "OUTRO", undefined])
              for (const error of ["falhou", undefined]) {
                const data: RespostaNumeracao = { numero: 12, chaveAcesso: "35260912345678000190550010000000121234567890" };
                if (success !== undefined) data.success = success;
                if (status !== undefined) data.status = status;
                if (mensagem !== undefined) data.mensagem = mensagem;
                if (code !== undefined) data.code = code;
                if (error !== undefined) data.error = error;
                const antes = handleEmitirAntes(ok, data);
                const agora = desfechoEmissao(ok, data);
                const ctx = JSON.stringify({ ok, data });
                expect(agora.numeracao, ctx).toBeUndefined();
                expect(agora.pedirConfirmacaoDescarte, ctx).toBe(antes.confirmar);
                expect(agora.toast, ctx).toEqual(antes.toast);
                expect(agora.redirecionar, ctx).toBe(antes.redirect);
                casos++;
              }
    expect(casos).toBe(2 * 3 * (STATUS.length + 1) * 2 * 3 * 2);
  });

  it("V1: SENDING com success:false (provedor 'erro') segue ERRO — só a resposta V2 vira 'em andamento'", () => {
    const d: RespostaNumeracao = { success: false, status: "SENDING", numero: 5, mensagem: "Erro do provedor" };
    expect(respostaEmAndamento(d)).toBe(false);
    expect(desfechoEmissao(true, d).toast).toEqual({ msg: "Erro do provedor", type: "error" });
  });

  it("V2, Focus 202 ⇒ INCERTO: toast INFO mandando consultar (nunca erro) e a tela mostra a reserva", () => {
    const d: RespostaNumeracao = { success: false, status: "SENDING", numero: 1, serie: 1, emAndamento: true, mensagem: "Focus ainda processando", numeracao: { estado: "INCERTO", numero: 1, serie: 1, reutilizavel: false } };
    const x = desfechoEmissao(true, d);
    expect(x).toEqual({ numeracao: d.numeracao, toast: { msg: MSG_EM_ANDAMENTO, type: "info" }, redirecionar: false, pedirConfirmacaoDescarte: false });
    expect(MSG_EM_ANDAMENTO).toBe("NF-e enviada, aguardando SEFAZ — use Consultar situação");
  });

  it("V2, status SENDING com a chave numeracao mas sem emAndamento ⇒ info", () => {
    const x = desfechoEmissao(true, { success: false, status: "SENDING", numeracao: { estado: "EM_TRANSMISSAO", numero: 4 } });
    expect(x.toast).toEqual({ msg: MSG_EM_ANDAMENTO, type: "info" });
  });

  it("V2, claim perdido (VALIDATING, sem botão de consulta) ⇒ info com a mensagem do servidor", () => {
    const d: RespostaNumeracao = { success: false, status: "VALIDATING", emAndamento: true, mensagem: "Emissão desta NF-e já está em andamento", numeracao: { estado: "RESERVADO", numero: 3, reutilizavel: true } };
    expect(desfechoEmissao(true, d).toast).toEqual({ msg: "Emissão desta NF-e já está em andamento", type: "info" });
    expect(desfechoEmissao(true, { ...d, mensagem: undefined }).toast).toEqual({ msg: "NF-e enviada, aguardando SEFAZ", type: "info" });
  });

  it("V2, rejeitada com nº mantido ⇒ erro + numeracao REJEITADO na tela", () => {
    const d: RespostaNumeracao = { success: false, status: "REJECTED", emAndamento: false, mensagem: "Rejeicao: Falha no Schema XML", numeracao: { estado: "REJEITADO", numero: 1, reutilizavel: true } };
    expect(desfechoEmissao(true, d)).toEqual({ numeracao: d.numeracao, toast: { msg: "Rejeicao: Falha no Schema XML", type: "error" }, redirecionar: false, pedirConfirmacaoDescarte: false });
  });

  it("V2, nº consumido (numeracao:null) ⇒ LIMPA a tela (null, não undefined) — some o 'mantido para nova tentativa'", () => {
    const x = desfechoEmissao(true, { success: false, status: "DENIED", emAndamento: false, mensagem: "Uso Denegado", numeracao: null });
    expect(x.numeracao).toBeNull();
    expect(x.toast).toEqual({ msg: "Uso Denegado", type: "error" });
  });

  it("V2 autorizada ⇒ sucesso + redireciona, numeracao AUTORIZADO", () => {
    const d: RespostaNumeracao = { success: true, status: "AUTHORIZED", numero: 9, chaveAcesso: "35260912345678000190550010000000091234567890", emAndamento: false, numeracao: { estado: "AUTORIZADO", numero: 9 } };
    const x = desfechoEmissao(true, d);
    expect(x.redirecionar).toBe(true);
    expect(x.toast).toEqual({ msg: "NF-e 9 autorizada! Chave: 35260912345678000190...", type: "success" });
    expect(x.numeracao).toEqual({ estado: "AUTORIZADO", numero: 9 });
  });

  it("409 NUMERACAO_CONFIRMAR_DESCARTE ⇒ pede confirmação, erro com a mensagem da rota", () => {
    const x = desfechoEmissao(false, { error: "Confirme o descarte do nº 10", code: "NUMERACAO_CONFIRMAR_DESCARTE" });
    expect(x).toEqual({ numeracao: undefined, toast: { msg: "Confirme o descarte do nº 10", type: "error" }, redirecionar: false, pedirConfirmacaoDescarte: true });
  });
});

describe("wizard: desfecho de POST /consultar-situacao (resposta repassada pelo NumeracaoActions)", () => {
  it("autorizada ⇒ numeracao AUTORIZADO, toast de sucesso e redireciona (como o handleEmitir)", () => {
    const d: RespostaNumeracao = { success: true, status: "AUTHORIZED", numero: 1, chaveAcesso: "35260912345678000190550010000000011234567890", mensagem: "NF-e autorizada", emAndamento: false, numeracao: { estado: "AUTORIZADO", numero: 1, serie: 1, reutilizavel: false } };
    expect(desfechoConsulta(d)).toEqual({ numeracao: d.numeracao, toast: { msg: "NF-e 1 autorizada! Chave: 35260912345678000190...", type: "success" }, redirecionar: true, pedirConfirmacaoDescarte: false });
  });

  it("ainda incerta ⇒ só atualiza a numeração (a mensagem fica no NumeracaoActions)", () => {
    const d: RespostaNumeracao = { success: false, status: "SENDING", emAndamento: true, mensagem: "Resultado ainda incerto", numeracao: { estado: "INCERTO", numero: 1 } };
    expect(desfechoConsulta(d)).toEqual({ numeracao: d.numeracao, toast: null, redirecionar: false, pedirConfirmacaoDescarte: false });
  });

  it("nº consumido ⇒ numeracao null + toast com a mensagem (o NumeracaoActions some da tela)", () => {
    const x = desfechoConsulta({ success: false, status: "DENIED", mensagem: "Uso Denegado: Irregularidade fiscal do destinatario", numeracao: null });
    expect(x).toEqual({ numeracao: null, toast: { msg: "Uso Denegado: Irregularidade fiscal do destinatario", type: "error" }, redirecionar: false, pedirConfirmacaoDescarte: false });
  });

  it("nº consumido sem mensagem ⇒ só limpa; corpo de erro ({error,code}) não mexe em nada", () => {
    expect(desfechoConsulta({ success: false, status: "DENIED", numeracao: null })).toEqual({ numeracao: null, toast: null, redirecionar: false, pedirConfirmacaoDescarte: false });
    expect(desfechoConsulta({ error: "Recurso indisponível", code: "RECURSO_INDISPONIVEL" })).toEqual({ numeracao: undefined, toast: null, redirecionar: false, pedirConfirmacaoDescarte: false });
  });

  it("botão 'Consultar situação' só para INCERTO/EM_TRANSMISSAO", () => {
    expect(podeConsultarSituacao({ estado: "INCERTO", numero: 1 })).toBe(true);
    expect(podeConsultarSituacao({ estado: "EM_TRANSMISSAO", numero: 1 })).toBe(true);
    for (const estado of ["RESERVADO", "REJEITADO", "BLOQUEADO", "AUTORIZADO", "CANCELADO"]) expect(podeConsultarSituacao({ estado, numero: 1 }), estado).toBe(false);
    expect(podeConsultarSituacao(null)).toBe(false);
    expect(podeConsultarSituacao(undefined)).toBe(false);
  });
});
