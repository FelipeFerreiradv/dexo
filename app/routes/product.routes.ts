import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ProductUseCase } from "../usecases/product.usercase";
import { ProductCreate } from "../interfaces/product.interface";

export const productRoutes = async (fastify: FastifyInstance) => {
  const productUseCase = new ProductUseCase();
  fastify.post<{ Body: ProductCreate }>(
    "/",
    async (
      request: FastifyRequest<{ Body: ProductCreate }>,
      reply: FastifyReply,
    ) => {
      const { sku, name, description, stock, price } = request.body;
      try {
        const data = await productUseCase.create({
          sku,
          name,
          description,
          stock,
          price,
        });
        return reply.status(201).send(data);
      } catch {
        throw new Error("Erro ao criar produto");
      }
    },
  );
};
