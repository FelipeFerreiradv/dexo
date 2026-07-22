# Índice único de identidade do produto (`userId` + `skuNormalized`)

## Por que

A identidade real de um produto é o **SKU normalizado**, mas a única garantia no
banco é `@@unique([userId, sku])` — sobre o SKU **cru**. Consequência observada em
produção: `mk2-204` (criado pela Shopee) e `Mk2-204` (criado pelo Mercado Livre,
4 h depois) viraram **dois produtos** para a mesma peça, sem violar constraint
nenhuma. O invariante vivia só no código; qualquer brecha gravava duplicata em
silêncio e o `P2002` que a aplicação usa para se recuperar nunca disparava.

Com o índice abaixo, o banco passa a garantir o invariante e o caminho de
recuperação já existente (`isDuplicateSkuError` → rebusca por `skuNormalized` →
vincula) converte duplicata silenciosa em vínculo garantido.

## Ordem de execução (obrigatória)

O índice **falha** se ainda houver duplicata. Portanto:

### 1. Limpar o passivo

```bash
npx tsx scripts/dedupe-products-by-normalized-sku.ts          # dry-run: só relata
npx tsx scripts/dedupe-products-by-normalized-sku.ts --apply  # executa
```

O script **não funde nada às cegas**. Só funde quando os DOIS critérios valem:

1. **títulos parecidos** e
2. **plataformas disjuntas** — o cenário real da duplicação é "o mesmo item
   anunciado em marketplaces diferentes". Dois produtos na **mesma** plataforma
   com o mesmo SKU são reuso de etiqueta pelo vendedor, nunca duplicata.

O critério (2) não é teórico: sem ele, "Borracha Vedação **Porta Dianteira
Direita** Rav4" e "Borracha Vedação **Porta Mala** Rav4" (ambas no ML, SKU de
caixa `saco borracha rav4 2`) seriam fundidas por terem títulos parecidos — e
uma peça real seria perdida.

Quem não passa nos dois critérios é **preservado**: recebe SKU sintético
`VAAPT-DEDUP-<id>` e continua existindo. Quem passa tem os anúncios migrados
para o produto mais antigo; se o perdedor tiver histórico (pedido/financeiro,
relações `onDelete: Restrict`), a remoção falha de propósito e ele também só
recebe o SKU sintético — o histórico nunca é destruído.

Confira o relatório do dry-run antes de aplicar. No levantamento inicial: **8
grupos → 1 fusão real (`mk2-204`, Shopee + ML) e 7 preservados**.

### 2. Criar o índice

```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Product_userId_skuNormalized_key"
  ON "Product"("userId","skuNormalized")
  WHERE "skuNormalized" IS NOT NULL AND "skuNormalized" <> '';
```

`CONCURRENTLY` evita lock de escrita na tabela (não pode rodar dentro de
transação). O predicado deixa de fora produtos sem SKU — que devem mesmo poder
coexistir. Verificado antes de escrever: **0** produtos com `skuNormalized = ''`
e 8 com `NULL` (no Postgres, `NULL`s não conflitam entre si).

### Rollback

```sql
DROP INDEX CONCURRENTLY IF EXISTS "Product_userId_skuNormalized_key";
```

O código funciona com ou sem o índice — ele é a rede de segurança, não a única
proteção (o recheque por `skuNormalized` antes de inserir vive em
`listing-autodetect.usercase.ts`).

## Nota sobre o `schema.prisma`

O índice **não** é declarado no schema porque o Prisma não expressa índices
**parciais** (com `WHERE`). Declará-lo sem o predicado criaria um índice total,
que trata `''` como valor conflitante. Fica como SQL manual — mesma convenção já
usada no projeto para as demais migrações.

⚠️ Se algum dia for usado `prisma db push`, ele pode remover índices que não
estão no schema. Reaplique o SQL acima depois.
