# Numbering V2: verdict on designs A, B and C, and the final design

> **Registro de desenho pré-implementação, congelado no HEAD `1549bc4`.**
> **A implementação final divergiu deste desenho:** a allowlist é por `companyFiscalConfigId` (`NFE_NUMERACAO_V2_CONFIG_IDS`, ver `app/fiscal/flags.ts`); `NFE_NUMERACAO_V2_USER_IDS`, citada adiante, nunca foi lida pelo código.
> O runbook válido é [`docs/roteiro-emissao-focus-nfe.md`](../roteiro-emissao-focus-nfe.md).

I judged all three designs. **C wins (8.0), then A (7.5), then B (6.5).** The final design below uses C as the backbone and adds A's lock order, its evidence rules for adopting old rows, its Focus `ref` rule and its logging whitelist. From B it takes the UI keying off the API payload, the Focus sub-flag chosen by provider and the explicit "discard number" confirmation. Four things the code showed must shape the result:

- **SEFAZ direct has no "local error" path today.** Build, sign and QR failures come back as `erro` after the point of no return, so the note sits in SENDING with its number burned. This is exactly the reported scenario.
- **V1 SVC XML would fail the schema.** The SEFAZ builder never writes `dhCont`/`xJust`. V2 therefore never sends to SVC on its own.
- **Focus DANFEs print the fake Dexo number.** On Focus the DANFE is built from the database row, so it shows 12/13/14 while the real nNF is 3/4/5. V2 must fix the row's number before the DANFE is generated.
- **The claim loser's error message falls through to HTTP 500.** V2 returns a normal 200 "already in progress" result instead. The PDV already maps that to "processing".

Line citations refer to the worktree at HEAD `1549bc4`.

---

## Part 1. Claims checked against the code

| # | Claim (who made it) | Verdict | Evidence |
|---|---|---|---|
| V1 | SEFAZ direct build, sign and QR failures come back as `status:"erro"` after `sentToSefaz=true`, so the row stays SENDING (C, "B6") | **Confirmed. This is the reported scenario for SEFAZ direct.** | `sefaz-direct.provider.ts:188-205` (build: `codMunicipio`/`uf` throws at `nfe-xml-builder-sefaz.service.ts:98-105`), `:207-223`, `:243-250`; `nfe-emission.usecase.ts:357` sets `sentToSefaz` first; `:521-536` keeps SENDING |
| V2 | `updateDraft` forces DRAFT and clears only `motivoRejeicao`; `cStatRejeicao` survives (A) | Confirmed | `nfe.repository.ts:379-381` |
| V3 | `shouldReuseNumero` checks neither emitter nor série (C, "U3") | Confirmed. This is a latent bug that any fix for R1 would expose. | `nfe-number-reuse.ts:51-62` |
| V4 | 205, 206 and 635 fall in 200–599 and count as reusable, so retries loop (C, "U1") | Confirmed | `cstat-mapper.ts:111-117` |
| V5 | Focus 422 `already_processed` is mapped to `rejeitada` (C, "S3") | Confirmed | `focus-nfe.provider.ts:89-101` |
| V6 | Focus inutilização treats any HTTP 200 as success and reads `body.protocolo` (C, "B11") | Confirmed | `focus-nfe.provider.ts:254-259` |
| V7 | Focus `consultar` has no `res.ok` check and defaults to `processando`; a 401 HTML body makes `res.json()` throw, which the catch turns into `erro` | Confirmed | `focus-nfe.provider.ts:70`, `:146-155`, `:115-129` |
| V8 | The SEFAZ builder never writes `dhCont`/`xJust` | Confirmed (0 matches) | `nfe-xml-builder-sefaz.service.ts` |
| V9 | V1 SVC resends the **same number with a new chave** after timeout → 217 | Confirmed | `nfe-emission.usecase.ts:423-437`, `:587-591` |
| V10 | `parseRetConsSitNFe` drops `protNFe`, so authorization found by consult has no nfeProc | Confirmed | `sefaz-direct.provider.ts:1085`; `nfe-emission.usecase.ts:831-838` |
| V11 | The claim loser's error reaches the route as HTTP 500 | Confirmed | `nfe-emission.usecase.ts:151-155`; `fiscal.routes.ts:944-956` |
| V12 | `handleAuthorized`'s `transitionStatus` is an unconditional update | Confirmed. Calling it after an atomic AUTHORIZED write is harmless. | `nfe-emission.usecase.ts:1103-1117` |
| V13 | On Focus, `xmlAutorizadoInline` is always null, so the DANFE is generated **from the database row's `numero`** | Confirmed. This is an existing bug: Focus DANFEs show the fake number. | `focus-nfe.provider.ts:84,166`; `nfe-emission.usecase.ts:849-899` |
| V14 | `NfeEmitida.xmlAssinadoPath` exists and nothing uses it (C) | Confirmed | `schema.prisma:1939`; grep finds no use in `app/` |
| V15 | Only `cancelar` and `buscarXml` use `nfeId` as the Focus ref. Focus has no CC-e method. | Confirmed | `nfe-cancelamento.usecase.ts:110`, `nfe-emission.usecase.ts:815`; `focus-nfe.provider.ts` has no `cartaCorrecao` |
| V16 | `gerarCnf` is documented for persist-and-reuse; `montarChave` throws if cNF equals nNF or is a forbidden pattern | Confirmed | `chave-acesso.ts:77-91`, `:141-156` |
| V17 | SOAP retries resend the same envelope on timeout/5xx; defaults 60 s × (3+1) | Confirmed | `soap-client.service.ts:96-129`, `:211-238` |
| V18 | SEFAZ returns 110/301/302 with `nProt` as `rejeitada` and keeps `codigoStatus` | Confirmed. `nProt` can tell a denial from a rejection. | `sefaz-direct.provider.ts:912-922` |
| V19 | PDV maps `success && status∉{AUTHORIZED,REJECTED}` to "processing" and never calls emit for SENDING rows | Confirmed | `finance.usecase.ts:1862-1876`, `:1911-1918` |
| V20 | `NfeEmitida_legacy_null_key` has no `numero>0` filter | Confirmed. A's "set the other row's numero to −abs" could collide with draft placeholders. | `docs/multi-cnpj-sql.md:207-209`; `nfe.repository.ts:257` |
| V21 | Project DDL convention: SQL editor, BEGIN/COMMIT, RLS, verification block, rollback block | Confirmed | `prisma/ddl/2026-08-14-receivable-event.sql` |

Not verifiable from code (flagged in §4.25): C's reading of NT 2024.001 (302/303 becoming rejections) and the exact wording of 563/613/691. The final design must not depend on either.

---

## Part 2. Scores

| Criterion | A (ledger-first) | B (minimal) | C (risk-first) |
|---|---|---|---|
| Fiscal correctness | 8 | 6 | 8 |
| 14 cases + reported scenario | 9 | 8 | 9 |
| Concurrency / idempotency | 8 | 8 | 7 |
| Flag-off identity / regression risk | 7 | 5 | 9 |
| Rollout safety (DDL order, new tables) | 9 | 8 | 8 |
| Size / complexity (10 = lean) | 4 | 7 | 6 |
| Testability | 8 | 7 | 9 |
| **Overall** | **7.5** | **6.5** | **8.0** |

**A. Strengths:**
- A single lock order for everything (sequence → ledger → row).
- cNF kept per number.
- 539 matched against every chave already sent.
- Rules for adopting old rows based on evidence, correctly excluding Focus.
- A logging whitelist and CHECK constraints.

**A. Defects:**
- A pool of released numbers (LIBERADO/ORFAO, expiring with the fiscal month) that runs under the lock on every allocation. It relies on unconfirmed Focus behaviour.
- Focus realignment **changes another document's number to a negative value** (V20).
- Takes the sequence lock even when simply reusing a number.
- Allows SVC on 108/109 even though the builder cannot produce valid SVC XML (V8).
- A background sweeper.
- An unnecessary "late authorization from RESERVADO" transition.

**B. Strengths:**
- The UI keys off the API payload, so no `NEXT_PUBLIC` flag.
- A provider-scoped Focus sub-flag.
- Explicit confirmation before a number is discarded.
- A clear write-up of the pool trade-off.

**B. Defects:**
- **The V1 SVC block stays inside V2** (hook H10 → V9), so the double-authorization path survives when `SEFAZ_AUTO_FALLBACK_ENABLED=true`.
- Fourteen hooks woven through V1 `emit`, `handleAuthorized`, `handleRejected`, the providers, the factory, and an extraction in the sequence service: the largest flag-off diff.
- Stores only the last chave.
- No nfeProc when authorization is found by consult (V10).
- Adopts old rows only when REJECTED, which misses R1 rows.
- Treats 110/205/301-303 as consumed without evidence.
- Treats 999 as INCERTO.
- `prepararChaveSefaz` duplicates the chave derivation from a private `brazilParts` (`nfe-xml-builder-sefaz.service.ts:929`).

**C. Strengths:**
- The best risk register; V1, V3–V6 and V14 are all real.
- A one-line dispatch.
- A separate Focus client.
- An attempts table with digest-based ownership.
- An honest real-Postgres test.
- I4: a later rejection is not proof about an earlier attempt.

**C. Defects:**
- Takes the per-document reservation lock **before** the sequence lock, while inutilização takes the sequence first. That is deadlock-prone.
- Adoption of old rows does not exclude Focus rows, whose database number is not the real one.
- A new cNF on every rebuild, so ownership rests on a regex over xMotivo whose format varies by UF.
- Silently abandons a PRODUCAO number when série or emitter changes.
- Moves the counter before calling inutilização.
- Depends on an unverified NT reading.

---

## Part 3. Disagreements and how they are resolved

| # | Topic | A | B | C | **Decision** | Why |
|---|---|---|---|---|---|---|
| D1 | Pool of released numbers | yes (same month) | phase 2 | no | **No pool** | Unconfirmed Focus behaviour. Every allocation would pay a pool query under the lock. "New document gets 102" stays literal. Gaps only come from explicit, confirmed user actions and are recorded. |
| D2 | Persistence | ledger + events | one table | reserva + attempts | **`NfeNumeroReserva` + `NfeNumeroTentativa`** | Every chave and digest sent is needed for 204/539 ownership across months and for building nfeProc after a consult. |
| D3 | SEFAZ local errors | two-phase | "reach" diagnostics inside `emitir` | two-phase | **Two-phase methods; `emitir()` untouched** | Local failures throw before anything is committed. The signed XML is on disk before sending. |
| D4 | cNF | per number | per number | new per rebuild | **Stored on the reservation and reused on every attempt** | Same month gives the same chave, so a late authorization comes back as 204 instead of 539. The attempts table still covers month changes. |
| D5 | "Not found" (217 / Focus 404) maturity | 10 min | 120 s | 120 s / 60 s | **120 s (env); conclusive at once when the original send got a conclusive answer** | Safety does not depend on the threshold, because the cNF is reused (D4). |
| D6 | Claim loser | 409 | 409 | 200 `emAndamento` | **200 `emAndamento`** | No route change; wizard and PDV already handle `success:true`. |
| D7 | Série / emitter / ambiente change on a live number | release to pool | 409 confirm in PROD | silent abandon | **409 confirm when the *old* ambiente is PRODUCAO; automatic in HOMOLOGACAO** | Makes the gap an explicit decision. |
| D8 | Delete a numbered draft | release to pool | record gap | abandon | **Abandon; 409 confirm in PRODUCAO; refuse DENEGADO/AUTORIZADO/CANCELADO** | Same reasoning as D7. |
| D9 | Adopting old rows | evidence (DRAFT/REJECTED, SEFAZ only) | V1 rule, REJECTED only | V1 rule + guards | **A's evidence + C's guards; Focus rows never adopted** | Covers R1 rows without trusting fake Focus numbers. |
| D10 | Focus `numero` | builder argument | builder option | mutate payload, keep `numero_nota` | **Mutate the payload in the orchestrator, delete `numero_nota`; builder untouched** | Zero diff in the builder. |
| D11 | Focus `ref` | new ref for a new number | always `nfeId` | always `nfeId` | **A's rule** | Never re-POST a ref with a different number. A ref Focus has authorized (even if later cancelled), or a legacy "denegado" ref, can no longer be reused, so a later number for the same document gets a new ref. |
| D12 | Focus I/O | new provider methods | constructor options | separate client | **Separate `focus-nfe-v2.client.ts`** | The V1 provider stays untouched. |
| D13 | Focus number divergence | rebind and negate other rows | audit + update + move forward | block | **B + C: never modify another document's number** | Another live reservation of that number becomes CONSUMIDO_EXTERNO; a conflict becomes CRITICO. |
| D14 | SVC | 108/109 only | V1 kept | 108/109 only | **Never automatic in V2 (phase 1)** | V8. 108/109 keep the number and ask for a retry. |
| D15 | 110/301/302/303 | consumed | consumed | consumed (NT caveat) | **Consumed only with `nProt` or a consult that confirms** | Holds under either reading of the NT. |
| D16 | 999 | reusable | INCERTO | reusable | **Reusable** | Reuse cannot double-authorize (204/539 recovery). |
| D17 | Counter floor | automatic from chaves | go-live check | report only | **One-time, forward-only, audited floor at the first V2 allocation per key, plus a diagnostic report** | Only moves forward, so it cannot duplicate a number. |
| D18 | Flags | master + users + modelos + NEXT_PUBLIC | master + Focus | master + users + Focus + NEXT_PUBLIC | **master + users (empty = nobody, `*` = all) + modelos (default 55) + Focus; no NEXT_PUBLIC** | Typo-proof canary; front end and API cannot disagree. |
| D19 | Sequence primitive | duplicate lock without bump | extract from V1 | same SQL shape | **New repository primitive; `nfe-sequence.service.ts` untouched; parity test** | No V1 diff. |
| D20 | Inutilização and the counter | after, under lock | after | before the call | **After success, under lock; allocation skips ranges that are ACEITA or PENDENTE < 15 min** | A failed inutilização leaves no gap. |
| D21 | Sweeper | optional | none | none | **None** | Explicit actions only. |
| D22 | Tax-calc code | inline | inline | inline | **New pure `montarEntradaCalculoEmissao` for V2 + parity test; V1 converges in a later PR** | V1 stays untouched now. |
| D23 | Legacy SENDING/VALIDATING rows | untouched | 404 as today | `emAndamento` | **`emAndamento` with a "pre-V2" message; no reconcile (decision 3)** | Respects decision 3 without an error. |

---

## Part 4. Final design

### 4.0 Invariants (each one has a test)

- **I1.** A document gets a **new** number only when its reservation is in a consumed state: DENEGADO, INUTILIZADO or CONSUMIDO_EXTERNO. ABANDONADO also allows it, but only after an explicit key change.
- **I2.** A reservation belongs to one key `K = (companyFiscalConfigId, ambiente, modelo, série)` and is never used under another key.
- **I3.** An attempt is committed before any byte leaves: chave, cNF, dhEmi, tpEmis, DigestValue, signed XML path, Focus ref, and the row moves to SENDING, all in one transaction.
- **I4.** An uncertain attempt is closed only by a mature consult of that attempt, or by a conclusive answer to that attempt. A rejection of a later resend proves nothing about it.
- **I5.** No `MAX(numero)+1` allocation, no `numero--`, no reassigning abandoned numbers. The counter only moves forward.
- **I6.** One global lock order: `NfeSequence` (keys sorted) → `NfeNumeroReserva` → `NfeNumeroTentativa` → `NfeEmitida`. The reuse fast path locks only reserva → row.
- **I7.** Old rows are never released, reconciled or inutilized automatically. They may only be adopted back onto the same row, with evidence.
- **I8.** With the flag off, not a single extra statement, payload field or response field (§4.21).
- **I9.** Reusing the same number can never double-authorize: SEFAZ answers 204/539 and V2 recognizes its own chaves. Only renumbering needs proof.

### 4.1 Flags and tunables

New file `app/fiscal/numeracao/flags.ts`. Read at call time and compared with `=== "true"` (see the `.env` "1"×"true" gotcha).

```ts
export function isNumeracaoV2ParaUsuario(userId: string): boolean {
  if (process.env.NFE_NUMERACAO_V2_ENABLED !== "true") return false;
  const raw = (process.env.NFE_NUMERACAO_V2_USER_IDS ?? "").trim();
  if (raw === "*") return true;
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(userId); // vazio ⇒ ninguém
}
export function isNumeracaoV2ParaEmissao(userId: string, modelo: "55" | "65", providerName: string | null): boolean {
  if (!isNumeracaoV2ParaUsuario(userId)) return false;
  const modelos = (process.env.NFE_NUMERACAO_V2_MODELOS ?? "55").split(",").map((s) => s.trim());
  if (!modelos.includes(modelo)) return false;
  return providerName === "SEFAZ_DIRECT" ? true : process.env.NFE_NUMERACAO_V2_FOCUS_ENABLED === "true";
}
export const naoConstaMinMs     = () => intEnv("NFE_NUMERACAO_V2_NAO_CONSTA_MIN_MS", 120_000);
export const leasePreEnvioMs    = () => intEnv("NFE_NUMERACAO_V2_LEASE_PRE_ENVIO_MS", 600_000);
export const leaseEnvioSefazMs  = () => intEnv("NFE_NUMERACAO_V2_LEASE_SEFAZ_MS", 900_000);   // > 60s×4 SOAP ×2 + poll + consulta
export const leaseEnvioFocusMs  = () => intEnv("NFE_NUMERACAO_V2_LEASE_FOCUS_MS", 180_000);
export const focusPostTimeoutMs = () => intEnv("FOCUS_V2_POST_TIMEOUT_MS", 45_000);
export const focusGetTimeoutMs  = () => intEnv("FOCUS_V2_GET_TIMEOUT_MS", 15_000);
```

- **No `NEXT_PUBLIC_*` flag.** The UI switches to V2 behaviour only when the API response contains a `numeracao` field, which only V2 adds (§4.20).
- **When `NFE_NUMERACAO_V2_FOCUS_ENABLED` is off,** Focus configs run the V1 path entirely. V2 numbering is meaningless while Focus picks the numbers.

### 4.2 Data model: two new tables, no column on any existing model

`prisma/schema.prisma` gains two models placed after `NfeInutilizacao` (`schema.prisma:2024`). They have a relation to each other only, never to `NfeEmitida`. They are there so that a forbidden `db push` would not drop the tables. All access is raw SQL, so **`prisma generate` is not needed**. The shared `node_modules` client from the worktree gotcha is untouched.

```prisma
// Numeração V2. Índice PARCIAL "NfeNumeroReserva_nfeId_vivo_key" vive SÓ no banco
// (prisma/ddl/2026-09-18-nfe-numeracao-v2.sql). NUNCA `prisma db push`.
model NfeNumeroReserva {
  id                    String    @id @default(dbgenerated("gen_random_uuid()::text"))
  userId                String
  companyFiscalConfigId String
  ambiente              String
  modelo                String
  serie                 Int
  numero                Int
  nfeId                 String?   // sem FK: sobrevive à exclusão do rascunho
  estado                String
  origem                String    // CONTADOR | LEGADO_V1 | READBACK_FOCUS
  cNF                   String?   @db.Char(8)
  provedorUltimo        String?
  ultimaClasse          String?
  ultimoCStat           Int?
  ultimoCodigoProvedor  String?   @db.VarChar(64)
  motivo                String?   @db.VarChar(500)
  requerInutilizacao    Boolean   @default(false)
  bloqueadoAte          DateTime?
  leaseAte              DateTime?
  consumidoEm           DateTime?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @default(now())
  tentativas            NfeNumeroTentativa[]
  @@unique([companyFiscalConfigId, ambiente, modelo, serie, numero], map: "NfeNumeroReserva_cfc_amb_mod_serie_num_key")
  @@index([nfeId], map: "NfeNumeroReserva_nfeId_idx")
  @@index([userId, estado], map: "NfeNumeroReserva_userId_estado_idx")
}
model NfeNumeroTentativa {
  id              String    @id @default(dbgenerated("gen_random_uuid()::text"))
  reservaId       String
  nfeId           String
  userId          String
  seq             Int
  provedor        String
  ambiente        String
  tpEmis          Int       @default(1)
  chaveAcesso     String?   @db.Char(44)
  cNF             String?   @db.Char(8)
  dhEmi           DateTime?
  digestValue     String?
  xmlAssinadoPath String?
  conteudoSha256  String    @db.Char(64)
  focusRef        String?
  nRec            String?
  fase            String    // TRANSMITINDO | RESPONDIDA | FECHADA
  httpStatus      Int?
  transporte      String?
  cStat           Int?
  codigoProvedor  String?   @db.VarChar(64)
  classe          String?
  prova           String?   // RESPOSTA_CONCLUSIVA | CONSULTA_NAO_CONSTA_MADURA | FOCUS_404_MADURO | AUTORIZACAO | ...
  mensagem        String?   @db.VarChar(500)
  protocolo       String?
  numeroLido      Int?
  serieLida       Int?
  transmitidaEm   DateTime
  respondidaEm    DateTime?
  consultadaEm    DateTime?
  createdAt       DateTime  @default(now())
  reserva         NfeNumeroReserva @relation(fields: [reservaId], references: [id], onDelete: Restrict)
  @@unique([reservaId, seq], map: "NfeNumeroTentativa_reserva_seq_key")
  @@index([chaveAcesso], map: "NfeNumeroTentativa_chave_idx")
  @@index([nfeId], map: "NfeNumeroTentativa_nfeId_idx")
  @@index([focusRef], map: "NfeNumeroTentativa_focusRef_idx")
}
```

**`prisma/ddl/2026-09-18-nfe-numeracao-v2.sql`** follows the `2026-08-14-receivable-event.sql` convention. The tables are new and empty, so plain `CREATE INDEX` inside the editor transaction is valid.

```sql
-- NUMERAÇÃO V2 — 100% ADITIVO (2 tabelas novas). EXECUTAR NO SQL EDITOR DO SUPABASE.
-- ORDEM: 1) deploy do código com NFE_NUMERACAO_V2_ENABLED ausente  2) este DDL
--        3) verificação  4) flag + allowlist + pm2 restart (runbook VPS).
-- Pré-condição: SELECT 1 FROM information_schema.columns
--   WHERE table_name='NfeEmitida' AND column_name='cStatRejeicao';   -- deve retornar 1 linha
BEGIN;
CREATE TABLE IF NOT EXISTS "NfeNumeroReserva" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId" TEXT NOT NULL, "companyFiscalConfigId" TEXT NOT NULL,
  "ambiente" TEXT NOT NULL, "modelo" TEXT NOT NULL, "serie" INTEGER NOT NULL, "numero" INTEGER NOT NULL,
  "nfeId" TEXT, "estado" TEXT NOT NULL, "origem" TEXT NOT NULL, "cNF" CHAR(8),
  "provedorUltimo" TEXT, "ultimaClasse" TEXT, "ultimoCStat" INTEGER, "ultimoCodigoProvedor" VARCHAR(64),
  "motivo" VARCHAR(500), "requerInutilizacao" BOOLEAN NOT NULL DEFAULT false,
  "bloqueadoAte" TIMESTAMP(3), "leaseAte" TIMESTAMP(3), "consumidoEm" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NfeNumeroReserva_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NfeNumeroReserva_estado_chk" CHECK ("estado" IN ('RESERVADO','REJEITADO','EM_TRANSMISSAO',
    'INCERTO','BLOQUEADO','AUTORIZADO','CANCELADO','DENEGADO','INUTILIZADO','CONSUMIDO_EXTERNO','ABANDONADO')),
  CONSTRAINT "NfeNumeroReserva_dominio_chk" CHECK ("modelo" IN ('55','65') AND "ambiente" IN ('HOMOLOGACAO','PRODUCAO')
    AND "serie" BETWEEN 0 AND 999 AND "numero" BETWEEN 1 AND 999999999),
  CONSTRAINT "NfeNumeroReserva_vinculo_chk" CHECK ("estado" NOT IN
    ('RESERVADO','REJEITADO','EM_TRANSMISSAO','INCERTO','BLOQUEADO','AUTORIZADO','CANCELADO') OR "nfeId" IS NOT NULL)
);
-- Um número aparece UMA vez por chave fiscal durante toda a vida (rede de segurança do FOR UPDATE).
CREATE UNIQUE INDEX IF NOT EXISTS "NfeNumeroReserva_cfc_amb_mod_serie_num_key"
  ON "NfeNumeroReserva" ("companyFiscalConfigId","ambiente","modelo","serie","numero");
-- PARCIAL (fora do schema): no máximo 1 reserva viva-ou-autorizada por documento.
CREATE UNIQUE INDEX IF NOT EXISTS "NfeNumeroReserva_nfeId_vivo_key" ON "NfeNumeroReserva" ("nfeId")
  WHERE "estado" IN ('RESERVADO','REJEITADO','EM_TRANSMISSAO','INCERTO','BLOQUEADO','AUTORIZADO','CANCELADO');
CREATE INDEX IF NOT EXISTS "NfeNumeroReserva_nfeId_idx" ON "NfeNumeroReserva" ("nfeId");
CREATE INDEX IF NOT EXISTS "NfeNumeroReserva_userId_estado_idx" ON "NfeNumeroReserva" ("userId","estado");

CREATE TABLE IF NOT EXISTS "NfeNumeroTentativa" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "reservaId" TEXT NOT NULL, "nfeId" TEXT NOT NULL, "userId" TEXT NOT NULL, "seq" INTEGER NOT NULL,
  "provedor" TEXT NOT NULL, "ambiente" TEXT NOT NULL, "tpEmis" INTEGER NOT NULL DEFAULT 1,
  "chaveAcesso" CHAR(44), "cNF" CHAR(8), "dhEmi" TIMESTAMP(3), "digestValue" TEXT, "xmlAssinadoPath" TEXT,
  "conteudoSha256" CHAR(64) NOT NULL, "focusRef" TEXT, "nRec" TEXT, "fase" TEXT NOT NULL,
  "httpStatus" INTEGER, "transporte" TEXT, "cStat" INTEGER, "codigoProvedor" VARCHAR(64), "classe" TEXT,
  "prova" TEXT, "mensagem" VARCHAR(500), "protocolo" TEXT, "numeroLido" INTEGER, "serieLida" INTEGER,
  "transmitidaEm" TIMESTAMP(3) NOT NULL, "respondidaEm" TIMESTAMP(3), "consultadaEm" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NfeNumeroTentativa_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NfeNumeroTentativa_fase_chk" CHECK ("fase" IN ('TRANSMITINDO','RESPONDIDA','FECHADA'))
);
ALTER TABLE "NfeNumeroTentativa" DROP CONSTRAINT IF EXISTS "NfeNumeroTentativa_reservaId_fkey";
ALTER TABLE "NfeNumeroTentativa" ADD CONSTRAINT "NfeNumeroTentativa_reservaId_fkey"
  FOREIGN KEY ("reservaId") REFERENCES "NfeNumeroReserva"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "NfeNumeroTentativa_reserva_seq_key" ON "NfeNumeroTentativa" ("reservaId","seq");
CREATE INDEX IF NOT EXISTS "NfeNumeroTentativa_chave_idx"    ON "NfeNumeroTentativa" ("chaveAcesso");
CREATE INDEX IF NOT EXISTS "NfeNumeroTentativa_nfeId_idx"    ON "NfeNumeroTentativa" ("nfeId");
CREATE INDEX IF NOT EXISTS "NfeNumeroTentativa_focusRef_idx" ON "NfeNumeroTentativa" ("focusRef");

ALTER TABLE "NfeNumeroReserva"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NfeNumeroTentativa" ENABLE ROW LEVEL SECURITY;
COMMIT;
-- VERIFICAÇÃO: SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
--   WHERE c.relname LIKE 'NfeNumero%';  -- todos t
-- SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('NfeNumeroReserva','NfeNumeroTentativa');
-- ROLLBACK (flag OFF + restart ANTES; backup):
-- CREATE SCHEMA IF NOT EXISTS ops_backup;
-- CREATE TABLE ops_backup."NfeNumeroReserva_<data>" AS TABLE "NfeNumeroReserva";
-- CREATE TABLE ops_backup."NfeNumeroTentativa_<data>" AS TABLE "NfeNumeroTentativa";
-- BEGIN; DROP TABLE IF EXISTS "NfeNumeroTentativa"; DROP TABLE IF EXISTS "NfeNumeroReserva"; COMMIT;
```

Also add `NfeNumeroReserva_nfeId_vivo_key` to the memory file listing indexes outside the schema (11 becomes 12).

### 4.3 Numbering states

States live in `app/fiscal/numeracao/estados.ts`, which is pure. "Row status" is `NfeEmitida.status`; no new status values, so listing and stats are unaffected.

| State | Meaning | Consumed at SEFAZ | Same document reuses the number | Terminal | Row status |
|---|---|---|---|---|---|
| `RESERVADO` | Bound; never transmitted, or every attempt closed without authorization (local error, Focus refused before SEFAZ, 108/109, mature "not found") | no | **yes** | no | DRAFT (local error) / REJECTED |
| `REJEITADO` | Conclusive SEFAZ rejection | no | **yes** | no | REJECTED (cStat as integer) |
| `EM_TRANSMISSAO` | Attempt committed, request in flight (`leaseAte`) | unknown | blocked | no | SENDING |
| `INCERTO` | Sent, outcome unknown | unknown | only after a consult | no | SENDING |
| `BLOQUEADO` | Anomaly: digest mismatch, cancelled outside Dexo, CRITICO conflict | consumed/unknown | never (manual) | manual | SENDING |
| `AUTORIZADO` | 100/150 | **yes** | never | until cancelled | AUTHORIZED |
| `CANCELADO` | Cancellation accepted | yes | never | yes | CANCELLED |
| `DENEGADO` | Denial proven (nProt or consult) | yes | never; next emission renumbers | yes | REJECTED |
| `INUTILIZADO` | 206, or inutilização ACEITA over the number | yes | never; renumbers | yes | REJECTED |
| `CONSUMIDO_EXTERNO` | Number held at SEFAZ by a chave that is not ours | yes | never; renumbers | yes | REJECTED |
| `ABANDONADO` | Given up by an explicit action (key change, delete, flag-rollback divergence, Focus divergence) | no/unknown | never (no pool) | yes (`requerInutilizacao` in PRODUCAO) | unchanged / deleted |

**Allowed transitions** (every SQL update carries `WHERE "estado" = $de`; a count of 0 throws):

```
RESERVADO, REJEITADO → EM_TRANSMISSAO | ABANDONADO | INUTILIZADO
EM_TRANSMISSAO       → AUTORIZADO | REJEITADO | RESERVADO | INCERTO | DENEGADO | INUTILIZADO | CONSUMIDO_EXTERNO | BLOQUEADO
INCERTO              → AUTORIZADO | RESERVADO | DENEGADO | INUTILIZADO | CONSUMIDO_EXTERNO | BLOQUEADO | INCERTO
AUTORIZADO           → CANCELADO | ABANDONADO(only Focus realignment, before handleAuthorized)
```

Forbidden: INCERTO/EM_TRANSMISSAO → ABANDONADO; INCERTO → REJEITADO. A rejection is an answer to a *new* attempt, which must first go through EM_TRANSMISSAO.

### 4.4 Reservation algorithm

This is `NfeNumeracaoService.reservarOuReutilizar`, one `prisma.$transaction(fn, { maxWait: 5000, timeout: 15000 })` with no network I/O inside (see the pooler incident). Queries come from `NfeNumeracaoRepository` (raw SQL, injectable client, interface `INfeNumeracaoRepository` for the in-memory fake).

```ts
const VIVOS_REUSAVEIS = new Set(["RESERVADO", "REJEITADO"]);
async reservarOuReutilizar(c: {
  userId; nfeId; key: { cfc; ambiente; modelo; serie }; isDefault: boolean;   // isDefault = usecase:250-252
  row: { numero; serie; ambiente; companyFiscalConfigId; status; cStatRejeicao };
  providerName; confirmarDescarte: boolean; emitenteSnapshot: unknown;
}): Promise<Reserva & { origemDecisao: "REUSO" | "ADOCAO_LEGADO" | "CONTADOR" }> {
  const viva0 = await repo.reservaViva(c.nfeId);                                  // sem lock
  const auditLegado = !viva0 && c.row.numero > 0 ? await repo.trilhaAuditoria(c.nfeId) : null;
  const caminhoRapido = viva0 && mesmaChave(viva0, c.key) && c.row.numero === viva0.numero;

  return prisma.$transaction(async (tx) => {
    // R1 — REUSO (a decisão NÃO lê status: R1 do wizard resolvido sem tocar updateDraft)
    if (caminhoRapido) {
      const v = await repo.lockReservaPorId(tx, viva0!.id);                       // FOR UPDATE
      if (!v || !VIVOS_REUSAVEIS.has(v.estado) || !mesmaChave(v, c.key) || v.numero !== viva0!.numero)
        throw new NumeracaoError("NUMERACAO_CONCORRENCIA", 409, "Numeração alterada em paralelo — tente novamente");
      await repo.gravarNumeroNaLinha(tx, c, v.numero);
      return { ...v, origemDecisao: "REUSO" };
    }
    // R2 — caminho lento: sequências ordenadas → reserva → linha
    const chaves = ordenarChaves(unicas([c.key, viva0 && chaveDe(viva0)]));
    const seq = new Map<string, { id: string; proximoNumero: number }>();
    for (const k of chaves) seq.set(ks(k), await repo.lockSequencia(tx, c.userId, k, mesma(k, c.key) ? c.isDefault : false));
    const v = viva0 ? await repo.lockReservaPorId(tx, viva0.id) : await repo.lockReservaVivaPorNfe(tx, c.nfeId);
    if ((v?.id ?? null) !== (viva0?.id ?? null) || (v && !VIVOS_REUSAVEIS.has(v.estado)))
      throw new NumeracaoError("NUMERACAO_CONCORRENCIA", 409, "Numeração alterada em paralelo — tente novamente");
    if (v) {
      const motivo = mesmaChave(v, c.key) ? "FLAG_ROLLBACK_V1" : motivoTroca(v, c.key);   // SERIE|EMITENTE|AMBIENTE|MODELO
      if (motivo !== "FLAG_ROLLBACK_V1" && v.ambiente === "PRODUCAO" && !c.confirmarDescarte)
        throw new NumeracaoError("NUMERACAO_CONFIRMAR_DESCARTE", 409,
          `O nº ${v.numero} (série ${v.serie}) ficará sem uso e precisará ser inutilizado`, { numero: v.numero, serie: v.serie, motivo });
      await repo.transicionar(tx, v, "ABANDONADO", { motivo, requerInutilizacao: v.ambiente === "PRODUCAO" });
    }
    // R3 — adoção de legado (mesma linha, mesma chave, com evidência) §4.5
    if (!v && c.row.numero > 0 && mesmaChave(chaveDaLinha(c.row), c.key)) {
      const ocup = await repo.ocupacao(tx, c.userId, c.key, c.row.numero, c.nfeId, c.isDefault);
      const d = decidirAdocaoLegado({ row: c.row, providerName: c.providerName, trilha: auditLegado,
                                      proximoNumero: seq.get(ks(c.key))!.proximoNumero, ocupacao: ocup });
      if (d.adotar) {
        const r = await repo.inserirReserva(tx, { ...c.key, userId: c.userId, numero: c.row.numero, estado: d.estado,
          origem: "LEGADO_V1", nfeId: c.nfeId, cNF: gerarCnf(c.row.numero), ultimoCStat: c.row.cStatRejeicao });
        if (r) { await repo.gravarNumeroNaLinha(tx, c, r.numero); return { ...r, origemDecisao: "ADOCAO_LEGADO" }; }
      } else log("nfe.numeracao.legado_nao_adotado", { nfeId: c.nfeId, numero: c.row.numero, motivo: d.motivo });
    }
    const s = seq.get(ks(c.key))!;
    // R4 — piso único (1ª alocação V2 da chave; só avança)
    if (!(await repo.existeReservaNaChave(tx, c.key))) {
      const piso = await repo.pisoPorEvidencia(tx, c.userId, c.key, c.isDefault);
      if (piso >= s.proximoNumero) { await repo.setProximo(tx, s.id, piso + 1, c.key.cfc); log.warn("nfe.numeracao.piso_aplicado", { de: s.proximoNumero, para: piso + 1 }); s.proximoNumero = piso + 1; }
    }
    // R5 — guarda L2
    if (await repo.ultimasReservasTodasConsumidoExterno(tx, c.key, 3))
      throw new NumeracaoError("SEQUENCIA_ATRAS_DA_SEFAZ", 409, "Os 3 últimos números desta série já existiam na SEFAZ — ajuste o próximo número");
    // R6 — contador (atômico, só avança)
    for (let i = 0; i < 50; i++) {
      const n = s.proximoNumero;
      await repo.setProximo(tx, s.id, n + 1, c.key.cfc); s.proximoNumero = n + 1;
      const o = await repo.ocupacao(tx, c.userId, c.key, n, c.nfeId, c.isDefault);
      if (o.emNota || o.inutilizado || o.reservado) { log.warn("nfe.numeracao.numero_pulado", { n, ...o }); continue; }
      const r = await repo.inserirReserva(tx, { ...c.key, userId: c.userId, numero: n, estado: "RESERVADO",
        origem: "CONTADOR", nfeId: c.nfeId, cNF: gerarCnf(n) });
      if (!r) throw new NumeracaoError("NUMERACAO_INCONSISTENTE", 500, "Inconsistência de numeração — contate o suporte"); // falha fechada
      await repo.gravarNumeroNaLinha(tx, c, n);
      return { ...r, origemDecisao: "CONTADOR" };
    }
    throw new NumeracaoError("COLISOES_EXCESSIVAS", 409, "50 números seguidos já usados — revise a numeração");
  }, { maxWait: 5000, timeout: 15000 });
}
```

**Repository SQL:**

- **`lockSequencia`.** It uses the same `SELECT … ORDER BY ("companyFiscalConfigId" IS NULL) ASC LIMIT 1 FOR UPDATE` as `nfe-sequence.service.ts:143-150`. If no row exists, it runs `INSERT … proximoNumero=1 … ON CONFLICT DO NOTHING` and selects again. If the row still cannot be seen, it throws the same message as `:215-217`. It never bumps.
- **`setProximo`.** It is `UPDATE "NfeSequence" SET "proximoNumero"=$1,"companyFiscalConfigId"=$2,"updatedAt"=NOW() WHERE "id"=$3`, the same statement as `:169-175`, which also adopts the legacy NULL row.
- **`ocupacao`.** One statement:

```sql
SELECT
 EXISTS(SELECT 1 FROM "NfeEmitida" e WHERE e."ambiente"=$amb AND e."serie"=$ser AND e."modelo"=$mod AND e."numero"=$n
        AND e."id"<>$nfe AND (e."companyFiscalConfigId"=$cfc OR ($def AND e."companyFiscalConfigId" IS NULL AND e."userId"=$u))) "emNota",
 EXISTS(SELECT 1 FROM "NfeInutilizacao" i WHERE $mod='55' AND i."ambiente"=$amb AND i."serie"=$ser
        AND $n BETWEEN i."numeroInicial" AND i."numeroFinal"
        AND (i."status"='ACEITA' OR (i."status"='PENDENTE' AND i."createdAt" > NOW() - interval '15 minutes'))
        AND (i."companyFiscalConfigId"=$cfc OR ($def AND i."companyFiscalConfigId" IS NULL AND i."userId"=$u))) "inutilizado",
 EXISTS(SELECT 1 FROM "NfeNumeroReserva" r WHERE r."companyFiscalConfigId"=$cfc AND r."ambiente"=$amb
        AND r."modelo"=$mod AND r."serie"=$ser AND r."numero"=$n) "reservado"
```

- **`gravarNumeroNaLinha`.** `UPDATE "NfeEmitida" SET "numero"=$n,"ambiente"=$amb,"dataEmissao"=NOW(),"companyFiscalConfigId"=$cfc,"emitenteJson"=$snap::jsonb,"chaveAcesso"=NULL,"updatedAt"=NOW() WHERE "id"=$nfe AND "status"='VALIDATING'`. These are the same fields as `nfe-emission.usecase.ts:262-278`. A count other than 1 throws. A unique violation (23505) rolls back the whole transaction, so nothing is consumed.
- **`pisoPorEvidencia`.** This is A's floor query (§5.5 of A): MAX nNF from 44-digit chaves using `regexp_replace(…,'[^0-9]','','g')` (see the POSIX-class gotcha), over rows of the key including the legacy NULL-config rows of the default emitter, with status AUTHORIZED/CANCELLED/SENDING. It also takes the MAX of `numeroFinal` from `NfeInutilizacao` ACEITA for modelo 55.

### 4.5 Adopting old rows: `decidirAdocaoLegado` (pure, `app/fiscal/numeracao/decisao.ts`)

**Refuse** (return `{ adotar: false, motivo }`) when any of these holds:

- `providerName !== "SEFAZ_DIRECT"`. Reason: `FOCUS_NUMERO_FICTICIO`, because `numero_nota` is ignored (`nfe-xml-builder.service.ts:56`).
- `row.status ∉ {DRAFT, REJECTED}`, or `row.numero >= proximoNumero`, or `ocupacao.inutilizado`, or `ocupacao.reservado`.
- No `NUMERADA` event with `detalhes.numero === row.numero` and `detalhes.serie === row.serie` (written at `usecase:280-283`). Reason: `SEM_TRILHA`.
- The trail `T` after that last NUMERADA contains any of: `ENVIO_INCERTO`, `AUTORIZADA`, `CONTINGENCIA_*`, or a later `NUMERADA` with a different number. Reason: `TRILHA_INCERTA`. This also excludes the B6 rows, which have ENVIO_INCERTO.

**Adopt when there is evidence:**

- **Evidence A: never transmitted.** `T` has `EDITADA_DRAFT` whose `motivo` starts with "Erro antes do envio" (`usecase:553-556`) and no `ENVIADA`. Adopt as `RESERVADO`.
- **Evidence B: conclusive SEFAZ rejection.** `T` has `ENVIADA{providerName:"SEFAZ_DIRECT"}` (`:339-341`), then `REJEITADA`. `row.cStatRejeicao` is not null and `classificarCStatEnvioSefaz(row.cStatRejeicao, {nProt:null}).estadoAlvo === "REJEITADO"`, which excludes 204/205/206/218/539/635/110/301-303. The cStat survives the wizard's DRAFT flip (`nfe.repository.ts:379-381`). Adopt as `REJEITADO`.
- Anything else: refuse with `SEM_EVIDENCIA`. The V1 behaviour then applies (new number), and the old number shows up only in the diagnostic.

### 4.6 SEFAZ direct: two phases, chave and cNF saved before sending

New **public methods on the class** in `app/fiscal/providers/sefaz-direct.provider.ts`. Neither `emitir()` (`:156-303`) nor the interface changes. They reuse the module-private `buildEnviNFeEnvelope`, `parseRetEnviNFe`-style extraction helpers, `extractTagBlock` and `buildNfeProc`.

```ts
export interface SefazNfePreparada { modelo: "55"|"65"; tpEmis: 1; chaveAcesso: string; cNF: string; dhEmi: Date;
  signedXml: string; digestValue: string; }
/** Build + sign (+QR 65). LANÇA em qualquer falha local. Nunca toca a rede. */
prepararEmissao(p: { draft; config; numero: number; cNF: string; dhEmi: Date; respTec?: NfeRespTec | null }): SefazNfePreparada
  // = :179-251 com throw no lugar de makeEmitErrorResult; respTec default resolveRespTecFromEnv() (igual :197) —
  //   ponto de injeção do futuro resolver de RT por empresa (atualizar AMBOS os call sites).
  // digestValue = extrairDigestValue(signedXml)  (novo app/fiscal/sefaz/digest.ts: <DigestValue> da Reference do infNFe)
export interface SefazTransmissao { transporte: null | "TIMEOUT" | "REDE"; httpStatus: number | null;
  loteCStat: number | null; loteXMotivo: string; protCStat: number | null; protXMotivo: string; nProt: string | null;
  dhRecbto: Date | null; nRec: string | null; chNFe: string | null; protNFeXml: string | null; xmlAutorizado: string | null; }
async transmitirPreparada(p: SefazNfePreparada): Promise<SefazTransmissao>   // nunca lança; endpoint = :267-269 (sem SVC)
export interface SefazConsultaDetalhada { transporte; httpStatus; cStat: number | null; xMotivo: string; nProt: string | null;
  dhRecbto: Date | null; digVal: string | null; chNFe: string | null; protNFeXml: string | null; }
async consultarDetalhado(chave: string): Promise<SefazConsultaDetalhada>             // mesmo SOAP de :305-366
async consultarReciboDetalhado(nRec: string, chave: string): Promise<SefazConsultaDetalhada>  // mesmo SOAP de :376-428
static montarNfeProc(signedXml: string, protNFeXml: string): string                   // = buildNfeProc :1117-1125
```

- **cNF.** It is created with the reservation (`gerarCnf(n)`, which is never equal to nNF and never a forbidden pattern, `chave-acesso.ts:82-91`) and reused on every attempt of that number. The same month gives the same chave, so an unknown earlier authorization comes back as **204** on resend and is recovered by consulting that chave.
- **dhEmi.** Always fresh on each attempt. This is needed for NFC-e rule 704, and the chave depends only on AAMM.
- **Ownership check.** A consult returns 100 with `digVal`. The attempt is ours when `chNFe` is among the reservation's attempts and `digVal` is null or among the reservation's digests. If `digVal` does not match any of our digests, the reservation goes to BLOQUEADO.
- **nfeProc after a consult.** `montarNfeProc(readFile(attempt.xmlAssinadoPath), protNFeXml)`. This removes `XML_AUTORIZADO_PENDENTE` for V2 rows.
- **Storage.** New `FiscalStorageService.saveXmlTentativa(userId, nfeId, sufixo, xml)` writes `xml-assinado/{nfeId}-{numero}-{ts}.xml`. On authorization, `NfeEmitida.xmlAssinadoPath`, which exists but is unused (V14), is set to the authorized attempt's file.

### 4.7 Focus: Dexo controls the number, a ref per number, and the real number read back

- **Client.** New `app/fiscal/providers/focus-nfe-v2.client.ts`. It has its own base URL constants and does `res.text()` before `JSON.parse` inside try/catch (a 401 answer is HTML). It uses `AbortSignal.timeout` (POST `focusPostTimeoutMs`, GET `focusGetTimeoutMs`) and reads `Retry-After`. It returns `{ httpStatus, transporte: null|"TIMEOUT"|"REDE", corpo: pick(status,status_sefaz,mensagem_sefaz,codigo,mensagem,chave_nfe,numero,serie,protocolo,protocolo_sefaz,data_evento), retryAfterMs }`. Tokens and headers never appear in results or logs. Methods: `emitir(payload, ref, token)`, `consultar(ref, token)`, `inutilizar(...)`. The path is `/v2/nfe` or `/v2/nfce` by modelo.
- **Payload.** The builder is untouched. The orchestrator does `payload = xmlBuilder.build(nfe, config, numero); delete payload.numero_nota; payload.numero = String(numero); payload.serie = String(nfe.serie);`.
- **`focusRefPara(nfeId, numero)`.**
  - `nfeId` when no earlier attempt for this `nfeId` used a different number.
  - Otherwise `${nfeId}-n${numero}`.
  - The same number always re-POSTs the same ref, which Focus documents as allowed after `erro_autorizacao`.
  - Old V1 attempts under ref `nfeId` are harmless. If Focus had actually authorized them, the POST returns 422 `already_processed`, V2 does a GET, and the read-back records the real number.
- **Read-back on every authorization** (pure `decidirReadbackFocus` plus service `realinharFocus`). The chave is parsed with `parseChave(chave.replace(/\D/g,""))` (`chave-acesso.ts:181-208`). The design asserts `p.CNPJ === onlyDigits(config.cnpj)` and `p.mod === modelo`; there is no hardcoded CNPJ, and a mismatch raises the CRITICO alert `NUMERACAO_FOCUS_INCONSISTENTE`.
  - **Equal numbers** (`(nNF, serie) === (reserva.numero, reserva.serie)`): normal authorization.
  - **Divergent numbers** run in one transaction following I6. Lock the sequence of key′ (série S′), lock our reservation N and, if it exists, the reservation for (key′, M). Then:
    1. Our N goes to `ABANDONADO(FOCUS_DIVERGENCIA, requerInutilizacao=false)` and is listed by the diagnostic as "conferir".
    2. If (key′, M) has no reservation, insert `AUTORIZADO, origem READBACK_FOCUS, nfeId` ours. If it belongs to another document in `RESERVADO`/`REJEITADO`, move that one to `CONSUMIDO_EXTERNO(NUMERO_USADO_VIA_FOCUS)` and audit it on that document, then insert ours. If it is in any other state, log CRITICO `NUMERO_EM_DOIS_DOCUMENTOS`, do not insert, and keep our reservation N as `AUTORIZADO` with `numeroLido=M`.
    3. If `M >= proximoNumero(key′)`, set the counter to `M+1`.
    4. In a separate statement: `UPDATE "NfeEmitida" SET numero=M, serie=S′ WHERE id`. On 23505, keep N on the row and audit CRITICO. This runs **before** `handleAuthorized`, so the DANFE built from the database shows the real number (fixes V13 for V2).
    5. Audit `NUMERACAO_DIVERGENTE_FOCUS {reservado:N, real:M}`.
- **Chave format.** V2 writes 44 digits (the same as SEFAZ-direct rows). Old 47-character `NFe…` rows are not rewritten.
- **Cancellation and XML** use `focusRefAutorizada(nfeId) ?? nfeId` (§4.15). `handleAuthorized` receives the ref (§4.9 E13).

### 4.8 Outcome classification

Pure module `app/fiscal/numeracao/classificacao.ts`. `normalizarCStat(v)` returns an integer only for `/^\s*\d{3}\s*$/`, otherwise null; the raw value goes to `codigoProvedor`. This fixes R3. Every function returns `{ classe, estadoAlvo | acao, cStat, codigoProvedor, conclusiva, chaveReferida, retryAposMs }`. `cstat-mapper.ts` is not changed.

In the tables, "next emit" says what happens to the number on the next emission of the same document, and "row" is `NfeEmitida.status`.

**A. SEFAZ direct, response to `transmitirPreparada`:**

| Response | Class → action / state | Row | Next emit |
|---|---|---|---|
| transport TIMEOUT/REDE, HTTP ≥ 400, no readable cStat | `INCERTO_TRANSPORTE` → CONSULTAR_CHAVE once (100 → AUTORIZADO; 110/301-303 → DENEGADO; anything else, including 217, → INCERTO) | SENDING | blocked until consult |
| lote 103 (nRec) | `EM_PROCESSAMENTO` → POLL recibo 3×3 s (same pace as `usecase:618-652`); exhausted → INCERTO | SENDING | blocked |
| lote 104 without protNFe; 105 | `EM_PROCESSAMENTO` → POLL chave; exhausted → INCERTO | SENDING | blocked |
| prot 100 / 150 | `AUTORIZADA` → AUTORIZADO | AUTHORIZED | n/a |
| prot 110/301/302/303 **with** `nProt` | `DENEGADA` → DENEGADO | REJECTED | new number |
| prot 110/301/302/303 without `nProt` | `DENEGACAO_A_CONFIRMAR` → CONSULTAR_CHAVE: 110/301-303 → DENEGADO; mature 217 → REJEITADO; else INCERTO | per result | per result |
| 204 | `DUPLICIDADE_MESMA_CHAVE` → CONSULTAR_CHAVE: 100 and ours → AUTORIZADO (that attempt); 100 not ours → BLOQUEADO; 110.. → DENEGADO; else INCERTO | per result | per result |
| 539 / 562 / 613 | `DUPLICIDADE_OUTRA_CHAVE` → RECONCILIAR_539 (below) | per result | per result |
| 205 | `DENEGADA_NA_BASE` → CONSULTAR_CHAVE: 110/301-303 → DENEGADO; 217 → CONSUMIDO_EXTERNO; else INCERTO | per result | per result |
| 206 | `INUTILIZADA_NA_BASE` → INUTILIZADO (plus audit `INUTILIZADA_FORA_DO_DEXO` when no matching ACEITA record) | REJECTED | new number |
| 218 | `CANCELADA_NA_BASE` → CONSULTAR_CHAVE: 101/151/155 → BLOQUEADO (CRITICO, consumed); else INCERTO | SENDING | manual |
| 635 | `EM_PROCESSAMENTO_NA_SEFAZ` → INCERTO (never renumber, never rejected) | SENDING | blocked |
| 108 / 109 | `SERVICO_INDISPONIVEL` → RESERVADO; **no SVC** | REJECTED ("SEFAZ indisponível — nº N mantido") | same number |
| 656 | `CONSUMO_INDEVIDO` → REJEITADO + `bloqueadoAte = now + 60 min` | REJECTED | same number after cooldown |
| 999 and **every other integer 200–999** (215, 225, 228, 280–289, 704, 778, 781, 897, 974, 975, …) | `REJEICAO` → REJEITADO | REJECTED (integer cStat) | **same number** |
| unlisted 1xx | `DESCONHECIDO` → CONSULTAR_CHAVE, then INCERTO | SENDING | blocked |

**RECONCILIAR_539:**

1. Take `C′ = /(\d{44})/` from xMotivo. If C′ is among this reservation's attempts, consult C′: 100 → AUTORIZADO for that attempt; 110.. → DENEGADO; otherwise INCERTO.
2. Otherwise consult **every** attempt chave. Any 100 (and ours) → AUTORIZADO. Any 110.. → DENEGADO.
3. If all are 217 **and each attempt is mature or had a conclusive answer** → CONSUMIDO_EXTERNO. A 539 proves the number is taken in the database by a chave that is not ours.
4. Anything else → INCERTO.

**B. SEFAZ `consultarDetalhado` (by chave) or by recibo:**

| cStat | Result |
|---|---|
| 100 / 150 | chave among attempts and (`digVal` null or among digests) → AUTORIZADO; otherwise BLOQUEADO |
| 110 / 301 / 302 / 303 | DENEGADO |
| 101 / 151 / 155 | BLOQUEADO (CRITICO: cancelled outside the flow) |
| 217 | `provaMadura(attempt)` → attempt FECHADA (`prova=CONSULTA_NAO_CONSTA_MADURA`); otherwise inconclusive |
| 105, other codes, transport or HTTP error | inconclusive |

`provaMadura(t, agora) = t.respostaConclusiva || agora − t.transmitidaEm ≥ naoConstaMinMs()`. A response is conclusive when its class is one of REJEICAO, PRE_ENVIO_PROVEDOR, SERVICO_INDISPONIVEL or DUPLICIDADE_OUTRA_CHAVE.

**C. Focus POST `/v2/{nfe|nfce}?ref=`:**

| Response | Class → action / state | Row | Next emit |
|---|---|---|---|
| transport TIMEOUT/REDE; 5xx; 2xx/422 with unreadable body | `INCERTO_TRANSPORTE` → GET_REF once, then INCERTO | SENDING | blocked |
| 200/201 `status:"autorizado"` | AUTORIZADO + read-back | AUTHORIZED | n/a |
| 201/202 `processando_autorizacao` or no status | POLL GET 3×3 s, then INCERTO | SENDING | blocked |
| 200/201 `erro_autorizacao` | table A on `normalizarCStat(status_sefaz)`; null → REJEITADO | per table | per table |
| 200/201 `denegado` | DENEGADO | REJECTED | new number |
| 400 `requisicao_invalida` / `empresa_nao_habilitada`; 401; 403; 404; 415; 422 `permissao_negada`; 422 `erro_validacao_schema` | `PRE_ENVIO_PROVEDOR` → RESERVADO (conclusive) | REJECTED (cStat null, motivo) | **same number, same ref** (R4 fixed) |
| 429 | RESERVADO + `bloqueadoAte = now + retryAfter ?? 60 s` | REJECTED | same number |
| 422 `pending_operation` / `em_processamento` | GET_REF, then INCERTO | SENDING | blocked |
| 422 `already_processed` / `nfe_autorizada` | GET_REF → table D | per GET | per GET |
| 422 with numeric `status_sefaz` | table A | per table | per table |
| 422 with unknown `codigo` | GET_REF (the POST was conclusive, so 404 → RESERVADO) | per GET | per GET |

**D. Focus GET `/v2/{nfe|nfce}/{ref}`:**

| Response | Result |
|---|---|
| 200 `autorizado` | AUTORIZADO + read-back |
| 200 `cancelado` | BLOQUEADO (CRITICO) |
| 200 `denegado` | DENEGADO |
| 200 `erro_autorizacao` | 539/562/613 → chave from `mensagem_sefaz` among our attempts? GET that attempt's ref : CONSUMIDO_EXTERNO. 205 → CONSUMIDO_EXTERNO. 206 → INUTILIZADO. 108/109 → RESERVADO. 635 → INCERTO. Any other code or null → REJEITADO |
| 200 `processando_autorizacao` | inconclusive → INCERTO |
| 404 `nao_encontrado` | `provaMadura` → attempt FECHADA (`FOCUS_404_MADURO`); otherwise inconclusive |
| 401, 403, 429, 5xx, HTML, network | inconclusive (**never** read as "not found") |

### 4.9 `emit()` in V2, step by step

**Dispatch.** The only change in the V1 body is the top of `emit` in `app/usecases/nfe-emission.usecase.ts:91`:

```ts
async emit(userId: string, nfeId: string, opts?: EmitOpts): Promise<EmissionResult> {
  if (isNumeracaoV2ParaUsuario(userId)) {                 // leitura síncrona de env; OFF ⇒ nada mais roda
    const r = await this.v2().emitir(userId, nfeId, opts ?? {});
    if (r !== DELEGAR_V1) return r;
  }
  // ── 1. Load draft ── … linhas 92-564 intocadas
}
private v2() {                                            // lazy; privados do V1 entram como callbacks
  return (this._v2 ??= new NfeEmissaoV2Orchestrator({
    nfeRepo: this.nfeRepo, configRepo: this.configRepo, calculator: this.calculator, xmlBuilder: this.xmlBuilder,
    storage: this.storage, numeracao: new NfeNumeracaoService(),
    validate: (d, c) => this.validate(d, c), loadNfe: (id) => this.loadNfe(id),
    buildEmitenteSnapshot: (c) => this.buildEmitenteSnapshot(c),
    transitionStatus: (...a) => this.transitionStatus(...a), forceStatus: (...a) => this.forceStatus(...a),
    handleAuthorized: (...a) => this.handleAuthorized(...a),
    providers: defaultProviderFactories,                  // SEFAZ two-phase + Focus V2 client; injetável em teste
  }));
}
```

`EmitOpts = { confirmarDescarteNumero?: boolean; _jaReconciliado?: boolean }`. `EmissionResult` (`usecase:45-54`) gains **optional** fields: `emAndamento?`, `jaEmitida?`, `bloqueioRepeticao?`, `numeracao?: { estado, numero, serie, mantido: boolean }`. `handleAuthorized` gains an optional last argument `v2?: { focusRef?: string }`; its only use is `provider.buscarXml(v2?.focusRef ?? nfeId, …)` at `:815`, so without it the call is byte-identical.

**Orchestrator** `app/usecases/nfe-emissao-v2.orchestrator.ts`:

```ts
async emitir(userId, nfeId, opts): Promise<EmissionResult | typeof DELEGAR_V1> {
  // E0 — snapshot enxuto + elegibilidade
  const snap = await prisma.nfeEmitida.findFirst({ where: { id: nfeId, userId }, select: SNAP_SELECT });
  if (!snap) return DELEGAR_V1;                                              // V1 lança "Rascunho nao encontrado"
  const modelo = snap.modelo === "65" ? "65" : "55";
  const config = snap.companyFiscalConfigId
    ? await deps.configRepo.findByIdForUser(snap.companyFiscalConfigId, userId) : await deps.configRepo.findByUserId(userId);
  if (!config || !isNumeracaoV2ParaEmissao(userId, modelo, config.providerName)) return DELEGAR_V1;

  // E1 — portão de status (puro: decidirEntrada)
  const viva = await numeracao.reservaViva(nfeId);
  const d = decidirEntrada({ status: snap.status, updatedAt: snap.updatedAt, viva, agora: new Date(), leasePreEnvioMs: leasePreEnvioMs() });
  switch (d.acao) {
    case "REPLAY_AUTORIZADA": return resultadoDaLinha(snap, { success: true, jaEmitida: true, mensagem: "NF-e já autorizada" });
    case "DELEGAR_V1":        return DELEGAR_V1;                              // CANCELLED/INUTILIZED: V1 dá o mesmo erro de hoje
    case "EM_ANDAMENTO":      return resultadoDaLinha(snap, { success: true, emAndamento: true, mensagem: d.mensagem });
    case "BLOQUEADA_MANUAL":  return resultadoDaLinha(snap, { success: false, mensagem: `Numeração nº ${viva!.numero} exige conferência manual` });
    case "RECONCILIAR":       return this.reconciliar(userId, nfeId, viva!, config, { reenviar: !opts._jaReconciliado, opts });
    case "RETOMAR_TRAVADA": {
      const r = await prisma.nfeEmitida.updateMany({ where: { id: nfeId, userId, status: { in: ["VALIDATING", "SIGNING"] },
        updatedAt: { lt: new Date(Date.now() - leasePreEnvioMs()) } }, data: { status: "DRAFT" } });
      if (r.count === 0) return resultadoDaLinha(snap, { success: true, emAndamento: true, mensagem: "Emissão em andamento" });
      await deps.nfeRepo.addAuditLog(nfeId, userId, "RECUPERADA_TRAVADA", { numero: viva!.numero });
      break;
    }
    case "SEGUIR": break;
  }

  // E2 — draft + validate (idêntico a usecase:93-129)
  const draft = await deps.nfeRepo.findDraftById(userId, nfeId);
  if (!draft) throw new Error("Rascunho nao encontrado");
  const isSefaz = config.providerName === "SEFAZ_DIRECT";
  if (!isSefaz && !config.providerToken) throw new Error("Token do provedor fiscal nao configurado");
  deps.validate(draft, config);

  // E3 — guardas pré-claim (sem efeito colateral)
  const key = { cfc: config.id, ambiente: config.ambiente, modelo, serie: draft.serie };
  const conteudoSha256 = hashConteudo(draft, config);                       // stableStringify sem id/status/numero/timestamps
  const pre = decidirPreClaim({ viva, key, conteudoSha256, ultimaTentativa: viva && await numeracao.ultimaTentativa(viva.id),
                                confirmarDescarte: opts.confirmarDescarteNumero === true, agora: new Date() });
  if (pre.acao === "CONFIRMAR_DESCARTE") throw new NumeracaoError("NUMERACAO_CONFIRMAR_DESCARTE", 409, pre.mensagem, pre.detalhes);
  if (pre.acao === "COOLDOWN") return resultadoRejeitado(snap, viva!, { bloqueioRepeticao: true, mensagem: pre.mensagem });

  // E4 — claim (igual usecase:147-150; V2 exige a coluna cStatRejeicao — pré-condição do DDL)
  const claimed = await prisma.nfeEmitida.updateMany({ where: { id: nfeId, userId, status: { in: ["DRAFT", "REJECTED"] } },
    data: { status: "VALIDATING", motivoRejeicao: null, cStatRejeicao: null } });
  if (claimed.count === 0) return resultadoDaLinha(await loadSnap(), { success: true, emAndamento: true,
    mensagem: "Emissão desta NF-e já está em andamento" });

  let fase: "PRE" | "TRANSMITINDO" = "PRE"; let tentativa: Tentativa | null = null;
  try {
    // E5 — cálculo (novo puro montarEntradaCalculoEmissao ≡ usecase:163-193) + calculator + persistCalculo (≡ :195-214)
    const { itensInput, freteOpts } = montarEntradaCalculoEmissao(draft, config.regimeTributario, modelo);
    const calc = deps.calculator.calcular(config.regimeTributario, itensInput, freteOpts);
    draft.itens.forEach((it, i) => (it.tributosJson = calc.itens[i]));
    await deps.nfeRepo.persistCalculo(nfeId, { totaisJson: calc.totais, itens: draft.itens });

    // E6 — reserva (tx única; grava número na linha)
    const isDefault = draft.companyFiscalConfigId ? (config.isDefault ?? true) : true;
    const reserva = await numeracao.reservarOuReutilizar({ userId, nfeId, key, isDefault, row: draft, providerName: config.providerName,
      confirmarDescarte: opts.confirmarDescarteNumero === true, emitenteSnapshot: deps.buildEmitenteSnapshot(config) });
    await deps.nfeRepo.addAuditLog(nfeId, userId, "NUMERADA", { numero: reserva.numero, serie: draft.serie,
      origem: reserva.origemDecisao, reservaId: reserva.id });
    log("nfe.numeracao.reservado", { nfeId, numero: reserva.numero, origem: reserva.origemDecisao });

    // E7 — SIGNING
    await deps.transitionStatus(nfeId, userId, "VALIDATING", "SIGNING");
    const nfe = await deps.loadNfe(nfeId);

    // E8 — preparar (sem rede; qualquer throw = erro local ⇒ número mantido)
    const prep = isSefaz ? await this.prepararSefaz(userId, nfeId, nfe, config, reserva)
                         : await this.prepararFocus(nfeId, nfe, config, reserva);
    await this.salvarXmlOriginal(userId, nfeId, prep.xmlOriginalContent);    // ≡ usecase:305-334

    // E9 — iniciarTransmissao (tx: tentativa TRANSMITINDO + reserva EM_TRANSMISSAO + linha SIGNING→SENDING)
    tentativa = await numeracao.iniciarTransmissao(reserva, { ...prep.registro, conteudoSha256 },
                                                   isSefaz ? leaseEnvioSefazMs() : leaseEnvioFocusMs());
    fase = "TRANSMITINDO";
    await deps.nfeRepo.addAuditLog(nfeId, userId, "ENVIADA", { providerName: config.providerName, numero: reserva.numero, tentativa: tentativa.seq });

    // E10 — transmitir
    const bruto = isSefaz ? await prep.sefaz!.transmitirPreparada(prep.preparada!)
                          : await prep.focus!.emitir(prep.payload, prep.focusRef!, config.providerToken!);
    let cls = isSefaz ? classificarEnvioSefaz(bruto) : classificarPostFocus(bruto);
    await numeracao.registrarResposta(tentativa, bruto, cls);

    // E11 — follow-ups (≤ 1 consulta + 3 polls; NUNCA renumera dentro da chamada)
    cls = await this.seguir(cls, { tentativa, reserva, prep, config });

    // E12/E13 — aplicar (§4.10)
    return await this.aplicar(userId, nfeId, config, reserva, tentativa, cls, prep);
  } catch (err) {
    if (fase === "PRE") {
      await deps.forceStatus(nfeId, "DRAFT");                                               // ≡ usecase:552
      await deps.nfeRepo.addAuditLog(nfeId, userId, "EDITADA_DRAFT",
        { motivo: "Erro antes do envio - numero mantido", erro: msg(err) });              // prefixo mantido (§4.5 evidência A)
      log("nfe.numeracao.falha_local", { nfeId });                                          // reserva intacta ⇒ retry reusa
    } else {
      await safe(() => numeracao.marcarIncertoSeAberta(tentativa!));                        // nunca rebaixa terminal
      await deps.nfeRepo.addAuditLog(nfeId, userId, "ENVIO_INCERTO", { motivo: "Erro apos envio - reconciliar por consulta", erro: msg(err) });
    }
    throw err;
  }
}
```

**Branches of `decidirEntrada`** (pure):

| Row status | Live reservation | Action |
|---|---|---|
| AUTHORIZED | any | REPLAY_AUTORIZADA |
| CANCELLED / INUTILIZED | any | DELEGAR_V1 |
| DRAFT / REJECTED | none, RESERVADO, REJEITADO | SEGUIR |
| DRAFT / REJECTED | EM_TRANSMISSAO / INCERTO (only possible after manual SQL) | RECONCILIAR |
| any | BLOQUEADO | BLOQUEADA_MANUAL |
| VALIDATING / SIGNING | none | EM_ANDAMENTO (a winner between claim and reservation, or an old stuck row: decision 3) |
| VALIDATING / SIGNING | RESERVADO/REJEITADO, `updatedAt` older than the pre-send lease | RETOMAR_TRAVADA |
| VALIDATING / SIGNING | RESERVADO/REJEITADO, recent | EM_ANDAMENTO |
| SENDING | none | EM_ANDAMENTO, message "emissão anterior à numeração v2 — sem ação automática" |
| SENDING | EM_TRANSMISSAO with a valid lease | EM_ANDAMENTO |
| SENDING | INCERTO, or EM_TRANSMISSAO with an expired lease | RECONCILIAR |

**`prepararSefaz`:**
- `sefaz = await createNfeProviderFromConfig({ providerName: "SEFAZ_DIRECT", ambiente: config.ambiente, uf, certificadoPath, certificadoSenhaEnc })`. A certificate load failure is local.
- `preparada = sefaz.prepararEmissao({ draft: nfe, config, numero, cNF: reserva.cNF!, dhEmi: new Date() })`.
- `xmlPath = storage.saveXmlTentativa(...)`.
- The `xmlOriginalContent` JSON snapshot is the same as `usecase:307-316`.
- `registro = { provedor: "SEFAZ_DIRECT", ambiente, tpEmis: 1, chaveAcesso, cNF, dhEmi, digestValue, xmlAssinadoPath }`.

**`prepararFocus`:**
- The payload as in §4.7.
- `focusRef = await numeracao.focusRefPara(nfeId, numero)`.
- `focus = new FocusNfeV2Client(config.ambiente, modelo)`.
- `registro = { provedor: "FOCUS_NFE", ambiente, focusRef }`.

**`iniciarTransmissao` SQL** (one transaction):

```sql
SELECT * FROM "NfeNumeroReserva" WHERE "id"=$r FOR UPDATE;                 -- estado ∈ (RESERVADO,REJEITADO) senão throw
SELECT COALESCE(MAX("seq"),0)+1 AS seq FROM "NfeNumeroTentativa" WHERE "reservaId"=$r;
INSERT INTO "NfeNumeroTentativa" (…, "fase","transmitidaEm") VALUES (…, 'TRANSMITINDO', NOW()) RETURNING *;
UPDATE "NfeNumeroReserva" SET "estado"='EM_TRANSMISSAO',"provedorUltimo"=$p,"leaseAte"=NOW()+($lease||' milliseconds')::interval,
  "bloqueadoAte"=NULL,"updatedAt"=NOW() WHERE "id"=$r AND "estado"=$de;
UPDATE "NfeEmitida" SET "status"='SENDING',"chaveAcesso"=COALESCE($chave,"chaveAcesso"),"dataEmissao"=COALESCE($dhEmi,"dataEmissao"),
  "updatedAt"=NOW() WHERE "id"=$nfe AND "status"='SIGNING';                 -- count ≠ 1 ⇒ throw (rollback)
```

### 4.10 `aplicar`: from classification to effects

Each case is one transaction: reservation (`WHERE estado=$de`), then attempt, then row. Rejections write status, motivo and integer cStat in **one** update, replacing V1's two-step at `usecase:1059-1070` (the R3 fix).

| Target state | Transaction | After the transaction | Returned result |
|---|---|---|---|
| AUTORIZADO | reservation → AUTORIZADO (`consumidoEm`); attempt FECHADA (protocolo, numeroLido/serieLida); Focus: `realinharFocus` when divergent; `UPDATE NfeEmitida SET status='AUTHORIZED', chaveAcesso=$chave44, protocoloAutorizacao, dataAutorizacao=COALESCE($d,NOW()), xmlAssinadoPath WHERE id AND status='SENDING'` | `deps.handleAuthorized(nfeId, userId, numeroReal, serieReal, chave44, protocolo, data, providerCompat, config, xmlInline, { focusRef })`. `xmlInline` for SEFAZ is `bruto.xmlAutorizado` or `montarNfeProc(stored signed XML, protNFeXml)`; for Focus it is null (buscarXml by ref). Its `transitionStatus` is a harmless no-op (V12). | V1 authorized result + `numeracao` |
| REJEITADO | reservation → REJEITADO (`ultimoCStat`, `ultimoCodigoProvedor`, `motivo`); attempt FECHADA `prova=RESPOSTA_CONCLUSIVA`; `UPDATE NfeEmitida SET status='REJECTED', motivoRejeicao=$m, cStatRejeicao=$intOuNull WHERE id AND status='SENDING'` | audit `REJEITADA {classe, codigo, numeroMantido:true}` | `REJECTED`, "`{motivo}` — nº N mantido para a correção" |
| RESERVADO (Focus pre-SEFAZ, 108/109, all attempts closed) | same shape; audits `ERRO_PROVEDOR` / `SEFAZ_INDISPONIVEL` / `ENVIO_NAO_REGISTRADO`; set `bloqueadoAte` for 429/656 | as left | `REJECTED`, number kept |
| DENEGADO / INUTILIZADO / CONSUMIDO_EXTERNO | reservation → state (`consumidoEm`); attempt FECHADA; row REJECTED (motivo, cStat) | audit `DENEGADA` / `NUMERO_INUTILIZADO` / `NUMERO_CONSUMIDO_EXTERNO {numeroMantido:false}` | `REJECTED`, "nº N consumido; a próxima emissão desta nota usará outro número" |
| INCERTO | reservation → INCERTO (`leaseAte` NULL); attempt RESPONDIDA; row stays SENDING | audit `ENVIO_INCERTO {classe, chaveSufixo}` | `pendingResult` (`usecase:654-671` shape), "Envio sem confirmação — nº N reservado; use Consultar situação" |
| BLOQUEADO | reservation → BLOQUEADO; row stays SENDING | audit `NUMERACAO_BLOQUEADA_CRITICO`; log error | `success:false`, "exige conferência manual" |

If a reservation update affects 0 rows, the transaction throws and the orchestrator's catch (phase TRANSMITINDO) marks the reservation INCERTO when it is still open. Nothing after transmission is swallowed silently; it is always logged.

### 4.11 Timeout and consult flow

`reconciliar(userId, nfeId, viva, configAtual, { reenviar, opts })`:

```ts
if (!(await numeracao.tomarLease(viva.id, 180_000))) return emAndamento;   // UPDATE … WHERE estado IN (EM_TRANSMISSAO,INCERTO) AND (leaseAte IS NULL OR leaseAte<NOW())
const cfg = viva.companyFiscalConfigId === configAtual.id ? configAtual
          : await deps.configRepo.findByIdForUser(viva.companyFiscalConfigId, userId);
const abertas = await numeracao.tentativasAbertas(viva.id);                  // fase ≠ FECHADA, mais nova primeiro
let consumo: { cls; t } | null = null; let todasFechadas = true;
for (const t of abertas) {
  const c = await this.consultarTentativa(t, cfg, viva);                      // provedor DA TENTATIVA, ambiente DA RESERVA
  const cls = t.provedor === "SEFAZ_DIRECT"
    ? classificarConsultaSefaz(c, { chaves: todasChaves, digests: todosDigests, madura: provaMadura(t, new Date()) })
    : classificarGetFocus(c, { chaves: todasChaves, madura: provaMadura(t, new Date()) });
  await numeracao.registrarConsulta(t, c, cls);                              // fecha a tentativa quando a prova é madura
  if (["AUTORIZADO", "DENEGADO", "INUTILIZADO", "CONSUMIDO_EXTERNO", "BLOQUEADO"].includes(cls.estadoAlvo)) { consumo = { cls, t }; break; }
  if (!cls.fechaTentativa) todasFechadas = false;
}
if (consumo) return this.aplicar(userId, nfeId, cfg, viva, consumo.t, consumo.cls, null);
if (todasFechadas) {
  await numeracao.naoConstaConfirmado(viva, nfeId);   // tx: reserva → RESERVADO; linha SENDING → REJECTED "Envio não registrado na SEFAZ — nº N mantido"
  await deps.nfeRepo.addAuditLog(nfeId, userId, "ENVIO_NAO_REGISTRADO", { numero: viva.numero });
  if (reenviar) return this.emitir(userId, nfeId, { ...opts, _jaReconciliado: true });   // mesmo nº, mesmo cNF, dhEmi novo, mesma requisição
  return resultadoRejeitado(…, { mensagem: "Envio não registrado na SEFAZ — pode reenviar; o nº N continua desta nota" });
}
await numeracao.devolverIncerto(viva.id);                                     // estado INCERTO, leaseAte NULL
return pendingV2("Situação ainda indefinida na SEFAZ — consulte novamente em alguns minutos");
```

**`consultarTentativa`:**
- **SEFAZ:** `createNfeProviderFromConfig({ providerName: "SEFAZ_DIRECT", ambiente: viva.ambiente, uf: cfg.uf, certificadoPath, certificadoSenhaEnc, timeoutMs: 20_000, retryMax: 1 })`. The options exist at `provider-factory.ts:89-117`. With an nRec still processing it calls `consultarReciboDetalhado`; otherwise `consultarDetalhado(t.chaveAcesso)`. Missing certificate or config gives `transporte: "SEM_CREDENCIAL"`, which is inconclusive.
- **Focus:** `new FocusNfeV2Client(viva.ambiente, viva.modelo).consultar(t.focusRef, cfg.providerToken)`. No token is inconclusive.

**Entry points** (no background job):
1. `POST /issue` on a SENDING V2 row with INCERTO, or with an expired lease. This path reconciles and **resends in the same request** when "not found" is proven. The row stays SENDING during the check, so it cannot be edited between attempts.
2. New `POST /fiscal/nfe/:id/consultar-situacao`. It returns 404 `{error:"Recurso indisponível"}` when V2 is off for the user; 409 unless the reservation is INCERTO or EM_TRANSMISSAO with an expired lease; otherwise it runs `reconciliar(…, { reenviar: false })`. It never transmits.

**Edge case after a consult-only "not found":** the row becomes REJECTED and editable. If an earlier attempt is authorized very late, the resend (same cNF, same month) gets 204 and the consult returns 100 with the old digest. The note is authorized with **that attempt's** signed XML (the legal document), audited CRITICO `AUTORIZADA_COM_CONTEUDO_DE_TENTATIVA_ANTERIOR` when the current `conteudoSha256` differs, and the DANFE is built from the XML.

### 4.12 Retry, edit, série / emitter / ambiente change, delete

| Event | V2 behaviour |
|---|---|
| Wizard edit (PUT → `updateDraft` forces DRAFT, `nfe.repository.ts:379-381`), `/calculate` (`fiscal.routes.ts:865-867`) | `updateDraft` untouched. The reuse decision reads the reservation for `nfeId`, never the status, so the number is **kept** (R1 fixed). |
| Retry with no edit after REJEITADO/RESERVADO | Same number, same cNF, same Focus ref. L1 cooldown applies (§4.18). |
| Local error (certificate, build, signing, storage, database) | Row DRAFT, reservation RESERVADO; retry uses **the same number** (R5 and B6 fixed). |
| Série, emitter or modelo changed; old ambiente PRODUCAO | Pre-claim 409 `NUMERACAO_CONFIRMAR_DESCARTE {numero, serie, motivo}`. The confirmation re-POST sends `{confirmarDescarteNumero:true}`; the old number goes to ABANDONADO (`requerInutilizacao=true`) and a new number is allocated in the new key, both in the slow-path transaction. |
| Ambiente change from HOMOLOGACAO | Old number ABANDONADO automatically (`requerInutilizacao=false`). |
| Any change while INCERTO/EM_TRANSMISSAO | Impossible: the row is SENDING, so `updateDraft` is a silent no-op (`nfe.repository.ts:413-418`). Resolve by consulting first. |
| PDV switches emitter (`finance.usecase.ts:1887-1900`) | Passes `{ confirmarDescarteNumero: true }` to `emit` at `:1910`, **only** when the emitter actually changed. V1 ignores `opts`. |
| "Nova NF-e" reopens the latest DRAFT (`nfe-draft.usecase.ts:123-124`), which may hold RESERVADO 101 | It gets 101. That is correct: the document is the row and 101 was never consumed. Documented as behaviour, not a bug. |
| DELETE draft (V2, `nfe-draft.usecase.ts:524-531`) | See the pseudo-code below. |

```
tx: viva0 = reservaViva(id)
    if (viva0) { lockSequencia(key(viva0)); v = lockReservaPorId(viva0.id) }
    if EXISTS reserva(nfeId=id, estado IN ('AUTORIZADO','CANCELADO','DENEGADO')) → 409 DOCUMENTO_FISCAL_REGISTRADO
    if v?.estado IN (EM_TRANSMISSAO,INCERTO,BLOQUEADO) → 409 NFE_NUMERO_PENDENTE_CONSULTA (defensivo)
    if v && v.ambiente==='PRODUCAO' && !descartarNumero → 409 NUMERACAO_CONFIRMAR_DESCARTE {numero, serie}
    if v → ABANDONADO(RASCUNHO_EXCLUIDO, requerInutilizacao = v.ambiente==='PRODUCAO')
    deleteMany NfeEmitida {id, userId, status IN (DRAFT,REJECTED)}; count 0 ⇒ throw "Rascunho de NF-e não encontrado" (rollback)
old row (no reservation) with numero>0 → log nfe.numeracao.legado_rascunho_excluido only (decision 3)
```

The ledger rows have no FK to the row, so they survive the delete while `NfeAuditLog` cascades (`schema.prisma:2001`). The route reads `?descartarNumero=true`; a `NumeracaoError` branch in the route maps to 409.

### 4.13 Pool decision: no pool

- A new document always takes the counter's next free number. Abandoned numbers are never handed out again.
- **Reasons:**
  - (a) Whether Focus accepts reusing a number that sits on another ref in `erro_autorizacao` is unconfirmed.
  - (b) It keeps "new document gets 102" literal.
  - (c) A pool needs an extra state machine and a query under the lock on every allocation.
  - (d) After R1–R5 are fixed, gaps only come from explicit, confirmed user actions (delete or key change in PRODUCAO) or from consumption, and each one is recorded with `requerInutilizacao` and listed by the diagnostic.
- **Phase 2**, only if the user asks for it: a separate flag that recycles `ABANDONADO` numbers that were **never transmitted** (no attempt) and are not covered by an inutilização, under the same sequence lock.

### 4.14 Idempotency and concurrency

| Threat | Mechanism |
|---|---|
| Double click / parallel `/issue` on the same row | The atomic claim (`usecase:147-150`) comes before any reservation. The loser returns 200 `emAndamento`. Front end: a synchronous `useRef` guard set **before** `await saveCurrentStep()` (closes the window at `nfe-wizard.tsx:457-466`), active only on V2 drafts. Database backstop: partial unique `NfeNumeroReserva_nfeId_vivo_key`. |
| Front-end retry after the server finished, or a 504 from the proxy | AUTHORIZED → replay; SENDING with lease → `emAndamento`; expired → reconcile. Never 101/102/103. |
| Two users, different documents, same key | `FOR UPDATE` on `NfeSequence` inside the transaction that inserts the reservation and writes the row. Backstops: `NfeNumeroReserva_cfc_amb_mod_serie_num_key` and `NfeEmitida_cfcId_…_key`. A violation rolls everything back, nothing is sent, the row goes DRAFT. |
| Two requests sending the same number | Only one `iniciarTransmissao` can move RESERVADO/REJEITADO → EM_TRANSMISSAO. Consults need an expired lease (`tomarLease`) and never transmit. |
| Crash after reserving, before sending | Row stuck in VALIDATING/SIGNING while the reservation is RESERVADO. After the pre-send lease, RETOMAR_TRAVADA sets DRAFT and the same number is reused. |
| Crash after sending | Reservation EM_TRANSMISSAO; when the lease expires, consult first. |
| Crash between the AUTORIZADO transaction and `handleAuthorized` | Row AUTHORIZED without XML/DANFE, which is the same recoverable class as V1's `XML_AUTORIZADO_PENDENTE`. Replay returns AUTHORIZED. |
| Deadlocks | I6 order everywhere: emission slow path, delete, inutilização, Focus realignment. The reuse fast path never takes a sequence lock after taking a reservation lock. |
| Tenants / emitters / séries / ambientes / modelos | The key is `(cfc, ambiente, modelo, série)`, with legacy NULL-config rows included only for the default emitter (same rule as `nfe-sequence.service.ts:146-147`). |
| Focus ↔ SEFAZ | There is no provider dimension: one counter. Attempts record the provider; consults go through that provider; reusable numbers move across providers freely. |
| Same CNPJ in two tenants (`schema.prisma:1849`); shared Focus tokens | Cannot be prevented per tenant. Shows up as CONSUMIDO_EXTERNO plus loop guard L2; the diagnostic reports it (md5 groups of tokens). Not fixed. |

### 4.15 Inutilização and cancellation

**Inutilização, V2 branch at `nfe-inutilizacao.usecase.ts:59`** (only when `isNumeracaoV2ParaUsuario(userId)`; modelo 55):

1. Validation and config: unchanged (`:63-103`).
2. **Guard transaction:**
   - `lockSequencia(key)`.
   - `SELECT id, numero, status FROM "NfeEmitida"` for the key (including legacy NULL-config rows of the default emitter) with `numero BETWEEN ini AND fim AND status <> 'INUTILIZED'`.
   - `SELECT … FROM "NfeNumeroReserva" WHERE key AND numero BETWEEN … FOR UPDATE`.
   - Pure `avaliarFaixa`. It **blocks** rows that are AUTHORIZED, CANCELLED, SENDING, VALIDATING, SIGNING, DRAFT or REJECTED holding a number (the message tells the user to delete that draft first). It also blocks reservations that are anything other than `ABANDONADO`.
   - If blocked, throw `NumeracaoError("FAIXA_COM_NUMERO_VIVO", 400, "…nº 101 (rascunho X)…")` listing up to 10.
3. PENDENTE record and provider call: as `:106-138`. For Focus, V2 uses `FocusNfeV2Client.inutilizar`: `success = corpo.status === "autorizado" && normalizarCStat(corpo.status_sefaz) === 102`, `protocolo = corpo.protocolo_sefaz` (fixes V6 under V2 only).
4. Record update: as `:141-152`.
5. **On success, one transaction:** `lockSequencia`; `UPDATE "NfeNumeroReserva" SET estado='INUTILIZADO', "consumidoEm"=NOW() WHERE key AND numero BETWEEN … AND estado='ABANDONADO'`; if `proximoNumero <= fim`, set it to `fim+1` under the lock. This replaces the unlocked `:166-182` for V2.
6. **On failure:** same as V1. The counter never moved, so no gap.
7. Allocation skips ranges that are ACEITA, or PENDENTE and less than 15 min old (§4.4 `ocupacao`).
8. **No "inutilizar todas as lacunas" action exists.** Gaps come only from the diagnostic, so the counter bug cannot be hidden.

**Cancellation, V2 branch in `nfe-cancelamento.usecase.ts`:**
- Before `:109`: `ref = (await numeracao.focusRefAutorizada(nfeId)) ?? nfeId`, taken from the attempt that closed with AUTORIZADO.
- After `:135-146`: `safe(() => numeracao.marcarCancelado(nfeId, result.protocolo))`, moving AUTORIZADO → CANCELADO. Old rows without a reservation are a no-op.

### 4.16 SVC under V2

- **V2 never goes to SVC on its own, whatever `SEFAZ_AUTO_FALLBACK_ENABLED` says.**
  - The builder emits no `dhCont`/`xJust` (V8), so tpEmis 6/7 XML would be schema-rejected.
  - After an uncertain outcome, contingency means a new document with a new number and manual cancellation or inutilização of the original. That must not happen by guessing.
  - 108/109 go to RESERVADO with "SEFAZ indisponível — tente novamente; nº mantido".
  - 280–289 are REJEITADO.
- **V1 is unchanged** (`usecase:377-454`, `contingencia.service.ts:61-109`).
- **Operational:** read the production value of `SEFAZ_AUTO_FALLBACK_ENABLED` (read-only) and keep it off. SVC V2 is a separate task (builder `dhCont`/`xJust` first).

### 4.17 Old rows and the diagnostic script (decision 3)

- **No automatic action on old rows:** no release, no inutilização, no reconciliation, no list button. The only V2 behaviour is evidence-based adoption onto the same row (§4.5). Old SENDING rows return `emAndamento` and nothing else.
- **`scripts/fiscal/diagnostico-numeracao-nfe.ts`.** Classification logic lives in the pure `app/fiscal/numeracao/diagnostico-classificacao.ts`.
  - **Read-only guarantees.** Everything runs inside `prisma.$transaction` whose first statement is `SET TRANSACTION READ ONLY`. A source-guard test forbids `.create(`, `.update(`, `.delete(`, `upsert` and any `$executeRaw` except that line. It never prints tokens (only the first 8 hex characters of md5) and never prints recipient data.
  - **Arguments:** `--user-id=…`, `--todos`, `--ambiente=PRODUCAO|HOMOLOGACAO|todos`, `--modelo=55|65|todos`, `--csv`.
  - **Per key it reports:**
    - `proximoNumero` and the max nNF read from chaves.
    - Per-number class in `1..proximoNumero-1`: `AUTORIZADA_OK` (+`DIVERGENCIA_FOCUS` when `numero ≠ nNF`), `INUTILIZADA` (+`INUTILIZADA_FOCUS_NAO_VERIFICADA`), `REJEITADA_EM_POSSE` (+`CSTAT_PERDIDO_R3`), `EM_ABERTO_SENDING` (by provider / chave / last event), `ABANDONADA_POS_REJEICAO`, `ABANDONADA_ERRO_LOCAL`, `ABANDONADA_INCERTA` (chave from `ENVIO_INCERTO.detalhes`), `SEM_RASTRO`, `CONFLITO`.
    - **For Focus tenants, Dexo gaps and SEFAZ gaps (from chave nNF) are reported separately.** Only SEFAZ gaps matter fiscally.
    - The `decidirAdocaoLegado` verdict per DRAFT/REJECTED row.
    - The floor §4.4 R4 would apply, and `CONTADOR_ATRAS`.
    - Integrity checks: V2 reservation counts by state, INCERTO older than 1 h, BLOQUEADO, `ABANDONADO requerInutilizacao`.
    - The same CNPJ in more than one tenant; shared Focus tokens.
  - **Output:** `scripts/out/diagnostico-numeracao-<data>.{json,csv}` plus a console summary. It exits non-zero only on integrity failures.
  - **Optional `--consultar`** (VPS only; refuses to run unless the certificate file exists; needs the user's explicit go-ahead). It calls only `consultarDetalhado`, `consultarReciboDetalhado` and Focus GET, for the 22 SENDING rows, and prints suggestions. It never writes.

### 4.18 Loop guards

- **L1.** Checked before the claim. If the last attempt closed as REJEICAO or PRE_ENVIO_PROVEDOR with the same `conteudoSha256` less than 60 s ago, or `reserva.bloqueadoAte > now` (656: 60 min; 429: Retry-After), nothing is transmitted and the stored rejection comes back with `bloqueioRepeticao:true`. After 60 s an identical resend is allowed: Kiko's 974 is fixed outside Dexo, in the PR UPD system.
- **L2.** When the last 3 reservations for a key ended CONSUMIDO_EXTERNO, the result is 409 `SEQUENCIA_ATRAS_DA_SEFAZ`.
- **L3.** Per call: at most one number transmitted (plus identical SOAP retries), one automatic consult and 3 polls. A call **never** renumbers. 635 and 204 never renumber.
- **L4.** The allocation skip loop stops at 50 and rolls back.

### 4.19 Observability

`logNumeracao(evt, campos)` writes `console.info("[nfe-numeracao]", JSON.stringify(...))` using a field whitelist: `userId, nfeId, cfcId, ambiente, modelo, serie, numero, reservaId, tentativa, de, para, origem, provedor, cStat, codigoProvedor, chaveSufixo(10), latenciaMs, lockEsperaMs, motivo`.

Never logged: token, certificate password, CSC, XML, recipient data. Event `detalhes` keys avoid substrings that `sanitizeDeep` redacts (see the `SystemLog` gotcha).

| Level | Events |
|---|---|
| info | `reservado`, `transmissao_iniciada`, `resultado`, `incerto`, `consulta`, `nao_consta_confirmado`, `falha_local`, `legado_adotado`, `leg

| Level | Events |
|---|---|
| info | `reservado`, `transmissao_iniciada`, `resultado`, `incerto`, `consulta`, `nao_consta_confirmado`, `falha_local`, `legado_adotado`, `legado_nao_adotado`, `legado_rascunho_excluido`, `abandonado` |
| warn | `piso_aplicado`, `numero_pulado`, `consumido_externo`, `sequencia_atras`, `cooldown`, lock wait > 2000 ms |
| error | `focus_divergencia`, `bloqueado`, `numero_em_dois_documentos`, `autorizada_com_conteudo_anterior`, `inconsistencia`, `escrita_falhou` |

The user-visible trail in `NfeAuditLog` uses these events: NUMERADA (with origem and reservaId), ENVIADA (with tentativa), REJEITADA, ERRO_PROVEDOR, SEFAZ_INDISPONIVEL, DENEGADA, NUMERO_INUTILIZADO, NUMERO_CONSUMIDO_EXTERNO, ENVIO_INCERTO, ENVIO_NAO_REGISTRADO, RECUPERADA_TRAVADA, NUMERACAO_DIVERGENTE_FOCUS and NUMERACAO_BLOQUEADA_CRITICO.

### 4.20 Frontend

**Contract.** V2 is detected from the API payload only; there is no `NEXT_PUBLIC` flag.

- `nfeDraft.getById` attaches `numeracao: { numero, serie, ambiente, companyFiscalConfigId, estado, reutilizavel } | null`, but only when `isNumeracaoV2ParaUsuario(userId)`.
- `NfeRepository.findEmitted` adds one extra query when the flag is on: `SELECT "nfeId","estado","numero" FROM "NfeNumeroReserva" WHERE "nfeId" = ANY($1) AND "estado" IN ('RESERVADO','REJEITADO','EM_TRANSMISSAO','INCERTO','BLOQUEADO')` over the ids of the page. Each item gets `numeracao?: { estado, numero } | null`.
- `NfeDraftResponse`, `NfeListItem` (`app/interfaces/nfe.interface.ts`) and `EmissionResult` only gain optional fields.

**Pure module `app/notas-fiscais/lib/nfe-numeracao-ui.ts`.** No imports from `app/fiscal/sefaz`, because `chave-acesso.ts` needs `node:crypto`. Tested in node.

```ts
export const usaNumeracaoV2 = (d: unknown): boolean => !!d && typeof d === "object" && "numeracao" in (d as object);
export function podeDispararEmissao(s: { draftId: string | null; emEnvio: boolean }): boolean;
export type InterpretacaoEmissao =
  | { tipo: "AUTORIZADA"; mensagem: string; redirecionar: true }
  | { tipo: "EM_ANDAMENTO" | "PENDENTE"; mensagem: string }
  | { tipo: "REJEITADA"; mensagem: string; numeroMantido: boolean }
  | { tipo: "CONFIRMAR_DESCARTE"; mensagem: string; numero: number; serie: number; motivo: string }
  | { tipo: "ERRO"; mensagem: string };
export function interpretarRespostaEmissao(httpStatus: number, body: any): InterpretacaoEmissao;
export function acaoListaNumeracao(n: { status: string; numeracao?: { estado: string } | null }):
  "TENTAR_NOVAMENTE" | "CONSULTAR_SITUACAO" | null;
  // REJECTED + (RESERVADO|REJEITADO) ⇒ TENTAR_NOVAMENTE ("mantém o nº");
  // SENDING + (INCERTO|EM_TRANSMISSAO) ⇒ CONSULTAR_SITUACAO; numeracao null/undefined ⇒ null
export function textoConfirmacaoDescarte(d: { numero: number; serie: number; motivo: string }): string;
export function bannerNumeracao(n: { estado: string; numero: number; serie: number } | null): string | null;
```

**`nfe-wizard.tsx`.** The new behaviour runs only when `usaNumeracaoV2(loadedDraft)`.

- Add `const emEnvioRef = useRef(false)`. In `handleEmitir`, set it synchronously **before** `await saveCurrentStep()` and reset it in `finally`.
- Map the response through `interpretarRespostaEmissao`.
- On `CONFIRMAR_DESCARTE`, show a confirmation using the existing dialog pattern, then re-POST `{ confirmarDescarteNumero: true }`.
- Show `bannerNumeracao` next to the existing rejection banner (`:534-548`).
- Otherwise the current code path runs.

**`nfe-list.tsx` (`:784-807`).** When `nota.numeracao !== undefined`, the actions come from `acaoListaNumeracao`:

- "Tentar novamente — mantém o nº N" opens the wizard.
- "Consultar situação" (RefreshCw) POSTs `/fiscal/nfe/:id/consultar-situacao` and shows a toast.
- The draft delete action handles a 409 `NUMERACAO_CONFIRMAR_DESCARTE` by confirming and retrying with `?descartarNumero=true`.
- Legacy rows (`numeracao: null`) get no new button (decision 3).

Without the field, the current JSX runs.

### 4.21 Flag-off identity checklist

1. `emit()` does one synchronous env read. When it is false, lines 92–564 run unchanged. `opts` is never read.
2. `handleAuthorized` has an optional last parameter. When it is absent, `buscarXml(nfeId, …)` is called exactly as at `:815`.
3. These files are unchanged: `nfe-sequence.service.ts`, `cstat-mapper.ts`, `nfe-number-reuse.ts`, `contingencia.service.ts`, `focus-nfe.provider.ts`, `nfe-xml-builder.service.ts`, `nfe-xml-builder-sefaz.service.ts`, and `NfeRepository.updateDraft/createDraft/deleteDraft/findDraftById`.
4. `sefaz-direct.provider.ts` only gains new methods. `emitir`, `consultar`, `consultarRecibo`, `cancelar`, `inutilizar`, `cartaCorrecao` and the parsers stay byte-identical.
5. `fiscal-storage.service.ts` only gains a new method.
6. Routes:
   - `/issue` and `DELETE /nfe/draft/:id` get an `instanceof NumeracaoError` branch before the existing mapping. Only V2 code throws that error.
   - `/issue` reads `body.confirmarDescarteNumero` and DELETE reads `query.descartarNumero`; both are passed only into V2 paths.
   - The new `consultar-situacao` endpoint returns 404 when V2 is off.
7. `nfe-draft.usecase` (getById, delete), `nfe-inutilizacao.usecase`, `nfe-cancelamento.usecase` and `NfeRepository.findEmitted` each start with one synchronous check.
8. `finance.usecase.ts:1910` passes `opts` to `emit`, which V1 ignores. It is `{confirmarDescarteNumero:true}` only on an actual emitter switch.
9. The UI is unchanged without the `numeracao` field.
10. Database: two new tables. Nothing reads them when V2 is off. The flag-off path needs no DDL, and there is no Prisma client regeneration.
11. Known V1 bugs stay as they are with the flag off (R1–R5, B6, V6, V9, V13). V2 is the fix.

### 4.22 Files to touch

**New files**

| File | Content |
|---|---|
| `prisma/ddl/2026-09-18-nfe-numeracao-v2.sql` | §4.2 |
| `app/fiscal/numeracao/flags.ts` | §4.1 |
| `app/fiscal/numeracao/estados.ts` | states, `podeTransicionar`, `VIVOS` sets (pure) |
| `app/fiscal/numeracao/classificacao.ts` | `normalizarCStat`, `extrairChaveReferida`, `classificarEnvioSefaz`, `classificarConsultaSefaz`, `classificarPostFocus`, `classificarGetFocus`, `provaMadura` (pure) |
| `app/fiscal/numeracao/decisao.ts` | `decidirEntrada`, `decidirPreClaim`, `decidirAdocaoLegado`, `decidirReadbackFocus`, `avaliarFaixa`, `focusRefParaPuro`, `hashConteudo` (pure) |
| `app/fiscal/numeracao/numeracao.errors.ts` | `NumeracaoError { code, httpStatus, detalhes }` |
| `app/fiscal/numeracao/numeracao.repository.ts` | raw SQL; `INfeNumeracaoRepository`; injectable client |
| `app/fiscal/numeracao/numeracao.service.ts` | `reservarOuReutilizar`, `iniciarTransmissao`, `registrarResposta`, `registrarConsulta`, `aplicar*` transactions, `realinharFocus`, `marcarIncertoSeAberta`, `tomarLease`, `devolverIncerto`, `naoConstaConfirmado`, `abandonarPorExclusao`, `inutilizacaoGuard/Pos`, `marcarCancelado`, `focusRefPara`, `focusRefAutorizada` |
| `app/fiscal/numeracao/calculo-emissao.ts` | `montarEntradaCalculoEmissao` (pure; equivalent to `usecase:163-193`) |
| `app/fiscal/numeracao/diagnostico-classificacao.ts` | pure |
| `app/fiscal/sefaz/digest.ts` | `extrairDigestValue(signedXml)` |
| `app/fiscal/providers/focus-nfe-v2.client.ts` | §4.7 |
| `app/usecases/nfe-emissao-v2.orchestrator.ts` | §4.9–4.11 |
| `app/usecases/nfe-numeracao-consulta.usecase.ts` | the endpoint |
| `app/notas-fiscais/lib/nfe-numeracao-ui.ts` | §4.20 |
| `scripts/fiscal/diagnostico-numeracao-nfe.ts` | §4.17 |

**Changed files** (additive and gated)

| File | Change |
|---|---|
| `prisma/schema.prisma` | 2 models |
| `app/usecases/nfe-emission.usecase.ts` | dispatch, `v2()`, `EmitOpts`, optional `EmissionResult` fields, optional `handleAuthorized` parameter |
| `app/fiscal/providers/sefaz-direct.provider.ts` | 4 methods plus static `montarNfeProc` |
| `app/fiscal/storage/fiscal-storage.service.ts` | `saveXmlTentativa` |
| `app/usecases/nfe-draft.usecase.ts` | getById `numeracao`; V2 delete |
| `app/usecases/nfe-inutilizacao.usecase.ts` | V2 branch |
| `app/usecases/nfe-cancelamento.usecase.ts` | V2 ref and CANCELADO mark |
| `app/usecases/finance.usecase.ts` | pass opts at `:1910` |
| `app/repositories/nfe.repository.ts` | `findEmitted` attach |
| `app/interfaces/nfe.interface.ts` | optional fields |
| `app/routes/fiscal.routes.ts` | error branches, body/query options, new endpoint |
| `app/notas-fiscais/components/nfe-wizard.tsx`, `nfe-list.tsx` | §4.20 |
| `.env.example` | new variables |
| memory index file | partial-index list |

### 4.23 Tests

All tests run with vitest `--pool=forks` in the node environment, using `vi.hoisted` doubles as in `tests/fiscal/nfe-emission-company.spec.ts:13-74`.

**Harness `tests/fiscal/__helpers__/fake-numeracao-repo.ts`** implements `INfeNumeracaoRepository` in memory:
- a per-key promise-chain mutex models `FOR UPDATE` and the I6 order;
- a copy-on-write snapshot is rolled back when the transaction throws;
- it enforces the unique key, the partial unique on `nfeId` for live states, and every `WHERE estado=$de` guard.

Fakes for `SefazDirectProvider` (two-phase) and `FocusNfeV2Client` use response queues. An in-memory `nfeEmitida` store covers updateMany/update/findFirst. Storage is mocked. Polling uses `vi.useFakeTimers()`.

| Spec | Covers |
|---|---|
| `tests/fiscal/numeracao/classificacao.spec.ts` | Every row of the §4.8 tables. Also: `normalizarCStat("974")===974`; `("erro_validacao_schema")===null`; 110 with and without nProt; 204/205/206/218/539/562/613/635/656/999; 280–289 map to REJEITADO; Focus 401 HTML; 422 for each codigo; 429 with Retry-After; GET 404 mature vs immature; GET 403 is never "not found" |
| `.../estados.spec.ts` | full transition matrix, including the forbidden transitions |
| `.../decisao.spec.ts` | `decidirEntrada` table; `decidirPreClaim` (confirmation, cooldown); `decidirAdocaoLegado` (evidence A, evidence B, Focus refused, ENVIO_INCERTO refused, cStat 205 refused, inutilized refused, numero ≥ counter refused); `decidirReadbackFocus`; `avaliarFaixa`; `provaMadura` edges at 119 s and 120 s |
| `.../calculo-emissao-paridade.spec.ts` | V1 `emit` (stopped by a throw in `persistCalculo`) and V2 pass identical arguments to `calculator.calcular` for the same drafts (SIMPLES/NORMAL, frete flag on/off, modelo 65) |
| `.../sefaz-two-phase.spec.ts` | With `tests/fiscal/__helpers__/test-certificate.ts`: `prepararEmissao` is deterministic for a given cNF/dhEmi and throws on a missing `codMunicipio`; `transmitirPreparada` sends the signed XML byte-for-byte; the digest is extracted; **for the same inputs, `emitir()` produces the same envelope body as prepare + transmit** |
| `.../focus-client-v2.spec.ts` | Stubbed fetch: 201 autorizado; 202; 401 HTML does not throw; abort gives TIMEOUT; inutilização 200 + `erro_autorizacao` is a failure; `protocolo_sefaz` is read; the token never appears in the result |
| `.../emissao-v2-cenarios.spec.ts` | the 14 cases and the reported scenario (table below) |
| `.../emissao-v2-guardas.spec.ts` | 635 then retry is blocked; 539 with our chave from an earlier month gives AUTORIZADO; 539 with a foreign chave twice then L2; 422 `already_processed` then GET autorizado; key change in PROD returns 409 with no claim (`updateMany` not called), and with confirmation the old number is ABANDONADO and a new one is allocated; key change in HOMOLOG is automatic; `FLAG_ROLLBACK_V1` divergence; stale VALIDATING with a reservation is taken over, without one it stays `emAndamento`; cooldown within 60 s; Focus divergence (chave nNF 3 against reserved 12) sets row numero 3, reservation 12 ABANDONADO, counter moves forward, row updated before `handleAuthorized`; the late-authorization content-divergence audit |
| `.../reserva-concorrencia.spec.ts` | the fake with the mutex: 20 parallel `reservarOuReutilizar` calls on one key give {1..20}; an unique violation injected in `gravarNumeroNaLinha` rolls back both counter and reservation |
| `.../inutilizacao-v2.spec.ts` | refuses live rows or reservations; ABANDONADO becomes INUTILIZADO on success; counter moves forward under lock; failure leaves the counter untouched; allocation skips PENDENTE < 15 min |
| `.../delete-v2.spec.ts` | PROD requires confirmation; DENEGADO/AUTORIZADO refused; ABANDONADO kept after deletion; legacy delete writes nothing to the ledger |
| `.../flag-off-regressao.spec.ts` | Env unset, `"1"`, user not allowed, modelo 65 with default modelos, Focus without the sub-flag. In each: the orchestrator is never constructed (module mock spy); `reservarProximoNumero` gets exactly the V1 arguments (`nfe-emission-company.spec.ts:135-141`); the Focus payload has `numero_nota` and no `numero`; `buscarXml` receives `nfeId`; delete, inutilização and cancel issue no `NfeNumero*` SQL; the `/issue` claim loser still returns 500; `consultar-situacao` returns 404; the draft GET and list payloads have no `numeracao` key |
| `.../diagnostico-somente-leitura.spec.ts` | source guard plus pure classification |
| `tests/nfe-numeracao-ui.spec.ts` | the §4.20 functions |
| `tests/fiscal/db/nfe-numeracao.pg.spec.ts` (opt-in) | `describe.skipIf(!process.env.NFE_PG_TEST_URL)`; refuses hosts containing `supabase` or `pooler`. Setup: `docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:15-alpine`, minimal `NfeSequence`/`NfeEmitida`/`NfeInutilizacao` tables, partial indexes copied from `docs/multi-cnpj-sql.md:77-86,203-209`, and **the V2 DDL file read verbatim**. Two `PrismaClient({ datasourceUrl })` instances. Checks: 40 concurrent reservations give exactly 1..40 and counter 41; 10 concurrent first-allocations on a new key give one "1"; 10 on the same `nfeId` give one live row (partial unique); a throw after the bump leaves the counter unchanged; keys are independent; a seeded `NfeEmitida` numero=5 is skipped; slow-path, delete and inutilização run interleaved without deadlock |

**The 14 mandatory cases and the reported scenario** (`emissao-v2-cenarios.spec.ts`):

| # | Steps | Assertions |
|---|---|---|
| 1 | Local error: SEFAZ `prepararEmissao` throws (missing `codMunicipio`); fix and retry; then a new document | Reservation 101 RESERVADO, row DRAFT, 0 attempts, 0 transmissions. Retry: same 101, same cNF, AUTORIZADO. New document gets 102. The counter was bumped exactly twice. |
| 2 | SEFAZ rejection 225 (variants 974, 704, 781, 999); edit via `updateDraft` (row goes DRAFT); retry | REJEITADO, integer cStat. Retry reuses 101 with the same chave (same month). Authorized. |
| 3 | Focus: 422 `erro_validacao_schema`; 401 HTML; GET `erro_autorizacao` with `status_sefaz:"974"` | 422 and 401 give RESERVADO; `erro_autorizacao` gives REJEITADO. Row REJECTED (not SENDING), `cStatRejeicao` 974 as an integer, no Prisma error, no 500. Retry uses 101 with ref `nfeId` and payload `numero:"101"`. Focus 503 gives INCERTO. |
| 4 | Authorized, then `/issue` again, then a new document | `jaEmitida`, zero provider calls. New document gets 102. |
| 5 | Cancel an authorized note | Reservation CANCELADO. `/issue` replays or delegates (no transmission). Inutilização covering 101 refused. Delete refused. New document gets 102. |
| 6 | Document A abandoned 101 (PROD delete, confirmed); inutilização 101–101 succeeds; 206 during emission of document B holding 103 | 101 becomes INUTILIZADO and the counter is unchanged (already past). B's reservation 103 becomes INUTILIZADO and B's next emit gets a new number. Inutilização over an INCERTO range is refused. |
| 7 | SEFAZ transport timeout after `iniciarTransmissao` | INCERTO, row SENDING, chave already stored before the transmit call (call order asserted). Immediate `/issue`: `emAndamento` inside the lease. After the lease: **the consult is called before any transmission**. 217 at 60 s: still INCERTO, 0 transmissions. 217 at ≥ 120 s: RESERVADO, then resend in the same request with the same number and cNF, authorized 101. Focus variant: abort, then GET 404 mature, then resend with the same ref. |
| 8 | Timeout, then consult returns 100 with a matching digVal | AUTORIZADO, nfeProc built from the stored signed XML plus protNFe, **1** transmission in total, next document 102. With a mismatching digVal: BLOQUEADO. |
| 9 | `Promise.all([emit(a), emit(a)])` | One claim, one reservation, one transmission. The loser returns `emAndamento` without throwing. |
| 10 | `Promise.all([emit(u1,a), emit(u2,b)])` on the same key | 101 and 102, distinct (fake mutex), plus the PG test. |
| 11 | Two cfc in different tenants, same série and ambiente | Both start at 1, reservations isolated. |
| 12 | Séries 1 and 3 of the same cfc | Independent counters. |
| 13 | HOMOLOG 101 REJEITADO, config switched to PRODUCAO | HOMOLOG number ABANDONADO (`requerInutilizacao=false`) automatically; PROD allocates from its own counter. The reverse direction requires confirmation. |
| 14 | Focus rejects 101 (schema), config switched to SEFAZ_DIRECT; also a Focus INCERTO then switch | 101 reused through SEFAZ and authorized. A new document through Focus gets 102 with `numero:"102"`. After Focus INCERTO and a switch to SEFAZ, the retry consults **through Focus** (the attempt's provider). |
| ★ | 100 authorized (seed, counter 101). Document X fails on an invalid or missing field through: (a) SEFAZ builder throw; (b) SEFAZ 225; (c) Focus 422 schema; (d) `validate()` failure. Correct via `updateDraft` and `/calculate`, then `/issue`. New document Y. | (a–c) X authorized as **101**; (d) no number until the fixed emission, then 101. Y gets **102**. No number burned. |

**Gates.** `tsc --noEmit` multiset diff against the clean HEAD baseline (98). `next build` eslint (`prefer-const`). Existing suites unchanged and green: `nfe-emission-reuse`, `nfe-emission-company`, `nfe-emission-nfce-validate`, `nfe-sequence*`, `nfe-update-draft-guard`, `provider-contract`, `focus-nfce-path`, `sefaz/*`, `contingencia`.

### 4.24 Rollout, canary and rollback

1. **Preflight (read-only).**
   - Confirm the `cStatRejeicao` column exists.
   - Read `SEFAZ_AUTO_FALLBACK_ENABLED`, `SEFAZ_TIMEOUT_MS` and `SEFAZ_RETRY_MAX` on the VPS.
   - Run the diagnostic without `--consultar` through `DIRECT_URL` on the VPS (runbook `reference_psql_producao_via_vps`) and review adoption verdicts, floors, SENDING rows and Focus divergence with the user.
2. **Deploy the code with no V2 variables.** Smoke-test issue, cancel, CC-e, inutilização, PDV NFC-e, DANFE, XML, listing, stats and multi-CNPJ.
3. **Run the DDL** in the Supabase SQL editor. Verify `indisvalid=t` and RLS.
4. **Focus homologação checks, done by the user** on Kiko's homologação config (`cmrxiixko1spi1837uhscntiy`, série 3):
   - (a) `numero` + `serie` are honoured: chave nNF equals `numero`;
   - (b) re-POST of the same ref after `erro_autorizacao` keeps the number;
   - (c) a ref `${cuid}-n123` is accepted;
   - (d) the code returned when POSTing a number that is already authorized;
   - (e) the synchronous 201 body carries `numero`, `serie` and `chave_nfe`.
5. **Canary 1, homologação.** Set `NFE_NUMERACAO_V2_ENABLED=true`, `NFE_NUMERACAO_V2_USER_IDS=<Kiko userId>,<SEFAZ-direct homolog test tenant>`, `NFE_NUMERACAO_V2_MODELOS=55`, `NFE_NUMERACAO_V2_FOCUS_ENABLED=true` (only after step 4). Apply the env change following the VPS pm2 runbook (`reference_vps_pm2_recovery`; never `--update-env`). Run cases 1–9 by hand.
6. **Canary 2.** Add one SEFAZ-direct PRODUCAO tenant. Watch `[nfe-numeracao]` warn/error lines and NUMERADA origins for 48 h. Then widen the allowlist, then `*`.
7. **Later:** `NFE_NUMERACAO_V2_MODELOS=55,65` once PDV was checked in homologação.
8. **Rollback.** Turn the flag off (instant). V2 reservations go inert.
   - V2 REJECTED rows follow the V1 rule; 974-style codes renumber, as V1 does today.
   - V2 SENDING/INCERTO rows behave like V1 SENDING rows; the consult endpoint returns 404.
   - Caveat: a Focus note authorized under ref `${nfeId}-n…` cannot be cancelled by V1, which uses `nfeId`. Re-enable V2 or cancel through the Focus panel.
   - When re-enabled, a V1 renumbering is detected as `FLAG_ROLLBACK_V1`.
   - Drop the tables only with the flag off and an `ops_backup` copy taken.

### 4.25 Open external confirmations and findings outside this scope

**Needs confirmation (not verifiable from code):**
- The Focus behaviours in step 4 of §4.24.
- Exact meaning and context of 563/613/691/692 and 113/114 in MOC 7.0 Anexo I, and the xMotivo chave format per UF. The design never depends on this: an unparsable 539 consults every attempt.
- The NT 2024.001 reading of 302/303. The `nProt`/consult rule makes the design independent of it.
- CSRT for Focus in PR: the separate RT workstream (Kiko authorizes Focus in the UPD system).
- Whether the user wants phase-2 recycling of never-transmitted abandoned numbers.

**Found while checking, not fixed by V2 when the flag is off (report to the user):**
1. **SEFAZ direct build/sign/QR failures leave the note in SENDING forever with its number burned** (V1). This is the reported scenario on SEFAZ direct.
2. **Focus DANFEs are generated from the database's fake numero** instead of the authorized XML (V13). Already-issued Focus DANFEs in homologação likely show the wrong nNF; production has no authorized Focus notes.
3. **Focus inutilização counts `erro_autorizacao` as success and advances the counter** (V6).
4. **V1 SVC resends the same number with a new chave after timeout → 217** (V9), and the builder cannot produce valid SVC XML (V8). Keep `SEFAZ_AUTO_FALLBACK_ENABLED` off.
5. `shouldReuseNumero` ignores emitter and série (V3). It is masked today only because R1 turns every edit into DRAFT.
6. `cstat-mapper.ts:72-75` describes 218 as "já foi autorizada"; the SEFAZ meaning is "already cancelled".
7. `contingencia.service.ts:86-92` treats 287–289 (content errors) as infrastructure failures.
8. The Focus consult treats 404/403 as `processando` (V7), so Focus notes can poll forever.
9. `deleteDraft` cascades `NfeAuditLog` (`schema.prisma:2001`), so the forensic trail of abandoned numbers is lost in V1.
10. The same CNPJ can exist in two tenants (`schema.prisma:1849`), each with its own counter, and two Focus tokens are shared across tenants. Isolation risk; report only.
11. Inutilização rejects série 0 (`nfe-inutilizacao.usecase.ts:67`) and cannot handle modelo 65 (no `modelo` column, `schema.prisma:2007-2024`).

