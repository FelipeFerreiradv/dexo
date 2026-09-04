# Frete/medidas na NF-e — SQL manual

Convenção do repo: o módulo fiscal não usa `prisma/migrations/`; o SQL abaixo é
aplicado manualmente em cada banco **ANTES do deploy do código**.

⛔ **Nunca rodar `prisma db push` neste repo.** Existem 11 índices parciais fora
do `schema.prisma` (7 deles ÚNICOS, incluindo o da numeração de NF-e); o `db
push` os apagaria em falha silenciosa.

## Por que é seguro

Alargamento puro: **uma coluna nullable, sem default, sem índice, sem FK**.
Nenhuma linha existente é lida ou reescrita; as notas já emitidas ficam com
`valorFrete = NULL`, que é exatamente o comportamento de hoje (frete zero).
Nada pode violar a nova coluna.

## Por que é bloqueante mesmo com a feature flag desligada

A flag `NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED` controla o *comportamento*, não a
*leitura*. O Prisma nunca faz `SELECT *` — ele lista as colunas do model
explicitamente. As leituras que usam `include` (sem `select`) passam a pedir
`valorFrete` assim que o código novo subir e, sem a coluna no banco, **quebram**:

| Tela | Sem o ALTER |
|---|---|
| Rascunho / wizard de emissão | **quebra** |
| Detalhe da nota | **quebra** |
| Emissão da NF-e | **quebra** |
| Listagem de Notas Emitidas | sobrevive (usa `select` explícito, sem a coluna) |
| Exportação XLSX/PDF e cards de estatística | sobrevivem (idem) |

Ou seja: a maior parte do módulo cai, mas a listagem continua carregando — o que
pode enganar quem for validar o deploy só pela tela de Notas Emitidas.

Ordem obrigatória: **ALTER → `prisma generate` → deploy → (depois) ligar a flag.**

⚠️ Rodar em **todos** os bancos alvo (homologação e produção). O `.env` costuma
apontar para um só.

## APPLY

```sql
ALTER TABLE "NfeEmitida" ADD COLUMN IF NOT EXISTS "valorFrete" DECIMAL(15,2);
```

Precisão `(15,2)` acompanha os demais valores monetários do módulo fiscal
(`NfeItem.valorTotal`, `NfeItem.desconto`).

Depois, no repositório:

```bash
npx prisma generate
```

## Verificação

```sql
SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
FROM information_schema.columns
WHERE table_name = 'NfeEmitida' AND column_name = 'valorFrete';
```

Esperado: `numeric | 15 | 2 | YES`.

## ROLLBACK

Desligar a flag já devolve o comportamento anterior (XML byte-idêntico) sem
tocar no banco — é o rollback recomendado. Remover a coluna só faz sentido se o
código também voltar, e **apaga os valores de frete já informados**:

```sql
-- Só depois de reverter o código. Destrutivo.
ALTER TABLE "NfeEmitida" DROP COLUMN IF EXISTS "valorFrete";
```

## O que NÃO precisa de SQL

As **dimensões** (comprimento/largura/altura) e o **peso** não criam coluna: o
peso já vivia em `NfeEmitida.volumesJson` e as dimensões entram no mesmo JSON,
por volume, como `comprimentoCm` / `larguraCm` / `alturaCm` (centímetros
inteiros, mesmo padrão de `Product.heightCm/widthCm/lengthCm`). Volumes antigos
simplesmente não têm as chaves.
