# Bitz — auditoria de performance, egress e regressão

**Branch:** `claude/bitz-ia-agent-d0b8fa` · **Base:** `9b67a76` · **Data:** 07/08/2026
**Método:** 6 dimensões independentes sobre a branch inteira (commitado + árvore de
trabalho), 34 achados brutos (~22 distintos), verificação adversarial explícita nos
acionáveis. 15 agentes, ~2M tokens.

> **Critério:** só virou código o que era real **e** de risco de regressão
> nenhum-ou-baixo. Tudo que era real porém arriscado está aqui, documentado e
> **não implementado** — que é exatamente o que foi pedido.

---

## 0. Placar

| | |
| --- | --- |
| Achados brutos | 34 (~22 distintos) |
| Submetidos ao cético | 8 |
| Derrubados pelo cético | **2** |
| Confirmados e **corrigidos** | **2** |
| Confirmados e **documentados** (correção mais arriscada que o defeito) | **13** |

---

## 1. Corrigido nesta rodada

### 1.1 A coluna `User.aiDailyLimit` estava fora do caminho de deploy

**Severidade: alta. Consequência: indisponibilidade total da plataforma.**

`prisma/schema.prisma` declarava a coluna; `docs/bitz/setup-supabase.sql` (que se
anuncia como "TODO o DDL, num arquivo só") não a criava, e não havia migração
versionada. O Prisma expande `SELECT` em lista **nominal** de colunas:
`findByEmail` (o `authorize` do NextAuth) e `findById` (o middleware de auth) leem
`User` com `include`, sem `select`. Sem o `ALTER`, **ninguém loga** — não é
degradação de um módulo desligado, é o Dexo inteiro fora do ar.

**Corrigido:** `ALTER TABLE` no SQL de setup (mais os blocos de conferência e de
rollback), migração versionada própria, ordem de deploy corrigida no atestado.

**E a correção de verdade é o teste.** Nada verificava se o SQL de deploy cobre as
colunas do schema. Agora existe verificação que **deriva a lista do próprio
schema** — a próxima coluna nasce coberta.

⚠️ **O teste lê o índice do git, não o disco.** `prisma/migrations/` está no
`.gitignore` (linha 51) e cada migração entra com `git add -f`. A primeira versão
deste teste usava `readdirSync` e teria dado **verde falso**: passava nesta
máquina e falharia em qualquer clone limpo. Foi a auditoria que pegou.

### 1.2 Reserva e devolução de cota resolviam o dia UTC separadamente

**Severidade: baixa. Consequência: cota liberada de graça na virada do dia.**

`runTurn` passava `input.now` para `reserveAiTurn` e `refundAiTurn`, e produção
nunca manda `now` — as rotas montam o input sem ele. Com `undefined`,
`utcDayKey(now = new Date())` era reavaliado dentro de cada uma. Um turno que
começa às 23:59:5x UTC (20:59 em São Paulo) e falha segundos depois reservava no
dia velho e **devolvia no dia novo**: decrementava um contador onde nunca reservou
e liberava um slot do dia seguinte.

**Corrigido:** o instante é capturado uma vez no topo de `runTurn` e usado nos dois
pontos. Dentro do mesmo dia o comportamento é idêntico.

**Prova:** `tests/ai-quota-day-boundary.spec.ts` — três testes com relógio falso que
cruzam a meia-noite no meio do turno. Verificado por **controle negativo**:
revertendo a correção, o teste da virada falha e os outros dois seguem verdes.

**Ressalva honesta:** a correção também reancora a **reserva**, do instante em que
ela acontece para o instante em que o turno começa — uma janela de menos de um
segundo. Nenhuma das duas versões infla teto (cada turno cai em exatamente uma
chave de dia); fixar o turno inteiro num dia só é a semântica mais defensável.

---

## 2. Real, verificado, e NÃO corrigido

Para cada item: por que mexer é pior que conviver.

### 2.1 `/public/bitz/*` sai com `Cache-Control: public, max-age=0`

O mascote do launcher (7,3 KB) revalida a cada carregamento de página completo.
**Por que não corrigir:** os nomes **não** são content-hashed, não há CDN para
purgar, e esta própria branch substituiu assets **no mesmo nome** três vezes — a
animação de entrada mudou hoje. Um `max-age` longo serviria arquivo velho por
semanas, sem botão de desfazer. A correção certa é hashear o nome do asset, que é
trabalho de build, não uma linha de config.

### 2.2 Sem error boundary: um chunk que falha derruba a PÁGINA

`BitzRoot` é montado no shell de todas as telas autenticadas e usa `dynamic()`.
Uma rejeição do `import()` — o caso clássico é a aba aberta durante um deploy,
quando o hash do chunk antigo some — lança **durante o render** e leva a árvore
do React junto. **O repositório não tem error boundary nenhum.**

**Mitigação já existente:** o caminho da animação de entrada usa `import()`
manual com `.catch`, justamente por isso. O que continua exposto é o chunk do
widget.

**Por que não corrigir agora:** introduzir o primeiro error boundary do
repositório é decisão de arquitetura, não patch de auditoria. **Recomendação
registrada:** vale como tarefa própria, com teste.

### 2.3 A janela de contexto vale só para a PRIMEIRA chamada do turno

O orçamento de 8.000 tokens de entrada é aplicado uma vez; os resultados de tool
entram sem novo teto. Pior caso auditado: ~74k tokens de entrada num único turno,
contra ~8,5k do caso simples. **Por que não corrigir:** reaplicar a janela a cada
rodada muda o que o modelo enxerga — é mudança de comportamento do agente.

### 2.4 A cota conta TURNOS, não chamadas ao provedor

`AI_MAX_DAILY_GLOBAL=1500` garante **1.500 turnos/dia**, não R$ 100/semana. A
razão entre um e outro depende da mistura de perguntas. **Por que não corrigir:**
reservar por chamada ou por tokens muda regra de negócio. **Ação tomada:**
`docs/bitz/previa-gratuita.md` foi corrigido para não prometer o que não entrega.

### 2.5 A guarda do refund depende de o PROVEDOR reportar uso

O sinal de "nada foi cobrado" é "ninguém me disse quanto custou" — coisas
diferentes. Um provedor que pare de mandar `usageMetadata` faria todo turno que
termina em erro devolver cota já consumida. **Por que não corrigir:** o Gemini
reporta hoje; trocar a condição exigiria reescrever asserção de spec existente.

### 2.6 A cota é reservada DEPOIS de persistir a conversa e a pergunta

Um usuário sem cota continua escrevendo ~5 linhas por requisição. **Por que não
corrigir:** antecipar a checagem quebra o contrato — `degrade()` precisa do
`conversationId`, e o front depende do quadro `conversa` chegar primeiro.

### 2.7 O RAG é re-injetado a cada turno de dúvida, sem cache nem dedupe

Numa conversa de 5 turnos sobre o mesmo assunto, os mesmos pedaços entram no
system prompt 5 vezes. **Por que não corrigir:** enviar só o que ainda não foi
enviado muda o que o modelo enxerga nos turnos seguintes.

### 2.8 As 6 tools consultivas repetem a MESMA busca no mesmo turno

Uma pergunta que dispare 3-4 tools consultivas executa 3-4 buscas
byte-idênticas — ~12 dos ~29 statements de um turno consultivo. **Por que não
corrigir:** o cético confirmou o mecanismo e reprovou a correção — quebra testes
existentes, e a casa exige um *guard de deriva de chave* junto de qualquer cache
novo (regra da auditoria anterior de egress).

### 2.9 Projeção larga no caminho quente: 20 linhas completas de `Product` por chamada

40-100 KB por tool consultiva; com 3-4 tools, **150-400 KB por mensagem** onde
~30 KB bastariam. **É o maior número de egress do módulo.** **Por que não
corrigir:** um `select` próprio seria uma **segunda** busca, divergindo da tela de
Produtos — e "o número do Bitz é o número da tela" é critério declarado da fase.

### 2.10 `buscar_localizacao` lê a árvore inteira de localizações para devolver ≤20

**Por que não corrigir:** `findAllFlat` é compartilhada com `/locations/select` e
com o formulário de produto. Podá-la mexe em telas fora do escopo.

### 2.11 `relatorio_estoque` dispara 9 agregações em `Product` por mensagem

Sete varreduras agregadas da mesma tabela, mais um `groupBy` sem teto. **Por que
não corrigir:** as cinco contagens de faixa caberiam num `$queryRaw` com
`COUNT(*) FILTER`, mas isso é consulta nova — e o critério da fase é que o número
do Bitz seja idêntico ao da tela, por construção.

### 2.12 O streaming trafega a resposta duas vezes, sem compressão

~6-7× os bytes do caminho JSON por mensagem. **Por que não corrigir: é
load-bearing.** O quadro `fim` ser a resposta canônica é o que impede o texto na
tela de divergir do texto no banco quando a conexão cai no meio. Comprimir
anularia o streaming.

### 2.13 `Permissions-Policy` global foi afrouxado (`microphone`)

De allowlist vazia para a própria origem, em todas as páginas do ERP. É a única
mudança da branch fora do namespace do Bitz que **não** é aditiva, e o rollback
pela flag **não** a desfaz — voltar exige deploy. Foi decisão de produto
explícita, registrada aqui para não sumir.

### 2.14 Outros, de menor porte

- **`PATCH` grava um `UPDATE` vazio antes do `UPDATE` real** em duas rotas de
  admin, quando o corpo traz só permissões ou só os campos do Bitz. Real (com
  `@updatedAt` o Prisma emite a escrita), mas o cético reprovou a correção: usar
  o `target` já carregado como valor de resposta muda o shape devolvido.
- **`PUT /users/:id/settings` descarta `isActive`/`pagePermissions` em silêncio,
  com 200.** Nenhum consumidor real quebra hoje; é buraco de contrato. Responder
  400 mudaria o contrato HTTP de duas rotas em produção.
- **Concessão do Bitz gravada em linha de COLABORADOR** via curl: grava coluna
  que o gate nunca lê (cota e acesso são sempre do `dataOwnerId`). A UI só
  oferece o controle na linha do administrador.
- **A trava central de campo proibido falha ABERTA** quando estoura profundidade
  ou orçamento de nós na varredura. Hoje inalcançável, mas a direção da falha
  está errada para uma trava de privacidade.
- **430 KB de assets do mascote nunca são requisitados** (`webp512` não tem um
  único consumidor). Egress zero; é peso de repositório e de deploy.

---

## 3. Derrubados pelo cético — não reabrir

- **"`diagnostico_operacional` não tem índice de suporte."** Falso. O
  `@@unique([marketplaceAccountId, externalListingId])` e o
  `@@index([marketplaceAccountId, metricsUpdatedAt])` têm a coluna do tenant como
  líder; o filtro vira semi-join com caminho de índice. **Um índice novo em
  produção teria sido criado à toa.**
- **"O arquivo da animação de entrada não está versionado e o spec vai quebrar."**
  Falso. O arquivo não é ignorado por nenhuma regra; estava apenas untracked,
  como todo arquivo novo antes do commit.

---

## 4. Egress — veredito

**A branch AUMENTA o tráfego externo. O aumento é contido, condicionado à flag, e
nenhuma rota, consulta ou cache pré-existente foi reescrito para pior.** Não há
redução em lugar nenhum: a branch não otimiza o que já existia, ela acrescenta com
disciplina.

### Por página, para quem NUNCA abre o Bitz

| Cenário | Requisições/página | Bytes/página |
| --- | --- | --- |
| Flag desligada (**estado de hoje**) | **0** | **0** |
| Flag ON, tenant sem plano | 1 (`GET /ai/entitlement`) | ~0,5 KB |
| Flag ON, com plano ou prévia | 2 | ~7,3 KB na 1ª página, depois revalidação 304 |

Com a flag desligada, `bitz-root.tsx` retorna `null` **antes** de renderizar o
loadable — nenhum dos três chunks é buscado. O que sobra é custo **por build**:
+2,1 KB gz no shell e ~2,3 KB de `@keyframes`.

### Para quem abre e usa

- **Primeira vez na vida, por navegador:** ~1,28 MB de assets, dos quais **93% são
  as duas animações** (1.045 KB + 235 KB).
- **Da segunda abertura em diante: 0 byte de animação.** O marco em `localStorage`
  é checado **antes** do `import()`, e falha **fechado**.
- **Por mensagem: exatamente 1 POST.** Zero polling, zero `setInterval`, zero
  `EventSource`, zero WebSocket, zero reconexão.

### Consultas ao Postgres por turno

| Turno | Statements |
| --- | --- |
| Piso (pergunta social, sem RAG, sem tool) | **7** + 1 `SystemLog` |
| Caches frios (auth + entitlement) | +2 |
| Com RAG | +1 `$queryRaw` |
| Duas tools de leitura | ~19 |
| Quatro tools consultivas | ~29, dos quais ~12 são a mesma busca repetida (2.8) |
| Teto do desenho | 2 rodadas × 8 tools = até 16 execuções |

### O que NÃO piorou

- `findChildrenPublic` (a lista mais chamada da tela de Colaboradores) **não
  ganhou coluna nenhuma**. Só `findAllForSuperadmin` ganhou duas, e é exclusiva do
  Superadmin.
- O gate por tenant **não** virou consulta por página: cache de 60 s, e quando
  toca o banco é 1 `findUnique` com `select` de 2 colunas. `requireAiEnabled` e
  `getAiDailyLimitFor` compartilham a mesma entrada já aquecida.
- Nenhuma requisição externa nova por padrão: sem `AI_PROVIDER=gemini` o provedor
  é o mock; o catálogo público do ML está atrás de flag que nasce desligada, com
  gate central.
- Preflight CORS já amortizado (`maxAge: 86400`) pelo trabalho anterior de egress.
- Toda consulta Prisma direta do módulo usa `select` explícito e teto de linhas.

---

## 5. Regras da auditoria de egress anterior — continuam valendo?

**Sim.** Verificado item a item:

- Nenhum spec de perf/egress existente foi tocado: `git diff --numstat` sobre
  `tests/` no commitado dá **27 arquivos, 7.702 inserções e ZERO deleções**.
- Zero `it.skip`, `describe.skip`, `it.todo`, `.only`, `xit`, `xdescribe` nos
  specs novos.
- Nenhuma rota, consulta ou cache pré-existente foi reescrito.
- O rate limit global das outras rotas ficou byte-idêntico.
- O shell de todas as páginas não engordou além dos +2,1 KB medidos.

**Uma exceção, declarada:** `tests/team-collaborators.routes.spec.ts` foi
alterado. A alteração **endurece** (ver `atestado-nao-regressao.md`, seção 4).

---

## 6. Lacunas desta auditoria

O que ela **não** conseguiu verificar:

1. **Nada foi medido com servidor rodando.** Headers HTTP reais, gzip e
   comportamento do 304 vêm de leitura do código do Next, não de `curl`.
2. **Tamanhos de chunk em produção não medidos.** Os números de chunk vêm de um
   build de **dev, sem minificação** — servem para a razão entre eles, nunca para
   o valor absoluto.
3. **Nenhum `EXPLAIN ANALYZE` contra o Postgres real.** Todo o raciocínio sobre
   planos é leitura de schema e de índices declarados.
4. **Custo real por turno, em tokens e em reais, não medido.** Os ~74k tokens de
   pior caso são derivados de leitura de código.
5. **Nenhuma chamada real a um LLM.** A suíte inteira roda no provedor de mock.
6. **Nenhuma verificação visual.** Layout é verificado por texto-fonte e por dois
   specs em jsdom, não por pixels.

---

## 7. Achado de método — vale mais que vários dos achados de código

O `.env` deste worktree tem `AI_PROVIDER=gemini`, e **o vitest carrega o `.env`**.
Um spec de turno que não fixe o provedor com `vi.stubEnv("AI_PROVIDER", "mock")`
roda contra o provedor real, estoura sem rede, cai no `catch` de `chamar()` e
**nunca consome a fila do mock** — passando pelo caminho errado e provando outra
coisa.

Os specs de turno existentes já fazem isso (`ai-advisory-turn.spec.ts:106-107`).
O spec novo desta rodada não fazia, e foi pego porque a fila do mock ficou intacta
depois do turno. **Toda asserção de turno deve conferir
`__pendingMockCompletions() === 0`** — é o que distingue "o cenário encenado
rodou" de "alguma coisa quebrou antes".
