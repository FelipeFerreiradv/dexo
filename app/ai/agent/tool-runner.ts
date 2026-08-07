// Execução de UMA tool. É a fronteira entre o que o modelo pediu e o que o
// sistema faz.
//
// INVARIANTE: `runTool` NUNCA lança. Toda falha — tool inexistente, argumento
// inválido, permissão negada, erro de banco — vira um resultado que volta ao
// modelo como texto. O modelo lê e explica ao usuário. Uma exceção subindo
// daqui derrubaria o turno inteiro por causa de uma consulta.
//
// A ordem dos passos é a própria política de segurança, e nenhum deles pode
// trocar de lugar:
//
//   1. a tool existe?          — nome vindo do modelo é não confiável
//   2. o ATOR pode ver isso?   — permissão ANTES de tocar no banco
//   3. os argumentos valem?    — zod .strict(): chave extra é REJEITADA
//   4. executa com o scope     — o tenant vem do servidor, nunca dos args
//   5. campo proibido?         — trava central: custo, credencial, PII crua
//   6. serializa com teto      — egress e contexto têm preço
//
// O passo 2 vir antes do 3 é deliberado: um colaborador sem `financeiro` recebe
// "sem permissão" mesmo mandando argumento malformado. Validar primeiro
// revelaria, pela mensagem de erro, o formato de uma consulta que ele não pode
// fazer.

import type { ZodError } from "zod";

import { auditToolCall, auditToolDenied } from "../audit/ai-audit";
import type { AiScope } from "../core/scope";
import type { AiToolCall } from "../core/types";
import type { AiTool } from "../tools/registry";

/**
 * Teto do resultado de UMA tool no contexto do modelo.
 *
 * 4.000 caracteres ≈ 1.000 tokens. Cada tool já tem teto de linhas próprio;
 * isto é a rede de segurança para o caso de um registro individual gigante
 * (uma descrição de produto de 8 mil caracteres, por exemplo).
 */
export const MAX_TOOL_RESULT_CHARS = 4000;

export type ToolFailure =
  | "tool_desconhecida"
  | "sem_permissao"
  | "argumentos_invalidos"
  | "falha_na_consulta";

export interface ToolRunResult {
  name: string;
  ok: boolean;
  /** Texto que volta ao modelo. Sempre preenchido, inclusive em falha. */
  content: string;
  ms: number;
  failure?: ToolFailure;
}

export interface ToolRunContext {
  registry: Map<string, AiTool>;
  scope: AiScope;
  /** Só para auditoria. */
  conversationId?: string;
}

/**
 * ⭐ Campos que NUNCA podem sair de uma tool, para ninguém — nem para o admin.
 *
 * Por que uma trava CENTRAL, e não só a disciplina de cada handler:
 *
 *  - `costPrice` e `markup` moram na tabela `Product`, e o gate de permissão do
 *    runner é POR PÁGINA. Uma tool de produto declara `page: "produtos"` — o que
 *    é correto — e com isso o dado mais sensível do sistema ficaria atrás da
 *    permissão errada. Não é problema de permissão: é campo proibido, ponto.
 *
 *  - `ProductUseCase.getDetail` lê o produto com `include`, não com `select`
 *    (product.repository.ts:1704-1706). Toda coluna NOVA que alguém acrescentar
 *    ao model Product entra no retorno sozinha, sem ninguém tocar na tool. Uma
 *    blocklist por handler envelhece para insegura em silêncio; esta não.
 *
 *  - O resultado de uma tool NÃO fica no servidor: ele vai para o contexto do
 *    modelo e sai por HTTP para o provedor. Cada campo aqui é uma transferência
 *    a terceiro que não dá para desfazer.
 *
 * A comparação é sobre a chave em INGLÊS, que é como as colunas do Prisma se
 * chamam. As projeções das tools usam chaves em português (`placa`, `documento`,
 * `cadastradoPor`), então o que esta trava pega é o vazamento ACIDENTAL — um
 * objeto cru do Prisma devolvido por engano —, não a exposição deliberada e
 * revisada de um campo que o lojista precisa ver.
 */
export const CAMPOS_PROIBIDOS = [
  // Custo e margem: regra inegociável do produto.
  "costprice",
  "markup",
  // Credenciais.
  "accesstoken",
  "refreshtoken",
  "password",
  "appclientsecret",
  // PII crua vinda de objeto não projetado.
  "cpf",
  "rg",
  "birthdate",
  "inscricaoestadual",
  "deliverycpf",
  "deliverycnpj",
  // Identificação de veículo em objeto cru.
  "chassis",
  "renavam",
  "enginenumber",
  // Texto livre do operador: o campo com maior chance de dado imprevisto.
  "notes",
] as const;

const PROIBIDOS = new Set<string>(CAMPOS_PROIBIDOS);

/**
 * Varre o resultado procurando chave proibida.
 *
 * Devolve o caminho da primeira que achar, ou `null`. Tem teto de profundidade
 * e de nós: a varredura não pode virar o gargalo de uma consulta grande, e um
 * grafo com ciclo não pode travar o turno.
 */
export function acharCampoProibido(
  valor: unknown,
  caminho = "",
  profundidade = 0,
  orcamento = { nos: 20_000 },
): string | null {
  if (profundidade > 8 || orcamento.nos <= 0) return null;
  if (!valor || typeof valor !== "object") return null;

  if (Array.isArray(valor)) {
    for (let i = 0; i < valor.length; i++) {
      orcamento.nos--;
      if (orcamento.nos <= 0) return null;
      const achado = acharCampoProibido(
        valor[i],
        `${caminho}[${i}]`,
        profundidade + 1,
        orcamento,
      );
      if (achado) return achado;
    }
    return null;
  }

  for (const [chave, filho] of Object.entries(valor)) {
    orcamento.nos--;
    if (orcamento.nos <= 0) return null;
    if (PROIBIDOS.has(chave.toLowerCase())) {
      return caminho ? `${caminho}.${chave}` : chave;
    }
    const achado = acharCampoProibido(
      filho,
      caminho ? `${caminho}.${chave}` : chave,
      profundidade + 1,
      orcamento,
    );
    if (achado) return achado;
  }
  return null;
}

/**
 * Serialização à prova de BigInt.
 *
 * `JSON.stringify` LANÇA em BigInt ("Do not know how to serialize a BigInt"), e
 * todo `COUNT(*)` de `$queryRaw` no Prisma volta como BigInt. Sem este
 * replacer, a primeira tool de relatório que contasse linhas derrubaria o
 * turno — e só em produção, porque o mock de teste devolve number.
 *
 * O Decimal do Prisma não precisa de tratamento aqui: ele tem `toJSON` próprio
 * e vira string. Ainda assim os handlers convertem para número com `num()`
 * (ver tools/serialize.ts), porque `"84320.00"` entre aspas leva o modelo a
 * tratar dinheiro como texto.
 */
function safeStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === "bigint" ? Number(v) : v),
    0,
  );
}

/** Aplica o teto e avisa o modelo quando cortou — silêncio viraria resposta incompleta com cara de completa. */
export function truncateToolResult(
  texto: string,
  max = MAX_TOOL_RESULT_CHARS,
): string {
  if (texto.length <= max) return texto;
  return `${texto.slice(0, max)}\n\n[RESULTADO TRUNCADO em ${max} caracteres. Diga ao usuário que a lista é maior do que cabe aqui e ofereça um recorte mais específico — período menor, filtro, ou menos itens.]`;
}

/** Mensagem de erro de argumento, curta e sobre o SHAPE — nunca sobre o dado. */
function describeZodError(err: ZodError): string {
  return err.issues
    .slice(0, 4)
    .map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`)
    .join("; ");
}

export async function runTool(
  call: AiToolCall,
  ctx: ToolRunContext,
): Promise<ToolRunResult> {
  const started = Date.now();
  const { registry, scope, conversationId } = ctx;

  const fail = (
    failure: ToolFailure,
    content: string,
    name = call.name,
  ): ToolRunResult => ({
    name,
    ok: false,
    content,
    ms: Date.now() - started,
    failure,
  });

  // 1. A tool existe? O nome veio do modelo — pode ser alucinado.
  const tool = registry.get(call.name);
  if (!tool) {
    return fail(
      "tool_desconhecida",
      `A consulta "${call.name}" não existe. Diga ao usuário o que você consegue consultar, sem inventar dado.`,
    );
  }

  // 2. Permissão, ANTES de qualquer I/O.
  //
  // Devolve resultado de tool, e NÃO um 403 HTTP: o chat em si é permitido, a
  // consulta é que não. Um 403 encerraria a conversa inteira por causa de uma
  // pergunta que o colaborador simplesmente não podia fazer.
  if (!scope.can(tool.page)) {
    auditToolDenied({
      dataOwnerId: scope.dataOwnerId,
      actorUserId: scope.actorId,
      conversationId,
      tool: tool.name,
      page: tool.page,
    });
    return fail(
      "sem_permissao",
      `SEM PERMISSÃO: este usuário não tem acesso à área "${tool.page}". Diga isso a ele em uma frase e sugira falar com o administrador da conta. NÃO tente outra consulta para contornar, e NÃO estime o número.`,
    );
  }

  // 3. Argumentos. `.strict()` no schema faz chave desconhecida ser REJEITADA
  //    em vez de ignorada — é a terceira trava contra o modelo tentar escolher
  //    o tenant (ver core/scope.ts).
  const parsed = tool.args.safeParse(call.args ?? {});
  if (!parsed.success) {
    return fail(
      "argumentos_invalidos",
      `Argumentos inválidos para ${tool.name}: ${describeZodError(parsed.error)}. Corrija e chame de novo, ou pergunte ao usuário o que falta.`,
      tool.name,
    );
  }

  // 4. Execução. O `scope` é o único caminho do tenant para dentro do handler.
  let resultado: unknown;
  try {
    resultado = await tool.handler(parsed.data, scope);
  } catch (err) {
    // O erro cru pode conter fragmento de SQL e valor de coluna. Fica no log do
    // servidor; ao modelo vai só o fato.
    console.error(`[bitz-tool] ${tool.name} falhou:`, err);
    auditToolCall({
      dataOwnerId: scope.dataOwnerId,
      actorUserId: scope.actorId,
      conversationId,
      tool: tool.name,
      ok: false,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message.slice(0, 120) : "erro",
    });
    return fail(
      "falha_na_consulta",
      `A consulta ${tool.name} falhou. Diga ao usuário que não conseguiu buscar agora e que ele pode tentar de novo. NÃO invente o número.`,
      tool.name,
    );
  }

  // 5. ⭐ Trava de campo proibido, ANTES de serializar.
  //
  // Falha FECHADA de propósito: o turno perde a consulta, e não o cliente perde
  // o custo dele. Vazamento silencioso não é uma opção aceitável aqui.
  const proibido = acharCampoProibido(resultado);
  if (proibido) {
    console.error(
      `[bitz-tool] ${tool.name} tentou devolver campo proibido: ${proibido}`,
    );
    auditToolCall({
      dataOwnerId: scope.dataOwnerId,
      actorUserId: scope.actorId,
      conversationId,
      tool: tool.name,
      ok: false,
      ms: Date.now() - started,
      error: `campo_proibido:${proibido}`,
    });
    return fail(
      "falha_na_consulta",
      `A consulta ${tool.name} foi bloqueada por conter dado que não pode sair do sistema. Diga ao usuário que essa informação está disponível na tela correspondente, não por aqui.`,
      tool.name,
    );
  }

  // 6. Serialização com teto.
  let texto: string;
  try {
    texto = safeStringify(resultado ?? null);
  } catch (err) {
    console.error(`[bitz-tool] ${tool.name}: resultado não serializável`, err);
    return fail(
      "falha_na_consulta",
      `A consulta ${tool.name} devolveu algo que não consegui ler. Diga ao usuário que não conseguiu buscar agora.`,
      tool.name,
    );
  }

  const ms = Date.now() - started;
  auditToolCall({
    dataOwnerId: scope.dataOwnerId,
    actorUserId: scope.actorId,
    conversationId,
    tool: tool.name,
    ok: true,
    ms,
  });

  return {
    name: tool.name,
    ok: true,
    content: truncateToolResult(texto),
    ms,
  };
}
