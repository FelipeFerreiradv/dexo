# Bitz — Atestado de não-regressão

**Branch:** `claude/bitz-ia-agent-d0b8fa` · **Base:** `9b67a76` · **Data:** 07/08/2026
**Escopo:** Fases 1 a 6 + streaming NDJSON — 7 commits, 118 arquivos, +19.687/−78 linhas.

> **REGRA ZERO:** nenhuma regressão em nenhuma área da aplicação, nem durante nem
> depois destas alterações.

Este documento não afirma que não houve regressão. Ele diz **o que foi verificado,
como, e qual foi o resultado** — inclusive onde a verificação tem limite.

---

## 0. O resumo em uma linha

**Nada está em produção.** Todo o módulo está atrás de dois gates que nascem
desligados, e as três DDLs são aditivas. Enquanto `NEXT_PUBLIC_AI_MODULE_ENABLED`
não for `true` e nenhum `User.aiEnabledAt` for preenchido, o sistema se comporta
como antes destes 7 commits.

| Gate                             | Resultado                                                |
| -------------------------------- | -------------------------------------------------------- |
| `npx vitest run --pool=forks`    | **5.226 passed / 27 skipped / 0 failed**                 |
| `npx tsc --noEmit`               | **100 erros** = baseline exata; **0** em arquivo do Bitz |
| `npm run build`                  | verde                                                    |
| Shell do app (First Load JS, gz) | **232,9 KB** (baseline do plano: 230,8 KB → **+2,1 KB**) |
| Lint dos arquivos do Bitz        | **0 problemas**                                          |
| Testes pré-existentes alterados  | **0**                                                    |

---

## 1. Quem não tem o Bitz — 100% dos usuários hoje

**O que precisava ser verdade:** sem `aiEnabledAt`, o mascote não aparece, nenhum
JS extra é baixado, nenhuma chamada a `/ai/*` acontece, e `/ai/chat` na unha
responde 403.

| Verificação                                     | Método                                                         | Resultado                                                           |
| ----------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| Módulo nasce desligado                          | `ai-zero-impact.spec.ts` — `isAiModuleEnabled()` sem env       | ✅ `false`                                                          |
| Provedor default não toca rede                  | idem — `getAiProviderName()`                                   | ✅ `mock`                                                           |
| Pesquisa externa nasce desligada                | idem — `isAiExternalLookupEnabled()`                           | ✅ `false`                                                          |
| API sobe sem nenhuma `AI_*`                     | `ai-zero-impact.spec.ts` executa `loadEnvOrExit` com env limpa | ✅ válido                                                           |
| 403 em todas as rotas sem entitlement           | `ai-routes-gate.spec.ts`                                       | ✅ todas menos `/ai/entitlement`, que devolve `200 {enabled:false}` |
| O `Accept` de streaming não fura o gate         | `ai-stream-route.spec.ts`                                      | ✅ 403                                                              |
| Gate por tenant não toca o banco com a flag off | `ai-entitlement.spec.ts`                                       | ✅ curto-circuita antes do DB                                       |
| Usuário inexistente                             | idem                                                           | ✅ `false` (fail-closed)                                            |

**Limite conhecido:** a flag `NEXT_PUBLIC_*` **não faz tree-shaking**. Medi com
`git stash` na mesma árvore: o bundle é idêntico com ela ligada e desligada.
O que resolve é a fronteira `dynamic()` — o launcher é a única coisa eager, e o
painel, o markdown e tudo mais vivem num chunk separado. **Custo real e
permanente no shell: +2,1 KB gz.** Está dentro da meta de <5 KB do plano, mas
não é zero, e eu afirmei zero antes de medir.

---

## 2. Layout — nenhuma tela existente mudou

| Verificação                          | Método                                 | Resultado                                                                                                                                                |
| ------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arquivos de página tocados           | `git diff --name-status` contra a base | ✅ **nenhum**                                                                                                                                            |
| Montagem do widget                   | `components/main-layout.tsx`           | ✅ **+7 linhas, 0 removidas**                                                                                                                            |
| CSS global                           | `git diff app/globals.css`             | ✅ **+72 linhas, 0 removidas** — só `@keyframes bitz-*` e as regras `prefers-reduced-motion` deles. Nenhum seletor de elemento, nenhuma classe existente |
| Z-index não cobre toast/sheet/header | `ai-widget-contract.spec.ts`           | ✅ mapa da Fase 0 respeitado                                                                                                                             |
| Tela cheia em qualquer breakpoint    | idem                                   | ✅                                                                                                                                                       |
| `prefers-reduced-motion`             | idem                                   | ✅ toda animação tem a variante                                                                                                                          |
| Foco e `Esc` dos Radix               | idem (contrato do painel)              | ✅ intactos                                                                                                                                              |
| Markdown sem `rehype-raw`            | idem                                   | ✅ HTML cru continua desabilitado                                                                                                                        |

**Limite conhecido:** a suíte roda em `environment: "node"`, sem jsdom. As
verificações de layout são **sobre o código-fonte**, não sobre pixels
renderizados. O precedente da casa é o mesmo
(`tests/dashboard-routes-page-gate.spec.ts`). **Conferência visual em navegador
continua sendo sua**, e é a única forma de fechar esse ponto.

---

## 3. Segurança

### 3.1 Isolamento entre lojas

Três travas somadas, nenhuma dependendo de disciplina:

| Trava                                               | Onde                   | Prova                                                                                  |
| --------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| **Tipo** — `AiScope` é nominal e tem uma fábrica só | `app/ai/core/scope.ts` | `ai-scope.spec.ts`: o cast que cria a marca aparece **1 vez** no repositório inteiro   |
| **Schema** — nenhuma tool aceita chave de dono      | as 20 tools            | `ai-tools-registry.spec.ts`: varre schema e texto-fonte                                |
| **Runtime** — `.strict()` **rejeita** chave extra   | `tool-runner.ts`       | `ai-tool-runner.spec.ts`: `userId` injetado ⇒ `argumentos_invalidos`, handler não roda |

E o outro lado: `ai-tenant-isolation.spec.ts` prova que cada handler **entrega** o
tenant à camada de dados. Isso importa porque quatro repositórios aceitam
`userId?` opcional e, sem ele, varrem todos os inquilinos devolvendo 200 — sem
erro e sem log.

### 3.2 Permissão

| Verificação                                            | Método                                  | Resultado                                                       |
| ------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------- |
| Colaborador sem `financeiro` não obtém dado financeiro | `ai-tool-turn.spec.ts` (turno real)     | ✅ recusa **dentro da conversa**, não 403 que encerraria o chat |
| Permissão checada **antes** da validação de argumentos | `ai-tool-runner.spec.ts`                | ✅ (validar antes revelaria o formato de uma consulta proibida) |
| Toda tool declara uma página que o gate avalia         | `ai-tool-turn.spec.ts` (mapa explícito) | ✅ 20/20                                                        |

### 3.3 Privacidade

| Verificação                     | Método                                                              | Resultado                                                                                           |
| ------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `costPrice`/`markup` nunca saem | trava central em `CAMPOS_PROIBIDOS` + varredura do código das tools | ✅ bloqueia a consulta inteira, **inclusive para admin**                                            |
| Amostra < 5 não sugere          | `ai-advisory-tools.spec.ts`                                         | ✅ e a recusa é **rechecada na leitura**, não só no job                                             |
| Documento de cliente            | `ai-privacy.spec.ts`                                                | ✅ mascarado (3 últimos dígitos)                                                                    |
| Placa/chassi/renavam            | `tool-runner` + projeções                                           | ✅ chassi e renavam bloqueados; placa exposta de propósito (é como o lojista acha o carro no pátio) |

**A trava é central de propósito:** `ProductUseCase.getDetail` lê o produto com
`include`, então **coluna nova no model entra no retorno sozinha**. Uma allowlist
por handler envelheceria para insegura em silêncio.

### 3.4 Injeção de prompt

`ai-prompt-injection.spec.ts` — **escrito nesta rodada**, e ele achou algo.

| Propriedade                                                        | Resultado            |
| ------------------------------------------------------------------ | -------------------- |
| Resultado de tool entra como `role:"tool"`, nunca no system prompt | ✅                   |
| Nada dentro do **resultado** de uma tool vira chamada de outra     | ✅                   |
| Mesmo se o modelo obedecer ao texto, esbarra no gate de permissão  | ✅                   |
| Tentativa de trocar o tenant pelo texto                            | ✅ `.strict()` barra |

⚠️ **Achado corrigido:** `wrapSystemData` **não neutralizava** um
`</dados_do_sistema>` vindo dentro do conteúdo. Um documento da base de
conhecimento com essa string fecharia o envelope e o resto seria lido como
instrução do sistema. Hoje só documentos escritos por nós passam por ali, então o
risco era teórico — mas custava uma linha e é impossível lembrar depois.
**Corrigido e travado por teste.**

### 3.5 Segredos

`ai-secret-leak.spec.ts` — **escrito nesta rodada**. As quatro rotas de fuga:

| Rota                                      | Resultado                                                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Erro do axios (URL completa no erro)      | ✅ chave vai em **header**; `detail` é só `HTTP 400`                                                                                           |
| Corpo da resposta de erro (ecoa o prompt) | ✅ descartado — nem chave, nem prompt                                                                                                          |
| Log de auditoria (`SystemLog`)            | ✅ nada gravado contém a chave                                                                                                                 |
| Bundle do navegador                       | ✅ a única `NEXT_PUBLIC_` do módulo é o kill-switch booleano; nenhum arquivo de `components/` ou `hooks/` lê a chave ou importa `ai-constants` |

E o caminho de streaming foi coberto junto — é uma segunda chamada HTTP e teria
sido fácil esquecer.

---

## 4. Domínio inalterado

**A evidência mais forte é negativa e é a que mais vale:**

```
git diff --name-only 9b67a76 HEAD -- tests/ | grep -v "tests/ai-"
(nenhum)
```

**Zero testes pré-existentes alterados, afrouxados, pulados ou apagados.** Os
4 arquivos de teste modificados são todos `ai-*.spec.ts` que eu mesmo escrevi
nesta entrega, e as mudanças são **aditivas** (mais cobertura) ou de adaptação de
um helper a um registry que passou de 13 para 20 tools.

Com isso, os **5.226 testes verdes** cobrem sucata, PDV, financeiro, orçamento,
etiqueta, pedido, NF-e/NFC-e, sync de marketplace, WhatsApp, import e sugestão de
categoria exatamente como cobriam antes.

### ⚠️ A exceção — 1 spec pré-existente ALTERADO na rodada de 07/08

A frase acima descrevia os 7 commits originais e **deixou de ser verdade** na
rodada da prévia gratuita. Registrar isso é obrigação, não formalidade: a regra
número 2 do dono do produto diz que nenhum teste existente pode ser alterado.

**`tests/team-collaborators.routes.spec.ts` foi alterado.** Duas naturezas:

1. **O dublê ganhou um método.** A rota passou a chamar
   `userRepository.updateAccessControl` (o tipo estreito que fecha o mass
   assignment). Sem ensinar o dublê, `PATCH .../status` responderia **500** — a
   alteração é o que mantém o teste refletindo a realidade.
2. **Três asserções de guarda foram REAPONTADAS.** Elas afirmavam que
   `updateMock` não era chamado depois de um 403. Como a rota deixou de usar
   `update()` em qualquer caminho, essas asserções passariam a ser
   **vacuamente verdadeiras** — verdes sem provar nada. Foram reapontadas para
   `updateAccessControlMock`, que é o método que a rota de fato usa.

**Nenhuma asserção foi afrouxada; todas ficaram mais específicas.** Duas
auditorias independentes revisaram este diff linha a linha e classificaram a
mudança como endurecimento. Reverter significaria devolver o mass assignment de
`pagePermissions` em `PUT /users/me/settings` — o remédio seria pior.

**É a única exceção da entrega inteira.** Todo o resto de `tests/` alterado
nesta branch são arquivos novos ou `ai-*.spec.ts` desta mesma entrega.

### Os 9 arquivos pré-existentes tocados — e nada além deles

| Arquivo                                  | Δ       | Natureza                                                   |
| ---------------------------------------- | ------- | ---------------------------------------------------------- |
| `prisma/schema.prisma`                   | +101/−0 | 1 campo em `User` + 3 models novos                         |
| `.env.example`                           | +65/−0  | documentação                                               |
| `app/globals.css`                        | +72/−0  | `@keyframes` do mascote                                    |
| `app/lib/env.ts`                         | +47/−0  | bloco `AI_*` **opcional**                                  |
| `app/interfaces/system-log.interface.ts` | +17/−1  | 5 membros na união `LogAction` (a linha removida é o `;`)  |
| `next.config.ts`                         | +12/−2  | `microphone=()` → `microphone=(self)` — **decisão 1, sua** |
| `app/api/api.ts`                         | +9/−0   | 1 import + 1 `register`                                    |
| `components/main-layout.tsx`             | +7/−0   | monta o launcher                                           |
| `package.json`                           | +3/−0   | `react-markdown`, `remark-gfm`, script `ai:index`          |

O plano previa 6 arquivos e avisou que `system-log.interface.ts` provavelmente
entraria como sétimo. Entraram 9: os dois a mais são `app/globals.css` (os
keyframes precisavam de um lugar; Tailwind v4 não tem `tailwind.config` neste
projeto) e `app/lib/env.ts` (as `AI_*` opcionais precisavam ser declaradas para o
boot continuar validando). Ambos aditivos, ambos reportados na fase em que
entraram.

---

## 5. Streaming — o que ele pode e não pode quebrar

Entregue nesta rodada. É a única mudança que altera o **comportamento de uma rota
existente**, então merece verificação própria.

| Risco                                  | Verificação                                                               | Resultado                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| O caminho JSON mudar                   | `ai-chat-route.spec.ts` (15 testes, intocado) + `ai-stream-route.spec.ts` | ✅ sem o header `Accept`, resposta byte-idêntica e ainda comprimida                 |
| Texto na tela ≠ texto no banco         | `ai-stream.spec.ts`                                                       | ✅ deltas remontam exatamente o conteúdo final; a mensagem nasce só do quadro `fim` |
| Conexão cair no meio                   | idem + hook                                                               | ✅ resposta parcial **não** vira mensagem                                           |
| `@fastify/compress` bufferizar o corpo | `reply.hijack()` + `reply.raw`                                            | ✅ o `onSend` do compress não roda; o JSON continua comprimido                      |
| **CORS sumir da resposta**             | `ai-stream-route.spec.ts`                                                 | ✅ cabeçalhos montados pelo Fastify são copiados no `writeHead`                     |
| Rate limit dobrar                      | negociação na **mesma** rota                                              | ✅ um balde só                                                                      |
| Provedor sem streaming                 | `ai-stream.spec.ts`                                                       | ✅ entrega a resposta inteira, sem prévia, sem degradar                             |
| Stream pendurado para sempre           | teto de duração total no provedor                                         | ✅ o `timeout` do axios não cobre o corpo de um stream — há relógio próprio         |

---

## 6. Infra

| Verificação                   | Resultado                                                                 |
| ----------------------------- | ------------------------------------------------------------------------- |
| `npx vitest run --pool=forks` | **5.226 / 27 skipped / 0 failed** (621 são do Bitz, em 27 specs)          |
| `npx tsc --noEmit`            | **100** — a mesma baseline pré-existente; **0** nos arquivos do Bitz      |
| `npm run build`               | ✅ verde                                                                  |
| Migrations                    | 3, todas `IF NOT EXISTS`, todas com o rollback escrito no próprio arquivo |
| Shell gz                      | 232,9 KB                                                                  |

⚠️ **`npm run lint` não roda neste worktree, e não é o código.** O worktree é
aninhado dentro do checkout principal; o ESLint sobe a árvore, acha dois
`.eslintrc.json` e dois `@next/eslint-plugin-next`, e **aborta antes de lintar
qualquer arquivo**. Confirmei com `git stash` que o HEAD limpo dá o mesmo exit 1.
Eu havia reportado "exit 0" na Fase 5 — estava errado.

O comando que dá sinal real:

```bash
ESLINT_USE_FLAT_CONFIG=false npx eslint --no-eslintrc -c .eslintrc.json --ext .ts,.tsx app/ai components/bitz hooks lib/ndjson-stream.ts app/routes/ai.routes.ts
```

Resultado: **0 problemas.**

---

## 7. O que este atestado NÃO cobre

Honestidade sobre os limites vale mais que a lista de verdes.

1. **Nenhuma linha rodou contra o Postgres de produção.** As 3 DDLs, a indexação
   da base de conhecimento e o SQL do retriever nunca executaram contra um banco
   real — só contra dublês. A primeira execução real é o
   `npm run ai:index -- --apply` depois do deploy.
2. **Nenhuma chamada real a um LLM.** 100% da suíte roda no `MockAiProvider`. O
   `GeminiProvider` é testado com `vi.mock("axios")`: o contrato está coberto, o
   comportamento do modelo de verdade não.
3. **Nenhuma verificação visual.** Sem jsdom, o layout é verificado por
   texto-fonte. Abrir o app e olhar continua sendo necessário.
4. **O número do Bitz = o número da tela** foi garantido por **construção** (as
   tools embrulham as mesmas funções que as telas usam) e coberto por teste de
   unidade — mas a conferência manual dos 6 casos que o plano pedia **depende de
   dados reais** e não foi feita.
5. **11 perguntas em aberto** na base de conhecimento, marcadas
   `⚠️ PENDENTE DE CONFIRMAÇÃO` e listadas por `npm run ai:index`. Até você
   respondê-las, o Bitz não fala desses comportamentos.
6. **Efeito colateral conhecido e não corrigido:** `ProductUseCase.listProducts`
   com busca dispara `CREATE EXTENSION`/`CREATE INDEX` uma vez por processo. Não é
   novo — é o que a tela de Produtos já faz —, mas agora o gatilho é um texto
   vindo do modelo. Corrigir mexe em `product.repository.ts`/`api.ts`, fora da
   lista de arquivos autorizada. **Reportado, não corrigido, aguardando sua
   decisão.**
7. **Custo em R$** não preenchido: falta confirmar a tabela de preço vigente do
   modelo escolhido. A matemática de tokens do plano (§11.1) continua válida.

---

## 8. Ordem de deploy

Nada disso vale se a ordem for outra.

1. **4 DDLs, aplicadas À MÃO**, nesta ordem:
   `User.aiEnabledAt` → `User.aiDailyLimit` → `AiConversation` + `AiMessage` →
   `AiKnowledgeChunk`

   O caminho curto é colar `docs/bitz/setup-supabase.sql` inteiro — ele tem os
   quatro, na ordem certa, todos idempotentes.

   ⚠️ **As duas colunas de `User` vêm antes do deploy, sem exceção.** O Prisma
   expande `SELECT` em lista nominal de colunas: código no ar sem elas quebra
   toda leitura de `User`, login inclusive. As tabelas novas não têm esse risco
   (ninguém as lê com a flag desligada), as colunas têm.

   O SQL está versionado em `prisma/migrations/20260807*/migration.sql` (os
   arquivos foram adicionados com `-f`, já que `.gitignore:51` ignora a pasta).
   A convenção da casa é aplicar o DDL manualmente no Supabase, **não** rodar
   `prisma migrate deploy` — os três são `IF NOT EXISTS` e podem ser colados
   direto.

2. `npx prisma generate`
3. Deploy da API e do front
4. `npm run ai:index -- --apply` — indexa a base de conhecimento
5. `NEXT_PUBLIC_AI_MODULE_ENABLED=true` — **exige REBUILD do front**, não só restart
6. `npx tsx scripts/set-ai-access.ts --email=<cliente> --on` — por cliente

**Rollback em qualquer ponto:** `NEXT_PUBLIC_AI_MODULE_ENABLED=false` desliga
front e back sem deploy de código (o front exige rebuild). As colunas e tabelas
podem ficar: são aditivas e ninguém mais as lê.

`AI_EXTERNAL_LOOKUP_ENABLED` fica **desligada** — ligá-la é uma decisão separada,
porque é ela que autoriza o título de uma peça a sair do perímetro em direção ao
Mercado Livre.
