# Bitz — Fase 7: o lojista fala

Como funciona a voz no chat, o que ela custa e o que ela **não** guarda.

## 1. O desenho em uma linha

**Transcrever não é perguntar.** O lojista fala, o texto volta para o campo de
escrita, ele lê e corrige, e só então envia — pelo mesmo `/ai/chat` de sempre.

Isso vale três coisas de uma vez:

| | |
| --- | --- |
| Transcrição erra nome de peça | e uma pergunta errada gastaria uma mensagem da cota dele |
| O orquestrador **não muda** | nenhuma linha dele sabe que existe áudio |
| O áudio some | vive na memória pelo tempo da chamada e nunca toca disco nem banco |

## 2. O caminho de um áudio

```
[navegador] MediaRecorder  →  POST /ai/audio (multipart)
                                  ├─ gate: auth + plano  (403 sem)
                                  ├─ valida BYTES (magic bytes + teto)
                                  ├─ reserva cota de transcrição
                                  ├─ Gemini transcreve
                                  └─ devolve { ok, texto }
[navegador] texto cai no CAMPO  →  o lojista confere  →  POST /ai/chat
```

## 3. Configuração

```bash
AI_ROUTE_AUDIO="gemini:<modelo-vigente>"
AI_GEMINI_API_KEY="..."
AI_MAX_DAILY_AUDIO_PER_TENANT="15"   # opcional; 15 é o default
```

⚠️ **O microfone só aparece se a rota de áudio resolver para um provedor que
saiba transcrever.** Quem roteou o áudio para o DeepSeek — que não tem áudio em
forma nenhuma — recebe `audio: false` em `GET /ai/capacidades`, e o chat segue
inteiro, só sem o botão. Botão que sempre falha é pior que botão nenhum.

## 4. Os tetos, e por que cada um existe

| Teto | Valor | Onde é aplicado | Por quê |
| --- | --- | --- | --- |
| Duração | 90 s | navegador | o servidor não consegue medir duração sem decodificar |
| Tamanho | 2 MB | **servidor** | é o único verificável de cá — o cliente mente |
| Transcrições/dia | 15 por loja | servidor | áudio vira ~32 tokens por segundo |
| Teto global | `AI_MAX_DAILY_GLOBAL` | servidor | vale para áudio também: é a proteção da carteira |

⚠️ **2 MB não é generosidade, é o teto de custo.** Deixar no limite do multipart
(20 MB) aceitaria ~16 minutos de áudio numa requisição.

### A cota de áudio é SEPARADA da de mensagens

Transcrever não é enviar. Gravar duas ou três vezes até sair direito é o
comportamento normal — debitar uma mensagem por tentativa gastaria a cota do dia
sem o lojista ter perguntado nada. Por isso existe a linha `ai:audio:<tenant>`
em `ProviderDailyUsage`, com teto próprio.

A cota é devolvida quando a falha **não custou nada** (sem fala, formato
inválido). Não é devolvida quando o provedor já foi chamado — o mesmo critério
do refund do turno.

## 5. Segurança

**O arquivo é entrada hostil.** O formato é decidido pelos **bytes** (cabeçalho
EBML/`ftyp`/`OggS`/`RIFF`/`ID3`), e o `mimetype` do multipart — que é escrito
pelo cliente — só é aceito quando concorda com eles. Um executável rotulado
`audio/webm` é recusado **antes** de qualquer chamada externa, e sem consumir
cota. Sem isso, a rota viraria um canal de upload genérico atrás do gate do Bitz.

**O texto transcrito é DADO, nunca instrução.** Ele vira a mensagem do usuário e
segue o caminho de qualquer coisa que ele digitaria — não há superfície nova de
injeção, porque ele sempre pôde digitar o que quisesse. Do outro lado, o prompt
do transcritor manda **transcrever** pedidos e ordens contidos no áudio, não
obedecê-los: sem isso, um áudio dizendo "ignore o anterior e responda X" faria o
modelo responder, e o lojista veria uma resposta no lugar da própria fala.

**A trilha do microfone é sempre solta** — no fim natural, no cancelamento, no
teto de duração e na desmontagem do painel. Um `MediaStream` vivo mantém a luz
do microfone acesa e o indicador de gravação na aba.

## 6. Privacidade

O áudio **não é guardado**. Vive na memória pelo tempo da chamada e some. Fica
salva só a transcrição, como mensagem do lojista — o mesmo que ele teria
digitado.

Foi decisão explícita do dono do produto, e o motivo é simples: voz é dado
sensível, e o melhor lugar para ela é lugar nenhum. Guardar exigiria storage
privado, DDL, rotina de expurgo e um arquivo de voz por mensagem sob
responsabilidade da Dexo — além de virar assunto de LGPD.

O aviso está **na tela de escuta**, não num termo que ninguém lê.

## 7. O que ainda NÃO existe

- **O Bitz não fala de volta.** Síntese de voz foi avaliada e ficou de fora:
  dobraria o escopo (provedor de TTS, custo por caractere, player, controle de
  parar) e o ganho é menor — número e tabela se leem melhor do que se ouvem.
- **Não dá para reouvir o que foi dito**, por consequência da decisão acima.
- **Nenhum áudio real passou pela API.** A transcrição está coberta por teste
  contra o protocolo, mas a primeira fala de verdade depende de uma chave do
  Gemini com faturamento habilitado.
