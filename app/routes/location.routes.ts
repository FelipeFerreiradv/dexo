import { createHash } from "crypto";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CapacityExceededError,
  LocationUseCase,
} from "../usecases/location.usercase";
import { authMiddleware } from "../middlewares/auth.middleware";
import { SystemLogService } from "../services/system-log.service";
import {
  describeBatchError,
  expandBulkLocationRows,
  validateBulkLocationRows,
  type BulkLocationRow,
} from "../localizacoes/lib/bulk-locations";

export const locationRoutes = async (fastify: FastifyInstance) => {
  const locationUseCase = new LocationUseCase();

  /**
   * GET /locations
   * Lista localizações (raiz por padrão, ou filhas de um parentId)
   */
  fastify.get(
    "/",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { search, parentId, page, limit, tree } = request.query as {
          search?: string;
          parentId?: string;
          page?: string;
          limit?: string;
          tree?: string;
        };

        // tree=full: árvore completa achatada (todos os níveis) para busca/
        // navegação client-side. Param opcional e retrocompatível — quando
        // ausente, o comportamento abaixo permanece idêntico.
        if (tree === "full") {
          const data = await locationUseCase.listAllFlat(userId);
          return reply.status(200).send({
            locations: data.locations,
            pagination: {
              page: 1,
              limit: data.total,
              total: data.total,
              totalPages: 1,
            },
          });
        }

        const data = await locationUseCase.listLocations({
          userId,
          search: search || undefined,
          parentId: parentId || undefined,
          page: page ? parseInt(page) : 1,
          limit: limit ? parseInt(limit) : 50,
        });

        return reply.status(200).send({
          locations: data.locations,
          pagination: {
            page: page ? parseInt(page) : 1,
            limit: limit ? parseInt(limit) : 50,
            total: data.total,
            totalPages: data.totalPages,
          },
        });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao buscar localizações",
        });
      }
    },
  );

  /**
   * GET /locations/select
   * Lista simplificada para selects/dropdowns (com fullPath)
   *
   * EGRESS: este payload é rebaixado INTEIRO a cada abertura do modal de
   * criar/editar produto (o cache do products-list tem TTL de 15s e os modais
   * nem o usam) — 53,8 KB comprimidos por chamada no maior tenant, ~233 MB/mês
   * somando a base. Encolher o corpo não resolve: o `id` (cuid) sozinho é 64,6%
   * do payload comprimido e é irredutível.
   *
   * Daí o ETag: `no-cache` faz o navegador REVALIDAR sempre (nunca serve dado
   * velho) e, quando nada mudou, a resposta é um 304 sem corpo. Medido sobre 7
   * dias de produção, 70% a 91% das revalidações não teriam mudança.
   *
   * Por que é seguro sem `Vary`: `private` impede cache compartilhado e
   * `no-cache` força revalidação, então uma entrada de outro usuário no mesmo
   * navegador nunca é servida — o ETag é recalculado para o usuário da vez e
   * não bate. O corpo de um 200 é byte-idêntico ao de antes.
   *
   * NÃO ADIANTA IR ALÉM DAQUI — medido em produção (13/08, issue #269), não
   * refazer a análise:
   *  - Cache por TEMPO (no cliente ou via `max-age`) não pega quase nada: a
   *    MEDIANA entre dois cadastros do mesmo usuário é de 434 s. Só 2,2% das
   *    aberturas caem dentro de 60 s da anterior, e 1 em 6.446 dentro de 15 s —
   *    é por isso que o cache de 15 s do `products-list` praticamente nunca
   *    acerta. Para pegar a mediana o TTL teria que ser de ~7 min, defasagem
   *    que nenhum contador aguenta.
   *  - Cache SERVER-SIDE não tem o que economizar: no `pg_stat_statements` as
   *    consultas desta rota somam 60 s de banco em 22 dias (3,7 ms por
   *    chamada). O `groupBy` escopado do `findAllFlat` já matou o custo que
   *    existia.
   *  - Encolher o corpo já tinha sido descartado antes: o `id` (cuid) é 64,6%
   *    do payload comprimido e é a chave de seleção.
   */
  fastify.get(
    "/select",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const locations = await locationUseCase.listForSelect(userId);

        // Serializa UMA vez: o mesmo buffer vira o ETag e o corpo.
        const body = JSON.stringify({ locations });
        const etag = `W/"${createHash("sha1").update(body).digest("base64url")}"`;

        // `if-none-match` pode vir com uma lista; basta um casar.
        const enviado = request.headers["if-none-match"];
        if (
          typeof enviado === "string" &&
          enviado.split(",").some((candidato) => candidato.trim() === etag)
        ) {
          return reply
            .header("ETag", etag)
            .header("Cache-Control", "private, no-cache")
            .status(304)
            .send();
        }

        return reply
          .header("ETag", etag)
          .header("Cache-Control", "private, no-cache")
          .type("application/json")
          .status(200)
          .send(body);
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao buscar localizações",
        });
      }
    },
  );

  /**
   * GET /locations/:id/products
   * Lista produtos vinculados a uma localização
   */
  fastify.get(
    "/:id/products",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const { search, page, limit } = request.query as {
          search?: string;
          page?: string;
          limit?: string;
        };

        const data = await locationUseCase.getLocationProducts(id, userId, {
          search: search || undefined,
          page: page ? parseInt(page) : 1,
          limit: limit ? parseInt(limit) : 50,
        });

        return reply.status(200).send({
          products: data.products,
          pagination: {
            page: page ? parseInt(page) : 1,
            limit: limit ? parseInt(limit) : 50,
            total: data.total,
            totalPages: Math.ceil(data.total / (limit ? parseInt(limit) : 50)),
          },
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao buscar produtos";
        const status = message.includes("não encontrada") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  /**
   * POST /locations/move-products
   * Move produtos entre localizações (ou desvincula)
   */
  fastify.post(
    "/move-products",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { productIds, targetLocationId } = request.body as {
          productIds?: string[];
          targetLocationId?: string | null;
        };

        if (
          !productIds ||
          !Array.isArray(productIds) ||
          productIds.length === 0
        ) {
          return reply
            .status(400)
            .send({ error: "Lista de produtos é obrigatória" });
        }

        const result = await locationUseCase.moveProducts(
          productIds,
          targetLocationId ?? null,
          userId,
        );

        return reply.status(200).send({
          message: targetLocationId
            ? `${result.count} produto(s) movido(s) para "${result.targetLocation}"`
            : `${result.count} produto(s) desvinculado(s)`,
          count: result.count,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao mover produtos";
        const status = message.includes("não encontrada")
          ? 404
          : message.includes("capacidade")
            ? 422
            : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  /**
   * POST /locations/:id/attach-products
   * Vincula produtos a uma localização (usado pelo fluxo de scan).
   * Aborta o batch inteiro se exceder maxCapacity.
   */
  fastify.post(
    "/:id/attach-products",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const { productIds } = request.body as { productIds?: unknown };

        if (!Array.isArray(productIds) || productIds.length === 0) {
          return reply
            .status(400)
            .send({ error: "Lista de produtos é obrigatória" });
        }
        if (productIds.length > 200) {
          return reply
            .status(400)
            .send({ error: "Limite de 200 produtos por requisição" });
        }
        if (!productIds.every((pid) => typeof pid === "string" && pid.length > 0)) {
          return reply
            .status(400)
            .send({ error: "Todos os productIds devem ser strings não vazias" });
        }

        const result = await locationUseCase.attachProducts(
          id,
          productIds as string[],
          userId,
        );

        // Log batch único (não 1 por produto)
        await SystemLogService.logInfo(
          "UPDATE_LOCATION",
          `${result.attached.length} produto(s) vinculado(s) à localização "${result.location.code}" via scan`,
          {
            userId,
            resource: "Location",
            resourceId: id,
            details: {
              attached: result.attached.length,
              alreadyAttached: result.alreadyAttached.length,
              skipped: result.skipped.length,
            },
          },
        );

        return reply.status(200).send(result);
      } catch (error) {
        if (error instanceof CapacityExceededError) {
          return reply.status(422).send({
            error: error.message,
            detail: error.detail,
          });
        }
        const message =
          error instanceof Error ? error.message : "Erro ao vincular produtos";
        const status = message.includes("não encontrada")
          ? 404
          : message.includes("Nenhum produto") ||
              message.includes("Limite de 200")
            ? 400
            : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  /**
   * GET /locations/:id
   * Detalhe de uma localização com filhos e ocupação
   */
  fastify.get(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };

        const location = await locationUseCase.findById(id, userId);
        if (!location) {
          return reply.status(404).send({
            error: "Localização não encontrada",
          });
        }

        return reply.status(200).send({ location });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao buscar localização",
        });
      }
    },
  );

  /**
   * POST /locations
   * Cria uma nova localização (raiz ou subtópico)
   */
  fastify.post(
    "/",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { code, description, maxCapacity, parentId } = request.body as {
          code?: string;
          description?: string;
          maxCapacity?: number;
          parentId?: string;
        };

        // Validações
        if (!code || typeof code !== "string" || code.trim().length === 0) {
          return reply.status(400).send({ error: "Sigla é obrigatória" });
        }
        if (code.trim().length > 20) {
          return reply.status(400).send({
            error: "Sigla deve ter no máximo 20 caracteres",
          });
        }
        if (description && description.length > 200) {
          return reply.status(400).send({
            error: "Descrição deve ter no máximo 200 caracteres",
          });
        }

        const capacity = maxCapacity !== undefined ? Number(maxCapacity) : 0;
        if (isNaN(capacity) || capacity < 0) {
          return reply.status(400).send({
            error: "Capacidade máxima deve ser um número não negativo",
          });
        }

        const location = await locationUseCase.create({
          userId,
          code: code.trim().toUpperCase(),
          description: description?.trim() || undefined,
          maxCapacity: capacity,
          parentId: parentId || undefined,
        });

        return reply.status(201).send({ location });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao criar localização";
        const status = message.includes("Já existe") ? 409 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  /**
   * POST /locations/bulk
   * Cria localizações em massa a partir de FAIXAS (prefixo + intervalo).
   *
   * Recebe as faixas, não os códigos expandidos: a expansão roda aqui com a
   * mesma função pura do front (preview idêntico ao gravado, tetos
   * inburláveis) e o corpo registrado no SystemLog fica pequeno.
   *
   * Siglas duplicadas são reportadas em `skipped` sem derrubar o lote.
   */
  fastify.post(
    "/bulk",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { rows } = (request.body ?? {}) as { rows?: BulkLocationRow[] };

        if (!Array.isArray(rows) || rows.length === 0) {
          return reply
            .status(400)
            .send({ error: "Lista de faixas é obrigatória" });
        }

        const validation = validateBulkLocationRows(rows);
        if (!validation.canGenerate) {
          return reply.status(400).send({
            error: describeBatchError(validation) ?? "Faixas inválidas",
          });
        }

        const items = expandBulkLocationRows(rows);
        const result = await locationUseCase.createBulk({ userId, items });

        // Log agregado (só contadores — o corpo já é enxuto por ser faixas).
        // Fire-and-forget: as localizações já foram criadas, então uma falha
        // ao registrar o log não pode transformar o lote num 500.
        void Promise.resolve(
          SystemLogService.logInfo(
            "CREATE_LOCATION",
            `${result.created.length} localização(ões) criada(s) em lote`,
            {
              userId,
              resource: "Location",
              details: {
                faixas: rows.length,
                requested: items.length,
                created: result.created.length,
                skipped: result.skipped.length,
                failed: result.failed.length,
              },
            },
          ),
        ).catch(() => {});

        return reply.status(result.created.length > 0 ? 201 : 200).send({
          summary: {
            requested: items.length,
            created: result.created.length,
            skipped: result.skipped.length,
            failed: result.failed.length,
          },
          created: result.created,
          skipped: result.skipped,
          failed: result.failed,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Erro ao criar localizações em lote";
        return reply.status(500).send({ error: message });
      }
    },
  );

  /**
   * PATCH /locations/:id
   * Atualiza uma localização
   */
  fastify.patch(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const { code, description, maxCapacity, parentId } = request.body as {
          code?: string;
          description?: string;
          maxCapacity?: number;
          parentId?: string | null;
        };

        // Validações
        if (code !== undefined) {
          if (typeof code !== "string" || code.trim().length === 0) {
            return reply.status(400).send({ error: "Sigla é obrigatória" });
          }
          if (code.trim().length > 20) {
            return reply.status(400).send({
              error: "Sigla deve ter no máximo 20 caracteres",
            });
          }
        }
        if (description !== undefined && description.length > 200) {
          return reply.status(400).send({
            error: "Descrição deve ter no máximo 200 caracteres",
          });
        }

        const data: any = {};
        if (code !== undefined) data.code = code.trim().toUpperCase();
        if (description !== undefined) data.description = description.trim();
        if (parentId !== undefined) data.parentId = parentId;
        if (maxCapacity !== undefined) {
          const capacity = Number(maxCapacity);
          if (isNaN(capacity) || capacity < 0) {
            return reply.status(400).send({
              error: "Capacidade máxima deve ser um número não negativo",
            });
          }
          data.maxCapacity = capacity;
        }

        const location = await locationUseCase.update(id, data, userId);
        return reply.status(200).send({ location });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Erro ao atualizar localização";
        const status = message.includes("não encontrada")
          ? 404
          : message.includes("Já existe")
            ? 409
            : message.includes("Capacidade") ||
                message.includes("circular") ||
                message.includes("pai de si")
              ? 422
              : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  /**
   * DELETE /locations/:id
   * Remove localização e todas as sublocalizações (desvincula produtos)
   */
  fastify.delete(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };

        await locationUseCase.delete(id, userId);

        return reply.status(200).send({
          message: "Localização excluída com sucesso",
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Erro ao excluir localização";
        const status = message.includes("não encontrada") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );
};
