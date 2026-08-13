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

import { Platform } from "@prisma/client";

import { CustomerUseCase } from "../../usecases/customer.usecase";
import { ProductUseCase } from "../../usecases/product.usercase";
import { ScrapUseCase } from "../../usecases/scrap.usercase";
import type { AiScope } from "../core/scope";
import { contarMemorias, criarMemoria } from "../memoria/memoria.service";
import {
  ehTopico,
  MAX_MEMORIAS_POR_TENANT,
  MENSAGEM_DE_LOTADA,
  verificarConteudo,
} from "../memoria/memoria.types";
import type { AiAcaoRelatorioDeLote, AiAcaoTipo } from "./acao.types";

/** O que um executor devolve: o id da entidade criada ou alterada. */
export type ResultadoDaExecucao = {
  resultId: string | null;
  /** Só em lote (Fase 10): o que entrou e o que faltou. */
  relatorio?: AiAcaoRelatorioDeLote;
};

type Executor = (
  payload: any,
  scope: AiScope,
) => Promise<ResultadoDaExecucao>;

/**
 * ⚠️ ALTERAR PRODUTO DISPARA SYNC AO VIVO NOS MARKETPLACES.
 *
 * `ProductUseCase.update` chama `syncProductData` para cada anúncio da peça
 * (product.usercase.ts:1039-1063). Confirmar uma troca de preço de uma peça
 * anunciada muda o preço NA HORA em todo canal em que ela estiver, e não existe
 * um clique para desfazer.
 *
 * ⭐ E são CINCO canais, não dois: o `switch` de `syncProductData`
 * (sync.usercase.ts:4965) tem ramo para MERCADO_LIVRE, SHOPEE, MAGALU, OLX e
 * FACEBOOK. Nada aqui precisou mudar quando a OLX e o Facebook entraram — o
 * executor manda para o usecase e o usecase despacha por plataforma. É o motivo
 * de esta camada não conhecer canal nenhum, e de ela dever continuar assim.
 *
 * Duas consequências que o lojista pode estranhar, e que são do CANAL, não
 * daqui: a OLX arredonda o preço para inteiro na publicação, e estoque zero
 * EXCLUI o anúncio da OLX (lá não existe pausar) enquanto no Facebook ele só
 * fica indisponível. As regras de canal do Bitz (advisory/channel-rules.ts)
 * são o lugar onde isso é explicado ao usuário.
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

  /**
   * ⭐ O LOTE (Fase 10) — MELHOR-ESFORÇO COM RELATÓRIO, não tudo-ou-nada.
   *
   * Decisão do dono em 10/08/2026, seguindo o precedente da casa
   * (`LocationUseCase.createBulk`): uma linha ruim não pode invalidar as 28
   * boas. Um desmonte cadastra trinta peças de uma vez; se duas falharem por
   * nome repetido, ele corrige as duas — refazer o pedido inteiro seria pior.
   *
   * ⚠️ SEQUENCIAL, e de propósito. `createWithAutoSku` reserva o SKU com um
   * `UPDATE ... RETURNING` atômico na linha do User; trinta reservas em paralelo
   * disputariam a MESMA linha, e o ganho de tempo viraria contenção de lock.
   *
   * ⚠️ E SEM `$transaction`. A reserva de SKU é atômica por fora da transação de
   * propósito (product.usercase.ts:72-77) — prender o lote inteiro a uma
   * transação longa aumentaria a janela de lock sem dar atomicidade real, já que
   * os números de SKU não voltariam num rollback.
   */
  "produto.criar-lote": async (payload, scope) => {
    const usecase = new ProductUseCase();
    const itens: any[] = Array.isArray(payload?.itens) ? payload.itens : [];

    const falhas: AiAcaoRelatorioDeLote["falhas"] = [];
    let primeiroId: string | null = null;
    let criadas = 0;

    for (const item of itens) {
      try {
        const produto = await usecase.create({
          ...item,
          userId: scope.dataOwnerId,
          createdByUserId: scope.actorId,
          autoSku: true,
        } as any);
        criadas++;
        primeiroId ??= (produto as any)?.id ?? null;
      } catch (err) {
        // O motivo vai para o cartão e para a auditoria. Curto e sem SQL: o
        // lojista precisa saber POR QUE aquela linha não entrou.
        falhas.push({
          nome: String(item?.name ?? "sem nome").slice(0, 80),
          motivo: motivoLegivel(err),
        });
      }
    }

    return {
      // O id da PRIMEIRA peça criada. Não existe "o id do lote", e inventar um
      // seria um número que não abre nada em tela nenhuma.
      resultId: primeiroId,
      relatorio: { criadas, total: itens.length, falhas },
    };
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

  /**
   * ⭐ DAR ENTRADA NUMA SUCATA. Embrulho fino de `ScrapUseCase.create` — o mesmo
   * usecase que a tela de Sucatas chama (scrap.routes.ts:27), com as mesmas
   * validações de marca, modelo, chassi e chave de acesso.
   *
   * ⚠️⚠️ SÓ O `resultId` VOLTA, e aqui NÃO EXISTE REDE DE SEGURANÇA — por isso
   * o cuidado é maior, não menor.
   *
   * `ScrapRepository.create` termina com um `include` (scrap.repository.ts:140-143)
   * e o objeto devolvido carrega `chassis`, `renavam`, `engineNumber` e `notes`
   * — quatro campos de `CAMPOS_PROIBIDOS`. Mas a varredura de
   * `acharCampoProibido` roda no TOOL-RUNNER e só sobre `paraOModelo`
   * (tool-runner.ts:313 substitui o resultado por ele antes da checagem em
   * :340). O executor roda depois, na rota de confirmação, e o que ele devolve
   * NUNCA é escaneado.
   *
   * ⭐ Quem barra é o TIPO: `ResultadoDaExecucao` é `{ resultId; relatorio? }`.
   * Não afrouxe esse tipo, e não devolva o objeto do usecase "por conveniência":
   * seria identificação veicular saindo na resposta HTTP sem nada para pegar.
   *
   * ⭐ Sem efeito colateral a declarar: o insert não gera peça, não mexe em
   * estoque e não lança nada no financeiro. É o motivo de o cartão poder dizer
   * "a sucata nasce vazia" sem ressalva.
   */
  /**
   * ⭐ VINCULAR A PEÇA AO LOTE. Embrulho fino de `ProductUseCase.linkScrap`.
   *
   * ⚠️ NÃO usa `update()`, e isso é escolha do usecase, não descuido:
   * `linkScrap` (product.usercase.ts:694-706) evita o caminho de update DE
   * PROPÓSITO porque `scrapId` não afeta anúncio nem estoque — passar por lá
   * dispararia limpeza de override, stock log e sync de marketplace por uma
   * mudança que não muda nada disso. É o motivo de o cartão poder prometer
   * "não vai para marketplace nenhum".
   *
   * A guarda de tenant da sucata está dentro do repositório
   * (product.repository.ts:1008-1021) e é refeita aqui pelo `dataOwnerId`.
   */
  /**
   * ⭐ PAUSAR / REATIVAR os anúncios. Embrulho fino de
   * `ProductUseCase.pauseListings` — o MESMO método que o botão da tela de
   * Produtos usa (product.routes.ts:1459), com a mesma idempotência e o mesmo
   * agregado de resultado.
   *
   * ⚠️⚠️ `pularPlataformas: [OLX]` vem do PAYLOAD, não é recalculado aqui.
   * Entre a proposta e o clique passa até meia hora; se alguém publicasse a
   * peça na OLX nesse intervalo e a exclusão fosse recalculada agora, o clique
   * executaria uma operação que o lojista não leu. O que ele confirmou é o que
   * roda.
   */
  "anuncio.situacao": async (payload, scope) => {
    const usecase = new ProductUseCase();
    await usecase.pauseListings(
      payload.produtoId,
      scope.dataOwnerId,
      payload.situacao,
      payload.pularOlx ? { pularPlataformas: [Platform.OLX] } : undefined,
    );
    return { resultId: payload.produtoId };
  },

  "produto.vincular-sucata": async (payload, scope) => {
    const usecase = new ProductUseCase();
    await usecase.linkScrap(
      payload.produtoId,
      payload.sucataId,
      scope.dataOwnerId,
    );
    return { resultId: payload.produtoId };
  },

  /**
   * ⭐ GRAVAR O BLOCO FISCAL. Embrulho fino de `ScrapUseCase.update`, o mesmo
   * que a tela de Sucatas usa — inclusive a validação de 44 dígitos da chave,
   * que aqui é a segunda barreira (a tool já conferiu o dígito verificador).
   *
   * ⚠️ A data chega como `AAAA-MM-DD` e vira `Date` AQUI, não na tool: o
   * payload da proposta é JSON e um `Date` não sobrevive à ida ao banco.
   */
  "sucata.fiscal": async (payload, scope) => {
    const usecase = new ScrapUseCase();
    const { issueDate, ...resto } = payload.fiscal ?? {};
    await usecase.update(
      payload.sucataId,
      {
        ...resto,
        ...(issueDate ? { issueDate: new Date(`${issueDate}T00:00:00`) } : {}),
      } as any,
      scope.dataOwnerId,
    );
    return { resultId: payload.sucataId };
  },

  "sucata.criar": async (payload, scope) => {
    const usecase = new ScrapUseCase();
    const sucata = await usecase.create({
      ...payload.sucata,
      // ⭐ O tenant entra AQUI, do escopo. O payload nunca o carrega.
      userId: scope.dataOwnerId,
      // ⚠️ E o AUTOR é o ator, não o tenant — senão a tela de Sucatas diria que
      // o dono da conta cadastrou o lote que o balconista ditou ao Bitz. Foi
      // exatamente o achado #9 da Fase 9, para `Product`.
      createdByUserId: scope.actorId,
    } as any);
    return { resultId: (sucata as any)?.id ?? null };
  },

  /**
   * ⭐ ENSINAR UMA REGRA (Fase 11) — e as três travas são REFEITAS aqui.
   *
   * ⚠️ NÃO É PARANOIA, É A JANELA DE 30 MINUTOS. Entre a proposta e o clique
   * passa até meia hora (`PROPOSTA_VALIDA_POR_MS`), e nesse intervalo o
   * administrador pode ter virado colaborador de outra conta, a loja pode ter
   * chegado ao teto por outro caminho, e um deploy pode ter apertado a guarda de
   * conteúdo. O que grava tem de validar o que grava, com o estado de AGORA.
   *
   * Lançar aqui é o comportamento certo: a linha vira `falhou`, com o motivo na
   * coluna de erro, e o lojista lê que nada foi alterado — que é a verdade.
   */
  "memoria.criar": async (payload, scope) => {
    if (!scope.isAdmin) {
      throw new Error("só o administrador da conta ensina o Bitz");
    }

    const topico = ehTopico(payload?.topico) ? payload.topico : "geral";
    const verificado = verificarConteudo(payload?.conteudo);
    if (!verificado.ok) throw new Error(verificado.mensagem);

    const quantas = await contarMemorias({ dataOwnerId: scope.dataOwnerId });
    if (quantas >= MAX_MEMORIAS_POR_TENANT) {
      throw new Error(MENSAGEM_DE_LOTADA);
    }

    const { id } = await criarMemoria({
      // ⭐ O tenant vem do ESCOPO. O payload nunca o carrega.
      dataOwnerId: scope.dataOwnerId,
      // Quem ensinou tem nome, mesmo a memória sendo da casa.
      createdByUserId: scope.actorId,
      topico,
      conteudo: verificado.conteudo,
      conversationId: payload?.conversationId ?? null,
    });
    return { resultId: id };
  },
};

/**
 * ⭐ O MOTIVO QUE O LOJISTA LÊ — e ele NUNCA é o erro cru.
 *
 * ⚠️ Conserto de um achado: o motivo ia direto para o cartão e para o corpo
 * HTTP. Um erro de validação do Prisma despejava
 * "Invalid `prisma.product.create()` invocation: { data: { name: …" na tela de
 * um lojista, que não tem o que fazer com isso — e o dump carrega o nome das
 * colunas e pedaços do dado.
 *
 * As mensagens dos usecases da casa (`Produto com esse sku já existe`) são
 * escritas para humano e passam. Qualquer coisa que cheire a stack ou a dump de
 * ORM vira uma frase genérica, e o erro completo fica no log do servidor.
 */
function motivoLegivel(err: unknown): string {
  const bruto =
    err instanceof Error ? err.message.replace(/\s+/g, " ").trim() : "";

  const cheiroDeOrm =
    /prisma|invocation|\bP\d{4}\b|at\s+\w+\s*\(|select\s|insert\s|\{\s*data:/i;

  if (!bruto || cheiroDeOrm.test(bruto) || bruto.length > 160) {
    console.error("[bitz-acao] falha de item no lote:", err);
    return "não consegui cadastrar esta peça";
  }
  return bruto.slice(0, 120);
}

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
