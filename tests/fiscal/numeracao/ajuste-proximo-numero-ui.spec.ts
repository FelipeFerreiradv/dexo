import { describe, expect, it } from "vitest";
import {
  MOTIVO_MAX,
  MOTIVO_MIN,
  NUMERO_MAX,
  SERIE_MAX,
  avisoInutilizacao,
  corpoAjuste,
  corpoConfirmacao,
  desfechoAjuste,
  errosDoForm,
  inteiroDoCampo,
  linhasDaConfirmacao,
  numeroAtualDoPreview,
  numerosPulados,
  podeRevisar,
  type FormAjuste,
} from "../../../app/notas-fiscais/lib/nfe-ajuste-numeracao-ui";

// Decisões de tela do ajuste do próximo número, em node (o jsdom do projeto
// está quebrado — mesmo motivo do `nfe-numeracao-ui.spec.ts` ao lado).
//
// As réguas aqui são as MESMAS do `NfeSequenceAjusteUseCase`. Elas não
// substituem a validação do servidor: existem para o operador não gastar uma
// ida ao servidor por um motivo curto demais.

const FORM_OK: FormAjuste = {
  ambiente: "PRODUCAO",
  modelo: "55",
  serie: "1",
  proximoNumero: "5000",
  motivo: "migracao do sistema antigo - ultima NF-e do CNPJ foi a 4999",
};

// Corpo do 409 de confirmação, copiado do contrato do caso de uso.
const DETALHES_409 = {
  companyFiscalConfigId: "cfg-abc",
  emitenteDocumento: "11222333000181",
  ambiente: "PRODUCAO",
  modelo: "55",
  serie: 1,
  proximoNumeroAtual: 100,
  proximoNumeroSolicitado: 5000,
  numerosPulados: 4900,
  requerInutilizacao: true,
};
const MSG_409 =
  "O próximo número da série 1 (modelo 55, produção, CNPJ 11222333000181) passará de 100 para 5000: 4900 número(s) ficarão sem uso e essa lacuna pode exigir inutilização junto à SEFAZ. O contador nunca retrocede — isto não pode ser desfeito. Confirme para aplicar.";

describe("campos do formulário", () => {
  it("aceita o formulário completo e recusa cada campo pela régua do servidor", () => {
    expect(errosDoForm(FORM_OK)).toEqual({});
    expect(podeRevisar(FORM_OK)).toBe(true);

    // Série: inteiro de 0 a 999 (mesma faixa do preview e do guard da V2).
    expect(errosDoForm({ ...FORM_OK, serie: "0" }).serie).toBeUndefined();
    expect(errosDoForm({ ...FORM_OK, serie: String(SERIE_MAX) }).serie).toBeUndefined();
    for (const serie of ["", " ", "abc", "-1", "1.5", "1000", "1e3"]) {
      expect(errosDoForm({ ...FORM_OK, serie }).serie, serie).toBeTruthy();
    }

    // Próximo número: inteiro de 1 a 999999999 (nNF tem 9 dígitos na chave).
    expect(errosDoForm({ ...FORM_OK, proximoNumero: "1" }).proximoNumero).toBeUndefined();
    expect(
      errosDoForm({ ...FORM_OK, proximoNumero: String(NUMERO_MAX) }).proximoNumero,
    ).toBeUndefined();
    for (const n of ["", "0", "-5", "12.5", String(NUMERO_MAX + 1)]) {
      expect(errosDoForm({ ...FORM_OK, proximoNumero: n }).proximoNumero, n).toBeTruthy();
    }

    // Motivo: 15–500, contados DEPOIS do trim (vai para a auditoria).
    expect(errosDoForm({ ...FORM_OK, motivo: "a".repeat(MOTIVO_MIN) }).motivo).toBeUndefined();
    expect(errosDoForm({ ...FORM_OK, motivo: "a".repeat(MOTIVO_MAX) }).motivo).toBeUndefined();
    expect(errosDoForm({ ...FORM_OK, motivo: "a".repeat(MOTIVO_MIN - 1) }).motivo).toBeTruthy();
    expect(errosDoForm({ ...FORM_OK, motivo: "a".repeat(MOTIVO_MAX + 1) }).motivo).toBeTruthy();
    // 20 espaços em volta de 3 letras continuam sendo 3 caracteres.
    expect(errosDoForm({ ...FORM_OK, motivo: `${" ".repeat(20)}abc${" ".repeat(20)}` }).motivo).toBeTruthy();

    expect(podeRevisar({ ...FORM_OK, motivo: "curto" })).toBe(false);
  });

  it("inteiroDoCampo recusa tudo que não é inteiro decimal", () => {
    expect(inteiroDoCampo("42")).toBe(42);
    expect(inteiroDoCampo(" 42 ")).toBe(42);
    expect(inteiroDoCampo("0")).toBe(0);
    for (const v of ["", "  ", "4.2", "-1", "1e3", "0x10", "abc", "4 2"]) {
      expect(inteiroDoCampo(v), v).toBeNull();
    }
  });
});

describe("quantos números ficam sem uso", () => {
  it("é a diferença, e só quando dá para afirmar", () => {
    expect(numerosPulados(100, 5000)).toBe(4900);
    expect(numerosPulados(100, 101)).toBe(1);
    // O servidor recusa `novo <= atual` (inclusive a igualdade): não existe
    // "pulo" a mostrar, e inventar 0 sugeriria que o ajuste é inofensivo.
    expect(numerosPulados(100, 100)).toBeNull();
    expect(numerosPulados(100, 99)).toBeNull();
    // Contador atual desconhecido ⇒ a tela não adivinha.
    expect(numerosPulados(null, 5000)).toBeNull();
    expect(numerosPulados(undefined, 5000)).toBeNull();
    expect(numerosPulados(100, null)).toBeNull();
    expect(numerosPulados(100.5, 5000)).toBeNull();
  });
});

describe("número atual lido do preview", () => {
  // O GET /fiscal/nfe/proximo-numero não recebe modelo nem ambiente: ele é
  // sempre do modelo 55 e do ambiente SALVO na config. Mostrar essa resposta
  // enquanto o operador mira outro ambiente/modelo seria a mesma classe de
  // erro que mover o contador do CNPJ errado.
  const alvo = { ambiente: "PRODUCAO" as const, modelo: "55" as const, serie: "1" };
  const resposta = { serie: 1, ambiente: "PRODUCAO", proximoNumero: 100 };

  it("aceita só quando ambiente, modelo e série batem com o que está na tela", () => {
    expect(numeroAtualDoPreview(resposta, alvo)).toBe(100);

    // Ambiente diferente do que a resposta devolveu: o contador de produção
    // NÃO é o de homologação.
    expect(numeroAtualDoPreview(resposta, { ...alvo, ambiente: "HOMOLOGACAO" })).toBeNull();
    expect(
      numeroAtualDoPreview({ ...resposta, ambiente: "HOMOLOGACAO" }, alvo),
    ).toBeNull();

    // Modelo 65 tem contador próprio e o preview não sabe dele.
    expect(numeroAtualDoPreview(resposta, { ...alvo, modelo: "65" })).toBeNull();

    // Resposta atrasada de outra série (o campo mudou durante o debounce).
    expect(numeroAtualDoPreview(resposta, { ...alvo, serie: "2" })).toBeNull();
    expect(numeroAtualDoPreview({ ...resposta, serie: 2 }, alvo)).toBeNull();

    // Corpo sem número / erro / ausente.
    expect(numeroAtualDoPreview({ serie: 1, ambiente: "PRODUCAO" }, alvo)).toBeNull();
    expect(numeroAtualDoPreview({ error: "Série inválida (0–999)." } as never, alvo)).toBeNull();
    expect(numeroAtualDoPreview(null, alvo)).toBeNull();
    expect(numeroAtualDoPreview(undefined, alvo)).toBeNull();
  });

  it("série 0 é válida e não é confundida com campo vazio", () => {
    const zero = { ambiente: "HOMOLOGACAO" as const, modelo: "55" as const, serie: "0" };
    expect(
      numeroAtualDoPreview({ serie: 0, ambiente: "HOMOLOGACAO", proximoNumero: 7 }, zero),
    ).toBe(7);
    expect(
      numeroAtualDoPreview({ serie: 0, ambiente: "HOMOLOGACAO", proximoNumero: 7 }, { ...zero, serie: "" }),
    ).toBeNull();
  });
});

describe("corpo da requisição: dois passos com o MESMO corpo", () => {
  it("primeiro passo vai sem confirmar; o segundo é o mesmo corpo com confirmar:true", () => {
    const primeiro = corpoAjuste(FORM_OK, "cfg-abc");
    expect(primeiro).toEqual({
      companyFiscalConfigId: "cfg-abc",
      ambiente: "PRODUCAO",
      modelo: "55",
      serie: 1,
      proximoNumero: 5000,
      motivo: FORM_OK.motivo,
      confirmar: false,
    });
    expect(corpoConfirmacao(primeiro)).toEqual({ ...primeiro, confirmar: true });
  });

  it("congelar o corpo no 409 impede que editar o formulário por trás do diálogo troque o que será aplicado", () => {
    const congelado = corpoAjuste(FORM_OK, "cfg-abc");
    // Operador mexe no formulário com o diálogo aberto...
    const depois: FormAjuste = { ...FORM_OK, proximoNumero: "999999", serie: "9" };
    expect(corpoAjuste(depois, "cfg-abc").proximoNumero).toBe(999999);
    // ...e o que se confirma continua sendo o que foi revisado.
    expect(corpoConfirmacao(congelado)).toEqual({
      companyFiscalConfigId: "cfg-abc",
      ambiente: "PRODUCAO",
      modelo: "55",
      serie: 1,
      proximoNumero: 5000,
      motivo: FORM_OK.motivo,
      confirmar: true,
    });
  });

  it("sem emitente explícito manda null (= CNPJ padrão do tenant) e apara o motivo", () => {
    const corpo = corpoAjuste({ ...FORM_OK, motivo: `  ${FORM_OK.motivo}  ` }, null);
    expect(corpo.companyFiscalConfigId).toBeNull();
    expect(corpo.motivo).toBe(FORM_OK.motivo);
  });
});

describe("desfecho da resposta do servidor", () => {
  it("409 NUMERACAO_CONFIRMAR_AJUSTE: abre o diálogo, não mostra erro e revela o número atual", () => {
    const x = desfechoAjuste(false, {
      error: MSG_409,
      code: "NUMERACAO_CONFIRMAR_AJUSTE",
      detalhes: DETALHES_409,
    });
    expect(x.confirmacao).toEqual({ mensagem: MSG_409, detalhes: DETALHES_409 });
    // Nada foi escrito: nem toast de erro, nem "aplicado".
    expect(x.toast).toBeNull();
    expect(x.aplicado).toBeNull();
    expect(x.numeroAtual).toBe(100);
    expect(x.campoInvalido).toBeNull();
  });

  it("409 SEQUENCIA_NAO_RETROCEDE: erro com a MENSAGEM DO SERVIDOR e corrige o número mostrado", () => {
    const error =
      "O próximo número da série 1 (modelo 55, produção) já está em 5200: o contador só avança, nunca volta — número já usado não pode ser emitido de novo. Informe um número maior que 5200.";
    const x = desfechoAjuste(false, {
      error,
      code: "SEQUENCIA_NAO_RETROCEDE",
      detalhes: {
        companyFiscalConfigId: "cfg-abc",
        ambiente: "PRODUCAO",
        modelo: "55",
        serie: 1,
        proximoNumeroAtual: 5200,
        proximoNumeroSolicitado: 5000,
      },
    });
    expect(x.toast).toEqual({ msg: error, type: "error" });
    expect(x.confirmacao).toBeNull();
    expect(x.aplicado).toBeNull();
    // A tela aprendeu o número real: o preview do modelo 55 podia estar mudo.
    expect(x.numeroAtual).toBe(5200);
  });

  it("400 AJUSTE_ENTRADA_INVALIDA aponta o campo que o servidor recusou", () => {
    for (const campo of ["ambiente", "modelo", "serie", "proximoNumero", "motivo"] as const) {
      const x = desfechoAjuste(false, {
        error: `Campo ${campo} inválido`,
        code: "AJUSTE_ENTRADA_INVALIDA",
        detalhes: { campo },
      });
      expect(x.campoInvalido, campo).toBe(campo);
      expect(x.toast?.msg).toBe(`Campo ${campo} inválido`);
    }
    // Código diferente nunca marca campo (SEQUENCIA_NAO_RETROCEDE não traz `campo`).
    expect(
      desfechoAjuste(false, { error: "x", code: "SEQUENCIA_NAO_RETROCEDE" }).campoInvalido,
    ).toBeNull();
  });

  it("todo erro do contrato chega ao operador com o texto do servidor, nunca com o genérico", () => {
    const erros = [
      { status: 400, body: { error: "Emitente inválido" } }, // sem `code`, barrado na rota
      { status: 404, body: { error: "Empresa não encontrada", code: "EMITENTE_NAO_ENCONTRADO" } },
      { status: 409, body: { error: "Configuração fiscal não encontrada", code: "CONFIG_FISCAL_AUSENTE" } },
      { status: 500, body: { error: "Erro ao ajustar próximo número" } },
    ];
    for (const e of erros) {
      const x = desfechoAjuste(false, e.body);
      expect(x.toast, JSON.stringify(e)).toEqual({ msg: e.body.error, type: "error" });
      expect(x.aplicado).toBeNull();
      expect(x.confirmacao).toBeNull();
    }
    // Só o corpo sem mensagem nenhuma cai no texto genérico.
    expect(desfechoAjuste(false, {}).toast).toEqual({
      msg: "Não foi possível ajustar o próximo número.",
      type: "error",
    });
    expect(desfechoAjuste(false, null).toast?.type).toBe("error");
  });

  it("200: o contador moveu — devolve o ajuste aplicado e o número novo", () => {
    const ajuste = {
      companyFiscalConfigId: "cfg-abc",
      emitenteDocumento: "11222333000181",
      ambiente: "PRODUCAO",
      modelo: "55",
      serie: 1,
      proximoNumeroAnterior: 100,
      proximoNumero: 5000,
      numerosPulados: 4900,
      motivo: FORM_OK.motivo,
      ajustadoEm: "2026-09-23T12:00:00.000Z",
    };
    const x = desfechoAjuste(true, { success: true, ajuste });
    expect(x.aplicado).toEqual(ajuste);
    expect(x.numeroAtual).toBe(5000);
    expect(x.toast?.type).toBe("success");
    expect(x.toast?.msg).toContain("5000");
    expect(x.toast?.msg).toContain("4900");
    expect(x.confirmacao).toBeNull();
  });

  it("200 sem corpo de ajuste não conta como aplicado", () => {
    expect(desfechoAjuste(true, { success: true }).aplicado).toBeNull();
    expect(desfechoAjuste(true, {}).aplicado).toBeNull();
  });
});

describe("texto da confirmação", () => {
  it("mostra o escopo inteiro — inclusive o CNPJ, formatado", () => {
    const linhas = linhasDaConfirmacao(DETALHES_409);
    const mapa = Object.fromEntries(linhas.map((l) => [l.rotulo, l.valor]));
    expect(mapa["CNPJ que emite"]).toBe("11.222.333/0001-81");
    expect(mapa["Ambiente"]).toBe("Produção");
    expect(mapa["Tipo de nota"]).toBe("NF-e (modelo 55)");
    expect(mapa["Série"]).toBe("1");
    expect(mapa["Próximo número hoje"]).toBe("100");
    expect(mapa["Passa a ser"]).toBe("5000");
    expect(mapa["Números que ficam sem uso"]).toBe("4900");
  });

  it("série 0 e CNPJ ausente não viram buraco na tela", () => {
    const mapa = Object.fromEntries(
      linhasDaConfirmacao({
        ...DETALHES_409,
        serie: 0,
        emitenteDocumento: null,
        modelo: "65",
        ambiente: "HOMOLOGACAO",
      }).map((l) => [l.rotulo, l.valor]),
    );
    expect(mapa["Série"]).toBe("0");
    expect(mapa["CNPJ que emite"]).toBe("—");
    expect(mapa["Tipo de nota"]).toBe("NFC-e do PDV (modelo 65)");
    expect(mapa["Ambiente"]).toBe("Homologação (teste)");
  });

  it("sem `numerosPulados` no corpo, calcula do de→para", () => {
    const { numerosPulados: _fora, ...sem } = DETALHES_409;
    const mapa = Object.fromEntries(
      linhasDaConfirmacao(sem).map((l) => [l.rotulo, l.valor]),
    );
    expect(mapa["Números que ficam sem uso"]).toBe("4900");
  });

  it("o aviso da lacuna muda de tom pelo `requerInutilizacao` do servidor", () => {
    const producao = avisoInutilizacao(DETALHES_409);
    expect(producao).toContain("4900");
    expect(producao).toContain("inutilizado");
    expect(producao).toContain("contador");

    const homologacao = avisoInutilizacao({ ...DETALHES_409, requerInutilizacao: false });
    expect(homologacao).toContain("ambiente de teste");
    expect(homologacao).not.toContain("SEFAZ");

    // Campo ausente ⇒ tom cauteloso (o da produção), nunca o permissivo.
    const { requerInutilizacao: _fora, ...sem } = DETALHES_409;
    expect(avisoInutilizacao(sem)).toContain("SEFAZ");
  });
});
