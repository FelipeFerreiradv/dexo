// Quem de fato escreve, depois do clique de confirmação. Fase 9.
//
// ⭐ CADA EXECUTOR É UM EMBRULHO FINO DO USECASE QUE A TELA JÁ USA. Nenhuma
// regra de negócio nasce aqui, nenhuma validação própria, nenhum acesso direto
// ao Prisma. Se o Bitz criasse produto por um caminho diferente do da tela de
// Produtos, os dois divergiriam no primeiro campo novo — e o do Bitz seria o
// errado, porque ninguém olha para ele.
//
// ⚠️ O `userId` DOS USECASES É O TENANT, e ele vem do `AiScope` — nunca do
// payload, nunca de algo que o modelo tenha produzido. O payload guardado na
// proposta carrega só os campos de negócio.

import { CustomerUseCase } from "../../usecases/customer.usecase";
import { ProductUseCase } from "../../usecases/product.usercase";
import type { AiScope } from "../core/scope";
import type { AiAcaoTipo } from "./acao.types";

/** O que um executor devolve: o id da entidade criada ou alterada. */
export type ResultadoDaExecucao = { resultId: string | null };

type Executor = (
  payload: any,
  scope: AiScope,
) => Promise<ResultadoDaExecucao>;

/**
 * ⚠️ ALTERAR PRODUTO DISPARA SYNC AO VIVO NOS MARKETPLACES.
 *
 * `ProductUseCase.update` chama `syncProductData` para cada anúncio da peça
 * (product.usercase.ts:1039-1063). Confirmar uma troca de preço de uma peça
 * anunciada muda o preço no Mercado Livre e na Shopee NA HORA, e não existe um
 * clique para desfazer.
 *
 * Isso não é contornado aqui, e é de propósito: usar um caminho que NÃO
 * sincroniza deixaria o Dexo dizendo um preço e o anúncio dizendo outro, que é
 * pior. O que a fase faz é garantir que o lojista SAIBA disso antes de
 * confirmar — o `aviso` do cartão diz quantos anúncios serão afetados.
 */
const atualizarProduto = async (
  campos: Record<string, unknown>,
  payload: any,
  scope: AiScope,
): Promise<ResultadoDaExecucao> => {
  const usecase = new ProductUseCase();
  await usecase.update(payload.produtoId, campos as any, scope.dataOwnerId);
  return { resultId: payload.produtoId };
};

const EXECUTORES: Record<AiAcaoTipo, Executor> = {
  "produto.criar": async (payload, scope) => {
    const usecase = new ProductUseCase();
    const produto = await usecase.create({
      ...payload.produto,
      // ⭐ O tenant entra AQUI, do escopo. O payload nunca o carrega.
      userId: scope.dataOwnerId,
      // ⚠️ Sem isto a coluna "Criado por" da tela de Produtos mostrava "—" para
      // tudo que o Bitz cadastrasse — indistinguível de registro legado ou de
      // importação. Quem cadastrou foi o ATOR, não o tenant, e a informação
      // existia (`AiAction.actorUserId`) numa tabela que aquela tela não lê.
      createdByUserId: scope.actorId,
      // Atribuição atômica do SKU no servidor: sem isto, dois cadastros
      // simultâneos podem colidir (o P2002 já foi engolido uma vez neste
      // repositório — ver project_sku_autosku_concurrency).
      autoSku: true,
    } as any);
    return { resultId: (produto as any)?.id ?? null };
  },

  "produto.preco": async (payload, scope) =>
    atualizarProduto({ price: payload.preco }, payload, scope),

  "produto.estoque": async (payload, scope) =>
    atualizarProduto({ stock: payload.estoque }, payload, scope),

  "cliente.criar": async (payload, scope) => {
    const usecase = new CustomerUseCase();
    const cliente = await usecase.create({
      ...payload.cliente,
      userId: scope.dataOwnerId,
    } as any);
    return { resultId: (cliente as any)?.id ?? null };
  },
};

/**
 * Executa a ação. LANÇA quando o usecase lança — quem chama transforma em
 * `status: "falhou"` e mostra ao lojista que nada foi alterado.
 */
export async function executarAcao(
  tipo: AiAcaoTipo,
  payload: any,
  scope: AiScope,
): Promise<ResultadoDaExecucao> {
  const executor = EXECUTORES[tipo];
  // Tipo desconhecido é falha DURA e não silêncio: uma linha de `AiAction` com
  // um `action` que este deploy não conhece (rollback de versão, por exemplo)
  // não pode ser "confirmada" sem ter feito nada.
  if (!executor) throw new Error(`Ação desconhecida: ${tipo}`);
  return executor(payload, scope);
}

/** As ações que ESTE deploy sabe executar. Usado pelos testes de contrato. */
export const TIPOS_EXECUTAVEIS = Object.keys(EXECUTORES) as AiAcaoTipo[];
