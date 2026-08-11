# Bitz — Fase 9: escrita com confirmação humana

O lojista pede → o Bitz **prepara** → um **cartão** aparece com o que vai mudar,
campo a campo → ele confere e clica em **Confirmar** → só então o sistema muda.

---

## ⭐ A frase que governa a fase inteira

**O agente não escreve. Ele propõe.**

Uma tool de escrita não toca no banco de negócio. Ela valida os argumentos,
resolve o alvo dentro do tenant, monta o resumo do que mudaria e grava uma linha
em `AiAction` com status `pendente`. Quem escreve é o clique em
`POST /ai/acoes/:id/confirmar`.

E o que é executado sai do `payload` **daquela linha**, nunca do que o navegador
devolveu. Sem isso, a rota de confirmação seria uma rota de escrita genérica com
nome de confirmação: um `curl` mandaria `{ produtoId: "...", preco: 1 }` e o
servidor obedeceria, porque "o usuário confirmou".

---

## O que entra nesta fase

| Ação | Efeito colateral | Permissão |
|---|---|---|
| Cadastrar peça | nenhum — `ProductUseCase.create` não dispara nada | `bitz.criar-produto` |
| **Cadastrar VÁRIAS peças** (Fase 10) | nenhum | `bitz.criar-produto-lote` |
| Cadastrar cliente | nenhum | `bitz.criar-cliente` |
| Alterar preço | ⚠️ **sincroniza com o marketplace na hora** | `bitz.atualizar-preco` |
| Ajustar estoque | ⚠️ **sincroniza com o marketplace na hora** | `bitz.ajustar-estoque` |

**⛔ E nada de exclusão.** Não há tool de apagar e não vai haver — regra do dono
do produto. A ausência é mais forte que qualquer validação: não existe caminho
para o modelo pedir, porque não existe a ferramenta. Há teste varrendo os nomes
de todas as 25 tools atrás de qualquer coisa que soe como exclusão.

---

## ⚠️ Alterar produto mexe no anúncio, e isso não é contornado

`ProductUseCase.update` chama `syncProductData` para cada anúncio da peça
([product.usercase.ts:1039](app/usecases/product.usercase.ts:1039)). Confirmar
uma troca de preço de uma peça anunciada muda o preço no Mercado Livre e na
Shopee **na hora**, e não existe um clique para desfazer.

Isso **não é evitado de propósito**: usar um caminho que não sincroniza deixaria
o Dexo dizendo um preço e o anúncio dizendo outro, que é pior. O que a fase faz é
garantir que o lojista **saiba antes**:

> ⚠️ Esta peça tem 2 anúncios publicados. Ao confirmar, o preço dos anúncios
> também será atualizado no marketplace na hora — e isso não tem um clique para
> desfazer.

O aviso fica **acima dos botões**, e há teste prendendo essa posição.

---

## As travas da confirmação

**1. ⭐⭐ Idempotência real.** A confirmação é um `updateMany` condicional
(`where status = "pendente"`), atômico no Postgres. Clique duplo, retry de rede
ou duas abas abertas executam **uma vez**: o segundo chamador encontra 0 linhas e
devolve o resultado já registrado, sem erro na cara de quem só clicou rápido.
Sem isso, "cadastrar produto" viraria dois produtos — e o lojista descobriria no
inventário, semanas depois.

**2. ⭐ A permissão é conferida DE NOVO, na hora de confirmar.** A checagem do
tool-runner aconteceu quando a proposta nasceu. Entre lá e aqui o administrador
pode ter tirado a chave do colaborador — e o que vale é o **agora**. Sem essa
segunda checagem, bastaria propor antes de perder o acesso.

**3. Escopo `(id, dataOwnerId, actorUserId)`.** Proposta de outro tenant — ou de
outro colaborador do mesmo tenant — simplesmente não resolve. E devolve **404, não
403**: 403 confirmaria que aquele id existe em algum lugar.

**4. Validade de 30 minutos.** O cartão diz "de R$ 180,00 para R$ 240,00". Se ele
confirmar amanhã, o "de" pode não ser mais R$ 180,00 — outra pessoa mexeu, um sync
trouxe outro valor — e ele estaria aprovando uma mudança que não é a que leu.

**5. Falha não volta a pendente.** Uma escrita que estourou no meio pode ter
aplicado parte. Reoferecer o botão convidaria a aplicar a outra metade duas
vezes. O caminho de volta é pedir de novo ao Bitz, que relê o estado atual.

---

## Permissão: duas chaves, somadas

O tool-runner exige **`scope.can(page)` E `scope.canAction(action)`**. Quem não
entra em Produtos não cadastra peça pelo Bitz nem com a chave ligada.

⭐ **Por que uma chave própria, e não só o acesso à página:** pedir por escrito a
um agente não é a mesma coisa que preencher um formulário. No formulário a pessoa
vê os 20 campos, erra num e o navegador reclama; no chat ela escreve uma frase e
outra coisa decide o resto. É legítimo um administrador querer que o balconista
continue cadastrando peça **na tela** e não pelo chat — e sem chave própria não
haveria como expressar isso.

**Nascem LIGADAS** para quem já tem a página (decisão do dono em 10/08/2026): no
dia do deploy ninguém perde capacidade nenhuma, e o administrador desliga
explicitamente na tela de Colaboradores.

⭐ **Uma declaração só.** `ACAO_EXIGE_PERMISSAO` é a fonte única: as tools
importam dela (`action: ACAO_EXIGE_PERMISSAO["produto.criar"]`) e a rota consulta
a mesma. Se cada lado declarasse a sua, bastaria acrescentar uma ação e esquecer
de um deles para existir escrita confirmável sem a permissão que a criou.

---

## O que o modelo vê, e o que ele não vê

A tool de escrita devolve `{ acao, paraOModelo }`. A **proposta** sai por fora e
vai para a tela; ao provedor de IA vai só a instrução curta.

O modelo **não** recebe o id interno do alvo nem a estrutura do preview. O preço
de venda vai, de propósito: é o que permite ao Bitz dizer *"preparei a troca de
R$ 180,00 para R$ 240,00, confere?"* em vez de *"preparei uma alteração"*. Preço
de venda não é sensível — as tools de leitura já o devolvem; o proibido é
`costPrice`, que não passa por aqui.

### As regras que entram no prompt

Só quando há tool de escrita no cardápio. A mais importante:

> **NUNCA diga que fez.** Nada de "pronto", "cadastrei", "alterei", "salvei".

É o erro mais provável e o mais caro: o modelo chama a ferramenta, lê "proposta
criada", e escreve "pronto, cadastrei!". O lojista fecha o chat achando que a
peça está no catálogo, e ela não está.

E a segunda:

> Se ele responder "sim", "pode fazer" ou "confirma" **por escrito**, isso NÃO é
> confirmação.

Se o modelo tratasse um "pode fazer" como autorização, a confirmação humana
viraria interpretação de texto — que é exatamente o que esta fase existe para não
ser. O gesto que vale é o botão, e o servidor só conhece o botão.

---

## A trilha

`AiAction` guarda quem pediu, quando, qual ação, quais campos, o que o lojista
**viu** ao decidir (o `preview` é gravado, não recalculado) e o que aconteceu.
Uma segunda linha vai para o `SystemLog` como `AI_ACTION`, em **warning** mesmo
no sucesso — é onde o suporte procura ao responder *"quem mexeu no preço dessa
peça?"*. Nada do conteúdo entra ali: só o quê, sobre qual id.

---

## Deploy

**A DDL vem ANTES do código.** `docs/bitz/setup-supabase.sql` cresceu para 5
passos; o novo é a tabela `AiAction`.

⚠️ Sem ela, o Bitz continua conversando e consultando normalmente — **toda
proposta de escrita é que falha**. Ao contrário das colunas de `User`, isso NÃO
derruba o login, então passaria despercebido até um cliente tentar cadastrar uma
peça pelo chat. Por isso há teste que deriva as tabelas do `schema.prisma` e
exige, para cada uma, `CREATE TABLE` no SQL de setup **e** numa migração lida do
índice do git.

O `SELECT` de conferência agora espera **1, 1, 1, 1, 1, 1, 0, 1**.

---

## Fase 10 — o lote

O caso real: o lojista desmontou um carro e quer cadastrar as peças de uma vez.
Ele dita a lista no chat, **ou** anexa uma foto/XML e o Bitz monta as linhas a
partir da leitura (Fase 8) — sem caminho novo de extração: a leitura já chega ao
modelo como `<dados_do_sistema>`, e o lojista confere linha a linha no cartão.

⭐ **A descrição da ferramenta PROÍBE completar a lista.** "desmontei um Gol 2012,
cadastra as peças" não vira 15 peças típicas de um Gol: o Bitz não sabe o que ele
de fato tirou do carro, e cadastrar peça que não existe no pátio é pior que não
cadastrar nada. A regra manda **perguntar quais peças**.

⭐ **Chave de permissão SEPARADA da de peça única** (`bitz.criar-produto-lote`).
O risco é diferente: conferir 25 linhas cansa, e confirmar sem ler é o risco real
da fase. O administrador pode liberar uma e não a outra.

| Decisão | Escolha do dono (10/08/2026) |
| --- | --- |
| Falha parcial | **As que deram certo ficam**, e o cartão lista as que faltaram — precedente de `LocationUseCase.createBulk`. Uma linha ruim não invalida as 28 boas. |
| Peça já existente | **Cadastra e avisa na linha.** Um desmonte tem mesmo dois faróis dianteiros esquerdos iguais, de dois carros — cada um é uma peça com SKU próprio. Barrar erraria o negócio. |
| Teto | **25 peças** por lote. |

⚠️ **O lote é SEQUENCIAL e sem `$transaction`.** `createWithAutoSku` reserva o SKU
com um `UPDATE ... RETURNING` atômico na linha do `User`; 25 reservas em paralelo
disputariam a mesma linha, e o ganho de tempo viraria contenção de lock. E prender
o lote a uma transação longa não daria atomicidade real — os números de SKU não
voltam num rollback.

O relatório (`28 de 30 cadastradas`, com o motivo de cada falha) vai para o
cartão, para a mensagem — sobrevive a fechar e reabrir o painel — e para o
`SystemLog` como `AI_ACTION`.

---

## O que a revisão adversarial pegou

Seis lentes independentes, com um cético por achado: **47 achados brutos → 30
refutados → 17 confirmados**, todos corrigidos antes do commit. Vários eram a
mesma raiz vista por lentes diferentes.

**1. ⭐⭐ A mentira depois de uma escrita irreversível.** O `update` que grava o
`resultId` morava **dentro do mesmo `try`** da execução. Com o preço já no
Mercado Livre e o pool do Prisma estourando na linha seguinte (P2024, incidente
conhecido deste repositório), a ação virava `falhou`, o `SystemLog` registrava
"falhou" e o lojista lia **"Nada foi alterado"** — com o anúncio já alterado. A
única trilha que existe registrava o oposto do que aconteceu. Agora a escrita de
**controle** é best-effort e separada: falhar em anotar não reescreve a história.

**2. ⭐⭐ O teste de dois cliques simultâneos não provava nada.** O dublê de banco
devolvia o **próprio objeto** do array e o mutava no lugar, então o perdedor via
a mudança do vencedor retroativamente e saía pelo early-return — nunca chegando
ao `updateMany`. Apagar `status: "pendente"` do `where` (a única coisa que dá a
idempotência) deixava a suíte inteira verde. Agora há teste sobre o `where` de
verdade e outro que força o ramo `count === 0`.

**3. ⭐ O estado intermediário passou a ser `executando`.** Marcar `confirmada`
antes de executar tornava indistinguíveis "deu certo" e "o processo morreu no
meio" (pm2 reload, OOM) — e o segundo pareceria sucesso para sempre. E o clique
que chega durante a execução recebe *"está sendo executada agora, aguarde"*, não
*"já foi decidida"*, que o deixaria sem saber se deu certo.

**4. ⭐ As tools de escrita quase nunca eram alcançadas.** As chaves eram pares
("alterar preco"), e a comparação é substring sobre a frase inteira: **"altera o
preço"** já não casava. 2 acertos em 18 frases reais. Ao mesmo tempo, chaves
soltas arrastavam a tool de cadastrar **peça** para "cadastro de cliente sumiu".
Resolvido com uma regra só: **tool de escrita precisa de dois sinais** (verbo de
mudança + objeto). Há uma suíte com 19 frases reais de lojista prendendo os dois
lados.

**5. ⭐ "SKU não existe" virava "não consegui buscar agora".** A tool lançava, e o
tool-runner traduz qualquer exceção para "tente de novo". Quem digitou `9999` em
vez de `4999` tentava para sempre sem nunca ser informado do problema. Agora é um
resultado de negócio: o modelo recebe o SKU, a verdade, e a proibição de inventar.

**6. O aviso de cliente duplicado era linha morta.** `CustomerUseCase.search(q, userId)`
é posicional e estava sendo chamado com um **objeto**, por trás de um `as any` — o
`as any` foi exatamente o que escondeu do compilador. Cinco lentes acharam.

**7. Fechar e reabrir o painel ressuscitava o cartão.** O `DialogPrimitive.Content`
do Radix desmonta ao fechar e leva junto o `useState`: um cartão já executado
voltava a "Confira antes de confirmar", com o botão ativo. A decisão passou a
morar na **mensagem**, que vive um nível acima e sobrevive.

**8. Proposta corrigida não aposentava a anterior.** "cadastra o coxim, R$ 90" →
"errei, é R$ 190" deixava dois cartões vivos; confirmar o antigo criava um
segundo produto com o preço errado. Agora a proposta nova cancela a pendente do
mesmo tipo, na mesma conversa, do mesmo ator.

**9. `createdByUserId` não era gravado** — a coluna "Criado por" mostrava "—"
para tudo que o Bitz cadastrasse.

### Uma coisa que ficou como está, de propósito

"cadastro de cliente sumiu" **oferece** `cadastrar_cliente` ao modelo. Apertar
mais a seleção derrubaria as frases legítimas de cadastro, e oferecer não é
chamar: o prompt manda preparar e nunca afirmar, e o cartão exige o clique.

---

## Dívidas declaradas

1. **Nenhuma escrita real aconteceu ainda** — os executores são embrulhos finos
   dos usecases da tela, mas a primeira execução de verdade depende do deploy.
2. **Uma proposta por vez na conversa.** Não há tela de "propostas pendentes": se
   o lojista fechar o chat sem decidir, a proposta expira sozinha em 30 minutos.
3. **Sem desfazer.** Confirmado é confirmado — inclusive no marketplace. Cancelar
   depois de confirmar não desfaz nada, e o cartão diz isso.
4. **`Receivable` continua sem chave natural** (lacuna mapeada na Fase 0). Não
   entra nesta fase justamente por isso: uma ação financeira sem chave de
   idempotência natural mereceria um desenho próprio.
