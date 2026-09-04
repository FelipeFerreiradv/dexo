# Módulo Fiscal — Integração Direta com SEFAZ

> Substituição do provedor externo Focus NFe por comunicação direta com as
> SEFAZ estaduais para emissão de NFe modelo 55 v4.00.

> **Hardening (revisão adversarial multi-agente, Opus 4.8):** após a
> implementação inicial, todo o módulo passou por uma auditoria adversarial
> (84 + 11 agentes) que confirmou o núcleo criptográfico correto e identificou
> bugs fiscais reais — todos corrigidos. Ver §11.

---

## 1. Visão geral

O módulo fiscal do Dexo (Notas Fiscais) historicamente emitia NFe via Focus
NFe, um serviço pago que abstrai a comunicação com cada SEFAZ. O custo do
provedor ficou inviável, e por isso foi construída uma **integração direta
com as SEFAZ** que respeita o mesmo contrato (`INfeProvider`) — a troca de
provedor é uma mudança de configuração por empresa, não uma reescrita.

**Estado atual do código (fases F-A..F-H completas):**

| Capacidade | Focus NFe | SEFAZ direto |
|---|---|---|
| Emitir NFe modelo 55 (síncrono) | ✓ | ✓ |
| Consultar status de NFe | ✓ | ✓ (por chave) |
| Cancelar NFe (evento 110111) | ✓ | ✓ |
| Inutilizar faixa de numeração | ✓ | ✓ |
| Carta de Correção (evento 110110) | ✗ (API não expõe) | ✓ |
| Status do serviço (cStat 107) | implícito | ✓ |
| Contingência SVC-AN / SVC-RS | abstraído | ✓ opt-in |
| DANFE a partir do XML autorizado | — | ✓ (caminho preferencial) |

**Filosofia:**

- Adapter pattern (`INfeProvider`) preservado — código existente do Focus
  segue intocado.
- Migração por empresa via `CompanyFiscalConfig.providerName`. Rollback =
  alterar 1 campo no banco.
- Homologação obrigatória antes de produção.
- Audit log de cada chamada SEFAZ (request/response + cStat + protocolo).

---

## 2. Arquitetura

### 2.1 Camadas

```
┌─────────────────────────────────────────────────────────────────┐
│                        UI / Rotas Fastify                       │
│  /fiscal/nfe/:id/issue   /fiscal/nfe/:id/cancel                 │
│  /fiscal/inutilizacao    /fiscal/nfe/:id/carta-correcao         │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                          Use cases                              │
│  NfeEmissionUseCase                                             │
│  NfeCancelamentoUseCase                                         │
│  NfeInutilizacaoUseCase                                         │
│  NfeCartaCorrecaoUseCase                                        │
│                                                                 │
│  Detecta config.providerName:                                   │
│   - "FOCUS_NFE" → createNfeProvider (compacto)                  │
│   - "SEFAZ_DIRECT" → createNfeProviderFromConfig (async + cert) │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                  INfeProvider (interface)                       │
│  emitir / consultar / cancelar / inutilizar                     │
│  + opcionais: consultarStatusServico / cartaCorrecao            │
└─────────────┬────────────────────────────────────┬──────────────┘
              │                                    │
   ┌──────────▼──────────┐               ┌─────────▼─────────────┐
   │  FocusNfeProvider   │               │  SefazDirectProvider  │
   │  REST + Basic Auth  │               │  SOAP 1.2 + mTLS      │
   │  (intocado)         │               │  (novo, F-A..F-H)     │
   └─────────────────────┘               └───────────┬───────────┘
                                                     │
                          ┌──────────────────────────┼─────────────────────┐
                          │                          │                     │
                  ┌───────▼─────────┐    ┌───────────▼─────────┐  ┌────────▼──────────┐
                  │ NfeXmlBuilder   │    │ XmlSignerService    │  │ SoapClientService │
                  │ EventoBuilder   │    │ (xml-crypto)        │  │ (axios + mTLS)    │
                  │ InutilBuilder   │    │ XML-DSig + C14N     │  │ retry + Agent     │
                  └─────────────────┘    └─────────────────────┘  └────────┬──────────┘
                                                     │                     │
                                          ┌──────────▼──────────┐          │
                                          │ CertificateLoader   │          │
                                          │ (node-forge → PFX)  │          │
                                          └─────────────────────┘          │
                                                                           │
                                                                ┌──────────▼──────────┐
                                                                │  SEFAZ estadual /   │
                                                                │  SVC-AN / SVC-RS    │
                                                                │  (HTTPS + mTLS)     │
                                                                └─────────────────────┘
```

### 2.2 Stack de tecnologias

- **Runtime:** Node.js + TypeScript, Fastify 5 (backend), Next.js 15 (front)
- **Persistência:** PostgreSQL (Neon) via Prisma 6
- **XML construção:** `xmlbuilder2`
- **XML parsing:** `fast-xml-parser` (XXE-safe)
- **Assinatura:** `xml-crypto` (XML-DSig)
- **Certificado PFX:** `node-forge`
- **HTTPS + mTLS:** `axios` + `https.Agent`
- **PDF DANFE:** `pdf-lib`

### 2.3 Estrutura de arquivos

```
app/fiscal/
├── providers/
│   ├── nfe-provider.interface.ts     # Contrato INfeProvider
│   ├── focus-nfe.provider.ts         # Implementação Focus (intocada)
│   ├── sefaz-direct.provider.ts      # Implementação SEFAZ direto
│   └── provider-factory.ts           # createNfeProvider + createNfeProviderFromConfig
├── certificate/
│   ├── certificate-manager.service.ts  # Encripta/desencripta senha
│   └── certificate-loader.service.ts   # Parse PFX, cache TTL
├── sefaz/
│   ├── endpoints.ts                    # URLs por UF + AN + SVC-AN/SVC-RS
│   ├── chave-acesso.ts                 # Geração + DV mod 11
│   ├── cstat-mapper.ts                 # cStat → categoria
│   ├── xml-extract.ts                  # Regex helpers para parsing leve
│   ├── nfe-xml-parser.service.ts       # Parser tipado de <nfeProc>
│   ├── nfe-xml-builder-sefaz.service.ts  # Build XML modelo 55 v4.00
│   ├── evento-xml-builder.service.ts   # Cancelamento + CCe
│   ├── inutilizacao-xml-builder.service.ts
│   ├── envelopes.ts                    # Wrappers SOAP 1.2
│   ├── xml-signer.service.ts           # XML-DSig
│   ├── soap-client.service.ts          # SOAP + mTLS
│   ├── contingencia.service.ts         # Detecção SEFAZ-down + roteamento SVC
│   └── xsd/README.md                   # Instruções para download dos XSDs
├── generators/
│   ├── nfe-xml-builder.service.ts      # Builder JSON Focus (intocado)
│   └── danfe-pdf.service.ts            # PDF DANFE — generate(DB) + generateFromXml(XML)
└── domain/
    ├── nfe.types.ts                    # Enums, status machine
    └── fiscal-errors.ts

app/usecases/
├── nfe-emission.usecase.ts             # Fork por providerName + auto-fallback SVC
├── nfe-cancelamento.usecase.ts         # Fork por providerName
├── nfe-inutilizacao.usecase.ts         # Fork por providerName
└── nfe-carta-correcao.usecase.ts       # Novo — só SEFAZ_DIRECT

app/routes/
└── fiscal.routes.ts                    # Rotas fiscais (added: POST /fiscal/nfe/:id/carta-correcao)

scripts/fiscal/
└── smoke-status-servico.ts             # Smoke contra SEFAZ real

tests/fiscal/                           # 325 testes verdes (cobre todas as fases)
```

---

## 3. Setup

### 3.1 Dependências (já em `package.json` após F-H)

```json
{
  "dependencies": {
    "xml-crypto": "^6.0.0",
    "node-forge": "^1.3.1",
    "fast-xml-parser": "^5.8.0"
  },
  "devDependencies": {
    "@types/node-forge": "^1.3.0"
  }
}
```

Rode `npm install` após `git pull` para garantir.

### 3.2 Variáveis de ambiente

Edite `.env` no diretório raiz (não em worktree). Veja `.env.example` para o
template completo. As variáveis relevantes ao SEFAZ direto:

| Variável | Default | Descrição |
|---|---|---|
| `FISCAL_MODULE_ENABLED` | `true` | Liga o módulo fiscal no servidor |
| `NEXT_PUBLIC_FISCAL_MODULE_ENABLED` | `true` | Idem no front |
| `NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED` | `false` | Reemitir nota REJEITADA reaproveitando o mesmo número (botão "Tentar novamente" + banner do motivo). **Ligar só após o ALTER `cStatRejeicao` + `prisma generate`.** Off = reserva número novo na reemissão (comportamento atual) |
| `NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED` | `false` | Valor do frete, peso e medidas nas etapas Frete/Volumes. Liga o `<vFrete>` (total + rateio por item), a emissão do grupo `<vol>` (hoje o peso é digitado e **descartado** na montagem) e as dimensões no `<infCpl>`. **Ligar só após o ALTER `valorFrete` + `prisma generate`** (ver `docs/nfe-frete-medidas-sql.md`). Com modalidade **CIF** o frete passa a compor a **base do ICMS** — validar com o contador. Off = XML byte-idêntico ao atual |
| `FISCAL_PRODUCTION_UNLOCKED` | `false` | **Trava emissão em produção.** Só liga após validação |
| `FISCAL_STORAGE_PATH` | `C:/dexo-fiscal-storage` | Diretório onde XMLs e DANFEs ficam (precisa existir) |
| `FISCAL_CERT_ENC_KEY` | (vazio) | 32 bytes em hex (64 chars). Gere com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `SEFAZ_DIRECT_ENABLED` | `false` | Habilita o provider SEFAZ_DIRECT no factory |
| `SEFAZ_TIMEOUT_MS` | `60000` | Timeout HTTP das chamadas SOAP |
| `SEFAZ_RETRY_MAX` | `3` | Tentativas em ETIMEDOUT/ECONNRESET |
| `SEFAZ_CA_BUNDLE_PATH` | (vazio) | Caminho para CA bundle adicional (só se preciso) |
| `SEFAZ_AUTO_FALLBACK_ENABLED` | `false` | Auto-retry via SVC quando SEFAZ origem cair. Opt-in. |

**Atenção:** `FISCAL_CERT_ENC_KEY` **não pode mudar depois de gerada** —
senhas de certificado armazenadas no banco ficam ilegíveis. Tratar como
secret de produção.

### 3.3 Certificado A1

Você precisa de um **certificado digital A1** (arquivo `.pfx` ou `.p12`)
emitido por uma Autoridade Certificadora credenciada (Certisign, Serasa,
Valid, AC Soluti, etc.).

- Tipo: A1 e-CNPJ (renovação anual, ~R$ 200-400)
- Mesmo certificado serve para **homologação e produção**

**Caminho recomendado:** salve o `.pfx` em `FISCAL_STORAGE_PATH/certs/<userId>.pfx`.
A senha vai ser encriptada com AES-256-GCM via `FISCAL_CERT_ENC_KEY` e
guardada em `CompanyFiscalConfig.certificadoSenhaEnc`.

**Upload via UI:** `/notas-fiscais/configuracao` tem o stepper de
configuração fiscal que faz upload + encripta senha automaticamente.

### 3.4 Configuração da empresa (`CompanyFiscalConfig`)

Cada empresa (`userId`) tem um `CompanyFiscalConfig`. Para emitir via SEFAZ
direto, os campos obrigatórios:

| Campo | Exemplo | Notas |
|---|---|---|
| `cnpj` | `11222333000181` | Dígitos apenas |
| `razaoSocial` | `EMPRESA EXEMPLO LTDA` | |
| `inscricaoEstadual` | `123456789` | Sem máscara |
| `regimeTributario` | `SIMPLES` | `SIMPLES` / `LUCRO_PRESUMIDO` / `LUCRO_REAL` |
| `uf` | `SP` | **Obrigatório.** Define o endpoint SEFAZ |
| `codMunicipio` | `3550308` | IBGE (7 dígitos) |
| `municipio` | `SAO PAULO` | |
| `cep` | `01000000` | |
| `logradouro`, `numero`, `bairro` | | Endereço fiscal |
| `ambiente` | `HOMOLOGACAO` | **Sempre comece em homolog** |
| `providerName` | `SEFAZ_DIRECT` | (Era `FOCUS_NFE`) |
| `certificadoPath` | `C:/dexo-fiscal-storage/certs/abc.pfx` | Caminho absoluto |
| `certificadoSenhaEnc` | `iv:tag:cipher` | Encriptada automaticamente pela UI |
| `certificadoValidoAte` | `2027-05-14` | Extraído do `.pfx` |
| `certificadoSubjectCN` | `EMPRESA:11222333000181` | CN do titular do A1 — exibição + reconferência do CNPJ |

Para alterar via SQL (em vez de UI):

```sql
UPDATE "CompanyFiscalConfig"
SET "providerName" = 'SEFAZ_DIRECT',
    "uf" = 'SP',
    "ambiente" = 'HOMOLOGACAO'
WHERE "userId" = '<seu-user-id>';
```

### 3.5 Upload de certificado pela UI (self-service)

O stepper `/notas-fiscais/configuracao`, passo **Ambiente & Provedor**, permite:

1. Selecionar o provedor **SEFAZ Direto** no dropdown (antes só Focus NFe).
2. Enviar o `.pfx` + senha. A rota `POST /fiscal/config/certificate` (multipart:
   campo `certificate` = arquivo, campo `senha`) valida o A1 (abre com a senha,
   confere validade e o CNPJ pela base de 8 dígitos contra o emissor), grava em
   `FISCAL_STORAGE_PATH/certs/<userId>.pfx` (escrita atômica), cifra a senha
   (AES-256-GCM) e persiste `certificadoPath/SenhaEnc/ValidoAte/SubjectCN`.

Pré-requisito: salvar antes os dados da empresa (CNPJ/endereço) — a trava de CNPJ
precisa do emissor. O `setup-sefaz-direct.ts` continua válido para casos via CLI.

> **Deploy — migration obrigatória (aplicar ANTES do código):** este feature
> adiciona a coluna `certificadoSubjectCN`. Como o Prisma passa a selecioná-la,
> rode o ALTER **antes** de subir o build, senão a leitura do
> `CompanyFiscalConfig` quebra:
>
> ```sql
> ALTER TABLE "CompanyFiscalConfig"
>   ADD COLUMN IF NOT EXISTS "certificadoSubjectCN" TEXT;
> ```
>
> Em seguida `npx prisma generate` e o `next build`/restart dos serviços.

Segredos: `GET`/`PUT /fiscal/config` **não** devolvem mais `certificadoSenhaEnc`,
`certificadoPath` nem `providerToken` ao navegador — apenas os booleanos
`certificadoConfigurado` / `providerTokenConfigurado` + `certificadoValidoAte` /
`certificadoSubjectCN`. O form Focus reenvia o token vazio para **manter** o
salvo (só sobrescreve quando um novo é digitado).

---

## 4. Fluxos

### 4.1 Emissão (síncrona)

```
1. UI: usuário preenche wizard /notas-fiscais/nfe (9 steps) → rascunho salvo
2. POST /fiscal/nfe/:id/issue
3. NfeEmissionUseCase.emit:
   a. Load draft + config
   b. FiscalCalculatorService.calcular(regime, itens) → ICMS/PIS/COFINS
   c. NfeSequenceService.reservarProximoNumero(userId, ambiente, serie)
   d. Detecta config.providerName:
      - SEFAZ_DIRECT → createNfeProviderFromConfig (carrega cert)
        + monta SefazEmitPayload { draft, config, numero }
      - FOCUS_NFE   → createNfeProvider + builder JSON Focus
   e. provider.emitir({ nfeData, token, ref: nfeId })
4. SefazDirectProvider.emitir:
   a. NfeXmlBuilderSefazService.build → <NFe><infNFe>...</infNFe></NFe>
   b. XmlSignerService.sign → adiciona <Signature> após </infNFe>
   c. buildEnviNFeEnvelope → SOAP 1.2 com indSinc=1 (síncrono)
   d. SoapClientService.send → HTTPS + mTLS para NFeAutorizacao4 da UF
   e. parseRetEnviNFe:
      - cStat 100 (autorizada) → success + protNFe inline → nfeProc completo
      - cStat 539/218 (duplicidade) → success idempotente
      - cStat 103 (lote recebido async) → status="processando"
      - Outros → rejeitada
5. F-G: se SEFAZ_AUTO_FALLBACK_ENABLED && shouldFallbackToSvc(result):
   a. Audit log CONTINGENCIA_SVC
   b. Retenta com contingencia="SVC_AN" ou "SVC_RS"
   c. Nova chave (tpEmis=6 ou 7), novo XML, nova assinatura
6. handleAuthorized:
   a. Status AUTHORIZED no banco
   b. Salva XML autorizado (nfeProc) em FISCAL_STORAGE_PATH
   c. DanfePdfService.generateFromXml(xml) → PDF do DANFE
   d. Audit log AUTORIZADA
```

### 4.2 Cancelamento (evento 110111)

```
POST /fiscal/nfe/:id/cancel { justificativa: "..." }

NfeCancelamentoUseCase.cancel:
  1. Valida justificativa ≥15 chars
  2. Valida NFe status = AUTHORIZED + janela 24h
  3. provider.cancelar({ chaveAcesso, protocolo, justificativa, token })
  4. SefazDirectProvider:
     a. EventoXmlBuilderService.build (tpEvento=110111, Id 54 chars)
     b. Sign referenciando "infEvento"
     c. envEvento → SOAP RecepcaoEvento4
     d. Parse: cStat 135 = vinculado, 573 = duplicidade idempotente
  5. Audit log CANCELADA
  6. Transition AUTHORIZED → CANCELLED
```

### 4.3 Inutilização de faixa

```
POST /fiscal/inutilizacao { serie, numeroInicial, numeroFinal, justificativa }

NfeInutilizacaoUseCase.inutilizar:
  1. Valida range + justificativa
  2. Cria NfeInutilizacao PENDENTE
  3. provider.inutilizar(...)
  4. SefazDirectProvider:
     a. InutilizacaoXmlBuilderService.build (Id 43 chars com cUF+ano+CNPJ+mod+serie+faixa)
     b. Sign referenciando "infInut"
     c. SOAP NfeInutilizacao4 (endpoint da UF)
     d. Parse: cStat 102 = homologada
  5. Update NfeInutilizacao para ACEITA/REJEITADA
  6. Avança NfeSequence.proximoNumero para numeroFinal+1 se aceita
```

### 4.4 Carta de Correção (evento 110110) — exclusivo SEFAZ direto

```
POST /fiscal/nfe/:id/carta-correcao { correcao: "Correcao na natureza..." }

NfeCartaCorrecaoUseCase.execute:
  1. Valida nota AUTORIZADA + correcao 15..1000 chars
  2. Conta CCes prévias para essa NFe → próxima sequencia (limite 20)
  3. Valida providerName=SEFAZ_DIRECT (rejeita Focus com mensagem clara)
  4. provider.cartaCorrecao({ chaveAcesso, correcao, sequencia })
  5. SefazDirectProvider:
     a. EventoXmlBuilderService.build (tpEvento=110110 + xCondUso obrigatório)
     b. Sign + envEvento + SOAP RecepcaoEvento4
     c. Parse: cStat 135 = vinculada, 573 = duplicidade
     d. Em sucesso: procEventoNFe = evento + retEvento (XML canônico)
  6. Audit log CCE_ENVIADA { sequencia, cStat, protocolo, correcao }
```

### 4.5 Contingência SVC

Opt-in via `SEFAZ_AUTO_FALLBACK_ENABLED=true`.

```
Tentativa normal (tpEmis=1, SEFAZ origem)
  ├─ Sucesso → segue fluxo normal
  └─ Falha tipo infra (cStat 108/109/280-289 ou status="erro")
      └─ shouldFallbackToSvc(result) = true
          └─ Audit log CONTINGENCIA_SVC { svcType, motivo, cStat origem }
              └─ Retenta com contingencia=SVC_AN|SVC_RS conforme UF:
                  ├─ Builder usa tpEmis=6 (SVC_AN) ou 7 (SVC_RS)
                  ├─ Chave de acesso muda (cDV recalculado)
                  ├─ XML re-assinado
                  └─ Envia para endpoint SVC (não SEFAZ origem)
                      ├─ Sucesso → CONTINGENCIA_OK no audit log
                      └─ Falha → CONTINGENCIA_FALHOU no audit log
```

Mapeamento UF → SVC primário (NT 2014.002):

- **SVC-AN:** AC, AL, AP, CE, DF, ES, MG, PA, PB, PI, RJ, RN, RO, RR, SC, SE, SP, TO
- **SVC-RS:** AM, BA, GO, MA, MS, MT, PE, PR, RS

---

## 5. Operação

### 5.1 Smoke test (status do serviço)

Valida toda a stack SEFAZ direto contra homologação real sem emitir
nada — só `NfeStatusServico4`.

```bash
# 1. Preencher .env (DATABASE_URL, FISCAL_CERT_ENC_KEY)
# 2. Configurar CompanyFiscalConfig com cert + UF (via UI ou SQL)
# 3. Rodar:
npx tsx scripts/fiscal/smoke-status-servico.ts --user-id=<seu-id>
```

Saída esperada:

```
Empresa:
  CNPJ:           11222333000181
  Razao social:   EMPRESA TESTE
  UF:             SP
  Ambiente:       HOMOLOGACAO
  Provider:       SEFAZ_DIRECT
  Cert path:      C:/dexo-fiscal-storage/certs/<hash>.pfx

Chamando NfeStatusServico4 ...

Latencia:       847 ms
cStat:          107
xMotivo:        Servico em Operacao
verAplic:       SVRS202604140924
emOperacao:     SIM ✓

✓ Smoke OK — toda a stack SEFAZ direto esta funcional.
```

Se voltar cStat ≠ 107, ver Troubleshooting.

### 5.2 Troca de provider por empresa

**De Focus para SEFAZ direto:**

```sql
UPDATE "CompanyFiscalConfig"
SET "providerName" = 'SEFAZ_DIRECT'
WHERE "userId" = '<id>';
```

Próxima emissão usa SEFAZ direto. Não desfaz NFes já emitidas via Focus —
essas continuam autorizadas oficialmente.

**Rollback (volta para Focus):**

```sql
UPDATE "CompanyFiscalConfig"
SET "providerName" = 'FOCUS_NFE'
WHERE "userId" = '<id>';
```

Efeito instantâneo na próxima emissão. Pré-requisito: `providerToken`
ainda válido em `CompanyFiscalConfig`.

### 5.3 Audit log e XMLs salvos

Toda chamada SEFAZ deixa rastro em `NfeAuditLog`:

| Evento | Disparado em |
|---|---|
| `CRIADA` | Criação do rascunho |
| `EDITADA_DRAFT` | Save de etapa |
| `NUMERADA` | Reserva atômica de número |
| `ENVIADA` | Antes do POST ao provider |
| `AUTORIZADA` | cStat 100 / 150 |
| `REJEITADA` | cStat de rejeição |
| `CANCELADA` | Evento 110111 OK |
| `INUTILIZADA` | Inutilização aceita |
| `XML_REENVIADO` | E-mail enviado |
| `CCE_ENVIADA` | CCe enviada (com sequência) |
| `CONTINGENCIA_SVC` | Auto-fallback disparado |
| `CONTINGENCIA_OK` | Reenvio via SVC autorizou |
| `CONTINGENCIA_FALHOU` | Reenvio via SVC rejeitou |

XMLs salvos em `FISCAL_STORAGE_PATH/<userId>/`:

```
<userId>/
├── xml-original/
│   └── <nfeId>.json   # Payload de entrada (SEFAZ direto salva snapshot redatado)
├── xml-autorizado/
│   └── <nfeId>.xml    # <nfeProc> autorizado (formato canônico de arquivamento)
└── danfe/
    └── <nfeId>.pdf
```

### 5.4 Rollback rápido em produção

Se uma empresa começar a falhar em produção via SEFAZ direto:

1. **Imediato** — alterar `providerName` no banco para `FOCUS_NFE` (próxima emissão volta ao Focus).
2. **Investigar** — ver últimos `NfeAuditLog` da empresa para cStat / mensagem.
3. **Se for cert** — renovar/reuploadar via `/notas-fiscais/configuracao`.
4. **Se for tabela SEFAZ desatualizada** — atualizar `app/fiscal/sefaz/endpoints.ts` e redeploy.

---

## 6. API

### 6.1 Rotas fiscais que disparam SEFAZ

```
POST   /fiscal/nfe/:id/issue
Body:  {}  (use case detecta providerName)
Resp:  { success, nfeId, status, numero, serie, chaveAcesso, protocolo, mensagem }

POST   /fiscal/nfe/:id/cancel
Body:  { justificativa: string ≥15 chars }
Resp:  { success, nfeId, status, protocolo, mensagem }

POST   /fiscal/inutilizacao
Body:  { serie, numeroInicial, numeroFinal, justificativa }
Resp:  { success, id, protocolo, mensagem, sequenciaAjustada }

POST   /fiscal/nfe/:id/carta-correcao    # F-F — só SEFAZ_DIRECT
Body:  { correcao: string 15..1000 chars }
Resp:  { success, nfeId, sequencia, protocolo, cStat, mensagem }

POST   /fiscal/nfe/:id/resend-email
Body:  { email }
Resp:  { success, mensagem }
```

### 6.2 Rotas auxiliares

```
GET    /fiscal/config         # CompanyFiscalConfig do usuário logado
PUT    /fiscal/config         # Update da config
GET    /fiscal/nfe            # Listagem com filtros
GET    /fiscal/nfe/stats      # Cards do topo
GET    /fiscal/nfe/:id        # Detalhe
GET    /fiscal/nfe/:id/events # Audit log
GET    /fiscal/nfe/:id/xml    # Download do XML autorizado
GET    /fiscal/nfe/:id/danfe  # Download do DANFE
GET    /fiscal/nfe/export?format=xlsx|pdf
```

---

## 7. Troubleshooting

### 7.1 Smoke retorna `cStat: -1` com mensagem "Erro de rede"

- Cert inválido ou senha errada → recheque `certificadoSenhaEnc`
- Cert expirado → veja `certificadoValidoAte`
- Firewall corporativo bloqueando saída para SEFAZ (porta 443 com mTLS)
- TLS 1.2 indisponível no host (raríssimo)

### 7.2 Smoke retorna `cStat: 108` ou `109`

SEFAZ paralisada momentaneamente. Não é problema seu — espera ou liga
`SEFAZ_AUTO_FALLBACK_ENABLED=true` para rotear via SVC automaticamente.

### 7.3 Emissão falha com cStat de 200+ (`Rejeicao schema XML`)

XML montado fora do esperado pela SEFAZ. Geralmente é:

- Campo obrigatório ausente na config (IM sem CNAE, endereço incompleto)
- NCM/CFOP inválido para a operação
- Destinatário com CPF/CNPJ malformado

Conferir o XML original salvo em
`FISCAL_STORAGE_PATH/<userId>/xml-original/<nfeId>.json` e a mensagem
detalhada em `NfeAuditLog`.

### 7.4 `Cannot find module 'fast-xml-parser'`

Rodar `npm install` (foi adicionada na F-H).

### 7.5 Chave de acesso com DV incorreto

Quase certamente quer dizer que houve manipulação manual da chave após
geração. O builder produz chave válida; só re-monte via
`montarChave()`. Não edite manualmente os 43 primeiros dígitos.

### 7.6 Cert no Windows: `Mac verify failure`

Senha do PFX está incorreta. Verifique que a senha encriptada em
`certificadoSenhaEnc` foi gerada com a mesma `FISCAL_CERT_ENC_KEY` que
está em uso hoje. Se a key mudou, é preciso reupload do .pfx.

### 7.7 XSDs

Validação XSD não está habilitada por padrão (o XML montado pelo nosso
builder é XSD-compliant por construção). Se quiser validar antes de
enviar, baixar PL_009_V4 do Portal Nacional e habilitar o validador
(extensão futura — ver `app/fiscal/sefaz/xsd/README.md`).

---

## 8. Limitações e roadmap

### 8.1 Cobertura atual

- **NFe modelo 55 v4.00** — único modelo suportado
- **CFOPs de venda comum (5102, 6102, etc.)** — cobertos
- **CFOPs de devolução, complementar, exportação** — funcionam se draft
  trouxer os dados certos, mas não há helpers específicos
- **ICMS-ST, FCP, ICMS-Desonerado** — schema cobre, builder gera campos
  vazios; ajustar conforme regra de negócio quando aparecer
- **NFC-e (modelo 65)** — fora de escopo (precisa CSC + QR code)

### 8.2 Roadmap pendente (fases plano original)

- **F-I** — Piloto em produção (1 empresa, monitoramento intenso, opcional modo shadow)
- **F-J** — Rollout incremental por UF
- **F-K** — Deprecação do FocusNfeProvider após 1 ciclo fiscal

### 8.3 Extensões possíveis

- UI dialog para CCe em `nfe-detail-sheet.tsx` (rota POST já existe)
- Modo EPEC (contingência off-line)
- Validador XSD plugável
- Dashboard de métricas SEFAZ (latência p95, distribuição de cStats, taxa de fallback)
- Script de rotação de `FISCAL_CERT_ENC_KEY` (re-encripta senhas)

---

## 11. Hardening — revisão adversarial (Opus 4.8)

O módulo passou por uma revisão adversarial multi-agente (9 dimensões + críticos,
com verificação independente de cada achado). **O núcleo criptográfico foi
confirmado correto** (C14N inclusiva, RSA-SHA1, Reference URI, posição do
`<Signature>`, X509 no KeyInfo, herança de namespace). Os bugs fiscais reais
encontrados foram corrigidos:

### Bloqueadores de emissão (corrigidos)
- **Homologação:** o literal "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR
  FISCAL" agora vai no `<dest><xNome>` (Rejeição 598), não no `infCpl`.
- **Ceará:** mapeado para SVRS (migrou em jan/2022); endpoints próprios removidos.
- **Fuso:** `dhEmi`/`dVenc`/`dhEvento` usam offset fixo `-03:00` (Brasília),
  independente do TZ do servidor; a `AAMM` da chave deriva do mesmo horário.
- **cNF (Rejeição 897):** geração e validação rejeitam dezenas repetidas e
  sequências; `cNF` agora é CSPRNG.
- **natOp** truncada a 60 com fallback.

### Integridade de dados / anti dupla-emissão (corrigidos)
- Transição `DRAFT→VALIDATING` **atômica** (anti duplo-clique/concorrência).
- Sem rollback para `DRAFT` após o envio à SEFAZ (mantém `SENDING` para
  reconciliação) — evita reemitir uma NF-e já autorizada.
- Contingência SVC só em indisponibilidade **explícita** (cStat 108/109/280-289);
  em timeout/rede ambíguo, **consulta a chave antes de reenviar** (só cai pra SVC
  se "não consta", cStat 217).
- Duplicidade (204/218/539) e `cStat 104` sem `protNFe` não viram mais
  `AUTHORIZED` com protocolo nulo — entram em reconciliação por consulta.
- Polling assíncrono por **recibo (nRec)** ou **chave**, nunca pelo `nfeId`
  interno; `consultarRecibo` (NFeRetAutorizacao4) implementado.

### Segurança (corrigido)
- `FISCAL_CERT_ENC_KEY`: **fail-closed em produção** — sem chave válida (64 hex),
  o boot aborta em vez de cair numa chave de dev hardcoded.

### DANFE
- Pagina automaticamente (não descarta itens); recusa gerar para XML não
  autorizado; CRT 4 (MEI) tratado como Simples.

### Limitações conhecidas (follow-ups, não bloqueiam emissão)
- **Código de barras Code 128C** da chave no DANFE: ainda não impresso (precisa
  de uma lib de Code128). O DANFE é documento auxiliar; o XML é o canônico.
- **Reconciliação de NF-e em `SENDING`:** quando uma emissão fica pendente
  (timeout/consulta inconclusiva), não há ainda um endpoint dedicado de
  "reconsultar e finalizar" — hoje é via nova emissão/consulta manual. Eventos
  no audit log: `ENVIO_INCERTO`, `CONTINGENCIA_ADIADA`, `XML_AUTORIZADO_PENDENTE`.
- **XML canônico após reconciliação por consulta:** quando a autorização é
  reconhecida só via consulta (sem `nfeProc` inline), o XML autorizado completo
  não é recuperado automaticamente (precisaria de `NFeDistribuicaoDFe`). Fica
  sinalizado por `XML_AUTORIZADO_PENDENTE`.
- **`cNF` não persistido:** em reenvio, uma nova chave é gerada. Para
  idempotência perfeita, persistir o `cNF`/chave da 1ª tentativa (requer campo
  no schema — fora do escopo atual).
- **Polling síncrono** (até ~9s) bloqueia o request de `/issue` quando a SEFAZ
  responde assíncrono. Raro com `indSinc=1`.

---

## Referências

- Portal Nacional NFe: https://www.nfe.fazenda.gov.br/portal/principal.aspx
- Webservices por UF: https://www.nfe.fazenda.gov.br/portal/webServices.aspx
- NT 2014.002 v4.00 (esquema atual): https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=33ol5hhSYZk=
- NT 2019.001 (Rejeição 897 — cNF): Portal Nacional NFe / Notas Técnicas
- Comunicado SEFAZ-CE — Migração NFe para SVRS (10/01/2022)
- xml-crypto: https://github.com/node-saml/xml-crypto
- node-forge: https://github.com/digitalbazaar/forge

---

**Última atualização:** após hardening da revisão adversarial Opus 4.8
(commits 6c889db / 500a109 / f4154eb / 1df8456).
344 testes fiscais verdes; 1106 na suíte completa; zero regressão.
Pronto para piloto em homologação real.
