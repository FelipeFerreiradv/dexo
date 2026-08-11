import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { authMiddleware } from "../middlewares/auth.middleware";
import { isAiEnabledFor } from "../ai/entitlement/ai-entitlement.service";
import { requireAiEnabled } from "../ai/entitlement/require-ai-enabled";
import {
  MAX_ANEXOS_POR_TURNO,
  MAX_USER_MESSAGE_CHARS,
  runTurn,
  type AiTurnAnexo,
} from "../ai/agent/orchestrator";
import { AI_CONSTANTS } from "../ai/core/ai-constants";
import { cancelarAcao, confirmarAcao } from "../ai/acoes/acao.service";
import {
  ACAO_EXIGE_ADMIN,
  ACAO_EXIGE_PERMISSAO,
  mensagemDeFalhaDeAcao,
  type AiAcaoTipo,
} from "../ai/acoes/acao.types";
import { apagarMemoria, listarMemorias } from "../ai/memoria/memoria.service";
import { ROTULO_DO_TOPICO } from "../ai/memoria/memoria.types";
import { detectarFormatoDeAudio } from "../ai/audio/audio-formato";
import { nomeDeAnexoSeguro } from "../ai/anexo/anexo-formato";
import {
  anexosDisponiveis,
  classificarAnexo,
  lerAnexo,
  mensagemDeFalhaDeAnexo,
} from "../ai/anexo/leitura.service";
import {
  audioDisponivel,
  mensagemDeFalha,
  transcreverAudio,
} from "../ai/audio/transcricao.service";
import {
  anexoQuotaMessage,
  audioQuotaMessage,
  refundAiAnexo,
  refundAiTranscription,
  reserveAiAnexo,
  reserveAiTranscription,
} from "../ai/quota/ai-usage.service";
import { falhaSemCobranca } from "../ai/core/provider";
import { scopeFromRequest } from "../ai/core/scope";
import { abrirNdjson, querNdjson } from "../ai/stream/ndjson";
import prisma from "../lib/prisma";

/**
 * Rotas do módulo Bitz (agente de IA).
 *
 * Módulo 100% aditivo atrás de DOIS gates: flag global
 * NEXT_PUBLIC_AI_MODULE_ENABLED (kill-switch de deploy) + entitlement por
 * tenant (User.aiEnabledAt — plano pago superior). Sem os dois, TODAS as rotas
 * autenticadas respondem 403 e não tocam em nada — exceto GET /ai/entitlement,
 * que é a sonda de visibilidade da UI (ver comentário abaixo).
 *
 * Isolamento: este plugin NÃO importa nada de produto/pedido/financeiro/
 * marketplace. A seta de dependência aponta sempre do Bitz para o sistema,
 * nunca o contrário.
 *
 * ESCOPO: `dataOwnerId` e `actorUserId` saem SEMPRE de `request.user`, que o
 * authMiddleware montou a partir da sessão. Nunca do corpo, nunca da query,
 * nunca de algo que o modelo possa produzir.
 */
export const aiRoutes = async (fastify: FastifyInstance) => {
  /**
   * GET /ai/entitlement
   *
   * Sonda de visibilidade da UI (decide se o mascote é montado). NÃO retorna
   * 403 — "não contratado" é um estado legítimo ({ enabled: false }), mesma
   * decisão de GET /whatsapp/status (whatsapp.routes.ts:43-57).
   *
   * Contrato mínimo de propósito: só cresce, nunca encolhe. Nada de config do
   * provedor aqui — o cliente não precisa saber qual modelo roda por trás.
   */
  fastify.get(
    "/entitlement",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const dataOwnerId = request.user?.dataOwnerId;
      if (!dataOwnerId) {
        return reply.status(401).send({ error: "Não autenticado" });
      }
      const enabled = await isAiEnabledFor(dataOwnerId);
      return reply.send({ enabled });
    },
  );

  /**
   * GET /ai/capacidades — o que este cliente pode FAZER dentro do chat.
   *
   * ⭐ ROTA SEPARADA DA SONDA, de propósito. `/ai/entitlement` roda em TODA
   * página, para todo usuário, só para decidir se o mascote aparece — e o
   * contrato dele é verificado por teste com igualdade estrita. Crescer aquele
   * objeto sairia caro nos dois sentidos: quebraria o teste e mandaria bytes a
   * mais em toda navegação, para uma informação que só interessa a quem ABRIU
   * o chat.
   *
   * Aqui é o oposto: só é chamada quando o painel monta, e o front guarda a
   * resposta pela sessão.
   *
   * `audio` diz se o MICROFONE DEVE APARECER. Botão que sempre falha é pior que
   * botão nenhum: o lojista grava, espera e leva um erro. Quem configurou só o
   * modelo de texto — e o DeepSeek não tem áudio — recebe `false`, e o chat
   * segue inteiro sem o microfone.
   *
   * `anexos` é a LISTA DE EXTENSÕES que o clipe deve oferecer, e ela sai daqui
   * pela mesma razão. `.xml` está sempre nela (ler NF-e não depende de provedor
   * nenhum); `.jpg`/`.png`/`.webp` só entram quando há modelo de visão
   * configurado. Lista vazia ⇒ o clipe não aparece.
   *
   * Nunca o nome do provedor nem do modelo: o front não sabe (nem precisa saber)
   * o que está por trás — só o que ele pode oferecer ao lojista.
   */
  fastify.get(
    "/capacidades",
    { preHandler: [authMiddleware, requireAiEnabled] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user?.dataOwnerId) {
        return reply.status(401).send({ error: "Não autenticado" });
      }
      return reply.send({
        audio: audioDisponivel(),
        anexos: anexosDisponiveis(),
        // ⭐ `memorias` diz se o BOTÃO "o que eu sei da sua loja" DEVE APARECER
        // (Fase 11). Vem do servidor pela mesma razão do microfone e do clipe:
        // esconder no cliente nunca foi permissão, e o botão que sempre dá 403
        // é pior que botão nenhum. A permissão de verdade continua nas rotas
        // `/ai/memorias`, que conferem `isAdmin` por conta própria.
        memorias: !request.user.parentUserId,
      });
    },
  );

  /**
   * POST /ai/anexo — o lojista anexa um arquivo, isto devolve a LEITURA dele.
   *
   * ⭐ NÃO RESPONDE À PERGUNTA, mesma decisão central da Fase 7. A leitura volta
   * para o navegador, aparece num cartão acima do campo de escrita, o lojista
   * confere — e corrige o código da peça que o modelo leu errado — e só então
   * pergunta pelo `/ai/chat` de sempre.
   *
   * O arquivo vive na memória pelo tempo da chamada e some. Nada em disco, nada
   * em banco: foi decisão explícita do dono, e ela apaga de uma vez três riscos
   * do mapa — anexo servido sem auth, o GC de órfãos apagando arquivo de tabela
   * nova, e retenção de documento do cliente.
   *
   * DOIS CAMINHOS, e a diferença entre eles é DINHEIRO:
   *   - imagem  → modelo de visão (`AI_ROUTE_IMAGEM`). Custa, então reserva cota.
   *   - XML NF-e → `parseNfeXml`, puro e local. NÃO custa nada, então NÃO
   *     reserva cota: cobrar por uma leitura que a plataforma não pagou faria um
   *     desmonte com vinte notas no dia bater num teto sem motivo.
   *
   * Mesmo gate, mesmo rate limit e mesmo bucket-próprio do `/ai/chat`.
   */
  fastify.post(
    "/anexo",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          hook: "preHandler",
          keyGenerator: (req: any) => req.user?.id ?? req.ip,
        },
      },
      preHandler: [authMiddleware, requireAiEnabled],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.dataOwnerId) {
        return reply.status(401).send({ error: "Não autenticado" });
      }
      const dataOwnerId = user.dataOwnerId;

      // ⚠️ Teto POR REQUISIÇÃO, que vence o global de 20 MB do registro do
      // multipart. O global não é tocado — a regra da casa é que a rota que
      // precisa de limite diferente o declare aqui, nunca lá.
      let parte: any;
      try {
        parte = await (request as any).file({
          limits: { fileSize: AI_CONSTANTS.MAX_ANEXO_BYTES, files: 1 },
        });
      } catch {
        return reply
          .status(400)
          .send({ error: mensagemDeFalhaDeAnexo("formato_invalido") });
      }
      if (!parte) {
        return reply
          .status(400)
          .send({ error: mensagemDeFalhaDeAnexo("vazio") });
      }

      let buffer: Buffer;
      try {
        buffer = await parte.toBuffer();
      } catch {
        // `toBuffer` estoura quando o arquivo passa do `fileSize` acima.
        return reply
          .status(400)
          .send({ error: mensagemDeFalhaDeAnexo("grande_demais") });
      }

      // A classificação é por BYTES e vem ANTES de qualquer reserva: arquivo
      // inválido não pode consumir a cota de ninguém, e é ela que diz se este
      // caminho custa dinheiro.
      const classe = classificarAnexo(buffer, parte.mimetype);
      if (!classe.ok) {
        return reply
          .status(400)
          .send({ error: mensagemDeFalhaDeAnexo(classe.motivo) });
      }

      if (classe.pago) {
        const quota = await reserveAiAnexo({ dataOwnerId });
        if (!quota.ok) {
          // 200 e não 4xx: teto batido é estado de negócio, e o front mostra a
          // mensagem no chat como faz com o teto de mensagens.
          return reply.send({
            ok: false,
            error: anexoQuotaMessage(quota.denied ?? "tenant"),
          });
        }
      }

      const r = await lerAnexo({ buffer, formato: classe.formato });

      if (!r.ok) {
        // Nada foi cobrado quando o provedor nem chegou a ser chamado — e "não
        // consegui enxergar" também não gasta: o lojista vai tirar outra foto.
        //
        // ⭐ E `falhaSemCobranca` cobre o caso que faltava: chave inválida ou
        // sem saldo é recusa ANTES de qualquer token. Cobrar por isso tirava do
        // lojista um dos 15 anexos do dia por um problema de configuração nosso.
        if (
          classe.pago &&
          (r.motivo !== "erro_provedor" || falhaSemCobranca(r.detalhe))
        ) {
          await refundAiAnexo({ dataOwnerId });
        }
        return reply.send({
          ok: false,
          error: mensagemDeFalhaDeAnexo(r.motivo, r.detalhe),
        });
      }

      return reply.send({
        ok: true,
        anexo: {
          // O nome vem do disco do cliente e vai parar no rótulo do envelope do
          // prompt. Saneado aqui, na fronteira, e não lá adiante.
          nome: nomeDeAnexoSeguro(parte.filename),
          tipo: r.tipo,
          leitura: r.leitura,
          resumo: r.resumo,
        },
      });
    },
  );

  /**
   * POST /ai/audio — o lojista fala, isto devolve o TEXTO.
   *
   * ⭐ NÃO RESPONDE À PERGUNTA, e essa é a decisão central da Fase 7. O texto
   * volta para o navegador, entra no campo de escrita, o lojista lê e corrige
   * se a transcrição errou o nome da peça — e só então envia pelo `/ai/chat`
   * de sempre. Assim:
   *   - transcrição ruim não vira pergunta errada gastando a cota dele;
   *   - o orquestrador NÃO MUDA: nenhuma linha dele sabe que existe áudio.
   *
   * O arquivo vive na memória pelo tempo da chamada e some. Nada em disco,
   * nada em banco: voz é dado sensível e não guardar é a única garantia real.
   *
   * Mesmo gate, mesmo rate limit e mesmo bucket-próprio do `/ai/chat`. A cota
   * DIÁRIA é separada (ver `reserveAiTranscription`): gravar duas ou três vezes
   * até sair direito é normal e não pode consumir mensagens.
   */
  fastify.post(
    "/audio",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          hook: "preHandler",
          keyGenerator: (req: any) => req.user?.id ?? req.ip,
        },
      },
      preHandler: [authMiddleware, requireAiEnabled],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.dataOwnerId) {
        return reply.status(401).send({ error: "Não autenticado" });
      }
      const dataOwnerId = user.dataOwnerId;

      // ⚠️ Teto POR REQUISIÇÃO, que vence o global de 20 MB do registro do
      // multipart (deepmergeAll). O global não é tocado — a regra da casa é
      // que rota que precisa de limite diferente o declare aqui, nunca lá.
      let parte: any;
      try {
        parte = await (request as any).file({
          limits: { fileSize: AI_CONSTANTS.MAX_AUDIO_BYTES, files: 1 },
        });
      } catch {
        return reply
          .status(400)
          .send({ error: mensagemDeFalha("formato_invalido") });
      }
      if (!parte) {
        return reply.status(400).send({ error: mensagemDeFalha("vazio") });
      }

      let buffer: Buffer;
      try {
        buffer = await parte.toBuffer();
      } catch {
        // `toBuffer` estoura quando o arquivo passa do `fileSize` acima.
        return reply
          .status(400)
          .send({ error: mensagemDeFalha("grande_demais") });
      }

      // A cota é reservada DEPOIS da validação de bytes e ANTES da chamada
      // externa: arquivo inválido não pode consumir a cota de ninguém, e
      // chamada paga não pode acontecer sem reserva.
      const formatoOk =
        buffer.length > 0 &&
        buffer.length <= AI_CONSTANTS.MAX_AUDIO_BYTES &&
        detectarFormatoDeAudio(buffer) !== null;
      if (!formatoOk) {
        return reply.status(400).send({
          error: mensagemDeFalha(
            buffer.length > AI_CONSTANTS.MAX_AUDIO_BYTES
              ? "grande_demais"
              : buffer.length === 0
                ? "vazio"
                : "formato_invalido",
          ),
        });
      }

      const quota = await reserveAiTranscription({ dataOwnerId });
      if (!quota.ok) {
        // 200 e não 4xx: teto batido é estado de negócio, e o front mostra a
        // mensagem no chat como faz com o teto de mensagens.
        return reply.send({
          ok: false,
          error: audioQuotaMessage(quota.denied ?? "tenant"),
        });
      }

      const r = await transcreverAudio({
        buffer,
        mimeDeclarado: parte.mimetype,
      });

      if (!r.ok) {
        // Nada foi cobrado quando o provedor nem chegou a ser chamado — e
        // "sem fala" também não gasta: o lojista vai regravar.
        //
        // ⭐ Idem ao anexo: recusa por chave ou saldo não custou nada, e queimar
        // um áudio do dia por causa dela é cobrar do cliente um erro nosso.
        if (r.motivo !== "erro_provedor" || falhaSemCobranca(r.detalhe)) {
          await refundAiTranscription({ dataOwnerId });
        }
        return reply.send({ ok: false, error: mensagemDeFalha(r.motivo) });
      }

      return reply.send({ ok: true, texto: r.texto });
    },
  );

  /**
   * POST /ai/chat
   *
   * Um turno de conversa. NUNCA responde 5xx por causa de IA: provedor fora do
   * ar, timeout ou teto de cota viram 200 com `degraded: true` e uma mensagem
   * legível — o front mostra no chat e o resto do ERP não sente nada.
   *
   * bodyLimit explícito: o Fastify default é 1 MB e não há override global
   * neste projeto. 64 KB é folgado para uma pergunta de chat.
   *
   * Rate limit PRÓPRIO, com store filho: `config.rateLimit` faz o
   * @fastify/rate-limit criar um bucket separado para esta rota
   * (node_modules/@fastify/rate-limit/index.js:141-157), então o teto global de
   * 300/min das outras rotas continua byte-idêntico. `hook: "preHandler"` é
   * obrigatório — o default `onRequest` roda ANTES do authMiddleware, quando
   * `request.user` ainda não existe e o keyGenerator cairia sempre no IP.
   */
  fastify.post(
    "/chat",
    {
      bodyLimit: 64 * 1024,
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          hook: "preHandler",
          keyGenerator: (req: any) => req.user?.id ?? req.ip,
        },
      },
      preHandler: [authMiddleware, requireAiEnabled],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.dataOwnerId) {
        return reply.status(401).send({ error: "Não autenticado" });
      }

      const body = (request.body ?? {}) as {
        message?: unknown;
        conversationId?: unknown;
        anexos?: unknown;
      };

      const message =
        typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        return reply
          .status(400)
          .send({ error: "Campo 'message' é obrigatório" });
      }
      if (message.length > MAX_USER_MESSAGE_CHARS) {
        return reply.status(400).send({
          error: `Mensagem muito longa (máximo ${MAX_USER_MESSAGE_CHARS} caracteres)`,
        });
      }

      const conversationId =
        typeof body.conversationId === "string" && body.conversationId
          ? body.conversationId
          : undefined;

      const anexos = lerAnexosDoCorpo(body.anexos);

      // -----------------------------------------------------------------
      // Streaming por NEGOCIAÇÃO DE CONTEÚDO, e não numa rota separada.
      //
      // Duas rotas dariam DOIS baldes de rate limit (o @fastify/rate-limit
      // cria um store por rota), e um cliente alternando entre elas teria o
      // dobro do teto por minuto. Aqui o gate, o bodyLimit, a validação e o
      // balde são literalmente os mesmos — só o formato da resposta muda.
      //
      // Quem não manda o Accept cai no caminho JSON de antes, byte a byte.
      // -----------------------------------------------------------------
      if (querNdjson(request.headers.accept)) {
        const saida = abrirNdjson(reply);
        // Primeiro quadro imediato: solta os cabeçalhos e prova ao front (e a
        // qualquer proxy no caminho) que a conexão está viva antes de o modelo
        // levar seus segundos para começar a falar.
        saida.escrever({ type: "inicio" });

        try {
          const result = await runTurn({
            dataOwnerId: user.dataOwnerId,
            actorUserId: user.id,
            message,
            conversationId,
            ...(anexos.length ? { anexos } : {}),
            scope: scopeFromRequest(request) ?? undefined,
            onEvent: saida.escrever,
          });

          // ⭐ O quadro `fim` é a RESPOSTA. Os deltas foram prévia; o que o
          // front guarda, e o que foi gravado no banco, é isto. É a mesma
          // carga do caminho JSON, o que mantém os dois formatos impossíveis
          // de divergir.
          saida.escrever({
            type: "fim",
            conversationId: result.conversationId,
            message: { content: result.content, sources: result.sources },
            degraded: result.degraded,
            usage: result.usage,
            // Propostas de escrita deste turno. Ausente quando não houve —
            // o quadro `fim` de um turno de consulta não muda.
            ...(result.acoes ? { acoes: result.acoes } : {}),
          });
        } catch (error) {
          // Os cabeçalhos já foram; não existe mais status para mudar. A falha
          // vira um `fim` degradado — o front trata igual ao 200 degradado do
          // caminho JSON.
          request.log.warn(
            { err: error },
            "[bitz] turno falhou de forma inesperada (stream)",
          );
          saida.escrever({
            type: "fim",
            conversationId: conversationId ?? null,
            message: {
              content:
                "Não consegui responder agora. Tenta de novo em instantes.",
              sources: [],
            },
            degraded: true,
            usage: { inputTokens: null, outputTokens: null },
          });
        } finally {
          saida.encerrar();
        }
        return;
      }

      try {
        const result = await runTurn({
          dataOwnerId: user.dataOwnerId,
          actorUserId: user.id,
          message,
          conversationId,
          ...(anexos.length ? { anexos } : {}),
          // ⭐ O escopo das consultas sai DAQUI e de nenhum outro lugar: tenant
          // e permissões vêm da sessão já autenticada. `scopeFromRequest` é a
          // única fábrica que existe (ai/core/scope.ts), e sem ela o turno roda
          // sem tool nenhuma em vez de rodar com um tenant adivinhado.
          scope: scopeFromRequest(request) ?? undefined,
        });

        return reply.send({
          conversationId: result.conversationId,
          message: { content: result.content, sources: result.sources },
          degraded: result.degraded,
          usage: result.usage,
          ...(result.acoes ? { acoes: result.acoes } : {}),
        });
      } catch (error) {
        // runTurn não deveria lançar. Se lançar, o erro morre AQUI: o chat
        // reporta indisponibilidade e nenhum alerta de infra é disparado.
        request.log.warn(
          { err: error },
          "[bitz] turno falhou de forma inesperada",
        );
        return reply.send({
          conversationId: conversationId ?? null,
          message: {
            content:
              "Não consegui responder agora. Tenta de novo em instantes.",
            sources: [],
          },
          degraded: true,
          usage: { inputTokens: null, outputTokens: null },
        });
      }
    },
  );

  /**
   * POST /ai/acoes/:id/confirmar — ⭐ O ÚNICO CAMINHO DE ESCRITA DO BITZ.
   *
   * Nenhuma tool escreve. Elas gravam uma proposta em `AiAction` com status
   * "pendente"; esta rota é a que executa, e só ela.
   *
   * ⭐ O CORPO É IGNORADO DE PROPÓSITO — não há corpo. O que é executado sai do
   * `payload` da linha no banco, não do que o navegador devolveu. Sem isso, esta
   * rota seria uma rota de escrita genérica com nome de confirmação: um `curl`
   * mandaria `{produtoId, preco: 1}` e o servidor obedeceria, porque "o usuário
   * confirmou".
   *
   * TRÊS TRAVAS, nesta ordem:
   *   1. o gate de sempre (autenticado + plano);
   *   2. ⭐ A PERMISSÃO É CONFERIDA DE NOVO, AGORA. A checagem do tool-runner
   *      aconteceu quando a proposta nasceu; entre lá e aqui o administrador
   *      pode ter tirado a permissão do colaborador, e o que vale é o AGORA.
   *   3. o escopo `(id, dataOwnerId, actorUserId)` dentro do serviço — proposta
   *      de outra pessoa não resolve.
   */
  fastify.post(
    "/acoes/:id/confirmar",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
          hook: "preHandler",
          keyGenerator: (req: any) => req.user?.id ?? req.ip,
        },
      },
      preHandler: [authMiddleware, requireAiEnabled],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const scope = scopeFromRequest(request);
      if (!scope) {
        return reply.status(401).send({ error: "Não autenticado" });
      }
      const { id } = request.params as { id: string };

      // A proposta é lida ANTES para saber QUAL permissão exigir. Ela ainda não
      // executa nada — quem executa é `confirmarAcao`, logo abaixo.
      const pendente = await prisma.aiAction.findFirst({
        where: {
          id,
          dataOwnerId: scope.dataOwnerId,
          actorUserId: scope.actorId,
        },
        select: { action: true },
      });
      if (!pendente) {
        // 404 e não 403: não confirmamos a existência de um id alheio.
        return reply
          .status(404)
          .send({ error: mensagemDeFalhaDeAcao("nao_encontrada") });
      }

      const exigida = ACAO_EXIGE_PERMISSAO[pendente.action as AiAcaoTipo];
      if (!exigida || !scope.canAction(exigida)) {
        return reply
          .status(403)
          .send({ error: mensagemDeFalhaDeAcao("sem_permissao") });
      }

      // ⭐ E a trava de ADMINISTRADOR, para as ações que a exigem (Fase 11).
      //
      // ⚠️ SEPARADA DA PERMISSÃO POR AÇÃO, e não redundante com ela: a permissão
      // por ação nasce LIGADA para o colaborador (default da casa), então
      // `canAction` acima devolve `true` para ele. "Só o dono ensina" precisa da
      // sua própria conferência — e precisa dela AQUI, no momento do clique,
      // porque entre propor e confirmar passam até 30 minutos.
      if (
        ACAO_EXIGE_ADMIN.has(pendente.action as AiAcaoTipo) &&
        !scope.isAdmin
      ) {
        return reply
          .status(403)
          .send({ error: mensagemDeFalhaDeAcao("sem_permissao") });
      }

      const r = await confirmarAcao({ id, scope });

      if (!r.ok) {
        // 200 com `ok:false`: proposta vencida ou já decidida é estado de
        // negócio, e o cartão mostra a mensagem no lugar dos botões.
        return reply.send({ ok: false, error: r.mensagem });
      }
      return reply.send({
        ok: true,
        status: r.status,
        resultId: r.resultId,
        jaEstava: r.jaEstava,
        // Só em lote: o que entrou e o que faltou.
        ...(r.relatorio ? { relatorio: r.relatorio } : {}),
      });
    },
  );

  /**
   * POST /ai/acoes/:id/cancelar — o lojista desistiu.
   *
   * Não exige a permissão da ação de propósito: quem pode CRIAR uma proposta
   * pode desistir dela, e recusar um cancelamento por falta de permissão
   * deixaria uma proposta pendente que ninguém consegue fechar. O escopo
   * `(id, tenant, ator)` continua valendo.
   */
  fastify.post(
    "/acoes/:id/cancelar",
    { preHandler: [authMiddleware, requireAiEnabled] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const scope = scopeFromRequest(request);
      if (!scope) {
        return reply.status(401).send({ error: "Não autenticado" });
      }
      const { id } = request.params as { id: string };

      const r = await cancelarAcao({ id, scope });
      return r.ok
        ? reply.send({ ok: true, status: r.status })
        : reply.send({ ok: false, error: r.mensagem });
    },
  );

  /**
   * GET /ai/conversations
   * Histórico do ATOR (não do tenant): a conversa de um colaborador não
   * aparece para o outro, nem para o admin.
   */
  fastify.get(
    "/conversations",
    { preHandler: [authMiddleware, requireAiEnabled] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.dataOwnerId) {
        return reply.status(401).send({ error: "Não autenticado" });
      }

      const conversations = await prisma.aiConversation.findMany({
        where: { actorUserId: user.id, dataOwnerId: user.dataOwnerId },
        orderBy: { updatedAt: "desc" },
        take: 30,
        select: { id: true, title: true, updatedAt: true },
      });

      return reply.send({ conversations });
    },
  );

  /**
   * GET /ai/conversations/:id
   * 404 quando a conversa não é do ator — nunca 403, para não confirmar a
   * existência de um id que pertence a outra pessoa.
   */
  fastify.get(
    "/conversations/:id",
    { preHandler: [authMiddleware, requireAiEnabled] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.dataOwnerId) {
        return reply.status(401).send({ error: "Não autenticado" });
      }
      const { id } = request.params as { id: string };

      const conversation = await prisma.aiConversation.findFirst({
        where: {
          id,
          actorUserId: user.id,
          dataOwnerId: user.dataOwnerId,
        },
        select: { id: true, title: true, createdAt: true, updatedAt: true },
      });
      if (!conversation) {
        return reply.status(404).send({ error: "Conversa não encontrada" });
      }

      const messages = await prisma.aiMessage.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: "asc" },
        take: 200,
        // Projeção enxuta: tokens/latência/provedor são telemetria interna e
        // não têm por que trafegar para o browser.
        select: {
          id: true,
          role: true,
          content: true,
          sources: true,
          errorCode: true,
          createdAt: true,
        },
      });

      return reply.send({ conversation, messages });
    },
  );

  /**
   * GET /ai/memorias — o que o Bitz sabe sobre esta loja. Fase 11.
   *
   * ⭐ SÓ O ADMINISTRADOR, e a decisão é a mesma de quem grava. A lista é o
   * conteúdo integral das regras da casa — markup, política de desconto, o que
   * a loja faz e não faz. Ela já influencia a RESPOSTA que o colaborador recebe;
   * abrir o texto cru para ele é outra coisa, e ninguém pediu.
   *
   * Escopo por `dataOwnerId` — memória é da LOJA, não de quem digitou. É por
   * isso que ela não usa `actorUserId`, ao contrário das conversas.
   */
  fastify.get(
    "/memorias",
    { preHandler: [authMiddleware, requireAiEnabled] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const scope = scopeFromRequest(request);
      if (!scope) {
        return reply.status(401).send({ error: "Não autenticado" });
      }
      if (!scope.isAdmin) {
        return reply.status(403).send({
          error: "Só o administrador da conta vê e edita a memória do Bitz.",
        });
      }

      const memorias = await listarMemorias({
        dataOwnerId: scope.dataOwnerId,
      });

      return reply.send({
        memorias: memorias.map((m) => ({
          id: m.id,
          topico: m.topico,
          // O rótulo vai pronto: a tela não precisa carregar a tabela de
          // tópicos, e um tópico desconhecido já virou "geral" na leitura.
          topicoLabel: ROTULO_DO_TOPICO[m.topico],
          conteudo: m.conteudo,
          createdAt: m.createdAt,
        })),
      });
    },
  );

  /**
   * DELETE /ai/memorias/:id — o administrador esqueceu uma regra. Fase 11.
   *
   * ⛔ ISTO NÃO FURA A REGRA "O BITZ NÃO APAGA". O que o Bitz não apaga é DADO
   * DE NEGÓCIO — peça, pedido, cliente —, e não existe ferramenta para ele
   * fazer isso. Aqui quem apaga é o administrador, na tela, com o dedo dele, e o
   * que some é uma anotação do próprio agente. Não há tool de esquecer, e pedir
   * por escrito no chat não apaga nada.
   */
  fastify.delete(
    "/memorias/:id",
    { preHandler: [authMiddleware, requireAiEnabled] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const scope = scopeFromRequest(request);
      if (!scope) {
        return reply.status(401).send({ error: "Não autenticado" });
      }
      if (!scope.isAdmin) {
        return reply.status(403).send({
          error: "Só o administrador da conta vê e edita a memória do Bitz.",
        });
      }
      const { id } = request.params as { id: string };

      // `deleteMany` COM o tenant no `where`, dentro do serviço: id de outra
      // loja não apaga nada e devolve 404.
      const apagou = await apagarMemoria({
        id,
        dataOwnerId: scope.dataOwnerId,
      });
      if (!apagou) {
        return reply.status(404).send({ error: "Memória não encontrada" });
      }

      return reply.status(204).send();
    },
  );

  /** DELETE /ai/conversations/:id — as mensagens caem por cascade. */
  fastify.delete(
    "/conversations/:id",
    { preHandler: [authMiddleware, requireAiEnabled] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.dataOwnerId) {
        return reply.status(401).send({ error: "Não autenticado" });
      }
      const { id } = request.params as { id: string };

      // deleteMany COM o escopo (e não delete por id) para o id de outra
      // pessoa não apagar nada — mesmo padrão de idor-isolation.spec.ts.
      const { count } = await prisma.aiConversation.deleteMany({
        where: { id, actorUserId: user.id, dataOwnerId: user.dataOwnerId },
      });
      if (count === 0) {
        return reply.status(404).send({ error: "Conversa não encontrada" });
      }

      return reply.status(204).send();
    },
  );
};

/**
 * As leituras de anexo que vieram no corpo do `/ai/chat`. Fase 8.
 *
 * ⚠️ POR QUE O CLIENTE PODE MANDAR A LEITURA DE VOLTA, E POR QUE ISSO ESTÁ
 * CERTO. Alguém vai olhar isto e perguntar se um `curl` não poderia inventar
 * uma "leitura" que o servidor nunca produziu. Poderia — e não muda nada. O
 * dono da requisição é o próprio usuário autenticado, e ele SEMPRE pôde escrever
 * o que quisesse no campo `message`. Mandar texto pela via do anexo é
 * estritamente MENOS poderoso: ali o conteúdo entra embrulhado em
 * `<dados_do_sistema>`, que é a fronteira que impede dado de virar instrução.
 *
 * O que precisa mesmo de guarda é o TAMANHO — a leitura é gravada e volta no
 * histórico de todo turno seguinte — e o formato, que vem de fora e não pode
 * chegar torto no orquestrador. É o que esta função faz, e nada além disso.
 */
function lerAnexosDoCorpo(bruto: unknown): AiTurnAnexo[] {
  if (!Array.isArray(bruto)) return [];

  return bruto
    .slice(0, MAX_ANEXOS_POR_TURNO)
    .map((item: any): AiTurnAnexo | null => {
      const leitura =
        typeof item?.leitura === "string"
          ? item.leitura.slice(0, AI_CONSTANTS.MAX_ANEXO_LEITURA_CHARS).trim()
          : "";
      if (!leitura) return null;
      return { nome: nomeDeAnexoSeguro(item?.nome), leitura };
    })
    .filter((a): a is AiTurnAnexo => a !== null);
}
