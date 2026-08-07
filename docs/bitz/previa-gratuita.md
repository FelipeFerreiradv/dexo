# Bitz — prévia gratuita e tetos de custo

Como ligar o Bitz para todos os clientes por um período, com gasto previsível, e
como fechar depois deixando só quem assinou.

## 1. DDL (roda ANTES do deploy)

Duas colunas. As duas são `NULL` para todo usuário existente, então o estado
inicial é exatamente o de hoje — ninguém ganha nem perde acesso ao rodar isto.

```sql
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "aiEnabledAt"  TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "aiDailyLimit" INTEGER;
```

O SQL está versionado, um arquivo por coluna:

- `prisma/migrations/20260807100000_add_ai_enabled_at/migration.sql`
- `prisma/migrations/20260807130000_add_ai_daily_limit/migration.sql`

> ⚠️ `prisma/migrations/` está no `.gitignore` (linha 51), então estes arquivos
> foram adicionados com `git add -f` e a convenção da casa continua sendo
> **colar o DDL à mão no SQL editor**, não rodar `prisma migrate deploy`. Os dois
> são `IF NOT EXISTS` e podem ser reaplicados sem risco.
>
> ⚠️ **O DDL vem ANTES do deploy, sem exceção.** O Prisma não faz `SELECT *` —
> ele expande a lista nominal de colunas do schema. Código no ar sem estas duas
> colunas quebra **toda** leitura de `User`, login inclusive.

Depois rode `npx prisma generate` e faça o build.

## 2. As três camadas do acesso

O acesso efetivo é decidido em `app/ai/entitlement/ai-entitlement.service.ts`,
nesta ordem:

| Camada | Onde | Efeito |
|---|---|---|
| `NEXT_PUBLIC_AI_MODULE_ENABLED` | env (build) | Kill-switch. Desligado, **nada** passa. |
| `AI_FREE_PREVIEW` | env (runtime) | Prévia: vale para **todo mundo**. |
| `User.aiEnabledAt` | banco | Concessão individual (plano pago). |

**A prévia dá ACESSO, nunca COTA.** Quem entra por ela fica sem teto próprio e
cai no padrão da plataforma. É isso que torna "grátis para todos" um gasto
previsível, e há spec provando a assimetria.

## 3. Os tetos

| Variável | Padrão | Significado |
|---|---|---|
| `AI_MAX_DAILY_PER_TENANT` | **5** | Teto diário por cliente sem teto próprio. |
| `AI_MAX_DAILY_GLOBAL` | 5000 | Teto diário da plataforma inteira. |
| `User.aiDailyLimit` | `NULL` | Teto próprio do cliente; sobrescreve o padrão. |

A reserva é **pessimista**: o contador sobe *antes* de chamar o provedor
(`reserveAiTurn`), então o gasto real nunca ultrapassa o teto — no máximo fica
abaixo dele.

### Custo medido (07/08/2026)

| | |
|---|---|
| Por mensagem | ~R$ 0,0093 |
| Entrada / saída | 5.690 / 465 tokens |

Escolha o orçamento e derive o teto global:

| Teto na semana | `AI_MAX_DAILY_GLOBAL` |
|---|---|
| R$ 50 | 750 |
| R$ 100 | 1.500 |
| R$ 200 | 3.000 |

> ⚠️ **ESTA TABELA É ORDEM DE GRANDEZA, NÃO GARANTIA — e o motivo é estrutural.**
> O contador de cota conta **turnos**, não chamadas ao provedor. Um turno de
> conversa pura custa 1 chamada; um turno com duas rodadas de consulta custa até
> 4, e o payload de entrada ACUMULA a cada rodada (a janela de contexto de 8.000
> tokens vale só para a primeira). O pior caso auditado chega a ~74k tokens de
> entrada num único turno, contra os ~8,5k do caso simples.
>
> Ou seja: `AI_MAX_DAILY_GLOBAL=1500` garante **1.500 turnos por dia**, não
> R$ 100 na semana. A razão entre um e outro depende da mistura de perguntas dos
> clientes, que ainda não foi medida em produção.
>
> A amostra que gerou o custo por mensagem tinha **3 conversas**, e a
> contabilização de tokens só passou a somar todas as chamadas do turno nesta
> rodada — o número acima foi apurado quando ela ainda subnotificava.
> **Reapure depois de uma semana de uso real** e reajuste o teto pelo que a
> fatura disser, não por esta tabela.

## 4. Ligar a prévia

```bash
# .env do servidor
AI_FREE_PREVIEW=true
AI_MAX_DAILY_PER_TENANT=5
AI_MAX_DAILY_GLOBAL=1500
```

Reiniciar a API basta (as três são lidas por função, em runtime).
`NEXT_PUBLIC_AI_MODULE_ENABLED` é a exceção: **exige rebuild** do front.

**Pré-requisito:** faturamento habilitado no Gemini. No tier gratuito são 20
requisições e a prévia morre em `429` nos primeiros minutos.

## 5. Encerrar a prévia

```bash
AI_FREE_PREVIEW=false
```

Só isso. Quem tem `aiEnabledAt` continua, cada um com o teto que o Superadmin
deu; o resto perde o acesso. **Não existe `UPDATE` em massa para desfazer** — e
foi por isso que a prévia virou uma flag em vez de um `UPDATE "User" SET
"aiEnabledAt" = NOW()`: um update global apagaria a distinção entre "recebeu na
prévia" e "assinou o plano", e no dia de fechar seria preciso adivinhar quem era
quem.

## 6. O painel do Superadmin

`/colaboradores` → aba da equipe Dexo → botão **Bitz** na linha de cada
administrador.

- **Acesso liberado** — grava `aiEnabledAt`. É a lista de quem sobrevive ao fim
  da prévia. A data não é reescrita por clique repetido.
- **Teto diário** — grava `aiDailyLimit`. Vazio volta ao padrão da plataforma.
  Teto de sanidade de 2000 na rota: cada mensagem custa dinheiro e um dígito a
  mais viraria milhares de reais em um dia.

⚠️ **O controle só aparece na linha do ADMINISTRADOR.** Gate e quota usam sempre
o `dataOwnerId` (`parentUserId ?? id`): colaborador herda do pai e divide a mesma
cota. Um controle na linha do colaborador gravaria coluna que nunca é lida.

Salvar limpa o cache de entitlement (60 s) — senão o Superadmin liberaria o
acesso e o cliente seguiria barrado por até um minuto, olhando a tela naquela
hora.
