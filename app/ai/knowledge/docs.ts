// Manifesto da base de conhecimento do Bitz.
//
// Módulo PURO (sem `fs`, sem Prisma): é importado tanto pelo indexador quanto
// pelo retriever, que roda dentro do Fastify.
//
// `id` é a chave estável gravada em AiKnowledgeChunk.docId e citada em
// `sources[]`. Renomear um id é uma migração de conteúdo (o indexador poda o
// docId antigo e cria o novo), então trate-o como identidade, não como título.
//
// `page` amarra o documento à página do sistema de que ele fala — a mesma
// PageId de app/lib/page-access.ts. Hoje serve para o Bitz saber para onde
// mandar o usuário ("isso fica em Produtos"). Na Fase 5 é o gancho natural
// para não recuperar conhecimento de área que o colaborador não enxerga.

import type { PageId } from "../../lib/page-access";

export interface KnowledgeDoc {
  /** Identidade estável. Também é o nome do arquivo (.md) em `content/`. */
  id: string;
  /** Título humano, citado na resposta. */
  title: string;
  /** Página do sistema a que o documento se refere. */
  page: PageId;
}

export const KNOWLEDGE_DOCS: readonly KnowledgeDoc[] = [
  { id: "produtos", title: "Produtos e cadastro de peças", page: "produtos" },
  {
    id: "anuncios-mercado-livre",
    title: "Anúncios no Mercado Livre",
    page: "mercado-livre",
  },
  {
    id: "anuncios-shopee-magalu",
    title: "Anúncios na Shopee e no Magalu",
    page: "shopee",
  },
  { id: "pedidos", title: "Pedidos dos marketplaces", page: "pedidos" },
  {
    id: "estoque-e-localizacoes",
    title: "Estoque e localizações",
    page: "localizacoes",
  },
  {
    id: "etiquetas-e-scan",
    title: "Etiquetas e Receber por scanner",
    page: "scan-receber",
  },
  { id: "pdv-balcao", title: "PDV Balcão", page: "pdv" },
  { id: "financeiro", title: "Financeiro", page: "financeiro" },
  { id: "orcamentos", title: "Orçamentos e funil de vendas", page: "clientes" },
  { id: "clientes", title: "Clientes", page: "clientes" },
  { id: "sucatas", title: "Sucatas e desmembramento", page: "sucatas" },
  {
    id: "notas-fiscais",
    title: "Notas fiscais (NF-e e NFC-e)",
    page: "fiscal",
  },
  {
    id: "colaboradores-e-permissoes",
    title: "Colaboradores e permissões",
    page: "dashboard",
  },
] as const;

const BY_ID = new Map(KNOWLEDGE_DOCS.map((d) => [d.id, d]));

/** Documento pelo id. `undefined` para id desconhecido (chunk órfão no banco). */
export function findKnowledgeDoc(id: string): KnowledgeDoc | undefined {
  return BY_ID.get(id);
}

/** Título para citação. Cai no próprio id quando o documento não existe mais. */
export function knowledgeDocTitle(id: string): string {
  return BY_ID.get(id)?.title ?? id;
}
