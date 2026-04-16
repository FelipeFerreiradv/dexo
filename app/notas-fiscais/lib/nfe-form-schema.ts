import { z } from "zod";

// ── Step 1 — Informações Gerais ──

export const stepInfoGeralSchema = z.object({
  serie: z.coerce.number().int().min(1, "Série é obrigatória"),
  tipoOperacao: z.enum(["ENTRADA", "SAIDA"]),
  finalidade: z.enum(["NORMAL", "COMPLEMENTAR", "AJUSTE", "DEVOLUCAO"]),
  destinoOperacao: z.enum(["INTERNA", "INTERESTADUAL", "EXTERIOR"]),
  naturezaOperacao: z.string().min(2, "Natureza da operação é obrigatória"),
  indPresenca: z.enum([
    "NAO_SE_APLICA",
    "PRESENCIAL",
    "INTERNET",
    "TELEMARKETING",
    "ENTREGA_DOMICILIO",
    "PRESENCIAL_FORA",
    "OUTROS",
  ]),
  intermediador: z.string().optional().nullable(),
  numeroPedido: z.string().optional().nullable(),
  dataEmissao: z.string().optional().nullable(),
  dataSaida: z.string().optional().nullable(),
});

export type StepInfoGeralData = z.infer<typeof stepInfoGeralSchema>;

// ── Step 2 — Destinatário ──

export const stepDestinatarioSchema = z.object({
  customerId: z.string().optional().nullable(),
  destinatario: z.object({
    tipoPessoa: z.enum(["PF", "PJ", "EXTERIOR"]),
    cpfCnpj: z.string().min(1, "CPF/CNPJ é obrigatório"),
    nome: z.string().min(2, "Nome é obrigatório"),
    inscricaoEstadual: z.string().optional().nullable(),
    email: z.string().optional().nullable(),
    telefone: z.string().optional().nullable(),
    cep: z.string().optional().nullable(),
    logradouro: z.string().optional().nullable(),
    numero: z.string().optional().nullable(),
    complemento: z.string().optional().nullable(),
    bairro: z.string().optional().nullable(),
    municipio: z.string().optional().nullable(),
    codMunicipio: z.string().optional().nullable(),
    uf: z.string().optional().nullable(),
    codPais: z.string().optional().nullable(),
    pais: z.string().optional().nullable(),
  }),
});

export type StepDestinatarioData = z.infer<typeof stepDestinatarioSchema>;

// ── Step 3 — Produtos ──

export const nfeItemSchema = z.object({
  productId: z.string().optional().nullable(),
  numero: z.coerce.number().int().min(1),
  codigo: z.string().min(1, "Código é obrigatório"),
  descricao: z.string().min(1, "Descrição é obrigatória"),
  ncm: z.string().min(8, "NCM deve ter 8 dígitos").max(8),
  cfop: z.string().min(4, "CFOP deve ter 4 dígitos").max(4),
  cest: z.string().optional().nullable(),
  origem: z.coerce.number().int().min(0).max(8),
  unidade: z.string().min(1, "Unidade é obrigatória"),
  quantidade: z.coerce.number().positive("Quantidade deve ser maior que 0"),
  valorUnitario: z.coerce.number().min(0, "Valor unitário inválido"),
  valorTotal: z.coerce.number().min(0),
  desconto: z.coerce.number().min(0).optional().nullable(),
  observacoes: z.string().optional().nullable(),
});

export const stepProdutosSchema = z.object({
  itens: z.array(nfeItemSchema).min(1, "Adicione pelo menos um produto"),
});

export type NfeItemFormData = z.infer<typeof nfeItemSchema>;
export type StepProdutosData = z.infer<typeof stepProdutosSchema>;

// ── Full draft form (all steps combined — used by the wizard) ──

export const nfeDraftFormSchema = z.object({
  // Step 1
  serie: z.coerce.number().int().min(1),
  tipoOperacao: z.enum(["ENTRADA", "SAIDA"]),
  finalidade: z.enum(["NORMAL", "COMPLEMENTAR", "AJUSTE", "DEVOLUCAO"]),
  destinoOperacao: z.enum(["INTERNA", "INTERESTADUAL", "EXTERIOR"]),
  naturezaOperacao: z.string().min(2),
  indPresenca: z.enum([
    "NAO_SE_APLICA",
    "PRESENCIAL",
    "INTERNET",
    "TELEMARKETING",
    "ENTREGA_DOMICILIO",
    "PRESENCIAL_FORA",
    "OUTROS",
  ]),
  intermediador: z.string().optional().nullable(),
  numeroPedido: z.string().optional().nullable(),
  dataEmissao: z.string().optional().nullable(),
  dataSaida: z.string().optional().nullable(),

  // Step 2
  customerId: z.string().optional().nullable(),
  destinatario: z.object({
    tipoPessoa: z.enum(["PF", "PJ", "EXTERIOR"]),
    cpfCnpj: z.string(),
    nome: z.string(),
    inscricaoEstadual: z.string().optional().nullable(),
    email: z.string().optional().nullable(),
    telefone: z.string().optional().nullable(),
    cep: z.string().optional().nullable(),
    logradouro: z.string().optional().nullable(),
    numero: z.string().optional().nullable(),
    complemento: z.string().optional().nullable(),
    bairro: z.string().optional().nullable(),
    municipio: z.string().optional().nullable(),
    codMunicipio: z.string().optional().nullable(),
    uf: z.string().optional().nullable(),
    codPais: z.string().optional().nullable(),
    pais: z.string().optional().nullable(),
  }),

  // Step 3
  itens: z.array(nfeItemSchema),
});

export type NfeDraftFormData = z.infer<typeof nfeDraftFormSchema>;
