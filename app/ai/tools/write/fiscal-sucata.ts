// Tool de ESCRITA: completar o bloco FISCAL de uma sucata a partir da nota.
//
// ⭐ O CASO REAL: o lojista arremata um veículo, recebe a NF-e, e hoje precisa
// abrir a tela de Sucatas e digitar chave de acesso, CNPJ do fornecedor, número,
// série, data e ICMS à mão. Com a leitura de anexo (Fase 8) o XML já chega ao
// turno; o que faltava era um lugar para gravar.
//
// ⚠️⚠️ O RISCO QUE GOVERNA ESTE ARQUIVO: a leitura do anexo vira TEXTO no
// contexto do modelo, não um objeto que a tool possa referenciar. Ou seja, os
// valores chegam aqui TRANSCRITOS por um LLM — e uma chave de acesso de 44
// dígitos com um dígito trocado é pior que chave nenhuma: ela aponta para outra
// nota, ou para nada, e ninguém percebe.
//
// A defesa é em três camadas, e nenhuma delas é confiança:
//   1. a CHAVE tem dígito verificador (módulo 11 sobre os 43 primeiros) e é
//      conferida por `parseChave`, o MESMO validador que a emissão de NF-e usa.
//      Um dígito trocado reprova com ~90% de probabilidade;
//   2. o CNPJ do fornecedor passa por `isValidCnpj`;
//   3. tudo o que sobra vai para o CARTÃO, formatado, e o lojista compara com a
//      nota que está na mão dele antes de clicar. É a mesma troca de confiança
//      do resto do Bitz — o agente propõe, o humano confere.

import { z } from "zod";

import { parseChave } from "../../../fiscal/sefaz/chave-acesso";
import { isValidCnpj, onlyDigits } from "../../../lib/masks";
import { ScrapUseCase } from "../../../usecases/scrap.usercase";
import { proporAcao } from "../../acoes/acao.service";
import {
  ACAO_EXIGE_PERMISSAO,
  type AiAcaoPreview,
} from "../../acoes/acao.types";
import type { AiScope } from "../../core/scope";
import type { AiTool, AiToolContext, AiWriteToolResult } from "../registry";

const MAX_VALOR = 9_999_999;

const brl = (n: number) =>
  n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function semProposta(instrucao: string): AiWriteToolResult {
  return { acao: null, paraOModelo: { proposta: "faltou_dado", instrucao } };
}

/** Como o cartão nomeia um lote. */
function rotuloDaSucata(s: any): string {
  const base = [s?.brand, s?.model, s?.year].filter(Boolean).join(" ");
  const extra = s?.plate ? `placa ${s.plate}` : s?.nickname || null;
  return extra ? `${base} · ${extra}` : base || "sucata sem identificação";
}

/** Formata a data como o lojista lê, sem inventar fuso. */
function dataBR(iso: string): string {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

export const completarFiscalDaSucata: AiTool = {
  name: "completar_fiscal_da_sucata",
  description:
    "PREPARA o preenchimento dos dados da NOTA FISCAL de uma sucata já cadastrada. NÃO altera nada agora: devolve uma proposta que o usuário confirma na tela. " +
    "Use quando ele anexar o XML da NF-e do veículo ou ditar os dados da nota. " +
    "Copie os valores EXATAMENTE como aparecem na leitura do anexo — não arredonde, não complete e não adivinhe dígito nenhum. " +
    "Se algum campo não estiver na nota, deixe vazio em vez de inventar.",
  args: z
    .object({
      sucata: z
        .string()
        .min(2)
        .max(80)
        .describe(
          "Como identificar o lote: placa, apelido do pátio ou marca+modelo+ano.",
        ),
      chaveDeAcesso: z
        .string()
        .max(60)
        .optional()
        .describe("Os 44 dígitos da chave de acesso da NF-e."),
      cnpjDoFornecedor: z
        .string()
        .max(20)
        .optional()
        .describe("CNPJ de quem emitiu a nota."),
      numeroDaNota: z.string().max(20).optional(),
      serie: z.string().max(10).optional(),
      dataDeEmissao: z
        .string()
        .max(10)
        .optional()
        .describe("Data de emissão no formato AAAA-MM-DD."),
      naturezaDaOperacao: z.string().max(80).optional(),
      valorDoIcms: z
        .number()
        .min(0)
        .max(MAX_VALOR)
        .optional()
        .describe("Valor do ICMS da nota, em reais."),
    })
    .strict(),
  kind: "write",
  page: "sucatas",
  action: ACAO_EXIGE_PERMISSAO["sucata.fiscal"],
  keywords: [
    "nota fiscal",
    "nfe",
    "nf-e",
    "chave de acesso",
    "danfe",
    "fiscal",
    "sucata",
    "lote",
  ],
  sourceLabel: "Dados fiscais da sucata",
  async handler(
    args,
    scope,
    ctx?: AiToolContext,
  ): Promise<AiWriteToolResult> {
    // 1. A chave. Se veio, ela TEM de fechar o dígito verificador.
    let chave: string | null = null;
    if (args.chaveDeAcesso) {
      const digitos = onlyDigits(args.chaveDeAcesso);
      if (digitos.length !== 44) {
        return semProposta(
          `A chave de acesso que você passou tem ${digitos.length} dígitos, e a chave de uma NF-e tem 44. ` +
            "Confira a leitura do anexo e copie a chave INTEIRA, sem cortar. Não complete com zeros.",
        );
      }
      try {
        parseChave(digitos);
      } catch {
        // ⭐ O dígito verificador é o que transforma "o modelo transcreveu
        // errado" de defeito silencioso em recusa visível.
        return semProposta(
          "A chave de acesso não passou na conferência do dígito verificador — provavelmente algum dígito saiu trocado na cópia. " +
            "Leia a chave de novo no anexo e confira dígito a dígito. NÃO tente adivinhar o dígito certo.",
        );
      }
      chave = digitos;
    }

    // 2. O CNPJ do emitente.
    let cnpj: string | null = null;
    if (args.cnpjDoFornecedor) {
      const d = onlyDigits(args.cnpjDoFornecedor);
      if (!isValidCnpj(d)) {
        return semProposta(
          "O CNPJ do fornecedor não é válido (o dígito verificador não fecha). " +
            "Confira na nota e copie de novo. NÃO invente um CNPJ.",
        );
      }
      cnpj = d;
    }

    // 3. A data, se veio.
    let emissao: string | null = null;
    if (args.dataDeEmissao) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.dataDeEmissao)) {
        return semProposta(
          "A data de emissão precisa estar no formato AAAA-MM-DD. Converta antes de chamar de novo.",
        );
      }
      emissao = args.dataDeEmissao;
    }

    const temAlgo =
      chave ||
      cnpj ||
      emissao ||
      args.numeroDaNota ||
      args.serie ||
      args.naturezaDaOperacao ||
      args.valorDoIcms !== undefined;

    if (!temAlgo) {
      return semProposta(
        "Não veio nenhum dado de nota fiscal para gravar. Peça ao usuário para anexar o XML da NF-e ou ditar os dados.",
      );
    }

    // 4. O lote. Mesma busca de `vincular_peca_a_sucata`, mesma regra de
    //    ambiguidade: perguntar, nunca escolher.
    let candidatas: any[] = [];
    try {
      const r = await new ScrapUseCase().listScraps({
        search: args.sucata,
        userId: scope.dataOwnerId,
        limit: 6,
        page: 1,
      });
      candidatas = Array.isArray(r?.scraps) ? r.scraps : [];
    } catch {
      return semProposta(
        "Não consegui consultar as sucatas agora. Diga ao usuário que ele pode tentar de novo em instantes.",
      );
    }

    if (candidatas.length === 0) {
      return semProposta(
        `Não achei nenhuma sucata que case com "${args.sucata}". ` +
          "Pergunte a placa ou o apelido do lote. NÃO escolha uma sucata por conta própria.",
      );
    }
    if (candidatas.length > 1) {
      return {
        acao: null,
        paraOModelo: {
          proposta: "faltou_dado",
          instrucao:
            `Achei ${candidatas.length} sucatas que casam com "${args.sucata}". ` +
            "Pergunte qual é a certa — os botões já aparecem na tela. NÃO escolha por conta própria.",
        },
        opcoes: candidatas.map((s) => ({
          rotulo: rotuloDaSucata(s),
          enviar: `Os dados da nota são da sucata ${s?.plate || s?.nickname || rotuloDaSucata(s)}`,
        })),
      };
    }

    const sucata = candidatas[0];

    const campos = [
      ...(chave
        ? [
            {
              campo: "Chave de acesso",
              ...(sucata.accessKey ? { de: "já preenchida" } : {}),
              para: chave,
            },
          ]
        : []),
      ...(cnpj ? [{ campo: "CNPJ do fornecedor", para: cnpj }] : []),
      ...(args.numeroDaNota
        ? [{ campo: "Número da nota", para: args.numeroDaNota }]
        : []),
      ...(args.serie ? [{ campo: "Série", para: args.serie }] : []),
      ...(emissao ? [{ campo: "Emissão", para: dataBR(emissao) }] : []),
      ...(args.naturezaDaOperacao
        ? [{ campo: "Natureza da operação", para: args.naturezaDaOperacao }]
        : []),
      ...(args.valorDoIcms !== undefined
        ? [{ campo: "ICMS", para: brl(args.valorDoIcms) }]
        : []),
    ];

    const preview: AiAcaoPreview = {
      titulo: "Preencher dados fiscais da sucata",
      alvo: rotuloDaSucata(sucata),
      campos,
      // ⚠️⚠️ O AVISO MAIS IMPORTANTE DESTE CARTÃO: estes números foram COPIADOS
      // de um documento por um modelo de linguagem. A chave e o CNPJ têm dígito
      // verificador e já foram conferidos; o resto não tem como ser conferido
      // por máquina, e é o lojista com a nota na mão quem fecha essa conta.
      aviso:
        "⚠️ Confira CAMPO A CAMPO contra a nota antes de confirmar: estes valores foram copiados do documento automaticamente. " +
        "A chave de acesso e o CNPJ já passaram na conferência do dígito verificador; número, série, data e ICMS não têm como ser conferidos pelo sistema. " +
        "Isto não emite nem altera nota nenhuma — só guarda os dados no cadastro da sucata.",
    };

    const acao = await proporAcao({
      scope,
      tipo: "sucata.fiscal",
      payload: {
        sucataId: sucata.id,
        fiscal: {
          ...(chave ? { accessKey: chave } : {}),
          ...(cnpj ? { supplierCnpj: cnpj } : {}),
          ...(args.numeroDaNota ? { nfeNumber: args.numeroDaNota } : {}),
          ...(args.serie ? { nfeSeries: args.serie } : {}),
          ...(emissao ? { issueDate: emissao } : {}),
          ...(args.naturezaDaOperacao
            ? { operationNature: args.naturezaDaOperacao }
            : {}),
          ...(args.valorDoIcms !== undefined
            ? { icmsValue: args.valorDoIcms }
            : {}),
        },
      },
      preview,
      conversationId: ctx?.conversationId,
    });

    return {
      acao,
      paraOModelo: {
        proposta: "criada",
        acaoId: acao.id,
        instrucao:
          "Preparei o preenchimento dos dados fiscais. Diga ao usuário, em UMA frase, de qual sucata e quantos campos, e peça para ele CONFERIR CAMPO A CAMPO contra a nota antes de confirmar. " +
          "NÃO diga que já foi feito. " +
          'Se ele responder "sim" por escrito, explique que a confirmação é o botão do cartão.',
      },
    };
  },
};
