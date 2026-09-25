# NF-e evolution: test strategy, validation and rollout

Scope: numbering v2, cStat v2, Focus hardening with Dexo-controlled numbering, per-company responsável técnico (RT), and devolução (backend and frontend). This is a design only. Nothing was changed in the repo.

---

## 0. Ground rules this plan relies on

- **Names are placeholders.** The ledger, attempt, RT and devolução tables and the state names below (`NfeNumeroFiscal`, `NfeEmissaoTentativa`, `CompanyFiscalRespTec`, `NfeDevolucaoItem`; `RESERVADO | EM_TRANSMISSAO | INCERTO | REJEITADO_REUSAVEL | AUTORIZADO | CANCELADO | DENEGADO | INUTILIZADO | LIBERADO`) stand in for whatever the numbering-v2 design picks. Tests import them from one `states.ts`, so renaming is mechanical. The tests check behavior, not names.
- **Write characterization tests first.** Before any fiscal file changes, a first PR adds specs that pin how commit 1549bc4 behaves today, including bugs R1–R5. They must pass on the unchanged tree. Every v2 case also runs with flags OFF and must reproduce the old bug. That proves two things: flag OFF is bit-identical, and the test would catch the bug.
- **Constraints the tests enforce, derived from existing code:**
  - Do not touch `NfeSequenceService`. Its spec routes mocked SQL by text (`tests/fiscal/nfe-sequence.spec.ts:12-27`), and the SQL is subtle: the `RETURNING` branch at `app/fiscal/sequence/nfe-sequence.service.ts:188-202`. Numbering v2 goes in a new service that reuses the **same** `NfeSequence.proximoNumero` counter. That shared counter is what makes rollback safe (§2 P9, §1.9 R-1).
  - The v2 reservation path is raw SQL inside `$transaction`, the same style as `nfe-sequence.service.ts:54-125`, and takes an injectable `db = prisma`. The real-Postgres suite then doesn't need regenerated model delegates.
  - Use only new tables, never new columns on `NfeEmitida` or `NfeItem`. `NfeEmitida` reads use `include` (`nfe.emission.usecase.ts:1127-1130`, `nfe.repository.ts:321-324`), so a new column would need DDL before deploy.
  - Do not change `package.json` or `package-lock.json`: no `pg`, no testcontainers. A local npm 11.6 drops peers and `npm ci` on the VPS then fails.
- **Flag conventions.** Backend flags are read at call time with `=== "true"`, like `nfe-number-reuse.ts:24-26`. New backend flags drop the `NEXT_PUBLIC_` prefix so allowlists never get inlined into client bundles. Every flag has an allowlist that **fails closed**:
  - `NFE_NUMERACAO_V2_ENABLED` + `NFE_NUMERACAO_V2_CONFIG_IDS`
  - `NFE_FOCUS_HARDENING_ENABLED` + `_CONFIG_IDS`
  - `NFE_FOCUS_NUMERO_DEXO_ENABLED` + `_CONFIG_IDS` (only takes effect if numbering v2 is on for the same config)
  - `NFE_FOCUS_READBACK_ENABLED` + `_CONFIG_IDS`
  - `NFE_RESP_TEC_EMPRESA_ENABLED` + `_CONFIG_IDS`
  - `NFE_DEVOLUCAO_ENABLED` + `_CONFIG_IDS`
  - `NFE_FISCAL_LOG_ENABLED` (global)
  - Optional: `NFE_HOMOLOG_FAULT_CONFIG_IDS` (§5)
  - Frontend, set at build: `NEXT_PUBLIC_NFE_NUMERACAO_V2_UI_ENABLED`, `NEXT_PUBLIC_NFE_DEVOLUCAO_ENABLED`
  - Canarying per config happens through a backend capabilities endpoint, not a rebuild.
  - One pure resolver, `app/fiscal/domain/fiscal-flags.ts`, computes `isFiscalFeatureOn(feature, configId, env)`:
    - `ENABLED === "true"` and allowlist contains the id → on
    - allowlist `"*"` → on for all
    - `ENABLED === "true"` with an empty allowlist → **off**
    - anything other than exactly `"true"` → off

---

## 1. Emit harness: `NfeEmissionUseCase.emit` end to end

### 1.1 Why module mocks and not dependency injection

The use case builds its collaborators inside the constructor (`app/usecases/nfe-emission.usecase.ts:79-89`) and calls `prisma` directly in many places (`:147, :262, :331, :368, :907, :1113, :1120, :1127`). Module mocks are the only way in without touching production code. That is the same pattern as `tests/fiscal/nfe-emission-company.spec.ts:13-74`. The difference: that spec stops early on purpose ("PARADA-CONTROLADA", `:16-18`), and no spec today gets past `provider.emitir`. `MockNfeProvider` (`tests/fiscal/__mocks__/mock-nfe-provider.ts:23-101`) is not used by any use-case test.

### 1.2 Layout

The harness files contain no `vi.mock` calls, because those only hoist inside the spec file.

```
tests/fiscal/__harness__/
  emit-world.ts              singleton World (state + doubles + API)
  in-memory-prisma.ts        delegates nfeEmitida, nfeItem, nfeAuditLog, nfeSequence, nfeInutilizacao, user, $transaction
  fake-authority.ts          SEFAZ truth: per (cnpj, amb, modelo, serie, numero) → autorizada | cancelada | inutilizada | denegada
  scripted-provider.ts       INfeProvider driven by steps, backed by FakeAuthority
  fake-focus-server.ts       fetch stub with Focus HTTP semantics, backed by FakeAuthority (used with the REAL FocusNfeProvider)
  numeracao-memory.ts        in-memory v1 NfeSequenceService + v2 numbering service (contract-tested against real PG, §2)
  invariants.ts              global invariants I1–I8
  nfe-columns-1549bc4.json   NfeEmitida/NfeItem scalar column list at base commit
  states.ts                  ledger/attempt state names (re-exported from app once v2 exists)
```

### 1.3 Mock map

| Module | Double | Reason |
|---|---|---|
| `app/lib/prisma` (both specifiers) | `in-memory-prisma` | direct writes throughout emit |
| `repositories/nfe.repository` | **real** | R1 lives in `updateDraft` (`nfe.repository.ts:379-381`); real `findDraftById`, `persistCalculo`, `addAuditLog` |
| `repositories/company-fiscal.repository` | world configs | `findByIdForUser` / `findByUserId` |
| `fiscal/sequence/nfe-sequence.service` | `numeracao-memory` (v1 contract) | raw SQL is out of reach in memory; real SQL runs in §2 |
| v2 numbering service | `numeracao-memory` (v2 contract) | same |
| `fiscal/providers/provider-factory` | returns world provider; can throw (certificate load) | R5 |
| `fiscal/storage/fiscal-storage.service` | in-memory files; `failNext(method)` | R5 |
| `generators/danfe-pdf.service`, `danfe-nfce-pdf.service`, `danfe-avatar` | stubs | avoid pdf-lib and sharp |
| `repositories/customer.repository`, `usecases/customer.usecase` | stubs | constructor at `:87-88` |
| calculator, `nfe-xml-builder.service`, `contingencia.service`, `domain/*` | **real** (pure) | payload assertions (`numero_nota`/`numero`) |
| `NfeCancelamentoUseCase`, `NfeInutilizacaoUseCase` | **real** | cases 5 and 6 |

Wiring in each spec (async factories import the harness lazily):

```ts
const W = () => import("./__harness__/emit-world").then(m => m.world());
vi.mock("../../app/lib/prisma", async () => ({ default: (await W()).prisma }));
vi.mock("@/app/lib/prisma",     async () => ({ default: (await W()).prisma }));
vi.mock("../../app/repositories/company-fiscal.repository", async () => (await W()).modules.companyFiscalRepo);
vi.mock("../../app/fiscal/sequence/nfe-sequence.service",   async () => (await W()).modules.sequenceV1);
vi.mock("../../app/fiscal/numeracao/nfe-numeracao.service", async () => (await W()).modules.numeracaoV2);
vi.mock("../../app/fiscal/providers/provider-factory",      async () => (await W()).modules.providerFactory);
vi.mock("../../app/fiscal/storage/fiscal-storage.service",  async () => (await W()).modules.storage);
// + danfe-pdf, danfe-nfce-pdf, danfe-avatar, customer.repository, customer.usecase
```

### 1.4 In-memory state machine

**Tables.** `NfeEmitida` (with items), `NfeAuditLog`, `NfeSequence`, `NfeInutilizacao`, and the v2 tables `NfeNumeroFiscal` and `NfeEmissaoTentativa`.

**Indexes enforced by the double.** Violations throw `{ code: "P2002" }`.
- `NfeEmitida (cfcId, ambiente, serie, numero, modelo) WHERE cfcId NOT NULL AND numero > 0`. Copied from `docs/multi-cnpj-sql.md` §3e.
- `NfeEmitida.chaveAcesso` globally unique (`prisma/schema.prisma:1896`).
- `NfeSequence (cfcId, ambiente, serie, modelo)`.
- Ledger unique `(cfcId, ambiente, modelo, serie, numero)`.
- At most one active binding per `nfeId`.
- At most one `EM_ANDAMENTO` attempt per `nfeId`.

**Type validation.** Writes are checked against `nfe-columns-1549bc4.json` plus declared types. For example `cStatRejeicao Int?` (`schema.prisma:1935`) given a string throws a `PrismaClientValidationError`-like error. That reproduces **R3** exactly. An unknown column throws "Unknown argument". With flags OFF, any write or read of a column that did not exist at 1549bc4 fails the test, which enforces "no new column".

**v2 DDL switch.** With `v2DdlApplied = false`, any v2 table access throws `relation "NfeNumeroFiscal" does not exist`. All flag-OFF runs use `false`, which proves the code can deploy before the DDL.

**Transactions.** `$transaction(cb)` snapshots state and restores it if `cb` throws. Single-statement `updateMany` is atomic, matching Postgres. Real lock semantics are proven in §2, not here.

**Interleaving.** `reset({ interleave: true, seed })`: every delegate call first awaits a seeded 0–3 microtask hops (`await Promise.resolve()`, never timers). Cases 9 and 10 loop over seeds 1..200.

**Spies for static guards.** Any `aggregate({_max:{numero}})` or `orderBy:{numero:"desc"}` in the numbering path fails the test (no `MAX(numero)+1`). Every `proximoNumero` write is recorded and must be monotonic (no `numero--`).

### 1.5 Fake authority, scripted provider, fake Focus server

**`FakeAuthority`** mirrors SEFAZ rules:
- Emitting a number that is already authorized with a different chave → 539. Same chave → 204.
- Emitting an inutilized number → 206.
- Consulting a chave it doesn't hold → 217. Rejections are never stored.
- After cancellation, consult returns cancelada.
- It counts authorizations per `(key, numero)` and per `nfeId` (drives invariant I2).

**`ScriptedProvider`** steps, queued per tenant:
```ts
authorize()                              // authority stores, returns autorizada (chave built from numero + cNF)
reject(cStat: number | string, msg?)     // e.g. reject(778), reject("974")
deny(110 | 301 | 302 | 303)
processing(...consultSteps)              // emit → processando; polls consume the steps
lostResponse({ received: boolean })      // received=true: authority AUTHORIZES, provider returns {status:"erro", chaveAcesso}
preSendFailure(msg)                      // shape of sefaz-direct.provider.ts:199-223 (build/sign error returned as "erro", no network)
consultNotFound() | consultError() | consultAuthorized()
hold()                                   // deferred promise; release() via world, for in-flight retries
throwError(err)
```

**`FakeFocusServer`** (transport `"http"`) stubs `fetch` with `vi.stubGlobal` and runs the **real** `FocusNfeProvider`:
- `POST /v2/nfe?ref` → 202, or 201 when configured sync.
- 422 `erro_validacao_schema`; 422 `already_processed` / `nfe_autorizada` if the ref was already authorized (ref is burned); 422 `pending_operation`.
- 400 `empresa_nao_habilitada`; 401 with `text/html` body so `res.json()` throws (`focus-nfe.provider.ts:70`); 403 `permissao_negada`; 429.
- `GET /v2/nfe/{ref}` → `processando_autorizacao` for N polls, then `autorizado` / `erro_autorizacao` with `status_sefaz` as a **string** / `denegado` / `cancelado`; 404 `nao_encontrado`.
- Chave returned as `"NFe" + 44`.
- Auto-numbers when the payload has no `numero`. `numero_nota` is ignored, which reproduces the production divergence of DB 12/13/14 vs nNF 3/4/5. Honors `numero`/`serie` when present.
- Option `renumberTo` simulates Focus contingency renumbering.

**Fake timers.** `world.emit()` calls `vi.useFakeTimers({ toFake: ["setTimeout","clearTimeout"] })`, starts `uc.emit()`, then loops `await vi.advanceTimersByTimeAsync(3000)` until the promise settles (at most 20 iterations), then restores real timers. That covers polling at `nfe-emission.usecase.ts:627` and `:1094`. `Date` stays real.

### 1.6 Harness API

```ts
export interface World {
  reset(o?: { seed?: number; interleave?: boolean; v2DdlApplied?: boolean }): void; // also vi.unstubAllEnvs/Globals
  flags(f: Partial<Record<FiscalFlag, string>>): void;           // vi.stubEnv; unset flags stubbed to ""
  tenant(s: { provider: "SEFAZ_DIRECT" | "FOCUS_NFE"; transport?: "scripted" | "http";
              ambiente?: "HOMOLOGACAO" | "PRODUCAO"; serie?: number; proximoNumero?: number;
              userId?: string; cfcId?: string; isDefault?: boolean; uf?: string }): Tenant;
  draft(t: Tenant, o?: DraftOverrides): Promise<string>;          // REAL createDraft (placeholder -(n), nfe.repository.ts:242-257) + REAL updateDraft
  editDraft(t: Tenant, nfeId: string, patch: NfeDraftUpdateInput): Promise<void>; // REAL updateDraft (reproduces R1)
  emit(t: Tenant, nfeId: string, o?: { asUserId?: string; idempotencyKey?: string }): Promise<EmitOutcome>;
  cancel(t: Tenant, nfeId: string): Promise<unknown>;
  inutilizar(t: Tenant, r: { serie: number; ini: number; fim: number }): Promise<unknown>;
  switchProvider(t: Tenant, p: "SEFAZ_DIRECT" | "FOCUS_NFE"): void;
  switchAmbiente(t: Tenant, a: "HOMOLOGACAO" | "PRODUCAO"): void;
  script(t: Tenant): ScriptBuilder;          // .emit(step).consult(step)
  failNext(target: "storage.saveXmlOriginal" | "providerFactory" | "nfeEmitida.update#numero"): void;
  release(holdId: string): void;
  sefaz: FakeAuthority; focus: FakeFocusServer;
  // reads
  row(nfeId: string): NfeRow; audit(nfeId: string): string[]; numerada(nfeId: string): number[];
  ledger(t: Tenant, serie?: number): LedgerRow[]; attempts(nfeId: string): AttemptRow[];
  seq(t: Tenant, serie?: number): number; providerCalls(t?: Tenant): ProviderCall[]; logs(): string[];
  assertInvariants(): void;                  // called in afterEach
}
export interface EmitOutcome { result?: EmissionResult; error?: Error; http: number }
```

`http` comes from the pure mapper extracted from `app/routes/fiscal.routes.ts:944-956` (`mapEmitErrorToHttp`), so the route behavior is asserted without Fastify.

### 1.7 Global invariants (`afterEach`)

| # | Invariant |
|---|---|
| I1 | No two `NfeEmitida` rows share `(cfc, amb, serie, modelo, numero > 0)` |
| I2 | The authority never holds two authorizations for one `nfeId`, or two chaves for one `(key, numero)` |
| I3 | Every authority-authorized `(key, numero)` has a ledger row `AUTORIZADO`/`CANCELADO` bound to the note whose `row.numero` equals nNF |
| I4 | Every v2-era number below `proximoNumero` has exactly one ledger state. No silent holes |
| I5 | `proximoNumero` writes are monotonic |
| I6 | An attempt is not a consumption: `attempts(nfeId).length ≥ 1` never implies more than one number consumed per document |
| I7 | Secret sentinels (`providerToken="TOKEN-SENTINEL-…"`, `certificadoSenhaEnc="SENHA-SENTINEL"`, `csrt="CSRT-SENTINEL"`) never appear in `logs()`, audit `detalhes`, stored `xmlOriginal`, or error messages. Allowed only in outgoing Focus `Authorization` headers |
| I8 | Devolução specs: the in-memory prisma throws on any access to `product`, `stockLog`, `productListing`, `order` delegates (fiscal-only rule) |

### 1.8 Paired flag matrix

Each case runs in two modes:
- **(v2)** the relevant allowlist contains `t.cfcId`, `v2DdlApplied = true`.
- **(legacy)** all new flags `""`, `v2DdlApplied = false`, `NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED="true"` (production value). The legacy run asserts the **1549bc4 outcome, bug included**. That is both the zero-regression proof and the evidence that the test has teeth.

### 1.9 Mandatory cases

Shorthand: `t` = tenant, `A/B/C` = drafts, `→` = assertion.

**Case 0: the reported scenario.** Parametrized over F ∈ {`localValidation` (`dest.codMunicipio=""`), `reject(778)`, Focus-http 422 `erro_validacao_schema`, Focus-http GET `erro_autorizacao` + `status_sefaz:"974"`} × provider {SEFAZ_DIRECT scripted, FOCUS http}.
```ts
const t = w.tenant({ provider, serie: 1, proximoNumero: 100 });
const A = await w.draft(t); w.script(t).emit(authorize());   expect((await w.emit(t, A)).result!.numero).toBe(100);
const B = await w.draft(t, faultFor(F)); w.script(t).emit(stepFor(F));
const b1 = await w.emit(t, B);                              // fails
await w.editDraft(t, B, fixFor(F));                         // REAL updateDraft → DRAFT (R1)
w.script(t).emit(authorize()); const b2 = await w.emit(t, B);
const C = await w.draft(t); w.script(t).emit(authorize()); const c = await w.emit(t, C);
```
- (v2):
  - `localValidation`: `b1.http === 400` and `w.numerada(B)` is empty (nothing reserved). Otherwise `b1.http === 200` with `status` REJECTED / `REJEITADO_REUSAVEL`, `row(B).cStatRejeicao` is an int, `motivoRejeicao` is non-null, and there is no `ENVIO_INCERTO`.
  - `b2.result.numero === 101`; every entry in `w.numerada(B)` is 101; `c.result.numero === 102`; `w.seq(t) === 103`.
  - `w.sefaz.authorized(t)` equals `[100, 101, 102]`; ledger 100–102 are `AUTORIZADO`.
  - With Focus-http, the POST body has `numero:"101"` and `serie:"1"`.
- (legacy): `b2` numero is 102. For the `"974"` variant, `b1` throws (`http 500`), audit shows `ENVIO_INCERTO`, `motivoRejeicao` is null, and the next retry takes a new number. This pins R1, R2 and R3.

**Case 1: local error after reservation (R5).**
- Faults: `failNext("storage.saveXmlOriginal")`, `failNext("providerFactory")` (certificate load, `:344-351` runs after reservation at `:238`), and `preSendFailure()` (`sefaz-direct.provider.ts:199-223`).
- (v2): the failed attempt ends with `providerCalls` having no network send, row not `SENDING`, ledger 101 `RESERVADO` bound to B. Retry B → 101 authorized. New C → 102.
- (legacy): storage and factory faults → row DRAFT, retry → 102. `preSendFailure` → `SENDING` forever (`:521-535`), and B cannot be re-emitted (`findDraftById` only accepts DRAFT|REJECTED, `nfe.repository.ts:321-323`).
- Sub-case: `failNext("nfeEmitida.update#numero")` with P2002 (a legacy row occupies 101) → (v2) ledger 101 becomes `CONFLITO` (never reused), at most 3 hops, audit written, no loop.

**Case 2: SEFAZ rejection**, table-driven.

| cStat | expected ledger state | retry of the same document |
|---|---|---|
| 209, 225, 598, 778, 974, "974", 999 | `REJEITADO_REUSAVEL` | same number |
| 110, 205, 301, 302, 303 | `DENEGADO` | never the same number; document blocked per design |
| 204, 539 | treated as uncertain | consult by chave first; if authorized → `AUTORIZADO` |
| 206 | `INUTILIZADO` | next attempt takes a new number |

The legacy run pins `lookupCStat` as it is today: ≥600 → desconhecido, and 205/206/301–303 wrongly reusable (`tests/fiscal/nfe-emission-reuse.spec.ts` stays unchanged).

**Case 3: Focus errors** (http transport). Each row asserts the ledger state, that the row is never `SENDING` for a pre-authorization definitive error, the HTTP status, and whether a retry reuses the number.
- 422 `erro_validacao_schema` → reusable, same number.
- 400 `empresa_nao_habilitada`, 401 text/html, 403 → `RESERVADO` with a configuration error. After fixing the token, retry → same number, no consult needed (Focus never accepted).
- 429 → same number, message says retry later.
- POST network reset or 5xx → `INCERTO`; see case 7.
- Re-POST 422 `already_processed` → consult ref → `AUTORIZADO`.
- 422 `pending_operation` → poll, no re-POST.
- GET `denegado` → `DENEGADO`.
- GET 404 after an uncertain POST → confirmed not received → re-POST the same ref with the same `numero`.
- Provider consult with 403/404 JSON is never "processando" (today `focus-nfe.provider.ts:146-155` has no `res.ok` check).

**Case 4: authorized = consumed forever.** After AUTHORIZED:
- `w.emit(t, A)` → 404/409, no provider call, no NUMERADA.
- `editDraft` is a no-op (existing guard).
- `w.inutilizar(t, {ini: 101, fim: 101})` is blocked locally, with no `provider.inutilizar` call.
- New C → next number.

**Case 5: cancelled.** Real `NfeCancelamentoUseCase`, script cancel success → `CANCELADO`. New C → 102. Re-emit A is refused. Inutilizing a range containing 101 is blocked. Cancel failure → still `AUTORIZADO`.

**Case 6: inutilized.**
- 6a: B holds `RESERVADO` 101, user abandons B, `w.inutilizar(101..101)` → authority marks inutilizada, ledger `INUTILIZADO`, `seq` unchanged (the advance at `nfe-inutilizacao.usecase.ts:173-181` only moves the counter forward). New C → 102.
- 6b: a range that contains a number bound to an active document (`RESERVADO`, `REJEITADO_REUSAVEL`, `INCERTO`) is **blocked** with no provider call. Inutilização must not hide the counter bug.
- 6c: externally inutilized (`w.sefaz.inutilize(101)`), retry B → 206 → `INUTILIZADO`; B's next attempt → 102; C → 103.
- 6d: future range (proximo=102, range 105–106) → pin the v2 policy: either blocked, or 102–104 recorded as skipped (I4).
- Legacy: the range advance for modelo 55 only (`:170`) is pinned.

**Case 7: timeout → consult first.**
```ts
w.script(t).emit(lostResponse({ received: false })); await w.emit(t, B);   // → INCERTO (v2) | SENDING forever (legacy)
w.script(t).consult(consultNotFound()).emit(authorize()); const r = await w.emit(t, B);
expect(w.providerCalls(t).map(c => c.op).slice(-2)).toEqual(["consultar", "emitir"]);
expect(r.result!.numero).toBe(101);                                          // C → 102
```
- An inconclusive consult (`consultError()`) → no `emitir` call; stays `INCERTO`; a C emitted meanwhile gets 102.
- Focus variant: POST reset → GET 404 → re-POST same ref and `numero`.
- Focus variant: GET `processando_autorizacao` → poll only.
- If the v2 design persists the cNF, the retry after a confirmed not-received reuses the same chave.

**Case 8: timeout but authorized.** `lostResponse({ received: true })` → retry → consult authorized → `handleAuthorized`.
- Exactly one `emitir` in total; `w.sefaz.authorizationsFor(B) === 1`; ledger `AUTORIZADO`; C → 102; XML retrieved, or `XML_AUTORIZADO_PENDENTE` audit (`:831-838`).
- Focus `renumberTo: 7`: audit `NUMERO_DIVERGENTE {esperado: 101, real: 7}`, `row.numero === 7`. If 7 collides → audit `NUMERO_DIVERGENTE_COLISAO`, the result is still AUTHORIZED, no throw. Ledger 101 is flagged for human review.

**Case 9: double click / frontend retry.** Seeds 1..200.
```ts
const [x, y] = await Promise.all([w.emit(t, B), w.emit(t, B)]);
```
- (v2): exactly one outcome with AUTHORIZED, the other `http === 409`; one `emitir`; one attempt; `seq` advanced by 1.
- (legacy): loser `http === 500` (message "ja esta em processamento", `fiscal.routes.ts:956`).
- In-flight variant: `hold()` on the first → second returns 409 → `release()` → a third call returns the current state with no new reservation.
- Idempotency-Key variant, if adopted: the same key twice → same payload, one attempt.

**Case 10: two users at once.** Same tenant, two collaborator ids resolving to the same `dataOwnerId`. `Promise.all` over B and C for 200 seeds → numbers {101, 102}. Also 20 documents → exactly 101..120.

**Case 11: tenants.**
- tA and tB both at serie 1, proximo 101, concurrent → both 101. tA's rejection leaves tB untouched.
- `w.emit({...tB}, A)` → 404, no claim (`updateMany` scoped by `userId`, `:147-150`).
- Multi-CNPJ inside one tenant: independent counters; only the default config adopts the legacy NULL row (`nfe-sequence.service.ts:143-150`).

**Case 12: séries.** Series 1 and 3 independent. B is REJECTED at serie-1 #101, edited to serie 3 → next attempt uses a serie-3 number. Serie-1 #101 stays ledgered and is never assigned to another document unless the release policy explicitly allows it (then covered by §2 P6).

**Case 13: ambientes.** B REJECTED at H #101 → `switchAmbiente(P)` → retry takes P's counter. The H ledger entry is untouched. Parity with `nfe-number-reuse.ts:59`.

**Case 14: Focus × SEFAZ.**
- A via FOCUS-http with Dexo numbering → POST contains `numero:"101"` → nNF 101. `switchProvider(SEFAZ)` → B 102. Switch back → C 103. `w.sefaz.authorized(t)` equals `[101, 102, 103]`.
- Uncertain Focus attempt, then switch to SEFAZ → the retry consults **Focus by ref with the token of that attempt**. Only after Focus says not found does it send through SEFAZ direct with 101.
- Dexo numbering OFF + read-back ON → Focus auto-numbers → divergence audited. This documents why read-back and Dexo numbering must be on together when providers are mixed.

**NFC-e (modelo 65) regression.** A PDV-style draft uses its own counter and the same state machine. `finance.usecase.ts:1910` calls the same `emit`.

**R-1: v2 → v1 rollback.** v2 reserves 101–103 (102 `REJEITADO_REUSAVEL`) → all flags `""` → v1 new document gets **104**. A v1 retry of the 102 document never duplicates a number. I4 is relaxed for v1-era numbers.

**R-2: forbidden pair.** Flag ON with `v2DdlApplied = false` → error **before** the claim. No reservation, no status change, HTTP 503-style "numeração v2 indisponível".

### 1.10 Contract tests keep the fake honest

`tests/fiscal/numeracao/numeracao-contract.ts` exports case functions (`reserve`, `bind`, `markTransmitting`, `markOutcome`, `release`, `consume`, and ordering rules). They run against `numeracao-memory` (`numeracao-contract.memory.spec.ts`) and against real SQL (`numeracao-contract.pg.spec.ts`). A fake that drifts from real SQL fails the PG run.

---

## 2. Real-Postgres concurrency suite (opt-in)

### 2.1 Guard: `tests/fiscal/pg/pg-guard.ts`

```ts
export const PG_URL = process.env.FISCAL_PG_TEST_URL;
export const pgDescribe = PG_URL ? describe : describe.skip;
export function assertLocalTestDb(url: string, env = process.env): void {
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error("FISCAL_PG_TEST_URL: protocolo invalido");
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname)) throw new Error("FISCAL_PG_TEST_URL precisa ser local");
  if (!/^\/dexo_fiscal_test(_[a-z0-9]+)?$/.test(u.pathname)) throw new Error("banco precisa chamar dexo_fiscal_test*");
  if (/supabase|pooler|pgbouncer|amazonaws|sa-east-1/i.test(url)) throw new Error("URL remota recusada");
  for (const k of ["DATABASE_URL", "DIRECT_URL"]) if (env[k] && sameDb(env[k]!, url)) throw new Error(`igual a ${k}`);
}
// on connect: SELECT current_database() must match AND to_regclass('"__dexo_fiscal_test_marker"') IS NOT NULL
```

- If the variable is set but the URL is invalid, the suite **throws**; it never silently skips.
- `pg-guard.spec.ts` (always runs): rejects a Supabase pooler URL, `sa-east-1`, a remote IP, a wrong database name, and equality with `DATABASE_URL`. Accepts `postgresql://postgres:x@127.0.0.1:55432/dexo_fiscal_test`.

### 2.2 Client

`tests/fiscal/pg/pg-client.ts`: `createTestPrisma(limit)` returns `new PrismaClient({ datasources: { db: { url: PG_URL + "?connection_limit=" + limit + "&pool_timeout=30" } } })`. The datasource name `db` comes from `prisma/schema.prisma:5`.

- Raw SQL only (`$queryRawUnsafe` / `$executeRawUnsafe`), so it works with either generated client.
- Specs `vi.mock` `app/lib/prisma` to a test client when `PG_URL` is set, else a dummy.
- v2 services get `db` injected so two pools can simulate two API processes.
- `beforeEach`: `TRUNCATE "NfeSequence","NfeEmitida","NfeItem","NfeAuditLog","NfeNumeroFiscal","NfeEmissaoTentativa","NfeDevolucaoItem" RESTART IDENTITY CASCADE`.

### 2.3 Ephemeral Postgres (PowerShell)

Use `docker cp` + `psql -f`. Piping SQL through PowerShell 5.1 re-encodes accented text.

```powershell
docker version    # daemon must answer; otherwise start Docker Desktop manually
docker run -d --rm --name dexo-fiscal-pg -e POSTGRES_PASSWORD=dexo_test -e POSTGRES_DB=dexo_fiscal_test `
  -p 127.0.0.1:55432:5432 postgres:15-alpine -c max_connections=200
docker exec dexo-fiscal-pg pg_isready -U postgres -d dexo_fiscal_test
# Match prod major: read-only `SHOW server_version;` in Supabase; change the image tag if it is not 15.

$env:DATABASE_URL="postgresql://x:x@127.0.0.1:5432/x"; $env:DIRECT_URL=$env:DATABASE_URL
node "$MAIN\node_modules\prisma\build\index.js" migrate diff --from-empty `
  --to-schema-datamodel "$WT\prisma\schema.prisma" --script | Out-File -Encoding ascii "$SCR\00-base.sql"   # no DB contact
docker cp "$SCR\00-base.sql" dexo-fiscal-pg:/tmp/00.sql
docker cp "$WT\tests\fiscal\pg\sql\01-partial-indexes-prod.sql" dexo-fiscal-pg:/tmp/01.sql
docker cp "$WT\prisma\ddl\2026-09-XX-nfe-numeracao-v2.sql"     dexo-fiscal-pg:/tmp/02.sql
docker cp "$WT\prisma\ddl\2026-09-XX-nfe-resp-tec-empresa.sql" dexo-fiscal-pg:/tmp/03.sql
docker cp "$WT\prisma\ddl\2026-09-XX-nfe-devolucao.sql"        dexo-fiscal-pg:/tmp/04.sql
foreach ($f in "00","01","02","03","04") { docker exec dexo-fiscal-pg psql -v ON_ERROR_STOP=1 -U postgres -d dexo_fiscal_test -f "/tmp/$f.sql" }
docker exec dexo-fiscal-pg psql -U postgres -d dexo_fiscal_test -c 'CREATE TABLE "__dexo_fiscal_test_marker"(id int)'
$env:FISCAL_PG_TEST_URL="postgresql://postgres:dexo_test@127.0.0.1:55432/dexo_fiscal_test"
node "$MAIN\node_modules\vitest\vitest.mjs" run --root "$WT" --pool=forks tests/fiscal/pg
docker stop dexo-fiscal-pg
```

- If `Out-File -Encoding ascii` mangles non-ASCII comments, run the diff from Git Bash with `>`.
- `01-partial-indexes-prod.sql` holds the prod partial indexes copied verbatim from `docs/multi-cnpj-sql.md`: §3d `NfeSequence_cfcId_ambiente_serie_modelo_key`, §3e `NfeEmitida_cfcId_ambiente_serie_numero_modelo_key`, §5 `*_legacy_null_key`. Its header comment pastes the output of a read-only prod `SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('NfeSequence','NfeEmitida')`.
- `indices-prod-parity.pg.spec.ts` asserts `pg_get_indexdef` matches that pasted text, to catch drift.
- `02–04` are **the same files** applied in prod, so the DDL is the fixture.

### 2.4 Cases

| ID | Scenario | Assertion |
|---|---|---|
| P1 | 50 parallel v2 reservations on the same key, via 2 clients × `connection_limit=25` | numbers exactly {1..50}; `proximoNumero=51`; 50 ledger rows; 0 errors |
| P1-neg | Mutation control: a test-only SQL "read without FOR UPDATE + `pg_sleep(0.01)` + write" | **must** produce duplicates. If it doesn't, fail the suite: the positive test would have no detection power |
| P2 | Double emit claim: 20 concurrent v2 claim transactions (`UPDATE … WHERE status IN (…) RETURNING` + attempt `INSERT`) for one `nfeId` | exactly 1 winner, 1 attempt row; the partial unique on the `EM_ANDAMENTO` attempt rejects the rest |
| P3 | Two tenants (cfg A and B) interleaved, 30 each | each {1..30}. Plus legacy NULL-row adoption race: 10 concurrent first reservations by the default config → contiguous, one row adopted. Covers existing `reservarPorEmitente` at `nfe-sequence.service.ts:136-218` for real |
| P4 | Séries 1 and 3 in parallel; 20 concurrent **first-ever** reservations on a new série | independent; {1..20}. Proves the `ON CONFLICT … RETURNING` branch at `:188-202` |
| P5 | Ambientes H and P, same cfc and série | independent |
| P6 | Release race (only if the design has `LIBERADO`): release 7 while the owner retries and a new document reserves (`FOR UPDATE SKIP LOCKED`) | exactly one party gets 7; releasing from `EM_TRANSMISSAO`/`INCERTO` is refused by the SQL guard |
| P7 | Connection-pool exhaustion: `connection_limit=2`, `pool_timeout=1`, 30 parallel | successes distinct and contiguous; failures are P2024/P2028; afterwards `proximoNumero = 1 + successes` and ledger rows = successes |
| P8 | Atomicity: force the ledger insert to fail after the counter bump (test-only CHECK violation) | transaction rolls back; counter unchanged |
| P9 | v1 `NfeSequenceService.reservarProximoNumero(..., opts)` and v2 concurrently on one key | all distinct and contiguous. Rollback compatibility |
| P10 | Unique backstop: two `NfeEmitida` rows forced to the same `(cfc, amb, serie, numero>0, modelo)` | 23505 |
| P11 | Devolução balance: original item qty 5, 10 concurrent authorizations of 1 unit through the serialized path | exactly 5 succeed; cancelling one frees 1 |

---

## 3. Regression suites and new spec files

### 3.1 Must pass unchanged

With all new flags unset (`vitest.config.ts` sets none):

- **All of `tests/fiscal/**`:**
  - certificate-*, cfop-catalog, code128, company-fiscal-*, cross-module-smoke, danfe-*, fiscal-calculator, focus-nfce-path, inf-cpl, load-avatar, ncm-padrao-autofill
  - nfe-customer-mapping, nfe-draft-*, nfe-emission-company, nfe-emission-nfce-validate, nfe-emission-reuse, nfe-frete-*, nfe-list-busca-e-modelo, nfe-periodo-filtro, nfe-relatorio-mensal, nfe-resp-tec-env, nfe-sequence*, nfe-update-draft-guard, nfe-xml-builder-focus-infcpl
  - pagamento-card, provider-contract, soap-client-agent, valor-input-parse
  - `sefaz/*`, `nfce/*`
- **Outside that folder:**
  - tests/finance-fiscal-draft, finance-multi-payment, finance-nfce-endpoint, finance-nfce-venda-parcelada, finance-receipt-installments, finance-receivable-items, finance-status-filter
  - tests/first-allowed-page, page-defs-href-drift
  - tests/import/import-{ibr-nfe, ibr-pacote, ibrsoft, nfe, vaapt-pacote}
  - tests/nfe-import/*, tests/nfe-lookup-products
  - tests/pdv-actions, pdv-nfce-helper
  - tests/security/{log-redaction, idor-isolation, secret-cipher}
- **Full suite:** the set of failing test ids must be a subset of the 1549bc4 baseline failures. The 3 jsdom specs are known failures.

### 3.2 Known traps: design around them, do not adapt the specs

| Spec | Trap | Rule |
|---|---|---|
| `nfe-sequence.spec.ts:12-27` (+ multi-cnpj, modelo) | mocked SQL routed by text | never edit `NfeSequenceService`; v2 goes in a new service |
| `focus-nfce-path.spec.ts:10-16` | stubbed response has no `headers` | hardened code reads `res.headers?.get?.("content-type")` null-safely, or only under the flag |
| `nfe-draft-modelo-isolation.spec.ts:80` | asserts `findExistingDraft("user-1","55")` | no third parameter; devolução gets its own repository method and endpoint |
| `nfe-emission-company.spec.ts:28-35, 55-62, 135-141` | 4 prisma delegates, 4 repository methods, exact 5-argument `reservarProximoNumero` call | with flags OFF, no new delegate or method may be touched. If this spec needs edits, that is a regression. The one acceptable change is adding a `vi.mock` for a new module whose import has side effects, and a lazy import is preferred |
| `cstat-mapper.spec.ts`, `nfe-emission-reuse.spec.ts` | pin `lookupCStat` / `shouldReuseNumero` | leave both untouched; v2 classifier is a new file |
| `nfe-resp-tec-env.spec.ts` | pins `resolveRespTecFromEnv` | keep it exported and unchanged; the new resolver wraps it |
| `security/log-redaction.spec.ts` | pins `SENSITIVE_FIELD_PATTERNS` | adding `"csrt"` (missing at `logging.middleware.ts:383-403`) is covered by a **new** spec |
| `cross-module-smoke.spec.ts:127-170` | instantiates use cases | new constructor collaborators must build without DB or env |

### 3.3 New spec files

**PR-0: characterization.** Must pass on untouched 1549bc4.
- `tests/fiscal/characterization/focus-provider-http-legacy.spec.ts`: 200/201/202 → processando; 422 passes the string `codigo` through; 401 html → `erro` with a SyntaxError message; consult 404 → processando.
- `focus-payload-golden.spec.ts`, fixture `__fixtures__/focus-payload-1549bc4.json`: deep equality, includes `numero_nota`.
- `sefaz-xml-golden.spec.ts`: deterministic `dhEmi`/`cNF` (`sefaz-direct.provider.ts:109-111`), RT from env.
- `emit-legacy-flows.spec.ts`: harness, flags OFF, pins R1–R5.
- `issue-route-status-legacy.spec.ts`: mapper table from `fiscal.routes.ts:944-956`.

**Harness and numbering**
- `tests/fiscal/__harness__/*` (§1.2)
- `tests/fiscal/numeracao/`:
  - `numeracao-contract.ts`
  - `numeracao-contract.memory.spec.ts`
  - `emit-numeracao-casos.spec.ts` (cases 0–8)
  - `emit-concorrencia.spec.ts` (cases 9–10)
  - `emit-isolamento.spec.ts` (cases 11–13)
  - `emit-focus-sefaz-troca.spec.ts` (case 14)
  - `rollback-v2-v1.spec.ts` (R-1, R-2)
  - `cstat-classificador-v2.spec.ts` (string→int, ≥600, 205/206/301–303, Focus textual codes)
  - `fiscal-flags.spec.ts` (fail-closed allowlist, dependency Focus numbering ⇒ v2)
  - `issue-route-status-v2.spec.ts` (409 for a lost claim)
  - `static-guards.spec.ts`: scans `app/fiscal/**`, `app/usecases/nfe-*` and `app/repositories/nfe.repository.ts` for `_max: { numero`, `orderBy: { numero: "desc" }`, `MAX("numero")`, `proximoNumero" - `, 14-digit CNPJ literals with a valid check digit, and requires the diagnostic script to contain no `update(` / `create(` / `delete` / `$executeRaw` other than `SET TRANSACTION READ ONLY`, and no imports from `providers/` or `sefaz/`

**Focus**
- `tests/fiscal/focus/focus-provider-hardening.spec.ts`: full HTTP table, `AbortController` timeouts under fake timers, `denegado`, chave `NFe` prefix stripped
- `focus-payload-numero.spec.ts`: ON → `numero` + `serie`; OFF → golden
- `focus-readback-chave.spec.ts`: nNF and série parsed from positions 26–34 and 23–25 of the 44 digits; divergence and collision audits

**Responsável técnico**
- `tests/fiscal/resp-tec/resp-tec-resolver.spec.ts`: precedence company → env → none; Focus with mode `PROVEDOR` sends nothing (Kiko)
- `resp-tec-focus-payload.spec.ts`, `resp-tec-sefaz-xml.spec.ts`: company CNPJ; CSRT hash only on SEFAZ direct
- `resp-tec-config-usecase.spec.ts`: CSRT encrypted at rest, never returned by GET, redacted in `redactConfig`
- `tests/security/log-redaction-csrt.spec.ts`

**Devolução**
- `tests/fiscal/devolucao/`:
  - `cfop-devolucao.spec.ts`: 105 codes with `indDevol=1`, 1949/2949 exception, mapping table, MEI list, CFOP digit vs `idDest`
  - `devolucao-elegibilidade.spec.ts`: blocks cancelled, denegada, non-authorized, and historic imports without XML
  - `devolucao-saldo.spec.ts`: per original `nItem` taken from the authorized XML via `parseNfeXml`; only authorized, non-cancelled devoluções count
  - `devolucao-draft-usecase.spec.ts`: dedicated endpoint; never copies `orderId`/`numeroPedido`
  - `devolucao-xml-sefaz.spec.ts`: `DFeReferenciado` is the last child of `det`; no `NFref`; `tPag=90`; `impostoDevol` only when applicable; `nItem` not positional
  - `devolucao-focus-payload.spec.ts`: item-level reference fields; no `notas_referenciadas`
  - `devolucao-sem-estoque.spec.ts` (I8)
  - `devolucao-stats-isolamento.spec.ts`: `getStats`, monthly report, `findAuthorizedByOrderId`
- `tests/notas-fiscais/nfe-list-actions.spec.ts`, `devolucao-form.spec.ts` ("devolvida após entrega?" gating, quantity bounds), `emit-button-state.spec.ts` (pure decision; `isEmitting` set before `await saveCurrentStep`, fixing `nfe-wizard.tsx:457-466`)

**Postgres:** `tests/fiscal/pg/*` (§2).
**Diagnostic:** `tests/fiscal/diagnostico/gaps.spec.ts` (pure hole and holder computation over fixtures).

---

## 4. Gate commands (Windows)

```powershell
$MAIN="C:\Users\Casa\Documents\GitHub\ghd-plataform"
$WT="$MAIN\.claude\worktrees\receivable-stock-listing-sync-9b376d"
$BASE="$MAIN\.claude\worktrees\tsc-base-1549bc4"
$SCR="<session scratchpad>"
```

**G0: preflight**
- `git worktree list` shows `$WT` as a real worktree (an empty folder would edit main).
- `Test-Path "$WT\.env"` is False (vitest reads `.env`).
- `git -C $WT diff --quiet 1549bc4 -- package.json package-lock.json` must succeed.
- Git Bash: `git -C "$WT" diff --name-only 1549bc4 | xargs grep -lP '\x00'` must be empty (the Write tool can emit NUL bytes).

**G1: Prisma validate, regenerate, restore** (only when `schema.prisma` changed)
```powershell
$env:DATABASE_URL="postgresql://x:x@127.0.0.1:5432/x"; $env:DIRECT_URL=$env:DATABASE_URL
node "$MAIN\node_modules\prisma\build\index.js" validate --schema "$WT\prisma\schema.prisma"
Copy-Item -Recurse -Force "$MAIN\node_modules\.prisma\client" "$SCR\prisma-client-backup"
node "$MAIN\node_modules\prisma\build\index.js" generate --schema "$WT\prisma\schema.prisma"
(Get-Item "$MAIN\node_modules\.prisma\client\index.js").Length   # must be > 200000 (not the 2076-byte stub)
Select-String "$MAIN\node_modules\.prisma\client\index.d.ts" -Pattern "NfeNumeroFiscal" -Quiet   # True
# ... run G2–G5 ...
node "$MAIN\node_modules\prisma\build\index.js" generate --schema "$MAIN\prisma\schema.prisma"   # RESTORE
Select-String "$MAIN\node_modules\.prisma\client\index.d.ts" -Pattern "NfeNumeroFiscal" -Quiet   # False
# if restore fails: Remove-Item -Recurse "$MAIN\node_modules\.prisma\client"; Copy-Item -Recurse "$SCR\prisma-client-backup" "$MAIN\node_modules\.prisma\client"
```
The main `node_modules` is shared by 8 worktrees and other sessions. Keep the window short, and never use `npx prisma` or a different Prisma version.

**G2: vitest**
```powershell
Remove-Item -Recurse -Force "$WT\node_modules\.vite","$MAIN\node_modules\.vite\vitest" -ErrorAction SilentlyContinue
$env:NODE_OPTIONS="--max-old-space-size=8192"
node "$MAIN\node_modules\vitest\vitest.mjs" run --root "$WT" --pool=forks tests/fiscal tests/notas-fiscais tests/security tests/finance-fiscal-draft.spec.ts tests/finance-nfce-endpoint.spec.ts tests/pdv-actions.spec.ts tests/pdv-nfce-helper.spec.ts
git -C $MAIN worktree add --detach $BASE 1549bc4
node "$MAIN\node_modules\vitest\vitest.mjs" run --root "$BASE" --pool=forks --reporter=json --outputFile="$SCR\vt-base.json"
node "$MAIN\node_modules\vitest\vitest.mjs" run --root "$WT"   --pool=forks --reporter=json --outputFile="$SCR\vt-head.json"
```
A small node script compares the failed `fullName` sets. New failures must be empty; head passed count must be at least base passed plus the new tests.

**G3: tsc multiset** (Git Bash, both trees on the same regenerated client)
```bash
TSC="$MAIN/node_modules/typescript/lib/tsc.js"
node "$TSC" --noEmit --incremental false -p "$BASE/tsconfig.json" > "$SCR/tsc-base.txt"
node "$TSC" --noEmit --incremental false -p "$WT/tsconfig.json"   > "$SCR/tsc-head.txt"
norm(){ tr -d '\r' < "$1" | grep 'error TS' | sed -E 's#^.*\.claude/worktrees/[^/]+/##; s#\\#/#g; s/\([0-9]+,[0-9]+\)//' | sort; }
norm "$SCR/tsc-base.txt" > "$SCR/b.n"; norm "$SCR/tsc-head.txt" > "$SCR/h.n"
wc -l "$SCR/b.n" "$SCR/h.n"            # base ~98, but trust the regenerated number
comm -13 "$SCR/b.n" "$SCR/h.n"         # NEW errors (with multiplicity): must be empty
comm -23 "$SCR/b.n" "$SCR/h.n"         # informational
```
- `sort` without `-u` keeps duplicate messages visible.
- `--incremental false` avoids a stale `tsconfig.tsbuildinfo`.
- A head output with 0 lines means the command failed, not success.

**G4: eslint on touched files** (Git Bash)
```bash
cd "$WT" && FILES=$(git diff --name-only --diff-filter=ACMR 1549bc4 -- '*.ts' '*.tsx')
ESLINT_USE_FLAT_CONFIG=false node "$MAIN/node_modules/eslint/bin/eslint.js" --no-eslintrc -c .eslintrc.json $FILES; echo "eslint rc=$?"   # rc must be 0
```

**G5: next build**, twice: flags OFF, then UI flags ON (Git Bash)
```bash
cd "$WT" && export DATABASE_URL=postgresql://b:b@127.0.0.1:5432/b DIRECT_URL=postgresql://b:b@127.0.0.1:5432/b
node scripts/generate-build-id.mjs
node --stack-size=4000 "$MAIN/node_modules/next/dist/bin/next" build > "$SCR/nb-off.log" 2>&1; echo "rc=$?"
NEXT_PUBLIC_NFE_DEVOLUCAO_ENABLED=true NEXT_PUBLIC_NFE_NUMERACAO_V2_UI_ENABLED=true \
  node --stack-size=4000 "$MAIN/node_modules/next/dist/bin/next" build > "$SCR/nb-on.log" 2>&1; echo "rc=$?"
grep -c "Failed to compile" "$SCR"/nb-*.log     # 0
grep -c "Route (app)" "$SCR"/nb-*.log           # >= 1
grep -rl "NFE_NUMERACAO_V2_CONFIG_IDS\|SENTINEL" .next/static | wc -l   # 0
```
- Check the build's own `rc`, not the rc of a composed command.
- The build fails if a client module imports `chave-acesso.ts` (it imports `node:crypto`).

**G6: Postgres suite** (§2.3), when Docker is available.
**G7: cleanup.** `git -C $MAIN worktree remove $BASE`, then restore the Prisma client (G1).

---

## 5. Manual validation in homologação only

### 5.1 Where it runs

On the production deployment, with flag allowlists containing **only homologação config ids**. Do not run a local API against the prod DB: `npm run api` starts workers that mutate prod, and a local machine refreshing ML tokens knocks accounts into ERROR.

### 5.2 Tenants

**T-FOCUS: Kiko**, `cmrxiixko1spi1837uhscntiy` (HOMOLOGACAO, FOCUS_NFE, own token).
- Needs the user's and Kiko's OK: the test notes will show up in Kiko's NF-e list.
- Use a **dedicated unused série** in the normal range 1–889 (for example 777). Confirm it's unused first. Avoid 890–999, which are reserved séries and would be rejected.
- Today every Kiko homologação emission gets **974** (Focus not authorized as RT in UPD PR). That is exactly the R2/R3 check for flow 3. Positive Focus flows (4, 5, 8, 9, 10, 14) wait until the contador authorizes Focus in UPD. Alternative: another Focus homologação token that is **not** one of the two shared-token groups.

**T-SEFAZ:** an internal tenant with `SEFAZ_DIRECT`, `HOMOLOGACAO` and a valid A1, found with a read-only query. The global `NFE_RESP_TEC_CNPJ` applies to every SEFAZ-direct tenant (`sefaz-direct.provider.ts:197`), so pick a UF whose homologação accepts that RT. The first plain emission is a smoke test; a 972–975 result means fix the RT for that tenant before running the matrix. Same dedicated série rule.

### 5.3 Before every session (read-only)

```sql
SELECT id, "userId", "providerName", ambiente, uf, "certificadoValidoAte"
FROM "CompanyFiscalConfig" WHERE id IN ('<T-FOCUS>','<T-SEFAZ>');          -- both HOMOLOGACAO, or abort
SELECT count(*) FROM "NfeEmitida" WHERE "companyFiscalConfigId" IN ('<T-FOCUS>','<T-SEFAZ>') AND serie = 777;  -- 0 on the first run
```
On the VPS: `grep -E '^NFE_(NUMERACAO|FOCUS|RESP_TEC|DEVOLUCAO|HOMOLOG)' /var/www/dexo/.env`. Only those two ids may appear.

### 5.4 Optional: homologação-only fault injection

Without it, flows 1b, 7 and 8 rely only on the harness and Postgres suite.

- Enabled only when `NFE_HOMOLOG_FAULT_CONFIG_IDS` contains the config **and** `config.ambiente === "HOMOLOGACAO"`.
- Triggered by a marker in `informacoesComplementares`: `#DEXO-FAULT:before_send#`, `#DEXO-FAULT:lost_not_sent#`, or `#DEXO-FAULT:lost_after_send#`. The marker is stripped before the payload is built.
  - `lost_not_sent`: the provider is not called; returns `erro`.
  - `lost_after_send`: the provider is called; its response is discarded and `erro` returned.
- Unit tests prove it is inert in PRODUCAO even when listed, inert when the env var is absent, and always logs `fault.injected`.

### 5.5 Flows

Evidence for each flow:
- `nfeId`
- `SELECT evento, detalhes, "createdAt" FROM "NfeAuditLog" WHERE "nfeId"=$1 ORDER BY 3`
- ledger and attempt rows
- DANFE nNF
- `pm2 logs dexo-api --nostream --lines 2000 | grep '\[fiscal\]'`
- diagnostic delta

| # | Flow | How to trigger it safely | Expected |
|---|---|---|---|
| 1a | local error before reservation | T-SEFAZ, clear the destinatário CEP | HTTP 400, no NUMERADA, ledger empty |
| 1b | local error after reservation | marker `before_send` → fix → retry → new document | same number, then the next number |
| 2 | SEFAZ rejection | T-SEFAZ item NCM `00000000` (passes local check `nfe-emission.usecase.ts:753`, SEFAZ rejects: unknown NCM, ≥600 family) → fix NCM in the wizard (goes through `updateDraft`) → retry | REJECTED with int cStat and reason; retry authorized with the **same** number |
| 3 | Focus error | T-FOCUS normal emission (974 today) | REJEITADO_REUSAVEL, cStat 974 stored as int, reason not null, HTTP 200 (not 500), retry keeps the number |
| 4 | authorized | T-SEFAZ normal | AUTORIZADO; DANFE nNF equals `numero`; `POST /issue` again from the logged-in console → 409/404, no NUMERADA |
| 5 | cancelled | cancel the note from flow 4 | CANCELADO; new document gets the next number |
| 6 | inutilized | marker `before_send`, abandon the document, inutilize that single number in the UI; then try inutilizing a number held by a REJECTED document | first ACEITA and INUTILIZADO, next document gets the next number; second blocked with no SEFAZ call |
| 7 | timeout, not sent | marker `lost_not_sent` → retry | audit shows CONSULTA before ENVIADA; 217 → same number authorized |
| 8 | timeout, authorized | marker `lost_after_send` → retry | consult → authorized; a single ENVIADA; next document gets the next number |
| 9 | double click | logged-in console: `await Promise.all([1,2].map(()=>fetch(api+"/fiscal/nfe/"+id+"/issue",{method:"POST",headers:{"Content-Type":"application/json",email},body:"{}"})))` | one 200 and one 409; one NUMERADA |
| 10 | two users | two collaborator sessions click Emitir on two drafts in the same second, or `Promise.all` over two ids | distinct consecutive numbers |
| R | reported scenario | flow 4 → flow 2 → corrected retry → new document | numbers n, n+1 (after rejection), n+2 |

Cases 11–14 are proven by the harness and Postgres suite. Case 13 must not be exercised manually, because it requires PRODUCAO.

---

## 6. DDL, deploy order, flags, canary, diagnostic

### 6.1 DDL documents

Each document has an executable twin in `prisma/ddl/`, and each is applied **after** its code has been deployed with flags OFF (new tables, so code goes first).

1. **`docs/nfe-numeracao-v2-sql.md`** → `prisma/ddl/2026-09-XX-nfe-numeracao-v2.sql`
   - `CREATE TABLE IF NOT EXISTS "NfeNumeroFiscal"`, `"NfeEmissaoTentativa"`
   - `CHECK` on state values; no foreign keys (module convention, `docs/multi-cnpj-sql.md` "Sem FOREIGN KEY")
   - unique `(cfcId, ambiente, modelo, serie, numero)`
   - partial unique active binding `(nfeId) WHERE estado IN ('RESERVADO','EM_TRANSMISSAO','INCERTO','REJEITADO_REUSAVEL')`
   - attempts: unique `(nfeId, tentativa)` and partial unique `(nfeId) WHERE resultado='EM_ANDAMENTO'`
2. **`docs/nfe-resp-tec-empresa-sql.md`**: `"CompanyFiscalRespTec"` (unique `companyFiscalConfigId`, `modo`, CNPJ, contact fields, `idCsrt`, `csrtEnc`).
3. **`docs/nfe-devolucao-sql.md`**: `"NfeDevolucaoItem"` with unique `(devolucaoNfeId, chaveOriginal, nItemOriginal)` (rule 1072) and index `(originalNfeId, nItemOriginal)`.

Every document carries:
- a header warning against `prisma db push` and `prisma migrate`;
- **APPLY** wrapped in `BEGIN…COMMIT`. The tables are empty, so the Supabase editor is fine and no `CONCURRENTLY` is needed;
- **VERIFY** (read-only);
- **ROLLBACK**;
- the "forbidden pair" note.

The flags table in `docs/fiscal-sefaz-direto.md` (around lines 187–199) gets the new flags.

**VERIFY** (run before and after):
```sql
SELECT to_regclass('"NfeNumeroFiscal"'), to_regclass('"NfeEmissaoTentativa"');
SELECT c.relname, i.indisvalid, i.indisunique, pg_get_indexdef(i.indexrelid)
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE i.indrelid IN ('"NfeNumeroFiscal"'::regclass, '"NfeEmissaoTentativa"'::regclass);   -- every indisvalid = t
SELECT count(*) AS parciais, count(*) FILTER (WHERE indexdef ILIKE 'CREATE UNIQUE%') AS unicos
FROM pg_indexes WHERE indexdef ILIKE '% WHERE %';   -- before: 11/7; after: 11+new / 7+new
SELECT count(*) FROM "NfeNumeroFiscal";              -- 0 while flags are OFF
```
The editor wraps statements in a transaction, and `IF NOT EXISTS` reports "skipping" on an invalid index. Only `indisvalid` proves the index is good.

**ROLLBACK:** set flags OFF and restart the API first. Then back up and drop:
```sql
CREATE SCHEMA IF NOT EXISTS ops_backup;
CREATE TABLE ops_backup."NfeNumeroFiscal_YYYYMMDD" AS TABLE "NfeNumeroFiscal";
-- same for attempts
DROP TABLE …;
```
Normally leave the tables in place; they are inert. **Forbidden pair:** flags ON with tables dropped. Harness case R-2 guarantees that fails before the claim.

### 6.2 VPS deploy (per PR)

Standard deploy since 25/09/2026. The build runs **in** `/var/www/dexo`: `.next` stores absolute paths, so a build made in another folder cannot be moved in. The site is unstable for about 3 minutes while `next build` rewrites `.next`; the API stays up. The deploy never runs `prisma migrate deploy` or `db push`: DDL is a separate, reviewed step, applied before the code that uses it.

```bash
cd /var/www/dexo && git status --porcelain && git log -1 --oneline   # clean; note the current prod sha
ANTES=$(git rev-parse HEAD)
git pull --ff-only
git diff --name-only "$ANTES"..HEAD -- package-lock.json prisma/schema.prisma   # decides the next step
# package-lock.json listed → npm ci (postinstall = prisma generate). Never restart pm2 after a failed install
# only prisma/schema.prisma listed → pinned generate, never `npx prisma` (`npm run build` does not generate the client):
#   node node_modules/prisma/build/index.js generate --schema=prisma/schema.prisma
# either way, node_modules/.prisma/client/index.js must be > 200KB: a stale client breaks dexo-api at runtime (tsx does no type check)
cp -a .next .next.bak-$(date +%Y%m%d-%H%M%S)      # frontend rollback point
npm run build; echo "rc=$?"                        # build-id + next build
# routine pre-flight gate right here, read-only (docs/fiscal-numeracao-v2.md, "Gate de pré-voo"): no EM_TRANSMISSAO/INCERTO
#   reservation with a live lease, no note in VALIDATING/SIGNING/SENDING, no pending inutilização. A parked BLOQUEADO does not
#   count here; switching a flag on, widening a list or rolling back uses the strict gate instead
pm2 restart dexo-api dexo-frontend                 # + dexo-sync-orders when sync code changed. NEVER --update-env; NEVER `restart all` (re-runs the catalog-stats batch)
curl -s http://127.0.0.1:3000/api/version          # new sha in build id
pm2 logs dexo-api --lines 100 --nostream
```

### 6.3 Flag sequence

| Step | Action | Gate to move on |
|---|---|---|
| 0 | Diagnostic snapshot **T0**, read-only (§6.4) | saved to `/var/www/dexo-diag/diag-T0.csv` |
| 1 | Deploy PR-0/PR-1 code, **flags OFF, no DDL** | 24h: homologação smoke on T-SEFAZ and T-FOCUS gives the same audit event sequence as before; `/fiscal/nfe/:id/issue` error rate unchanged (query `SystemLog` by `details.url`, never by `action`) |
| 2 | Apply DDL 1 (and 2, 3 when their code is live) | VERIFY clean |
| 3 | Backend allowlists = homologação ids only; edit `.env`, `pm2 restart dexo-api` | manual matrix (§5) passes; diagnostic shows no new holes. **Superseded — see Status on 25/09/2026 below** (the homologação UAT was replaced) |
| 4 | `NEXT_PUBLIC_*` UI flags → `npm run build` → `pm2 restart dexo-frontend` | UI shows features only where the capabilities endpoint says the config is allowlisted |
| 5 | **Production canary, numbering v2:** add 1 low-volume, consenting SEFAZ-direct PRODUCAO config | 3 business days: 0 P2002 in numbering; 0 ledger numbers with two active bindings; 0 `numero ≠ nNF(chave)`; 0 INCERTO older than 15 min; no increase in `/issue` 500s; no new abandoned numbers in the diagnostic |
| 6 | **Replaced on 25/09/2026 (owner's decision):** the "3 configs for 48 h" step gives way to an explicit list of every SEFAZ_DIRECT config in **both** allowlists, never `*` | 24 h and 48 h vigil (below) |
| 7 | Focus Dexo numbering + read-back in prod | only for a Focus prod tenant, **on from its first prod note** (Kiko after UPD authorization) |
| 8 | RT per company | Kiko row `modo=PROVEDOR` (send nothing); SEFAZ-direct tenants with no row fall back to env, byte-identical per golden |
| 9 | Devolução | ~~homologação now; prod not before 05/10/2026, when `DFeReferenciado` becomes mandatory in production~~ **Superseded — see Status on 25/09/2026 below** (live in production for the DLS since 24/09/2026, referencing by note until 04/10) |

**Stop rule:** any criterion breached → remove the id from **both** allowlists (never set `NFE_NUMERACAO_V2_ENABLED=false`: the note would fall to V1 and be renumbered), run the strict pre-flight gate and `pm2 restart dexo-api` (seconds). Rollback is safe because the counter is shared (R-1, P9). A binary rollback also works with the new tables present: old code never touches them.

**Status on 25/09/2026.** The runbook for everything below is in `docs/fiscal-numeracao-v2.md`, "Rollout e rollback".
- Step 5 is done: the DLS config has been the production canary since 22/09/2026. Its criteria, measured on 25/09/2026, passed: no double binding, no INCERTO, no `numero ≠ nNF(chave)`, P2002 only from `OrderRepository`, no `/issue` 500 for the DLS.
- Step 6 and the homologação UAT of step 3 were replaced by the owner's decision. The wider rollout puts the same **explicit list** of the SEFAZ_DIRECT configs in `NFE_NUMERACAO_V2_CONFIG_IDS` and `NFE_DEVOLUCAO_CONFIG_IDS` at once: devolução goes on together with numbering (owner's decision of 25/09/2026). The per-config devolução rollback protection and the cancellation that survives a slow SEFAZ are deployed before that switch. Never `*`: `isDevolucaoAtiva` ignores the provider, and the Focus sub-flag reads the same allowlist. A new SEFAZ_DIRECT config joins both lists at onboarding.
- Vigil at 24 h and 48 h after each widening, read-only: reservations in `EM_TRANSMISSAO`/`INCERTO`/`BLOQUEADO` untouched for more than 15 min; `ABANDONADO`/`INUTILIZADO`/`CONSUMIDO_EXTERNO` reservations moved there since the switch (by `updatedAt`, so an older reservation that changes state counts), reading `motivo`; `numero ≠ nNF(chave)` on model-55 AUTHORIZED/CANCELLED notes since the switch; `grep -h P2002 ~/.pm2/logs/dexo-api-*.log | grep -v OrderRepository`; `/issue` 500s in `SystemLog` by `details.url`; `SEQUENCIA_ATRAS_DA_SEFAZ` in the log. Anything unexplained → stop rule.
- Every restart that switches on, widens or rolls back a list is preceded by the strict pre-flight gate (0 reservations in `EM_TRANSMISSAO`/`INCERTO`/`BLOQUEADO` in any config, 0 notes in `VALIDATING`/`SIGNING`/`SENDING`, 0 pending inutilização) and restarts only `dexo-api`, the only process that reads these flags. Rolling back one config adds the pre-flight filtered by that config. A routine code deploy, with no flag change, uses the routine gate (live lease instead of any `EM_TRANSMISSAO`/`INCERTO`/`BLOQUEADO`); the definition of both lives only in `docs/fiscal-numeracao-v2.md`, "Gate de pré-voo".
- Devolução on the wider list: watch by cStat the first devolução of each authorizer that never received one (GO, MG, PR, SP) and, from 05/10, the first by-item devolução of each authorizer in production; 225, 321 or 1010 → remove that UF's configs from `NFE_DEVOLUCAO_CONFIG_IDS` only. The by-item format was authorized in homologação at SVRS on 25/09/2026 (protocol 342260000975434).
- Step 4 does not apply to numbering v2 or devolução: neither has a `NEXT_PUBLIC_*` flag. The UI follows the server (`numeracao` in the responses, `GET /fiscal/nfe/devolucao/disponibilidade`).
- Step 7 stays off: `NFE_NUMERACAO_V2_FOCUS_ENABLED=false` until the Focus prerequisites in `docs/roteiro-emissao-focus-nfe.md` are met.
- Step 9: devolução has been live in production for the DLS since 24/09/2026. Until 04/10 production references the original by note; from 05/10 by item (`NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE`, default 2026-10-05, one global value).

### 6.4 Read-only diagnostic: `scripts/fiscal/diagnostico-numeracao-nfe.ts`

**Guarantees:**
- Runs inside `prisma.$transaction(async tx => { await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY"); await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '30s'"); … })`. Postgres itself refuses any write.
- Explicit column lists only. Never selects `providerToken`, `certificadoSenhaEnc`, CSRT or destinatário data.
- Imports nothing from `providers/`, `sefaz/`, or integrations. Enforced by `static-guards.spec.ts`.
- Prints the DB host.

**Output**, per `(cfcId, ambiente, modelo, serie)`:
- `proximoNumero`
- highest authorized number
- **holes**: numbers below `proximoNumero` with no AUTHORIZED/CANCELLED/INUTILIZED row and outside any ACEITA inutilização range
- numbers held by REJECTED/DRAFT/SENDING rows
- SENDING rows with age, chave present or not, and provider
- Focus divergence (`numero` vs nNF parsed from the chave after stripping the `NFe` prefix)
- per-document number history from NUMERADA audits

A `sugestao` column is **text only**, for example "consultar chave no portal SEFAZ antes de qualquer inutilização". Nothing is ever executed: no release, no inutilização, no reconcile button.

**Runbook:**
```bash
cd /var/www/dexo
git log -1 --format=%h -- scripts/fiscal/diagnostico-numeracao-nfe.ts; wc -l scripts/fiscal/diagnostico-numeracao-nfe.ts   # the VPS may have an old copy
npx tsx scripts/fiscal/diagnostico-numeracao-nfe.ts [--config-id <id>] [--user-id <id>] --csv /var/www/dexo-diag/diag-$(date +%F).csv
```
It is not `npm run api`, so no workers start. A human acts on the findings: SEFAZ portal consult by chave, then an inutilização through the UI if appropriate.

---

## 7. Observability

### 7.1 One line format

Module `app/fiscal/observability/fiscal-log.ts`, active when `NFE_FISCAL_LOG_ENABLED === "true"` or any v2 flag is effective for the config:
```
[fiscal] {"v":1,"ts":"2026-09-17T12:00:00.000Z","evt":"emit.resultado","nfeId":"…","userId":"…","cfcId":"…","amb":"H","mod":"55","serie":3,"numero":101,"tentativa":2,"provider":"FOCUS_NFE","fase":"pos_envio","resultado":"REJEITADA","numeracao":"REJEITADO_REUSAVEL","reuso":true,"cStat":974,"http":200,"focusStatus":"erro_autorizacao","durMs":1834,"chave":"4126…0017","msg":"Rejeicao: …(≤300 chars, redacted)"}
```

**Events:**
`emit.claim` (won/lost), `numero.reservado`, `numero.reutilizado`, `emit.enviado`, `emit.resultado`, `emit.incerto`, `reconciliacao.consulta`, `reconciliacao.resultado`, `numero.consumido`, `numero.divergente`, `numero.conflito`, `numero.inutilizado`, `numero.liberado`, `cancel.resultado`, `resptec.resolvido` (source `empresa | env | provedor | omitido`, masked CNPJ), `devolucao.criada`, `devolucao.saldo_insuficiente`, `focus.http` (method, status, content type, `durMs`; never the body), `fault.injected`.

**Where emitted:** use-case transitions, Focus/SEFAZ provider calls, the numbering service, the reconcile path, the RT resolver, the devolução use case. The same event names go to `NfeAuditLog` (`nfe.repository.ts:493-507`) with allowlisted `detalhes`; the full chave stays there for forensics.

### 7.2 No-secret rules (tested)

- `FiscalLogFields` is a **closed** TypeScript type with no index signature. Tests use `@ts-expect-error` on an extra key.
- Never logged: `providerToken`, `Authorization` header, `certificadoSenhaEnc`, PFX/PEM, `FISCAL_CERT_ENC_KEY`, CSRT/hashCSRT, full XML or JSON payloads (only byte size and sha256 prefix), destinatário CPF/CNPJ/name/email/phone, request URLs with query strings.
- `msg` goes through `redactFiscalMessage`: strips `Basic …`, base64 runs of 40+ characters, `-----BEGIN`, 11/14-digit document patterns. Truncated to 300 characters.
- Error objects are never serialized, only `error.message` after redaction and `error.name`/`code`. A known leak path: an error's `cause` exposed a client secret in logs.
- Not written to `SystemLog`:
  - the middleware labels POSTs wrongly and redacts by substring;
  - `SystemLogService.log` prints raw data to the console when its own write fails (`system-log.service.ts:86-94`);
  - `csrt` is missing from `SENSITIVE_FIELD_PATTERNS` (`logging.middleware.ts:383-403`).
- Name the RT secret field `csrtToken` so today's `token` pattern already redacts it, and add `csrt` to the patterns (new spec).
- Harness invariant I7 scans every captured sink for the sentinels.

### 7.3 Read-only alert queries

Manual for now, cron later:
- INCERTO/EM_TRANSMISSAO older than 15 min
- ledger numbers with more than one active binding
- `AUTHORIZED` rows where `numero <> substr(regexp_replace("chaveAcesso",'\D','','g'),26,9)::int`

---

## 8. Open items to confirm before implementation

- **UPD authorization of Focus for Kiko** (contador) and **CSRT with Focus support**. This blocks positive Focus homologação flows.
- **Two tenant groups share Focus tokens.** Excluded from tests; flagged as an isolation risk, not fixed blindly.
- **Release policy** (`LIBERADO`) and the **future-range inutilização policy** (case 6d). The tests pin semantics; the numbering-v2 design must decide both.
- **Kiko homologação use:** needs explicit user/Kiko consent. Otherwise an internal Focus homologação tenant with an unshared token is required.
- **Postgres major version** of Supabase prod (read-only `SHOW server_version`), to pin the Docker image.