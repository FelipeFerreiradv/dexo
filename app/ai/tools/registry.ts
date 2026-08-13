// O catálogo de tools e a conversão do schema para o dialeto do modelo.
//
// Uma tool é um EMBRULHO FINO de código que já existe. Nenhuma regra de
// negócio nasce aqui: se o número que a tool devolve não é o mesmo que a tela
// equivalente mostra, a tool está errada — não a tela.
//
// `page` não é decoração: o tool-runner recusa a execução quando o colaborador
// não tem acesso àquela página. Esconder o menu nunca foi permissão.
//
// ⚠️ ANTES DE ESCOLHER O QUE UM `handler` DEVOLVE, LEIA ISTO:
// o retorno de uma tool NÃO fica no servidor. Ele entra no contexto do modelo e
// sai por HTTP para o provedor de IA. Cada campo é uma transferência a
// terceiro, sobre dado de um cliente do Dexo, que não dá para desfazer.
//
// Regra prática: monte o retorno por ALLOWLIST literal, campo a campo, com
// chaves em português. Nunca devolva o objeto que veio do usecase, nem um
// spread dele — vários caminhos do sistema usam `include` do Prisma, e ali toda
// coluna nova entra no retorno sozinha, sem ninguém tocar na tool.
// A trava de `CAMPOS_PROIBIDOS` no tool-runner é a rede embaixo, não o plano.

import type { ZodTypeAny } from "zod";

import type { ActionId } from "../../lib/action-access";
import type { PageId } from "../../lib/page-access";
import type { AiScope } from "../core/scope";
import type { AiToolDefinition } from "../core/types";

export type AiToolKind = "read" | "advisory" | "write";

/**
 * O que uma tool de ESCRITA devolve. Fase 9.
 *
 * ⭐ DOIS DESTINOS DIFERENTES, e essa separação é o ponto. `acao` é a proposta
 * gravada e vai para a UI desenhar o cartão de confirmação — **nunca** entra no
 * contexto do modelo. `paraOModelo` é a frase curta que ele lê para saber o que
 * dizer ao lojista.
 *
 * Sem a separação, o `payload` inteiro da proposta viajaria para o provedor de
 * IA a cada turno seguinte da conversa, junto com o histórico. Ele não precisa
 * disso para dizer "preparei aqui, confirma no cartão".
 */
/**
 * ⭐ UMA ESCOLHA CLICÁVEL, quando o Bitz precisa desambiguar.
 *
 * O caso real: o pátio tem três Gol e o lojista disse só "Gol". Antes desta
 * fase o agente listava os três em PROSA e o lojista redigitava a placa — o
 * ponto exato em que o chat perde para a tela.
 *
 * ⚠️⚠️ `enviar` VIRA UMA MENSAGEM DO USUÁRIO ao ser clicado, e por isso ele só
 * pode nascer de código do SERVIDOR, a partir de dado do banco. NUNCA monte
 * opções com texto que o modelo produziu: seria dar a ele um canal para
 * escrever o próprio próximo prompt, com a legitimidade de um clique humano.
 * As tools montam estas opções a partir do que leram do tenant, e é só.
 */
export interface AiOpcao {
  /** O que o lojista LÊ no botão. */
  rotulo: string;
  /** O que é enviado como mensagem quando ele clica. */
  enviar: string;
}

export interface AiWriteToolResult {
  /**
   * A proposta gravada — ou `null` quando não houve o que propor.
   *
   * ⚠️ `null` É UM RESULTADO LEGÍTIMO, e permiti-lo foi conserto de um achado:
   * "não achei peça com esse SKU" é uma resposta de NEGÓCIO, não uma falha de
   * sistema. Quando a tool lançava nesse caso, o tool-runner traduzia para "a
   * consulta falhou, tente de novo" — e o lojista, que só tinha digitado o SKU
   * errado, tentava a mesma coisa para sempre sem nunca ser informado do
   * problema real.
   */
  acao: import("../acoes/acao.types").AiAcaoProposta | null;
  paraOModelo: Record<string, unknown>;
  /**
   * ⭐ Escolhas clicáveis para a tela, quando a tool encontrou mais de um alvo
   * possível. Como `acao`, sai por FORA do `content` e nunca vai ao provedor —
   * o modelo já recebe as opções em texto na sua instrução, e mandá-las duas
   * vezes seria pagar o mesmo token duas vezes.
   */
  opcoes?: AiOpcao[];
}

/** Contexto de execução que não é escopo nem argumento. */
export interface AiToolContext {
  /** Para amarrar a proposta à conversa em que ela nasceu. */
  conversationId?: string;
}

export interface AiTool<TArgs = any, TResult = any> {
  /** Nome que o modelo chama. snake_case, em português — ele responde em pt-BR. */
  name: string;
  /** A descrição que o MODELO lê para decidir quando usar. Escreva para ele. */
  description: string;
  /** Schema dos argumentos. SEMPRE `.strict()` — ver tool-runner. */
  args: ZodTypeAny;
  kind: AiToolKind;
  /** Página do sistema que governa o acesso a estes dados. */
  page: PageId;
  /**
   * Termos que puxam esta tool para o subconjunto do turno (tools/select.ts).
   *
   * Já normalizados (sem acento, minúsculos). Oferecer as 20 tools em todo turno
   * custaria ~1.200 tokens de entrada por mensagem; oferecer as 6 certas custa
   * um terço disso e ainda melhora a escolha do modelo.
   */
  keywords: string[];
  /**
   * Frase que aparece ao usuário no bloco "Fontes" quando esta tool responde.
   * Escreva para o LOJISTA, não para o modelo.
   */
  sourceLabel: string;
  /**
   * ⭐ SÓ EM `kind: "write"`: a permissão por AÇÃO que o ator precisa ter.
   *
   * SOMA-SE ao acesso à página, nunca o substitui — o tool-runner exige as duas.
   * Motivo: pedir por escrito a um agente não é a mesma coisa que preencher um
   * formulário, e é legítimo o administrador querer que o balconista continue
   * cadastrando peça na tela e não pelo chat.
   *
   * ⚠️ Tool de escrita SEM `action` é erro de autoria e a suíte falha: seria uma
   * escrita atrás de uma permissão só, sem ninguém ter decidido isso.
   */
  action?: ActionId;
  handler(
    args: TArgs,
    scope: AiScope,
    ctx?: AiToolContext,
  ): Promise<TResult>;
}

// ---------------------------------------------------------------------------
// zod -> JSON Schema
//
// Conversor PRÓPRIO, e de propósito. `zod-to-json-schema` resolveria o caso
// geral, mas o caso geral não é o nosso: eu escrevo os 13 schemas e eles usam
// um subconjunto minúsculo (objeto, string, número, booleano, enum, array,
// opcional, describe). Uma dependência nova na API para isso seria peso
// permanente por conveniência de uma tarde.
//
// O que não for suportado vira `{}` (aceita qualquer coisa) em vez de lançar:
// o zod continua sendo a validação de verdade no tool-runner, então um schema
// mais frouxo para o modelo nunca vira uma execução mais frouxa. Ainda assim,
// `ai-tools-registry.spec.ts` falha se alguma tool produzir `{}` — o silêncio
// aqui é rede de segurança, não permissão para escrever schema exótico.
// ---------------------------------------------------------------------------

interface JsonSchemaNode {
  type?: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  minimum?: number;
  maximum?: number;
}

/** Desembrulha `.optional()`, `.nullable()` e `.default()` até o tipo real. */
function unwrap(schema: any): { inner: any; optional: boolean } {
  let node = schema;
  let optional = false;
  // O laço tem teto: schema aninhado além disso é erro de autoria, não entrada.
  for (let i = 0; i < 10; i++) {
    const name = node?._def?.typeName;
    if (
      name === "ZodOptional" ||
      name === "ZodNullable" ||
      name === "ZodDefault"
    ) {
      optional = true;
      node = node._def.innerType;
      continue;
    }
    break;
  }
  return { inner: node, optional };
}

function describeOf(schema: any): string | undefined {
  return schema?._def?.description || schema?.description || undefined;
}

function nodeToJsonSchema(schema: any): JsonSchemaNode {
  const { inner } = unwrap(schema);
  const name = inner?._def?.typeName;
  const description = describeOf(schema) ?? describeOf(inner);
  const withDesc = (n: JsonSchemaNode): JsonSchemaNode =>
    description ? { ...n, description } : n;

  switch (name) {
    case "ZodString":
      return withDesc({ type: "string" });
    case "ZodNumber": {
      const node: JsonSchemaNode = { type: "number" };
      // Os tetos de `limite` viram parte do contrato que o modelo LÊ. Ele
      // continua sendo validado no runner, mas pedir 500 quando o teto é 20 só
      // gasta um turno — melhor ele já saber.
      for (const check of inner._def.checks ?? []) {
        if (check.kind === "min") node.minimum = check.value;
        if (check.kind === "max") node.maximum = check.value;
        if (check.kind === "int") node.type = "integer";
      }
      return withDesc(node);
    }
    case "ZodBoolean":
      return withDesc({ type: "boolean" });
    case "ZodEnum":
      return withDesc({ type: "string", enum: [...inner._def.values] });
    case "ZodNativeEnum":
      return withDesc({
        type: "string",
        enum: Object.values(inner._def.values as Record<string, string>).filter(
          (v) => typeof v === "string",
        ),
      });
    case "ZodArray":
      return withDesc({
        type: "array",
        items: nodeToJsonSchema(inner._def.type),
      });
    case "ZodObject":
      return withDesc(objectToJsonSchema(inner));
    default:
      // Não suportado. O zod ainda valida de verdade no runner.
      return description ? { description } : {};
  }
}

function objectToJsonSchema(schema: any): JsonSchemaNode {
  const shape = schema?._def?.shape?.() ?? {};
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = nodeToJsonSchema(value);
    const { optional } = unwrap(value);
    if (!optional) required.push(key);
  }

  const node: JsonSchemaNode = { type: "object", properties };
  if (required.length > 0) node.required = required;
  return node;
}

/** Converte o schema de argumentos de uma tool para o formato que o modelo lê. */
export function toolParameters(tool: AiTool): Record<string, unknown> {
  const { inner } = unwrap(tool.args);
  if (inner?._def?.typeName !== "ZodObject") {
    // Tool sem objeto na raiz não existe hoje e não deveria existir: o modelo
    // sempre manda um objeto de argumentos.
    return { type: "object", properties: {} };
  }
  return objectToJsonSchema(inner) as unknown as Record<string, unknown>;
}

/** A definição que vai ao provedor. */
export function toToolDefinition(tool: AiTool): AiToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: toolParameters(tool),
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Constrói o registry a partir da lista de tools, garantindo nome único.
 *
 * Nome duplicado é erro de programação e falha ALTO, no import do módulo: duas
 * tools com o mesmo nome fariam o modelo chamar uma e receber a outra, e isso
 * é o tipo de defeito que só aparece em produção com o cliente na frente.
 */
export function buildRegistry(tools: AiTool[]): Map<string, AiTool> {
  const registry = new Map<string, AiTool>();
  for (const tool of tools) {
    if (registry.has(tool.name)) {
      throw new Error(`[bitz] tool duplicada no registry: ${tool.name}`);
    }
    registry.set(tool.name, tool);
  }
  return registry;
}
