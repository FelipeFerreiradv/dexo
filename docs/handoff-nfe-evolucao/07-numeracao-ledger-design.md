# NUMBERING V2, ledger-first design (Dexo NF-e/NFC-e)

Read-only design. Line citations point to the worktree at `C:/Users/Casa/Documents/GitHub/ghd-plataform/.claude/worktrees/receivable-stock-listing-sync-9b376d` (same code as commit 1549bc4).

> **A implementação final divergiu deste desenho:** a allowlist é por `companyFiscalConfigId` (`NFE_NUMERACAO_V2_CONFIG_IDS`, ver `app/fiscal/flags.ts`); `NFE_NUMERACAO_V2_USER_IDS`, citada adiante, nunca foi lida pelo código.
> O runbook válido é [`docs/roteiro-emissao-focus-nfe.md`](../roteiro-emissao-focus-nfe.md).

---

## 0. What V2 guarantees

| # | Guarantee | How |
|---|---|---|
| I1 | A number stays attached to its document until something consumes it. Attempts do not use up numbers. | Ledger row `(emitente, ambiente, modelo, série, número)` is bound to `nfeId`. `emit()` reads the binding from the ledger, not from `NfeEmitida.status`. |
| I2 | A reservation is separate from a consumption. | Explicit ledger states (§2). A number is consumed only in AUTORIZADO, DENEGADO, CANCELADO, INUTILIZADO or CONSUMIDO_EXTERNO. |
| I3 | Nothing is transmitted without a committed record of the attempt. | The ledger moves to `EM_TRANSMISSAO` (chave, cNF, dhEmi, tpEmis, signed XML path, Focus ref) in the same commit as `NfeEmitida` moves SIGNING→SENDING, before the network call. |
| I4 | After an unknown outcome, no number is reused blindly. | `INCERTO` blocks any resend or release until a consult comes back. "Não consta" counts only after a minimum age. |
| I5 | A number that was ever `INCERTO` never goes to another document. | `jaIncerto=true`. Releasing it produces `ORFAO`, never `LIBERADO`. |
| I6 | Allocation is atomic per `(companyFiscalConfigId, ambiente, modelo, série)`. There is no `MAX(numero)+1` and no `numero--`. | `NfeSequence … FOR UPDATE` (same primitive as today), then the pool, then the counter bump, all in one transaction with a fixed lock order. |
| I7 | Old rows are never released automatically. | Old rows are adopted only onto the same row, only with positive evidence. Otherwise the old behaviour applies (new number) and the gap is reported by a read-only diagnostic script. |
| I8 | With the flag off, behaviour is bit-identical. | One synchronous env check per entry point. No extra query, statement, payload field or route behaviour (§4). |

---

## 1. Code facts the design relies on

- **Counter.** `NfeSequenceService.reservarPorEmitente` locks one `NfeSequence` row with `FOR UPDATE`, adopting the NULL-config row only for the default emitente. It bumps and commits inside its own `prisma.$transaction` (`app/fiscal/sequence/nfe-sequence.service.ts:136-219`, SQL at 143-150, bump at 168-175). On first insert it returns 1 without re-selecting (188-202). If it cannot see the conflicting row it fails loudly (215-217). `ajustarProximoNumero` only moves forward (248-326).
- **Emit order** (`app/usecases/nfe-emission.usecase.ts`):
  - load `DRAFT|REJECTED` (93-100), config (111-126), `validate` (129)
  - claim `updateMany → VALIDATING` (140-155)
  - calc + `persistCalculo` (162-214)
  - `shouldReuseNumero` or `reservarProximoNumero` (226-254), then write row numero/ambiente/dataEmissao/cfc (262-278)
  - audit NUMERADA `{numero, serie}` (280-283), SIGNING (286), payload (295-321), `saveXmlOriginal` (325-334)
  - SENDING (337), audit ENVIADA `{providerName}` (339-341), provider (344-354), `sentToSefaz=true` (357), `emitir` with `ref: nfeId` (358-362), SEFAZ chave write (367-372)
  - SVC block (377-454), processing/poll (457-504), `erro` stays SENDING (521-536), rejection (539-546)
  - catch: `!sentToSefaz` → DRAFT + EDITADA_DRAFT `"Erro antes do envio - retornado a rascunho"` (551-556); otherwise ENVIO_INCERTO (558-561)
- **`handleAuthorized`** sets AUTHORIZED first (802) and fetches the Focus XML with `buscarXml(nfeId)` (815). **`handleRejected`** runs `forceStatus(REJECTED)` (1059) and then a separate update that also writes `cStatRejeicao` (1065-1070). That split is where R3 happens.
- **SEFAZ direct provider.**
  - `emitir` builds, signs and sends in one call (`app/fiscal/providers/sefaz-direct.provider.ts:156-303`).
  - The builder accepts `dhEmi`, `cNF`, `tpEmis` (`app/fiscal/sefaz/nfe-xml-builder-sefaz.service.ts:80-85, 96, 126-137`).
  - Duplicity codes come back as `processando` with `codigoStatus` kept (`sefaz-direct.provider.ts:898-910, 963-976`). An unreadable lote cStat becomes `erro` (983). Network or HTTP≥400 becomes `erro` with the chave (284-298).
  - `parseRetConsSitNFe` throws away the `protNFe` block (1085).
- **Focus provider.**
  - HTTP 200/201/202 always becomes `processando` (`app/fiscal/providers/focus-nfe.provider.ts:72-87`).
  - 422 becomes `rejeitada` with `codigo` as a string (89-102). Anything else becomes `erro` (104-114).
  - `consultar` has no `res.ok` check and defaults to `processando` (148-155).
  - Cancel uses `ref` (206). The use case passes `nfeId` (`app/usecases/nfe-cancelamento.usecase.ts:109-115`).
- **Chave.** `montarChave` honours an explicit `cNF` (`app/fiscal/sefaz/chave-acesso.ts:141`). `gerarCnf` is exported, and its comment says to persist and reuse the cNF so a resend keeps the same chave (77-82). `parseChave` is at 181-208. The chave has no day or time, only AAMM. So the same cNF, tpEmis and month give an identical chave.
- **cStat mapper.** Only 200–599 counts as `rejeitada` (`app/fiscal/sefaz/cstat-mapper.ts:111-117`). 218 is mislabelled as "já foi autorizada" (72-75).
- **SVC.**
  - Blind fallback also fires on 280–289 (`app/fiscal/sefaz/contingencia.service.ts:86-92`).
  - On timeout it consults first (95-101).
  - It is opt-in via `SEFAZ_AUTO_FALLBACK_ENABLED` (132-134).
  - The SEFAZ builder never writes `dhCont`/`xJust`: a grep for `dhCont` in the builder finds nothing.
- **SOAP client.** Timeout is 60s and it retries 3 times on timeout/5xx with the same envelope, so the same chave (`app/fiscal/sefaz/soap-client.service.ts:96-125, 228-238`). Worst-case emit wall time is roughly 20 minutes. This sets the leases.
- **Repository.**
  - `updateDraft` forces `status="DRAFT"` and clears only `motivoRejeicao`; `cStatRejeicao` survives (`app/repositories/nfe.repository.ts:379-381`). It is guarded by `status IN (DRAFT,REJECTED)` (413-443).
  - `findDraftById` accepts only DRAFT|REJECTED (314-326).
  - `deleteDraft` hard-deletes (479-491).
  - `createDraft` uses a negative placeholder numero (257).
  - `NfeAuditLog` and `NfeItem` cascade on delete (`prisma/schema.prisma:2001, 1986`).
- **Uniqueness.** `NfeEmitida_cfcId_ambiente_serie_numero_modelo_key … WHERE cfc NOT NULL AND numero > 0` and `NfeSequence_cfcId_ambiente_serie_modelo_key` (`docs/multi-cnpj-sql.md:77-86`).
- **Inutilização.** Creates a PENDENTE record (`app/usecases/nfe-inutilizacao.usecase.ts:106-117`), calls the provider (130-138), and advances the counter only on success, without the lock (157-183). `NfeInutilizacao` has no `modelo` column (`schema.prisma:2007-2024`).
- **Routes.** `/issue` maps unknown errors to 500 (`app/routes/fiscal.routes.ts:929-960`). DELETE draft is at 762-781. `/calculate` calls `updateDraft` (865-867). The next-number preview is at 620-674.
- **Other callers.**
  - The NFC-e PDV treats `VALIDATING|SIGNING|SENDING` as "processing" and re-emits the same DRAFT/REJECTED row (`app/usecases/finance.usecase.ts:1843-1910`).
  - The wizard sets `isEmitting` after `await saveCurrentStep()` (`app/notas-fiscais/components/nfe-wizard.tsx:457-466`).
  - The list reads a front-end flag (`app/notas-fiscais/components/nfe-list.tsx:61-64`).
  - Storage overwrites `xml-original/{nfeId}.xml` on every attempt (`app/fiscal/storage/fiscal-storage.service.ts:36-45`).
- **Test pattern.** vi.hoisted doubles plus module mocks (`tests/fiscal/nfe-emission-company.spec.ts:13-74`). `MockNfeProvider` exists (`tests/fiscal/__mocks__/mock-nfe-provider.ts`).

---

## 2. States and transitions

| State | Meaning | `nfeId` | Consumed at SEFAZ? | Terminal? |
|---|---|---|---|---|
| `RESERVADO` | Bound to a document and not in flight. Either never transmitted, or confirmed not received (`jaIncerto=true`). | required | no | no |
| `EM_TRANSMISSAO` | Committed just before the network call. | required | unknown | no |
| `INCERTO` | Transmitted, outcome unknown (timeout, network, 5xx, still processing after polls, 635). | required | unknown | no |
| `REJEITADO_REUTILIZAVEL` | The authorizer (SEFAZ or Focus) refused for good without consuming. | required | no | no |
| `AUTORIZADO` | cStat 100/150 | the authorized doc | yes | until cancelled |
| `DENEGADO` | 110/301/302/303 or 205 | last binder (history) | yes | yes |
| `CANCELADO` | Cancel event, or 218 on emission | doc | yes | yes |
| `INUTILIZADO` | Inutilização accepted, or 206 on emission | last binder or NULL | yes | yes |
| `CONSUMIDO_EXTERNO` | The number is used by another document (539/562/613 with a chave that is not ours, or an `NfeEmitida` collision). | last binder or NULL | yes | yes |
| `LIBERADO` | Unbound, never ambiguous. Eligible for the pool in the current fiscal month only. | NULL | no | no |
| `ORFAO` | Unbound, not reusable automatically (released after being INCERTO, pool expired, Focus divergence, pulled out for an inutilização). Candidate for inutilização. | NULL | unknown or no | no |

Allowed transitions live in a pure map in `app/fiscal/domain/nfe-numeracao-v2.ts`. Every SQL update is conditional on `estado = $de`.

```
(new)            → RESERVADO | REJEITADO_REUTILIZAVEL (legacy adoption) | AUTORIZADO (Focus divergence) | CONSUMIDO_EXTERNO (collision)
RESERVADO        → EM_TRANSMISSAO | LIBERADO | ORFAO
REJEITADO_REUT.  → EM_TRANSMISSAO | LIBERADO | ORFAO
EM_TRANSMISSAO   → AUTORIZADO | DENEGADO | CANCELADO | INUTILIZADO | CONSUMIDO_EXTERNO | REJEITADO_REUTILIZAVEL | INCERTO
INCERTO          → AUTORIZADO | DENEGADO | CANCELADO | INUTILIZADO | CONSUMIDO_EXTERNO | REJEITADO_REUTILIZAVEL | RESERVADO(jaIncerto) | INCERTO
RESERVADO/REJ.   → AUTORIZADO   (late authorization only: chave ∈ attempted chaves of this row; alert)
AUTORIZADO       → CANCELADO
LIBERADO         → RESERVADO (pool) | ORFAO (expired / inutilização prep) | INUTILIZADO | CONSUMIDO_EXTERNO
ORFAO            → INUTILIZADO | CONSUMIDO_EXTERNO | AUTORIZADO? no → alert only (NUMERO_AUTORIZADO_FORA_DO_VINCULO)
```

---

## 3. Data model

### 3.1 Prisma (new models only; no existing model changes)

Add to `prisma/schema.prisma` after `NfeInutilizacao` (`schema.prisma:2024`):

```prisma
// Numeração V2 (ledger-first). Uma linha por número fiscal por
// (emitente, ambiente, modelo, série) durante TODO o ciclo de vida.
// SEM FK de propósito: é fato fiscal e sobrevive à exclusão do rascunho e do
// emitente. Índices PARCIAIS vivem só no banco (prisma/ddl/2026-09-18-nfe-numero-ledger.sql)
// — NUNCA `prisma db push`.
model NfeNumeroLedger {
  id                    String    @id @default(cuid())
  userId                String
  companyFiscalConfigId String
  ambiente              String    // HOMOLOGACAO | PRODUCAO
  modelo                String    // 55 | 65
  serie                 Int
  numero                Int
  estado                String    // ver nfe-numeracao-v2.ts
  nfeId                 String?
  jaIncerto             Boolean   @default(false)
  origem                String    // SEQUENCIA | POOL | ADOCAO_LEGADO | FOCUS_DIVERGENTE | COLISAO
  provedor              String?   // FOCUS_NFE | SEFAZ_DIRECT (última transmissão)
  providerRef           String?
  tentativas            Int       @default(0)
  chaveAcesso           String?
  cNF                   String?
  dhEmi                 DateTime?
  tpEmis                Int?
  xmlAssinadoPath       String?
  cStat                 Int?
  codigoProvedor        String?
  motivo                String?
  protocolo             String?
  transmitidoEm         DateTime?
  liberadoEm            DateTime?
  consumidoEm           DateTime?
  leaseAte              DateTime?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  @@unique([companyFiscalConfigId, ambiente, modelo, serie, numero], map: "NfeNumeroLedger_cfc_amb_mod_serie_num_key")
  @@index([nfeId], map: "NfeNumeroLedger_nfeId_idx")
  @@index([userId, createdAt], map: "NfeNumeroLedger_userId_createdAt_idx")
}

model NfeNumeroLedgerEvento {
  id                    String   @id @default(cuid())
  ledgerId              String?
  userId                String
  companyFiscalConfigId String
  ambiente              String
  modelo                String
  serie                 Int
  numero                Int?
  nfeId                 String?
  de                    String?
  para                  String?
  motivo                String   // RESERVA_SEQUENCIA | RESERVA_POOL | REUSO_MESMA_NOTA | ADOCAO_LEGADO | TROCA_CHAVE | RASCUNHO_EXCLUIDO | TRANSMISSAO_INICIADA | RESULTADO | CONSULTA | POOL_EXPIRADO | COLISAO_NFE_EMITIDA | FOCUS_DIVERGENCIA | PISO_SEQUENCIA | INUTILIZACAO_PREP | INUTILIZADO | CANCELADO | VINCULO_DIVERGENTE | AUTORIZACAO_TARDIA
  detalhes              Json?    // nunca token/senha/XML/dados do destinatário
  createdAt             DateTime @default(now())

  @@index([ledgerId, createdAt], map: "NfeNumeroLedgerEvento_ledgerId_createdAt_idx")
  @@index([nfeId, createdAt], map: "NfeNumeroLedgerEvento_nfeId_createdAt_idx")
  @@index([companyFiscalConfigId, ambiente, modelo, serie, createdAt], map: "NfeNumeroLedgerEvento_chave_createdAt_idx")
  @@index([userId, createdAt], map: "NfeNumeroLedgerEvento_userId_createdAt_idx")
}
```

Explicit `map:` names are required: the Prisma default for the unique would be 70 characters, over Postgres's 63-character limit. Regenerating the client touches the shared `node_modules` of the main repo, so restore it afterwards (see the worktree gotchas in memory).

### 3.2 DDL: `prisma/ddl/2026-09-18-nfe-numero-ledger.sql`

Both tables are new and empty, so a transactional `CREATE INDEX` in the Supabase editor is fine (no `CONCURRENTLY` needed).

```sql
-- NUMERAÇÃO V2 (ledger-first) — 100% ADITIVO: 2 tabelas novas.
-- ORDEM: 1) deploy do código com NFE_NUMERACAO_V2_ENABLED ausente (nada lê/escreve)
--        2) este DDL  3) verificação  4) flag ON só para a allowlist.
-- Idempotente. Rollback no fim.
BEGIN;

CREATE TABLE IF NOT EXISTS "NfeNumeroLedger" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "companyFiscalConfigId" TEXT NOT NULL,
  "ambiente" TEXT NOT NULL,
  "modelo" TEXT NOT NULL,
  "serie" INTEGER NOT NULL,
  "numero" INTEGER NOT NULL,
  "estado" TEXT NOT NULL,
  "nfeId" TEXT,
  "jaIncerto" BOOLEAN NOT NULL DEFAULT false,
  "origem" TEXT NOT NULL,
  "provedor" TEXT,
  "providerRef" TEXT,
  "tentativas" INTEGER NOT NULL DEFAULT 0,
  "chaveAcesso" TEXT,
  "cNF" TEXT,
  "dhEmi" TIMESTAMP(3),
  "tpEmis" INTEGER,
  "xmlAssinadoPath" TEXT,
  "cStat" INTEGER,
  "codigoProvedor" TEXT,
  "motivo" TEXT,
  "protocolo" TEXT,
  "transmitidoEm" TIMESTAMP(3),
  "liberadoEm" TIMESTAMP(3),
  "consumidoEm" TIMESTAMP(3),
  "leaseAte" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NfeNumeroLedger_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "NfeNumeroLedger" DROP CONSTRAINT IF EXISTS "NfeNumeroLedger_estado_chk";
ALTER TABLE "NfeNumeroLedger" ADD CONSTRAINT "NfeNumeroLedger_estado_chk" CHECK ("estado" IN
  ('RESERVADO','EM_TRANSMISSAO','INCERTO','REJEITADO_REUTILIZAVEL','AUTORIZADO','DENEGADO',
   'CANCELADO','INUTILIZADO','CONSUMIDO_EXTERNO','LIBERADO','ORFAO'));
ALTER TABLE "NfeNumeroLedger" DROP CONSTRAINT IF EXISTS "NfeNumeroLedger_dominio_chk";
ALTER TABLE "NfeNumeroLedger" ADD CONSTRAINT "NfeNumeroLedger_dominio_chk" CHECK (
  "modelo" IN ('55','65') AND "ambiente" IN ('HOMOLOGACAO','PRODUCAO')
  AND "serie" BETWEEN 0 AND 999 AND "numero" BETWEEN 1 AND 999999999
  AND ("tpEmis" IS NULL OR "tpEmis" IN (1,6,7)));
-- vínculo coerente com o estado
ALTER TABLE "NfeNumeroLedger" DROP CONSTRAINT IF EXISTS "NfeNumeroLedger_vinculo_chk";
ALTER TABLE "NfeNumeroLedger" ADD CONSTRAINT "NfeNumeroLedger_vinculo_chk" CHECK (
  ("estado" NOT IN ('RESERVADO','EM_TRANSMISSAO','INCERTO','REJEITADO_REUTILIZAVEL') OR "nfeId" IS NOT NULL)
  AND ("estado" NOT IN ('LIBERADO','ORFAO') OR "nfeId" IS NULL)
  AND ("estado" <> 'LIBERADO' OR "jaIncerto" = false));

-- 1 linha por número (ciclo de vida inteiro). Serve de alvo p/ ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS "NfeNumeroLedger_cfc_amb_mod_serie_num_key"
  ON "NfeNumeroLedger" ("companyFiscalConfigId","ambiente","modelo","serie","numero");
-- no máximo 1 vínculo ATIVO por documento (DENEGADO fica fora: a nota pode ser reemitida)
CREATE UNIQUE INDEX IF NOT EXISTS "NfeNumeroLedger_nfeId_vinculo_ativo_key"
  ON "NfeNumeroLedger" ("nfeId")
  WHERE "nfeId" IS NOT NULL AND "estado" IN
    ('RESERVADO','EM_TRANSMISSAO','INCERTO','REJEITADO_REUTILIZAVEL','AUTORIZADO','CANCELADO');
CREATE INDEX IF NOT EXISTS "NfeNumeroLedger_pool_idx"
  ON "NfeNumeroLedger" ("companyFiscalConfigId","ambiente","modelo","serie","numero")
  WHERE "estado" = 'LIBERADO';
CREATE INDEX IF NOT EXISTS "NfeNumeroLedger_pendentes_idx"
  ON "NfeNumeroLedger" ("estado","transmitidoEm")
  WHERE "estado" IN ('EM_TRANSMISSAO','INCERTO') OR ("estado" = 'ORFAO' AND "jaIncerto");
CREATE INDEX IF NOT EXISTS "NfeNumeroLedger_nfeId_idx" ON "NfeNumeroLedger" ("nfeId");
CREATE INDEX IF NOT EXISTS "NfeNumeroLedger_userId_createdAt_idx" ON "NfeNumeroLedger" ("userId","createdAt");

CREATE TABLE IF NOT EXISTS "NfeNumeroLedgerEvento" (
  "id" TEXT NOT NULL,
  "ledgerId" TEXT,
  "userId" TEXT NOT NULL,
  "companyFiscalConfigId" TEXT NOT NULL,
  "ambiente" TEXT NOT NULL,
  "modelo" TEXT NOT NULL,
  "serie" INTEGER NOT NULL,
  "numero" INTEGER,
  "nfeId" TEXT,
  "de" TEXT,
  "para" TEXT,
  "motivo" TEXT NOT NULL,
  "detalhes" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NfeNumeroLedgerEvento_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "NfeNumeroLedgerEvento_ledgerId_createdAt_idx" ON "NfeNumeroLedgerEvento" ("ledgerId","createdAt");
CREATE INDEX IF NOT EXISTS "NfeNumeroLedgerEvento_nfeId_createdAt_idx" ON "NfeNumeroLedgerEvento" ("nfeId","createdAt");
CREATE INDEX IF NOT EXISTS "NfeNumeroLedgerEvento_chave_createdAt_idx" ON "NfeNumeroLedgerEvento" ("companyFiscalConfigId","ambiente","modelo","serie","createdAt");
CREATE INDEX IF NOT EXISTS "NfeNumeroLedgerEvento_userId_createdAt_idx" ON "NfeNumeroLedgerEvento" ("userId","createdAt");

ALTER TABLE "NfeNumeroLedger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NfeNumeroLedgerEvento" ENABLE ROW LEVEL SECURITY;
COMMIT;

-- VERIFICAÇÃO
-- SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('NfeNumeroLedger','NfeNumeroLedgerEvento') ORDER BY 1;
-- SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
--  WHERE c.relname LIKE 'NfeNumeroLedger%';            -- todos indisvalid = t
-- SELECT conname FROM pg_constraint WHERE conrelid='"NfeNumeroLedger"'::regclass;
-- SELECT relrowsecurity FROM pg_class WHERE relname IN ('NfeNumeroLedger','NfeNumeroLedgerEvento');

-- ROLLBACK (flag OFF + pm2 restart ANTES; backup primeiro):
-- CREATE SCHEMA IF NOT EXISTS ops_backup;
-- CREATE TABLE ops_backup."NfeNumeroLedger_<data>" AS TABLE "NfeNumeroLedger";
-- CREATE TABLE ops_backup."NfeNumeroLedgerEvento_<data>" AS TABLE "NfeNumeroLedgerEvento";
-- BEGIN; DROP TABLE IF EXISTS "NfeNumeroLedgerEvento"; DROP TABLE IF EXISTS "NfeNumeroLedger"; COMMIT;
```

V2 also writes `NfeEmitida.cStatRejeicao`, which already exists in production (the V1 flag is on in prod). The DDL doc should list that as a precondition check: `SELECT 1 FROM information_schema.columns WHERE table_name='NfeEmitida' AND column_name='cStatRejeicao'`.

---

## 4. Flags and what "off" means

New file `app/fiscal/domain/nfe-numeracao-v2.ts`. Everything is read at call time.

```ts
export function isNfeNumeracaoV2Enabled(userId: string, modelo: "55" | "65"): boolean {
  if (process.env.NFE_NUMERACAO_V2_ENABLED !== "true") return false;           // === "true" (".env 1×true" gotcha)
  const allow = (process.env.NFE_NUMERACAO_V2_USER_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (allow.length > 0 && !allow.includes(userId)) return false;
  const modelos = (process.env.NFE_NUMERACAO_V2_MODELOS ?? "55").split(",").map(s => s.trim());
  return modelos.includes(modelo);
}
export const naoConstaMinMs  = () => intEnv("NFE_NUMERACAO_V2_NAO_CONSTA_MIN_MS", 600_000);   // 10 min
export const leasePreEnvioMs = () => intEnv("NFE_NUMERACAO_V2_LEASE_MS", 600_000);            // VALIDATING/SIGNING
export const leaseEnvioMs    = () => intEnv("NFE_NUMERACAO_V2_TRANSMISSAO_LEASE_MS", 1_800_000); // > ~20 min SOAP worst case
export const focusTimeoutMs  = () => intEnv("FOCUS_TIMEOUT_MS", 30_000);                        // used ONLY by new V2 Focus methods
```

- Front end: `NEXT_PUBLIC_NFE_NUMERACAO_V2_ENABLED` (inlined at build). It gates only the wizard's `isEmitting` ordering and the new list action.
- Optional sweeper: `NFE_NUMERACAO_V2_RECONCILIADOR_ENABLED`, off by default (§9.2).

**When V2 is off** (env not `"true"`, or user/modelo not allowlisted):
1. `emit()` does one synchronous check before `findDraftById` and then runs the current code untouched. No extra query.
2. `NfeXmlBuilderService.build(draft, config, numero)` is called with 3 arguments, so the 4th optional argument is `undefined` and the payload is identical (`numero_nota` stays, no `numero`).
3. `SefazDirectProvider.emitir`, `FocusNfeProvider.emitir/consultar/buscarXml/cancelar/inutilizar` are unchanged. V2 adds new methods only.
4. `nfe-draft.usecase.delete`, `nfe-inutilizacao.usecase.inutilizar`, `nfe-cancelamento.usecase.cancel`, `NfeRepository.findEmitted` and `/nfe/proximo-numero` each have one synchronous check at the top and otherwise run current code.
5. `/issue` status mapping is unchanged. The new `instanceof NumeracaoError` branch is only reachable from V2 code.
6. New route `POST /fiscal/nfe/:id/reconsultar` answers 404 `{error:"Recurso indisponível"}`. Existing routes are untouched.
7. The Prisma client has 2 more models that nobody queries. No DDL is needed to run flag-off code.
8. `cstat-mapper.ts`, `nfe-number-reuse.ts`, `contingencia.service.ts` and `nfe-sequence.service.ts` are not modified. V2 has its own classifier and its own lock primitive, duplicated on purpose. A test checks both primitives produce the same numbers on the same fixtures.

---

## 5. Reservation

### 5.1 Lock order (every V2 path that changes allocation)

`NfeSequence` rows (every key involved, sorted by `cfc, ambiente, modelo, serie`) → `NfeNumeroLedger` rows → `NfeEmitida` row.

Transitions that don't change pool membership (for example EM_TRANSMISSAO→INCERTO, or →REJEITADO) lock ledger → NfeEmitida only, which keeps the same partial order. Existing single-row writers (`updateDraft`, the emission claim) hold only the NfeEmitida lock, so no cycle is possible.

Transactions use `prisma.$transaction(fn, { maxWait: 5000, timeout: 15000 })` and stay short, with no network I/O inside (pooler incident).

### 5.2 Lock primitive: `lockSequencia`

Same semantics as V1 (`nfe-sequence.service.ts:143-217`), but it does not bump.

```ts
async function lockSequencia(tx, userId, k /* {cfc, ambiente, modelo, serie} */, isDefault): Promise<{id, proximoNumero}> {
  const sel = `SELECT "id","proximoNumero","companyFiscalConfigId" FROM "NfeSequence"
     WHERE "userId"=$1 AND "ambiente"=$2 AND "serie"=$3 AND "modelo"=$4
       AND ("companyFiscalConfigId"=$5 OR ($6 AND "companyFiscalConfigId" IS NULL))
     ORDER BY ("companyFiscalConfigId" IS NULL) ASC LIMIT 1 FOR UPDATE`;
  let r = (await tx.$queryRawUnsafe(sel, userId, k.ambiente, k.serie, k.modelo, k.cfc, isDefault))[0];
  if (!r) {
    await tx.$queryRawUnsafe(`INSERT INTO "NfeSequence" ("id","userId","ambiente","serie","modelo","proximoNumero","companyFiscalConfigId","updatedAt")
       VALUES (gen_random_uuid()::text,$1,$2,$3,$4,1,$5,NOW()) ON CONFLICT DO NOTHING`, userId, k.ambiente, k.serie, k.modelo, k.cfc);
    r = (await tx.$queryRawUnsafe(sel, userId, k.ambiente, k.serie, k.modelo, k.cfc, isDefault))[0];
    if (!r) throw new Error("Não foi possível reservar número para o emitente — contate o suporte");
  }
  if (r.companyFiscalConfigId == null)   // adoção idempotente, igual V1 :168-175
    await tx.$queryRawUnsafe(`UPDATE "NfeSequence" SET "companyFiscalConfigId"=$1,"updatedAt"=NOW() WHERE "id"=$2`, k.cfc, r.id);
  return { id: r.id, proximoNumero: r.proximoNumero };
}
```

### 5.3 `NfeNumeracaoV2Service.reservar`

```ts
// pre-tx (sem lock): auditLegado = nfeAuditLog.findMany({ where:{nfeId}, orderBy:{createdAt:"asc"}, select:{evento,detalhes,createdAt} })
//   — só se row.numero > 0 e não há ledger ativo (raro)
async reservar(c: { userId, nfeId, cfg, isDefault, ambiente, modelo, serie, row, auditLegado }): Promise<Reserva> {
  const key = { cfc: c.cfg.id, ambiente: c.ambiente, modelo: c.modelo, serie: c.serie };
  return prisma.$transaction(async (tx) => {
    const ATIVOS = `('RESERVADO','EM_TRANSMISSAO','INCERTO','REJEITADO_REUTILIZAVEL','AUTORIZADO','CANCELADO')`;
    const vig0 = first(await tx.$queryRawUnsafe(
      `SELECT "id","companyFiscalConfigId" cfc,"ambiente","modelo","serie" FROM "NfeNumeroLedger" WHERE "nfeId"=$1 AND "estado" IN ${ATIVOS}`, c.nfeId));

    // 1) sequências em ordem determinística (chave atual + chave antiga, se trocou)
    const keys = sortKeys(uniq([key, vig0 && keyOf(vig0)]));
    const seq: Record<string, {id, proximoNumero}> = {};
    for (const k of keys) seq[ks(k)] = await lockSequencia(tx, c.userId, k, isDefaultFor(k, c));

    // 2) vínculo ativo, travado
    let vig = first(await tx.$queryRawUnsafe(`SELECT * FROM "NfeNumeroLedger" WHERE "nfeId"=$1 AND "estado" IN ${ATIVOS} FOR UPDATE`, c.nfeId));
    if ((vig?.id ?? null) !== (vig0?.id ?? null)) throw new NumeracaoError("CONCORRENCIA", 409, "Tente novamente");

    // 3) guardas
    if (vig && ["EM_TRANSMISSAO", "INCERTO"].includes(vig.estado))
      throw new NumeracaoError("INCERTO", 409, `Envio anterior do nº ${vig.numero} sem confirmação — use "Consultar situação"`);
    if (vig && ["AUTORIZADO", "CANCELADO"].includes(vig.estado)) throw new NumeracaoError("JA_AUTORIZADA", 409, "NF-e já autorizada");

    // 4) vínculo divergente (flag foi desligada e V1 renumerou a linha)
    if (vig && sameKey(vig, rowKey(c.row)) && c.row.numero > 0 && c.row.numero !== vig.numero) {
      await transicionar(tx, vig, "ORFAO", { nfeId: null, motivo: "VINCULO_DIVERGENTE", detalhes: { numeroLinha: c.row.numero } });
      vig = null;
    }

    // 5) REUSO — mesma nota, mesma chave (independe de status DRAFT/REJECTED ⇒ R1 resolvido)
    if (vig && sameKey(vig, key)) {
      await evento(tx, vig, "REUSO_MESMA_NOTA", { estado: vig.estado, tentativas: vig.tentativas });
      await gravarNumeroNaLinha(tx, c, vig.numero, key);
      return reservaDe(vig, { reuso: true });
    }

    // 6) TROCA de emitente/série/ambiente: devolve o número antigo
    if (vig) {                                   // estado ∈ RESERVADO | REJEITADO_REUTILIZAVEL
      await transicionar(tx, vig, vig.jaIncerto ? "ORFAO" : "LIBERADO",
        { nfeId: null, liberadoEm: now(), limparTentativa: true, motivo: "TROCA_CHAVE", detalhes: { novaChave: key } });
    }

    // 7) adoção conservadora de legado (mesma linha, mesma chave)
    if (!vig && c.row.numero > 0 && sameKey(rowKey(c.row), key)) {
      const jaNoLedger = first(await tx.$queryRawUnsafe(`SELECT "id" FROM "NfeNumeroLedger" WHERE ${KEY_WHERE} AND "numero"=$5 FOR UPDATE`, ...kv(key), c.row.numero));
      const d = decidirAdocaoLegado({ row: c.row, audit: c.auditLegado, proximoNumero: seq[ks(key)].proximoNumero, jaNoLedger: !!jaNoLedger });
      if (d.adotar) {
        const ins = await inserirLedger(tx, { ...key, userId: c.userId, numero: c.row.numero, estado: d.estado,
          nfeId: c.nfeId, origem: "ADOCAO_LEGADO", providerRef: c.nfeId, cStat: c.row.cStatRejeicao ?? null });
        if (ins) { await gravarNumeroNaLinha(tx, c, c.row.numero, key); return reservaDe(ins, { reuso: true, adotado: true }); }
      } else log("nfe.numeracao.legado_nao_adotado", { nfeId: c.nfeId, numero: c.row.numero, motivo: d.motivo });
    }

    // 8) piso da sequência na 1ª alocação V2 da chave (§5.5)
    if (!(await existeLedgerDaChave(tx, key))) await aplicarPiso(tx, seq[ks(key)], key, c);

    // 9) anti-loop por chave
    if (await ultimasAlocacoesTodasConsumidasExternas(tx, key, 3))
      throw new NumeracaoError("SEQUENCIA_ATRAS_DA_SEFAZ", 409,
        "Os 3 últimos números desta série já existiam na SEFAZ — revise o próximo número antes de emitir");

    const inutPendentes = await faixasInutilizacaoPendentes(tx, c.userId, key);   // NfeInutilizacao PENDENTE < 15 min

    // 10) POOL
    for (let i = 0; i < 20; i++) {
      const cand = first(await tx.$queryRawUnsafe(
        `SELECT * FROM "NfeNumeroLedger" WHERE ${KEY_WHERE} AND "estado"='LIBERADO' ORDER BY "numero" ASC LIMIT 1 FOR UPDATE`, ...kv(key)));
      if (!cand) break;
      if (cand.liberadoEm < inicioMesFiscal(now())) { await transicionar(tx, cand, "ORFAO", { motivo: "POOL_EXPIRADO" }); continue; }
      if (cobre(inutPendentes, cand.numero)) throw new NumeracaoError("INUTILIZACAO_EM_ANDAMENTO", 409, "Inutilização em andamento nesta série — tente em 1 minuto");
      const uso = await numeroUsadoEmNfeEmitida(tx, c.userId, key, cand.numero, isDefaultFor(key, c));
      if (uso) { await transicionar(tx, cand, "CONSUMIDO_EXTERNO", { motivo: "COLISAO_NFE_EMITIDA", detalhes: { nfeIdExistente: uso.id, status: uso.status } }); continue; }
      const r = await transicionar(tx, cand, "RESERVADO", { nfeId: c.nfeId, origem: "POOL", tentativas: 0, limparTentativa: true,
        providerRef: providerRefPara(c.nfeId, cand.numero, await primeiroNumeroDaNota(tx, c.nfeId)), motivo: "RESERVA_POOL" });
      await gravarNumeroNaLinha(tx, c, cand.numero, key);
      return reservaDe(r, { reuso: false });
    }

    // 11) SEQUÊNCIA (atômica; só avança)
    const s = seq[ks(key)];
    for (let i = 0; i < 20; i++) {
      const n = s.proximoNumero;
      if (cobre(inutPendentes, n)) throw new NumeracaoError("INUTILIZACAO_EM_ANDAMENTO", 409, "...");
      await tx.$queryRawUnsafe(`UPDATE "NfeSequence" SET "proximoNumero"=$1,"updatedAt"=NOW() WHERE "id"=$2`, n + 1, s.id);
      s.proximoNumero = n + 1;
      const uso = await numeroUsadoEmNfeEmitida(tx, c.userId, key, n, isDefaultFor(key, c));
      if (uso) { await inserirLedger(tx, { ...key, userId: c.userId, numero: n, estado: "CONSUMIDO_EXTERNO", origem: "COLISAO",
                   motivo: "COLISAO_NFE_EMITIDA", detalhes: { nfeIdExistente: uso.id, status: uso.status } }); continue; }
      const r = await inserirLedger(tx, { ...key, userId: c.userId, numero: n, estado: "RESERVADO", nfeId: c.nfeId, origem: "SEQUENCIA",
                   providerRef: providerRefPara(c.nfeId, n, await primeiroNumeroDaNota(tx, c.nfeId)), motivo: "RESERVA_SEQUENCIA" });
      if (!r) { log.warn("nfe.numeracao.inconsistencia", { tipo: "LEDGER_A_FRENTE_DA_SEQUENCIA", key, n });
                throw new NumeracaoError("LEDGER_A_FRENTE", 500, "Inconsistência de numeração — contate o suporte"); }
      await gravarNumeroNaLinha(tx, c, n, key);
      return reservaDe(r, { reuso: false });
    }
    throw new NumeracaoError("COLISOES_EXCESSIVAS", 409, "20 números seguidos já usados — revise a numeração");
  }, { maxWait: 5000, timeout: 15000 });
}
```

Helper details:
- `inserirLedger` is `INSERT … ON CONFLICT ("companyFiscalConfigId","ambiente","modelo","serie","numero") DO NOTHING RETURNING *`, plus an event row.
- `gravarNumeroNaLinha` is `tx.nfeEmitida.update({ where:{id}, data:{ numero, ambiente, dataEmissao:new Date(), companyFiscalConfigId: cfg.id, emitenteJson: snapshot, chaveAcesso: null } })`: the same fields as `nfe-emission.usecase.ts:262-278`, with the chave always cleared. A P2002 rolls the whole transaction back, so nothing is consumed and the ledger is unchanged.
- `numeroUsadoEmNfeEmitida` is `SELECT "id","status" FROM "NfeEmitida" WHERE "ambiente"=$ AND "serie"=$ AND "modelo"=$ AND "numero"=$ AND ("companyFiscalConfigId"=$cfc OR ($isDefault AND "companyFiscalConfigId" IS NULL AND "userId"=$u)) AND "id"<>$nfeId LIMIT 1`.
- `providerRefPara(nfeId, numero, primeiro)` returns `nfeId` when this is the first number ever bound to the document, otherwise `${nfeId}-n${numero}`. Details in §6.3.

### 5.4 Legacy adoption: `decidirAdocaoLegado` (pure)

Inputs: the row (status, numero, cStatRejeicao), audit events, `proximoNumero`, `jaNoLedger`.

- `jaNoLedger`: no, reason `NUMERO_JA_NO_LEDGER`.
- `row.status ∉ {DRAFT, REJECTED}` or `row.numero >= proximoNumero`: no.
- Take `T` = the audit events after the last `NUMERADA` whose `detalhes.numero == row.numero` (event written at `nfe-emission.usecase.ts:280-283`). No such event: no, `SEM_TRILHA`.
- `T` contains any of ENVIO_INCERTO, AUTORIZADA, CONTINGENCIA_SVC, CONTINGENCIA_CONSULTA, CONTINGENCIA_ADIADA, CONTINGENCIA_OK or CONTINGENCIA_FALHOU: no, `TRILHA_INCERTA`. This covers every R3 row: they have ENVIO_INCERTO written by the catch at 558 and `cStatRejeicao` NULL.
- **Evidence A (never transmitted):** `T` has `EDITADA_DRAFT` with `detalhes.motivo` starting "Erro antes do envio" (556) and no `REJEITADA`. Adopt as `RESERVADO`.
- **Evidence B (definitive SEFAZ rejection):** `T` has `ENVIADA{providerName:"SEFAZ_DIRECT"}` (339-341) and `REJEITADA`, and `classificarCStatSefaz(row.cStatRejeicao).estado === "REJEITADO_REUTILIZAVEL"`. `cStatRejeicao` survives the `updateDraft` DRAFT flip (379-381). Adopt as `REJEITADO_REUTILIZAVEL`.
- `ENVIADA.providerName` of FOCUS_NFE or null: no, `FOCUS_LEGADO_NUMERACAO_NAO_CONFIAVEL`. The database numero is not the real nNF because `numero_nota` is ignored.
- Otherwise: no, `SEM_EVIDENCIA`. The V1 behaviour applies (new number); the old number is only reported.

Old SENDING rows are never adopted.

### 5.5 Sequence floor (once per key, only moves forward)

On the first V2 allocation for a key, while the `NfeSequence` lock is held:

```sql
SELECT GREATEST(
  COALESCE((SELECT MAX(CASE WHEN length(regexp_replace("chaveAcesso",'[^0-9]','','g'))=44
                 AND substr(regexp_replace("chaveAcesso",'[^0-9]','','g'),21,2)=$modelo
                 AND substr(regexp_replace("chaveAcesso",'[^0-9]','','g'),23,3)::int=$serie
            THEN substr(regexp_replace("chaveAcesso",'[^0-9]','','g'),26,9)::int
            WHEN "chaveAcesso" IS NULL AND "status" IN ('AUTHORIZED','CANCELLED','INUTILIZED') THEN "numero" END)
     FROM "NfeEmitida" WHERE <key rows incl. legacy NULL cfc for default> AND "status" IN ('AUTHORIZED','CANCELLED','INUTILIZED','SENDING')),0),
  COALESCE((SELECT MAX("numeroFinal") FROM "NfeInutilizacao" WHERE <cfc or legacy> AND "ambiente"=$a AND "serie"=$s AND "status"='ACEITA' AND $modelo='55'),0)) AS piso
```

If `piso >= proximoNumero`, set `proximoNumero = piso+1` and write a `PISO_SEQUENCIA{de,para}` event.

This raises the counter floor from evidence of numbers actually used at SEFAZ, mainly Focus tenants whose authorized chaves show nNF 3/4/5 while the database says 12/13/14. It never allocates from a MAX. The `[^0-9]` regex follows the POSIX-class gotcha in memory.

### 5.6 Pool rules

A new document can take a `LIBERADO` number only when all of these hold:
- It was released in the current fiscal month (America/Sao_Paulo, fixed -03:00, same basis as `brazilParts` at `nfe-xml-builder-sefaz.service.ts:929`). Anything older is demoted to `ORFAO` lazily.
- It was never INCERTO (enforced by a check constraint).
- It is not covered by a PENDENTE inutilização less than 15 minutes old.
- No `NfeEmitida` row holds it.

The lowest number goes first. Releases happen only on draft delete or key change, from RESERVADO or REJEITADO_REUTILIZAVEL. Neither state is stored at SEFAZ, so a new document with a new cNF can use the number.

---

## 6. `emit()` in V2, step by step

Entry in `nfe-emission.usecase.ts:91`:

```ts
async emit(userId, nfeId) {
  if (process.env.NFE_NUMERACAO_V2_ENABLED === "true") {           // barato; off ⇒ pula tudo
    const pre = await prisma.nfeEmitida.findFirst({ where:{id:nfeId,userId}, select:{ status:true, modelo:true, updatedAt:true } });
    if (pre && isNfeNumeracaoV2Enabled(userId, pre.modelo === "65" ? "65" : "55")) return this.emitV2(userId, nfeId, pre);
  }
  /* código atual, intocado */
}
```

### 6.1 `emitV2`

0. **Idempotency and stuck rows** (read the active ledger binding for `nfeId`):
   - `pre.status === "AUTHORIZED"`: return the stored result (`success:true`) instead of throwing. This makes front-end retries safe.
   - `pre.status === "SENDING"` with ledger `INCERTO`/`EM_TRANSMISSAO`: return a pending result, "Envio sem confirmação — use Consultar situação". No transmission.
   - `pre.status ∈ {VALIDATING, SIGNING}` and `updatedAt < now − leasePreEnvioMs()` and there is a V2 ledger binding in RESERVADO or REJEITADO_REUTILIZAVEL: `updateMany({where:{id, userId, status:{in:["VALIDATING","SIGNING"]}, updatedAt:{lt:cutoff}}, data:{status:"DRAFT"}})`, audit `RECUPERADA_TRAVADA`, continue. Rows without a V2 binding are not touched (decision 3).
   - `SIGNING` can never coexist with EM_TRANSMISSAO: SENDING and EM_TRANSMISSAO are written in one transaction (step 10).
1. `findDraftById`, the same status guard, and a modelo check. Same as lines 93-104.
2. Config, same as 111-126. 3. `validate`, same as 129. No number exists yet.
4. **Claim**, same `updateMany` as 147-150 with data `{status:"VALIDATING", motivoRejeicao:null, cStatRejeicao:null}`. The loser gets `NumeracaoError("EM_ANDAMENTO", 409, "NF-e ja esta em processamento de emissao ou ja foi emitida")` with the same text.
5. Calc and `persistCalculo`, same as 162-214.
6. **Reserve** (§5.3), with `fase = "RESERVADO"`. Audit `NUMERADA{numero, serie, origem, ledgerId}`, plus `NUMERO_REUTILIZADO{numero}` when it is a reuse. Log `nfe.numeracao.reservado`.
7. `transitionStatus(VALIDATING→SIGNING)`, then `nfeWithNumero = loadNfe(nfeId)`.
8. **Prepare, with no network call:**
   - **SEFAZ direct:**
     - `provider = await createNfeProviderFromConfig({...ambiente: ledger.ambiente...})`. The certificate now loads before the payload. A failure here is a local error; the number stays bound.
     - `cNF = reserva.cNF ?? gerarCnf(numero)`. The cNF is kept for the number, so a same-month resend gives the same chave.
     - `dhEmi = new Date()`, `tpEmis = 1`.
     - `prepared = provider.prepararEmissao({ draft, config, numero, cNF, dhEmi, tpEmis })` returns `{ signedXml, chaveAcesso, cNF, dhEmi, tpEmis, modelo }`.
     - `xmlAssinadoPath = storage.saveXmlAssinado(userId, nfeId, \`${numero}-t${reserva.tentativas+1}\`, prepared.signedXml)`.
     - Save the xmlOriginal JSON snapshot exactly as in 307-316 and 325-334.
   - **Focus:**
     - `payload = xmlBuilder.build(nfeWithNumero, config, numero, { numeracaoDexo: true })`. This sets `payload.numero = String(numero)` and `payload.serie = String(serie)` and deletes `numero_nota`.
     - Save xmlOriginal as in 320-334.
     - `provider = createNfeProvider(config.providerName, ambiente, { modelo })`.
9. `fase` is still RESERVADO, so any throw up to here is a local error.
10. **One transaction, `iniciarTransmissao`:**
    - Lock the ledger row by id and require `estado ∈ {RESERVADO, REJEITADO_REUTILIZAVEL}`.
    - Update it to `EM_TRANSMISSAO`, `tentativas+1`, `transmitidoEm=now`, `leaseAte=now+leaseEnvioMs()`, `provedor`, `providerRef`, `chaveAcesso`, `cNF`, `dhEmi`, `tpEmis`, `xmlAssinadoPath`, clearing `cStat/codigoProvedor/motivo`.
    - Write event `TRANSMISSAO_INICIADA{tentativa, chaveAcesso, cNF, dhEmi, tpEmis, xmlAssinadoPath, provedor, providerRef}`. This event history is how a 539 is later recognised as "one of our chaves".
    - `UPDATE "NfeEmitida" SET status='SENDING', "chaveAcesso"=$chave (SEFAZ only), "dataEmissao"=$dhEmi WHERE id=$1 AND status='SIGNING'`. A count of 0 throws and rolls back.
    - After commit: `fase="EM_TRANSMISSAO"`, audit `ENVIADA{providerName, numero, tentativa}` as in 339.
11. `sentToSefaz = true`. Transmit:
    - SEFAZ: `raw = provider.transmitirPreparada(prepared, nfeId)`.
    - Focus: `raw = provider.emitirDetalhado({ nfeData: payload, token, ref: reserva.providerRef })`.
12. `k = classificarEnvio(raw)` (§7).
13. Follow-ups, capped at 1 consult plus 3 polls, with no renumbering inside a call:
    - `k.acao === "CONSULTAR"`: consult by `k.chaveAlvo ?? prepared.chaveAcesso` (SEFAZ `consultarDetalhado`) or by ref (Focus `consultarDetalhado`). `k = classificarConsulta(c, { idadeMs: 0 })`. "Não consta" is never trusted here, so it stays INCERTO.
    - `k.acao === "POLL"`: 3 rounds × 3s, same cadence as 461-468, using the detailed consults. Unresolved means INCERTO.
    - SVC: see §10.6.
14. `estado = await numeracao.aplicarResultado(ctx, k)` (§8).
15. Dispatch:
    - `AUTORIZADO`: `handleAuthorized(nfeId, userId, numeroReal, serieReal, chave, protocolo, data, provider, config, xmlInline, { ref })`. The new optional last argument only changes `buscarXml(ref)` at 815; with it absent the call is identical. For SEFAZ `xmlInline` is `raw.xmlAutorizado`. When authorization came through a consult, `xmlInline = buildNfeProc(readFile(xmlAssinadoPath), protNFeBlock)`, which avoids `XML_AUTORIZADO_PENDENTE`.
    - `REJEITADO_REUTILIZAVEL`: `{success:false, status:"REJECTED", numero, serie, mensagem: \`${motivo} — nº ${numero} mantido para a correção\`}`.
    - `DENEGADO | INUTILIZADO | CONSUMIDO_EXTERNO | CANCELADO`: `REJECTED`, with message "… nº N consumido; a próxima emissão desta nota usará outro número".
    - `INCERTO`: `pendingResult(…, "Envio sem confirmação — nº N reservado para esta nota; use Consultar situação")`.
16. **catch:**
    - `fase !== "EM_TRANSMISSAO"`: `forceStatus(DRAFT)` and audit EDITADA_DRAFT, same as 551-556. The ledger is untouched (RESERVADO or REJEITADO_REUTILIZAVEL), so the retry reuses the number. Log `nfe.numeracao.falha_local`.
    - Otherwise: best-effort `safeLedger(() => marcarIncerto(ledgerId, erro))` and audit ENVIO_INCERTO as in 558-561. The row stays SENDING.
    - Rethrow in both cases.

All ledger writes after transmission go through `safeLedger`, which catches, logs `nfe.numeracao.ledger_escrita_falhou` and never throws. Recovery is guaranteed because EM_TRANSMISSAO was committed first.

### 6.2 New provider methods (additive; existing methods byte-unchanged)

- `SefazDirectProvider.prepararEmissao(p: SefazEmitPayload & { cNF: string; dhEmi: Date; tpEmis: 1|6|7 })`: steps 1, 2 and 2b of `emitir` (188-251). It throws `Error` instead of returning `makeEmitErrorResult`, because every failure here is local. It takes an optional `respTec` override, which is the hook for the per-company RT resolver; the default is `resolveRespTecFromEnv()` as today (197).
- `SefazDirectProvider.transmitirPreparada(prep, ref, opts?: { contingencia? })`: steps 3-5 (254-302) with the same `parseRetEnviNFe`.
- `SefazDirectProvider.consultarDetalhado(chave)`: same SOAP call as `consultar` (305-366), but a new parser returns `{ status, cStat, xMotivo, nProt, dhRecbto, chNFe, digVal, protNFeXml }`. The raw `protNFe` block is kept for building nfeProc.
- `FocusNfeProvider.emitirDetalhado(input)` and `consultarDetalhado(ref, token)` (both `nfe` and `nfce` paths):
  - `AbortController` timeout `focusTimeoutMs()`.
  - Return `{ httpStatus, rede: null | "TIMEOUT" | "FALHA", jsonValido, corpo: { status, status_sefaz, mensagem_sefaz, codigo, mensagem, chave_nfe, numero, serie, protocolo, data_evento, erros } }`. Only those whitelisted fields; the token never appears in results or logs.
  - A 401 answer is `text/html`, so parse inside try/catch.
- `FiscalStorageService.saveXmlAssinado(userId, nfeId, sufixo, xml)` writes `xml-assinado/{nfeId}-{sufixo}.xml`.

### 6.3 Focus ref

- `ref = nfeId` for the first number ever bound to the document. That matches old rows, `cancelar(ref: nfeId)` (`nfe-cancelamento.usecase.ts:110`) and `buscarXml(nfeId)` (815).
- Any later, different number for the same document gets `ref = ${nfeId}-n${numero}`. A ref is then never re-POSTed with a different numero, so there is no dependence on unconfirmed Focus behaviour.
- Retrying the same number re-POSTs the same ref, which Focus documents as allowed after `erro_autorizacao`.
- The ref is stored in `ledger.providerRef`. V2 cancellation and XML fetch read the ref from the ledger row in AUTORIZADO, falling back to `nfeId`.

### 6.4 Focus write-back (`aplicarResultado`, AUTORIZADO from Focus)

1. `p = parseChave(corpo.chave_nfe.replace(/\D/g,""))`. Checks: `p.CNPJ === onlyDigits(config.cnpj)`, `p.mod === modelo`, else alert `NUMERACAO_FOCUS_INCONSISTENTE`. No CNPJ is hardcoded.
2. If `(Number(p.nNF), Number(p.serie)) === (ledger.numero, ledger.serie)`: normal authorization.
3. Otherwise, in one transaction, locking the sequence(s) for both keys in order, then the ledger rows, then the NfeEmitida rows:
   - Our ledger N goes to `ORFAO` (nfeId NULL, `jaIncerto=true`, event `FOCUS_DIVERGENCIA{nNFReal, serieReal}`). We cannot know whether Focus ever transmitted N.
   - Real ledger M in key′: if missing, insert `AUTORIZADO` with origem `FOCUS_DIVERGENTE`. If it exists and is bound to another document in RESERVADO or REJEITADO_REUTILIZAVEL, set the other row's `numero = -abs(numero)` (audit `NUMERO_REMOVIDO_CONFLITO` on that row) and rebind M to us as `AUTORIZADO`. If it is already consumed, alert `NUMERACAO_DUPLICADA_FOCUS` and do not rebind.
   - If `M >= proximoNumero(key′)`, set the counter to `M+1` (forward only).
   - Update our row: `numero=M, serie=S′`, AUTHORIZED, chave (44 digits, "NFe" prefix removed), protocol.
   - Write NfeAuditLog `NUMERACAO_DIVERGENTE_FOCUS{reservado:N, real:M}`.

---

## 7. Outcome classification

Pure functions `classificarEnvio` and `classificarConsulta` in `nfe-numeracao-v2.ts`. `normalizarCStat(v)` returns an integer when `/^\d{3}$/` matches after `String(v).trim()`, else `null`; the raw text goes to `codigoProvedor`. That fixes R3.

"Next emit of this row" says what happens to the number on the next emission of the same document.

### 7.1 Local, before EM_TRANSMISSAO

| Cause | Ledger | NfeEmitida | Next emit of this row |
|---|---|---|---|
| `validate` fails (before claim) | none | unchanged | no number involved |
| cert load, build, sign, storage, P2002, DB error | stays RESERVADO or REJEITADO_REUTILIZAVEL | DRAFT (catch, as today) | **same number** (R5 fixed) |
| `iniciarTransmissao` transaction fails | unchanged (rolled back) | DRAFT | same number |

### 7.2 SEFAZ direct (from `transmitirPreparada` or a consult)

| Return | Ledger | NfeEmitida | Next emit of this row |
|---|---|---|---|
| 100, 150 | AUTORIZADO | AUTHORIZED | n/a |
| 110, 301, 302, 303, or xMotivo `/^uso denegado/i` (xMotivo `/^rejei/i` wins and gets logged as ambiguous) | DENEGADO | REJECTED (cStat) | new number; delete blocked |
| 204 (same chave already in the database) | consult by our chave: 100 → AUTORIZADO; 110/301-303 → DENEGADO; otherwise INCERTO | per result | per result |
| 205 | consult → DENEGADO (protocol best-effort) | REJECTED | new number |
| 206 | INUTILIZADO (alert: external inutilização of a bound number) | REJECTED | new number |
| 218 | CANCELADO (alert) | REJECTED (cStat 218) | new number |
| 539, 562, 613 | take `chNFe` from xMotivo (`/chNFe:\s*(\d{44})/i`). If it is one of our TRANSMISSAO_INICIADA chaves, consult that chave (100 → AUTORIZADO using that attempt's stored XML; denied → DENEGADO; otherwise INCERTO). If not ours: CONSUMIDO_EXTERNO | REJECTED | new number; loop guard §10.7 |
| 635 | INCERTO (never renumbered) | SENDING | blocked until a consult |
| 103, 104 without protNFe, 105 | POLL, then INCERTO if unresolved | SENDING | blocked until a consult |
| 108, 109 | REJEITADO_REUTILIZAVEL (lote not processed) | REJECTED | same number |
| any other code 200–999 (225, 228, 656, 704, 781, 974, 999, 280–289 cert…) | REJEITADO_REUTILIZAVEL | REJECTED | **same number** (R2 fixed) |
| lote cStat unreadable, HTTP ≥400, network error, timeout | CONSULTAR once (autorizada → AUTORIZADO), otherwise INCERTO | SENDING | blocked until a consult |

**Consult (`consultarDetalhado`):**
- 100/150 → AUTORIZADO (check `chNFe` equals the target).
- 110/301-303 → DENEGADO.
- 101/151/155 → CANCELADO.
- 217 → if `idadeMs ≥ naoConstaMinMs()` **and** the transmission lease has expired: RESERVADO with `jaIncerto=true`, row REJECTED, motivo "Não recebida pela SEFAZ — pode reenviar; o número N continua desta nota". Otherwise INCERTO.
- 105 or network → INCERTO.

### 7.3 Focus

| Return | Ledger | NfeEmitida | Next emit of this row |
|---|---|---|---|
| POST 200/201 with `status:"autorizado"` | AUTORIZADO plus write-back §6.4 | AUTHORIZED | n/a |
| POST 201/202 `processando_autorizacao` (or no status) | POLL via GET, then INCERTO | SENDING | blocked until a consult |
| POST 400 (`requisicao_invalida`, `empresa_nao_habilitada`), 401, 403 `permissao_negada`, 404, 415, 429 | REJEITADO_REUTILIZAVEL, `codigoProvedor = codigo ?? "HTTP_<n>"` | REJECTED (cStat NULL) | **same number, same ref** (R4 fixed) |
| POST 422 `erro_validacao_schema` | REJEITADO_REUTILIZAVEL | REJECTED | same number |
| POST 422 `pending_operation`, `em_processamento` | INCERTO | SENDING | blocked until a consult |
| POST 422 `already_processed`, `nfe_autorizada` | CONSULTAR_REF, then per GET | per GET | per GET |
| POST 422 with `status_sefaz` | SEFAZ table on the normalized code | per table | per table |
| POST 5xx, timeout, network, invalid JSON | CONSULTAR_REF once, otherwise INCERTO | SENDING | blocked until a consult |
| GET `autorizado` | AUTORIZADO plus write-back | AUTHORIZED | n/a |
| GET `cancelado` | CANCELADO | REJECTED plus alert (odd case) | new number |
| GET `denegado` | DENEGADO | REJECTED | new number |
| GET `erro_autorizacao` | SEFAZ table on normalized `status_sefaz`; unknown or non-numeric → REJEITADO_REUTILIZAVEL | REJECTED | per table |
| GET 404 `nao_encontrado` | age ≥ min and lease expired → RESERVADO (`jaIncerto`); otherwise INCERTO | REJECTED or SENDING | same number (same ref) |
| GET 401, 403, 5xx, network | INCERTO | SENDING | blocked |

---

## 8. Outcome handler

```ts
async aplicarResultado(ctx: { ledgerId, nfeId, userId, config, modelo }, k: Classificacao): Promise<Estado> {
  return safeOrThrow(ctx.fase, () => prisma.$transaction(async (tx) => {
    const led = first(await tx.$queryRawUnsafe(`SELECT * FROM "NfeNumeroLedger" WHERE "id"=$1 FOR UPDATE`, ctx.ledgerId));
    const nossaChave = k.chaveAcesso ? await chaveFoiTentadaPorEsteNumero(tx, led.id, k.chaveAcesso) : true;

    // autorização tardia: aceita de estados não-consumidos se a chave é nossa
    const origemOk = ["EM_TRANSMISSAO","INCERTO"].includes(led.estado)
      || (k.estado === "AUTORIZADO" && ["RESERVADO","REJEITADO_REUTILIZAVEL"].includes(led.estado) && nossaChave);
    if (!origemOk) { log.warn("nfe.numeracao.resultado_ignorado", { ledgerId: led.id, de: led.estado, para: k.estado }); return led.estado; }
    if (led.estado !== "EM_TRANSMISSAO" && led.estado !== "INCERTO") await evento(tx, led, "AUTORIZACAO_TARDIA", {});
    if (!podeTransicionar(led.estado, k.estado)) throw new Error(`transição inválida ${led.estado}→${k.estado}`);

    const base = { cStat: k.cStat, codigoProvedor: k.codigoProvedor, motivo: trunc(k.motivo, 500), leaseAte: null };
    switch (k.estado) {
      case "AUTORIZADO":
        if (ctx.provedor === "FOCUS_NFE") { const r = await realinharFocus(tx, led, k, ctx); if (r.divergente) return "AUTORIZADO"; }
        await upd(tx, led, "AUTORIZADO", { ...base, protocolo: k.protocolo, chaveAcesso: k.chaveAcesso ?? led.chaveAcesso, consumidoEm: now() });
        await tx.$queryRawUnsafe(`UPDATE "NfeEmitida" SET "status"='AUTHORIZED',"chaveAcesso"=$1,"protocoloAutorizacao"=$2,
            "dataAutorizacao"=COALESCE($3,NOW()),"updatedAt"=NOW() WHERE "id"=$4 AND "status" IN ('SENDING','REJECTED','DRAFT')`,
            k.chaveAcesso ?? led.chaveAcesso, k.protocolo, k.dataAutorizacao, ctx.nfeId);
        break;
      case "DENEGADO": case "INUTILIZADO": case "CONSUMIDO_EXTERNO": case "CANCELADO":
        await upd(tx, led, k.estado, { ...base, protocolo: k.protocolo ?? null, consumidoEm: now() });
        await linhaRejeitada(tx, ctx.nfeId, k);                       // 1 UPDATE: status+motivo+cStat(int|null)
        break;
      case "REJEITADO_REUTILIZAVEL":
        await upd(tx, led, "REJEITADO_REUTILIZAVEL", base);
        await linhaRejeitada(tx, ctx.nfeId, k);
        break;
      case "RESERVADO":                                                // não-consta confirmado
        await upd(tx, led, "RESERVADO", { ...base, jaIncerto: true });
        await linhaRejeitada(tx, ctx.nfeId, k);
        break;
      case "INCERTO":
        await upd(tx, led, "INCERTO", { ...base, jaIncerto: true, leaseAte: null });
        break;                                                         // linha continua SENDING
    }
    await evento(tx, led, "RESULTADO", { de: led.estado, para: k.estado, cStat: k.cStat, codigoProvedor: k.codigoProvedor, acao: k.acao });
    return k.estado;
  }));
}
// linhaRejeitada: UPDATE "NfeEmitida" SET status='REJECTED', "motivoRejeicao"=$m, "cStatRejeicao"=$c WHERE id=$n AND status IN ('SENDING','VALIDATING','SIGNING')
```

`upd(tx, led, para, data)` is `UPDATE … WHERE "id"=$1 AND "estado"=$de`. A count of 0 throws, so the transaction rolls back. On the emit path, a throw from `aplicarResultado` goes to the catch at step 16, which leaves the row INCERTO/SENDING, which is recoverable. After transmission this is never swallowed silently: it is logged.

The rejection path (`linhaRejeitada`) is one UPDATE carrying status, motivo and cStat together, replacing V1's two-step `handleRejected` (1059-1070).

---

## 9. Reconciliation

### 9.1 `POST /fiscal/nfe/:id/reconsultar` → `NfeNumeracaoReconciliarUseCase.reconciliar(userId, nfeId)`

1. The flag must be on for this user and modelo, otherwise 404.
2. `led` = the active ledger row for `nfeId` and `userId`. If missing, return 409 "Nota sem registro de numeração V2 — fora do escopo" (old rows; decision 3). The state must be INCERTO, or EM_TRANSMISSAO with `leaseAte < now`; otherwise 409 "Envio em andamento".
3. Lease claim: `UPDATE "NfeNumeroLedger" SET "leaseAte"=NOW()+interval '2 min' WHERE id=$1 AND estado IN ('EM_TRANSMISSAO','INCERTO') AND ("leaseAte" IS NULL OR "leaseAte" < NOW())`. A count of 0 returns 409.
4. The provider comes from **`led.provedor` and `led.ambiente`**, not the current config:
   - SEFAZ: `createNfeProviderFromConfig({providerName:"SEFAZ_DIRECT", ambiente: led.ambiente, uf, cert…})`. Without a certificate: 409 "Configure o certificado para confirmar a situação".
   - Focus: needs the token from the config of `led.companyFiscalConfigId`, otherwise 409.
5. SEFAZ `consultarDetalhado(led.chaveAcesso)` or Focus `consultarDetalhado(led.providerRef, token)`, then `classificarConsulta(c, { idadeMs: now − led.transmitidoEm, naoConstaMinMs })`.
6. `aplicarResultado`. If AUTORIZADO: SEFAZ builds nfeProc from `readFile(led.xmlAssinadoPath)` plus `protNFeXml`; Focus uses `buscarXml(led.providerRef)`. Then `handleAuthorized(..., { ref })`.
7. Return an `EmissionResult` shape. Log `nfe.numeracao.consulta`.

### 9.2 Optional sweeper (phase 6; separate flag, off by default)

`NfeNumeracaoReconciliadorService` is started in `app/api/api.ts` only when `NFE_NUMERACAO_V2_RECONCILIADOR_ENABLED === "true"` and `DEXO_INSTANCE_ROLE === "api-prod"`, so it can never run from a local `npm run api` that points at PROD.
- Every 5 minutes it takes up to 20 rows from `NfeNumeroLedger_pendentes_idx`: INCERTO older than 10 minutes, EM_TRANSMISSAO with an expired lease, and `ORFAO` with `jaIncerto` and a chave.
- It applies §9.1 steps 3-7.
- For `ORFAO` rows it only consults. If authorized, it raises `NUMERO_AUTORIZADO_FORA_DO_VINCULO` (manual cancel needed) and never rebinds.

---

## 10. Other lifecycle integrations

### 10.1 `updateDraft` forcing DRAFT (R1)

`updateDraft` stays as it is (`nfe.repository.ts:379-381`). V2 never decides reuse from `status` or `cStatRejeicao`; it decides from the ledger binding for `nfeId` (§5.3 step 5). A REJECTED row that the wizard flipped to DRAFT keeps its binding, and the next emit reuses the number. The flag-off path still uses `shouldReuseNumero`.

Known behaviour, unchanged: `findExistingDraft` can reopen that same DRAFT row (`nfe.repository.ts:225-235`). It is the same document, so reusing its number is correct.

### 10.2 Changing série, emitente or ambiente on a row that holds a number

- `updateDraft` allows `serie` and `companyFiscalConfigId` (338-341). `ambiente` comes from the config at emit time (`nfe-emission.usecase.ts:220`).
- V2 detects the key change at the next emit (§5.3 step 6):
  - the old number becomes `LIBERADO`, or `ORFAO` if `jaIncerto`, with event `TROCA_CHAVE`;
  - a number is allocated in the new key;
  - both sequence rows are locked in sorted order.
- While INCERTO the row is SENDING, so edits are silent no-ops (413-418). A key change is therefore impossible until reconciliation.
- Existing risk, out of scope and not fixed: changing série on a REJECTED row with a positive numero can hit the partial unique inside `updateDraft` (P2002 → 500). V2's release happens only at emit time.

### 10.3 Deleting a draft

`NfeDraftUseCase.delete` (`nfe-draft.usecase.ts:524-531`), when V2 is on:

```ts
tx:
  vig0 = ledger ativo de nfeId (sem lock)
  if (vig0) { lockSequencia(keyOf(vig0)); vig = SELECT … FOR UPDATE; recheck }
  if (await existe(tx, `"nfeId"=$1 AND "estado" IN ('AUTORIZADO','CANCELADO','DENEGADO')`))
      throw new NumeracaoError("DOCUMENTO_FISCAL_REGISTRADO", 409, "NF-e denegada/autorizada não pode ser excluída");
  if (vig?.estado in ["EM_TRANSMISSAO","INCERTO"]) throw 409   // (linha não seria DRAFT/REJECTED; defesa)
  if (vig) transicionar(vig, vig.jaIncerto ? "ORFAO" : "LIBERADO", { nfeId:null, liberadoEm:now(), limparTentativa:true, motivo:"RASCUNHO_EXCLUIDO" })
  const del = await tx.nfeEmitida.deleteMany({ where:{ id, userId, status:{ in:["DRAFT","REJECTED"] } } });
  if (del.count === 0) throw new Error("Rascunho de NF-e não encontrado");   // rollback
if (!vig && row.numero > 0) log("nfe.numeracao.legado_rascunho_excluido", { nfeId, cfc, ambiente, modelo, serie, numero, status, cStatRejeicao })
  // nenhuma escrita no ledger para legado (decisão 3); NfeAuditLog some por cascade (schema.prisma:2001)
```

### 10.4 Stuck VALIDATING/SIGNING

Covered in §6.1 step 0, only for rows with a V2 binding. The pre-send lease is 10 minutes by default; the steps before sending take seconds. The claim's `updateMany` bumps `updatedAt`.

### 10.5 Inutilização (`nfe-inutilizacao.usecase.ts`, V2 branch for modelo 55)

1. Validation (64-75) and config (80-99), unchanged.
2. **Pre-check transaction:**
   - `lockSequencia(key)`.
   - `SELECT numero, estado, "nfeId" FROM "NfeNumeroLedger" WHERE key AND numero BETWEEN $ini AND $fin AND estado NOT IN ('LIBERADO','ORFAO','INUTILIZADO') FOR UPDATE`.
   - `SELECT id, numero, status FROM "NfeEmitida" WHERE <key incl. legacy NULL for default> AND numero BETWEEN $ini AND $fin AND status <> 'INUTILIZED'`. This catches rows holding a number in any state, old or V2.
   - If either query returns anything: `NumeracaoError("FAIXA_COM_NUMERO_VIVO", 400, "Nº 101 (rascunho X / autorizada Y) está na faixa")`, listing up to 10.
   - `UPDATE ledger SET estado='ORFAO' WHERE key AND numero BETWEEN … AND estado='LIBERADO'` with event `INUTILIZACAO_PREP`. This takes them out of the pool before the SEFAZ call.
3. Create the PENDENTE record and call the provider, same as 106-138. The reservation path refuses numbers inside a PENDENTE range younger than 15 minutes (§5.3). The counter is not moved ahead of time.
4. On success, in one transaction: `lockSequencia`; `UPDATE ledger SET estado='INUTILIZADO', protocolo, consumidoEm WHERE key AND numero BETWEEN … AND estado IN ('LIBERADO','ORFAO')` with events; if `proximoNumero <= fin`, set it to `fin+1` under the lock (this replaces the unlocked 166-182 for V2). Numbers without a ledger row are not materialised; `NfeInutilizacao ACEITA` is the record, and §5.5 reads it.
5. On failure: identical to V1.

Inutilização is a fiscal action for real gaps. It never runs automatically and never touches bound numbers, so it cannot hide a counter bug.

### 10.6 SVC contingency

Current behaviour: blind SVC on 108/109 and 280-289, and "timeout → 217 → SVC with the same number" (`nfe-emission.usecase.ts:377-454`). The builder has no `dhCont`/`xJust`.

V2 rules:
- **Ambiguous origin (timeout, network, 5xx):** never go to SVC. Leave INCERTO. The contingency manual expects a document that was already sent in normal mode without a response to be reissued in contingency under a new number, with the original number later cancelled or inutilized. V2 does not automate that, so the `needsConsult → 217 → reemitViaSvc` branch is off under V2.
- **Explicit origin down (only 108/109):** same number, new `tpEmis` 6 or 7. Allowed because origin never registered the number. `prepararEmissao` runs with the same cNF, a new dhEmi and `tpEmis`, which gives a new chave. The ledger stays EM_TRANSMISSAO with a new `TRANSMISSAO_INICIADA` event, so both chaves count as "ours".
- 280–289 are certificate rejections, not "SEFAZ unavailable"; confirm against MOC 7.0 Anexo I. V2 treats them as REJEITADO_REUTILIZAVEL with no SVC.
- **Operational:** keep `SEFAZ_AUTO_FALLBACK_ENABLED` off until the builder emits `dhCont`/`xJust` for `tpEmis ≠ 1` (separate task).

### 10.7 Loop guards

- **Per emit call:** at most one number transmitted, plus identical SOAP retries (same chave), plus one automatic consult, plus 3 polls. Never renumbers automatically inside a call.
- **Per row:** at least 3 CONSUMIDO_EXTERNO or INUTILIZADO rows for this `nfeId` in 24h → `NUMERACAO_EM_LOOP` (409).
- **Per key:** the last 3 allocations ended CONSUMIDO_EXTERNO → `SEQUENCIA_ATRAS_DA_SEFAZ` (409).
- 635 and 204 never renumber.
- A 539 that matches one of our chaves goes through a consult, not a new number.

### 10.8 Cancellation (`nfe-cancelamento.usecase.ts`, V2)

- Before 109: `ref = (await ledger.refAutorizada(nfeId)) ?? nfeId`.
- After the update at 135-146: `safeLedger(() => transicionar(AUTORIZADO→CANCELADO, { protocolo }))`. Old rows without a ledger row are a no-op.

### 10.9 Next-number preview (`fiscal.routes.ts:620-674`, V2)

Adds `{ proximoNumero: min(eligible pool) ?? seq, origem: "POOL" | "SEQUENCIA" }`. Read-only.

### 10.10 NFC-e (65)

Excluded by default (`NFE_NUMERACAO_V2_MODELOS=55`). When enabled, the pipeline is the same. The PDV already treats SENDING as "processing" (`finance.usecase.ts:1862-1876`). Inutilização for 65 stays out of scope.

---

## 11. Old rows and the diagnostic script (decision 3)

- There is no automatic release, no inutilização and no "Reconciliar" button for old rows. The only V2 behaviour for them is the adoption onto the same row in §5.4.
- **`scripts/fiscal/diagnostico-numeracao-v2.ts`**:
  - Strictly read-only. Wraps everything in `$transaction` with `SET TRANSACTION READ ONLY` as the first statement. Never builds providers or calls Focus/SEFAZ.
  - Args: `--userId`, `--cfc`, `--csv`.
  - Output per key:
    - `proximoNumero`;
    - ledger counts per state;
    - numbers below `proximoNumero` with no AUTHORIZED/CANCELLED/INUTILIZED row and no ACEITA inutilização range (gaps);
    - SENDING rows with their last audit event;
    - DRAFT/REJECTED rows with numero>0 and the verdict from `decidirAdocaoLegado`, so adoption can be predicted before the flag goes on;
    - Focus rows where the database numero differs from the nNF in the chave;
    - the floor that §5.5 would apply;
    - integrity checks: ledger ahead of the sequence, active binding disagreeing with `row.numero`, INCERTO older than 1h, eligible pool rows.
  - Exits non-zero only on integrity failures.

---

## 12. Observability

`logNumeracao(evt, campos)` writes `console.info("[nfe-numeracao]", JSON.stringify({ evt, ts, ...whitelist }))`. Allowed fields: `userId, nfeId, cfcId, ambiente, modelo, serie, numero, ledgerId, de, para, origem, provedor, cStat, codigoProvedor, tentativa, chaveSufixo` (last 10 digits only), `latenciaMs, lockEsperaMs, motivo`.

Never logged: token, `certificadoSenhaEnc`, CSC, XML, destinatário data (LGPD), full `providerRef` URL. Event `detalhes` keys avoid words that `sanitizeDeep` redacts by substring (see memory).

| evt | level |
|---|---|
| `nfe.numeracao.reservado` (origem SEQUENCIA/POOL/ADOCAO_LEGADO, reuso bool, lockEsperaMs) | info |
| `nfe.numeracao.transmissao_iniciada` / `.resultado` (de→para, cStat, latenciaMs) | info |
| `nfe.numeracao.incerto` / `.consulta` / `.nao_consta_confirmado` | info |
| `nfe.numeracao.falha_local` (numero kept) | info |
| `nfe.numeracao.legado_nao_adotado` (reason) / `.legado_adotado` / `.legado_rascunho_excluido` | info |
| `nfe.numeracao.piso_aplicado` (de, para) | warn |
| `nfe.numeracao.liberado` / `.orfao` / `.pool_expirado` | info |
| `nfe.numeracao.consumido_externo` / `.loop_bloqueado` / `.sequencia_atras` | warn |
| `nfe.numeracao.focus_divergencia` / `.autorizacao_tardia` / `.numero_autorizado_fora_do_vinculo` | error |
| `nfe.numeracao.inconsistencia` (LEDGER_A_FRENTE, VINCULO_DIVERGENTE, resultado_ignorado) | error |
| `nfe.numeracao.ledger_escrita_falhou` | error |
| lock wait over 2000 ms | warn |

User-visible trail in `NfeAuditLog`: NUMERADA (with origem), NUMERO_REUTILIZADO, ENVIADA, REJEITADA, ENVIO_INCERTO, RECUPERADA_TRAVADA, NUMERACAO_DIVERGENTE_FOCUS, NUMERO_REMOVIDO_CONFLITO.

---

## 13. Files to touch

**New**
- `prisma/ddl/2026-09-18-nfe-numero-ledger.sql` (§3.2)
- `app/fiscal/domain/nfe-numeracao-v2.ts`: pure. Flags, states, `podeTransicionar`, `normalizarCStat`, `classificarEnvio`, `classificarConsulta` (SEFAZ and Focus), `decidirAdocaoLegado`, `providerRefPara`, `inicioMesFiscal`, `extrairChNFe`, `NumeracaoError { codigo, httpStatus }`.
- `app/fiscal/sequence/nfe-numero-ledger.repository.ts`: raw SQL, all transaction-scoped. `lockSequencia`, `lockVinculoAtivo`, `lockCandidatoPool`, `inserirLedger`, `transicionar`, `evento`, `numeroUsadoEmNfeEmitida`, `faixasInutilizacaoPendentes`, `ultimasAlocacoesTodasConsumidasExternas`, `existeLedgerDaChave`, `aplicarPiso`, `chaveFoiTentadaPorEsteNumero`, `refAutorizada`. Behind an interface `INfeNumeroLedgerRepo` so tests can use an in-memory version.
- `app/fiscal/sequence/nfe-numeracao-v2.service.ts`: `reservar`, `iniciarTransmissao`, `aplicarResultado` (with `realinharFocus`), `marcarIncerto`, `liberarPorExclusao`, `preInutilizacao`, `posInutilizacao`, `marcarCancelado`, `safeLedger`.
- `app/usecases/nfe-numeracao-reconciliar.usecase.ts`
- `app/notas-fiscais/lib/nfe-numeracao-actions.ts`: pure; `podeConsultarSituacao(item)`, `mensagemEstado(estado)`.
- `scripts/fiscal/diagnostico-numeracao-v2.ts` (read-only)
- Optional phase 6: `app/fiscal/sequence/nfe-numeracao-reconciliador.service.ts`

**Changed (additive, each gated)**
- `prisma/schema.prisma`: 2 new models (§3.1).
- `app/usecases/nfe-emission.usecase.ts`: V2 router at the top of `emit`; new `emitV2`; optional `opts?: { ref?: string }` on `handleAuthorized` (default `nfeId` gives an identical call at 815).
- `app/fiscal/providers/sefaz-direct.provider.ts`: add `prepararEmissao`, `transmitirPreparada`, `consultarDetalhado` and a new private parser. Existing functions untouched.
- `app/fiscal/providers/focus-nfe.provider.ts`: add `emitirDetalhado`, `consultarDetalhado`.
- `app/fiscal/generators/nfe-xml-builder.service.ts`: optional 4th argument `{ numeracaoDexo?: boolean }` around line 56.
- `app/fiscal/storage/fiscal-storage.service.ts`: add `saveXmlAssinado`.
- `app/usecases/nfe-draft.usecase.ts`: V2 branch in `delete`.
- `app/usecases/nfe-inutilizacao.usecase.ts`: V2 pre/post branches.
- `app/usecases/nfe-cancelamento.usecase.ts`: V2 ref resolution and CANCELADO mark.
- `app/routes/fiscal.routes.ts`:
  - new `POST /nfe/:id/reconsultar`;
  - in `/issue`, `if (error instanceof NumeracaoError) return reply.status(error.httpStatus)…` before the current mapping;
  - same `instanceof` branch in DELETE draft and `/inutilizacao`;
  - V2 branch in `/nfe/proximo-numero`.
- `app/repositories/nfe.repository.ts`: in `findEmitted` (637+), when V2 is on, one extra `SELECT "nfeId","estado" FROM "NfeNumeroLedger" WHERE "nfeId" = ANY($1) AND "estado" IN ('EM_TRANSMISSAO','INCERTO')` for the SENDING ids of the page only; attach `numeracao?: { estado }`.
- `app/interfaces/nfe.interface.ts`: optional `numeracao?: { estado: string }` on `NfeListItem`.
- `app/notas-fiscais/components/nfe-wizard.tsx`: with the front-end flag on, `setIsEmitting(true)` runs before `await saveCurrentStep()` (457-466).
- `app/notas-fiscais/components/nfe-list.tsx`: "Consultar situação" (RefreshCw) action shown when `podeConsultarSituacao(item)`, i.e. only rows carrying `numeracao`; old SENDING rows never show it.
- `.env.example`: the new flags.
- `tests/fiscal/__mocks__/mock-nfe-provider.ts`: queues for the new methods.

**Not touched:** `cstat-mapper.ts`, `nfe-number-reuse.ts`, `contingencia.service.ts`, `nfe-sequence.service.ts`, `nfe.repository.ts#updateDraft/createDraft/deleteDraft`, `finance.usecase.ts`.

---

## 14. Tests (vitest `--pool=forks`, hoisted doubles like `tests/fiscal/nfe-emission-company.spec.ts`)

**Harness.** `tests/fiscal/__helpers__/in-memory-ledger-repo.ts` implements `INfeNumeroLedgerRepo`:
- per-key async mutex to simulate `FOR UPDATE`;
- rollback on throw (copy-on-write snapshot);
- the unique and partial-unique rules enforced in memory.

`emitV2` tests use `MockNfeProvider` and the in-memory repo, and actually get past `provider.emitir`, which today's tests never do.

**Mandatory scenarios** (`tests/fiscal/nfe-numeracao-v2-emit.spec.ts`)

| # | Scenario | Assertions |
|---|---|---|
| 1 | Local error (certificate load throws after reservation) | ledger 101 RESERVADO; row DRAFT; retry → 101 AUTORIZADO; new document → 102; `NfeSequence` bumped once |
| 2 | SEFAZ rejection 225, edit via `updateDraft` (row→DRAFT), emit again | 101 reused, same cNF, same chave within the month; variants 974, 999, 704; Focus `"974"` string gets cStat 974 with no Prisma error |
| 3 | Focus 401 / 400 empresa_nao_habilitada / 422 schema | REJEITADO_REUTILIZAVEL, row **REJECTED** (not SENDING), retry keeps 101 and ref `nfeId`; Focus 503 → INCERTO |
| 4 | Authorized | AUTORIZADO; emit on the same row is idempotent (200, AUTHORIZED); next document 102; Focus write-back numero/serie from chave; divergence case (Focus nNF 3 against reserved 12) → row numero 3, ledger 12 ORFAO, audit written |
| 5 | Cancelled | CANCELADO; not in pool; inutilização of 101 refused; delete refused |
| 6 | Inutilized 102..105 | pool LIBERADO 103 → INUTILIZADO; sequence 106; 206 on emission → INUTILIZADO, next emit gets a new number |
| 7 | Timeout | INCERTO, row SENDING; emit returns pending with no transmission; reconsultar 217 at age < min → INCERTO; ≥ min → RESERVADO(jaIncerto) + REJECTED; emit → 101 same chave; delete → ORFAO (not pool) |
| 8 | Timeout, then consult 100 | AUTORIZADO; nfeProc = stored signed XML + protNFe; next document 102 |
| 9 | Double click: `Promise.all([emit, emit])` on the same nfeId | exactly one claim; `reservar` called once; loser gets `NumeracaoError` 409; one ledger row |
| 10 | Two users at once, two nfeIds, same key | 101 and 102 distinct; plus a test asserting `NfeSequence … FOR UPDATE` comes before any ledger SQL in the real repo's captured statements |
| 11 | Tenants: two cfc, same série/ambiente | both get 1 |
| 12 | Séries 1 and 3 | independent counters and pools |
| 13 | Ambientes | HOMOLOG 5 / PROD 1 independent; changing config ambiente on a REJECTED row → old LIBERADO in HOMOLOG, new in PROD |
| 14 | Focus rejects 101 (schema), switch to SEFAZ_DIRECT, emit | 101 reused, authorized; switch back to Focus → 102; ref for a second number = `${nfeId}-n102` only if the same nfeId |
| ★ | Reported scenario | 100 AUTORIZADO; new document → 101; rejection 225; wizard PUTs (DRAFT) and `/calculate`; issue → 101 AUTORIZADO; new document → 102 |

**Guards and edge cases** (`tests/fiscal/nfe-numeracao-v2-classificacao.spec.ts`, pure)
- Every row of the §7 tables.
- 539 with our chave → consult; 539 with another chave → CONSUMIDO_EXTERNO.
- 562 and 613 behave like 539. 635 → INCERTO. 204 → consult. 205 → DENEGADO. 218 → CANCELADO. 108 → reusable.
- `/^Rejei/` beats a 301 code.
- `normalizarCStat("erro_validacao_schema") === null`.

**Service** (`tests/fiscal/nfe-numeracao-v2-service.spec.ts`)
- Pool from the same month is taken first. Previous month → ORFAO, then sequence. `jaIncerto` release → ORFAO.
- `NfeEmitida` collision → CONSUMIDO_EXTERNO and skip (cap 20).
- Ledger ahead of the sequence → 500, fail closed.
- Floor from Focus chaves. PENDENTE inutilização blocks allocation.
- Three CONSUMIDO_EXTERNO in a row → SEQUENCIA_ATRAS. Row loop guard.
- Divergent binding → ORFAO. Key change releases under sorted locks.
- Late authorization accepted from REJEITADO_REUTILIZAVEL only when the chave is ours.

**Legacy** (`tests/fiscal/nfe-numeracao-v2-legado.spec.ts`)
- Evidence A adopts; evidence B adopts.
- ENVIO_INCERTO present → no. Focus provider → no. cStat null → no. numero ≥ proximoNumero → no.
- Old SENDING rows are never touched. Old draft delete writes no ledger.

**Stuck rows**
- VALIDATING older than the lease with a V2 binding → DRAFT, then emit.
- Without a binding → untouched, same error as today.

**Flag-off identity** (`tests/fiscal/nfe-numeracao-v2-flag-off.spec.ts`), with the env unset or `"1"`, and with the user not in the allowlist:
- `emit` makes the same `prisma` mock call sequence as a golden list recorded from current code;
- `reservarProximoNumero` is called with the same arguments as `nfe-emission-company.spec.ts:135-141`;
- builder payload deep-equals the old one (`numero_nota` present, no `numero`);
- `provider.emitir` is called and no new methods are;
- `delete`, `inutilizar` and `cancel` issue no ledger queries;
- `/issue` still returns 500 on the claim-loser message;
- `/reconsultar` returns 404.

Existing suites must stay green unchanged: `nfe-emission-reuse`, `nfe-sequence*`, `nfe-update-draft-guard`, `provider-contract`, `focus-nfce-path`.

**Front end** (`tests/nfe-numeracao-actions.spec.ts`, node): action visibility for V2 INCERTO rows vs old SENDING rows.

**Optional real Postgres** (`tests/integration/nfe-numero-ledger-pg.spec.ts`): skipped unless `NFE_LEDGER_PG_URL` is set, and refuses any host containing `supabase` or `pooler`. Runs the DDL on a docker `postgres:16`, then:
- 50 concurrent `reservar` → 50 distinct numbers;
- the partial unique rejects a second active binding;
- the check constraints hold.

**Gates:** `tsc --noEmit` multiset matches the clean HEAD baseline (98); `next build` eslint passes (prefer-const); restore the Prisma client after generating.

---

## 15. Rollout, preflight and rollback

1. **Preflight, before any flag:**
   - Run the diagnostic script against prod read-only (VPS `DIRECT_URL`, per the runbook). Review adoption verdicts, floors and SENDING rows.
   - Manual Focus homologação checks by the user, not by the implementer:
     - (a) POST with `numero`+`serie` is honoured and the chave nNF equals `numero`;
     - (b) re-POST of the same ref after `erro_autorizacao` with the same numero;
     - (c) a ref of about 36 characters with a hyphen is accepted;
     - (d) POST of a numero already authorized returns `erro_autorizacao` 539 (or which code);
     - (e) response fields and HTTP code for a synchronous 201.
2. Deploy code with the flag off. Confirm identity with smoke checks (issue, cancel, inutilização, PDV NFC-e, DANFE, XML, listing, stats).
3. Apply the DDL in the Supabase SQL editor (new tables, transactional). Run the verification queries; every index must show `indisvalid=t`.
4. `NFE_NUMERACAO_V2_ENABLED=true` and `NFE_NUMERACAO_V2_USER_IDS=<Kiko userId>` (HOMOLOGACAO, Focus), then `pm2 restart` without `--update-env` (see the pm2 recovery runbook). Run the 14 scenarios in homologação.
5. Front end: `NEXT_PUBLIC_NFE_NUMERACAO_V2_ENABLED=true` and rebuild.
6. Add SEFAZ_DIRECT production tenants one at a time, watching `[nfe-numeracao]` warn/error lines. Enable `NFE_NUMERACAO_V2_MODELOS=55,65` later. Enable the sweeper last.
7. **Rollback:** turn the flag off (instant, V1 resumes). V2-bound rows that V1 renumbers are detected as `VINCULO_DIVERGENTE` if V2 is re-enabled. Drop the tables only after the flag is off and the `ops_backup` copy exists.

---

## 16. Existing issues found along the way (not fixed by this design)

- `contingencia.service.ts:86-92` sends 280–289 (certificate errors) to SVC, and the SEFAZ builder never writes `dhCont`/`xJust`, so SVC XML is likely rejected. Keep `SEFAZ_AUTO_FALLBACK_ENABLED` off.
- `cstat-mapper.ts:72-75` labels 218 as "já foi autorizada"; per the SEFAZ table it means "já está cancelada".
- `deleteDraft` cascades `NfeAuditLog` (`schema.prisma:2001`), so the forensic trail disappears with the draft. V2's ledger events survive.
- Changing série on a REJECTED row with a positive numero can hit a P2002 inside `updateDraft` (the partial unique at `docs/multi-cnpj-sql.md:84-86`).
- `CompanyFiscalConfig @@unique([userId, cnpj])` (`schema.prisma:1849`) allows the same CNPJ in two tenants, each with its own counter, which means real SEFAZ collisions. V2 turns these into CONSUMIDO_EXTERNO plus a loop guard but does not prevent them. The two Focus tokens shared across tenants belong to the same isolation concern. Both are reported only, not changed.