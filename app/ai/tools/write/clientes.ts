// Tool de ESCRITA de cliente. Fase 9.
//
// ⭐ NÃO CADASTRA. Valida, monta o resumo e grava uma PROPOSTA; quem cadastra é
// o clique do lojista.
//
// ⚠️ DOCUMENTO NÃO ENTRA POR AQUI, e é decisão de segurança, não esquecimento.
// CPF e CNPJ estão na lista de `CAMPOS_PROIBIDOS` do tool-runner — o resultado
// de uma tool sai por HTTP para o provedor de IA, e documento de pessoa física
// é exatamente o que não pode fazer essa viagem. Quem precisa do CPF preenche
// na tela de Clientes, que não passa por modelo nenhum.
//
// O cadastro sem documento é válido no sistema (`CustomerCreate` só exige
// `name` e `userId`), então isto não cria um cliente pela metade: cria um
// cliente com o que o lojista ditou, e o resto ele completa quando precisar
// emitir nota.

import { z } from "zod";

import { CustomerUseCase } from "../../../usecases/customer.usecase";
import { proporAcao } from "../../acoes/acao.service";
import {
  ACAO_EXIGE_PERMISSAO,
  type AiAcaoPreview,
} from "../../acoes/acao.types";
import type { AiScope } from "../../core/scope";
import type { AiTool, AiToolContext } from "../registry";

/** Já existe alguém com nome muito parecido? Vira aviso, nunca bloqueio. */
async function jaExisteParecido(
  nome: string,
  scope: AiScope,
): Promise<string | undefined> {
  try {
    // ⚠️ ASSINATURA POSICIONAL: `search(q, userId)`. Ela estava sendo chamada
    // com um OBJETO por trás de um `as any` — o `userId` chegava como `undefined`
    // e o retorno nunca casava, então o aviso de duplicado era LINHA MORTA. O
    // `as any` foi o que escondeu; sem ele, o compilador teria pego na hora.
    const usecase = new CustomerUseCase();
    const achados = (await usecase.search(nome, scope.dataOwnerId)) ?? [];

    const alvo = nome.trim().toLowerCase();
    const iguais = (Array.isArray(achados) ? achados : [])
      .map((c) => String(c?.name ?? "").trim())
      .filter((n) => n.toLowerCase() === alvo);

    if (iguais.length === 0) return undefined;
    return `⚠️ Já existe ${iguais.length === 1 ? "um cliente" : `${iguais.length} clientes`} com este mesmo nome. Confira se não é a mesma pessoa antes de confirmar.`;
  } catch {
    // ⚠️ A busca de parecidos é CONVENIÊNCIA. Se ela falhar, a proposta segue
    // sem o aviso — trocar um cadastro por um erro de busca seria pior. O que
    // não pode falhar em silêncio é a escrita, e essa nem aconteceu ainda.
    return undefined;
  }
}

export const cadastrarCliente: AiTool = {
  name: "cadastrar_cliente",
  description:
    "PREPARA o cadastro de um cliente novo. NÃO cadastra: devolve uma proposta que o usuário confirma na tela. " +
    "Use quando ele pedir para cadastrar, criar ou incluir um cliente. " +
    "NÃO peça e NÃO aceite CPF nem CNPJ: documento se preenche na tela de Clientes.",
  args: z
    .object({
      nome: z
        .string()
        .min(2)
        .max(120)
        .describe("Nome da pessoa ou da empresa."),
      telefone: z
        .string()
        .max(30)
        .optional()
        .describe("Telefone ou celular, como o usuário ditou."),
      email: z.string().max(120).optional(),
      cidade: z.string().max(80).optional(),
      estado: z
        .string()
        .max(2)
        .optional()
        .describe("Sigla do estado, duas letras."),
      observacao: z
        .string()
        .max(200)
        .optional()
        .describe("Observação curta, se o usuário ditou uma."),
    })
    .strict(),
  kind: "write",
  page: "clientes",
  action: ACAO_EXIGE_PERMISSAO["cliente.criar"],
  // Verbo + "cliente". Os pares antigos ("cadastra cliente") eram linha morta:
  // "cadastra UM cliente" já não casava.
  keywords: [
    "cadastr",
    "cria",
    "criar",
    "inclui",
    "adicion",
    "nova",
    "novo",
    "cliente",
    "comprador",
    "oficina",
  ],
  sourceLabel: "Cadastro de cliente",
  async handler(args, scope, ctx?: AiToolContext) {
    const campos = [
      { campo: "Nome", para: args.nome },
      ...(args.telefone ? [{ campo: "Telefone", para: args.telefone }] : []),
      ...(args.email ? [{ campo: "E-mail", para: args.email }] : []),
      ...(args.cidade ? [{ campo: "Cidade", para: args.cidade }] : []),
      ...(args.estado
        ? [{ campo: "Estado", para: args.estado.toUpperCase() }]
        : []),
      ...(args.observacao
        ? [{ campo: "Observação", para: args.observacao }]
        : []),
    ];

    const duplicado = await jaExisteParecido(args.nome, scope);

    const preview: AiAcaoPreview = {
      titulo: "Cadastrar cliente",
      alvo: args.nome,
      campos,
      aviso:
        duplicado ??
        "CPF, CNPJ e endereço completo não entram por aqui — complete na tela de Clientes quando precisar emitir nota.",
    };

    const acao = await proporAcao({
      scope,
      tipo: "cliente.criar",
      payload: {
        cliente: {
          name: args.nome,
          phone: args.telefone ?? null,
          email: args.email ?? null,
          city: args.cidade ?? null,
          state: args.estado ? args.estado.toUpperCase() : null,
          notes: args.observacao ?? null,
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
          "Preparei o cadastro do cliente. Diga ao usuário, em UMA frase, o que você preparou, e peça para ele CONFERIR E CONFIRMAR no cartão que apareceu. " +
          "NÃO diga que já foi feito e NÃO diga que salvou: nada foi criado ainda. " +
          'Se ele responder "sim" por escrito, explique que a confirmação é o botão do cartão.',
      },
    };
  },
};
