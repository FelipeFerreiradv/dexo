# Plano — Evolução do módulo NF-e: numeração transacional, cStat/974, Kiko/Focus, NF-e de devolução

## Contexto

Quatro problemas, todos confirmados em código **e** em produção (VPS = `main` 1549bc4, idêntico ao worktree
`receivable-stock-listing-sync-9b376d`, branch `claude/dexo-nfe-module-evolution-3abbea`):

1. **Salto de numeração**: uma tentativa que falha consome o número, e o retry corrigido sai com outro.
2. **Crash `cStatRejeicao`**: a Focus devolve `"974"` como string, o Prisma recusa (`Int?`), e o motivo e o cStat se perdem.
3. **Kiko 4 X 4 (PR) rejeitada com 974**: a emissão pela Focus é recusada.
4. **Não existe NF-e de devolução.** A regra que exige referência por item (`DFeReferenciado`) entra em produção
   em **05/10/2026** e já vale em homologação.

Regra absoluta: **zero regressão**. Tudo é aditivo e atrás de flag por empresa; com a flag desligada o
comportamento atual fica idêntico. A única exceção deliberada é o conserto do crash do cStat (F1), que só muda
um caminho que hoje estoura com erro 500.

### Decisões do usuário (17/09)
1. Dexo controla a numeração também na Focus (envia `numero`+`serie`) e sempre regrava o nº real lido da chave.
2. Focus fica como responsável técnico da Kiko; criar configuração de RT **por empresa**, sem CNPJ fixo em código.
3. Histórico: só diagnóstico seguro read-only. Nada é liberado, reconciliado ou inutilizado automaticamente, e
   não entra botão novo para as linhas legadas.
4. Devolução é só fiscal: nunca mexe em estoque.

---

## 1. Diagnóstico (base de tudo)

### 1.1 Numeração: onde o número é lido, calculado e gravado
- **Leitura e incremento**: `NfeSequenceService.reservarPorEmitente` (`app/fiscal/sequence/nfe-sequence.service.ts:136-219`).
  - Faz `SELECT … FOR UPDATE` por (companyFiscalConfigId, ambiente, série, modelo) e grava `proximoNumero+1`
    **na mesma transação, antes de qualquer envio**.
  - Não existe `MAX(numero)+1` na emissão.
  - Contador por emitente/série/modelo; produção e homologação separadas; Focus e SEFAZ compartilham o contador.
- **Emissão**: `NfeEmissionUseCase.emit` (`app/usecases/nfe-emission.usecase.ts`).
  - `validate()` roda antes do claim; o claim atômico passa DRAFT|REJECTED→VALIDATING (`:147`).
  - O número é reservado em `:238` e sobrescrito na linha em `:262`, e o número anterior some (só a auditoria
    `NUMERADA` guarda o histórico).
  - Só depois vêm o certificado, o payload e o envio.
- **Retry**: usa a MESMA linha. O reaproveitamento (`shouldReuseNumero`, `app/fiscal/domain/nfe-number-reuse.ts:51-62`)
  só acontece se a flag estiver ligada (em produção está) **e** status===REJECTED **e** cStat na faixa 200–599.

### 1.2 Causas reais do salto (provadas pela auditoria de produção)
- **R1** `updateDraft` força `status="DRAFT"` a cada salvamento do wizard (`app/repositories/nfe.repository.ts:380`).
  - O `/calculate` do passo 8 faz o mesmo.
  - Toda renumeração após rejeição foi precedida de `EDITADA_DRAFT`.
  - Retries sem edição reaproveitaram o número (2→2 oito vezes, 7→7, 9→9).
- **R2** `lookupCStat` só considera "rejeitada" a faixa 200–599 (`app/fiscal/sefaz/cstat-mapper.ts:111`).
  - 974/704/781/999 nunca reaproveitam: a Kiko recebeu os nº 1..7 da série 3 em 10 min.
  - No sentido oposto, 205/206/635 são aceitas como reaproveitáveis e geram loop.
- **R3** Focus envia cStat como string. `handleRejected` grava REJECTED e depois quebra no update do cStat
  (`nfe-emission.usecase.ts:1059/1067`). Resultado: cStat null, sem reaproveitamento, HTTP 500.
  - A nota `cmu4gzo2q0q4e18xpsr1zgzgr` recebeu os nº 1,2,3,4 em 30 s.
- **R4** Erro definitivo da Focus antes da SEFAZ (401 token inválido, empresa não habilitada) vira `ENVIO_INCERTO` e a
  nota fica SENDING para sempre com o número queimado (Kiko, produção, série 3: nº 8, 9, 10).
- **R5** Qualquer exceção entre a reserva e o envio (certificado, payload, storage) volta a nota para DRAFT; o
  próximo clique reserva outro número. No SEFAZ direto, falha de montagem/assinatura vira "erro" e fica SENDING.
- **R6 (Focus)** O builder envia `numero_nota` (`app/fiscal/generators/nfe-xml-builder.service.ts:56`), campo que a
  Focus não conhece (o correto é `numero`), então a Focus numera sozinha.
  - Produção: nº 12/13/14 no banco × nNF 3/4/5 na chave.
  - A chave fica gravada com prefixo "NFe" (47 caracteres).
- **Impacto em produção**:
  - 80 notas autorizadas abandonaram 177 números; 26 rejeitadas, 109; 12 SENDING, 18; cerca de 9 clientes, jun–set/2026.
  - 22 linhas SENDING seguem sem reconciliador.
- **Ausências**: não existe reconciliador, webhook nem consulta antes do retry, e não há timeout no fetch da Focus.
  - O SEFAZ direto regenera o cNF a cada envio e não persiste chave nem XML assinado antes de transmitir.

### 1.3 Rejeição 974 da Kiko
- **Cadastro**: user `cmrwc403q0axf18e8xs887f7n`, config `cmrxiixko1spi1837uhscntiy`, CNPJ 11386276000176, **PR/Colombo**,
  SIMPLES, HOMOLOGACAO, FOCUS_NFE, token próprio (não compartilhado), A1 válido, série 3.
- **Regra**: 7ZD02-10 (NT 2018.005 v1.52). O PR compara o CNPJ do `<infRespTec>` com o fornecedor que a Kiko
  autorizou no UPD da Receita PR (em produção desde 05/05/2025). No PR o CSRT é obrigatório em produção desde 01/04/2026 (975).
- **`emit/CNPJ`** = 11386276000176, vindo de `CompanyFiscalConfig.cnpj` (correto nos dois provedores).
- **`infRespTec/CNPJ`**:
  - Em 17/08 (SEFAZ direto) veio da env global `NFE_RESP_TEC_CNPJ` (hoje 68704837000155 "Dexo System", sem CSRT),
    usada para TODOS os tenants em `sefaz-direct.provider.ts:197`.
  - Em 16/09 (Focus) o payload não tem RT, então a Focus preenche o dela (provavelmente 07504505000132).
  - Nenhum dos dois está autorizado no UPD da Kiko. **A hipótese do .env vale só para o SEFAZ direto.**
- **Correção**: é externa (ver §9). No código entra a configuração de RT por empresa com resolver central.

### 1.4 `(prisma as any)`
- São 72 casts, vindos do commit 7fa5f99 (escrito antes do `prisma generate`). É legado, não uma incompatibilidade estrutural.
- Mas os casts **mascaram** o bug do cStat e o drift do client local.
- Código novo não usa `as any` no Prisma: usa SQL cru tipado ou delegates tipados.
- `handleRejected` ganha tipagem honesta. Não refatoro os 72 casts (risco sem ganho funcional; fica no relatório).

---

## 2. Arquitetura unificada (resolve os conflitos da revisão adversarial)

1. **Um único fluxo novo de emissão**: `NfeEmissaoV2Orchestrator`.
   - `emit()` V1 fica intacto (linhas 92–564). A única mudança é o despacho no topo, e com a flag desligada ele é
     uma leitura de env e nada mais.
   - O orquestrador tem pontos de extensão explícitos:
     - `preClaimValidators[]`: regras de devolução e resolver de RT
     - estratégia de reserva: reserva de número + trava de saldo de devolução **na mesma transação**
     - cálculo de tributos: regime ou devolução
     - `payloadDecorators[]`: `numero`/`serie` da Focus, referências de devolução, RT
     - `postAuthorizedHooks[]`: `DEVOLUCAO_EMITIDA`
   - **Devolução só emite pelo V2.** Guard em runtime: 422 "Devolução exige a numeração v2 habilitada para esta empresa".
2. **Um único classificador** `app/fiscal/numeracao/classificacao.ts` (`normalizarCStat` e classificação SEFAZ/Focus).
   `cstat-mapper.ts` e `nfe-number-reuse.ts` **não mudam**. O conserto do V1 (F1) importa só `normalizarCStat`.
3. **Uma única flag por feature, com allowlist por `companyFiscalConfigId`** (fail-closed; `*` = todas):
   `isFiscalFeatureOn(feature, configId)` em `app/fiscal/flags.ts`.

   | Feature | Env (backend, `"true"`) | Allowlist |
   |---|---|---|
   | Numeração V2 | `NFE_NUMERACAO_V2_ENABLED` | `NFE_NUMERACAO_V2_CONFIG_IDS`, `NFE_NUMERACAO_V2_MODELOS` (default `55`) |
   | Numeração Dexo na Focus (sub-flag do V2) | `NFE_NUMERACAO_V2_FOCUS_ENABLED` | mesma allowlist do V2 |
   | Devolução | `NFE_DEVOLUCAO_ENABLED` | `NFE_DEVOLUCAO_CONFIG_IDS`; `NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE` (default `2026-10-05`) |
   | RT por empresa | `NFE_RESP_TEC_EMPRESA_ENABLED` | `NFE_RESP_TEC_EMPRESA_CONFIG_IDS` |

   UI:
   - `NEXT_PUBLIC_NFE_DEVOLUCAO_ENABLED` e `NEXT_PUBLIC_NFE_RESP_TEC_EMPRESA_ENABLED` (só exibição; o backend continua mandando).
   - A UI da numeração V2 **não tem flag**: liga quando a API devolve o campo `numeracao`.
4. **Assinaturas únicas**:
   - `emit(userId, nfeId, opts?: EmitOpts { confirmarDescarteNumero?, actorUserId? })`
   - `handleAuthorized(..., extras?: { focusRef?, devolucao? })`, um único objeto opcional.
5. **Contrato único de devolução** (§6.3), sem alternativas paralelas.
6. **Tabelas novas, nenhuma coluna nova em modelo quente** (NfeEmitida, NfeItem e CompanyFiscalConfig ficam intocados).
   - O código sobe com as flags desligadas, depois roda o DDL, depois liga a flag por empresa.
   - As leituras gated capturam `P2021/42P01` e degradam para o V1.
   - O boot loga um preflight `to_regclass`.
7. **Commits**: nenhum commit ou push sem pedido explícito. As mudanças ficam no worktree para revisão.

---

## 3. Fases de implementação (cada fase fecha com os gates da §8)

### F0 — Testes de caracterização (golden), antes de qualquer mudança
Travam o comportamento atual que as fases seguintes não podem alterar com as flags desligadas:
- payload Focus: normal, SIMPLES, LP, 65, frete, finalidade DEVOLUCAO sem contexto
- XML SEFAZ: mesmos cenários
- tabela-verdade de `shouldReuseNumero` (cStat 100..1100 × status)
- deep-equal de `parseNfeXml`
- `emitir` do SEFAZ para erros de build/assinatura/rede
- mapeamento HTTP da Focus V1

Arquivos: `tests/fiscal/golden/*.spec.ts` e fixtures.
Harness `tests/fiscal/__harness__/` (emit-world, in-memory-prisma, fake-authority, scripted-provider, fake-focus-server,
numeracao-memory, invariants), que dirige `emit()` até depois do provider. Inclui um spec que **reproduz o bug atual
no V1** (100 autorizada → 101 erro → edição → retry sai 102), documentando a causa.

### F1 — cStat: normalização e `handleRejected` atômico (conserto sempre ligado)
- `app/fiscal/numeracao/classificacao.ts` → `normalizarCStat(v: unknown): number|null`: `/^\s*\d{1,4}\s*$/` vira
  inteiro; qualquer outra coisa (inclusive `"erro_validacao_schema"`) vira null, e o valor bruto vai para a auditoria.
- `nfe-emission.usecase.ts` `handleRejected`:
  - UM update com `status:"REJECTED"`, `motivoRejeicao` e (flag de reemissão ligada) `cStatRejeicao: normalizarCStat(cStat)`.
  - Auditoria `REJEITADA { mensagem, codigoProvedor? }`.
  - Com cStat numérico, o resultado é o mesmo de hoje; em vez de dois updates, um.
- Tipagem: parâmetro `cStat: unknown`; `pollForResult` e `pollSefazResult` passam a ter tipo de retorno.
- Locais de escrita de `cStatRejeicao` no repo inteiro: só `:146` (claim, sempre null) e `:1066`. Não há webhook,
  sincronização nem script que grave o campo. Os novos pontos no V2 usam o mesmo normalizador.
- Testes obrigatórios `tests/fiscal/cstat-normalizacao.spec.ts`: `974`, `"974"`, `" 974 "`, `null`, `undefined`,
  `"erro_validacao_schema"`, `0`, `"12345"`. Mais um spec de `handleRejected` com Focus `status_sefaz:"974"` →
  `cStatRejeicao===974`, motivo gravado, sem `PrismaClientValidationError`, sem 500.

### F2 — Núcleo puro da numeração V2
- `app/fiscal/flags.ts`: `isFiscalFeatureOn`, `isNumeracaoV2ParaEmissao(configId, modelo, providerName)`, tunables.
  - Lease e maturidade derivados de `SEFAZ_TIMEOUT_MS×(SEFAZ_RETRY_MAX+1)+backoff+polling`.
- `app/fiscal/numeracao/estados.ts`: estados e transições permitidas.
- `classificacao.ts`: `classificarEnvioSefaz`, `classificarConsultaSefaz`, `classificarPostFocus`, `classificarGetFocus`,
  `provaMadura`, `extrairChaveReferida`. Tabela da §4.3.
- `app/fiscal/numeracao/decisao.ts`: `decidirEntrada`, `decidirPreClaim`, `decidirAdocaoLegado`,
  `decidirReadbackFocus`, `avaliarFaixa`, `hashConteudo`.
- `app/fiscal/numeracao/log.ts`: `logNumeracao(evento, campos)` com whitelist de campos.

### F3 — Dados e serviço da numeração V2
- `prisma/schema.prisma`: modelos `NfeNumeroReserva` e `NfeNumeroTentativa` (§4.1), sem relação com NfeEmitida.
- DDL `prisma/ddl/2026-09-18-nfe-numeracao-v2.sql`:
  - idempotente, BEGIN/COMMIT, CHECKs, RLS, índice parcial `NfeNumeroReserva_nfeId_vivo_key`
  - bloco de verificação `indisvalid`, rollback com backup em `ops_backup`
  - rodar via SQL editor; tabelas novas e vazias, sem CONCURRENTLY
- `app/fiscal/numeracao/numeracao.repository.ts`: SQL cru; client injetável; interface para o fake em memória.
- `app/fiscal/numeracao/numeracao.service.ts`: `reservarOuReutilizar` (§4.2), `iniciarTransmissao`,
  `registrarResposta`, `registrarConsulta`, `tomarLease`, `naoConstaConfirmado`, `devolverIncerto`,
  `marcarCancelado`, `abandonarPorExclusao`, `inutilizacaoGuard/Pos`, `focusRefPara`, `focusRefAutorizada`,
  `avancarContadorAtomico` (`UPDATE … SET "proximoNumero"=GREATEST("proximoNumero",$n)`, nunca lê e depois escreve).
- Toda escrita pós-transmissão tem guarda `WHERE id=$tentativa AND estado='EM_TRANSMISSAO'`: uma requisição
  superada não sobrescreve o que a outra gravou.

### F4 — Provedores em duas fases (V1 intacto)
- `sefaz-direct.provider.ts`: **métodos públicos novos**. `emitir()` e a interface não mudam.
  - `prepararEmissao({draft, config, numero, cNF, dhEmi, respTec})`: lança em falha local, não usa rede.
  - `transmitirPreparada(p)`: nunca lança.
  - `consultarDetalhado(chave)`, `consultarReciboDetalhado(nRec, chave)`.
  - `static montarNfeProc(signedXml, protNFeXml)`.
  - Teste de paridade: `prepararEmissao+transmitirPreparada` produz o mesmo envelope de `emitir()` para as mesmas entradas.
- `app/fiscal/sefaz/digest.ts` (DigestValue).
- `fiscal-storage.service.ts`: `saveXmlTentativa` (método novo).
- `app/fiscal/providers/focus-nfe-v2.client.ts`:
  - `res.text()` + parse protegido (o 401 vem em HTML); `AbortSignal.timeout` (POST e GET)
  - leitura de `Retry-After`; `status_sefaz`, `numero`, `serie`, `chave_nfe` (tira o "NFe"), `protocolo`
  - token nunca aparece em resultado nem em log
  - `inutilizar` considera sucesso só com `status==="autorizado" && 102`
- `focus-nfe.provider.ts` V1 não muda.

### F5 — Orquestrador V2 e integração
- `app/usecases/nfe-emissao-v2.orchestrator.ts`, fluxo da §4.4.
- `nfe-emission.usecase.ts`:
  - despacho no topo: 1 leitura de env; se ligada, `findFirst` enxuto (status, modelo, companyFiscalConfigId) +
    providerName; fora do escopo vai para o V1
  - `EmitOpts`; `handleAuthorized` com `extras` opcional (`buscarXml(extras?.focusRef ?? nfeId)`)
- `fiscal.routes.ts`:
  - `/issue` lê `confirmarDescarteNumero` e mapeia `NumeracaoError` (409/422)
  - perdedor do claim em V2 recebe 200 `emAndamento` (V1 continua 500)
  - `POST /fiscal/nfe/:id/consultar-situacao`: 404 se V2 desligado; nunca transmite
  - `DELETE /nfe/draft/:id?descartarNumero=true`
- `nfe-draft.usecase.ts`: `attachNumeracao()` em **todas** as respostas de rascunho (POST/GET/PUT) e delete V2
  (confirmação em PRODUÇÃO; bloqueia AUTORIZADO/CANCELADO/DENEGADO/INCERTO).
- `nfe.repository.ts` `findEmitted`: anexa `numeracao` só para linhas no escopo V2. Linha legada mantém o
  "Tentar novamente" atual.
- `nfe-inutilizacao.usecase.ts` e `nfe-cancelamento.usecase.ts`: ramos V2 (§4.6).
- `finance.usecase.ts:1910`: repassa `opts` só quando o emitente do PDV realmente mudou.

### F6 — Responsável técnico por empresa (resolver central)
- Tabela nova `CompanyFiscalRespTec` (1:1 por config; FK só no DDL `prisma/ddl/2026-09-18-company-fiscal-resp-tec.sql`):
  - campos: `modo` PADRAO|PROVEDOR|PERSONALIZADO|NENHUM, `cnpj`, `xContato`, `email`, `fone`, `idCsrt`
  - `csrtEnc` cifrado com a chave de `FISCAL_CERT_ENC_KEY`, via helper novo `fiscal-secret.ts`
- `app/fiscal/providers/nfe-provider-resolver.ts`: `resolveNfeProviderConfig(config, {modelo, respTecRow, env})`
  devolve `{providerName, ambiente, focus{baseUrl,path,token}, sefaz{uf}, numeracao:"DEXO"|"PROVEDOR", respTec}`.
  `resolveRespTec` segue esta tabela:

  | Modo | SEFAZ direto | Focus |
  |---|---|---|
  | PADRAO / sem linha / flag off | env atual (idêntico) | não envia nada (idêntico) |
  | PROVEDOR | proibido | não envia (Focus preenche) |
  | PERSONALIZADO | dados da empresa + `idCSRT`/`hashCSRT` | cnpj/contato/email/telefone, **nunca** `hash_csrt` (hash depende do cNF gerado pela Focus) |
  | NENHUM | omite `<infRespTec>` | não oferecido |

- `app/fiscal/domain/resp-tec.ts` (puro, seguro no client): validação de DV do CNPJ, e-mail, fone e par idCSRT/CSRT.
  - Tabela por UF: no PR em PRODUÇÃO, SEFAZ PERSONALIZADO exige CSRT; Focus PERSONALIZADO é bloqueado (a Focus
    precisa ser o RT); NENHUM é bloqueado.
- Encanamento: `SefazEmitPayload.respTec?: NfeRespTec|null` e `:197` passa a ser
  `payload.respTec === undefined ? resolveRespTecFromEnv() : (payload.respTec ?? undefined)`.
  - O V1 só preenche o campo quando a feature está ligada para a config; o V2 passa sempre pelo resolver.
- Rotas `GET/PUT /fiscal/config/resp-tec` e `/fiscal/companies/:id/resp-tec`.
  - O segredo trafega como `csrtToken` e nunca volta ao cliente.
  - Entradas novas em `sanitizeFiscalConfig`, `redactConfig` e no redator de log (`"csrt"`).
- UI: `steps/resp-tec-card.tsx` (estado local, fora do RHF) em `environment-step.tsx`; lógica pura em
  `app/notas-fiscais/lib/resp-tec-card.ts`.
- Nenhum CNPJ fixo em código. `.env.example` documenta que `NFE_RESP_TEC_*` virou só o **padrão** do SEFAZ direto.

### F7 — Devolução: backend, dados e XML (§6)
### F8 — Frontend: devolução, ação rápida e UI da numeração V2 (§7)
### F9 — Diagnóstico read-only e documentação (§5, §9)
### F10 — Validação completa, homologação, revisão adversarial do diff, relatório final (§8, §10)

---

## 4. Numeração V2 — especificação

### 4.1 Modelo
- **`NfeNumeroReserva`** (um número por chave fiscal durante toda a vida):
  - chave: `userId, companyFiscalConfigId, ambiente, modelo, serie, numero`
  - `nfeId?` (sem FK, sobrevive à exclusão do rascunho), `estado`, `origem` (CONTADOR|LEGADO_V1|READBACK_FOCUS)
  - `cNF` (fixo por número ⇒ mesma chave no mesmo mês)
  - `provedorUltimo`, `ultimaClasse`, `ultimoCStat`, `ultimoCodigoProvedor`, `motivo`, `requerInutilizacao`
  - `bloqueadoAte`, `leaseAte`, `consumidoEm`, timestamps
  - Unique `(cfc, ambiente, modelo, serie, numero)`. Parcial: 1 reserva viva por `nfeId`.
- **`NfeNumeroTentativa`**:
  - `reservaId`, `nfeId`, `seq`, `provedor`, `ambiente`, `tpEmis`, `chaveAcesso(44)`, `cNF`, `dhEmi`
  - `digestValue`, `xmlAssinadoPath`, `conteudoSha256`, `focusRef`, `nRec`, `fase` (TRANSMITINDO|RESPONDIDA|FECHADA)
  - `httpStatus`, `transporte`, `cStat`, `codigoProvedor`, `classe`, `prova`, `protocolo`
  - `numeroLido`, `serieLida`, timestamps

### 4.2 Estados, reserva × consumo
- **Estados**:
  - reserva viva: `RESERVADO`, `REJEITADO`
  - bloqueados para reuso até consulta: `EM_TRANSMISSAO`, `INCERTO`
  - trava manual: `BLOQUEADO`
  - número consumido: `AUTORIZADO`, `CANCELADO`, `DENEGADO`, `INUTILIZADO`, `CONSUMIDO_EXTERNO`
  - `ABANDONADO`: só por ação explícita e confirmada, com `requerInutilizacao` em PRODUÇÃO
- **Invariantes** (cada uma com teste):
  - I1: documento só ganha número novo quando o anterior foi consumido (ou abandonado por ação explícita).
  - I2: reserva nunca muda de chave fiscal.
  - I3: a tentativa (chave, cNF, digest, XML assinado, ref da Focus) é gravada ANTES de transmitir.
  - I4: incerto só fecha com consulta madura ou resposta conclusiva daquela tentativa.
  - I5: sem `MAX+1`, sem `numero--`, contador só avança.
  - I6: uma única ordem de lock, `NfeSequence` → `NfeNumeroReserva` → `NfeNumeroTentativa` → `NfeEmitida`.
  - I7: linha legada nunca é liberada automaticamente.
  - I8: flag desligada, nenhum statement a mais.
- **`reservarOuReutilizar`** (uma transação, sem rede):
  - (R1) Reuso: existe reserva viva RESERVADO/REJEITADO na mesma chave, lida por `nfeId` e **não pelo status**, o que
    neutraliza a R1 sem tocar em `updateDraft`.
  - (R2) Troca de série/emitente/ambiente: em PRODUÇÃO exige 409 `NUMERACAO_CONFIRMAR_DESCARTE` e depois
    ABANDONADO; em homologação é automático.
  - (R3) Adoção de legado SEFAZ na mesma linha, só com evidência: "Erro antes do envio" sem ENVIADA, ou REJEITADA com
    cStat de rejeição comum. Linha da Focus nunca é adotada.
  - (R4) Piso único, só para frente, calculado das chaves autorizadas.
  - (R5) Guarda L2: 3 CONSUMIDO_EXTERNO seguidos devolvem 409.
  - (R6) Contador: bump sob `FOR UPDATE`, pula número ocupado (nota, inutilização, reserva) até 50 vezes e grava o número na linha.
  - **Sem pool**: número abandonado não volta para outra nota. "Nova nota = 102" vale ao pé da letra.

### 4.3 Classificação dos resultados (tabela do `classificacao.ts`)
- **SEFAZ direto**:
  - 100/150 → AUTORIZADO
  - toda rejeição inteira 200–999 não listada abaixo (215, 225, 280–289, 704, 781, 897, 974, 975, 999…) → REJEITADO, **mesmo número**
  - 108/109 → RESERVADO, mesmo número, **sem SVC**
  - 656 → REJEITADO + cooldown de 60 min
  - 204 → consulta pela chave (nossa + digest bate → AUTORIZADO)
  - 539/562/613 → reconciliação pelas chaves das nossas tentativas (a do xMotivo primeiro)
  - 205 → consulta
  - 206 → INUTILIZADO
  - 218 → consulta e BLOQUEADO
  - 635 → INCERTO, nunca renumera
  - 110/301/302/303 com nProt → DENEGADO; sem nProt → consulta
  - timeout/rede/HTTP≥400 → consulta pela chave uma vez, senão INCERTO
  - 103/104/105 → polling, senão INCERTO
- **Focus POST**:
  - 201/200 `autorizado` → AUTORIZADO + read-back
  - 202/`processando` → polling por GET
  - `erro_autorizacao` → mesma tabela da SEFAZ sobre `normalizarCStat(status_sefaz)`
  - `denegado` → DENEGADO
  - 400/401/403/404/415, 422 `permissao_negada`/`erro_validacao_schema` → RESERVADO (conclusivo, **mesmo número e mesma ref**, conserta R4)
  - 429 → RESERVADO + `bloqueadoAte`
  - 422 `pending_operation`/`em_processamento` → GET e INCERTO
  - 422 `already_processed`/`nfe_autorizada` → GET
  - 5xx/timeout/rede → GET uma vez, senão INCERTO
- **Focus GET**:
  - `autorizado` → AUTORIZADO + read-back
  - `cancelado` → BLOQUEADO
  - `erro_autorizacao` → tabela SEFAZ
  - 404 só vale "não consta" com prova madura (≥ lease); 401/403/429/5xx são inconclusivos, nunca "não consta"

### 4.4 Fluxo `emitir` V2
1. **E0** Snapshot enxuto e elegibilidade (fora do escopo → V1).
2. **E1** `decidirEntrada`:
   - AUTHORIZED → replay `jaEmitida`
   - SENDING com lease válido → `emAndamento`
   - INCERTO ou lease vencido → reconciliar (consulta ANTES de qualquer reenvio)
   - VALIDATING/SIGNING travada com reserva e lease vencido → volta a DRAFT com o mesmo número
   - SENDING legado sem reserva → `emAndamento` "emissão anterior à numeração v2 — sem ação automática" (decisão 3)
3. **E2** `findDraftById` + `validate` (idênticos ao V1) + `preClaimValidators` (devolução, resolver de RT).
4. **E3** `decidirPreClaim`: confirmação de descarte; cooldown L1 (mesmo conteúdo rejeitado há < 60 s).
5. **E4** Claim atômico. O perdedor recebe 200 `emAndamento`.
6. **E5** Cálculo: `montarEntradaCalculoEmissao` (puro, com teste de paridade com o V1) ou `calcularTributosDevolucao`.
7. **E6** `reservarOuReutilizar` (com a trava de saldo da devolução na mesma transação) + auditoria
   `NUMERADA{origem, reservaId}`. **Throw até aqui = erro local**: linha volta a DRAFT, reserva fica RESERVADO, retry usa o mesmo número.
8. **E7** SIGNING.
9. **E8** Preparar: SEFAZ `prepararEmissao` (certificado, XML, assinatura) ou payload Focus + `numero`/`serie` (`numero_nota` removido) + decorators.
10. **E9** `iniciarTransmissao`: tentativa + EM_TRANSMISSAO + linha SENDING + chave, numa transação.
11. **E10** Transmitir.
12. **E11** Seguimento: no máximo 1 consulta + 3 polls; **nunca renumera dentro da chamada**.
13. **E12** Aplicar (§4.5).

### 4.5 Aplicação dos resultados
- **AUTORIZADO**:
  - Uma transação grava reserva + tentativa FECHADA + `NfeEmitida` AUTHORIZED com chave de 44 dígitos, protocolo e `xmlAssinadoPath`.
  - Depois `handleAuthorized(..., {focusRef})`. O XML da SEFAZ vem inline ou é montado via `montarNfeProc` a partir do XML assinado guardado.
  - **Read-back da Focus** (sempre): `parseChave` checa CNPJ e modelo da config.
    - Se nNF/série divergem: primeiro AUTHORIZED; depois, sob lock, `GREATEST` no contador e a reserva do número reservado vira ABANDONADO.
    - A tentativa de gravar `numero` real na linha é best-effort: P2002 mantém o número e audita `NUMERACAO_DIVERGENTE_FOCUS{conflito}`.
    - Tudo isso roda **antes** do DANFE, que passa a sair com o nº real.
- **REJEITADO/RESERVADO**: UM update (`REJECTED`, motivo, cStat inteiro) e mensagem "nº N mantido para a correção".
- **DENEGADO/INUTILIZADO/CONSUMIDO_EXTERNO**: linha REJECTED; a próxima emissão desta nota usa outro número.
- **INCERTO**: linha SENDING, mensagem "use Consultar situação".
- **BLOQUEADO**: conferência manual.

### 4.6 Concorrência, idempotência, inutilização, cancelamento, SVC
- **Duplo clique**: claim atômico + perdedor 200 `emAndamento` + `useRef` síncrono no wizard + índice parcial por `nfeId`.
- **Dois usuários**: `FOR UPDATE` no `NfeSequence` + unique da reserva + unique parcial existente de `NfeEmitida`.
  Qualquer violação faz rollback e nada é enviado.
- **Tenants, séries, ambientes, modelos**: chave `(cfc, ambiente, modelo, série)`.
- **Focus × SEFAZ**: contador único; a consulta usa o provedor **da tentativa**.
- **Inutilização V2**:
  - Guard sob lock recusa faixa com número vivo, incerto ou em nota.
  - Contador só avança após sucesso e sob lock.
  - A alocação pula faixas ACEITA ou PENDENTE há menos de 15 min.
  - Focus só é sucesso com `autorizado`+102.
  - Não existe "inutilizar lacunas" automático.
- **Cancelamento V2**: ref = `focusRefAutorizada(nfeId) ?? nfeId`; reserva vai para CANCELADO. Com devolução
  ligada, recusa (409) se houver devolução autorizada ou em voo (advisory lock da chave).
- **SVC**: o V2 nunca entra em contingência automática (o builder não gera `dhCont`/`xJust`). O V1 fica como está; recomendar `SEFAZ_AUTO_FALLBACK_ENABLED` desligado.
- **Rollback da Focus**: a numeração pelo Dexo é sticky por config. Runbook: antes de desligar o V2 de uma config
  Focus, alinhar `proximo_numero_nfe_*` no painel da Focus.

---

## 5. Diagnóstico read-only do histórico (decisão 3)
`scripts/fiscal/diagnostico-numeracao-nfe.ts` + classificação pura `app/fiscal/numeracao/diagnostico-classificacao.ts`:
- **Garantias de leitura**:
  - `SET TRANSACTION READ ONLY`
  - teste que lê o código-fonte e proíbe escrita
  - token só aparece como 8 hex de md5; nenhum dado de destinatário
- **Classifica cada número** por (config, ambiente, série, modelo): AUTORIZADA_OK (+DIVERGENCIA_FOCUS), INUTILIZADA,
  REJEITADA_EM_POSSE (+CSTAT_PERDIDO_R3), EM_ABERTO_SENDING, ABANDONADA_POS_REJEICAO, ABANDONADA_ERRO_LOCAL,
  ABANDONADA_INCERTA, SEM_RASTRO.
  - Para tenants Focus, lacuna do Dexo e lacuna da SEFAZ (nNF da chave) são separadas.
  - Contador atrasado.
  - Veredito de adoção de legado.
  - Mesmo CNPJ em 2 tenants; tokens Focus compartilhados.
- **`--consultar`**: só na VPS, com aval explícito. Faz apenas consultas (SEFAZ por chave/recibo, Focus GET) das 22 SENDING e imprime sugestões, sem gravar.
- **Saída**: `scripts/out/diagnostico-numeracao-<data>.{json,csv}`.

---

## 6. NF-e de devolução — backend (F7)

### 6.1 Regras fiscais vigentes aplicadas
- **Base**: finNFe=4; modelo 55 (NFC-e não pode ser devolução); pagamento `tPag=90` forçado no servidor (871).
- **Quem emite**:
  - VENDA_ENTRADA: o vendedor recebe de volta de consumidor/não contribuinte e emite entrada (tpNF=0).
  - COMPRA_SAIDA: devolução ao fornecedor, saída (tpNF=1), emitente original == destinatário (1194).
- **Modo de referência** (`modoReferenciaDevolucao(ambiente, hojeBR)`):
  - HOMOLOGACAO → ITEM
  - PRODUCAO antes de `NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE` (05/10/2026) → NOTA (`NFref/refNFe`)
  - a partir da data → ITEM (`det/DFeReferenciado{chaveAcesso,nItem}` em todo item, último filho de `det`)
  - **Nunca os dois** (1010).
- **Validações** (`validarDevolucao`, puro, antes do claim, porque erro de montagem queima número no V1):
  - chave com 44 dígitos e DV válido
  - nItem 1..990 vindo do **XML autorizado** (`det@nItem`, nunca de `NfeItem.numero`)
  - todas as chaves do mesmo emitente (1193); sem par chave+nItem repetido (1072)
  - CFOP no conjunto indDevol=1 ou 1.949/2.949 (327)
  - 1º dígito do CFOP × idDest da **original** (731–733); MEI restrito (1179)
  - original AUTHORIZED e não CANCELLED
  - `devolvidaAposEntrega===true` (recusa ou não entrega é finNFe 5, fora do escopo, com mensagem clara)
  - quantidade > 0 e ≤ disponível
- **Mapeamento de CFOP** `app/fiscal/domain/devolucao-cfop.ts` (puro, compartilhado com o front):
  - 5102→1202, 6102/6108→2202, 5101→1201, 6101/6107→2201, 5405/5403→1411, 6403→2411, 5401→1410, 6401→2410
  - 6404, 5949/6949 e 5929/6929 → **escolha do usuário** (opções 2411/2949, 1949/2949), com emissão bloqueada até escolher

### 6.2 Dados (tabelas novas; DDL `prisma/ddl/2026-09-18-nfe-devolucao.sql`, FKs só no DDL)
- **`NfeDevolucao`** (1:1 com a NfeEmitida da devolução):
  - `tipo` VENDA_ENTRADA|COMPRA_SAIDA; `fonte` DEXO|XML_IMPORTADO|MANUAL; `escopo` TOTAL|PARCIAL
  - `devolvidaAposEntrega Boolean?` (null na criação; exige true na emissão); `confirmadoSemXml`, `indFinal`
  - `origensJson` (snapshot dos itens do XML original); `createdByUserId` (ator = `request.user.id`)
- **`NfeDevolucaoItem`**:
  - posição `(devolucaoNfeId, ordem)` ↔ `NfeItem(nfeId, numero)`; ordem estável porque só o editor de devolução grava esses itens
  - `originalNfeId?`, `chaveAcessoOriginal`(44), `nItemOriginal`, `codigoOriginal`
  - `quantidadeOriginal?`, `valorUnitarioOriginal?`, `quantidade`, `valor`, `impostoOriginalJson`, `tributacaoJson`
  - Uniques `(devolucaoNfeId, ordem)` e `(devolucaoNfeId, chave, nItem)`; índice de saldo `(userId, chave, nItem)`.
- **Saldo por item original**:
  - AUTHORIZED consome
  - VALIDATING/SIGNING/SENDING reservam
  - DRAFT/REJECTED só informam
  - CANCELLED/INUTILIZED não contam
  - `disponivel = original − autorizada − emProcessamento`
  - Recalculado na transação da reserva sob `pg_advisory_xact_lock(hash(userId, chave))`; recontado após a autorização (auditoria `DEVOLUCAO_SALDO_EXCEDIDO` se houver anomalia).
- **Auditoria**: `DEVOLUCAO_RASCUNHO_CRIADO`, `DEVOLUCAO_ITENS_EDITADOS`, `DEVOLUCAO_SALDO_RESERVADO` (na devolução),
  `DEVOLUCAO_EMITIDA` (em cada original do Dexo), com `actorUserId` em `detalhes`.

### 6.3 Contrato de API (congelado; front e back usam o mesmo)
| Rota | Corpo | Resposta |
|---|---|---|
| `POST /fiscal/nfe/:id/devolucao` (id = original) | `{ escopo?: "TOTAL"\|"PARCIAL" }` | 201 `{draftId, reutilizado:false}` ou 200 `{draftId, reutilizado:true}` quando há devolução aberta dessa original; 409 totalmente devolvida, cancelada, sem XML; 404 |
| `GET /fiscal/nfe/:id/devolucao/saldo` | — | original (nº/série **reais da chave**, data, destinatário) + itens `{nItem, codigo, descricao, unidade, quantidadeOriginal, devolvidaAutorizada, emProcessamento, emRascunho, disponivel}` + devoluções |
| `GET /fiscal/nfe/draft/:id/devolucao` | — | cabeçalho, itens com referência, `issues` (prévia do `validarDevolucao`) |
| `PUT /fiscal/nfe/draft/:id/devolucao` | `{ devolvidaAposEntrega?, escopo?, tipo? }` | detalhe |
| `PUT /fiscal/nfe/draft/:id/devolucao/itens` | `{ itens:[{chaveAcesso, nItem, quantidade, cfop, tributacao?, confirmarTributacao?}] }` | detalhe; único gravador dos itens de devolução gerenciada |
| `POST /fiscal/nfe/devolucao/manual` | `{ tipo, xmlOriginal?: string }` ou `{ tipo, chaveAcesso, itens[] }` + `confirmarSemXml` | 201 `{draftId}` |

- Todas as rotas: `authMiddleware`, tenant `dataOwnerId`, 404 se a feature estiver desligada para a config.
- A criação **nunca copia** id/chave/protocolo/autorização/XML/DANFE/status/numero/motivo/cStat/orderId/numeroPedido/ref.
- A criação **copia**: destinatário (`destinatarioJson` da original), `customerId`, itens (código, descrição, NCM, CEST,
  unidade, origem, vUnCom do XML), `idDest` da original.
  - `naturezaOperacao`: "DEVOLUCAO DE VENDA" ou "DEVOLUCAO DE COMPRA"
  - `informacoesComplementares` com a referência (editável)
  - série/ambiente/emitente da config da original
  - `numero` placeholder negativo usando exatamente a fórmula `-(count+1)` extraída para um helper compartilhado
- Original Focus sem `xmlAutorizadoPath`: busca o XML pela ref (best-effort). As 407 notas atuais do Dexo têm XML;
  as 6.130 históricas importadas não têm e ficam inelegíveis, com mensagem "use a devolução manual".

### 6.4 Tributação
- Por item, proporcional a partir do grupo `imposto` do XML original (`parseNfeXml` já devolve o bruto):
  - **ICMS**: mesmos CST/CSOSN, base e alíquota. Allowlist v1:
    - CSOSN 102/103/300/400 → tag `ICMSSN102`; 500 → `ICMSSN500`; 900 → `ICMSSN900` (com vBC/pICMS/vICMS)
    - CST 00 → `ICMS00`; 40/41/50 → `ICMS40`; 60 → `ICMS60`; 90 → `ICMS90`
    - O mapeamento de tag só se aplica **com contexto de devolução**; o builder fica idêntico sem ele (conserta o latente `ICMSSN103`/`ICMS41`).
  - **PIS/COFINS**: CST da original com aviso `PIS_CST_SAIDA_EM_ENTRADA` e revisão.
  - **IPI**: `impostoDevol{pDevol, IPI/vIPIDevol}` + total `vIPIDevol`, só quando a original tinha IPI destacado e o usuário confirma.
  - **IBS/CBS**: não emitidos (em 2026 continuam opcionais; nunca `gDevTrib`).
- Fora da allowlist, ou regime divergente (ex.: Simples devolvendo a fornecedor não-Simples → CSOSN 900): `requerRevisao`,
  emissão bloqueada até `confirmarTributacao`. **Nada é inventado.**
- `indFinal`: VENDA_ENTRADA de consumidor = 1; COMPRA_SAIDA a contribuinte = 0. Só com contexto de devolução; fora
  dele continua fixo em "1".

### 6.5 XML e JSON (sem contexto de devolução, saída byte-idêntica, travada pelos goldens de F0)
- **SEFAZ** `nfe-xml-builder-sefaz.service.ts`:
  - `NFref/refNFe` em `ide` (modo NOTA); `DFeReferenciado` como último filho de `det` na ordem PL_010 (modo ITEM)
  - `impostoDevol`, total `vIPIDevol`, mapa de tags ICMS
  - `tpNF` e `finNFe` já existem
  - golden por grupo + checagem de ordem dos elementos
- **Focus** (decorator V2):
  - `finalidade_emissao:"4"`, `tipo_documento`, `local_destino`, `consumidor_final`
  - ITEM: `items[].chave_acesso_dfe_referenciado` + `numero_item_dfe_referenciado`
  - NOTA: `notas_referenciadas[].chave_nfe`
  - `percentual_devolvido`/`valor_ipi_devolvido` quando houver
  - `formas_pagamento` = 90

### 6.6 Colisões resolvidas (atrás da flag)
- `findExistingDraft` ignora rascunhos com `NfeDevolucao` (a "Nova NF-e" não reaproveita devolução).
- Devolução nunca recebe `orderId`/`numeroPedido` (etiqueta, PDV e "faturada" ficam intactos).
- `getStats` e relatório mensal **inalterados** (zero regressão nos números já exibidos).
- A listagem ganha selo "Devolução" e vínculo "Devolução da NF-e nº X" / "Devoluções: …".

---

## 7. Frontend (F8)

- **Módulos puros** (testes node):
  - `app/fiscal/domain/chave-acesso-dv.ts`: DV sem `node:crypto`
  - `devolucao-cfop.ts`
  - `app/notas-fiscais/lib/nfe-devolucao.ts`:
    - decisão de ações da linha (visível/desabilitado + motivo): AUTHORIZED, modelo 55/65 do Dexo com XML, não
      cancelada, não totalmente devolvida
    - validação de quantidades
    - textos pt-BR (`DEVOLUCAO_COPY`)
    - `bannerDevolucao` → "Emitindo devolução da NF-e nº 1234 série 3"
  - `app/notas-fiscais/lib/nfe-devolucao-api.ts`
  - `app/notas-fiscais/lib/nfe-numeracao-ui.ts`: `interpretarRespostaEmissao`, `acaoListaNumeracao` com fallback
    legado, `textoConfirmacaoDescarte`, `bannerNumeracao`
- **Lista** `nfe-list.tsx` (aditivo):
  - novo `nfe-row-actions-menu.tsx`: DropdownMenu "Ações" copiado de `app/pdv/components/pdv-sale-actions.tsx`
  - item "Emitir nota de devolução" → `POST /fiscal/nfe/:id/devolucao` → `router.push('/notas-fiscais/nfe?draft=…')`
  - guarda de requisição em voo e toasts de 409/422
  - sem flag, DOM idêntico; os ícones existentes não mudam de lugar
- **Detail sheet**: mesma ação em "Ações rápidas".
- **Em linhas V2**: "Tentar novamente — mantém o nº N" e "Consultar situação" (só para notas V2 INCERTO).
  Linhas legadas mantêm o botão atual.
- **Wizard** `nfe-wizard.tsx` (reaproveita o formulário existente; efeitos por handler explícito, nunca `useEffect`
  em `useWatch`, por causa do gotcha RHF de 04/08):
  - Passo 1:
    - seletor "Nota normal | Nota de devolução" (dirige `finalidade`; o select de finalidade fica travado em DEVOLUCAO)
    - painel da devolução:
      - NF-e original nº/série reais, data, destinatário, chave (somente leitura na ação rápida; digitada e validada, ou XML importado, no manual)
      - tipo de devolução, total/parcial
      - "a mercadoria foi entregue e devolvida?" (explica que recusa é outro tipo de nota)
  - Passo 3 em modo devolução:
    - sem busca de produto
    - faixa por item "Qtd. original · Já devolvida · Disponível"
    - campo "Quantidade a devolver"; TOTAL trava as quantidades; PARCIAL permite 0..disponível e remover itens
    - CFOP obrigatório quando ambíguo
    - salva via `PUT …/devolucao/itens`
  - Passo 7: pagamento travado em "Sem pagamento (90)", com explicação.
  - Passo 8: revisão de tributação por item (grupo original × proposto; confirmação quando `requerRevisao`).
  - Passo 9: seção "Devolução".
  - Banner de contexto em todos os passos.
  - Após AUTHORIZED, redireciona para `/notas-fiscais/emitidas`.
- **Emissão**:
  - `emEnvioRef` síncrono antes do `await saveCurrentStep()` (sempre, porque é neutro para o clique único)
  - `interpretarRespostaEmissao`: 200 `emAndamento` vira polling; 409 `NUMERACAO_CONFIRMAR_DESCARTE` abre diálogo e re-POST com confirmação
  - banner "nº N mantido"
  - o banner atual de "será reaproveitado" só aparece quando a API confirma (`numeracao.reutilizavel`)

---

## 8. Testes e gates

### 8.1 Specs novos (principais)
- **F0**: `tests/fiscal/golden/*`, `tests/fiscal/__harness__/*`, `emit-v1-bug-reproducao.spec.ts`.
- **F1**: `cstat-normalizacao.spec.ts`, `handle-rejected-atomico.spec.ts`.
- **F2–F5**:
  - `numeracao/classificacao.spec.ts` (todas as linhas da §4.3), `estados.spec.ts`, `decisao.spec.ts`
  - `calculo-emissao-paridade.spec.ts`, `sefaz-two-phase.spec.ts` (paridade de envelope), `focus-client-v2.spec.ts`
  - `emissao-v2-cenarios.spec.ts`: casos obrigatórios 1–14 + cenário reportado ★
  - `emissao-v2-guardas.spec.ts`: 635, 539 nossa/alheia, already_processed, troca de chave com confirmação,
    travada, cooldown, divergência Focus com P2002, resposta tardia após takeover
  - `reserva-concorrencia.spec.ts` (fake com mutex), `inutilizacao-v2.spec.ts`, `delete-v2.spec.ts`
  - `flag-off-regressao.spec.ts` (argumentos e resultados do V1 com a flag desligada ou fora do escopo)
  - `degradacao-sem-ddl.spec.ts` (P2021 em getById, findEmitted, cancel, inutilização, delete)
  - `diagnostico-somente-leitura.spec.ts`
- **F6**: `nfe-provider-resolver.spec.ts`, `resp-tec-validacao.spec.ts`, `sefaz-direct-resptec-payload.spec.ts`,
  `nfe-emission-resptec.spec.ts`, `company-fiscal-resp-tec.usecase.spec.ts`, redação de log, `resp-tec-card.spec.ts`.
- **F7/F8**: `devolucao-validacao.spec.ts` (321/1010/1048/1072/1193/1194/327/328/731–733/871/354), `devolucao-cfop.spec.ts`,
  `devolucao-saldo.spec.ts` (total, parcial, múltiplos itens, excedente, rejeitada/cancelada não contam, concorrência),
  `devolucao-criacao.spec.ts` (nunca copia identificadores; placeholder < 0), `devolucao-xml-sefaz.spec.ts` (golden
  ITEM/NOTA/impostoDevol/grupos ICMS), `devolucao-focus-payload.spec.ts`, `devolucao-emissao-v2.spec.ts` (DFeReferenciado
  e tPag 90 no transmitido), `devolucao-cancelamento-original.spec.ts`, `devolucao-contrato-api.spec.ts` (front × schemas),
  `nfe-devolucao-ui.spec.ts`, `nfe-numeracao-ui.spec.ts`.
- **Postgres real (opt-in)**: `tests/fiscal/pg/*` com `FISCAL_PG_TEST_URL` + guarda que recusa host não local ou supabase/pooler.
  - Ambiente: Postgres 15 efêmero via docker; schema via `prisma migrate diff --from-empty` (sem contato com banco);
    índices parciais de produção copiados verbatim; os mesmos DDLs de produção.
  - Casos: 40 reservas paralelas → 1..40; primeira alocação concorrente; mesmo `nfeId`; throw após bump;
    isolamento de chaves; número semeado pulado; inutilização/delete intercalados sem deadlock; write-back GREATEST
    nunca diminui; saldo de devolução concorrente.

### 8.2 Cenário reportado (★), obrigatório
Semente: 100 autorizada (contador 101). A nota X falha por campo inválido ou ausente, em quatro variantes:
(a) throw no builder SEFAZ, (b) SEFAZ 225, (c) Focus 422 schema, (d) `validate()`.
Corrige via `updateDraft` + `/calculate` e emite de novo.
- **X autorizada = 101** (em (d) não há reserva até a emissão válida).
- Nova nota Y = **102**.
- Nenhum número queimado.

### 8.3 Gates (Windows; comandos exatos no design de testes)
- **G0** Preflight: worktree real, sem `.env`, lock intacto, sem byte NUL nos arquivos tocados.
- **G1** `prisma validate` + generate do schema do worktree com **backup e restauração** do client compartilhado do main.
- **G2** vitest `--pool=forks` com heap de 8 GB:
  - suíte fiscal + adjacentes
  - **suíte completa** head × base (worktree detached 1549bc4), comparando conjuntos de falhas; zero falha nova
- **G3** `tsc --noEmit --incremental false` em multiconjunto contra a base limpa: zero erro novo.
- **G4** eslint nos arquivos tocados (rc 0).
- **G5** `next build` duas vezes (UI flags off e on), com `DATABASE_URL` sintética; conferir que nenhuma env do servidor vaza para `.next/static`.
- **G6** suíte PG (quando o Docker responder).

---

## 9. Kiko 4 X 4 e pendências externas (não escondidas em código)
- **Configuração (dados, não código)**:
  - `CompanyFiscalRespTec.modo = PROVEDOR` para `cmrxiixko1spi1837uhscntiy`
  - token Focus do **mesmo ambiente** da config (os 401 de produção vieram de token de outro ambiente)
  - empresa habilitada no painel Focus
  - V2 + Focus na allowlist quando validado
- **Contador da Kiko**: pedir Autorização de Uso do fornecedor Focus no UPD da Receita PR para o CNPJ 11386276000176
  (NPF 063/2012; Boletim SEFAZ-PR 013/2025).
- **Suporte Focus confirma**:
  - (a) CNPJ exato que vai no infRespTec
  - (b) envio do CSRT no PR em produção (975)
  - (c) `numero`/`serie` enviados são respeitados
  - (d) re-POST da mesma ref após `erro_autorizacao` mantém o número
  - (e) código retornado ao enviar número já autorizado
  - (f) contador interno após números explícitos
  - (g) formato do webhook
- **Contadores dos tenants**: parâmetros tributários da devolução quando `requerRevisao` (PIS/COFINS de entrada, Simples → CSOSN 900, IPI).
- **Credenciamento SEFAZ**: SEFAZ direto em PR precisa de RT autorizado no UPD + CSRT (a env global não tem CSRT).
  O diagnóstico lista configs PR/PRODUÇÃO que resolvem para a env.
- **Isolamento**: dois tokens Focus compartilhados entre tenants diferentes. Só reportar (contatar os clientes e a Focus).
- **Operação**: `SEFAZ_AUTO_FALLBACK_ENABLED` já está `"false"` em produção (conferido em 17/09) e deve continuar
  assim, porque a SVC do V1 reenvia o mesmo número com outra chave. Transporte em produção: `SEFAZ_TIMEOUT_MS=60000` e
  `SEFAZ_RETRY_MAX=3`, que servem de base para o lease e a maturidade da consulta.
- **Prazo legal**: lacunas de setembro precisam ser inutilizadas até 10/10/2026, por decisão humana a partir do diagnóstico.

---

## 10. Implantação e verificação

### 10.1 Ordem de deploy (VPS, por fase)
1. `git pull` → `npm ci` (postinstall roda `prisma generate`) → `npm run build` → `pm2 restart dexo-api dexo-frontend`.
   **Nunca `--update-env`.** Conferir `/api/version`.
2. Smoke com todas as flags novas ausentes: emissão SEFAZ/Focus, cancelamento, CC-e, inutilização, NFC-e/PDV,
   DANFE/XML, listagem/estatísticas, multi-CNPJ.
3. DDLs no SQL editor do Supabase:
   - `nfe-numeracao-v2`, `company-fiscal-resp-tec`, `nfe-devolucao`
   - verificar `indisvalid`/RLS
   - atualizar a memória dos índices parciais (+1)
4. Diagnóstico read-only (§5), revisado com o usuário.
5. **Canário 1 (homologação)**:
   - V2 + RT + devolução só para a config SEFAZ direto de homologação escolhida e para a Kiko (Focus sub-flag só após as confirmações (c)(d) da Focus)
   - fluxos manuais da §10.2
6. **Canário 2**: um tenant SEFAZ direto de PRODUÇÃO; observar `[nfe-numeracao]` por 48 h; ampliar a allowlist; depois `*`.
7. **Rollback**: remover a config da allowlist (instantâneo; reservas V2 ficam inertes). Focus segue o runbook sticky.

### 10.2 Validação manual (só homologação; emissão real só com aval explícito, em série dedicada sem uso)
1. NF-e normal SEFAZ direto.
2. NF-e normal Focus.
3. Kiko via Focus: esperado 974 até o UPD. Valida o crash corrigido, o cStat 974 inteiro, o motivo gravado e a manutenção do número.
4. Devolução manual (XML importado).
5. Notas emitidas → Ações → Emitir nota de devolução → dados pré-preenchidos → revisão → emissão.
6. Devolução parcial.
7. 974 sem crash do Prisma.
8. Erro na 101 e retry com 101.
9. Timeout com consulta antes de decidir (injeção de falha só em homologação com `NFE_HOMOLOG_FAULT_CONFIG_IDS`, inerte em produção e testado).
10. Duas emissões concorrentes (duas abas).

Antes de cada sessão: consultas read-only confirmando HOMOLOGACAO e série livre.

### 10.3 Revisão final do diff
- `git status`, `git diff` completo.
- Workflow adversarial procurando: CNPJ hardcoded, secrets, env global acidental, `as any` novo, `numero+1` fora
  do serviço, incremento prematuro, falta de transação ou unique, migration destrutiva, `.env` alterado, console
  temporário, NUL bytes.
- Correções, gates de novo, relatório final nas 12 seções pedidas (com o resultado explícito
  "100 autorizada / 101 erro / 101 retry / 101 autorizada / 102 próxima").

### 10.4 Arquivos críticos
- **Existentes (alteração aditiva)**:
  - `app/usecases/nfe-emission.usecase.ts`, `app/fiscal/providers/sefaz-direct.provider.ts`
  - `app/fiscal/sefaz/nfe-xml-builder-sefaz.service.ts`, `app/fiscal/sefaz/nfe-xml-parser.service.ts`
  - `app/fiscal/storage/fiscal-storage.service.ts`
  - `app/usecases/nfe-draft.usecase.ts`, `nfe-inutilizacao.usecase.ts`, `nfe-cancelamento.usecase.ts`, `finance.usecase.ts`
  - `app/repositories/nfe.repository.ts` (`findEmitted`, `findExistingDraft`), `app/routes/fiscal.routes.ts`
  - `app/interfaces/nfe.interface.ts`, `prisma/schema.prisma`, `.env.example`
  - `app/notas-fiscais/components/{nfe-wizard,nfe-list,nfe-detail-sheet}.tsx`
  - `steps/{step-informacoes-gerais,step-produtos,step-pagamentos,step-impostos,step-finalizar,environment-step}.tsx`
- **Novos**:
  - `app/fiscal/flags.ts`, `app/fiscal/numeracao/*`, `app/fiscal/providers/focus-nfe-v2.client.ts`
  - `app/fiscal/providers/nfe-provider-resolver.ts`, `app/fiscal/domain/{resp-tec,devolucao-cfop,chave-acesso-dv}.ts`
  - `app/fiscal/devolucao/*` (validação, saldo, montagem, tributação), `app/repositories/{nfe-devolucao,company-fiscal-resp-tec}.repository.ts`
  - `app/usecases/{nfe-emissao-v2.orchestrator,nfe-numeracao-consulta.usecase,nfe-devolucao.usecase,company-fiscal-resp-tec.usecase}.ts`
  - `app/notas-fiscais/lib/{nfe-devolucao,nfe-devolucao-api,nfe-numeracao-ui,resp-tec-card}.ts`
  - `app/notas-fiscais/components/{nfe-row-actions-menu,steps/resp-tec-card,devolucao-*}.tsx`
  - `prisma/ddl/2026-09-18-*.sql`, `scripts/fiscal/diagnostico-numeracao-nfe.ts`, `docs/fiscal-numeracao-v2.md`, `docs/fiscal-devolucao.md`
- **Reuso obrigatório**:
  - `parseNfeXml`, `parseChave`/`gerarCnf`/`montarChave`, `resolveRespTecFromEnv`, `CertificateManagerService`
  - `sanitizeFreeText`/`composeInfCpl`, `isValidCnpj`, `cfop-catalog.ts`, `MockNfeProvider`
  - padrão `pdv-actions.ts`/`pdv-sale-actions.tsx`, convenção DDL de `prisma/ddl/2026-08-14-receivable-event.sql`
