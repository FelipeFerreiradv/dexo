// Consumo do Bitz por cliente — o relatório da equipe Dexo. Fase 12 (P3.2).
//
// ⭐⭐ A DECISÃO MAIS IMPORTANTE DESTE ARQUIVO: ELE NÃO DIZ QUANTO CUSTOU EM
// REAIS, E ISSO É DE PROPÓSITO.
//
// Não existe tabela de preço por token em lugar nenhum do repositório, e
// chumbar uma aqui produziria um número de dinheiro que:
//   1. fica errado no dia em que o provedor mexer no preço — em silêncio, sem
//      teste que quebre, sem ninguém perceber;
//   2. é lido num painel que serve para decidir PREÇO DE PLANO.
// Um número de dinheiro confiantemente errado nesse lugar é pior que número
// nenhum. O que vai daqui é CONSUMO — mensagens, áudios, anexos e tokens —, que
// é medido de verdade e multiplica pelo preço vigente do dia em que alguém
// quiser a conta.
//
// ⚠️ E ELE NÃO DEVOLVE UMA LINHA DE CONVERSA. Nem conteúdo, nem título, nem
// pergunta. A equipe Dexo vê QUANTO o cliente usou; o que ele perguntou é dele.
// A projeção é só de contadores, e existe um teste que falha se alguém acoplar
// `content` aqui.
//
// DUAS FONTES, e cada uma responde o que a outra não responde:
//
//  - `ProviderDailyUsage` — o contador diário que a própria cota escreve, com
//    chave `ai:tenant:<id>` / `ai:audio:<id>` / `ai:anexo:<id>`. É a fonte das
//    QUANTIDADES, e é barata: `@@unique([provider, day])` faz a janela virar uma
//    faixa de índice.
//  - `AiMessage` — os TOKENS, que é o que realmente move o custo do texto.
//
// ⚠️ `AiMessage` não tem índice em `createdAt` sozinho (só
// `[conversationId, createdAt]`), então a janela é um Seq Scan. Medido em
// 12/08/2026: 54 linhas na base inteira, 0,3 ms. É um relatório sob demanda da
// equipe, não um caminho de request de cliente — e a DDL de um índice novo em
// produção é decisão do dono, não minha. Fica anotado aqui para o dia em que a
// tabela crescer.

import prisma from "../../lib/prisma";
import { AI_CONSTANTS } from "../core/ai-constants";

/** Mesma chave de dia da cota: `YYYY-MM-DD` em UTC, comparável como texto. */
function diaUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface ConsumoDeCliente {
  tenantId: string;
  nome: string | null;
  email: string | null;
  /** Desde quando o Bitz está liberado para ele. */
  bitzDesde: Date | null;
  /** Teto diário de mensagens configurado, quando há um. */
  tetoDiario: number | null;
  /**
   * Turnos RESERVADOS na cota diária, do `ProviderDailyUsage`. É o número que
   * decide plano.
   *
   * ⚠️ NÃO É O MESMO DENOMINADOR DE `respostas`, e por isso os dois nomes são
   * diferentes. A cota reserva ANTES de o modelo responder e devolve a reserva
   * em algumas falhas; `respostas` conta linha gravada em `AiMessage`. Pôr um
   * número ao lado do outro como se fossem a mesma coisa produzia, na primeira
   * medição real, um "12 erros em 12 mensagens" que parecia 100% de falha e não
   * era — os 12 erros eram de 27 respostas.
   */
  mensagens: number;
  audios: number;
  anexos: number;
  tokensEntrada: number;
  tokensSaida: number;
  /** Respostas gravadas na janela. É o DENOMINADOR de `respostasComErro`. */
  respostas: number;
  /** Dessas respostas, quantas saíram degradadas. */
  respostasComErro: number;
  /**
   * O motivo de cada uma.
   *
   * ⭐ Sem isto o número engana para o lado ruim: `quota_tenant` é o TETO DO
   * CLIENTE funcionando — o produto fazendo exatamente o que foi configurado —,
   * e somá-lo a `erro_provedor` faria a plataforma parecer quebrada quando o que
   * houve foi um cliente batendo no limite do plano dele.
   */
  errosPorMotivo: Record<string, number>;
  ultimoUso: Date | null;
}

export interface RelatorioDeConsumo {
  dias: number;
  de: string;
  clientes: ConsumoDeCliente[];
  totais: {
    clientesComBitz: number;
    clientesQueUsaram: number;
    mensagens: number;
    audios: number;
    anexos: number;
    tokensEntrada: number;
    tokensSaida: number;
    respostas: number;
    respostasComErro: number;
    errosPorMotivo: Record<string, number>;
  };
  observacao: string;
}

const MAX_DIAS = 365;

/**
 * O relatório. Só quantidades — ver o cabeçalho.
 *
 * `dias` é uma janela ROLANTE contada de agora, e o rótulo `de` diz o primeiro
 * dia incluído para ninguém ler "30 dias" como "este mês".
 */
export async function consumoDeIaPorCliente(
  dias = 30,
): Promise<RelatorioDeConsumo> {
  const janela = Math.min(Math.max(Math.trunc(dias) || 30, 1), MAX_DIAS);
  const desde = new Date(Date.now() - janela * 24 * 60 * 60 * 1000);
  const primeiroDia = diaUtc(desde);

  const [donos, contadores, tokens] = await Promise.all([
    // Só quem TEM o Bitz. Um relatório com 34 linhas zeradas esconderia as 2
    // que interessam.
    (prisma as any).user.findMany({
      where: { parentUserId: null, aiEnabledAt: { not: null } },
      select: {
        id: true,
        name: true,
        email: true,
        aiEnabledAt: true,
        aiDailyLimit: true,
      },
    }),

    prisma.providerDailyUsage.findMany({
      where: { day: { gte: primeiroDia } },
      select: { provider: true, count: true },
    }),

    // ⚠️ `::int` e `::text` obrigatórios: `COUNT`/`SUM` do Postgres voltam como
    // BigInt, e BigInt não serializa em JSON — a rota responderia 500.
    //
    // ⚠️ `role = 'assistant'`: só a resposta carrega token e `errorCode`. Sem o
    // filtro, o denominador dobraria (toda pergunta tem uma resposta) e a taxa
    // de erro apareceria pela METADE do que é.
    //
    // O motivo vem CRU no `GROUP BY` para a agregação por motivo sair de uma
    // consulta só — `quota_tenant` (o teto do cliente, funcionando) não pode ser
    // somado a `erro_provedor` (a plataforma falhando).
    prisma.$queryRaw<
      Array<{
        tenant: string;
        motivo: string | null;
        entrada: number;
        saida: number;
        respostas: number;
        ultimo: Date | null;
      }>
    >`
      SELECT c."dataOwnerId"::text                  AS tenant,
             m."errorCode"                          AS motivo,
             COALESCE(SUM(m."inputTokens"), 0)::int AS entrada,
             COALESCE(SUM(m."outputTokens"), 0)::int AS saida,
             COUNT(*)::int                          AS respostas,
             MAX(m."createdAt")                     AS ultimo
        FROM "AiMessage" m
        JOIN "AiConversation" c ON c.id = m."conversationId"
       WHERE m."createdAt" >= ${desde}
         AND m.role = 'assistant'
       GROUP BY 1, 2
    `,
  ]);

  /** Soma dos contadores diários por chave de cota. */
  const somar = (prefixo: string) => {
    const mapa = new Map<string, number>();
    for (const linha of contadores) {
      if (!linha.provider.startsWith(prefixo)) continue;
      const tenant = linha.provider.slice(prefixo.length);
      mapa.set(tenant, (mapa.get(tenant) ?? 0) + linha.count);
    }
    return mapa;
  };

  const porMensagem = somar(AI_CONSTANTS.USAGE_PROVIDER_TENANT_PREFIX);
  const porAudio = somar(AI_CONSTANTS.USAGE_PROVIDER_AUDIO_PREFIX);
  const porAnexo = somar(AI_CONSTANTS.USAGE_PROVIDER_ANEXO_PREFIX);
  /** As linhas de `AiMessage` dobradas por tenant (elas vêm uma por motivo). */
  const porTenant = new Map<
    string,
    {
      entrada: number;
      saida: number;
      respostas: number;
      erros: number;
      motivos: Record<string, number>;
      ultimo: Date | null;
    }
  >();
  for (const linha of tokens) {
    const atual = porTenant.get(linha.tenant) ?? {
      entrada: 0,
      saida: 0,
      respostas: 0,
      erros: 0,
      motivos: {} as Record<string, number>,
      ultimo: null as Date | null,
    };
    atual.entrada += linha.entrada;
    atual.saida += linha.saida;
    atual.respostas += linha.respostas;
    if (linha.motivo) {
      atual.erros += linha.respostas;
      atual.motivos[linha.motivo] =
        (atual.motivos[linha.motivo] ?? 0) + linha.respostas;
    }
    if (linha.ultimo && (!atual.ultimo || linha.ultimo > atual.ultimo)) {
      atual.ultimo = linha.ultimo;
    }
    porTenant.set(linha.tenant, atual);
  }

  // ⚠️ A anotação explícita é obrigatória: `donos` vem de um `prisma as any`,
  // então `.map()` devolve `any` e os parâmetros do `.sort()` logo abaixo
  // nasceriam com `any` implícito — dois erros novos de `tsc` sobre a baseline.
  const linhas: ConsumoDeCliente[] = (donos as any[]).map(
    (u: any): ConsumoDeCliente => {
      const t = porTenant.get(u.id);
      return {
        tenantId: u.id,
        nome: u.name ?? null,
        email: u.email ?? null,
        bitzDesde: u.aiEnabledAt ?? null,
        tetoDiario: u.aiDailyLimit ?? null,
        mensagens: porMensagem.get(u.id) ?? 0,
        audios: porAudio.get(u.id) ?? 0,
        anexos: porAnexo.get(u.id) ?? 0,
        tokensEntrada: t?.entrada ?? 0,
        tokensSaida: t?.saida ?? 0,
        respostas: t?.respostas ?? 0,
        respostasComErro: t?.erros ?? 0,
        errosPorMotivo: t?.motivos ?? {},
        ultimoUso: t?.ultimo ?? null,
      };
    },
  );

  // Quem mais consome primeiro: é a linha que decide plano.
  const clientes = linhas.sort(
    (a, b) => b.mensagens - a.mensagens || b.tokensEntrada - a.tokensEntrada,
  );

  const soma = (campo: keyof ConsumoDeCliente) =>
    clientes.reduce((n, c) => n + ((c[campo] as number) || 0), 0);

  return {
    dias: janela,
    de: primeiroDia,
    clientes,
    totais: {
      clientesComBitz: clientes.length,
      clientesQueUsaram: clientes.filter((c) => c.mensagens > 0).length,
      mensagens: soma("mensagens"),
      audios: soma("audios"),
      anexos: soma("anexos"),
      tokensEntrada: soma("tokensEntrada"),
      tokensSaida: soma("tokensSaida"),
      respostas: soma("respostas"),
      respostasComErro: soma("respostasComErro"),
      errosPorMotivo: clientes.reduce<Record<string, number>>((acc, c) => {
        for (const [motivo, n] of Object.entries(c.errosPorMotivo)) {
          acc[motivo] = (acc[motivo] ?? 0) + n;
        }
        return acc;
      }, {}),
    },
    observacao:
      "Consumo medido, não custo em reais: não há tabela de preço por token no sistema, e um valor chumbado aqui ficaria errado em silêncio no dia em que o provedor mudasse o preço. Multiplique pelo preço vigente quando precisar da conta. " +
      "`mensagens` são turnos reservados na cota diária; `respostas` são respostas gravadas — denominadores diferentes, não divida um pelo outro. A taxa de erro é `respostasComErro` sobre `respostas`, e `quota_tenant` dentro dela é o teto do próprio cliente funcionando, não falha da plataforma. " +
      "Nenhum conteúdo de conversa sai deste relatório.",
  };
}
