# Bitz — relatório para a equipe de Suporte

**Branch:** `claude/bitz-ia-agent-d0b8fa` · **Base:** `9b67a76` · **Data:** 07/08/2026
**Público:** equipe de Suporte da Dexo. Linguagem de atendimento, precisão de engenharia.

> Este documento não afirma que está tudo perfeito. Ele diz **o que mudou, o que
> foi verificado, como, e onde a verificação tem limite** — para que o Suporte
> consiga responder o cliente sem chutar.

---

## 1. Resumo executivo

O **Bitz** é o assistente de IA do Dexo: um robôzinho no canto inferior direito
de qualquer tela, que responde perguntas sobre o sistema e sobre os dados da
própria loja do cliente.

Nesta entrega ele passa a ser **liberado para todas as contas**, com **5
mensagens por dia por loja**, sem custo para o cliente. Quem precisar de mais
tem o teto ajustado pela Dexo, conta a conta.

Três coisas o Suporte precisa ter na ponta da língua:

| | |
| --- | --- |
| **O Bitz só lê.** | Ele não cria, não edita e não apaga nada. Um erro dele nunca vira um erro no sistema do cliente. |
| **5 mensagens por dia, por loja.** | A cota é da conta, somando o uso de todos os colaboradores, e zera todo dia. |
| **Ele respeita as permissões.** | Colaborador sem acesso ao Financeiro continua sem acesso, dentro do chat também. |

Gates de qualidade desta entrega:

| Gate | Resultado |
| --- | --- |
| Suíte de testes automatizados | **5.340 passando · 0 falhas** |
| Verificação de tipos (`tsc`) | **100 erros = a baseline exata do projeto**, 0 nos arquivos tocados |
| Testes pré-existentes alterados para passar | **0** |
| Regressão encontrada em área fora do Bitz | **nenhuma** |

---

## 2. Objetivo das otimizações

Esta rodada teve dois objetivos, e eles são diferentes entre si:

1. **Corrigir defeitos encontrados na própria entrega** — não "melhorar por
   melhorar". Cada alteração abaixo nasceu de um defeito concreto, com
   consequência mensurável em dinheiro, em segurança ou em experiência.
2. **Garantir que nada do resto do Dexo foi afetado.** O Bitz mexeu em arquivos
   compartilhados com o ERP inteiro (o cadastro de usuários, as rotas de equipe).
   Esse é o risco real da entrega, e foi auditado especificamente.

O que **não** foi objetivo: refatorar código que já funcionava, mudar fluxo,
mudar tela ou mudar contrato de API. Nada disso foi tocado.

---

## 3. Funcionalidades analisadas

Toda a branch — **125 arquivos e ~21.700 linhas já commitadas, mais 26 arquivos
e ~1.900 linhas da última rodada**. As áreas revisadas:

| Área | O que foi olhado |
| --- | --- |
| Chat do Bitz | Painel, composição da mensagem, bolhas, fontes da resposta, mascote, animações |
| Motor do agente | Orquestrador, ferramentas de consulta, contexto enviado ao modelo, streaming |
| Acesso e cota | Prévia gratuita, teto diário por loja, teto global da plataforma |
| Cadastro de usuários | `User`, repositório, rotas de equipe e de superadmin |
| Banco de dados | Colunas novas, ordem de aplicação, consultas por conversa |
| Rede e tráfego | O que é baixado por quem não usa o Bitz e por quem usa |
| Segurança | Isolamento entre lojas, permissões, segredos, injeção de prompt, privacidade |

---

## 4. Alterações realizadas

Sete alterações. Todas aditivas ou corretivas; **nenhuma mudou fluxo, tela ou
contrato de API**.

| # | Alteração | Arquivo principal | Tipo |
| --- | --- | --- | --- |
| 1 | A animação de entrada terminava voltando ao começo — o pedaço da volta foi cortado | `public/bitz/bitz-mascote-entrada.webp` | Correção visual |
| 2 | `PUT /users/me/settings` conseguia escrever campos privilegiados | `app/interfaces/user.interface.ts` | **Segurança** |
| 3 | A prévia gratuita entregava junto a cota do plano pago | `app/ai/entitlement/ai-entitlement.service.ts` | **Custo** |
| 4 | O custo de um turno era contado só na última chamada ao modelo | `app/ai/agent/orchestrator.ts` | **Custo** |
| 5 | A conversa voltava ao topo ao reabrir o painel | `components/bitz/bitz-panel.tsx` | Experiência |
| 6 | Faltava o DDL de uma coluna nova no SQL de deploy | `docs/bitz/setup-supabase.sql` | **Risco de indisponibilidade** |
| 7 | Teto diário por cliente, ajustável pelo Superadmin | `app/routes/superadmin.routes.ts` | Recurso novo |
| 8 | Na virada da meia-noite, a cota podia ser devolvida no dia errado | `app/ai/agent/orchestrator.ts` | Correção de cota |

---

## 5. Justificativa técnica de cada alteração

### 5.1 A animação voltava ao começo em vez de terminar

**Sintoma relatado:** ao clicar no mascote pela primeira vez, a animação rodava
bonita até o robô ir embora — e então dava um "solavanco" e voltava ao início
por cerca de um segundo.

**Causa:** não era código. O vídeo original foi autorado para rodar **em loop**,
e por isso ele já emenda a volta ao começo dentro do próprio arquivo. Conferido
quadro a quadro: até 9,53 s só existe o robô indo embora; em **9,60 s** ele ainda
está na tela **e a cabeça do começo já entra pela direita**; de 9,67 s em diante
só existe o robô do quadro zero.

**Correção:** o arquivo foi reexportado com **144 quadros em vez de 150** — o
corte cai no último quadro em que só existe o robô saindo.

| | Antes | Depois |
| --- | --- | --- |
| Quadros | 150 | **144** |
| Duração | 10,00 s | **9,60 s** |
| Tamanho | 1.065 KB | **1.045 KB** |

**Por que não pode regredir:** existe um teste que lê os **bytes do arquivo** e
exige duração entre 9,5 s e 9,7 s. Reexportar "o vídeo inteiro" volta a falhar
na hora, em vez de voltar em silêncio.

### 5.2 Campos privilegiados eram graváveis pela rota de preferências

**O defeito:** a rota que salva as preferências do próprio usuário
(`PUT /users/me/settings`) repassava o corpo do pedido para o repositório. O tipo
`UserUpdate` declarava `isActive`, `pagePermissions` e os dois campos de IA —
então qualquer usuário autenticado podia, com uma requisição feita à mão,
reativar a própria conta bloqueada, dar a si mesmo permissões que não tem, ou
liberar o Bitz com um teto arbitrário.

**A correção é por construção, não por validação.** Os quatro campos saíram de
`UserUpdate`. Quem precisa escrevê-los usa tipos estreitos e específicos
(`UserAiAccessUpdate`, `UserAccessControlUpdate`), acessíveis só pelas rotas com
guarda. Um `if` a mais poderia ser esquecido no próximo campo; um tipo que não
tem o campo não tem como esquecer.

**Prova:** `tests/security/user-settings-mass-assignment.spec.ts`.

### 5.3 A prévia gratuita entregava a cota do plano pago

**O defeito:** a prévia foi feita para dar **acesso**, nunca **cota**. Mas o
serviço devolvia o teto gravado no cliente independentemente de haver concessão
ativa. Efeito prático: um cliente que teve o plano revogado — mas que ficou com
`aiDailyLimit = 2000` no cadastro — voltava pela prévia **com 2.000 mensagens por
dia**, quando deveria cair no padrão de 5.

**A correção:** o teto só é devolvido quando existe concessão. Sem concessão, o
acesso vem da prévia e a cota vem do padrão da plataforma.

**Por que importa para o Suporte:** é isso que torna "grátis para todos" um gasto
previsível. Sem isso, um punhado de contas antigas custaria mais que a base
inteira.

### 5.4 O custo de um turno era contado só na última chamada

**O defeito:** uma pergunta pode exigir várias idas ao modelo (o Bitz consulta,
lê o resultado, consulta de novo, responde). O contador de uso era
**sobrescrito** a cada ida, então só a última era registrada.

**Consequência:** o custo real aparecia **menor do que é** nos relatórios de
consumo. O teto diário continuava funcionando (ele conta mensagens, não tokens),
mas a projeção de gasto ficava otimista.

**A correção:** o uso passa a ser **somado** ao longo do turno. E quando o
provedor não informa consumo, o campo grava **nulo** em vez de zero — "não sei"
e "custou zero" não são a mesma coisa, e tratar um como o outro é o que produz
relatório enganoso.

### 5.5 A conversa voltava ao topo ao reabrir o painel

**O defeito:** ao fechar e reabrir o chat, a conversa aparecia rolada lá em cima,
mostrando as mensagens mais antigas em vez da resposta mais recente.

**Causa:** o painel do Radix **desmonta** o conteúdo ao fechar. Ao reabrir, o
elemento de rolagem nasce novo com posição zero, e o efeito que ajusta a rolagem
não tornava a rodar porque as mensagens não haviam mudado.

**A correção:** a rolagem passa a ser posicionada no momento em que o elemento
nasce, o que é robusto a **qualquer** remontagem futura, não só à de hoje.

**Prova:** um teste que monta React de verdade, fecha, reabre e confere a
posição — incluindo um **controle negativo** que reproduz o defeito antigo.

### 5.6 Faltava o DDL de uma coluna nova

**Este é o item mais sério do relatório, e ele não é sobre o Bitz.**

A coluna `User.aiDailyLimit` foi criada no schema, mas não entrou nem no arquivo
de SQL de implantação nem em migração versionada.

**Por que isso derruba o Dexo inteiro:** o Prisma não faz `SELECT *`; ele monta a
lista **nominal** de colunas a partir do schema. Se o código subir antes do
`ALTER TABLE`, **toda** leitura da tabela `User` passa a citar uma coluna
inexistente e falha — **inclusive o login**. Não é degradação parcial de um
módulo desligado: é a plataforma fora do ar, para todos os clientes, por causa de
uma coluna de um recurso que nem estava ligado.

**A correção:** o `ALTER TABLE` entrou no SQL de implantação e ganhou migração
versionada própria, e a ordem de deploy foi corrigida nos documentos.

**E a correção de verdade é o teste.** Nada no repositório conferia se o SQL de
implantação cobre as colunas do schema — foi por isso que a lacuna passou. Agora
existe uma verificação que **deriva a lista do próprio schema**: a próxima coluna
nasce coberta sem ninguém lembrar de voltar lá.

### 5.7 Teto diário por cliente, pelo Superadmin

Recurso novo, pedido do produto: **/colaboradores → aba da equipe Dexo → botão
Bitz** na linha do administrador da conta.

- **Acesso liberado** — marca o cliente como assinante. É a lista de quem
  continua depois que a prévia acabar.
- **Teto diário** — o número de mensagens por dia daquele cliente. Em branco,
  volta ao padrão da plataforma.

Três detalhes que o Suporte precisa saber sobre este painel:

- **O controle só aparece na linha do ADMINISTRADOR.** Cota e acesso são sempre
  da conta-mãe; colaborador herda. Um controle na linha do colaborador gravaria
  um campo que nunca é lido.
- **Teto de sanidade de 2.000 aplicado no servidor.** Cada mensagem custa
  dinheiro, e um dígito a mais viraria milhares de reais em um dia.
- **Salvar já vale.** O cache de permissão é limpo na hora — sem isso, o cliente
  ficaria barrado por até um minuto depois de a Dexo liberar.

### 5.8 A cota podia ser devolvida no dia errado

**O defeito:** quando uma mensagem falha sem que o modelo tenha sido cobrado, o
sistema devolve a mensagem ao saldo do dia. O saldo é contado por dia, e o
começo e o fim da mensagem consultavam o relógio separadamente. Uma mensagem que
começasse às 20:59 de São Paulo e falhasse alguns segundos depois devolvia o
crédito ao **dia seguinte** — um saldo que ninguém tinha gasto.

**A correção:** o instante é fixado uma vez, no início da mensagem, e vale para
as duas pontas. Dentro do mesmo dia nada muda.

**Efeito prático para o Suporte:** nenhum cliente ganhava mensagem extra por
causa disso (o desconto do dia certo continuava valendo), mas o número do saldo
podia ficar torto por um dia. Agora não fica.

---

## 6. Ganhos esperados de performance

**Sendo honesto: esta rodada não é uma rodada de performance, e não seria certo
vendê-la como tal.** Os ganhos são estes, e são específicos:

| Onde | Ganho | Como foi medido |
| --- | --- | --- |
| Arquivo da animação de entrada | **−20 KB** (1.065 → 1.045 KB), baixado uma vez na vida por usuário | Bytes do arquivo |
| Precisão do relatório de custo de IA | Passa a refletir o custo real, que antes era subnotificado | Contagem de chamadas ao provedor por turno |
| Abertura do chat | A conversa abre na posição certa, sem o pulo de rolagem | Teste de montagem real |

Nenhuma consulta ao banco foi adicionada. Nenhuma requisição de rede foi
adicionada. **Nenhuma otimização foi aplicada "no escuro"**: onde havia dúvida
sobre risco de regressão, o item foi documentado e não implementado.

**A auditoria em números:** 6 dimensões independentes varreram a branch inteira e
produziram **34 achados**. Oito passaram por uma verificação adversarial —
alguém tentando derrubar cada um. **Dois foram derrubados** (um deles teria feito
a gente criar um índice desnecessário em produção), **dois viraram código** e
**13 foram documentados e não implementados**, com o motivo escrito, em
`docs/bitz/auditoria-perf-egress.md`.

Essa proporção é o resultado, não uma desculpa: numa entrega que já estava
testada, o achado honesto costuma ser "existe, mas mexer custa mais caro que
conviver".

---

## 7. Impacto sobre consumo de recursos e egress

### Para quem NÃO usa o Bitz

O custo permanente é o **launcher** — o robôzinho no canto — mais o código que
decide se ele aparece. Todo o resto (painel, chat, markdown, mascotes animados)
vive num pacote separado que **só é baixado depois do primeiro clique**.

O custo medido na entrega original foi de **+2,1 KB comprimidos** no pacote comum
de todas as páginas. Esta rodada **não o aumentou**: nenhum arquivo novo passou a
ser carregado de forma antecipada.

### Para quem usa

| Item | Quando é baixado | Tamanho |
| --- | --- | --- |
| Pacote do painel de chat | No primeiro clique da sessão | Sob demanda |
| Animação de entrada | **Uma vez na vida** do usuário | 1.045 KB |
| Mascote em loop da tela de apresentação | **Uma vez na vida** do usuário | 235 KB |
| Mascote estático | Junto com o painel | 16 KB |

A animação de entrada é o item caro, e ele é caro **de propósito e uma vez só**:
existe uma marca gravada no navegador do usuário, e quem já viu nunca mais pede o
arquivo. A marca é gravada **quando a animação aparece na tela**, não quando o
usuário clica — assim, quem clicou e não viu nada (rede caída, arquivo que não
chegou) continua com direito de ver depois, e não perde a animação para sempre.

### Banco de dados

Nenhuma consulta nova por conversa nesta rodada. O cache de permissão (60 s)
continua evitando ida ao banco a cada mensagem, e o teto por cliente lê do
**mesmo** cache — não custou nenhuma consulta a mais. A cota é contabilizada numa
tabela que já existia; **nenhuma tabela nova foi criada nesta rodada**.

Custo medido de uma mensagem, contando comandos enviados ao banco:

| Tipo de pergunta | Comandos no banco |
| --- | --- |
| Conversa simples (sem consulta a dados) | **7** |
| Com busca na base de conhecimento | +1 |
| Consultando dados (2 ferramentas) | ~19 |
| Consultando dados (4 ferramentas) | ~29 |

**Limite de desenho:** no máximo 2 rodadas de consulta × 8 ferramentas por
rodada. Não existe caminho em que uma pergunta consulte indefinidamente.

### O que NÃO ficou mais pesado

- A tela de **Colaboradores** não trafega 1 byte a mais: a listagem de equipe não
  ganhou nenhuma coluna. Só a listagem exclusiva do Superadmin ganhou duas.
- **Nenhuma requisição externa nova por padrão.** A busca em marketplaces
  continua atrás de uma chave desligada.
- Nenhuma rota, consulta ou cache que já existia foi reescrito.

### Teto de gasto

A reserva de cota é **pessimista**: o contador sobe **antes** de chamar o modelo.
O gasto real portanto nunca ultrapassa o teto configurado — no máximo fica
abaixo dele. Existem dois tetos em série: por loja (5/dia) e global da
plataforma.

---

## 8. Confirmação de ausência de regressões

| Verificação | Resultado |
| --- | --- |
| Suíte completa (`vitest run --pool=forks`) | **5.340 passando · 27 pulados · 0 falhas** |
| Arquivos de teste | 449 passando · 2 pulados |
| Verificação de tipos (`tsc --noEmit`) | **100 erros = a baseline exata do projeto** |
| Testes pré-existentes **afrouxados**, pulados ou apagados | **0** |
| Testes pré-existentes **alterados** | **1** — e a alteração endurece (ver abaixo) |
| Contratos de API alterados | **0** |
| Telas existentes alteradas | **0** |
| Regras de negócio alteradas | **0** |

**A evidência mais forte é negativa:** nenhum teste de domínio (produtos,
pedidos, estoque, financeiro, sucatas, NF-e, marketplaces) foi tocado. Eles
cobrem essas áreas exatamente como cobriam antes, e continuam verdes.

Os arquivos de teste modificados nesta rodada são todos de IA/segurança escritos
para esta entrega, e as mudanças são **aditivas** — mais cobertura, ou uma
verificação que ficou **mais específica**, nunca menos.

**A exceção, dita com todas as letras.** Um teste que já existia foi alterado:
`tests/team-collaborators.routes.spec.ts`. Duas coisas aconteceram nele, e
nenhuma afrouxa:

1. O dublê do repositório ganhou o método novo que a rota passou a usar. Sem
   isso, a rota de bloquear/desbloquear colaborador responderia **erro 500** no
   teste — a alteração é o que mantém o teste refletindo a realidade.
2. Três verificações de segurança foram **reapontadas**. Elas provavam que um
   método não era chamado após um acesso negado; como a rota deixou de usar esse
   método em qualquer caminho, elas passariam a ser verdadeiras **sem provar
   nada**. Agora apontam para o método que a rota de fato usa.

Duas auditorias independentes revisaram esse diff linha a linha e classificaram
a mudança como endurecimento. O detalhe completo está em
`docs/bitz/atestado-nao-regressao.md`, seção 4.

---

## 9. Funcionalidades críticas validadas

| Funcionalidade | Como foi validada |
| --- | --- |
| Criação, edição e exclusão de produtos | Suíte de domínio, intocada e verde |
| Sincronização de produtos com marketplaces | Suíte de integrações, intocada e verde |
| Importação automática de pedidos | Suíte de ingestão, intocada e verde |
| Baixa e atualização de estoque | Suíte de estoque, intocada e verde |
| Fluxo de pedidos | Suíte de pedidos, intocada e verde |
| Integrações (ML, Shopee, Magalu, OLX, Facebook) | Suítes de marketplace, intocadas e verdes |
| Rotinas agendadas, jobs, filas e webhooks | Nenhum arquivo tocado nesta branch |
| **Autenticação (login)** | Suíte de auth verde **+** correção do DDL faltante, que era o único caminho conhecido para derrubá-la |
| **Permissões** | Suíte de permissões verde **+** a correção de escrita privilegiada, com teste dedicado |

**Limite honesto:** a validação é por teste automatizado e leitura de código.
Nenhuma linha desta rodada rodou contra o banco de produção, e nenhuma chamada
real a um modelo de IA foi feita — a suíte inteira roda com dublês.
**Conferência em produção, depois do deploy, continua sendo necessária.**

---

## 10. O que mudou do ponto de vista do cliente

| O cliente vê | Detalhe |
| --- | --- |
| **Um robôzinho no canto inferior direito** | Em todas as telas do Dexo. Antes não existia. |
| **Uma animação no primeiro clique** | Uma vez na vida. Agora termina direito, sem voltar ao começo. |
| **A tela "Conheça o Bitz"** | Na primeira conversa. Depois disso, a tela de boas-vindas normal. |
| **5 mensagens por dia** | Quando acabam, o próprio Bitz avisa: *"Você atingiu o limite de mensagens do Bitz por hoje. Ele volta amanhã."* |
| **A conversa abre onde parou** | Antes voltava ao topo ao reabrir o painel. |

**O que o cliente NÃO vê mudar:** absolutamente nada do resto do sistema.
Nenhuma tela existente mudou, nenhum botão mudou de lugar, nenhum relatório mudou
de número.

---

## 11. O que o suporte precisa saber

**As cinco coisas que mais vão aparecer no atendimento:**

1. **"O Bitz mexeu no meu cadastro?"** — Não. Ele só lê. Não cria, não edita, não
   apaga, não emite nota, não publica anúncio, não dá baixa em estoque. Se algo
   mudou no sistema, não foi ele.

2. **"Acabaram minhas mensagens."** — São 5 por dia **por loja**, somando todos os
   colaboradores, e zeram todo dia. Para aumentar, é ajuste da Dexo, conta a
   conta, pelo painel de Superadmin.

3. **"Meu colaborador não consegue ver o Financeiro no Bitz."** — Está correto.
   O Bitz respeita as permissões já configuradas na conta. A solução é dar a
   permissão na tela de Colaboradores, como sempre foi.

4. **"O Bitz errou um número."** — Pode acontecer. Peça para o cliente conferir
   nas **fontes** que aparecem embaixo da resposta e na tela correspondente. E
   tranquilize: como ele não altera nada, um erro dele não vira erro no sistema.

5. **"A animação não apareceu."** — Ela toca **uma única vez por usuário, por
   navegador**. Quem já viu não vê de novo. Em navegador com "reduzir animações"
   ligado no sistema, ela também não toca — é comportamento intencional.

**O que o Suporte NÃO deve prometer:**

- Não prometa lista de conversas antigas: ainda não existe. O botão de nova
  conversa limpa a tela e recomeça.
- Não prometa que o Bitz executa tarefas. Nesta etapa ele **conversa, consulta,
  relata e recomenda** — nada mais.
- Não prometa aumento de cota na hora sem passar pelo time: o ajuste é manual.

---

## 12. Como orientar os clientes

**Passo a passo para o cliente que nunca usou:**

1. Abra qualquer tela do Dexo.
2. Clique no robôzinho no **canto inferior direito**.
3. Na primeira vez, uma animação toca e a tela "Conheça o Bitz" aparece.
4. Escreva a pergunta **em português normal** — não existe comando para decorar.
5. Se a resposta trouxer números, confira as **fontes** logo abaixo.

**Perguntas que funcionam bem** (são as mesmas que aparecem prontas no chat):

| Assunto | Exemplos |
| --- | --- |
| Vendas | "Quanto eu vendi em julho?" · "Qual marketplace mais fatura pra mim?" |
| Estoque | "Quais peças estão com estoque baixo?" · "Quantos produtos eu tenho cadastrados?" |
| Anúncios | "Como eu publico um anúncio no Mercado Livre?" · "Por que meu anúncio está pausado?" |
| Financeiro | "Quanto eu tenho a receber?" · "Quanto está vencido?" |
| Sucatas | "Quantas peças saíram da última sucata?" · "Quanto já recuperei de uma sucata?" |
| O próprio Dexo | "Como eu emito etiquetas?" · "Como funciona o Scan de recebimento?" |

**Página pública de notas de atualização** — para mandar ao cliente em vez de
explicar por escrito: o link publicado na comunidade da Dexo. Ele é atualizado a
cada melhoria do Bitz.

---

## 13. Perguntas frequentes

**O cliente precisa contratar algo?**
Não. Está liberado para todas as contas, com 5 mensagens por dia. Contratação só
entra se ele quiser um limite maior.

**Colaborador também usa?**
Sim, e vê apenas o que as permissões dele já permitem. As 5 mensagens são da
loja, somando o uso de todos.

**O Bitz vê os dados de outro cliente da Dexo?**
Não, e isso não depende de configuração. Cada conversa é fechada dentro da conta,
por três travas independentes no código. Não existe pergunta capaz de furar isso.

**O Bitz mostra custo ou margem?**
Não. Preço de custo e markup são bloqueados **inclusive para o administrador**.

**O Bitz manda os dados do cliente para fora?**
A pergunta e o contexto necessário vão para o provedor de IA para gerar a
resposta — é assim que qualquer assistente funciona. O que **não** sai: custo,
margem, documento de cliente sem máscara, e qualquer dado de outra loja. A busca
externa em marketplaces é uma chave separada, **desligada**.

**E se o cliente perder a animação?**
Ela toca uma vez por navegador. Trocando de navegador ou limpando os dados do
site, ela toca de novo — não é problema, é como foi desenhada.

**O chat funciona no celular?**
Sim. No celular abre em tela cheia; no computador, em painel lateral, com o Dexo
visível atrás.

**Dá para desligar o Bitz de um cliente específico?**
Enquanto a prévia gratuita estiver ligada, ela vale para todos. O que se ajusta
por cliente é o **teto**. Desligar caso a caso não existe hoje — se o cliente
pedir, registre e encaminhe.

---

## 14. Observações importantes

⚠️ **A ordem do deploy não é negociável.** O SQL vem **antes** do código. Fora
dessa ordem, o login do Dexo inteiro para de funcionar — todos os clientes, não
só os do Bitz. O arquivo `docs/bitz/setup-supabase.sql` tem tudo, na ordem certa,
e pode ser rodado mais de uma vez sem risco.

⚠️ **Faturamento do provedor de IA precisa estar habilitado.** No plano gratuito
o limite é de 20 requisições, e a prévia morre com erro nos primeiros minutos.

⚠️ **A prévia gratuita é uma chave, não um `UPDATE` no banco.** Desligá-la é uma
linha de configuração. Quem tiver acesso concedido individualmente continua; o
resto perde. Foi feito assim justamente para que, no dia de encerrar, não seja
preciso adivinhar quem recebeu na prévia e quem assinou.

⚠️ **A busca externa em marketplaces continua desligada.** Ligá-la é uma decisão
separada, porque é ela que autoriza o título de uma peça a sair do perímetro do
Dexo.

⚠️ **Custo por mensagem ainda é ordem de grandeza, não garantia.** A amostra que
gerou o número tinha 3 conversas, e a contagem de uso só agora ficou correta. O
que **é** garantia são os tetos: por loja e global, com reserva pessimista.

⚠️ **O teto global conta MENSAGENS, não chamadas ao modelo.** Uma pergunta que
exige consulta a dados pode custar até quatro idas ao modelo, e o texto enviado
cresce a cada ida. Então "1.500 no teto global" garante 1.500 mensagens por dia,
**não** um valor fixo em reais. Reapure a conta depois de uma semana de uso real
e ajuste pelo que a fatura disser.

⚠️ **13 melhorias possíveis foram identificadas e NÃO implementadas de
propósito.** Todas com o motivo escrito em `docs/bitz/auditoria-perf-egress.md`.
São coisas reais, mas em que mexer hoje custaria mais que conviver — o critério
foi estabilidade acima de ganho marginal. Se alguém perguntar "por que não
otimizaram X", a resposta está lá, item a item.

---

## 15. Checklist final de validação

Antes de considerar a entrega no ar:

- [ ] **SQL aplicado** (`docs/bitz/setup-supabase.sql`, colado inteiro no editor
      do Supabase) — **antes** do deploy do código
- [ ] `npx prisma generate`
- [ ] Deploy da API e do front
- [ ] `npm run ai:index -- --apply` (indexa a base de conhecimento)
- [ ] Faturamento habilitado no provedor de IA
- [ ] `AI_FREE_PREVIEW=true`, `AI_MAX_DAILY_PER_TENANT=5`, `AI_MAX_DAILY_GLOBAL`
      definido conforme o orçamento
- [ ] `NEXT_PUBLIC_AI_MODULE_ENABLED=true` — **exige rebuild do front**, não só
      restart
- [ ] **Login funcionando** (é o canário do DDL: se o login caiu, faltou coluna)
- [ ] Abrir uma tela qualquer e confirmar o robô no canto
- [ ] Primeiro clique: a animação toca **e termina sem voltar ao começo**
- [ ] Fazer uma pergunta de cada assunto e conferir os números contra a tela
- [ ] Gastar as 5 mensagens e confirmar a mensagem de limite
- [ ] Abrir e fechar o painel: a conversa volta na posição certa
- [ ] Superadmin: liberar acesso e teto para um cliente e confirmar que vale na
      hora
- [ ] Colaborador sem Financeiro: confirmar que o Bitz recusa dentro da conversa

**Rollback:** `NEXT_PUBLIC_AI_MODULE_ENABLED=false` (com rebuild do front)
desliga tudo sem deploy de código. As colunas e tabelas podem ficar — são
aditivas e ninguém mais as lê.
