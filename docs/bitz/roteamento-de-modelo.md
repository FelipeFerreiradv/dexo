# Bitz — troca dinâmica de modelo

Como fazer cada tipo de pergunta ir para o modelo mais barato que dá conta dela,
mexendo só no `.env`.

## 1. A ideia em uma linha

**Texto é ~95% do volume do Bitz** — dúvida, relatório, consulta de peça,
"quanto vendi em julho". Isso não precisa de um modelo multimodal caro. Imagem e
áudio precisam, e são raros. Amarrar tudo a um provedor só significa pagar preço
de multimodal em toda pergunta de texto.

O roteamento resolve isso: **uma capacidade, um provedor, um modelo.**

## 2. A configuração que economiza

```bash
# Chaves — uma por provedor
AI_GEMINI_API_KEY="..."
AI_DEEPSEEK_API_KEY="..."

# Rotas: "provedor:modelo"
AI_ROUTE_TEXTO="deepseek:<modelo-v4-vigente>"
AI_ROUTE_IMAGEM="gemini:<modelo-vigente>"
AI_ROUTE_AUDIO="gemini:<modelo-vigente>"
```

Reiniciar a API basta. Nada aqui exige rebuild — só a
`NEXT_PUBLIC_AI_MODULE_ENABLED` tem essa exigência, e ela é outra coisa.

## 3. Quem serve para quê

Verificado em 07/08/2026, e a tabela existe porque o contrário custa caro:

| Capacidade | DeepSeek | Gemini |
| --- | --- | --- |
| **Texto** | ✅ mais barato | ✅ |
| **Imagem** | ❌ **não tem visão na API** | ✅ |
| **Áudio** | ❌ **não tem áudio, em forma nenhuma** | ✅ |

⚠️ **A visão do DeepSeek existe só no `chat.deepseek.com`**, não na API. Não há
endpoint nem tipo de conteúdo de imagem. Rotear `imagem` para ele **não falha na
configuração** — falha na chamada, com `erro_provedor`, e parece problema de
rede.

⚠️ **Áudio, quando a Fase 7 chegar, é transcrever e responder no DeepSeek.** A
decisão do produto foi: um serviço de transcrição converte a voz em texto e o
DeepSeek responde. Duas chamadas, mas o raciocínio caro fica no modelo barato —
e o Bitz continua com um cérebro só, então voz e texto respondem igual.

⚠️ **Nome de modelo muda.** `deepseek-chat` e `deepseek-reasoner` foram
**descontinuados em 24/07/2026** em favor dos nomes da V4. Confira o nome
vigente na documentação do provedor antes de colar — este documento não fixa
nomes de propósito, e o código também não.

## 4. As regras que o código garante

**Compatibilidade.** Sem nenhuma `AI_ROUTE_*`, as três capacidades caem no par
legado `AI_PROVIDER` + `AI_MODEL`. Um `.env` que nunca ouviu falar de rota se
comporta exatamente como antes. Há teste para as três.

**⭐ `AI_PROVIDER=mock` vence QUALQUER rota.** Não é preferência de provedor: é o
interruptor de "não fale com ninguém lá fora". Use-o para tirar o Bitz do ar sem
desmontar a configuração de rotas.

⚠️ Isto já quebrou de verdade. Quando as rotas entraram, um `.env` de
desenvolvimento com `AI_ROUTE_TEXTO` passou a vencer o `AI_PROVIDER=mock` que
dezenas de specs de turno fixam — e eles começaram a chamar o provedor **real,
com chave real**, saindo pela rede. O sintoma foi enganoso ("nenhuma ferramenta
foi selecionada", não "erro de rede"), e por isso a regra virou explícita e
testada. `AI_PROVIDER` **ausente** não desliga rota nenhuma; só o valor escrito
conta.

**⭐ Chave nunca cruza de provedor.** `AI_API_KEY` só é usada pelo provedor
nomeado em `AI_PROVIDER`. Sem essa regra, um `.env` com `AI_PROVIDER=gemini` +
`AI_ROUTE_TEXTO=deepseek:...` e sem `AI_DEEPSEEK_API_KEY` mandaria **a chave do
Google para o servidor do DeepSeek** no primeiro `Authorization: Bearer` —
vazamento de credencial para terceiro, causado por uma linha de configuração e
sem nenhum sinal de erro. Faltando a chave certa, o provedor não sobe e o Bitz
degrada.

**Falha fechada.** `AI_ROUTE_TEXTO="deepseek"` (sem `:modelo`) **não** vira um
modelo padrão: o chat degrada com `sem_modelo`. Inventar um nome aqui é o começo
de uma conta surpresa — chamaria um modelo que ninguém escolheu, com o preço que
vier.

**⭐ Typo na rota não deixa a API subir.** `AI_ROUTE_TEXTO="deepsek:v4"` é
recusado **no boot** (`app/lib/env.ts`) — a mesma regra que a casa já aplica a
`AI_PROVIDER`. Parece severo e é o oposto: sem essa barreira o typo cairia no
provedor `mock`, e um mock em produção responde `Bitz (mock): recebi "..."`
**como se fosse resposta de verdade**, com `ok:true`, a cota do dia debitada e
nada no log. Falhar no boot é barulhento e você conserta em um minuto; falhar
assim é silencioso e cobra do cliente.

Como segunda camada, se a rota chegar ao runtime com provedor desconhecido (um
script fora do caminho de boot, por exemplo), o Bitz devolve
`provedor_desconhecido` e se declara indisponível — nunca vira mock.

⚠️ **`AI_PROVIDER=deepseek` precisa estar no allowlist do boot.** Ele está — e
essa linha existe porque a primeira versão desta entrega **não** o tinha: o
valor que este documento manda usar teria derrubado a API inteira (pedido,
NF-e, PDV, estoque), não só o Bitz. Há teste para isso agora.

**O kill-switch vence tudo.** Com `NEXT_PUBLIC_AI_MODULE_ENABLED` desligada,
nenhuma capacidade resolve, com ou sem rota.

## 5. Como conferir que pegou

Sem servidor, direto do código:

```bash
npx vitest run tests/ai-model-routing.spec.ts tests/ai-deepseek-provider.spec.ts --pool=forks
```

Com a API no ar: faça uma pergunta no chat e olhe a linha da conversa em
`AiMessage` — o provedor e o modelo de cada turno são gravados ali. Se o texto
ainda estiver saindo pelo Gemini, é porque `AI_ROUTE_TEXTO` não chegou ao
processo (a API foi reiniciada?).

## 6. O que ainda NÃO está ligado

`AI_ROUTE_IMAGEM` e `AI_ROUTE_AUDIO` **resolvem e têm teste, mas nada as chama
ainda**. Elas entram com a Fase 7 (áudio) e a Fase 8 (anexos). Estão declaradas
desde já para a configuração do cliente não precisar mudar quando aquelas fases
chegarem — e para que a decisão "qual modelo atende o quê" já esteja tomada e
documentada quando o código as consumir.

Hoje, o único caminho que consome roteamento é o turno de chat, e ele declara
`texto`.
