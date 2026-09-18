# HANDOFF CLAUDE CODE → CODEX — Dexo · Evolução do módulo NF-e

## Identificação do handoff

| Campo | Valor |
|---|---|
| Projeto | Dexo (repositório `ghd-plataform`), ERP para desmanches, CDVs e lojas de autopeças |
| Tipo | **Inicial** (não existia handoff anterior) |
| Data/hora | 17/09/2026, por volta de 09:35 (horário de Brasília) |
| Branch | `claude/dexo-nfe-module-evolution-3abbea` |
| HEAD | `1549bc462e3f6e05280628fa401684f05449f028` (= `main` = o que roda em produção). **Nenhum commit foi criado nesta sessão.** |
| Worktree | `C:\Users\Casa\Documents\GitHub\ghd-plataform\.claude\worktrees\receivable-stock-listing-sync-9b376d` (o nome da pasta não bate com a branch; é normal) |
| Frente atual | Evolução do módulo fiscal NF-e: numeração transacional (V2), crash do `cStatRejeicao`, rejeição 974 da Kiko 4 X 4 via Focus, NF-e de devolução |
| Onde a sessão parou | Fim da **Onda 1** de implementação (fundações puras + testes de caracterização). A Onda 2 não começou. |

---

## Resumo de 60 segundos

- **Projeto:** Dexo. Frontend Next.js 15, API Fastify rodando via `tsx`, Prisma 6.2.1 **pinado**, Postgres no Supabase (São Paulo), produção numa VPS (nginx + pm2). O foco aqui é o módulo fiscal: NF-e modelo 55 e NFC-e 65, por **SEFAZ direto** ou **Focus NFe**.
- **Frente atual:** o usuário pediu, com a regra absoluta de **ZERO REGRESSÃO**:
  1. corrigir o salto de numeração, em que a tentativa que falha queima o número;
  2. corrigir o crash `cStatRejeicao "974"` (string numa coluna Int);
  3. isolar a Focus e explicar a rejeição 974 da Kiko 4 X 4;
  4. implementar a NF-e de devolução com ação rápida em "Notas emitidas".
- **Estado geral:**
  - Investigação completa, com evidência de produção, documentação fiscal e revisão adversarial.
  - Plano aprovado pelo usuário.
  - Implementação em cerca de **30%**:
    - F1 (conserto do crash do cStat) **concluída e validada**;
    - fundações puras da numeração V2, da devolução e do responsável técnico **concluídas e testadas**;
    - provedores em duas fases (SEFAZ) e cliente Focus V2 **concluídos e testados**;
    - testes de caracterização (goldens) e harness de emissão **concluídos**.
  - **Não há nada integrado ao fluxo de emissão ainda** (sem orquestrador V2, rotas, repositórios, UI). As flags novas não existem no `.env`, e nada disso roda em produção.
- **Validação atual:**
  - suíte `tests/fiscal` + adjacentes: **101 arquivos, 2.254 testes, 0 falhas**;
  - `tsc`: **98 erros = linha de base, 0 novos**;
  - suíte completa na base (1549bc4): 6.633/6.633.
- **Primeiro próximo passo:** reconfirmar o estado (comandos da §36) e implementar a **Onda 2A**: repositório e serviço da numeração V2 (`app/fiscal/numeracao/numeracao.repository.ts`, `numeracao.service.ts`, `numeracao.errors.ts`) conforme `docs/handoff-nfe-evolucao/01-numeracao-v2-final.md` §4.2–§4.4 e §4.9–§4.15.
- **Frentes restantes:**
  - Onda 2: dados/serviço da numeração, backend/XML da devolução, integração do responsável técnico
  - Onda 3: orquestrador V2 + integrações
  - Onda 4: frontend
  - Onda 5: script de diagnóstico + docs
  - Onda 6: gates completos, revisão do diff, validação em homologação, relatório final
- **Alertas críticos:**
  - `prisma db push` é **PROIBIDO**: há índices parciais fora do schema.
  - Nunca rodar `npm run api` apontando para produção: os workers mutam produção.
  - Não fazer emissão fiscal real sem aval explícito.
  - Não commitar/pushar sem pedido do usuário.
  - A regra da NT 2025.002 (referência por item na devolução) entra em **produção em 05/10/2026**.
  - Lacunas de numeração de setembro têm prazo legal de inutilização em **10/10/2026** (decisão humana).

---

## 1. Visão geral do projeto

- **Dexo:** sistema de gestão (estoque, anúncios em marketplaces ML/Shopee/Magalu, pedidos, financeiro, PDV, fiscal) para desmanches e lojas de autopeças. Em produção com clientes reais.
- **Módulo fiscal:**
  - emissão de NF-e 55 e NFC-e 65 com multi-CNPJ por tenant (`CompanyFiscalConfig` 1:N)
  - provedor por empresa: `providerName` = `SEFAZ_DIRECT` (mTLS com A1 próprio) ou `FOCUS_NFE` (API REST, token por empresa)
  - cancelamento, CC-e, inutilização, DANFE (pdf-lib), XML, listagem/estatísticas, importação de XML
- **Estado global:** o produto funciona em produção. Esta frente é aditiva e ainda não foi implantada.

## 2. Arquitetura e stack

| Camada | Tecnologia / local |
|---|---|
| Frontend | Next.js 15 (App Router), React, shadcn/ui (Radix), react-hook-form + zod. Páginas fiscais em `app/notas-fiscais/**` |
| API | Fastify em `app/api/api.ts` (via `tsx`), rotas em `app/routes/*.routes.ts` (fiscal: `app/routes/fiscal.routes.ts`, prefixo `/fiscal`) |
| Casos de uso | `app/usecases/*` (emissão: `nfe-emission.usecase.ts`; rascunho: `nfe-draft.usecase.ts`; cancelamento, inutilização, CC-e, listagem) |
| Repositórios | `app/repositories/*` (fiscal: `nfe.repository.ts`, `company-fiscal.repository.ts`) |
| Domínio fiscal | `app/fiscal/**`: `providers/` (Focus, SEFAZ direto, factory), `sefaz/` (builder XML, parser, SOAP, assinatura, cStat, chave), `sequence/` (numeração V1), `generators/` (payload Focus, DANFE), `storage/`, `certificate/` |
| Banco | Postgres (Supabase `sa-east-1`), Prisma 6.2.1 pinado. DDL manual em `prisma/ddl/*.sql` e `docs/*-sql.md` (não usar `prisma/migrations` para o fiscal) |
| Testes | vitest 1.6.1, ambiente `node`. O jsdom está quebrado: lógica de UI fica em módulos puros testáveis |
| Produção | VPS Hostinger (`ssh vps-assuncao`), `/var/www/dexo`, pm2 (`ecosystem.config.cjs`: `dexo-frontend` :3000, `dexo-api` :3333, `dexo-sync-orders`, `dexo-catalog-stats`) |

## 3. Estrutura do repositório (partes relevantes)

```
app/
  api/api.ts                      # bootstrap Fastify, registra rotas (/fiscal)
  routes/fiscal.routes.ts         # ~1554 linhas: config, companies, draft, issue, list, xml, danfe, cancel, cce, inutilizacao
  usecases/
    nfe-emission.usecase.ts       # emissão V1 (alterada só em handleRejected — F1)
    nfe-draft.usecase.ts, nfe-cancelamento.usecase.ts, nfe-inutilizacao.usecase.ts, finance.usecase.ts (PDV NFC-e)
  repositories/nfe.repository.ts  # updateDraft força DRAFT (causa R1), findEmitted, findExistingDraft
  fiscal/
    flags.ts                      # NOVO — flags por companyFiscalConfigId (allowlist) + tunables
    numeracao/                    # NOVO — cstat, tipos, estados, classificacao, decisao, log (núcleo puro V2)
    devolucao/                    # NOVO — tipos, contrato, modo-referencia, saldo, validacao, tributacao, montagem (puro)
    domain/                       # existente + NOVOS chave-acesso-dv.ts, devolucao-cfop.ts, resp-tec.ts
    providers/                    # focus-nfe.provider.ts (V1, intocado), sefaz-direct.provider.ts (+métodos 2 fases),
                                  # NOVOS focus-nfe-v2.client.ts, nfe-provider-resolver.ts
    sefaz/                        # builder XML, parser, soap, cstat-mapper (intocados) + NOVO digest.ts
    sequence/nfe-sequence.service.ts  # numeração V1 (intocado)
    storage/fiscal-storage.service.ts # +saveXmlTentativa
    certificate/                  # +NOVO fiscal-secret.ts
  notas-fiscais/                  # UI (wizard nfe-wizard.tsx, lista nfe-list.tsx, steps/*) — INTOCADA até agora
prisma/
  schema.prisma                   # +5 modelos novos (sem relação com modelos quentes)
  ddl/2026-09-18-*.sql            # NOVOS — 3 DDLs (numeração V2, resp-tec, devolução)
tests/fiscal/                     # specs existentes + NOVOS golden/, __harness__/, numeracao/, devolucao/, resp-tec/, 2 specs F1
docs/
  fiscal-sefaz-direto.md, multi-cnpj-sql.md, nfce-fase2-sql.md, nfe-frete-medidas-sql.md  # existentes
  handoff-nfe-evolucao/           # NOVO — plano aprovado, desenhos, revisão adversarial, relatórios da onda 1
HANDOFF_CODEX_NFE_EVOLUCAO.md     # este arquivo
```

## 4. Como executar

> O worktree **não tem `node_modules`**: as ferramentas vêm do repositório principal
> (`C:\Users\Casa\Documents\GitHub\ghd-plataform\node_modules`). Resolver por ancestral funciona porque o
> worktree fica dentro do repo principal. Nos comandos abaixo, `M=/c/Users/Casa/Documents/GitHub/ghd-plataform`.

| Ação | Comando (Git Bash, a partir do worktree) |
|---|---|
| Instalar deps | No repo principal: `npm ci`. ⚠️ O npm 11.6 local já dropou peers do lock; na VPS o lock é regenerado lá. `postinstall` roda `prisma generate`. |
| Frontend dev | `npm run dev` (Next) |
| API dev | `npm run api` (`tsx watch app/api/api.ts`). ⚠️ **Sobe workers que MUTAM o banco apontado pelo `.env`**; nunca contra produção. |
| Build | `DATABASE_URL=postgresql://b:b@127.0.0.1:5432/b DIRECT_URL=$DATABASE_URL node scripts/generate-build-id.mjs && node --stack-size=4000 $M/node_modules/next/dist/bin/next build` (o build **não** checa tipos: `ignoreBuildErrors`; roda eslint) |
| Testes (alvo) | `NODE_OPTIONS=--max-old-space-size=8192 node $M/node_modules/vitest/vitest.mjs run --root . --pool=forks <arquivos ou pastas>` |
| Suíte fiscal | idem com `tests/fiscal tests/finance-fiscal-draft.spec.ts tests/finance-nfce-endpoint.spec.ts tests/pdv-nfce-helper.spec.ts` |
| Suíte completa | idem sem argumentos, ~5 min. **Nunca** o pool `threads` (segfault); nunca rodar do repo principal (varre outros worktrees). |
| Tipos (gate real) | `node $M/node_modules/typescript/lib/tsc.js --noEmit --incremental false -p tsconfig.json > head.txt`; comparar como **multiconjunto** com a base via `node docs/handoff-nfe-evolucao/tscdiff.cjs base.txt head.txt` |
| Base limpa para comparar | worktree `C:\Users\Casa\Documents\GitHub\ghd-plataform\.claude\worktrees\tsc-base-1549bc4` (criado nesta sessão, detached em 1549bc4). A base tem **98** erros de tsc e 6.633 testes passando. |
| Lint | `ESLINT_USE_FLAT_CONFIG=false node $M/node_modules/eslint/bin/eslint.js --no-eslintrc --no-ignore -c .eslintrc.json <arquivos>` (**`--no-ignore` é obrigatório**, senão tudo sob `.claude/` é ignorado) |
| Prisma validate | `DATABASE_URL=postgresql://x:x@127.0.0.1:5432/x DIRECT_URL=$DATABASE_URL node $M/node_modules/prisma/build/index.js validate --schema prisma/schema.prisma` |
| Prisma generate | **Evitar.** O client é compartilhado com o repo principal e outros worktrees. As tabelas novas são acessadas por SQL cru justamente para não precisar gerar. Se for inevitável: backup de `$M/node_modules/.prisma/client`, gerar, testar e restaurar gerando com o schema do main. |
| DDL | Manual, no SQL editor do Supabase, **antes** de ligar a flag (ver §25). Nunca `prisma db push` nem `migrate`. |
| Postgres de teste (opcional) | Docker estava **desligado** nesta máquina (daemon indisponível). Os testes PG planejados são opt-in via `FISCAL_PG_TEST_URL`. |

## 5. Configuração e ambiente

- **Runtime local**: Windows 11, Node v24.20.0, Git Bash + PowerShell 5.1, repo com CRLF (`core.autocrlf=true`); arquivos novos foram escritos com LF (só gera aviso no `git add`).
- **O worktree não tem `.env`** (bom: o vitest lê `.env`). Nunca criar ou alterar `.env`.
- **Variáveis existentes relevantes** (nomes; valores de produção só quando não secretos):

| Variável | Uso | Produção (17/09) |
|---|---|---|
| `DATABASE_URL` / `DIRECT_URL` | banco (psql na VPS usa `DIRECT_URL`) | segredo |
| `FISCAL_CERT_ENC_KEY` | chave AES dos A1/segredos fiscais | segredo |
| `FISCAL_STORAGE_PATH` | XML/DANFE em disco | `/var/dexo-fiscal-storage` |
| `NFE_RESP_TEC_CNPJ` / `_XCONTATO` / `_EMAIL` / `_FONE` | responsável técnico **global** usado só pelo SEFAZ direto | CNPJ `68704837000155` ("Dexo System"); sem CSRT |
| `NFE_RESP_TEC_ID_CSRT` / `NFE_RESP_TEC_CSRT` | CSRT global | ausentes |
| `NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED` | reuso de número em rejeitada (V1) | `true` |
| `SEFAZ_AUTO_FALLBACK_ENABLED` | contingência SVC automática (V1) | `false` (manter) |
| `SEFAZ_TIMEOUT_MS` / `SEFAZ_RETRY_MAX` | transporte SOAP | `60000` / `3` |
| `FISCAL_MULTI_CNPJ_ENABLED`, `NEXT_PUBLIC_MULTI_CNPJ_ENABLED`, `NEXT_PUBLIC_DANFE_*`, `NEXT_PUBLIC_NFCE_ENABLED`, `NEXT_PUBLIC_NFE_*` | outras flags fiscais | ligadas |
| `NFE_PROVIDER_TOKEN_PROD` | existe no `.env` de produção, **não é lida pelo código** | legado |

- **Variáveis NOVAS** (lidas por `app/fiscal/flags.ts`; ainda **não** existem em nenhum `.env` e **não** foram documentadas no `.env.example`, o que é pendência):
  - `NFE_NUMERACAO_V2_ENABLED`, `NFE_NUMERACAO_V2_CONFIG_IDS` (allowlist de `companyFiscalConfigId`, `*` = todas, vazio = nenhuma), `NFE_NUMERACAO_V2_MODELOS` (default `55`), `NFE_NUMERACAO_V2_FOCUS_ENABLED`
  - `NFE_DEVOLUCAO_ENABLED`, `NFE_DEVOLUCAO_CONFIG_IDS`, `NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE` (default `2026-10-05`)
  - `NFE_RESP_TEC_EMPRESA_ENABLED`, `NFE_RESP_TEC_EMPRESA_CONFIG_IDS`
  - Tunables: `NFE_NUMERACAO_V2_NAO_CONSTA_MIN_MS`, `NFE_NUMERACAO_V2_LEASE_PRE_ENVIO_MS`, `NFE_NUMERACAO_V2_LEASE_SEFAZ_MS`, `NFE_NUMERACAO_V2_LEASE_FOCUS_MS`, `FOCUS_V2_POST_TIMEOUT_MS`, `FOCUS_V2_GET_TIMEOUT_MS`, `NFE_NUMERACAO_V2_COOLDOWN_REPETICAO_MS`, `NFE_NUMERACAO_V2_COOLDOWN_CONSUMO_INDEVIDO_MS`
  - Planejadas para a UI (ainda não lidas por código): `NEXT_PUBLIC_NFE_DEVOLUCAO_ENABLED`, `NEXT_PUBLIC_NFE_RESP_TEC_EMPRESA_ENABLED`
- **Convenção de flags:** o backend fiscal compara com `=== "true"` (outros módulos usam `"1"`; trocar desliga em silêncio). `NEXT_PUBLIC_*` é embutida no build (mudança exige rebuild).

## 6. Organização do desenvolvimento

O trabalho segue o **plano aprovado** `docs/handoff-nfe-evolucao/00-PLANO-APROVADO.md` (cópia de
`C:\Users\Casa\.claude\plans\system-reminder-you-are-operating-cryptic-island.md`), com fases F0–F10. A
execução foi reorganizada em **ondas** por dependência e por posse de arquivos, para permitir agentes em paralelo sem conflito:

| Onda | Conteúdo | Fases do plano | Estado |
|---|---|---|---|
| — | F1: crash do cStat (feito direto, antes das ondas) | F1 | **CONCLUÍDO** |
| — | Schema (5 modelos) + 3 DDLs | parte de F3/F6/F7 | **CONCLUÍDO** (não aplicado em banco) |
| 1 | Goldens + harness; núcleo puro V2; provedores 2 fases + Focus V2; domínio puro devolução; domínio puro RT | F0, F2, F4, partes puras de F6/F7 | **CONCLUÍDO** |
| 2A | Repositório/serviço/erros da numeração V2 + fake + testes PG opt-in | F3 | NÃO INICIADO |
| 2B | Devolução: parser (idDest etc.), builder SEFAZ com contexto, decorator Focus, repositório, use case, módulo de rotas | F7 | NÃO INICIADO |
| 2C | RT por empresa: repositório, use case, módulo de rotas, encanamento no provider SEFAZ e no V1, sanitize/redact/log, card de UI | F6 | NÃO INICIADO |
| 3A | Orquestrador V2 + despacho em `emit()` + rotas `/issue`, `consultar-situacao` e delete + `attachNumeracao` + `findEmitted` + ramos V2 de inutilização/cancelamento + `finance.usecase` opts + cenários 1–14 e ★ | F5 | NÃO INICIADO |
| 3B | Ganchos da devolução no orquestrador (saldo sob lock na transação da reserva, contexto antes do hash/digest), guarda de cancelamento da original, `findExistingDraft` | F7 | NÃO INICIADO |
| 4 | Frontend: lista/detalhe (menu Ações, ação rápida, ações V2) e wizard (modalidade devolução, passos, emissão V2) | F8 | NÃO INICIADO |
| 5 | Script de diagnóstico read-only, `docs/fiscal-numeracao-v2.md`, `docs/fiscal-devolucao.md`, `.env.example` | F9 | NÃO INICIADO |
| 6 | Gates completos, revisão adversarial do diff, validação em homologação (com aval), relatório final de 12 seções | F10 | NÃO INICIADO |

Registro de api: os módulos de rotas novos (devolução, RT) devem ser registrados em `app/api/api.ts` sob `/fiscal`,
pelo integrador, depois das ondas 2B/2C, para não haver dois agentes editando `api.ts`.

## 7. Frente/sessão atual

- **Por que existe:** o cliente Kiko 4 X 4 recebeu rejeição 974 e o sistema quebrou com PrismaClientValidationError. Números de NF-e pulam quando uma tentativa falha. Não há NF-e de devolução, e a SEFAZ vai exigir referência por item a partir de 05/10/2026.
- **Objetivo:** as quatro correções/funcionalidades, todas aditivas, com flag por empresa e **zero regressão**.
- **Começa em:** investigação (concluída) → plano (aprovado) → implementação em ondas (em andamento).
- **Termina em:** Definition of Done da §37 + relatório final de 12 seções pedido pelo usuário (lista no plano §10.3).

## 8. Estado no início desta sessão

### ANTES DESTA SESSÃO
- **Numeração V1**: `NfeSequenceService` reserva e comita `proximoNumero+1` antes do envio; o número é sobrescrito na linha da nota a cada tentativa.
- **Reuso de número**: só com status REJECTED e cStat 200–599. O wizard sempre rebaixa para DRAFT ao salvar (R1), o que na prática anula o reuso.
- **Focus**:
  - devolve cStat como string, o que crashava o Prisma (R3)
  - erros definitivos pré-SEFAZ ficam em SENDING para sempre (R4)
  - o builder envia `numero_nota`, que a Focus ignora (ela numera sozinha: R6)
- **Responsável técnico**: global via `.env`, só no SEFAZ direto.
- **Devolução**: inexistente (o select "Devolução" existe no wizard, mas sem nada por trás). Três tentativas de usuários em produção, todas REJECTED.

### APÓS O TRABALHO DESTA SESSÃO
- Diagnóstico completo com provas de produção (§9.1).
- F1 corrigida no V1 (sempre ligada).
- Fundações puras e testadas para V2, devolução e RT.
- Provedores em duas fases prontos e com paridade provada.
- Goldens travando o comportamento V1.
- Schema e DDLs escritos.
- **Nenhum fluxo novo ligado ou integrado**: produção inalterada.

## 9. Trabalho realizado nesta sessão

### 9.1 Investigação (read-only, código + produção + documentação oficial)
- **Produção (SSH/psql read-only):**
  - Kiko: user `cmrwc403q0axf18e8xs887f7n`, config `cmrxiixko1spi1837uhscntiy`, CNPJ 11386276000176, **PR/Colombo**, SIMPLES, HOMOLOGACAO, FOCUS_NFE, token próprio, A1 válido até 28/11/2026, série NF-e 3.
  - Auditoria mostrou:
    - 17/08, SEFAZ direto em PRODUÇÃO: 974 na série 1 (nº 4) e na série 3 (nº 1..7, um número por clique);
    - 16/09 via Focus: "Access token inválido" (produção e homologação), "Empresa ainda não habilitada", e 974 em homologação na nota `cmu4gzo2q0q4e18xpsr1zgzgr`, que recebeu os nº 1, 2, 3, 4 em 30 s com crash do Prisma a cada tentativa.
  - Payload Focus da nota 974: `cnpj_emitente` correto, **nenhum campo de responsável técnico**.
- **Causas do salto (R1–R6)**, provadas pela sequência `EDITADA_DRAFT → NUMERADA` na auditoria:
  - toda renumeração após rejeição foi precedida de edição; retries sem edição reaproveitaram o número;
  - 974 (≥600) nunca reaproveita;
  - erro local depois da reserva também renumera.
- **Impacto**: 80 notas autorizadas abandonaram 177 números, 26 rejeitadas 109, 12 SENDING 18; cerca de 9 clientes; 22 linhas SENDING em produção.
- **Focus**: as notas autorizadas têm nº 12/13/14 no banco e 3/4/5 na chave; chave gravada com "NFe" (47 chars). Dois tokens Focus aparecem compartilhados entre tenants diferentes.
- **Documentação oficial pesquisada**:
  - NT 2018.005 v1.52 (infRespTec, 972–978; 974 = fornecedor autorizado no UPD da Receita PR; CSRT obrigatório no PR em produção desde 01/04/2026)
  - NT 2025.002-RTC v1.51 (`det/DFeReferenciado{chaveAcesso,nItem}` obrigatório na devolução, `refNFe` proibido, 1010/1048/1072/1193/1194; produção **05/10/2026**)
  - NT 2026.009 (CFOP de devolução I08-140, exceção 1.949/2.949)
  - NT 2024.001 (denegação eliminada no modelo 55)
  - MOC 7.0 (rejeição não consome número; tPag 90 → 871; inutilização até o dia 10 do mês seguinte)
  - documentação e campos da Focus
- **Workflows**: um de investigação (16 agentes com crítico e verificação adversarial) e um de desenho (3 propostas de numeração + juiz + 4 desenhistas + 2 revisores adversariais, que apontaram 45 problemas, 5 deles bloqueadores). Resultado em `docs/handoff-nfe-evolucao/`.

### 9.2 Decisões do usuário (AskUserQuestion, 17/09)
1. Dexo controla a numeração também na Focus (envia `numero`+`serie`) e regrava o nº real lido da chave.
2. A Focus fica como responsável técnico da Kiko; criar configuração de RT por empresa, sem CNPJ fixo.
3. Histórico (~300 números abandonados, 22 SENDING): **só diagnóstico read-only**. Nada é liberado ou inutilizado automaticamente, e não entra botão novo para linhas legadas.
4. Devolução é **só fiscal**: não mexe em estoque.

### 9.3 F1 — crash do `cStatRejeicao` (CONCLUÍDO E VALIDADO)
- **Objetivo:** `"974"` não pode derrubar o Prisma; motivo e cStat precisam ficar gravados.
- **Estado anterior:** `handleRejected` gravava REJECTED e depois fazia `update({cStatRejeicao: "974"})`, que quebrava.
- **Solução:**
  - `app/fiscal/numeracao/cstat.ts` com `normalizarCStat(unknown): number|null` (1–4 dígitos com espaços → inteiro; resto → null) e `codigoProvedorNaoNumerico`.
  - `handleRejected` (`app/usecases/nfe-emission.usecase.ts`) passa a fazer **uma** escrita `{status:"REJECTED", motivoRejeicao, [cStatRejeicao normalizado quando NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED==="true"]}`.
  - Auditoria `REJEITADA {mensagem}` recebe `codigoProvedor` só quando o código não é numérico. O parâmetro virou `cStat?: unknown`.
- **Validação:**
  - `tests/fiscal/cstat-normalizacao.spec.ts` (27) e `tests/fiscal/handle-rejected-atomico.spec.ts` (6; o double do Prisma imita a validação Int) passam.
  - **Controle negativo:** os 6 testes falham no código original.
- **Estado atual:** pronto no V1. Com cStat numérico, o estado final é idêntico ao anterior.

### 9.4 Schema + DDL (CONCLUÍDO, NÃO APLICADO)
- `prisma/schema.prisma`: modelos `NfeNumeroReserva`, `NfeNumeroTentativa`, `CompanyFiscalRespTec`, `NfeDevolucao`, `NfeDevolucaoItem`.
  - Nenhuma coluna ou relação em modelos existentes; FKs só nos DDLs.
  - `prisma validate` OK. `prisma generate` **não** foi rodado.
- `prisma/ddl/2026-09-18-nfe-numeracao-v2.sql`, `2026-09-18-company-fiscal-resp-tec.sql`, `2026-09-18-nfe-devolucao.sql`: idempotentes, com CHECKs, RLS, verificação e rollback.
  - O índice parcial `NfeNumeroReserva_nfeId_vivo_key` vive só no banco.

### 9.5 Onda 1 — Goldens e harness (CONCLUÍDO) · `tests/fiscal/golden/**`, `tests/fiscal/__harness__/**`
- **Goldens** (`toMatchFileSnapshot`, 53 arquivos em `__snapshots__/`):
  - payload Focus (9 casos), XML SEFAZ (12 casos, incluindo RT com e sem CSRT e SVC)
  - tabela-verdade `shouldReuseNumero`/`lookupCStat`
  - `parseNfeXml`
  - resultados de `SefazDirectProvider.emitir` para erros e lotes
  - mapeamento HTTP do `FocusNfeProvider` V1
- **Harness** documentado em `__harness__/README.md`:
  - `createInMemoryPrisma`: fiel às colunas de 1549bc4 e aos uniques parciais de produção; lança PrismaClientValidationError/P2002
  - `FakeAuthority` (verdade da SEFAZ), `createScriptedProvider`, `createNumeracaoMemory` (contrato V1 com mutex por chave)
  - `world()` com seeds e `todasViolacoes`
- **`emit-v1-bug-reproducao.spec.ts`** documenta o bug V1 (100 autorizada → 101 rejeitada → edição → retry autoriza **102**; 974 sem edição → 102; falha de storage após reserva → 102). **Esses testes passam hoje e devem continuar passando** com as flags desligadas, porque descrevem o legado.
- **Defeitos V1 que os goldens travam (continuam existindo, ver §21):**
  - Focus 200/201 `autorizado` → `processando`
  - consultar 403/404/denegado → `processando`
  - inutilização com `erro_autorizacao` conta como sucesso e o protocolo sai sempre null
  - cancelamento com `erro_cancelamento` conta como sucesso
- 76 testes próprios, rodados duas vezes sem regravar snapshot.

### 9.6 Onda 1 — Núcleo puro da numeração V2 (CONCLUÍDO)
- **`app/fiscal/flags.ts`**:
  - `isFiscalFeatureOn(feature, configId, env)`
  - `isNumeracaoV2ParaEmissao(configId, modelo, providerName)`
  - `isDevolucaoAtiva(configId)`: exige devolução + V2 + "55" nos modelos
  - tunables (defaults: `naoConstaMinMs` 285000; lease SEFAZ 570000 com piso de 300000; lease pré-envio 600000; Focus 180000; timeouts Focus 45000/15000; cooldowns 60000/3600000)
  - `devolucaoRefItemProdDesde()`
  - `"*"` só vale sozinho
- **`app/fiscal/numeracao/tipos.ts`** (contratos compartilhados) e **`estados.ts`**: 11 estados, matriz de transições.
  - Acréscimos justificados: RESERVADO/REJEITADO→CONSUMIDO_EXTERNO e ABANDONADO→INUTILIZADO.
- **`classificacao.ts`**: tabelas SEFAZ, consulta SEFAZ, POST e GET da Focus.
  - Convenção: `acao==="NENHUMA"` ⇔ `estadoAlvo != null`.
  - 635 → INCERTO; 204/205/218 → consulta; 539/562/613 → `RECONCILIAR_539`; 206 → INUTILIZADO; 108/109 → RESERVADO.
  - 200–9999 comuns → REJEITADO; 404 da Focus só vale "não consta" com prova madura.
- **`decisao.ts`**: `decidirEntrada`, `decidirPreClaim`, `motivoTrocaChave`, `decidirAdocaoLegado`, `partesDaChave`, `decidirReadbackFocus`, `avaliarFaixa`, `mensagemBloqueiosFaixa`, `hashConteudo` (sha256 com chave estável).
- **`log.ts`**: `logNumeracao` com whitelist de campos (nunca token, senha ou CSRT).
- **Testes** `tests/fiscal/numeracao/{flags,estados,classificacao,decisao,log}.spec.ts`: 736 testes.

### 9.7 Onda 1 — Provedores em duas fases e cliente Focus V2 (CONCLUÍDO)
- **`sefaz-direct.provider.ts`**: **só acréscimos** (+596/−0).
  - `prepararEmissao` (lança em falha local; `respTec` undefined=env, null=omitir, objeto=usar)
  - `transmitirPreparada` (nunca lança), `consultarDetalhado`, `consultarReciboDetalhado`, `static montarNfeProc`
  - `emitir()` e os demais métodos intocados
- **Teste de paridade**: envelope, endpoint, action, timeout e retry **idênticos** aos de `emitir()` (55 homologação, 55 produção, com e sem RT, 65).
- **`app/fiscal/sefaz/digest.ts`**: `extrairDigestValue`.
- **`fiscal-storage.service.ts`**: `saveXmlTentativa` (+24/−0; flag `"wx"`; retorna caminho completo).
- **`app/fiscal/providers/focus-nfe-v2.client.ts`**: `FocusNfeV2Client` com `emitir`, `consultar` e `inutilizar` (sucesso só com `autorizado`+102).
  - `AbortSignal.timeout`, corpo lido como texto (o 401 vem em HTML), `Retry-After`, chave normalizada para 44 dígitos.
  - Token nunca aparece em resultado; texto que o contenha vira `[REDACTED]`.
- **Testes** `tests/fiscal/numeracao/{sefaz-two-phase,focus-client-v2,digest,storage-tentativa}.spec.ts`: 114.

### 9.8 Onda 1 — Domínio puro da devolução (CONCLUÍDO)
- **`app/fiscal/domain/chave-acesso-dv.ts`**: DV mod-11 sem `node:crypto`, cruzado com `chave-acesso.ts` em 200 chaves.
- **`app/fiscal/domain/devolucao-cfop.ts`**: 105 CFOPs de devolução, exceção 1949/2949, lista MEI, `mapearCfopDevolucao` (MAPEADO|ESCOLHA|SEM_INVERSO), `validarCfopVsIdDest`.
- **`app/fiscal/devolucao/`**:
  - `tipos.ts`
  - `contrato.ts`: contrato congelado da §6.3 do plano, validadores `parse*Body` sem zod, códigos de erro com HTTP
  - `modo-referencia.ts`: ITEM em homologação; em produção, NOTA antes de 05/10/2026 e ITEM a partir da data
  - `saldo.ts`: AUTHORIZED consome; VALIDATING/SIGNING/SENDING reservam; DRAFT/REJECTED só informam; CANCELLED/INUTILIZED ignorados; aritmética em 1/10000
  - `validacao.ts`: `validarDevolucao` com uma regra por rejeição, mais regras locais
  - `tributacao.ts`: allowlist de tags ICMS, proporcionalização, `requerRevisao`, `aplicarOverrideTributacao`
  - `montagem.ts`: `montarRascunhoDeOriginal`, só para VENDA_ENTRADA; nunca copia identificadores; texto com nº/série **reais da chave**
- **Testes** `tests/fiscal/devolucao/*.spec.ts`: 191.

### 9.9 Onda 1 — Domínio puro do responsável técnico (CONCLUÍDO)
- **`app/fiscal/domain/resp-tec.ts`** (seguro no client):
  - `modosPermitidos`, `REQUISITOS_RT_POR_UF` (PR exige RT + CSRT em produção + valida fornecedor UPD; AM/MS/PE/SC/TO exigem RT)
  - `validarRespTec`, `avisosRespTec`, `paraMensagemSemAcento`
- **`app/fiscal/providers/nfe-provider-resolver.ts`** (puro): `resolveNfeProviderConfig`, `resolveRespTec` (tabela de modos), `respTecParaPayloadSefaz`, `resolvedParaLog`.
- **`app/fiscal/certificate/fiscal-secret.ts`**: `encryptFiscalSecret`/`decryptFiscalSecret`, delegando ao `CertificateManagerService`.
- **Testes** `tests/fiscal/resp-tec/*.spec.ts`: 105, mais 10 de specs existentes relacionados.

## 10. Arquivos modificados (rastreados)

| Arquivo | Mudança | Importância |
|---|---|---|
| `app/usecases/nfe-emission.usecase.ts` | `handleRejected` atômico + normalização de cStat; import de `fiscal/numeracao/cstat` (+30/−10) | F1 em produção quando implantado. As ondas 3A e 2C vão mexer de novo (despacho V2 no topo; `respTec` no payload V1). |
| `app/fiscal/providers/sefaz-direct.provider.ts` | +596 linhas, só acréscimos (métodos de 2 fases) | Base do orquestrador V2. Não alterar `emitir()`. A onda 2C troca só a linha ~197 (`respTec`). |
| `app/fiscal/storage/fiscal-storage.service.ts` | +`saveXmlTentativa` | XML assinado persistido antes de transmitir |
| `prisma/schema.prisma` | +5 modelos | Documentação e proteção contra `db push`; nenhuma mudança em modelo existente |

## 11. Novos arquivos (não rastreados)

- **Produção (código):**
  - `app/fiscal/flags.ts`
  - `app/fiscal/numeracao/{cstat,tipos,estados,classificacao,decisao,log}.ts`
  - `app/fiscal/devolucao/{tipos,contrato,modo-referencia,saldo,validacao,tributacao,montagem}.ts`
  - `app/fiscal/domain/{chave-acesso-dv,devolucao-cfop,resp-tec}.ts`
  - `app/fiscal/providers/{focus-nfe-v2.client,nfe-provider-resolver}.ts`
  - `app/fiscal/sefaz/digest.ts`
  - `app/fiscal/certificate/fiscal-secret.ts`
  - Total: ~6.700 linhas.
- **DDL:** `prisma/ddl/2026-09-18-{nfe-numeracao-v2,company-fiscal-resp-tec,nfe-devolucao}.sql`.
- **Testes:**
  - `tests/fiscal/cstat-normalizacao.spec.ts`, `tests/fiscal/handle-rejected-atomico.spec.ts`
  - `tests/fiscal/golden/**` (7 specs, 2 fixtures, 53 snapshots)
  - `tests/fiscal/__harness__/**` (6 módulos + `harness.spec.ts` + README)
  - `tests/fiscal/numeracao/*.spec.ts` (9), `tests/fiscal/devolucao/*.spec.ts` (8), `tests/fiscal/resp-tec/*.spec.ts` (3)
- **Documentação de handoff:**
  - `HANDOFF_CODEX_NFE_EVOLUCAO.md` (este)
  - `docs/handoff-nfe-evolucao/`:
    - `00-PLANO-APROVADO.md`
    - `01-numeracao-v2-final.md` (desenho final da numeração, do juiz)
    - `02-devolucao-backend.md`, `03-devolucao-frontend.md`
    - `04-focus-cstat-resptec.md`: **só a seção C (RT) vale**; as seções A2/B da Focus no V1 foram descartadas (§16)
    - `05-testes-rollout.md`
    - `06`/`07`: desenhos alternativos, só referência
    - `08-revisao-adversarial.md`
    - `09-relatorios-onda1.md`: APIs exatas e notas de integração de cada agente
    - `tscdiff.cjs`: diff de tsc como multiconjunto

## 12. Arquivos removidos/substituídos

Nenhum arquivo foi removido. Nenhuma implementação existente foi substituída; `handleRejected` foi corrigido no lugar.

## 13. Decisões técnicas (com motivo)

1. **Numeração V2 como fluxo novo** (`NfeEmissaoV2Orchestrator`, ainda por implementar) com despacho no topo de `emit()`. O V1 fica intacto, porque o risco de regressão seria alto demais mexendo em 500 linhas críticas; flag desligada = V1 idêntico.
2. **Reserva × consumo por tabela-ledger** `NfeNumeroReserva` + `NfeNumeroTentativa`. Estados explícitos; o reuso é decidido pela reserva viva do documento (lida por `nfeId`), **não pelo status da nota**, o que neutraliza a R1 sem alterar `updateDraft`.
3. **Sem pool de números liberados.** Número abandonado não vai para outra nota; "nova nota = 102" vale ao pé da letra. Motivos: comportamento da Focus não confirmado, lock mais caro, e as lacunas passam a nascer só de ação explícita e confirmada.
4. **cNF fixo por número**, guardado na reserva: reenvio no mesmo mês gera a mesma chave, então uma autorização perdida volta como 204 e se reconcilia.
5. **Chave, digest e XML assinado gravados ANTES de transmitir** (duas fases); timeout ⇒ INCERTO ⇒ consulta madura antes de qualquer reenvio.
6. **V2 nunca faz contingência SVC automática** (o builder não gera `dhCont`/`xJust`); 108/109 mantêm o número.
7. **Uma ordem de lock global:** `NfeSequence` → `NfeNumeroReserva` → `NfeNumeroTentativa` → `NfeEmitida`.
8. **Flags por `companyFiscalConfigId`** (fail-closed, `*` = todas), não por userId, para não cobrir sem querer uma config nova de produção do mesmo tenant.
9. **Um único classificador** (`numeracao/classificacao.ts`) e um único normalizador (`numeracao/cstat.ts`). `cstat-mapper.ts` e `nfe-number-reuse.ts` não mudam.
10. **Numeração Dexo na Focus só dentro do V2** (sub-flag `NFE_NUMERACAO_V2_FOCUS_ENABLED`) + read-back do nº real da chave. É sticky por config: desligar exige alinhar o contador no painel Focus.
11. **Tabelas novas, nunca colunas em modelos quentes** (Prisma lista colunas explicitamente; coluna nova exige DDL antes do deploy). Acesso por **SQL cru** para não exigir `prisma generate`.
12. **Devolução só emite pelo V2**; a trava de saldo roda na mesma transação da reserva; o contexto de devolução é aplicado antes do hash/digest.
13. **Referência da devolução por modo:** ITEM (`DFeReferenciado`) em homologação e em produção a partir de 05/10/2026; NOTA (`refNFe`) em produção antes disso. **Nunca os dois** (1010).
14. **Tributação da devolução:** proporcional a partir do XML autorizado da original. Allowlist de tags ICMS (SN 102/103/300/400→ICMSSN102, 500, 900; CST 00, 40/41/50→ICMS40, 60, 90); fora dela ⇒ `requerRevisao`, emissão bloqueada até confirmação. Nada é inventado.
15. **Resolver central de RT** (`resolveNfeProviderConfig`): SEFAZ PADRAO = env atual; Focus PADRAO/PROVEDOR = não envia; PERSONALIZADO na Focus nunca envia `hash_csrt` (o hash depende do cNF gerado pela Focus).
16. **Perdedor do claim no V2 recebe 200 `emAndamento`** (V1 continua 500). O PDV já trata sucesso não autorizado como "processando".
17. **Assinaturas futuras:** `emit(userId, nfeId, opts?: {confirmarDescarteNumero?, actorUserId?})`, `handleAuthorized(..., extras?: {focusRef?, devolucao?})`.

## 14. Decisões de produto/UX

- As quatro decisões do usuário (§9.2).
- **Ação rápida**: "Notas emitidas → Ações → Emitir nota de devolução" abre o **wizard existente** (não um formulário paralelo), com banner "Emitindo devolução da NF-e nº X série Y" e revisão antes de emitir.
- **Pré-preenchimento**: destinatário, itens (NCM, unidade, valores do XML), CFOP mapeado (ou escolha obrigatória), idDest da original, `tPag 90` travado. Nunca copia id, chave, protocolo, XML, DANFE, status, número, ref, orderId ou numeroPedido.
- **Pergunta obrigatória** "a mercadoria foi entregue e devolvida?" (`devolvidaAposEntrega`, null na criação, true exigido na emissão). Recusa ou não entrega é finNFe 5, fora do escopo.
- **Devolução parcial**: 0..disponível por item; total trava as quantidades.
- **Troca de série, emitente ou ambiente** numa nota com número reservado em PRODUÇÃO exige confirmação de descarte (409); em homologação é automática.
- **Linhas legadas** mantêm o "Tentar novamente" atual; ações V2 só para notas V2.
- **Estatísticas e relatório mensal**: não mudam (zero regressão nos números).

## 15. Problemas resolvidos nesta sessão

| Problema | Causa | Solução | Arquivos | Validação |
|---|---|---|---|---|
| Crash `PrismaClientValidationError` com `cStatRejeicao:"974"` | Focus devolve cStat string; `handleRejected` fazia 2 updates | Normalização + update único | `app/fiscal/numeracao/cstat.ts`, `nfe-emission.usecase.ts` | 33 testes; controle negativo falha no código original |
| Diagnóstico do salto de numeração (antes era suspeita) | R1–R6 (§8) | Causas provadas; correção estrutural desenhada (V2) e fundações implementadas | — | Auditoria de produção + spec de reprodução V1 |
| Causa da 974 da Kiko (antes era hipótese de `.env`) | PR valida o CNPJ do RT contra o fornecedor autorizado no UPD; SEFAZ direto usava o CNPJ Dexo do `.env`; na Focus vai o RT da própria Focus | Correção externa (UPD) + RT por empresa (a integrar) | — | Payload real + NT 2018.005 + boletim SEFAZ-PR |

## 16. Tentativas descartadas

- **"Se erro → numero--" ou liberar números por status**: proibido pelo usuário e fiscalmente inseguro. Substituído pelo ledger com estados.
- **Pool de números liberados** (desenho A): descartado (decisão 13.3).
- **Endurecer a Focus dentro do V1** (desenho `04` seções A2/B1/B2/B3: `emitirV2` no provider V1, reuso derivado de auditoria, numeração Dexo sem V2): descartado pela revisão adversarial (dois classificadores, flags globais, criaria lacunas reais na SEFAZ). Substituído por `focus-nfe-v2.client.ts` + classificador único + V2.
- **Referência de devolução só por nota (`notasReferenciadasJson` → `refNFe`)**: inválida a partir de 05/10/2026 (NT 2025.002 v1.51); mantida só como modo NOTA em produção antes da data.
- **Allowlist por userId** (desenho do juiz): trocada por `companyFiscalConfigId`.
- **Colunas novas em `NfeEmitida`/`NfeItem`/`CompanyFiscalConfig`**: trocadas por tabelas novas.
- **Nomes `NfeNumeroFiscal`/`NfeEmissaoTentativa`/`LIBERADO`** (desenho de testes): substituídos por `NfeNumeroReserva`/`NfeNumeroTentativa`, sem LIBERADO.
- **Scripts com `\\` em heredoc no Git Bash**: perdem um nível de escape. Usar a ferramenta de arquivo para escrever scripts.
- **Postgres real local**: Docker indisponível; testes PG ficam opt-in.

## 17. Estado atual por área

- **CONCLUÍDO**:
  - F1 (crash do cStat)
  - diagnóstico completo
  - plano aprovado
  - schema + DDLs escritos
  - goldens/harness
  - núcleo puro V2 (flags, tipos, estados, classificação, decisão, log)
  - provedores em duas fases + cliente Focus V2
  - domínio puro da devolução
  - domínio puro do RT e resolver
- **CONCLUÍDO COM OBSERVAÇÃO**:
  - DDLs e schema: prontos, **não aplicados** em nenhum banco (a aplicação é na implantação, §33).
  - `montagem.ts` cobre só VENDA_ENTRADA a partir de nota do Dexo; o fluxo manual/COMPRA_SAIDA ainda precisa de `montarRascunhoManual`.
- **NÃO INICIADO**: ondas 2A, 2B, 2C, 3A, 3B, 4, 5, 6 (§6).
- **BLOQUEADO / DEPENDÊNCIA EXTERNA**:
  - validação positiva da Focus para a Kiko (depende da autorização no UPD PR e das confirmações do suporte Focus)
  - testes PG reais (Docker)
  - validação em homologação (exige aval do usuário)
- **FORA DO ESCOPO**:
  - finNFe 5/6 (nota de crédito/débito; recusa na entrega)
  - IBS/CBS na devolução
  - SVC V2
  - refatorar os 72 `(prisma as any)`
  - mudar estatísticas/relatório para descontar devoluções
- **INCERTO**: comportamento real da Focus com `numero` explícito e reenvio da mesma ref (a confirmar com o suporte ou em homologação).

## 18. O que está concluído (proteção contra retrabalho)

- `normalizarCStat` + `handleRejected` atômico, com testes e controle negativo.
- Goldens V1 (53 snapshots) + harness in-memory + spec de reprodução do bug V1.
- `flags.ts`, `numeracao/{cstat,tipos,estados,classificacao,decisao,log}.ts` com 736 testes.
- Métodos de 2 fases do `SefazDirectProvider` com paridade provada; `digest.ts`; `saveXmlTentativa`; `FocusNfeV2Client`.
- `devolucao/*` e `domain/{chave-acesso-dv,devolucao-cfop}.ts` com 191 testes.
- `domain/resp-tec.ts`, `nfe-provider-resolver.ts`, `fiscal-secret.ts` com 105 testes.
- 5 modelos no schema + 3 DDLs.

## 19. O que não deve ser reaberto sem motivo

- As 4 decisões do usuário e as 17 decisões técnicas (§13).
- O desenho final da numeração (`01-numeracao-v2-final.md`, com as correções do plano: allowlist por config, sem pool).
- O contrato de API da devolução (plano §6.3, implementado em `app/fiscal/devolucao/contrato.ts`).
- A tabela de classificação de cStat (inclui 635 → INCERTO e 539/562/613 → reconciliação).
- A regra "devolução só pelo V2".
- Os goldens: se um golden quebrar com as flags desligadas, **o código novo está errado**, não o golden.

## 20. Pendências reais

| # | Pendência | Prioridade | Depende de | Arquivos principais | Como validar | Riscos |
|---|---|---|---|---|---|---|
| P1 | **2A** Repositório/serviço/erros da numeração V2 (`reservarOuReutilizar`, `iniciarTransmissao`, `registrarResposta/Consulta`, `tomarLease`, `naoConstaConfirmado`, `devolverIncerto`, `marcarCancelado`, `abandonarPorExclusao`, `inutilizacaoGuard/Pos`, `focusRefPara`, `focusRefAutorizada`, `avancarContadorAtomico` com `GREATEST`) + fake em memória com mutex + testes; PG opt-in com guarda de host local | Alta | Onda 1 | `app/fiscal/numeracao/numeracao.{repository,service,errors}.ts`, `tests/fiscal/numeracao/*`, `tests/fiscal/pg/*` | specs; 20 reservas paralelas → 1..20; guarda `WHERE estado=$de`; nunca diminui contador | deadlock (seguir a ordem de lock), transação longa no pooler (sem rede dentro da tx) |
| P2 | **2C** RT por empresa integrado: repositório (SQL cru), use case (valida com `validarRespTec`, cifra CSRT), módulo de rotas `GET/PUT /fiscal/config/resp-tec` e `/fiscal/companies/:id/resp-tec`, linha ~197 do provider (`payload.respTec === undefined ? env : ...`), V1 preenche `respTec` só com a feature ligada para a config, `sanitizeFiscalConfig`/`redactConfig` sem `respTec`/`csrtEnc`, `"csrt"` no redator do logging middleware, card `steps/resp-tec-card.tsx` + `lib/resp-tec-card.ts` | Alta | Onda 1 | ver plano §F6 e desenho `04` §4 | goldens `sefaz-emitir-*-resptec-*` inalterados com a flag desligada; specs do plano §8.1 | vazar CSRT; regressão no RT global |
| P3 | **2B** Devolução backend: parser (`ide.idDest`, `emit.CRT`, NFref), builder SEFAZ com contexto (NFref modo NOTA; `DFeReferenciado` último filho de `det`; `impostoDevol`; tag ICMS pelo contexto; indFinal; tPag 90), decorator Focus (`chave_acesso_dfe_referenciado`, `numero_item_dfe_referenciado`, `notas_referenciadas` só no modo NOTA, `percentual_devolvido`), repositório (SQL cru; placeholder `-(count+1)`), use case (criar a partir da original, saldo, detalhe, cabeçalho, itens, manual com `montarRascunhoManual`), módulo de rotas | Alta (prazo 05/10) | Onda 1 | plano §6, desenho `02` | goldens sem contexto inalterados; goldens novos por grupo ICMS e modo; specs de contrato | rejeições 321/1010/327/871; PII do XML no SystemLog (redigir `xmlOriginal`) |
| P4 | **3A** Orquestrador V2 + despacho em `emit()` + rotas (`/issue` com `confirmarDescarteNumero` e `NumeracaoError`; `POST /fiscal/nfe/:id/consultar-situacao`; `DELETE draft?descartarNumero`) + `attachNumeracao` em todas as respostas de rascunho + `findEmitted` + ramos V2 de inutilização/cancelamento + `finance.usecase.ts:~1910` opts + degradação sem DDL (P2021/42P01) + preflight `to_regclass` | Alta | P1, P2 | `app/usecases/nfe-emissao-v2.orchestrator.ts`, `nfe-emission.usecase.ts`, `fiscal.routes.ts`, `nfe-draft.usecase.ts`, `nfe.repository.ts`, `nfe-inutilizacao.usecase.ts`, `nfe-cancelamento.usecase.ts` | **cenários 1–14 + ★** (plano §8.2) com o harness; `flag-off-regressao.spec`; goldens | regressão no V1; lease × retries SOAP; P2002 no read-back da Focus |
| P5 | **3B** Ganchos da devolução no orquestrador (validação pré-claim, trava de saldo na tx da reserva, cálculo de devolução, decorators antes do hash, `DEVOLUCAO_EMITIDA` pós-autorização), guarda de cancelamento da original (409 com advisory lock), `findExistingDraft` ignora devolução, guarda runtime "exige V2" | Alta | P3, P4 | idem + `nfe-devolucao.usecase.ts` | `devolucao-emissao-v2.spec` (DFeReferenciado e tPag 90 no transmitido), concorrência de saldo | devolução acima do saldo; cancelamento com devolução autorizada |
| P6 | **4** Frontend: `nfe-row-actions-menu.tsx` (DropdownMenu "Ações"), ação rápida, ações V2 com fallback legado, detail sheet; wizard (modalidade, painel, passo 3 com saldo, passo 7 tPag 90, passo 8 revisão de tributação, passo 9, banner, `emEnvioRef`, `interpretarRespostaEmissao`, diálogo de descarte); libs puras `nfe-devolucao.ts`, `nfe-devolucao-api.ts`, `nfe-numeracao-ui.ts` | Média | P4, P5 | desenho `03`; `app/notas-fiscais/**` | testes node das libs; `next build` duas vezes (flags off/on); DOM idêntico com flag off | gotcha RHF (efeito síncrono em `setValue`/`reset`: usar handlers, não `useEffect` em `useWatch`) |
| P7 | **5** `scripts/fiscal/diagnostico-numeracao-nfe.ts` (read-only com `SET TRANSACTION READ ONLY`, `--consultar` só na VPS com aval), `docs/fiscal-numeracao-v2.md`, `docs/fiscal-devolucao.md`, `.env.example` (nomes novos), memória dos índices parciais (+1) | Média | P1 | plano §5 | spec que lê o código-fonte e proíbe escrita | consultar SEFAZ/Focus em massa sem aval |
| P8 | **6** Gates completos: suíte inteira head × base (0 falhas novas), tsc multiconjunto (0 novos), eslint `--no-ignore` nos tocados, `next build` duas vezes, `prisma validate`; revisão adversarial do diff; relatório final de 12 seções | Alta | todas | plano §8.3 e §10.3 | comandos da §4 | — |
| P9 | Validação manual em **homologação** (10 fluxos do plano §10.2), **só com aval explícito** do usuário, em série dedicada | Média | P4–P6 | — | plano §10.2 | emissão real indevida |
| P10 | Limpeza: remover o worktree temporário `tsc-base-1549bc4` ao fim dos gates (`git -C <main> worktree remove <path>`) | Baixa | P8 | — | `git worktree list` | não remover `tsc-base-9343c57` (é de outra sessão) |

## 21. Bugs conhecidos (ainda existem em produção; V2 corrige quando ligado)

- **Salto de numeração R1–R6** (§8). Reproduzível com `tests/fiscal/golden/emit-v1-bug-reproducao.spec.ts`. Corrigido estruturalmente só com o V2 ligado.
- **Focus V1**:
  - 200/201 `autorizado` → tratado como `processando`
  - consultar 403/404/`denegado` → `processando` (pode fazer polling eterno)
  - inutilização com `erro_autorizacao` conta como sucesso e o protocolo sai sempre null
  - cancelamento com `erro_cancelamento` conta como sucesso
  - chave gravada com "NFe" (47 chars)
  - DANFE da Focus impresso com o nº falso do banco
  - Travados nos goldens `focus-v1-*.json`. Não corrigir no V1 sem decisão do usuário (o V2 usa o cliente novo).
- **SVC V1** reenvia o mesmo número com outra chave. Mitigado: `SEFAZ_AUTO_FALLBACK_ENABLED=false` em produção.
- **Reuso V1**: `shouldReuseNumero` ignora emitente e série (hoje mascarado pela R1). `cstat-mapper.ts` rotula 218 como "já foi autorizada" (o significado oficial é "já cancelada"); 205/206 caem como reaproveitáveis.
- **22 notas SENDING em produção** sem reconciliador, e cerca de 300 números abandonados (jun–set). Tratamento decidido: só diagnóstico (P7) e decisão humana; prazo legal de setembro é 10/10/2026.
- **Isolamento**: dois tokens Focus compartilhados entre tenants diferentes (só reportar).
- **Inutilização V1** não suporta modelo 65 e recusa série 0.

## 22. Dívida técnica

- 72 casts `(prisma as any)` no código fiscal (legado do commit 7fa5f99). Escondem erros de tipo; não refatorar nesta frente.
- Dois mappers manuais de `NfeDraftResponse` (`nfe.repository.ts` `toDraftResponse` e `nfe-emission.usecase.ts` `loadNfe`): campo novo precisa entrar nos dois.
- Legado da `NfeSequenceService` sem `opts` pula o nº 1 na primeira emissão (caminho não usado pela emissão).
- CST/CSOSN por item nunca é persistido (a emissão usa o default do regime).
- `NfeAuditLog.userId` guarda o dono do tenant, não o colaborador que agiu.

## 23. Testes e validações

### VALIDADO
| Comando | Ambiente | Resultado |
|---|---|---|
| vitest `tests/fiscal` + `finance-fiscal-draft`, `finance-nfce-endpoint`, `pdv-nfce-helper` (`--pool=forks`) | worktree, após a onda 1 | **101 arquivos, 2.254 testes, 0 falhas** |
| `tsc --noEmit --incremental false` head × base (multiconjunto) | worktree × `tsc-base-1549bc4` | base 98 / head 98, **0 novos**, 0 sumidos |
| vitest suíte completa | base 1549bc4 | 2.041 suites, **6.633/6.633** |
| `prisma validate` | worktree | válido |
| Controle negativo F1 | worktree com o arquivo revertido temporariamente | 6/6 falham sem o conserto |
| Paridade 2 fases × `emitir()` | spec | envelopes idênticos |
| Mutação (agentes W1d e W1e) | specs | mutações detectadas (W1e: 17/17) |

### IMPLEMENTADO, MAS NÃO VALIDADO
- Suíte **completa** no head (só a fiscal e adjacentes foram rodadas depois das mudanças).
- eslint dos arquivos novos com `--no-ignore` (W1b rodou nos seus arquivos: exit 0; os demais não).
- `next build` com as mudanças (nada de UI mudou, mas não foi rodado).
- DDLs: nunca executados em nenhum banco.

### NÃO TESTADO
- Qualquer integração real com SEFAZ/Focus (proibido sem aval; nenhum envio foi feito).
- Testes com Postgres real (Docker desligado).

## 24. Git

- **Branch**: `claude/dexo-nfe-module-evolution-3abbea`, HEAD `1549bc4` (igual a `main` e à produção).
- **Commits nesta sessão**: **nenhum**.
- **Staged**: nada.
- **Modificados**: 4 arquivos (§10). **Não rastreados**: 128 arquivos (§11), contando `docs/handoff-nfe-evolucao/` e este handoff.
- **Tudo pertence a uma única frente** (NF-e). Não há mistura com outras frentes.
- **Preservar**: todo o conteúdo não commitado. Se o Codex for trabalhar em outro checkout, o usuário precisa decidir se cria um commit WIP nesta branch ou se copia o worktree. **Não commitar nem pushar sem pedido explícito.**
- **Outros worktrees existentes**: `tsc-base-1549bc4` (criado nesta sessão, temporário); `tsc-base-9343c57` e demais **não são desta sessão**.
- **Gotchas**:
  - a pilha de `git stash` é compartilhada entre worktrees (nunca `stash pop` sem tag);
  - `git add -N` bloqueia `stash push -- arquivo`;
  - checar byte NUL em arquivos escritos por ferramenta (`LC_ALL=C.UTF-8 grep -lP '\x00'`).

## 25. Banco de dados

- **Postgres Supabase** (São Paulo). Em produção, `psql` via VPS usa `DIRECT_URL` (a `DATABASE_URL` tem `pgbouncer=true`, que o psql recusa):
  `ssh vps-assuncao 'set -a; . /var/www/dexo/.env; set +a; psql "$DIRECT_URL" -X -A -F"|"' <<'SQL' ... SQL` (heredoc local com delimitador entre aspas).
- **Modelos fiscais existentes**: `CompanyFiscalConfig`, `NfeSequence`, `NfeEmitida` (já tem `finalidade`, `tipoOperacao`, `notasReferenciadasJson`, `cStatRejeicao Int?`, `companyFiscalConfigId`), `NfeItem`, `NfeAuditLog`, `NfeInutilizacao`.
- **Índices únicos PARCIAIS só no banco** (não estão no schema):
  - `NfeEmitida_cfcId_ambiente_serie_numero_modelo_key (cfc, ambiente, serie, numero, modelo) WHERE cfc NOT NULL AND numero > 0`
  - `NfeEmitida_legacy_null_key`
  - `NfeSequence_cfcId_ambiente_serie_modelo_key`
  - `NfeSequence_legacy_null_key`
  - `CompanyFiscalConfig_userId_default_key`
  - Todos válidos em 17/09. ⛔ Por isso `prisma db push` é proibido.
- **Novos (não aplicados)**: 5 tabelas (§9.4). Ordem de implantação por DDL: código com flag desligada → DDL → verificação → flag por config.
- **Convenções**:
  - Coluna nova em modelo existente exige DDL **antes** do deploy; tabela nova pode ter código antes (com a flag desligada).
  - O SQL editor do Supabase roda em transação (`CONCURRENTLY` só por psql na VPS).
  - `EXPLAIN ANALYZE` de UPDATE executa: usar só dentro de transação com ROLLBACK.
- **Seeds**: não se aplica.

## 26. APIs e integrações

- **Rotas fiscais existentes** (prefixo `/fiscal`, `authMiddleware`, tenant = `request.user.dataOwnerId`): `GET/PUT /config`, `/companies*`, `POST/GET/PUT/DELETE /nfe/draft/:id`, `POST /nfe/draft/:id/calculate`, `POST /nfe/:id/issue`, `GET /nfe`, `/nfe/stats`, `/nfe/export`, `/nfe/relatorio-mensal`, `GET /nfe/:id`, `/xml`, `/danfe`, `/events`, `POST /nfe/:id/cancel`, `/carta-correcao`, `POST/GET /inutilizacao`, `POST /nfe/:id/resend-email`, `GET /nfe/proximo-numero`, lookups.
- **Rotas planejadas (não implementadas)**:
  - `POST /fiscal/nfe/:id/consultar-situacao`
  - devolução: `POST /fiscal/nfe/:id/devolucao`, `GET /fiscal/nfe/:id/devolucao/saldo`, `GET/PUT /fiscal/nfe/draft/:id/devolucao`, `PUT /fiscal/nfe/draft/:id/devolucao/itens`, `POST /fiscal/nfe/devolucao/manual`
  - RT: `GET/PUT /fiscal/config/resp-tec`, `/fiscal/companies/:id/resp-tec`
- **SEFAZ direto**: SOAP com mTLS (A1 por empresa), `SoapClientService` com retries do mesmo envelope.
- **Focus NFe**: REST v2 (`homologacao.focusnfe.com.br` / `api.focusnfe.com.br`), HTTP Basic com token por empresa, `ref` = id da nota (V2: `${nfeId}-n${numero}` só quando outro número já foi usado com a mesma ref).
  - Campos confirmados na documentação: `numero`/`serie` (numeração explícita), `cnpj_responsavel_tecnico`/`contato_`/`email_`/`telefone_responsavel_tecnico`/`identificador_csrt`/`hash_csrt`, `items[].chave_acesso_dfe_referenciado`/`numero_item_dfe_referenciado`, `percentual_devolvido`, `valor_ipi_devolvido`, `finalidade_emissao` 1..6.
- **Webhooks Focus**: existem na API deles; não usados pelo Dexo; fora do escopo.

## 27. Dependências externas

- **Banco/infra**: Supabase Postgres, VPS Hostinger (pm2/nginx).
- **Fiscal**: SEFAZ das UFs (e SVC), Focus NFe, certificados A1 ICP-Brasil, **Receita PR / UPD** (autorização do fornecedor de software), suporte Focus.
- **Regulatório**: Portal Nacional da NF-e (NTs vigentes).

## 28. UI/design

- **Nada de UI foi alterado ainda.**
- **Base a seguir**: shadcn/ui; padrão de menu "Ações" em `app/pdv/components/pdv-sale-actions.tsx` com decisão pura em `app/pdv/lib/pdv-actions.ts`; classes e banners descritos em `docs/handoff-nfe-evolucao/03-devolucao-frontend.md` §7.
- **Copy**: pt-BR.
- **Flags de UI**: `NEXT_PUBLIC_*` exige rebuild; com a flag desligada o DOM deve ser idêntico.

## 29. Assets e referências

- **Plano e desenhos**: `docs/handoff-nfe-evolucao/*` (§11).
- **Documentos oficiais citados**: URLs dentro de `08-revisao-adversarial.md`, `01`, `02` e `04`.
  - NT 2025.002 v1.51: `https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=AKD/muSmiIY=`
  - NT 2018.005 v1.52: `...conteudo=vZguLua3oPM%3D`
  - campos Focus: `https://campos.focusnfe.com.br/nfe/NotaFiscalXML.html`
- **Fixtures**: `tests/fiscal/golden/__fixtures__/`.

## 30. Documentação importante (ordem de leitura)

1. Este handoff.
2. `docs/handoff-nfe-evolucao/00-PLANO-APROVADO.md` (fonte de verdade das decisões; vence os desenhos em caso de conflito).
3. `docs/handoff-nfe-evolucao/09-relatorios-onda1.md` (APIs exatas e notas de integração).
4. `docs/handoff-nfe-evolucao/01-numeracao-v2-final.md` (para P1/P4).
5. `docs/handoff-nfe-evolucao/08-revisao-adversarial.md` (armadilhas que os desenhos originais tinham).
6. `02-devolucao-backend.md` (P3/P5), `03-devolucao-frontend.md` (P6), `04-focus-cstat-resptec.md` **só a seção 4 e a 5** (P2), `05-testes-rollout.md` (harness, gates, homologação, canário).
7. `tests/fiscal/__harness__/README.md`.
8. Existentes: `docs/fiscal-sefaz-direto.md`, `docs/multi-cnpj-sql.md`, `ecosystem.config.cjs` (regras de deploy).

## 31. Cuidados e armadilhas

- `prisma db push` e `migrate` são proibidos; DDL é manual (§25).
- Coluna nova em modelo quente quebra leituras `include` antes do DDL; por isso só tabelas novas e SQL cru.
- O `.env` do worktree (se alguém criar) é lido pelo vitest e pode apontar para produção; o worktree **não deve ter `.env`**.
- `npm run api` sobe workers que mutam o banco; abrir `/integracoes/*` pode rotacionar token do ML. Refresh de token ML a partir da máquina local derruba a conta do cliente.
- Emissão fiscal real: nunca sem aval explícito; preferir homologação e série dedicada sem uso.
- `updateDraft` rebaixa para DRAFT (R1): não "consertar" isso no V1; o V2 contorna lendo a reserva.
- Wizard: efeito do RHF dispara síncrono dentro de `setValue`/`reset` e já zerou formulário antes. Usar handlers explícitos.
- jsdom quebrado: teste de componente não funciona; extrair lógica para módulo puro.
- tsc mente de três jeitos: comparar como multiconjunto; número que "some" = comando falhou; normalizar linha/coluna.
- vitest: nunca pool `threads`; limpar `node_modules/.vite` se o resultado parecer em cache.
- Git Bash: heredoc perde um nível de `\\`; `open(p,"w")` trunca antes de falhar.
- `(prisma as any)` esconde erro de tipo em runtime (foi isso que escondeu o bug do cStat).
- SOAP retry: uma transmissão pode durar ~4,5 min. O lease e a maturidade de "não consta" já são derivados disso em `flags.ts`; toda escrita pós-transmissão precisa da guarda por tentativa.
- Log e auditoria: nunca token, senha, CSC, CSRT ou XML; `sanitizeDeep` redige por substring de chave (`ta`**`rg`**`etLocationId` vira `[REDACTED]`); rota de devolução manual com `xmlOriginal` precisa entrar na lista de redação (PII).
- NFC-e/PDV (`finance.usecase.ts`) reusa a mesma linha REJECTED e trata sucesso não autorizado como "processando". O V2 fica restrito a `NFE_NUMERACAO_V2_MODELOS=55` por padrão.

## 32. Riscos

- Regressão no V1 durante as ondas 3A/2C (arquivos centrais). Mitigação: goldens + `flag-off-regressao.spec` + suíte completa head × base.
- Rollback da numeração Dexo na Focus não é instantâneo (contador interno da Focus). Runbook no plano §4.6.
- Prazo de 05/10/2026 para a referência por item da devolução em produção.
- Dependências externas (UPD PR, CSRT na Focus) podem manter a Kiko rejeitada mesmo com o código pronto.
- Áreas sem teste real: transporte SOAP/HTTP real, Postgres real (sem Docker).

## 33. Produção/deploy

- **Onde roda**: VPS `ssh vps-assuncao`, `/var/www/dexo`, branch `main` em 1549bc4. pm2 com `ecosystem.config.cjs`; nginx na frente; API `api.usedexo.com.br`.
- **Deploy manual** (merge não deploya): `cd /var/www/dexo && git pull && npm ci && npm run build && pm2 restart dexo-api dexo-frontend && pm2 save`.
  - **Nunca `pm2 restart --update-env`.**
  - Conferir `/api/version`.
  - Flags de backend: editar `.env` + `pm2 restart dexo-api`. `NEXT_PUBLIC_*`: rebuild.
- **Ordem desta frente** (plano §10.1):
  1. deploy com flags ausentes + smoke
  2. DDLs no Supabase + verificação
  3. diagnóstico read-only
  4. canário em homologação (config SEFAZ direto de homologação + Kiko; sub-flag Focus só após confirmar com a Focus)
  5. um tenant SEFAZ direto em produção por 48 h
  6. ampliar a allowlist, depois `*`
  - Rollback: tirar a config da allowlist.
- **Sem CI** (só commitlint). Vercel é usado como checagem de build/lint em PR.

## 34. Primeiro próximo passo

1. Abrir o worktree `C:\Users\Casa\Documents\GitHub\ghd-plataform\.claude\worktrees\receivable-stock-listing-sync-9b376d` e rodar os comandos de confirmação da §36.1 (suíte fiscal + diff de tsc). Esperado: 101 arquivos e 2.254 testes passando; 0 erros novos de tsc.
2. Ler `docs/handoff-nfe-evolucao/01-numeracao-v2-final.md` §4.2–§4.4, §4.9–§4.15 e `09-relatorios-onda1.md` (seções w1b e w1c).
3. **Implementar P1 (Onda 2A)**, com o desvio do plano: a allowlist é por `companyFiscalConfigId`, não por userId.
   - `app/fiscal/numeracao/numeracao.errors.ts` (`NumeracaoError {code, httpStatus, detalhes}`)
   - `app/fiscal/numeracao/numeracao.repository.ts` (SQL cru, client injetável, interface `INfeNumeracaoRepository`)
   - `app/fiscal/numeracao/numeracao.service.ts`
   - fake em memória com mutex por chave
   - specs em `tests/fiscal/numeracao/`

## 35. Sequência imediata

1. P1 (2A): numeração V2, dados e serviço + testes (+ PG opt-in se o Docker estiver ligado).
2. P2 (2C): RT por empresa integrado (pode rodar em paralelo com P1; arquivos disjuntos, exceto `sefaz-direct.provider.ts` na linha ~197, que é só de P2).
3. P3 (2B): devolução backend/XML (paralelo com P1/P2; é dono dos builders, do parser e dos arquivos `nfe-devolucao.*`).
4. Registrar os módulos de rotas novos em `app/api/api.ts`; rodar a suíte fiscal + tsc diff; conferir os goldens.
5. P4 (3A): orquestrador V2 + integrações + cenários 1–14 e ★.
6. P5 (3B): ganchos da devolução no orquestrador + guarda de cancelamento + `findExistingDraft`.
7. P6 (4): frontend (lista/detalhe e wizard podem ser separados).
8. P7 (5): diagnóstico + docs + `.env.example`.
9. P8 (6): gates completos + revisão adversarial do diff + correções + gates de novo.
10. Pedir aval ao usuário para P9 (homologação) e preparar o relatório final de 12 seções.

## 36. Como validar a próxima alteração

### 36.1 Reproduzir o estado atual
```bash
cd "/c/Users/Casa/Documents/GitHub/ghd-plataform/.claude/worktrees/receivable-stock-listing-sync-9b376d"
M=/c/Users/Casa/Documents/GitHub/ghd-plataform
export NODE_OPTIONS=--max-old-space-size=8192
node $M/node_modules/vitest/vitest.mjs run --root . --pool=forks tests/fiscal tests/finance-fiscal-draft.spec.ts tests/finance-nfce-endpoint.spec.ts tests/pdv-nfce-helper.spec.ts
node $M/node_modules/typescript/lib/tsc.js --noEmit --incremental false -p tsconfig.json > /tmp/tsc-head.txt
# base (worktree temporário já criado; se não existir: git -C $M worktree add --detach $M/.claude/worktrees/tsc-base-1549bc4 1549bc4)
node $M/node_modules/typescript/lib/tsc.js --noEmit --incremental false -p $M/.claude/worktrees/tsc-base-1549bc4/tsconfig.json > /tmp/tsc-base.txt
node docs/handoff-nfe-evolucao/tscdiff.cjs /tmp/tsc-base.txt /tmp/tsc-head.txt   # esperado: NOVOS 0
```

### 36.2 Validar P1 (numeração V2, dados e serviço)
- **Specs novos passam**:
  - 20 reservas concorrentes na mesma chave → {1..20} e contador 21
  - chaves diferentes (tenant, série, ambiente, modelo) são independentes
  - throw depois do bump não consome número (rollback)
  - transição fora da matriz lança
  - `avancarContadorAtomico` nunca diminui
  - `reservarOuReutilizar` reusa por `nfeId` mesmo com a nota em DRAFT (R1)
  - troca de chave em PRODUÇÃO sem confirmação → `NumeracaoError` 409
  - adoção de legado só com evidência (Focus nunca)
- **Regressões a checar**: todos os goldens e `emit-v1-bug-reproducao.spec.ts` inalterados; `nfe-sequence*.spec.ts` e `nfe-emission-*.spec.ts` verdes; tsc sem erros novos.

## 37. Definition of Done da frente atual

A frente só termina quando **todos** os itens abaixo forem verdade:

1. **Numeração**:
   - cenários obrigatórios 1–14 do usuário e o cenário ★ ("100 autorizada / 101 erro / 101 retry / 101 autorizada / 102 próxima") passam no harness com V2 ligado, pelos dois provedores
   - duplo clique não gera dois números
   - concorrência não colide
   - timeout só reusa após consulta madura
   - cancelado e inutilizado nunca são reusados
2. **cStat**: `"974"`/`974`/`null`/`undefined` sem crash e com tipo correto. ✅ **já cumprido**.
3. **Kiko/RT**:
   - resolver por empresa integrado (SEFAZ PADRAO idêntico ao `.env`; Focus não envia RT; PERSONALIZADO validado por UF)
   - UI de configuração
   - nenhum CNPJ fixo em código
   - causa da 974 documentada ✅
4. **Devolução**:
   - criação a partir da nota (ação rápida) e manual
   - total e parcial com saldo (sem exceder; rejeitada/cancelada não contam)
   - finNFe 4, CFOP válido, tPag 90, referência ITEM/NOTA correta, sem os dois
   - XML SEFAZ e payload Focus com goldens
   - relacionamento original ↔ devolução consultável
   - wizard com revisão antes de emitir
5. **Flags desligadas**: todos os goldens de F0 inalterados, `flag-off-regressao.spec` verde, DOM idêntico.
6. **Gates**:
   - suíte completa head com 0 falhas novas em relação a 6.633/6.633
   - tsc com 0 erros novos
   - eslint `--no-ignore` rc 0 nos tocados
   - `next build` rc 0 (flags off e on)
   - `prisma validate` OK
7. **Documentação**: diagnóstico read-only, `docs/fiscal-numeracao-v2.md`, `docs/fiscal-devolucao.md`, `.env.example` atualizados.
8. **Encerramento**:
   - revisão adversarial do diff sem achado bloqueador aberto
   - relatório final das 12 seções entregue
   - validação em homologação feita **se** o usuário autorizar (caso contrário, registrada como pendência externa)

## 38. Roadmap restante

Igual à tabela da §6 (ondas 2A → 6), seguida da implantação (§33), que depende do usuário.
- **Fora desta frente**:
  - finNFe 5/6 (obrigatório em 2027)
  - IBS/CBS na devolução
  - SVC V2
  - correção dos defeitos da Focus V1 (hoje só travados nos goldens)
  - refatoração dos `(prisma as any)`
  - estatísticas descontando devoluções

## 39. Alterações desde o último handoff

Não se aplica: este é o handoff inicial.

## 40. Não faça

- Não rode `prisma db push`, `prisma migrate` nem `npx prisma generate` sem o procedimento de backup e restauração do client compartilhado.
- Não crie nem edite `.env` no worktree; não aponte testes ou API local para produção.
- Não emita NF-e/NFC-e real e não consulte SEFAZ/Focus em massa sem aval explícito do usuário.
- Não altere `emitir()`, `consultar()` ou outros métodos existentes do `SefazDirectProvider`, nem o `FocusNfeProvider` V1, `cstat-mapper.ts`, `nfe-number-reuse.ts` ou `nfe-sequence.service.ts`. O V2 vive em arquivos e métodos novos.
- Não "conserte" `updateDraft` forçando REJECTED no V1.
- Não regrave os snapshots de `tests/fiscal/golden/__snapshots__` para fazer teste passar: golden quebrado com a flag desligada = regressão.
- Não adicione colunas em `NfeEmitida`, `NfeItem` ou `CompanyFiscalConfig`.
- Não implemente pool de números, `numero--`, `MAX(numero)+1` nem liberação automática de números legados.
- Não envie `NFref` e `DFeReferenciado` na mesma nota; não envie `hash_csrt` pela Focus.
- Não coloque CNPJ (Kiko, Dexo, Focus) fixo em código.
- Não commite nem faça push sem pedido do usuário.
- Não remova o worktree `tsc-base-9343c57` (é de outra sessão).

## 41. Ponto de retomada

- Abrir o worktree da §Identificação.
- Rodar a §36.1 para confirmar 2.254 testes verdes e 0 erros novos de tsc.
- Ler o plano aprovado e os relatórios da onda 1 (§30, itens 2 e 3).
- Implementar **P1**: `app/fiscal/numeracao/numeracao.{errors,repository,service}.ts` + fake + specs, seguindo `docs/handoff-nfe-evolucao/01-numeracao-v2-final.md` §4.4 (com allowlist por config).
- Em paralelo, se houver capacidade, P2 (RT) e P3 (devolução backend), que têm arquivos disjuntos.

## 42. Matriz final de estado

| Área | Estado | Validação | Próxima ação |
|---|---|---|---|
| Diagnóstico (numeração, 974, Focus, devolução) | CONCLUÍDO | Provas de produção + NTs + revisão adversarial | — |
| Plano | CONCLUÍDO (aprovado) | Usuário aprovou | Seguir; o plano vence os desenhos |
| F1 crash cStat | CONCLUÍDO | 33 testes + controle negativo | Implantar junto com a próxima entrega |
| Schema + DDLs | CONCLUÍDO COM OBSERVAÇÃO | `prisma validate` | Aplicar só na implantação, após deploy |
| Goldens + harness | CONCLUÍDO | 76 testes, 2 execuções estáveis | Usar nas ondas 2–4 |
| Núcleo puro numeração V2 | CONCLUÍDO | 736 testes | Consumir em P1/P4 |
| Provedores 2 fases + Focus V2 | CONCLUÍDO | 114 testes + paridade | Consumir em P4 |
| Domínio puro devolução | CONCLUÍDO COM OBSERVAÇÃO (falta `montarRascunhoManual`) | 191 testes | P3 |
| Domínio puro RT + resolver | CONCLUÍDO | 105 testes | P2 |
| Numeração V2, dados e serviço | NÃO INICIADO | — | **P1 (primeiro passo)** |
| RT integrado + UI | NÃO INICIADO | — | P2 |
| Devolução backend/XML/rotas | NÃO INICIADO | — | P3 |
| Orquestrador V2 + integrações | NÃO INICIADO | — | P4 |
| Ganchos devolução no V2 | NÃO INICIADO | — | P5 |
| Frontend (lista, wizard) | NÃO INICIADO | — | P6 |
| Diagnóstico + docs + `.env.example` | NÃO INICIADO | — | P7 |
| Gates completos + revisão do diff | PARCIAL (fiscal + tsc ok) | 2.254 testes; tsc 0 novos | P8 |
| Homologação | BLOQUEADO (aval do usuário; UPD/Focus para a Kiko) | — | P9 |
| Implantação em produção | FORA DO ESCOPO desta sessão (decisão do usuário) | — | §33 |

## 43. Instruções para o Codex

- Você está assumindo um **projeto existente em produção**, com clientes reais. A regra absoluta do dono é **zero regressão**: toda mudança é aditiva e atrás de flag por empresa.
- **Leia este handoff inteiro** e depois o plano aprovado (`docs/handoff-nfe-evolucao/00-PLANO-APROVADO.md`). O plano é a fonte de verdade das decisões; os desenhos em `docs/handoff-nfe-evolucao/0x-*.md` detalham a implementação, mas perdem para o plano quando divergirem (ex.: allowlist por config, sem pool, contrato §6.3, Focus só pelo V2).
- **Confirme o estado atual antes de alterar** (§36.1): o repositório é a fonte de verdade, não a memória deste documento.
- **Preserve o trabalho concluído** (§18) e não reabra decisões (§19) sem necessidade nova e concreta.
- **Não trate o histórico como pendência**: o crash do cStat e o diagnóstico da 974 estão resolvidos. Os bugs da §21 existem no V1 e são corrigidos pelo V2 quando ligado, não por remendo no V1.
- **Comece pelo "Primeiro próximo passo"** (§34) e siga a sequência da §35.
- **Depois de cada alteração**: rode os specs novos, a suíte fiscal, o diff de tsc e confira os goldens. Ao final, os gates completos da §37.
- **Não faça commit, push, emissão fiscal real, DDL em banco nem chamadas à SEFAZ/Focus** sem pedido explícito do usuário.
- **Se precisar transferir de novo**, atualize **este mesmo arquivo** como handoff consolidado (Tipo B), com a seção "Alterações desde o último handoff" preenchida.


## Atualização Codex — 18/09/2026, encerramento local

Esta atualização substitui os estados antigos de P1–P8 apresentados acima. A implementação de P1–P7 foi integrada no mesmo worktree, preservando alterações anteriores. P8 passou nos gates locais disponíveis; PostgreSQL real isolado e UAT interativa permanecem pendentes. Não registrar homologação externa como concluída.

- Relatório consolidado em 12 seções: [10-RELATORIO-CODEX.md](docs/handoff-nfe-evolucao/10-RELATORIO-CODEX.md).
- Prioridade final do usuário: emissão Focus para cliente, economizando limite semanal. Roteiro: [roteiro-emissao-focus-nfe.md](docs/roteiro-emissao-focus-nfe.md).
- Suíte completa: base 6.633, head 7.937 aprovados, zero falhas. Fiscal final: 2.302 aprovados e 2 testes PostgreSQL ignorados. Rechecagem final da numeração: 881 aprovados e 2 ignorados.
- TypeScript: base 98/head 98, multiconjunto sem erros novos. Lint aprovado. Builds flags off/on aprovados; allowlist ausente do bundle público. Prisma validate aprovado.
- Cenário obrigatório testado em Focus e SEFAZ simulados: 100 autorizada → 101 falha → retry 101 autorizada → próxima 102.
- Docker local indisponível: testes reais PostgreSQL não executados. Nenhuma emissão, consulta remota de provedor, SSH, DDL remoto, commit, push ou implantação. Nenhum `.env` criado; configuração Codex e backup preservados.
- Focus/Kiko ainda exigem verificação externa de credenciais, habilitação, UPD e RT/CSRT. Seguir o roteiro; não repetir toda a exploração ou os gates sem novas alterações que justifiquem.
