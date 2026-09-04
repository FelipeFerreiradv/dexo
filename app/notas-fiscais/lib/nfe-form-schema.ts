import { z } from "zod";

// ── Step 1 — Informacoes Gerais ──

export const stepInfoGeralSchema = z.object({
  serie: z.coerce.number().int().min(1, "Serie e obrigatoria"),
  tipoOperacao: z.enum(["ENTRADA", "SAIDA"]),
  finalidade: z.enum(["NORMAL", "COMPLEMENTAR", "AJUSTE", "DEVOLUCAO"]),
  destinoOperacao: z.enum(["INTERNA", "INTERESTADUAL", "EXTERIOR"]),
  naturezaOperacao: z.string().min(2, "Natureza da operacao e obrigatoria"),
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
  // Limite do infCpl no leiaute 4.00 da NF-e
  informacoesComplementares: z
    .string()
    .max(5000, "Maximo de 5000 caracteres")
    .optional()
    .nullable(),
  dataEmissao: z.string().optional().nullable(),
  dataSaida: z.string().optional().nullable(),
});

export type StepInfoGeralData = z.infer<typeof stepInfoGeralSchema>;

// ── Step 2 — Destinatario ──

export const stepDestinatarioSchema = z.object({
  customerId: z.string().optional().nullable(),
  destinatario: z.object({
    tipoPessoa: z.enum(["PF", "PJ", "EXTERIOR"]),
    cpfCnpj: z.string().min(1, "CPF/CNPJ e obrigatorio"),
    nome: z.string().min(2, "Nome e obrigatorio"),
    inscricaoEstadual: z.string().optional().nullable(),
    indicadorIE: z.string().optional().nullable(),
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
  codigo: z.string().min(1, "Codigo e obrigatorio"),
  descricao: z.string().min(1, "Descricao e obrigatoria"),
  ncm: z.string().min(8, "NCM deve ter 8 digitos").max(8),
  cfop: z.string().min(4, "CFOP deve ter 4 digitos").max(4),
  cest: z.string().optional().nullable(),
  origem: z.coerce.number().int().min(0).max(8),
  unidade: z.string().min(1, "Unidade e obrigatoria"),
  quantidade: z.coerce.number().positive("Quantidade deve ser maior que 0"),
  valorUnitario: z.coerce.number().min(0, "Valor unitario invalido"),
  valorTotal: z.coerce.number().min(0),
  desconto: z.coerce.number().min(0).optional().nullable(),
  observacoes: z.string().optional().nullable(),
});

export const stepProdutosSchema = z.object({
  itens: z.array(nfeItemSchema).min(1, "Adicione pelo menos um produto"),
});

export type NfeItemFormData = z.infer<typeof nfeItemSchema>;
export type StepProdutosData = z.infer<typeof stepProdutosSchema>;

// ── Step 4 — Frete ──

export const transportadoraSchema = z.object({
  cpfCnpj: z.string().optional().nullable(),
  nome: z.string().optional().nullable(),
  inscricaoEstadual: z.string().optional().nullable(),
  endereco: z.string().optional().nullable(),
  municipio: z.string().optional().nullable(),
  uf: z.string().optional().nullable(),
});

export const stepFreteSchema = z.object({
  modalidadeFrete: z.enum([
    "CIF",
    "FOB",
    "TERCEIROS",
    "PROPRIO_REMETENTE",
    "PROPRIO_DESTINATARIO",
    "SEM_FRETE",
  ]),
  transportadora: transportadoraSchema,
  // Valor total do frete da nota. Opcional: nota sem frete continua valida.
  // Negativo e rejeitado; zero e aceito (frete gratis declarado).
  valorFrete: z.coerce
    .number()
    .min(0, "Valor do frete nao pode ser negativo")
    .optional()
    .nullable(),
});

export type StepFreteData = z.infer<typeof stepFreteSchema>;

// ── Step 5 — Volumes ──

export const volumeSchema = z.object({
  quantidade: z.coerce.number().int().min(0).optional().nullable(),
  especie: z.string().optional().nullable(),
  marca: z.string().optional().nullable(),
  numeracao: z.string().optional().nullable(),
  pesoLiquido: z.coerce.number().min(0).optional().nullable(),
  pesoBruto: z.coerce.number().min(0).optional().nullable(),
  // Dimensoes em centimetros inteiros — mesmo padrao de Product.heightCm/
  // widthCm/lengthCm. A NF-e 4.00 nao tem campo para elas: vao ao <infCpl>.
  comprimentoCm: z.coerce
    .number()
    .int("Comprimento deve ser um numero inteiro de cm")
    .min(0, "Comprimento invalido")
    .optional()
    .nullable(),
  larguraCm: z.coerce
    .number()
    .int("Largura deve ser um numero inteiro de cm")
    .min(0, "Largura invalida")
    .optional()
    .nullable(),
  alturaCm: z.coerce
    .number()
    .int("Altura deve ser um numero inteiro de cm")
    .min(0, "Altura invalida")
    .optional()
    .nullable(),
});

export const stepVolumesSchema = z.object({
  volumes: z.array(volumeSchema),
});

export type VolumeFormData = z.infer<typeof volumeSchema>;
export type StepVolumesData = z.infer<typeof stepVolumesSchema>;

// ── Step 6 — Duplicatas ──

export const duplicataSchema = z.object({
  numero: z.string().min(1, "Numero e obrigatorio"),
  vencimento: z.string().min(1, "Vencimento e obrigatorio"),
  valor: z.coerce.number().min(0.01, "Valor deve ser maior que zero"),
});

export const stepDuplicatasSchema = z.object({
  duplicatas: z.array(duplicataSchema),
});

export type DuplicataFormData = z.infer<typeof duplicataSchema>;
export type StepDuplicatasData = z.infer<typeof stepDuplicatasSchema>;

// ── Step 7 — Pagamentos ──

export const pagamentoSchema = z.object({
  meio: z.enum([
    "DINHEIRO",
    "CHEQUE",
    "CARTAO_CREDITO",
    "CARTAO_DEBITO",
    "CREDITO_LOJA",
    "VALE_ALIMENTACAO",
    "VALE_REFEICAO",
    "VALE_PRESENTE",
    "VALE_COMBUSTIVEL",
    "BOLETO",
    "DEPOSITO",
    "PIX",
    "TRANSFERENCIA",
    "SEM_PAGAMENTO",
    "OUTROS",
  ]),
  valor: z.coerce.number().min(0, "Valor invalido"),
});

export const stepPagamentosSchema = z.object({
  pagamentos: z.array(pagamentoSchema).min(1, "Adicione pelo menos uma forma de pagamento"),
});

export type PagamentoFormData = z.infer<typeof pagamentoSchema>;
export type StepPagamentosData = z.infer<typeof stepPagamentosSchema>;

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
  informacoesComplementares: z.string().max(5000).optional().nullable(),
  dataEmissao: z.string().optional().nullable(),
  dataSaida: z.string().optional().nullable(),

  // Step 2
  customerId: z.string().optional().nullable(),
  destinatario: z.object({
    tipoPessoa: z.enum(["PF", "PJ", "EXTERIOR"]),
    cpfCnpj: z.string(),
    nome: z.string(),
    inscricaoEstadual: z.string().optional().nullable(),
    indicadorIE: z.string().optional().nullable(),
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

  // Step 4
  modalidadeFrete: z.enum([
    "CIF",
    "FOB",
    "TERCEIROS",
    "PROPRIO_REMETENTE",
    "PROPRIO_DESTINATARIO",
    "SEM_FRETE",
  ]),
  transportadora: transportadoraSchema,
  // Valor total do frete da nota. Opcional: nota sem frete continua valida.
  // Negativo e rejeitado; zero e aceito (frete gratis declarado).
  valorFrete: z.coerce
    .number()
    .min(0, "Valor do frete nao pode ser negativo")
    .optional()
    .nullable(),

  // Step 5
  volumes: z.array(volumeSchema),

  // Step 6
  duplicatas: z.array(duplicataSchema),

  // Step 7
  pagamentos: z.array(pagamentoSchema),
});

export type NfeDraftFormData = z.infer<typeof nfeDraftFormSchema>;
