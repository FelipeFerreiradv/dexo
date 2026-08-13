// Tool de ESCRITA de sucata.
//
// ⭐ NÃO CADASTRA. Valida, resolve a marca, monta o resumo e grava uma PROPOSTA;
// quem cadastra é o clique do lojista. Mesmo contrato de `cadastrar_cliente`.
//
// ⭐ A SUCATA NASCE VAZIA, e o cartão diz isso. `ScrapRepository.create`
// (scrap.repository.ts:99-152) é um insert puro: não gera peça, não mexe em
// estoque, não lança nada no financeiro e nem sequer grava o primeiro
// `ScrapStatusEvent`. Quem desmembra é o lojista, peça a peça, na tela de
// Sucatas. Deixar isso implícito faria o dono confirmar achando que as peças
// apareceriam sozinhas.
//
// ⚠️ CHASSI, RENAVAM E NÚMERO DO MOTOR NÃO ENTRAM POR AQUI, e é decisão de
// segurança, não esquecimento — os três estão na lista de `CAMPOS_PROIBIDOS` do
// tool-runner, como o CPF do cadastro de cliente. O resultado de uma tool sai
// por HTTP para o provedor de IA, e identificador de veículo é exatamente o que
// não pode fazer essa viagem. Quem precisa deles preenche na tela de Sucatas,
// que não passa por modelo nenhum.
//
// O cadastro sem eles é válido no sistema (`ScrapUseCase.create` só exige
// `userId`, `brand` e `model`), então isto não cria uma sucata pela metade.

import { z } from "zod";

import {
  getModelsForBrand,
  getVehicleBrands,
  normalizeVehicleTerm,
} from "../../../lib/vehicle-catalog";
import { cleanPlate } from "../../../usecases/import/lib/normalize";
import { ProductUseCase } from "../../../usecases/product.usercase";
import { ScrapUseCase } from "../../../usecases/scrap.usercase";
import { proporAcao } from "../../acoes/acao.service";
import {
  ACAO_EXIGE_PERMISSAO,
  type AiAcaoPreview,
} from "../../acoes/acao.types";
import type { AiScope } from "../../core/scope";
import type { AiTool, AiToolContext, AiWriteToolResult } from "../registry";

/** Teto de valor. Não é regra de negócio: é rede contra dedo escorregado. */
const MAX_VALOR = 9_999_999;

const brl = (n: number) =>
  n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// ---------------------------------------------------------------------------
// Marca a partir do modelo
//
// ⭐ O PROBLEMA QUE ISTO RESOLVE: `Scrap.brand` é NOT NULL e o usecase lança
// "Marca é obrigatória" — mas ninguém fala a marca. Ele diz "chegou um Gol
// 2015", não "chegou um Volkswagen Gol 2015". Deixar o MODELO adivinhar seria o
// agente inventando dado de negócio, que é o que a persona proíbe.
//
// ⭐ A saída é REUSO: `app/lib/vehicle-catalog.ts` é a mesma fonte que os quatro
// selects em cascata do formulário de sucata já usam
// (create-scrap-dialog.tsx:185-190). Um índice invertido modelo → marcas
// resolve "Gol" → "Volkswagen" OFFLINE, sem I/O e sem custo de token.
//
// ⚠️ E ele pode devolver MAIS DE UMA marca. Hoje não devolve — medi o catálogo
// real e os 418 modelos são de marca única —, mas no dia em que alguém
// acrescentar um nome repetido, quem escolhe é o lojista, não o sorteio da
// ordem do array.
//
// ⚠️⚠️ HONESTIDADE SOBRE A COBERTURA, porque uma mutação me pegou exagerando:
// o que está testado é a DECISÃO (`marcasDoModelo`, com índice injetado). O
// ramo `candidatas.length > 1` DENTRO deste handler é inalcançável com o
// catálogo de hoje, e apagá-lo não quebra teste nenhum. O que protege ele é o
// teste de INVARIANTE em `ai-sucata-catalogo.spec.ts` ("nenhum nome de modelo
// existe em duas marcas"): quando o catálogo ganhar um modelo repetido, aquele
// teste falha e manda conferir esta pergunta antes de seguir. Não invente
// cobertura aqui — o guard certo é a invariante, não um teste de fachada.
// ---------------------------------------------------------------------------

let _indice: Map<string, string[]> | null = null;

/** Índice modelo → marcas, construído uma vez por processo. */
function indiceDoCatalogo(): ReadonlyMap<string, string[]> {
  if (_indice) return _indice;
  const mapa = new Map<string, string[]>();
  for (const marca of getVehicleBrands()) {
    for (const modelo of getModelsForBrand(marca)) {
      const chave = normalizeVehicleTerm(modelo);
      const atual = mapa.get(chave);
      if (atual) {
        if (!atual.includes(marca)) atual.push(marca);
      } else {
        mapa.set(chave, [marca]);
      }
    }
  }
  _indice = mapa;
  return mapa;
}

/**
 * As marcas do catálogo que têm um modelo com este nome.
 *
 * Função PURA e com o índice injetável, para o ramo ambíguo — inalcançável com
 * o catálogo de hoje — poder ser exercido por teste de verdade em vez de ficar
 * como linha morta que ninguém nunca rodou.
 */
export function marcasDoModelo(
  modelo: string,
  indice: ReadonlyMap<string, string[]> = indiceDoCatalogo(),
): string[] {
  return indice.get(normalizeVehicleTerm(modelo ?? "")) ?? [];
}

/** Resposta de negócio: nada foi proposto, e o modelo tem de perguntar. */
function semProposta(instrucao: string): AiWriteToolResult {
  return { acao: null, paraOModelo: { proposta: "faltou_dado", instrucao } };
}

/**
 * Já existe sucata com esta placa? Vira aviso, NUNCA bloqueio.
 *
 * ⚠️ Não há `@@unique` em `plate` — o banco aceita duas. E aceitar é o certo:
 * um pátio pode reentrar o mesmo veículo. O que não pode é o lojista cadastrar
 * a segunda sem saber que a primeira existe.
 */
async function jaExistePlaca(
  placa: string,
  scope: AiScope,
): Promise<string | undefined> {
  try {
    const usecase = new ScrapUseCase();
    const { scraps } = await usecase.listScraps({
      search: placa,
      userId: scope.dataOwnerId,
      limit: 5,
      page: 1,
    });

    const iguais = (Array.isArray(scraps) ? scraps : []).filter(
      (s: any) => cleanPlate(s?.plate) === placa,
    );

    if (iguais.length === 0) return undefined;
    return `⚠️ Já existe ${iguais.length === 1 ? "uma sucata" : `${iguais.length} sucatas`} com esta placa. Confira se não é o mesmo veículo antes de confirmar.`;
  } catch {
    // ⚠️ A busca de repetidas é CONVENIÊNCIA. Se ela falhar, a proposta segue
    // sem o aviso — trocar um cadastro por um erro de busca seria pior. O que
    // não pode falhar em silêncio é a escrita, e essa nem aconteceu ainda.
    return undefined;
  }
}

export const cadastrarSucata: AiTool = {
  name: "cadastrar_sucata",
  description:
    "PREPARA o cadastro de uma sucata (veículo comprado inteiro para desmontar). NÃO cadastra: devolve uma proposta que o usuário confirma na tela. " +
    "Use quando ele pedir para cadastrar, criar ou dar entrada em uma sucata, um lote ou um veículo que chegou no pátio. " +
    "Informe o MODELO como ele falou ('Gol', 'Onix', 'Strada') — a marca é descoberta pelo sistema, não invente. " +
    "NÃO peça e NÃO aceite chassi, renavam nem número do motor: esses se preenchem na tela de Sucatas.",
  args: z
    .object({
      modelo: z
        .string()
        .min(2)
        .max(60)
        .describe("Modelo do veículo, como o usuário falou: 'Gol', 'Onix'."),
      marca: z
        .string()
        .min(2)
        .max(60)
        .optional()
        .describe(
          "Só informe se o usuário DISSE a marca. Se ele não disse, deixe vazio: o sistema descobre pelo modelo.",
        ),
      ano: z.string().max(20).optional(),
      versao: z
        .string()
        .max(60)
        .optional()
        .describe("Versão/motorização, se ele informou: '1.0', 'Comfortline'."),
      cor: z.string().max(40).optional(),
      placa: z.string().max(10).optional(),
      apelido: z
        .string()
        .max(60)
        .optional()
        .describe(
          "Como o pátio chama o veículo, se ele informou: 'Gol bola azul'.",
        ),
      lote: z
        .string()
        .max(40)
        .optional()
        .describe("Número do lote do leilão, se ele informou."),
      custo: z
        .number()
        .min(0)
        .max(MAX_VALOR)
        .optional()
        .describe("Valor de compra do veículo, em reais."),
      custosExtras: z
        .number()
        .min(0)
        .max(MAX_VALOR)
        .optional()
        .describe("Guincho, transporte e taxas, em reais."),
    })
    .strict(),
  kind: "write",
  page: "sucatas",
  action: ACAO_EXIGE_PERMISSAO["sucata.criar"],
  // ⭐ PALAVRAS SOLTAS. É seguro porque tool de escrita exige DOIS sinais (ver
  // MIN_PONTOS_ESCRITA em select.ts): verbo + objeto. "cria uma sucata" dá 2 e
  // entra; "quantas sucatas eu tenho" dá 1 e fica de fora, que é o certo — essa
  // é pergunta para `buscar_sucata`.
  //
  // ⚠️ SEM CHAVES QUE SE SOBREPÕEM POR SUBSTRING. `cadastr` já casa
  // "cadastrar"/"cadastro"; ter as duas daria dois pontos por UMA palavra e
  // furaria o piso de escrita.
  keywords: [
    "cadastr",
    "cria",
    "inclui",
    "adicion",
    "entrada",
    "chegou",
    "sucata",
    "veiculo",
    "carro",
    "lote",
  ],
  sourceLabel: "Cadastro de sucata",
  async handler(
    args,
    scope,
    ctx?: AiToolContext,
  ): Promise<AiWriteToolResult> {
    // 1. A marca. Ditada > catálogo > pergunta.
    let marca = args.marca?.trim();
    if (!marca) {
      const candidatas = marcasDoModelo(args.modelo);

      if (candidatas.length === 0) {
        return semProposta(
          `Não encontrei "${args.modelo}" no catálogo de veículos, então não sei a marca — e marca é obrigatória para cadastrar uma sucata. ` +
            "Pergunte ao usuário QUAL É A MARCA desse veículo. Não escolha uma por conta própria.",
        );
      }
      if (candidatas.length > 1) {
        return semProposta(
          `O modelo "${args.modelo}" existe em mais de uma marca: ${candidatas.join(", ")}. ` +
            "Pergunte ao usuário QUAL DELAS é a certa. Não escolha por conta própria.",
        );
      }
      marca = candidatas[0];
    }

    // 2. A placa. Normalizada como o importador normaliza — e o que não passa
    // é DITO, nunca descartado em silêncio.
    const placa = args.placa ? cleanPlate(args.placa) : null;
    const placaRecusada = Boolean(args.placa) && !placa;

    const campos = [
      { campo: "Marca", para: marca },
      { campo: "Modelo", para: args.modelo },
      ...(args.ano ? [{ campo: "Ano", para: args.ano }] : []),
      ...(args.versao ? [{ campo: "Versão", para: args.versao }] : []),
      ...(args.cor ? [{ campo: "Cor", para: args.cor }] : []),
      ...(placa ? [{ campo: "Placa", para: placa }] : []),
      ...(args.apelido ? [{ campo: "Apelido", para: args.apelido }] : []),
      ...(args.lote ? [{ campo: "Lote", para: args.lote }] : []),
      ...(args.custo !== undefined
        ? [{ campo: "Valor de compra", para: brl(args.custo) }]
        : []),
      ...(args.custosExtras !== undefined
        ? [{ campo: "Custos extras", para: brl(args.custosExtras) }]
        : []),
    ];

    const repetida = placa ? await jaExistePlaca(placa, scope) : undefined;

    const aviso = [
      repetida,
      placaRecusada
        ? `⚠️ A placa "${args.placa}" não tem formato de placa (precisa de 6 a 8 letras e números) e NÃO vai ser gravada. Corrija na tela de Sucatas depois, se precisar.`
        : undefined,
      "A sucata nasce VAZIA: nenhuma peça é criada, nada entra no estoque nem no financeiro. Cadastrar as peças e desmembrar continuam sendo passos seus, na tela de Sucatas.",
      "Chassi, renavam, número do motor e os dados da nota não entram por aqui — complete na tela de Sucatas quando precisar.",
    ]
      .filter(Boolean)
      .join(" ");

    const preview: AiAcaoPreview = {
      titulo: "Cadastrar sucata",
      alvo: [marca, args.modelo, args.ano].filter(Boolean).join(" "),
      campos,
      aviso,
    };

    const acao = await proporAcao({
      scope,
      tipo: "sucata.criar",
      payload: {
        sucata: {
          brand: marca,
          model: args.modelo,
          year: args.ano ?? null,
          version: args.versao ?? null,
          color: args.cor ?? null,
          plate: placa,
          nickname: args.apelido ?? null,
          lot: args.lote ?? null,
          cost: args.custo ?? null,
          extraCosts: args.custosExtras ?? null,
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
        // A marca resolvida vai para o modelo de propósito: ele precisa poder
        // dizer "preparei a entrada do Volkswagen Gol" para o lojista conferir
        // que o catálogo acertou. Não é dado sensível — é o que ele acabou de
        // ditar, com a marca completada.
        marcaResolvida: marca,
        instrucao:
          "Preparei o cadastro da sucata. Diga ao usuário, em UMA frase, o que você preparou — INCLUINDO A MARCA que o sistema descobriu — e peça para ele CONFERIR E CONFIRMAR no cartão que apareceu. " +
          "NÃO diga que já foi feito e NÃO diga que salvou: nada foi criado ainda. " +
          'Se ele responder "sim" por escrito, explique que a confirmação é o botão do cartão.',
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Vincular a peça ao lote de onde ela saiu
// ---------------------------------------------------------------------------

/** Acha a peça pelo SKU, DENTRO do tenant. `null` quando não existe. */
async function acharPecaPorSku(sku: string, scope: AiScope) {
  const usecase = new ProductUseCase();
  const r: any = await usecase.listProducts({
    userId: scope.dataOwnerId,
    search: sku,
    limit: 10,
  } as any);
  const itens: any[] = Array.isArray(r) ? r : (r?.products ?? []);
  const alvo = sku.trim().toLowerCase();
  return itens.find((p) => String(p?.sku ?? "").toLowerCase() === alvo) ?? null;
}

/** Como o cartão nomeia um lote. */
function rotuloDaSucata(s: any): string {
  const base = [s?.brand, s?.model, s?.year].filter(Boolean).join(" ");
  const extra = s?.plate ? `placa ${s.plate}` : s?.nickname || null;
  return extra ? `${base} · ${extra}` : base || "sucata sem identificação";
}

export const vincularPecaASucata: AiTool = {
  name: "vincular_peca_a_sucata",
  description:
    "PREPARA o vínculo entre uma peça e a sucata de onde ela saiu. NÃO altera nada agora: devolve uma proposta que o usuário confirma na tela. " +
    "Use quando ele disser que uma peça veio de um lote/carro específico. " +
    "Precisa do SKU da peça e de como identificar a sucata (placa, apelido ou marca+modelo+ano). " +
    "NÃO mexe em preço, estoque nem anúncio.",
  args: z
    .object({
      sku: z
        .string()
        .min(1)
        .max(40)
        .describe("SKU da peça, como o usuário falou. Não invente."),
      sucata: z
        .string()
        .min(2)
        .max(80)
        .describe(
          "Como identificar o lote: placa, apelido do pátio ou marca+modelo+ano.",
        ),
    })
    .strict(),
  kind: "write",
  // ⚠️ A ESCRITA É NO **PRODUTO** (`Product.scrapId`), então a página que
  // governa é Produtos. Mas a ação envolve as duas telas, e por isso o handler
  // exige TAMBÉM `sucatas` — ver o comentário lá dentro.
  page: "produtos",
  action: ACAO_EXIGE_PERMISSAO["produto.vincular-sucata"],
  keywords: [
    "vincul",
    "veio",
    "saiu",
    "origem",
    "pertence",
    "sucata",
    "lote",
    "peca",
  ],
  sourceLabel: "Vínculo de peça com sucata",
  async handler(
    args,
    scope,
    ctx?: AiToolContext,
  ): Promise<AiWriteToolResult> {
    // ⭐⭐ AS DUAS PÁGINAS, SOMADAS. O tool-runner já conferiu `produtos`
    // (o `page` acima) — mas esta ação lê e nomeia um lote, e quem não entra em
    // Sucatas não deveria descobrir quais lotes existem escrevendo no chat.
    // `page` é um só por tool, então a segunda checagem mora aqui.
    if (!scope.can("sucatas")) {
      return semProposta(
        "O usuário não tem acesso à área de Sucatas, então não dá para vincular a peça a um lote. " +
          "Diga isso a ele e sugira falar com o administrador da conta. NÃO tente outro caminho.",
      );
    }

    const peca = await acharPecaPorSku(args.sku, scope);
    if (!peca) {
      return semProposta(
        `Não existe peça com o SKU ${args.sku} no catálogo desta loja. ` +
          "Diga isso ao usuário, com o SKU que ele passou, e pergunte se ele quer procurar pelo nome. NÃO invente uma peça.",
      );
    }

    // Resolve o lote pela mesma busca que `buscar_sucata` já usa.
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
          "Diga isso ao usuário e pergunte a placa ou o apelido do lote. NÃO escolha uma sucata por conta própria.",
      );
    }

    // ⭐ AMBIGUIDADE PERGUNTA, NUNCA CHUTA. Um pátio tem três Gol; escolher o
    // primeiro da lista vincularia a peça ao carro errado — e o erro só
    // apareceria no rateio de investimento daquele lote, semanas depois.
    if (candidatas.length > 1) {
      const lista = candidatas.map(rotuloDaSucata).join(" | ");
      return semProposta(
        `Achei ${candidatas.length} sucatas que casam com "${args.sucata}": ${lista}. ` +
          "Pergunte ao usuário QUAL DELAS é a certa, listando as opções. NÃO escolha por conta própria.",
      );
    }

    const sucata = candidatas[0];

    const preview: AiAcaoPreview = {
      titulo: "Vincular peça à sucata",
      alvo: `${peca.name ?? "peça"} (SKU ${peca.sku})`,
      campos: [
        {
          campo: "Sucata de origem",
          // `de` ausente quando a peça ainda não tinha lote; presente quando
          // está TROCANDO de lote — que é a mudança que mais merece conferência.
          ...(peca.scrapId ? { de: "outro lote já vinculado" } : {}),
          para: rotuloDaSucata(sucata),
        },
      ],
      // ⭐ O que este cartão pode dizer e os de preço/estoque não podem:
      // `linkScrap` evita `update()` de propósito (product.usercase.ts:694-697),
      // então NÃO há sync de marketplace, nem stock log, nem limpeza de override.
      aviso:
        "Isto muda só a ORIGEM da peça no Dexo: não mexe em preço, estoque nem anúncio, e não vai para marketplace nenhum. Serve para o lote saber quanto já retornou do que você investiu nele.",
    };

    const acao = await proporAcao({
      scope,
      tipo: "produto.vincular-sucata",
      payload: { produtoId: peca.id, sucataId: sucata.id },
      preview,
      conversationId: ctx?.conversationId,
    });

    return {
      acao,
      paraOModelo: {
        proposta: "criada",
        acaoId: acao.id,
        sku: peca.sku,
        instrucao:
          "Preparei o vínculo. Diga ao usuário, em UMA frase, qual peça vai para qual lote, e peça para ele CONFERIR E CONFIRMAR no cartão. " +
          "NÃO diga que já foi feito. " +
          'Se ele responder "sim" por escrito, explique que a confirmação é o botão do cartão.',
      },
    };
  },
};
