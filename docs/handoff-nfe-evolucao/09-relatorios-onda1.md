# Relatórios completos dos agentes da Onda 1 (17/09/2026)

Gerado a partir do retorno do workflow wf_1c5077c9-5b1. Cada seção é o relatório integral do agente.



---

# w1a-golden-harness

# W1a: goldens F0 and emit harness

All my specs pass and write their snapshots. A second run passed with nothing rewritten, and a type check shows no errors in my files. No production code was touched.

## 1. Files created
All paths are under `C:/Users/Casa/Documents/GitHub/ghd-plataform/.claude/worktrees/receivable-stock-listing-sync-9b376d/`.

**Harness** (`tests/fiscal/__harness__/`)
- `in-memory-prisma.ts`
- `fake-authority.ts`
- `scripted-provider.ts`
- `numeracao-memory.ts`
- `invariants.ts`
- `emit-world.ts`
- `README.md`
- `harness.spec.ts`: a self-test of the fakes (16 tests).

**Goldens** (`tests/fiscal/golden/`)
- `focus-payload.golden.spec.ts`
- `sefaz-xml.golden.spec.ts`
- `reuse-truth-table.golden.spec.ts`
- `xml-parser.golden.spec.ts`
- `sefaz-emitir-erros.golden.spec.ts`
- `focus-v1-http.golden.spec.ts`
- `emit-v1-bug-reproducao.spec.ts`
- `__fixtures__/casos-emissao.ts` (cases shared by the Focus and SEFAZ goldens) and `__fixtures__/nfe-proc-sample.xml`
- `__snapshots__/`: 53 files (`focus-*.json`, `sefaz-*.xml`, `sefaz-emitir-*.json`, `focus-v1-*.json`, `xml-parser-*.json`, `reuse-truth-table.txt`).

## 2. Exported API
- **`in-memory-prisma.ts`**
  - `createInMemoryPrisma(opcoes?: OpcoesMemoria): InMemoryDb`, where `OpcoesMemoria = { relogio?: () => Date; intercalar?: boolean; semente?: number }`.
  - `InMemoryDb`:
    - `client`
    - `reset(opcoes?)`
    - `tabela(modelo)`, `linha(modelo, id)`
    - `inserir(modelo, data)`, `atualizar(modelo, id, data)` (synchronous, for seeds)
    - `aoSqlCru(handler): () => void`
    - `falharProxima(alvo, erro, quando?)`
    - `chamadas(filtroAlvo?)`, `escritas(modelo?)`
  - Also exported: `SQL_NAO_TRATADO`, `HandlerSqlCru = (chamada: ChamadaSqlCru, db) => unknown`, `ChamadaSqlCru.registrarDesfazer(fn)`, `ErroPrismaMemoria { code, meta }`, `NomeModelo`, `Linha`.
  - Tables: `nfeEmitida`, `nfeItem`, `nfeAuditLog`, `nfeSequence`, `nfeInutilizacao`, `companyFiscalConfig`, `user`, `customer`.
  - Fidelity:
    - Columns match the schema at 1549bc4. An unknown column or a wrong type throws `PrismaClientValidationError` (for example `cStatRejeicao: "974"`).
    - The production partial uniques are enforced and throw P2002. Foreign keys throw P2003, missing rows throw P2025, and items/audit logs cascade on delete.
    - `$transaction(fn)` undoes only the writes made inside that transaction. Raw SQL with no handler throws.
- **`fake-authority.ts`**
  - `class FakeAuthority` with `montarChave(id, opts?)`, `autorizar(id, {chave?, digest?, nfeId?})`, `denegar`, `inutilizar(id, ini, fim)`, `cancelar(chave)`, `consultarPorChave(chave)`, `consultar(id)`, `registros(filtro?)`, `numerosAutorizados(filtro?)`, `autorizacoesPorNfe(nfeId)`.
  - It answers like SEFAZ: 100, 204, 539, 206, 205, 218, 217, 101, 110.
  - Also exported: `identidadeDoPayload(nfeData, fallback?)`, which reads both the SEFAZ and the Focus payload shapes.
- **`scripted-provider.ts`**
  - `createScriptedProvider(roteiro?: Partial<Record<OperacaoProvider, Passo[]>>, opcoes?: {name?, padrao?}): ScriptedProvider`.
  - Methods: `fila(op, ...passos)`, `chamadas`, `ops()`, `pendentes()`, `limpar()`, plus `emitir`, `consultar`, `consultarRecibo`, `buscarXml`, `cancelar`, `inutilizar`.
  - Step helpers in `passos`:
    - emission: `autorizar({autoridade?})`, `rejeitar(cStat|string, msg, {autoridade?})`, `denegar`, `processando`, `erro`
    - control: `lancar`, `segurar()`
    - consult: `consultaAutorizada`, `consultaRejeitada`, `consultaNaoConsta`, `consultaProcessando`, `consultaErro`
    - other operations: `xml`, `cancelamento`, `inutilizacao`
- **`numeracao-memory.ts`**
  - `createNumeracaoMemory(db): NumeracaoMemoria`, with `reservarProximoNumero`, `consultarProximoNumero` and `ajustarProximoNumero`. Signatures and error messages match the real V1 service; it also exposes `reservas()` and `chamadas()`.
  - `class MutexPorChave { executar<T>(chave, fn) }`
- **`invariants.ts`**: `todasViolacoes(db, authority): string[]`, covering I1, I2, I5 and I3 for V1.
- **`emit-world.ts`**: `world(): EmitWorld`, a singleton per spec file.
  - Collaborators: `db`, `prisma`, `authority`, `storage` (`FakeFiscalStorage.failNext(metodo)`), `providerFactory` (`failNext()`), `provider`, `usarProvider(p)`.
  - Seeds: `seedConfig(overrides?)`, `seedDraft({config, itens?, campos?})`, `seedAutorizada(numero, {config})`, `setProximoNumero(n, {config})`.
  - Reads: `proximoNumero({config})`, `row`, `audit`, `auditLogs`, `numerada`, `checarInvariantes()`, `assertInvariantes()`.
  - Other: `comTimersFalsos(fn)` and `modules`: `{prisma, sequenceV1, providerFactory, storage, danfePdf, danfeNfcePdf, customerRepository, customerUseCase}`.

## 3. Tests
Command pattern: `NODE_OPTIONS=--max-old-space-size=8192 node .../vitest.mjs run --root . --pool=forks <files>`
- **First runs:** snapshots written.
- **All owned specs** (`tests/fiscal/golden tests/fiscal/__harness__`): 8 files, 76 tests, all passed.
- **Second run** of the same specs plus related existing ones (`sefaz/nfe-xml-parser`, `sefaz/sefaz-direct-provider`, `sefaz/cstat-mapper`, `sefaz/nfe-xml-builder-sefaz`, `focus-nfce-path`, `nfe-emission-reuse`, `nfe-emission-company`, `nfe-xml-builder-focus-infcpl`): 16 files, 211 tests, all passed, 0 snapshots written.
- **Mutation check:** a throwaway copy of the bug spec with the reuse flag set to `"false"` failed 3 of 4 tests, so the spec catches that change. The copy was deleted.
- **Type check** (`tsc --noEmit --incremental false`): 0 errors in my files, 98 in total, which is the baseline.
- **NUL bytes:** none.
- **Bug reproduction (a)–(d):** all pass against the current code.

## 4. Deviations from plan and design
- **`fake-focus-server.ts` was not built.** It wasn't in the task list. The Focus golden stubs `fetch` with real `Response` objects instead.
- **`numeracao-memory` covers only the V1 contract.** V2 is a documented extension point (a raw-SQL handler plus `registrarDesfazer`, or an injected repository).
- **`CompanyFiscalRepository` stays real**, running on the in-memory `companyFiscalConfig` table instead of being mocked.
- **Masking:**
  - The signature and the X509 certificate are masked, and so is the OpenSSL error text. That text is `error:1E08010C:…` on this Node and varies between versions.
  - The Focus `JSON.parse` error message is masked only when it matches the current JS engine's message exactly.
  - Key, cNF and dhEmi are inputs, so they are fixed, and they are replaced by markers only when they equal the expected value. A drifted key would show up raw in the diff.
- **The truth table collapses consecutive cStats into ranges.** It holds the same information as one line per cStat.
- **Parser fixtures are copied, not imported.** They were inline in the existing specs, which can't be imported, so the sample XML is copied verbatim and the other cases are rebuilt with the same procedure.
- **XML goldens are the raw builder output**, byte for byte on a single line.

## 5. Notes for the next waves
- **Wiring:** the mocked module loader `W` must be wrapped in `vi.hoisted`, otherwise the file fails with "Cannot access 'W' before initialization". Full example in the README.
- **The current worktree includes another agent's F1 `handleRejected` change.** The bug spec passes on both 1549bc4 and F1 because a numeric cStat leaves the same final state. The string "974" crash isn't reproduced there, since F1 fixed it; `harness.spec.ts` shows the fake throws the same Prisma error.
- **No new columns or tables in the fake.** The fake only knows the 1549bc4 columns, so any V1-path write to a new column fails. Keep the V2 tables out of `SCHEMA`.
- **Goldens to keep byte-identical with flags off:**
  - F4/F6: `sefaz-emitir-lote-104-prot-100-resptec-env.json` and `build-resptec-env-incompleto.json` pin the environment-variable path for the technical responsible (RT).
  - F7: `focus-devolucao-*` and `sefaz-devolucao-*` pin output without a devolução context. Today the SEFAZ builder ignores `notasReferenciadasJson` (no `NFref` is emitted), while Focus sends `notas_referenciadas`.
- **Defects now pinned in the Focus V1 golden:**
  - A 200 or 201 `autorizado` response becomes `processando`, with `codigoStatus` as the string `"100"` and the `"NFe"` prefix left on the key.
  - Consulting a `denegado`, 403 or 404 response returns `processando`.
  - A 200 `erro_autorizacao` on inutilização counts as success, and `protocolo` is always null because the provider reads `protocolo`, not `protocolo_sefaz`.
  - Cancel: a 200 `erro_cancelamento` also counts as success. This one isn't in the plan's list.


---

# w1b-numeracao-core

W1b is finished: the five F2 pure-core modules and their five specs are written. All 736 tests in my specs pass, plus the 27 in the related `tests/fiscal/cstat-normalizacao.spec.ts`. None of the ~100 tsc errors are in my files, eslint is clean, and none of the 10 files has NUL bytes.

## 1. Files created (nothing existing was modified)
- `app/fiscal/flags.ts`
- `app/fiscal/numeracao/estados.ts`
- `app/fiscal/numeracao/classificacao.ts`
- `app/fiscal/numeracao/decisao.ts`
- `app/fiscal/numeracao/log.ts`
- `tests/fiscal/numeracao/flags.spec.ts`, `estados.spec.ts`, `classificacao.spec.ts`, `decisao.spec.ts`, `log.spec.ts`

`tipos.ts` and `cstat.ts` were only imported. `classificacao.ts` re-exports `normalizarCStat` and `codigoProvedorNaoNumerico` from `./cstat`, so the F1 import path in the plan also works.

## 2. Exported API
**`app/fiscal/flags.ts`** (no imports, reads env at call time)
```ts
type FiscalFeature = "NUMERACAO_V2" | "NUMERACAO_V2_FOCUS" | "DEVOLUCAO" | "RESP_TEC_EMPRESA"
type FiscalEnv = Readonly<Record<string, string | undefined>>
isFiscalFeatureOn(feature, configId: string | null | undefined, env: FiscalEnv = process.env): boolean
modelosNumeracaoV2(env?): Array<"55" | "65">
isNumeracaoV2ParaEmissao(configId, modelo: "55" | "65", providerName: string | null, env?): boolean
isDevolucaoAtiva(configId, env?): boolean
naoConstaMinMs(env?)             // 285000 by default
leasePreEnvioMs(env?)            // 600000
leaseEnvioSefazMs(env?)          // 570000 by default, never below 300000
leaseEnvioFocusMs(env?)          // 180000
focusPostTimeoutMs(env?)         // 45000
focusGetTimeoutMs(env?)          // 15000
cooldownRepeticaoMs(env?)        // 60000
consumoIndevidoCooldownMs(env?)  // 3600000
devolucaoRefItemProdDesde(env?): string  // "2026-10-05"
```
Env overrides, for `.env.example`:
- `NFE_NUMERACAO_V2_NAO_CONSTA_MIN_MS`
- `NFE_NUMERACAO_V2_LEASE_PRE_ENVIO_MS`, `NFE_NUMERACAO_V2_LEASE_SEFAZ_MS`, `NFE_NUMERACAO_V2_LEASE_FOCUS_MS`
- `FOCUS_V2_POST_TIMEOUT_MS`, `FOCUS_V2_GET_TIMEOUT_MS`
- `NFE_NUMERACAO_V2_COOLDOWN_REPETICAO_MS`, `NFE_NUMERACAO_V2_COOLDOWN_CONSUMO_INDEVIDO_MS`
- `NFE_NUMERACAO_V2_MODELOS`, `NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE`

**`app/fiscal/numeracao/estados.ts`**
- Re-exports `EstadoReserva`, `ESTADOS_REUSAVEIS`, `ESTADOS_VIVOS`, `ESTADOS_CONSUMIDOS` from `./tipos`.
- `ESTADOS_RESERVA` (all 11 states) and `TRANSICOES: Readonly<Record<EstadoReserva, readonly EstadoReserva[]>>`.
- `isEstadoReserva(v): v is EstadoReserva`, `podeTransicionar(de: unknown, para: unknown): boolean`, `assertTransicao(de, para): void`.
- `class TransicaoInvalidaError extends Error { code: "NUMERACAO_TRANSICAO_INVALIDA"; de; para }`

**`app/fiscal/numeracao/classificacao.ts`** (every function returns `Classificacao`)
```ts
interface OpcoesClassificacao { consumoIndevidoCooldownMs?: number; rateLimitPadraoMs?: number }
classificarCStatSefaz(cStat: number | null, ctx?: { nProt?; xMotivo? }, opcoes?)
classificarEnvioSefaz(t: SefazTransmissao, opcoes?)
classificarConsultaSefaz(c: SefazConsultaDetalhada, ctx: { chavesNossas: string[]; digestsNossos: string[]; madura: boolean }, opcoes?)
classificarPostFocus(r: FocusV2Resposta, opcoes?)
classificarGetFocus(r: FocusV2Resposta, ctx: { madura: boolean; postConclusivo: boolean }, opcoes?)
extrairChaveReferida(texto: unknown): string | null
provaMadura(t: { transmitidaEm: Date; respostaConclusiva: boolean }, agora: Date, minMs: number): boolean
```

**`app/fiscal/numeracao/decisao.ts`** (server-only because it uses `node:crypto`; it does not import `chave-acesso.ts`)
```ts
decidirEntrada({ status, updatedAt, viva: { estado, leaseAte, numero } | null, agora, leasePreEnvioMs }): { acao: AcaoEntrada; mensagem }
MENSAGEM_SENDING_LEGADO, MENSAGEM_EM_ANDAMENTO
decidirPreClaim({ viva: ReservaPreClaim | null, key: { cfc, ambiente, modelo, serie }, conteudoSha256, ultimaTentativa: { conteudoSha256, classe, transmitidaEm, respondidaEm? } | null, confirmarDescarte, agora, cooldownMs }): DecisaoPreClaim
  // SEGUIR{troca} | CONFIRMAR_DESCARTE{mensagem, detalhes{numero, serie, motivo}} | COOLDOWN{mensagem, retryAposMs, numero}
motivoTrocaChave(reserva, key): "EMITENTE" | "AMBIENTE" | "MODELO" | "SERIE" | null
decidirAdocaoLegado({ row: { numero, serie, status, cStatRejeicao }, providerName, trilha: EventoTrilha[] | null, proximoNumero, ocupacao: { inutilizado, reservado, emNota? } }): DecisaoAdocaoLegado
  // { adotar: true, estado: "RESERVADO" | "REJEITADO", evidencia } | { adotar: false, motivo }
partesDaChave(chave: unknown): PartesChaveAcesso | null
decidirReadbackFocus({ reservado: { numero, serie }, chave44, cnpjConfig, modelo }): DecisaoReadbackFocus
  // { resultado: "IGUAL" | "DIVERGENTE", numero, serie } | { resultado: "INCONSISTENTE", motivo: "CHAVE_INVALIDA" | "CNPJ_DIVERGENTE" | "MODELO_DIVERGENTE" }
avaliarFaixa({ linhas: { id, numero, status }[], reservas: { numero, estado }[], ini, fim }): { ok; bloqueios: { numero, motivo, nfeId? }[] }
mensagemBloqueiosFaixa(bloqueios, max = 10): string
CHAVES_IGNORADAS_HASH
hashConteudo(draft: unknown): string   // 64-char sha256 hex
```

**`app/fiscal/numeracao/log.ts`**
- `logNumeracao(evento: string, campos: Record<string, unknown> = {}, nivel: "info" | "warn" | "error" = "info"): void` never throws.
- Also exports `camposLogNumeracao(campos)`, `CAMPOS_LOG_NUMERACAO`, `PREFIXO_LOG_NUMERACAO`.

## 3. Tests
Command (bash, from the worktree root): `NODE_OPTIONS=--max-old-space-size=8192 node /c/Users/Casa/Documents/GitHub/ghd-plataform/node_modules/vitest/vitest.mjs run --root . --pool=forks` followed by the five `tests/fiscal/numeracao/{flags,estados,classificacao,decisao,log}.spec.ts` files and `tests/fiscal/cstat-normalizacao.spec.ts`.

| Spec | Passed |
|---|---|
| `flags` | 113 |
| `estados` (includes the full 11×11 transition matrix) | 147 |
| `classificacao` (includes sweeps of every cStat 200–999 and 100–199) | 267 |
| `decisao` | 194 |
| `log` | 15 |
| `cstat-normalizacao` | 27 |
| **Total** | **763, 0 failed** |

- **First run:** it covered the whole `tests/fiscal/numeracao/` folder, so it also ran four specs that belong to other agents (digest, focus-client-v2, sefaz-two-phase, storage-tentativa). Those passed. My only failure there was a wrong expectation in my own test (301–303 without nProt), which I fixed. Every run after that was scoped to my files.
- **tsc** (`--noEmit --incremental false`): 100 errors in total, none in my ten files.
- **eslint** (legacy config with `--no-ignore`): exit code 0.

## 4. Deviations from the plan or design
1. **Two transitions added to `TRANSICOES`** that the "exactly §4.3" table leaves out. The design needs both elsewhere, and without them `assertTransicao` would throw on those paths:
   - `RESERVADO`/`REJEITADO` → `CONSUMIDO_EXTERNO`, for the Focus read-back when another document's number was used (§4.7 step 2).
   - `ABANDONADO` → `INUTILIZADO`, when inutilização succeeds on an abandoned number (§4.15 step 5).
2. **How `Classificacao` fields are filled:**
   - `acao === "NENHUMA"` always comes with a non-null `estadoAlvo`; any other `acao` comes with `estadoAlvo: null`. If the follow-up doesn't resolve, the orchestrator applies `INCERTO`. A test checks this on every classification.
   - Inconclusive consults return `estadoAlvo: "INCERTO"`.
   - A "not found" result (`NAO_CONSTA`) returns `estadoAlvo: "RESERVADO"` for that one attempt; the orchestrator must combine all open attempts.
3. **SEFAZ:**
   - 100/150 without `nProt` goes to `CONSULTAR_CHAVE`, and in a consult it is inconclusive.
   - Codes 1000–9999 (devolução rules such as 1010, 1072, 1193) are `REJEITADO`, same as 200–999.
   - `transporte: "SEM_CREDENCIAL"` on a send is treated as uncertain, never as "nothing was sent".
4. **Focus POST:**
   - `autorizado` without a 44-digit `chave_nfe` goes to `POLL_REF`, because the read-back needs the chave.
   - `erro_autorizacao` carrying 100/150 is contradictory and goes to `GET_REF`.
   - `cancelado` goes to `GET_REF`.
   - Other 4xx codes (408, 409, 405) and 1xx/3xx go to `GET_REF`, marked not conclusive.
5. **Focus GET `erro_autorizacao`:**
   - 204 and 218 become `BLOQUEADO` (manual check) instead of "others → REJEITADO", because the plan's SEFAZ table never reuses those numbers blindly.
   - 110/301–303 become `DENEGADO` only when a protocol is present; otherwise `REJEITADO`.
   - Other 1xx codes are inconclusive.
6. **Focus GET 404** counts as "not found" only when the body is readable JSON and `codigo` is missing or `"nao_encontrado"`.
7. **Flags:**
   - `"*"` only means "all configs" when it is the whole value; `"abc,*"` does not open everything.
   - A blank `NFE_NUMERACAO_V2_MODELOS` falls back to `"55"`.
   - `isDevolucaoAtiva` also requires `"55"` in the V2 model list.
   - The 300000 floor on the SEFAZ lease also applies to its override.
   - The SEFAZ timeout and retry values are parsed exactly like `soap-client.service.ts`. The backoff allowance is the larger of 15000 and the real sum, so a high retry count is never under-counted.
8. **`decidirAdocaoLegado`** adds the refusals `SEM_NUMERO` and `NUMERO_EM_OUTRA_NOTA` (the latter via optional `ocupacao.emNota`). The trail field is `evento`, matching the `NfeAuditLog` column. If every event has `createdAt`, events are sorted by it.
9. **`hashConteudo`** takes one argument and ignores the listed keys at every depth, so rewritten item ids and item numbers don't change the hash. `focusRefParaPuro` (design §4.22) was not in this task and is not implemented.

## 5. Integration notes for later waves
- **Orchestrator options:**
  - Pass `{ consumoIndevidoCooldownMs: consumoIndevidoCooldownMs() }` into the classifiers.
  - When calling `classificarGetFocus` after a POST, pass `postConclusivo: postCls.conclusiva`.
  - Build `madura` with `provaMadura(t, agora, naoConstaMinMs())`.
- **Legacy adoption (evidence B):** reuse `classificarCStatSefaz` rather than writing a second cStat table.
- **Inutilização error message:** `mensagemBloqueiosFaixa` produces the "up to 10" text for `NumeracaoError("FAIXA_COM_NUMERO_VIVO")`.
- **Content hash:** if it should also cover the issuer or config, pass a composite object such as `{ draft, emitente }`.
- **Logging:** `motivo` is on the whitelist, so callers should pass a short reason, not raw provider or exception text.


---

# w1c-providers-two-phase

## W1c report: two-phase providers for F4 (V1 untouched)

All 4 new specs pass (114 tests), and so do the 14 existing specs I ran next to them. `tsc` shows no errors in my files. The diffs to `sefaz-direct.provider.ts` and `fiscal-storage.service.ts` only add lines; `emitir()` and every other existing method and function are unchanged.

### 1. Files
**Modified (additions only):**
- `app/fiscal/providers/sefaz-direct.provider.ts`: new imports after the existing ones, 5 new methods at the end of the class, new helpers and one exported interface at the end of the file.
- `app/fiscal/storage/fiscal-storage.service.ts`: new method `saveXmlTentativa`.

**Created:**
- `app/fiscal/sefaz/digest.ts`
- `app/fiscal/providers/focus-nfe-v2.client.ts`
- `tests/fiscal/numeracao/sefaz-two-phase.spec.ts`
- `tests/fiscal/numeracao/focus-client-v2.spec.ts`
- `tests/fiscal/numeracao/digest.spec.ts`
- `tests/fiscal/numeracao/storage-tentativa.spec.ts`

### 2. Exported API
```ts
// sefaz-direct.provider.ts
export interface SefazPrepararEmissaoInput { draft: NfeXmlSefazBuildOptions["draft"]; config: NfeXmlSefazBuildOptions["config"]; numero: number; cNF: string; dhEmi: Date; respTec?: NfeRespTec | null }
prepararEmissao(p: SefazPrepararEmissaoInput): SefazNfePreparada
transmitirPreparada(p: SefazNfePreparada, opts?: { svc?: never }): Promise<SefazTransmissao>
consultarDetalhado(chave: string): Promise<SefazConsultaDetalhada>
consultarReciboDetalhado(nRec: string, chave: string): Promise<SefazConsultaDetalhada>
static montarNfeProc(signedXml: string, protNFeXml: string): string   // calls the existing buildNfeProc

// digest.ts (no imports)
export function extrairDigestValue(signedXml: string): string | null

// FiscalStorageService
saveXmlTentativa(userId: string, nfeId: string, numero: number, xml: string): Promise<string>

// focus-nfe-v2.client.ts
export class FocusNfeV2Client {
  constructor(ambiente: "HOMOLOGACAO"|"PRODUCAO", modelo: "55"|"65", opts?: FocusNfeV2ClientOpts /* { fetchImpl?; postTimeoutMs?; getTimeoutMs? } */)
  emitir(payload: Record<string, unknown>, ref: string, token: string): Promise<FocusV2Resposta>
  consultar(ref: string, token: string): Promise<FocusV2Resposta>
  inutilizar(input: FocusV2InutilizacaoInput, token: string): Promise<FocusV2InutilizacaoResposta> // FocusV2Resposta & { sucesso: boolean; protocolo: string | null }
}
export function parseRetryAfterMs(valor: string | null | undefined, agoraMs?: number): number | null
export function normalizarChaveFocus(valor: unknown): string | null
export const FOCUS_V2_POST_TIMEOUT_MS_PADRAO = 45_000, FOCUS_V2_GET_TIMEOUT_MS_PADRAO = 15_000
export interface FocusNfeV2ClientOpts, FocusV2InutilizacaoInput; export type FocusV2InutilizacaoResposta
```

### 3. Test commands and results
Same vitest command as the task (`--pool=forks`, 8 GB heap), three runs:
1. **My 4 specs plus 8 related existing specs:** 12 files, 213 tests, 0 failures.
   - Mine: `sefaz-two-phase` 43, `focus-client-v2` 52, `digest` 13, `storage-tentativa` 6.
   - Existing: `sefaz-direct-provider`, `sefaz-direct-nfce`, `sefaz-direct-cce`, `focus-nfce-path`, `provider-contract`, `nfe-resp-tec-env`, `nfe-infresptec`, `xml-signer`.
2. **6 more existing specs:** `nfe-emission-company`, `nfe-emission-nfce-validate`, `cross-module-smoke`, `soap-client-agent`, `contingencia`, `envelopes`. 78 tests, 0 failures.
3. **`tsc --noEmit --incremental false`:** 98 errors in total, none in my files. My first run had one error of my own; I fixed it and reran.

No NUL bytes in any of my files.

The parity test covers 55 homologação with and without the responsável técnico from the env, 55 produção, and 65 NFC-e. In each case `emitir()` and `prepararEmissao` + `transmitirPreparada` send identical requests (envelope, endpoint, SOAP action, `timeoutMs`, `retryMax`). The test fixes `Date.now`, because `idLote` comes from it on both paths. The authorized nfeProc is also identical to the one `emitir()` builds.

ESLint could not check these files: it skips everything under `.claude/` by default. Gate G4 needs `--no-ignore` or a path outside `.claude/`.

### 4. Deviations from the plan
- **Extra checks in `prepararEmissao`:** it throws if `cNF` is not exactly 8 digits (an empty value would make the builder pick a random cNF without saying so), if `numero` is not an integer ≥ 1, or if `dhEmi` is invalid. It also resolves the authorization endpoint during preparation, so an unsupported UF throws before the attempt is recorded. It also throws if the DigestValue cannot be extracted.
- **`protNFe` is matched by chave** in the transmit and both consult parsers. A `protNFe` for a different chave is treated as missing (null fields, no nfeProc). The lote-level cStat and xMotivo are read with the `protNFe` blocks stripped out.
- **Consult by chave:** `nProt`, `dhRecbto` and `digVal` come only from `protNFe`. There is no fallback to the root, where a cancellation event would supply the wrong `nProt`.
- **Messages when no response was read:** after a transport error or HTTP ≥ 400, `loteXMotivo` / `xMotivo` hold a short Portuguese description instead of SEFAZ text, and `protXMotivo` is `""`. Readable responses have `httpStatus: 200`.
- **`SEM_CREDENCIAL`:** used only when a local endpoint or envelope failure happens inside transmit or consult. After `prepararEmissao` on the same provider instance this cannot happen. A consult with an invalid chave or an empty `nRec` sends nothing and returns `transporte: null`, `cStat: null`.
- **`saveXmlTentativa`:**
  - It writes with flag `"wx"`, so a second write for the same nfeId, numero and millisecond throws instead of overwriting the earlier attempt's file.
  - It returns the full path, the same thing `saveXmlAutorizado` returns (`path.join(basePath, …)`), not a relative path.
- **Focus client:**
  - If the headers arrive but reading the body fails, the result has `transporte` TIMEOUT/REDE and `httpStatus` is still filled in.
  - Any returned text that contains the token is replaced with `[REDACTED]`.
  - `inutilizar` uses `/v2/{nfe|nfce}/inutilizacao` according to modelo; V1 always uses `/nfe`.
  - `Retry-After` dates must contain a day or month name; otherwise V8 parses `"-5"` as a date.
- **Shared types:** no change was needed in `tipos.ts` or `cstat.ts`.

### 5. Notes for the next wave
- **Getting a typed provider:** `createNfeProviderFromConfig` returns `INfeProvider`. The orchestrator should call `createSefazDirectProvider` (it returns `SefazDirectProvider`) or check with `instanceof` before using the new methods.
- **Where the classifier must look:**
  - Check `transporte` before `httpStatus`.
  - Focus 5xx comes back as `transporte: null` with `httpStatus` 5xx.
  - Focus `status_sefaz` stays raw (string or number); normalize it with `normalizarCStat`.
  - `consultarReciboDetalhado` returns the NF-e cStat when there is a `protNFe` for the chave. Otherwise it returns the lote cStat (104, 105, 106…); 104 without a `protNFe` should be read as inconclusive.
- **Order in the orchestrator:** `prepararEmissao` → `saveXmlTentativa` → `iniciarTransmissao` → `transmitirPreparada`. Anything that throws before `iniciarTransmissao` counts as a local error, and the number is kept.
- **`respTec`:** the V2 path should always pass the resolver's result, with `null` for NENHUM. Passing `undefined` falls back to the env value.
- **Focus timeouts:** pass the values from the `flags.ts` tunables through `postTimeoutMs` / `getTimeoutMs`. The defaults are 45 s for POST and 15 s for GET. The client uses the global `Buffer`, so it is server-only.
- **Recovery after a consult:** build the nfeProc with `SefazDirectProvider.montarNfeProc(<signed XML from storage>, consulta.protNFeXml)`.


---

# w1d-devolucao-domain

# W1d: pure domain for the NF-e de devolução

All 9 modules and 8 spec files are written. **253 of 253 tests pass**: 191 in my 8 specs plus 62 in 3 related existing specs. `tsc` shows no errors in my files, and none of them contain NUL bytes.

## 1. Files created (nothing existing was modified)
- `app/fiscal/domain/chave-acesso-dv.ts`
- `app/fiscal/domain/devolucao-cfop.ts`
- `app/fiscal/devolucao/tipos.ts` (types only)
- `app/fiscal/devolucao/contrato.ts`
- `app/fiscal/devolucao/modo-referencia.ts`
- `app/fiscal/devolucao/saldo.ts`
- `app/fiscal/devolucao/validacao.ts`
- `app/fiscal/devolucao/tributacao.ts`
- `app/fiscal/devolucao/montagem.ts`
- Specs in `tests/fiscal/devolucao/`: `chave-acesso-dv`, `devolucao-cfop`, `devolucao-saldo`, `modo-referencia`, `devolucao-validacao`, `devolucao-tributacao`, `devolucao-montagem`, `devolucao-contrato`

None of these modules imports `node:*`, prisma or env. `montagem.ts` imports only types from `sefaz/nfe-xml-parser.service` and `interfaces/nfe.interface`. A spec reads the source files and fails if that changes.

## 2. Exported API

**chave-acesso-dv.ts**
- `UF_POR_CUF: Readonly<Record<string,string>>`
- `normalizarChaveAcesso(valor: unknown): string | null`: strips a leading "NFe" and separators; any other non-digit returns `null`.
- `calcularDvChaveAcesso(base43: string): string | null`
- `isChaveAcessoValida(chave: unknown): boolean`: strict, exactly 44 digits with a valid DV, no normalization.
- `interface ChaveAcessoPartes { chave; cUF; uf: string|null; aamm; ano: number; mes: number; cnpjCpf; modelo; serie: number; numero: number; tpEmis; cNF; dv; dvValido: boolean }`
- `parseChaveAcesso(chave: string): ChaveAcessoPartes | null`
- `validarChaveAcesso(raw: unknown, opts?: { modelos?: readonly string[] }): { ok: true; chave; partes } | { ok: false; codigo: "VAZIA"|"CARACTER_INVALIDO"|"TAMANHO"|"DV"|"MODELO"|"MES"; mensagem }`: models default to `["55","65"]`.
- `formatarChaveAcesso(chave: string): string`

**devolucao-cfop.ts**
- Sets: `CFOPS_DEVOLUCAO` (105 codes), `EXCECAO_1949_2949`, `CFOPS_MEI_DEVOLUCAO` (1202, 1553, 2202, 2553, 5202, 6202)
- `isCfopDevolucao(cfop: unknown): boolean`
- `isCfopPermitidoEmDevolucao(cfop: unknown, tpNF: "0"|"1"): boolean`
- `idDestDoCfop(cfop: unknown): 1|2|3|null`
- `validarCfopVsIdDest(cfop: unknown, idDest: unknown): boolean`
- `cfopsPermitidosDevolucao(ctx: { tipo: TipoDevolucaoCfop; idDest: IdDestCfop; crt? }): string[]`
- `mapearCfopDevolucao({ cfopOriginal, tipo: "VENDA_ENTRADA"|"COMPRA_SAIDA", idDestOriginal: 1|2|3, crt? }): { status: "MAPEADO"|"ESCOLHA"|"SEM_INVERSO"; cfop: string|null; opcoes: string[]; motivo }`

**tipos.ts**
- Enums: `TipoDevolucao`, `FonteDevolucao`, `EscopoDevolucao`, `ModoReferenciaDevolucao`, `IdDest`, `CrtEmitente`, `IndFinalDevolucao`
- Issues: `SeveridadeIssue`, `DevolucaoIssueCode` (union), `DevolucaoIssue { code; severidade: "ERRO"|"AVISO"; ordem?; mensagem }`
- Original taxes: `IcmsOriginal`, `IpiOriginal`, `PisOriginal`, `CofinsOriginal`, `ImpostoOriginal { icms|null; ipi|null; pis|null; cofins|null; temIbsCbs }`
- Return taxes: `TagIcmsDevolucao`, `MotivoRevisaoTributacao`, `AvisoTributacao`, `TributacaoDevolucaoItem { versao: 1; fonte; icms{tag,cst,csosn,orig,modBC,vBC,pICMS,vICMS}; pis{cst,vBC,p,v}; cofins; ipiDevol{pDevol,vIPIDevol}|null; requerRevisao; motivosRevisao; avisos; confirmada }`, `TributacaoOverride`
- Balance and snapshots: `SaldoItemOriginal`, `OrigemItemSnapshot`, `OrigemDevolucaoSnapshot`
- `RefDevolucaoItem`: the `NfeDevolucaoItem` row in memory, plus `cfopOriginal` and `cfopMapeamento`.

**contrato.ts**
- Error codes: `DEVOLUCAO_ERRO_CODIGOS` (`as const`), `DevolucaoErroCodigo`, `DEVOLUCAO_ERRO_HTTP`, `DEVOLUCAO_ERRO_MENSAGEM`, `isDevolucaoErroCodigo`, `respostaErroDevolucao(code, extras?) → { status; body: ErroDevolucaoResposta }`
- Types: `CriarDevolucaoBody`, `CriarDevolucaoResposta { draftId; reutilizado }`, `SaldoResposta`, `SaldoItemResposta`, `DevolucaoVinculadaResumo`, `DevolucaoDetalhe`, `DevolucaoItemDetalhe`, `OrigemResumo`, `AtualizarCabecalhoBody { devolvidaAposEntrega?: boolean|null; escopo?; tipo? }`, `AtualizarItensBody`, `AtualizarItemBody`, `ManualBody`, `ManualItemBody`, `ManualDestinatarioBody`, `ManualValidado` (union of `ManualValidadoXml` and `ManualValidadoChave`, discriminated by `modo`), `ManualResposta`, `ErroCampo`, `ResultadoParse<T>`
- Validators, all returning `{ ok, value } | { ok: false, erros }`: `parseCriarDevolucaoBody`, `parseAtualizarCabecalhoBody`, `parseAtualizarItensBody`, `parseManualBody`, `parseCriarDevolucaoResposta`
- Limits: `DEVOLUCAO_XML_MAX_CARACTERES` (1 MiB), `DEVOLUCAO_MAX_ITENS` (990)

**modo-referencia.ts**
- `DEVOLUCAO_REF_ITEM_PROD_DESDE_PADRAO = "2026-10-05"`
- `dataBrasilISO(instante: Date): string|null`
- `normalizarDesdeISO(desde): string`
- `modoReferenciaDevolucao(ambiente: string, agora: Date, desdeISO?: string|null): "ITEM"|"NOTA"`

**saldo.ts**
- Quantity helpers: `ESCALA_QUANTIDADE`, `quantidadeParaUnidades(v: unknown): number|null`, `unidadesParaQuantidade`, `temAteQuatroCasas`
- `baldeDoStatus(status): "AUTORIZADA"|"EM_PROCESSAMENTO"|"RASCUNHO"|"IGNORADA"`
- Input types: `LinhaSaldoDevolucao { chave; nItem; quantidade: number|string; statusDevolucao; devolucaoNfeId }`, `ItemOriginalParaSaldo`
- `calcularSaldoPorItem({ itensOriginais, linhas, excluirDevolucaoNfeId?, chave? }): SaldoItemOriginal[]`
- `isTotalmenteDevolvida`, `temDevolucaoConsumindo`

**validacao.ts**
- `ContextoValidacaoDevolucao { cabecalho|null; nota; emitente{cnpj,crt}; itens (NfeItem); refs; saldos?; originais?; idDestOriginal? }`, `RefValidacaoDevolucao`
- `validarDevolucao(ctx): DevolucaoIssue[]`
- `issuesBloqueantes`, `temBloqueio`

**tributacao.ts**
- Helpers: `round2`, `crtDeRegime`, `PIS_COFINS_CST_SUPORTADOS`, `familiaDaTag`, `tagCompativelComCrt`, `MENSAGEM_MOTIVO_REVISAO`
- `normalizarImpostoOriginal(raw: unknown): ImpostoOriginal`: idempotent.
- `tagIcmsParaDevolucao({ crt?, cst?, csosn? }): TagIcmsDevolucao|null`
- `proporcionalizar({ impostoOriginal, qOriginal, qDevolvida, vUnCom, crtEmitente?, crtOriginal?, tipoOperacao? }): TributacaoDevolucaoItem`
- `aplicarOverrideTributacao({ base, override?, confirmar?, crtEmitente, baseCalculoItem, tipoOperacao? }): { ok: true; tributacao } | { ok: false; erros }`

**montagem.ts**
- Input types: `OriginalParaDevolucao`, `ConfigParaDevolucao { id; cnpj; crt?; regimeTributario?; serieNfe?; ambiente }`, `ItemNfeOriginal`, `MontarRascunhoDeOriginalInput`
- Output types: `CabecalhoRascunhoDevolucao`, `ItemRascunhoDevolucao`
- `montarRascunhoDeOriginal(input): RascunhoDevolucaoMontado { tipo; fonte; escopo; indFinal; cabecalho; itens; refs; origem (origensJson); saldos; issues }`
- `descreverMotivosRevisao(ref): string`

## 3. Tests
```
cd "C:/Users/Casa/Documents/GitHub/ghd-plataform/.claude/worktrees/receivable-stock-listing-sync-9b376d" && NODE_OPTIONS=--max-old-space-size=8192 node /c/Users/Casa/Documents/GitHub/ghd-plataform/node_modules/vitest/vitest.mjs run --root . --pool=forks tests/fiscal/devolucao/ tests/fiscal/sefaz/chave-acesso.spec.ts tests/fiscal/cfop-catalog.spec.ts tests/fiscal/cstat-normalizacao.spec.ts
```
- **11 files, 253 tests passed, 0 failed.** My specs have 191 tests: chave-dv 18, cfop 41, saldo 14, modo 5, validação 37, tributação 42, montagem 21, contrato 13.
- **DV cross-check:** matches `calcularDV` on 200 generated bases, and on 200 keys from `montarChave` whose parts are compared field by field with `parseChave`.
- **Mutation check (files restored byte-identical afterwards):**
  - Breaking the DV rule and the 1072 duplicate check each made specs fail.
  - Breaking the `SENDING` bucket made nothing fail, because unknown statuses already fall into the same bucket.
- **`tsc --noEmit --incremental false`:** zero errors in my paths. The project total was 100 at the time: the 98 baseline plus other agents' work in progress.
- **NUL check:** `LC_ALL=C.UTF-8 grep -lP '\x00'` printed nothing. The command needs that locale in Git Bash; without it `grep -P` refuses to run.

## 4. Deviations from the plan or design, and why
- **Key normalization:** `normalizarChaveAcesso` returns `string | null`. It never deletes stray letters, which could turn a typo into a key that passes. `isChaveAcessoValida` is strict. `parseChaveAcesso` returns extra fields (`chave`, `uf`, `ano`, `mes`, `dvValido`), and `serie`/`numero` are numbers.
- **CFOP mapping:**
  - 5929 offers 1202, 1201, 1411, 1410, 1949; 6929 offers the 2xxx equivalents plus 2949. This merges the design's list with "use the underlying sale".
  - I added 5551/6551/7551 → x553 and 5501/5502/6501/6502 → x503/x504.
  - COMPRA_SAIDA given the supplier's CFOP (5/6/7xxx) returns ESCOLHA with the suggestion first.
  - MEI gets x202 (or keeps x553) as MAPEADO with `motivo: "MEI_RESTRITO"`.
  - An extra `motivo` field is always present.
- **PIS/COFINS:** CST 01–09 on an ENTRADA raises the aviso **and** `requerRevisao`. The plan §6.4 says "aviso e revisão", which wins over the task text. CST 49 is not flagged.
- **Tax structures:** `ImpostoOriginal` groups are `| null`, with extra fields (ST, credSN, qBCProd, `temIbsCbs`). `TributacaoDevolucaoItem` adds `versao`, `fonte`, `icms.modBC` and `confirmada`; confirmation is stored inside `tributacaoJson`.
- **Not requested but needed by `PUT …/itens`:** `aplicarOverrideTributacao`. It enforces the same allowlist, rates between 0 and 100, and only modBC 3.
- **Extra validation rules:**
  - `TIPO_OPERACAO_INCOERENTE`, `CFOP_SENTIDO_INVALIDO` (518/519) and `IDDEST_DIVERGENTE_ORIGINAL`.
  - `EMITENTE_ORIGINAL_DIVERGENTE`: for VENDA_ENTRADA the key's CNPJ must equal the emitter. This is a local rule, stricter than 1193.
  - `SALDO_NAO_VERIFICAVEL` blocks unless `confirmadoSemXml`.
  - `TRIBUTACAO_AUSENTE`, `TRIBUTACAO_NAO_SUPORTADA` (a confirmed tax row with no allowed tag still blocks) and `TRIBUTACAO_REGIME_INCOMPATIVEL` (590/591).
  - `IPI_DEVOL_INVALIDO`, `AMBIENTE_DIVERGENTE`, `NFREF_PROIBIDA` (1010) and a `COBRANCA_NAO_ENVIADA` aviso.
- **Montagem:**
  - It runs `validarDevolucao` as a preview, so a new draft always carries `ESCOLHA_PENDENTE` because `devolvidaAposEntrega` starts null.
  - The reference text says "NFC-e" for model 65 originals and uses the literal date from `dhEmi`.
  - `pagamentosJson` is `[{meio:"SEM_PAGAMENTO",valor:0}]` as the task says, not `[]` as the design says.
  - `indFinal` is always "1" because the parser has no `indFinal` field.
- **HTTP codes:** `SEM_XML` returns 409, following the plan table (the design said 422).
- **Missing reference date:** `modoReferenciaDevolucao` falls back to 2026-10-05 when the date is missing or invalid. An invalid `agora` in PRODUCAO returns NOTA.

## 5. Notes for the next waves (outside my ownership)
- **Personal data in the manual route's log:** the global logging middleware writes the body of `POST /fiscal/nfe/devolucao/manual` to `SystemLog`. `sanitizeDeep` only redacts by key name, so the whole `xmlOriginal` (addresses, CPF) would be stored. Before this route ships, add `xmlOriginal` to the redaction list or use multipart.
- **Env var:** the caller must read `NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE` and pass it in; `modo-referencia` reads no env.
- **idDest:** `ParsedIde` has no `idDest`, so the use case must supply `idDestOriginal` (from the parser addition in §2.2, or from `original.destinoOperacao`).
- **Repository:**
  - Assign the placeholder `numero = -(count+1)`.
  - API `escopo` maps to the `escopoSolicitado` column.
  - CFOP lives only in `NfeItem.cfop`; the snapshot's CFOP goes in `origensJson`.
  - Compute `ctx.saldos` with `excluirDevolucaoNfeId` set to the devolução itself, plus the key filter.
- **Builders:** emit `tributacao.icms.tag`, not `ICMS${cst}`. SN900 carries modBC, vBC, pICMS and vICMS. `ipiDevol` becomes `impostoDevol` plus the `vIPIDevol` total. Force tPag 90.
- **Still missing:** `montarRascunhoManual` (XML for COMPRA_SAIDA, or key plus items); `montarRascunhoDeOriginal` only builds VENDA_ENTRADA.
- **Frontend name mapping** (design 03 → here):
  - `normalizarChave` → `normalizarChaveAcesso`
  - `calcularDvChave` → `calcularDvChaveAcesso`
  - `sugerirCfopDevolucaoDeVenda` → `mapearCfopDevolucao`
  - `cfopsPermitidosDevolucaoEntrada` → `cfopsPermitidosDevolucao`
  - `cfopValidoDevolucaoEntrada` → `isCfopPermitidoEmDevolucao` + `validarCfopVsIdDest` + `CFOPS_MEI_DEVOLUCAO`
  - The row-action copy lives in `DEVOLUCAO_ERRO_MENSAGEM`.
- **To confirm against the MOC:** the rejection numbers quoted in messages 706/715 (NFC-e as devolução), 518/519, 590/591 and 1048. The MEI CFOP list comes from design 03.
- **Not supported:** alphanumeric CNPJ in the access key (raised in the adversarial review); keys are digits only.


---

# w1e-resptec-domain

# W1e report: per-company responsável técnico domain, central provider resolver, fiscal secret helper

All three modules and their specs are written and passing: 115 tests, with no tsc errors and no NUL bytes in my files. No existing file was modified.

## 1. Files created
- `C:/Users/Casa/Documents/GitHub/ghd-plataform/.claude/worktrees/receivable-stock-listing-sync-9b376d/app/fiscal/domain/resp-tec.ts`
- `C:/Users/Casa/Documents/GitHub/ghd-plataform/.claude/worktrees/receivable-stock-listing-sync-9b376d/app/fiscal/providers/nfe-provider-resolver.ts`
- `C:/Users/Casa/Documents/GitHub/ghd-plataform/.claude/worktrees/receivable-stock-listing-sync-9b376d/app/fiscal/certificate/fiscal-secret.ts`
- `C:/Users/Casa/Documents/GitHub/ghd-plataform/.claude/worktrees/receivable-stock-listing-sync-9b376d/tests/fiscal/resp-tec/resp-tec-validacao.spec.ts`
- `C:/Users/Casa/Documents/GitHub/ghd-plataform/.claude/worktrees/receivable-stock-listing-sync-9b376d/tests/fiscal/resp-tec/nfe-provider-resolver.spec.ts`
- `C:/Users/Casa/Documents/GitHub/ghd-plataform/.claude/worktrees/receivable-stock-listing-sync-9b376d/tests/fiscal/resp-tec/fiscal-secret.spec.ts`

## 2. Exported API

**`app/fiscal/domain/resp-tec.ts`** (client-safe)
- Its only runtime import is `isValidCnpj` from `app/lib/masks`, which has no imports of its own; everything else is a type import from `numeracao/tipos`.
- A spec reads the source and fails if a new import is added.
```ts
type RespTecModo = "PADRAO"|"PROVEDOR"|"PERSONALIZADO"|"NENHUM"
const RESP_TEC_MODOS: readonly RespTecModo[]
function isRespTecModo(valor: unknown): valor is RespTecModo
function normalizarProvedorFiscal(providerName: string|null|undefined): ProvedorFiscal   // non-SEFAZ_DIRECT => FOCUS_NFE
function modosPermitidos(providerName: string|null): RespTecModo[]
const RESP_TEC_LIMITES  // xContato 2-60, email 6-60, fone 6-14, csrtMax 128
interface RequisitoRespTecUf { exigeRespTec; exigeCsrtEmProducao; validaFornecedorAutorizado; fonte }
const REQUISITOS_RT_POR_UF: Readonly<Record<string, RequisitoRespTecUf>>  // PR {true,true,true}; AM MS PE SC TO {true,false,false}; frozen
function normalizarUf(uf: string|null|undefined): string|null
function requisitosRespTecUf(uf: string|null|undefined): RequisitoRespTecUf
interface RespTecEntrada { modo: string|null|undefined; cnpj?; xContato?; email?; fone?; idCsrt?; csrtNovo?: string|null; csrtConfigurado: boolean; removerCsrt?: boolean }
interface RespTecContexto { providerName: string|null; uf: string|null; ambiente: AmbienteFiscal }
interface RespTecNormalizado { modo; cnpj; xContato; email; fone; idCsrt; csrtNovo: string|null; removerCsrt: boolean }
type RespTecValidacao = {ok:true; normalizado: RespTecNormalizado} | {ok:false; erros: Record<string,string>}
function validarRespTec(i: RespTecEntrada, ctx: RespTecContexto): RespTecValidacao
const MSG_CSRT_NAO_ENVIADO_FOCUS
function csrtFormatoValido(csrt: string): boolean
type NivelAvisoRespTec = "info"|"alerta"|"bloqueio"
interface AvisoRespTec { codigo; nivel; mensagem }
interface AvisosRespTecContexto extends RespTecContexto { modo?; idCsrt?; csrtConfigurado?; padraoSistema?: {configurado: boolean; temCsrt: boolean}|null }
function avisosRespTec(ctx: AvisosRespTecContexto): AvisoRespTec[]
function paraMensagemSemAcento(mensagem: string): string
```
- **Error keys** returned in `erros`: `modo`, `cnpj`, `xContato`, `email`, `fone`, `idCsrt`, `csrt`.

**`app/fiscal/providers/nfe-provider-resolver.ts`** (pure)
```ts
interface RespTecRow { modo: string; cnpj; xContato; email; fone; idCsrt; csrtEnc: string|null }
type RespTecPolicy = {origem:"ENV_LEGADO"} | {origem:"PROVEDOR"} | {origem:"OMITIR"} | {origem:"EMPRESA"; dados: NfeRespTec}
interface NfeProviderFocus { baseUrl: string; path: "nfe"|"nfce"; token: string }
interface NfeProviderResolved { providerName: ProvedorFiscal; ambiente: AmbienteFiscal; modelo: ModeloFiscal; focus: NfeProviderFocus|null; sefaz: {uf: string}|null; numeracao: "DEXO"|"PROVEDOR"; respTec: RespTecPolicy }
type ConfigParaResolverNfe = Pick<CompanyFiscalConfig, "providerName"|"providerToken"|"ambiente"|"uf">
interface ResolveNfeProviderOpcoes { modelo: ModeloFiscal; respTecRow: RespTecRow|null; respTecAtivo: boolean; numeracaoDexoFocus: boolean; decryptSecret: (enc: string) => string }
interface ResolveRespTecContexto { uf: string|null; ambiente: AmbienteFiscal }
const FOCUS_BASE_URL; function focusBaseUrl(ambiente: AmbienteFiscal): string
function resolveNfeProviderConfig(config: ConfigParaResolverNfe, o: ResolveNfeProviderOpcoes): NfeProviderResolved
function resolveRespTec(providerName: string|null, row: RespTecRow|null, respTecAtivo: boolean, decryptSecret: (enc: string)=>string, ctx: ResolveRespTecContexto): RespTecPolicy
function respTecParaPayloadSefaz(p: RespTecPolicy): NfeRespTec|null|undefined   // undefined=env, null=omit
type RespTecPolicyLog; interface NfeProviderResolvedLog
function resolvedParaLog(r: NfeProviderResolved): NfeProviderResolvedLog  // focus.tokenConfigurado, dados.csrtConfigurado; does not mutate r
```

**`app/fiscal/certificate/fiscal-secret.ts`** (server only)
```ts
function encryptFiscalSecret(plain: string): string   // throws on empty
function decryptFiscalSecret(enc: string): string     // throws "Segredo fiscal ilegivel: ..." with no cause
```
- It delegates to `CertificateManagerService.encryptPassword/decryptPassword`, so a ciphertext from either one can be decrypted by the other.
- The service is only created on first use, so importing the module never aborts boot.

## 3. Tests
Run with `node .../vitest.mjs run --root . --pool=forks` on the spec files below.
- **My specs:**
  - `resp-tec-validacao.spec.ts`: 58 passed.
  - `nfe-provider-resolver.spec.ts`: 39 passed. This includes a 128-case check that "bloqueio" warnings match exactly the cases where the resolver throws.
  - `fiscal-secret.spec.ts`: 8 passed.
- **Related existing specs:** `certificate-manager.spec.ts` (6) and `nfe-resp-tec-env.spec.ts` (4) both pass, for 115/115 in total. `cstat-normalizacao.spec.ts` (27) also passed on an earlier run.
- **Mutation check:** I broke the source 17 different ways, one at a time, and restored it after each. The specs failed on all 17. One more mutation couldn't be applied because of a heredoc escaping issue; that behavior is still covered by the ASCII test.
- **tsc:** 99 errors in the whole repo, none in my files. The baseline is 98; the extra one is in another agent's in-progress work (`sefaz-direct.provider.ts`).
- **NUL bytes:** none in any of the six files.

## 4. Deviations and choices
- **Resolver config type:** `config` is typed as a `Pick` of the four fields it reads. A full `CompanyFiscalConfig` still type-checks.
- **Stored CSRT on Focus:** a CSRT saved while the company used SEFAZ direct is ignored on Focus, not treated as an error. Only entering a new CSRT or idCsrt on Focus PERSONALIZADO is an error, with the exact wording you gave. The resolver drops those fields, which keeps "Focus PERSONALIZADO without CSRT even when `csrtEnc` exists" (design §4.8) true.
- **NENHUM rule (972):** blocked in any UF that requires RT, in both production and homologação. I didn't limit it to production because homologação rejects 972 too.
- **Invalid `modo` in the database:** with the flag on, the resolver throws an "invalido" error instead of falling back to the env RT.
- **Modes without data:** fields are not validated, but come back trimmed so the use case can keep the saved values. A new CSRT is ignored in those modes. `removerCsrt` clears idCsrt, and sending it together with a new CSRT is an error.
- **Extra checks:** CNPJ and phone reject letters (only mask characters are allowed). xContato and email must stay in U+0020–U+00FF, the SEFAZ string range, so text that SEFAZ would reject with 225 fails at save time.
- **Extra table field:** each UF row has a `validaFornecedorAutorizado` flag (PR only), used for the 974 warning.
- **Extra helper:** `respTecParaPayloadSefaz` was not requested. I added it because the SEFAZ provider now uses `undefined` for "use env" and `null` for "omit".
- **Error format:** resolver errors are passed through `paraMensagemSemAcento`, so they come out as printable ASCII. Each contains "invalido" or "incompleto" (or "Token"), which `/issue` maps to 400.
- **Alphanumeric CNPJ:** not supported. `isValidCnpj` is digits-only, as the task specified.

## 5. Integration notes for other waves
- **Caller inputs:**
  - `respTecAtivo = isFiscalFeatureOn("RESP_TEC_EMPRESA", config.id)`
  - `numeracaoDexoFocus = isFiscalFeatureOn("NUMERACAO_V2_FOCUS", config.id)`
  - `decryptSecret = decryptFiscalSecret`
  - Only read `CompanyFiscalRespTec` when `respTecAtivo` is true, and fall back to `null` on P2021/42P01.
- **Where to call it:** call the resolver before the claim or reservation so RT errors never use up a number. For SEFAZ, pass `respTecParaPayloadSefaz(r.respTec)` as `respTec` to `prepararEmissao` / `SefazEmitPayload`.
- **Focus payload decorator:** for Focus with `EMPRESA`, map only the four fields (`cnpj/contato/email/telefone_responsavel_tecnico`), never a CSRT hash. `PROVEDOR` means send nothing.
- **Logging:** never log a `NfeProviderResolved` directly; pass it through `resolvedParaLog`.
- **Use case (`company-fiscal-resp-tec.usecase.ts`):**
  - Call `validarRespTec({...body, csrtNovo: body.csrtToken, csrtConfigurado: !!atual?.csrtEnc, removerCsrt}, {providerName, uf, ambiente})`.
  - Encrypt `normalizado.csrtNovo` with `encryptFiscalSecret`.
  - When `removerCsrt` is set, clear both `csrtEnc` and `idCsrt`.
  - On Focus, `normalizado.idCsrt` is null in PERSONALIZADO. Leave the stored `idCsrt`/`csrtEnc` untouched there if you want to keep them.
  - Save errors keep their accents; the route maps "inválid" to 400.
- **Card logic (`resp-tec-card.ts`):**
  - Use `modosPermitidos` and `avisosRespTec`.
  - Send `padraoSistema` from the server, computed as `resolveRespTecFromEnv()` → `{configurado: !!rt, temCsrt: !!rt?.csrt}`.
  - Don't send `idCsrt` or `csrtToken` for Focus.
- **Outside my ownership, still to do:** add `"csrt"` to `SENSITIVE_FIELD_PATTERNS`; strip `respTec`/`csrtEnc` in `sanitizeFiscalConfig` and `redactConfig`.
- **Line endings:** the new files use LF while the repo checks out as CRLF (`core.autocrlf=true`), same as the other agents' new files. `git add` will only print a warning.
