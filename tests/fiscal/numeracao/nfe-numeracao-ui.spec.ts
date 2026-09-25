import { describe, expect, it } from "vitest";
import {
  MSG_EM_ANDAMENTO,
  ROTULO_EXCLUIR_RASCUNHO,
  ROTULO_RETOMAR_EMISSAO,
  acoesNumeracao,
  ajudaBloqueado,
  avisoPisoSugerido,
  descartarNumeroBloqueado,
  desfechoConsulta,
  desfechoEmissao,
  lerConfirmacaoInutilizacao,
  mostrarTentarNovamente,
  podeConsultarSituacao,
  respostaEmAndamento,
  retomarEmissao,
  rotuloTentarNovamente,
  textoConfirmacaoInutilizacao,
  textoEstadoNumeracao,
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

// ── Prontidão da V2 (G2) ──
// BLOQ-2: reserva BLOQUEADO (613 sem chave, consulta 100 com chave alheia…) não
// tinha saída pela tela — só "Nº X: BLOQUEADO" cru, sem botão. As ações novas
// valem SÓ para a linha que traz a chave `numeracao` com BLOQUEADO: a linha V1
// (sem a chave) não ganha nada, porque o DELETE apagaria nota V1 sem confirmação.

describe("BLOQUEADO: texto legível e as duas saídas (descartar o nº / excluir o rascunho)", () => {
  const bloqueado = { estado: "BLOQUEADO", numero: 501, serie: 1, reutilizavel: false };

  it("BLOQUEADO ⇒ 'Descartar o nº X e emitir com número novo' + 'Excluir rascunho', e nenhum 'Consultar situação'", () => {
    expect(acoesNumeracao(bloqueado)).toEqual({
      consultar: false,
      descartarNumero: "Descartar o nº 501 e emitir com número novo",
      excluirRascunho: ROTULO_EXCLUIR_RASCUNHO,
      retomar: null,
    });
    expect(ROTULO_EXCLUIR_RASCUNHO).toBe("Excluir rascunho");
  });

  it("o texto troca o enum cru por frase de gente, e a ajuda diz o que conferir antes de descartar", () => {
    expect(textoEstadoNumeracao(bloqueado)).toBe("retido para conferência");
    expect(textoEstadoNumeracao(bloqueado)).not.toContain("BLOQUEADO");
    const ajuda = ajudaBloqueado(bloqueado);
    expect(ajuda).toContain("nº 501");
    expect(ajuda).toMatch(/portal da SEFAZ/);
    expect(ajuda).toMatch(/NÃO foi autorizado/);
  });

  it("os outros estados seguem com o texto de antes (a regressão rotas-front-2 lê 'Nº 1: INCERTO')", () => {
    expect(textoEstadoNumeracao({ estado: "RESERVADO", numero: 1, reutilizavel: true })).toBe("mantido para nova tentativa");
    expect(textoEstadoNumeracao({ estado: "REJEITADO", numero: 1, reutilizavel: true })).toBe("mantido para nova tentativa");
    for (const estado of ["INCERTO", "EM_TRANSMISSAO", "AUTORIZADO", "CANCELADO"]) expect(textoEstadoNumeracao({ estado, numero: 1 }), estado).toBe(estado);
  });

  it("nenhum outro estado ganha as ações de descarte (Consultar continua só em INCERTO/EM_TRANSMISSAO)", () => {
    for (const estado of ["RESERVADO", "REJEITADO", "INCERTO", "EM_TRANSMISSAO", "AUTORIZADO", "CANCELADO"]) {
      const a = acoesNumeracao({ estado, numero: 9, reutilizavel: ["RESERVADO", "REJEITADO"].includes(estado) });
      expect(a.descartarNumero, estado).toBeNull();
      expect(a.excluirRascunho, estado).toBeNull();
      expect(a.consultar, estado).toBe(estado === "INCERTO" || estado === "EM_TRANSMISSAO");
    }
  });

  it("linha SEM a chave `numeracao` (V1) ou com numeracao:null ⇒ nenhuma ação nova", () => {
    const nada = { consultar: false, descartarNumero: null, excluirRascunho: null, retomar: null };
    expect(acoesNumeracao(undefined)).toEqual(nada);
    expect(acoesNumeracao(null)).toEqual(nada);
    expect(acoesNumeracao(undefined, undefined)).toEqual(nada);
  });

  it("B8: 'Retomar emissão' só com `retomavel` do servidor — com ou sem reserva viva", () => {
    expect(acoesNumeracao({ estado: "RESERVADO", numero: 3, reutilizavel: true }, true).retomar).toBe(ROTULO_RETOMAR_EMISSAO);
    expect(acoesNumeracao(null, true).retomar).toBe("Retomar emissão");
    expect(acoesNumeracao({ estado: "RESERVADO", numero: 3, reutilizavel: true }, false).retomar).toBeNull();
    expect(acoesNumeracao({ estado: "RESERVADO", numero: 3, reutilizavel: true }).retomar).toBeNull();
  });
});

describe("A2: nota V1 rejeitada numa config que entrou na V2 (legadoV1)", () => {
  const legado = (p: Partial<LinhaTentarNovamente> = {}): LinhaTentarNovamente => ({ status: "REJECTED", serie: 1, numero: 158, reaproveitavel: true, legadoV1: true, ...p });

  it("legadoV1 + REJECTED reaproveitável + flag ⇒ botão, com o rótulo NEUTRO (quem decide se reaproveita é o servidor)", () => {
    expect(mostrarTentarNovamente(legado(), true)).toBe(true);
    expect(rotuloTentarNovamente(legado())).toBe("Tentar novamente");
  });

  it("legadoV1 segue a regra do V1: sem flag ou sem cStat reaproveitável ⇒ sem botão", () => {
    expect(mostrarTentarNovamente(legado(), false)).toBe(false);
    expect(mostrarTentarNovamente(legado({ reaproveitavel: false }), true)).toBe(false);
    expect(mostrarTentarNovamente(legado({ status: "AUTHORIZED" }), true)).toBe(false);
  });

  it("numeracao:null (nº consumido: ABANDONADO/CONSUMIDO_EXTERNO/INUTILIZADO) continua SEM botão", () => {
    expect(mostrarTentarNovamente({ status: "REJECTED", serie: 1, numero: 1, reaproveitavel: true, numeracao: null }, true)).toBe(false);
  });

  it("linha V1 pura (sem legadoV1) mantém o texto antigo", () => {
    expect(rotuloTentarNovamente({ status: "REJECTED", serie: 2, numero: 15, reaproveitavel: true })).toBe("Tentar novamente — reaproveita o nº 2/15");
  });
});

describe("B6: 409 SEQUENCIA_ATRAS_DA_SEFAZ vira aviso persistente (não só o toast de 4 s)", () => {
  const MSG = "Os nºs 10, 11, 12 da série 1 já existiam na SEFAZ com outra chave: o contador do Dexo está atrás…";
  const corpo: RespostaNumeracao = {
    error: MSG,
    code: "SEQUENCIA_ATRAS_DA_SEFAZ",
    detalhes: { numeros: [10, 11, 12], serie: 1, ambiente: "PRODUCAO", modelo: "55", proximoNumeroAtual: 13, proximoNumeroMinimo: 14 },
  };

  it("desfechoEmissao ⇒ sequenciaAtras com a frase do servidor, a série, o ambiente e o piso — e o MESMO toast de erro de antes", () => {
    const x = desfechoEmissao(false, corpo);
    expect(x.sequenciaAtras).toEqual({ mensagem: MSG, serie: 1, ambiente: "PRODUCAO", modelo: "55", numeros: [10, 11, 12], pisoSugerido: 14 });
    expect(x.toast).toEqual({ msg: MSG, type: "error" });
    expect(x.pedirConfirmacaoDescarte).toBe(false);
    expect(x.numeracao).toBeUndefined();
  });

  it("detalhes ausentes ou malformados ⇒ ainda avisa, com os campos nulos (nunca inventa piso)", () => {
    const x = desfechoEmissao(false, { error: MSG, code: "SEQUENCIA_ATRAS_DA_SEFAZ" });
    expect(x.sequenciaAtras).toEqual({ mensagem: MSG, serie: null, ambiente: null, modelo: null, numeros: [], pisoSugerido: null });
    const y = desfechoEmissao(false, { error: MSG, code: "SEQUENCIA_ATRAS_DA_SEFAZ", detalhes: { serie: "1", proximoNumeroMinimo: "14", numeros: "10" } as never });
    expect(y.sequenciaAtras).toMatchObject({ serie: null, pisoSugerido: null, numeros: [] });
  });

  it("qualquer outro desfecho ⇒ sem sequenciaAtras (a chave nem aparece)", () => {
    for (const d of [
      { error: "x", code: "NUMERACAO_CONFIRMAR_DESCARTE" },
      { error: "x", code: "NUMERACAO_BLOQUEADA" },
      { error: "x" },
    ] as RespostaNumeracao[]) expect("sequenciaAtras" in desfechoEmissao(false, d), JSON.stringify(d)).toBe(false);
    expect("sequenciaAtras" in desfechoEmissao(true, { success: true, status: "AUTHORIZED", numero: 1, chaveAcesso: "3526" })).toBe(false);
    // 200 com o code (não acontece) também não vira aviso: só o 409.
    expect("sequenciaAtras" in desfechoEmissao(true, corpo)).toBe(false);
  });

  it("o card NUNCA é pré-preenchido: o piso só aparece como texto de apoio", () => {
    const aviso = avisoPisoSugerido(14);
    expect(aviso).toContain("14");
    expect(aviso).toMatch(/portal da SEFAZ/);
    expect(avisoPisoSugerido(null)).toBeNull();
    expect(avisoPisoSugerido(undefined)).toBeNull();
  });
});

describe("chamadas da tela (fetch injetado): descartar o nº BLOQUEADO e retomar emissão", () => {
  type Chamada = { url: string; init: RequestInit };
  const falso = (respostas: Array<{ status: number; body?: unknown } | Error>) => {
    const chamadas: Chamada[] = [];
    const f = (async (url: string, init: RequestInit) => {
      chamadas.push({ url, init });
      const r = respostas.shift();
      if (!r) throw new Error("chamada a mais");
      if (r instanceof Error) throw r;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} } as Response;
    }) as unknown as typeof fetch;
    return { f, chamadas };
  };
  const base = { base: "http://api.test", email: "dona@dls.test", nfeId: "n 1" };
  const MSG_409 = "O nº 501 (série 1) está retido para conferência: confirme que ele NÃO foi autorizado na SEFAZ antes de descartá-lo";

  it("1º clique vai SEM confirmar ⇒ 409 NUMERACAO_CONFIRMAR_DESCARTE ⇒ pede confirmação com a frase do servidor", async () => {
    const { f, chamadas } = falso([{ status: 409, body: { error: MSG_409, code: "NUMERACAO_CONFIRMAR_DESCARTE", detalhes: { numero: 501, serie: 1 } } }]);
    const r = await descartarNumeroBloqueado({ ...base, fetchImpl: f });
    expect(r).toMatchObject({ ok: false, confirmar: true });
    expect(r.ok === false && r.mensagem).toContain(MSG_409);
    expect(chamadas[0].url).toBe("http://api.test/fiscal/nfe/n%201/numeracao/descartar-bloqueado");
    expect(chamadas[0].init.method).toBe("POST");
    expect(JSON.parse(String(chamadas[0].init.body))).toEqual({});
    expect((chamadas[0].init.headers as Record<string, string>).email).toBe("dona@dls.test");
  });

  it("confirmado ⇒ {confirmar:true} no corpo ⇒ 200 {ok, numeroDescartado, serie}", async () => {
    const { f, chamadas } = falso([{ status: 200, body: { ok: true, numeroDescartado: 501, serie: 1 } }]);
    const r = await descartarNumeroBloqueado({ ...base, confirmar: true, fetchImpl: f });
    expect(r).toEqual({ ok: true, numeroDescartado: 501, serie: 1 });
    expect(JSON.parse(String(chamadas[0].init.body))).toEqual({ confirmar: true });
  });

  it("409 NUMERACAO_NAO_BLOQUEADA, 404 e rede caída ⇒ erro com a frase do servidor (ou a padrão), nunca confirmação", async () => {
    const naoBloq = falso([{ status: 409, body: { error: "A reserva desta nota não está retida", code: "NUMERACAO_NAO_BLOQUEADA" } }]);
    expect(await descartarNumeroBloqueado({ ...base, fetchImpl: naoBloq.f })).toEqual({ ok: false, confirmar: false, mensagem: "A reserva desta nota não está retida" });
    const nf = falso([{ status: 404, body: { error: "Nota não encontrada" } }]);
    expect(await descartarNumeroBloqueado({ ...base, fetchImpl: nf.f })).toEqual({ ok: false, confirmar: false, mensagem: "Nota não encontrada" });
    const rede = falso([new TypeError("fetch failed")]);
    const r = await descartarNumeroBloqueado({ ...base, fetchImpl: rede.f });
    expect(r).toMatchObject({ ok: false, confirmar: false });
    // 409 de confirmação JÁ confirmado (não deveria acontecer): erro, não laço de confirmação.
    const laco = falso([{ status: 409, body: { error: MSG_409, code: "NUMERACAO_CONFIRMAR_DESCARTE" } }]);
    expect(await descartarNumeroBloqueado({ ...base, confirmar: true, fetchImpl: laco.f })).toMatchObject({ ok: false, confirmar: false });
  });

  it("retomarEmissao ⇒ POST /issue DIRETO (nunca pelo wizard) e a frase do desfecho da emissão", async () => {
    const { f, chamadas } = falso([{ status: 200, body: { success: true, status: "AUTHORIZED", numero: 7, chaveAcesso: "35260912345678000190550010000000071234567890", numeracao: { estado: "AUTORIZADO", numero: 7 } } }]);
    const r = await retomarEmissao({ ...base, fetchImpl: f });
    expect(chamadas[0].url).toBe("http://api.test/fiscal/nfe/n%201/issue");
    expect(chamadas[0].init.method).toBe("POST");
    expect(r.ok).toBe(true);
    expect(r.mensagem).toBe("NF-e 7 autorizada! Chave: 35260912345678000190...");
    expect(r.corpo).toMatchObject({ status: "AUTHORIZED" });
    const erro = falso([{ status: 409, body: { error: "Numeração nº 3 exige conferência manual", code: "NUMERACAO_BLOQUEADA" } }]);
    expect(await retomarEmissao({ ...base, fetchImpl: erro.f })).toMatchObject({ ok: false, mensagem: "Numeração nº 3 exige conferência manual" });
    const rede = falso([new TypeError("fetch failed")]);
    expect(await retomarEmissao({ ...base, fetchImpl: rede.f })).toMatchObject({ ok: false, mensagem: "Erro de conexao ao emitir NF-e" });
  });
});

describe("C1: inutilização V2 com número preso em nota não emitida (409 NUMERACAO_CONFIRMAR_DESCARTE)", () => {
  const corpo = { error: "Os nºs 92, 93 da série 4 estão reservados", code: "NUMERACAO_CONFIRMAR_DESCARTE", detalhes: { numeros: [92, 93], serie: 4 } };

  it("409 com o code e os números ⇒ pede confirmação listando os números", () => {
    const c = lerConfirmacaoInutilizacao(409, corpo);
    expect(c).toEqual({ numeros: [92, 93], serie: 4, mensagem: corpo.error });
    const t = textoConfirmacaoInutilizacao(c!);
    expect(t).toContain("92, 93");
    expect(t).toContain("série 4");
    expect(t).toMatch(/número novo/);
    expect(textoConfirmacaoInutilizacao({ numeros: [92], serie: 4, mensagem: "" })).toMatch(/^O nº 92 da série 4/);
  });

  it("qualquer outro caso ⇒ null (a tela segue com o toast de erro de sempre)", () => {
    expect(lerConfirmacaoInutilizacao(422, corpo)).toBeNull();
    expect(lerConfirmacaoInutilizacao(409, { ...corpo, code: "NUMERACAO_FAIXA_COM_NUMERO_VIVO" })).toBeNull();
    // Sem os números não há o que confirmar: nunca um "confirmo" às cegas.
    expect(lerConfirmacaoInutilizacao(409, { ...corpo, detalhes: {} })).toBeNull();
    expect(lerConfirmacaoInutilizacao(409, { ...corpo, detalhes: { numeros: [] } })).toBeNull();
    expect(lerConfirmacaoInutilizacao(409, null)).toBeNull();
    expect(lerConfirmacaoInutilizacao(409, "x")).toBeNull();
  });
});
