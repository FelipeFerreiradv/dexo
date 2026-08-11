// Tool de leitura de CLIENTES.
//
// ⭐ ESTA É A TOOL COM MAIS DADO PESSOAL DO SISTEMA, e por isso é a que mais
// corta.
//
// `CustomerUseCase.search` devolve o registro INTEIRO — as ~46 colunas, sem
// `select` (customer.repository.ts:271-275): CPF, RG, data de nascimento,
// gênero, estado civil, endereço completo, endereço de entrega, e-mail,
// telefone, observações. Tudo isso pertence ao lojista e ele vê na tela dele.
//
// Só que aqui o destino é diferente: o que sai desta função vai para o contexto
// de um modelo de linguagem de terceiro. Mandar RG e data de nascimento de um
// comprador para responder "qual o telefone do João?" é dado que ninguém pediu
// e que não volta atrás.
//
// A projeção abaixo é o mínimo para o lojista reconhecer e contatar o cliente:
// nome, cidade/UF, telefone, e o documento MASCARADO. Quem precisa do CPF
// inteiro (para emitir nota, por exemplo) abre o cadastro — que é onde ele já
// está, com o controle de acesso da tela.

import { z } from "zod";

import { CustomerUseCase } from "../../../usecases/customer.usecase";
import type { AiTool } from "../registry";
import { texto } from "../serialize";

const MAX_ITENS = 10;

/**
 * Documento mascarado: mantém os 3 últimos dígitos.
 *
 * É o suficiente para o lojista confirmar "é esse mesmo" contra o papel na mão,
 * e insuficiente para reconstruir o documento.
 */
export function mascararDocumento(valor: unknown): string | null {
  const digitos = String(valor ?? "").replace(/\D/g, "");
  if (digitos.length < 4) return null;
  return `•••${digitos.slice(-3)}`;
}

export const buscarCliente: AiTool = {
  name: "buscar_cliente",
  description:
    "Busca clientes cadastrados por nome, documento, e-mail ou telefone. " +
    "Devolve nome, cidade, telefone e o documento parcialmente mascarado. " +
    "Por privacidade, NÃO devolve CPF/CNPJ completo, RG, data de nascimento nem endereço — " +
    "se o usuário precisar desses dados, oriente a abrir o cadastro do cliente na tela Clientes.",
  args: z
    .object({
      consulta: z
        .string()
        .min(2)
        .max(80)
        .describe("Nome, documento, e-mail ou telefone do cliente."),
    })
    .strict(),
  kind: "read",
  page: "clientes",
  keywords: [
    "cliente",
    "comprador",
    "consumidor",
    "cpf",
    "cnpj",
    "fornecedor",
    "quem comprou",
  ],
  sourceLabel: "Clientes cadastrados",
  handler: async (args, scope) => {
    const usecase = new CustomerUseCase();
    const clientes = await usecase.search(args.consulta, scope.dataOwnerId);

    return {
      total: clientes.length,
      // O usecase já limita em 10 (customer.usecase.ts:147); repetimos o teto
      // aqui para o contrato da tool não depender de um default do outro lado.
      itens: clientes.slice(0, MAX_ITENS).map((c: any) => ({
        id: c.id,
        nome: c.personType === "PJ" ? (c.razaoSocial ?? c.name) : c.name,
        tipo: c.personType === "PJ" ? "empresa" : "pessoa física",
        documento: mascararDocumento(c.personType === "PJ" ? c.cnpj : c.cpf),
        telefone: texto(c.mobile ?? c.phone, 24),
        cidade: c.city ?? null,
        uf: c.state ?? null,
      })),
      observacao:
        "Documento mascarado por privacidade. O cadastro completo fica na tela Clientes.",
    };
  },
};
