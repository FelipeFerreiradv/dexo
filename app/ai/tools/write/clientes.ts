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

import {
  normName,
  onlyDigits,
} from "../../../usecases/import/lib/normalize";
import { CustomerUseCase } from "../../../usecases/customer.usecase";
import { proporAcao } from "../../acoes/acao.service";
import {
  ACAO_EXIGE_PERMISSAO,
  type AiAcaoPreview,
} from "../../acoes/acao.types";
import type { AiScope } from "../../core/scope";
import type { AiTool, AiToolContext } from "../registry";

/**
 * Já existe alguém parecido? Vira aviso, NUNCA bloqueio.
 *
 * ⭐ DOIS SINAIS, e o segundo é o que pega o caso real. Antes disto a
 * comparação era só de NOME EXATO em minúsculas — "João da Silva" e "Joao
 * Silva" passavam como pessoas diferentes, e o telefone, que a tool JÁ RECEBE,
 * não era consultado.
 *
 * O sistema já sabe fazer melhor em dois lugares, e é de lá que vem o desenho:
 * a cascata de `order-customer.service.ts:142-160` (documento → e-mail → nome)
 * e o importador (`customers.executor.ts:99-118`), que casa por
 * `normName(nome) + telefone`. Reusamos os MESMOS normalizadores para o Bitz
 * não ter uma terceira noção de "cliente parecido".
 *
 * ⚠️ Documento fica de fora por construção: a tool não aceita CPF/CNPJ (ver o
 * cabeçalho), então o sinal mais forte da cascata não está disponível aqui.
 */
async function jaExisteParecido(
  nome: string,
  telefone: string | undefined,
  scope: AiScope,
): Promise<string | undefined> {
  try {
    // ⚠️ ASSINATURA POSICIONAL: `search(q, userId)`. Ela estava sendo chamada
    // com um OBJETO por trás de um `as any` — o `userId` chegava como `undefined`
    // e o retorno nunca casava, então o aviso de duplicado era LINHA MORTA. O
    // `as any` foi o que escondeu; sem ele, o compilador teria pego na hora.
    const usecase = new CustomerUseCase();
    const digitos = telefone ? onlyDigits(telefone) : "";

    // ⚠️ DUAS BUSCAS, e não uma. `search` (o typeahead) NÃO procura por
    // telefone — só `findAll` procura (customer.repository.ts:218-220). Sem a
    // segunda, um cliente com o mesmo telefone e nome escrito diferente
    // continuaria invisível, que é justamente o duplicado que interessa.
    const [porNome, porTelefone] = await Promise.all([
      usecase.search(nome, scope.dataOwnerId),
      digitos.length >= 8
        ? usecase.list({ search: digitos, limit: 5 } as any, scope.dataOwnerId)
        : Promise.resolve(null),
    ]);

    const alvo = normName(nome);
    const candidatos = [
      ...(Array.isArray(porNome) ? porNome : []),
      ...((porTelefone as any)?.customers ?? []),
    ];

    const vistos = new Set<string>();
    let mesmoNome = 0;
    let mesmoTelefone = 0;

    for (const c of candidatos) {
      const id = String(c?.id ?? "");
      if (id && vistos.has(id)) continue;
      if (id) vistos.add(id);

      if (normName(String(c?.name ?? "")) === alvo) {
        mesmoNome++;
        continue;
      }
      // Só conta como "mesmo telefone" quando o nome NÃO bate — senão o mesmo
      // cliente apareceria nas duas contas e o aviso viraria exagero.
      if (
        digitos.length >= 8 &&
        [c?.phone, c?.mobile].some(
          (t) => t && onlyDigits(String(t)) === digitos,
        )
      ) {
        mesmoTelefone++;
      }
    }

    const partes: string[] = [];
    if (mesmoNome > 0) {
      partes.push(
        `${mesmoNome === 1 ? "um cliente" : `${mesmoNome} clientes`} com este mesmo nome`,
      );
    }
    if (mesmoTelefone > 0) {
      partes.push(
        `${mesmoTelefone === 1 ? "outro" : `${mesmoTelefone} outros`} com este mesmo telefone`,
      );
    }
    if (partes.length === 0) return undefined;

    return `⚠️ Já existe ${partes.join(" e ")}. Confira se não é a mesma pessoa antes de confirmar.`;
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

    const duplicado = await jaExisteParecido(args.nome, args.telefone, scope);

    const preview: AiAcaoPreview = {
      titulo: "Cadastrar cliente",
      alvo: args.nome,
      campos,
      // ⚠️ SOMA, e não `??`. Com `??` o aviso de documento SUMIA exatamente
      // quando havia um homônimo — ou seja, no cartão em que o lojista mais
      // precisa dos dois. É o mesmo defeito que o `??` já causou no aviso de
      // estoque zero (write/produtos.ts:636-644), consertado do mesmo jeito.
      aviso: [
        duplicado,
        "CPF, CNPJ e endereço completo não entram por aqui — complete na tela de Clientes quando precisar emitir nota.",
      ]
        .filter(Boolean)
        .join(" "),
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
          'Se ele responder "sim" por escrito, explique que a confirmação é o botão do cartão. ' +
          // ⭐⭐ O CPF DITADO QUE SUMIA EM SILÊNCIO.
          //
          // O schema é `.strict()` e recusa `cpf`/`cnpj` — de propósito, porque
          // documento de pessoa física não pode viajar para o provedor de IA.
          // Mas o efeito colateral era pior que o problema: quem escrevia
          // "cadastra o João, CPF 123.456.789-00" via um cartão com nome e
          // telefone, sem UMA palavra sobre o documento, e confirmava achando
          // que o cliente tinha entrado completo. Descobria na hora de emitir
          // nota, semanas depois.
          "⚠️ SE o usuário tiver ditado CPF ou CNPJ nesta conversa, diga a ele — de forma explícita, na mesma resposta — que o DOCUMENTO NÃO FOI INCLUÍDO nesta proposta e que ele precisa preencher na tela de Clientes. Nunca deixe passar em silêncio.",
      },
    };
  },
};
