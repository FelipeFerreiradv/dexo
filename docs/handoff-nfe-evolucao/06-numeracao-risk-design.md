# NF-e Numbering V2: risk-first design

Scope: this is a design only. Nothing was edited, run, deployed or called on SEFAZ or Focus. Line numbers refer to worktree HEAD `1549bc4`.

---

## 0. Core idea, invariants, flags

### 0.1 Why reuse is safe and renumbering is not

- **SEFAZ blocks duplicate numbers.** For one (CNPJ, modelo, série, nNF) it authorizes at most one document. A second chave for the same number gets 539; the same chave again gets 204.
- **So reusing a number cannot create a second authorization.** At worst it costs one extra request that comes back 204, 539, 205 or 206, and V2 recognizes those codes.
- **A new number is the only way to double-authorize.** If a document gets a new number while an earlier attempt could still be authorized, the same sale ends up authorized twice. Every renumbering therefore needs strong proof.
- **Gaps come from renumbering when reuse was possible.**

This gives a lopsided policy: **reuse by default, renumber only with proof that the number was consumed.** Keeping the number needs no proof, as long as Dexo remembers every chave it sent, so that 204/539 can be matched to its own attempts.

### 0.2 Invariants (every one gets a test)

| # | Invariant |
|---|---|
| I1 | A document (`nfeId`) gets a **new** number only when every earlier attempt on its current reservation is proven not authorized, or the number was consumed by someone else (539 or 206 with a chave that is not ours). |
| I2 | A reservation belongs to one key `K = (companyFiscalConfigId, ambiente, modelo, série)`. It is never used under another key. |
| I3 | Before any byte goes out, the attempt (chave, cNF, dhEmi, tpEmis, digest, signed-XML path) is committed with `fase=TRANSMITINDO`. |
| I4 | An uncertain attempt closes only through a **consultation** result that is old enough ("mature") or through a definitive answer to that same attempt. A rejection of a later resend does not count as proof (see §5.4). |
| I5 | No `MAX(numero)+1`, no `numero--`, no automatic reassignment of abandoned numbers. The counter only moves forward (`NfeSequence`, reused). |
| I6 | With the flag OFF, V2 code is never reached. Every existing path stays byte-identical. |

### 0.3 Flags (backend flags read on every call with `=== "true"`)

```ts
// app/fiscal/numeracao/flags.ts (NEW)
export function isNfeNumeracaoV2Enabled(userId?: string | null): boolean {
  if (process.env.NFE_NUMERACAO_V2_ENABLED !== "true") return false;
  const allow = (process.env.NFE_NUMERACAO_V2_USER_IDS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return allow.length === 0 || (!!userId && allow.includes(userId));
}
/** Only has effect when V2 is ON. Sends payload.numero/serie to Focus (user decision 1). */
export const isFocusEnviaNumeroEnabled = () =>
  process.env.NFE_FOCUS_ENVIA_NUMERO_ENABLED === "true";
```

- **Frontend:** `NEXT_PUBLIC_NFE_NUMERACAO_V2_UI_ENABLED`, inlined at build. It only controls the double-click guard and how the response is read. It is harmless even when the backend flag is OFF.
- **Allowlist:** rollout starts with Kiko (homologação), then everyone.

---

## 1. Risk register

Each risk has an ID (B = number wrongly burned, U = number wrongly reused, S = same document authorized twice), a location in code, and the V2 control that addresses it.

### 1.1 B: number wrongly burned (gap)

| ID | Mechanism (proof in code) | V2 control |
|---|---|---|
| B1 (R1) | `updateDraft` forces `status="DRAFT"` on every save (`app/repositories/nfe.repository.ts:379-381`). The "Tentar novamente" button always sends the user back into the wizard (`app/notas-fiscais/components/nfe-list.tsx:784-799`). The PDV emitter switch also goes through `updateDraft` (`app/usecases/finance.usecase.ts:1886-1897`). V1 reuse requires `status==='REJECTED'` (`app/fiscal/domain/nfe-number-reuse.ts:57`). | The reservation lives in the **ledger, keyed by `nfeId`**. Whether a number is reused no longer depends on `NfeEmitida.status`, so `updateDraft` stays untouched. |
| B2 (R2) | `lookupCStat` only treats 200–599 as `rejeitada` (`app/fiscal/sefaz/cstat-mapper.ts:111-117`). 974, 975, 704 and 781 are never reused. | New classifier (§3). Every integer code not listed as special is an ordinary rejection and the number is kept. |
| B3 (R3) | Focus returns `codigoStatus` as a string (`focus-nfe.provider.ts:82,96,164`). `handleRejected` commits `REJECTED` first, then a second update with `cStatRejeicao:"974"` throws (`nfe-emission.usecase.ts:1059-1070`). The catch writes `ENVIO_INCERTO` and returns HTTP 500 (`:557-563`). | `normalizarCStat()`. The raw value goes to the attempt table. `handleRejectedV2` writes status, motivo and integer cStat in **one** update. |
| B4 (R4) | Focus 401 answers `text/html`, so `res.json()` throws (`focus-nfe.provider.ts:70`) and the result becomes `erro`. Any HTTP status other than 200/201/202/422 is also `erro` (`:104-114`). Both end as `SENDING` forever (`nfe-emission.usecase.ts:521-536`). | Focus V2 client parses text first and classifies `PRE_ENVIO_DEFINITIVO` (400/401/403/404/415/422 `permissao_negada`/429). The number is kept and the row goes to `REJECTED`. |
| B5 (R5) | Any throw after the reservation and before the send puts the row back to `DRAFT`, and the next click reserves a new number (`nfe-emission.usecase.ts:547-556`). | The reservation stays `RESERVADO` and is reused. |
| **B6 (the reported scenario, SEFAZ direct)** | XML build, signing or QR failures inside `SefazDirectProvider.emitir` come back as `status:"erro"` (`sefaz-direct.provider.ts:199-205, 216-223, 244-250`). This happens **after** `sentToSefaz = true` (`nfe-emission.usecase.ts:357`), so a missing or invalid field (e.g. `codMunicipio`, `nfe-xml-builder-sefaz.service.ts:98-111`) leaves the note stuck in `SENDING` with its number burned. | Two phases: `prepararEmissao()` throws locally **before** `TRANSMITINDO` (§5). |
| B6b | With `SEFAZ_AUTO_FALLBACK_ENABLED` on, a signing failure returns a chave (`sefaz-direct.provider.ts:221`). That triggers "consult, then 217, then **SVC emission**" (`nfe-emission.usecase.ts:394-437`) for a note that was never sent. | V2 disables the SVC path after an uncertain outcome (§9). |
| B7 | Lote-level cStat values 108/109 become `rejeitada` (`sefaz-direct.provider.ts:983`). `handleRejected(108)` stores category `servico_indisponivel`, which is not reusable, so a new number is taken. | `SERVICO_INDISPONIVEL`: number kept. |
| B8 | A crash or pm2 restart during `VALIDATING`/`SIGNING` leaves the row stuck. `findDraftById` only accepts DRAFT or REJECTED (`nfe.repository.ts:321-323`). The user starts a new note, which gets a new number. | Lease on the reservation, plus takeover of a stale claim when no attempt was ever marked `TRANSMITINDO` (§7). |
| B9 | Deleting a REJECTED row that holds a number: `NfeDraftUseCase.delete` accepts REJECTED (`nfe-draft.usecase.ts:524-531`), `deleteDraft` does not check status (`nfe.repository.ts:479-491`), and the audit log cascades away (`schema.prisma:2001`). The gap leaves **no trace**. | V2 hook marks the reservation `ABANDONADO` with `requerInutilizacao`. The ledger has no FK to the row, so the record survives. |
| B10 | The counter is behind numbers already in use: imported historic notes, or V1 Focus rows whose stored number is fiction. The update at `nfe-emission.usecase.ts:262-278` hits the partial unique index, fails with P2002, and turns into B5. | The reservation loop skips numbers already taken in `NfeEmitida`, the ledger or inutilizações, and audits `NUMERO_PULADO`. |
| B11 | Focus inutilização counts HTTP 200 as success (`focus-nfe.provider.ts:257`), but Focus returns 200 even with `status:"erro_autorizacao"`. It also reads `body.protocolo`, while Focus documents `protocolo_sefaz`. Then the counter is advanced (`nfe-inutilizacao.usecase.ts:157-183`), leaving undeclared gaps. | Inutilização V2 (§10). |
| B12 | Focus auto-numbers today: `numero_nota` is not a Focus field (`nfe-xml-builder.service.ts:56`), so Dexo's numbers are fiction. The gaps on Focus's side cannot be seen from Dexo. | Send `numero`, then read the real nNF back from the chave (§6). |
| B13 | Emitter or série changed on a numbered REJECTED row: the old number is abandoned. That is fiscally correct but leaves a gap. | Explicit `ABANDONADO(CHAVE_ALTERADA)` state, reported. |

### 1.2 U: number wrongly reused

| ID | Mechanism | V2 control |
|---|---|---|
| U1 | 205 ("NF-e está denegada na base") and 206 ("já está inutilizada") fall inside 200–599, so they count as `rejeitada` and are reused. The retry hits 205/206 again, which is also reused: **an infinite loop**. Legacy 301 behaves the same way. | Dedicated classes, number consumed. |
| U2 | A REJECTED row whose number was then inutilized is reused, gets 206, and loops. The use case never checks whether a range contains live rows (`nfe-inutilizacao.usecase.ts:105-138`). | The reservation checks `NfeInutilizacao` ACEITA/PENDENTE ranges. The inutilização checks live rows. |
| **U3 (latent)** | `shouldReuseNumero` checks **neither emitter nor série** (`nfe-number-reuse.ts:51-62`). This is only hidden because B1 turns every edit into DRAFT. **Any fix of R1 that keeps REJECTED would reuse emitter A's number under emitter B.** | I2: the key is part of the reservation. When the key differs, the old reservation is abandoned. |
| U4 | 635 ("mesmo número e série já transmitida e aguardando processamento") is within 200–599, so it is treated as rejected and reusable. | Class `EM_PROCESSAMENTO_NA_SEFAZ`, never rejected. See S2 for the consequence. |
| U5 | Two tenants with the same CNPJ run two counters, because `CompanyFiscalConfig` is `@@unique([userId, cnpj])` (`schema.prisma:1851`). | Cannot be prevented locally. `CONSUMIDO_EXTERNO` plus loop guard L2, and the diagnostic reports it. |

### 1.3 S: same document authorized twice (most severe)

| ID | Path | V2 control |
|---|---|---|
| S1 | Polling ends while still processing, so the row sits in `SENDING` with no way to resolve it (`nfe-emission.usecase.ts:496-503`). The user creates a **new** note, and both get authorized. | Reconciliation for V2 rows on POST `/issue` and `consultar-situacao` (§7). Optional: block creating a draft for the same `orderId` while an uncertain one exists (§8.4). |
| S2 | 635 is treated as REJECTED, the retry rebuilds with a new cNF and gets 539, the consultation of our new chave returns 217, `handleRejected(217)` gives a **new number**, and the first attempt gets authorized as well. | 635 means "in flight". 539 is reconciled against **every** chave of our attempts. |
| S3 | Focus 422 `already_processed` is mapped to `rejeitada` (`focus-nfe.provider.ts:89-101`). The row shows REJECTED although the note was authorized, so the user issues again under a new ref. | `JA_PROCESSADA_FOCUS`: GET the ref first. |
| S4 | SVC resends the **same number with a new chave** after a timeout followed by 217 (`nfe-emission.usecase.ts:423-437`). The origin may authorize tpEmis 1 while SVC authorizes tpEmis 6. | V2: no automatic SVC after an uncertain outcome (§9). |
| S5 | An authorized consultation lands in `handleAuthorized` without the nfeProc, logged as `XML_AUTORIZADO_PENDENTE` (`nfe-emission.usecase.ts:831-838`). This is not a duplicate, but the fiscal record stays incomplete. | nfeProc = stored signed XML plus the `protNFe` returned by the consultation (§5.3). |

---

## 2. Data model: two new tables, no new column on existing models

These are new tables, so code can ship first with the flag OFF, then the DDL, then the flag goes ON. The repository uses **raw SQL** (like `nfe-sequence.service.ts`), so no `prisma generate` is required on deploy. The models are added to `schema.prisma` only as documentation, with no relation to `NfeEmitida`, so the columns Prisma selects on `NfeEmitida` stay the same.

`prisma/ddl/2026-09-XX-nfe-numeracao-v2.sql`: run through `psql "$DIRECT_URL"` on the VPS before turning the flag on. The tables are empty, so `CONCURRENTLY` is not needed.

```sql
-- Numbering V2. NEVER `prisma db push` (unique partial below lives outside the schema).
CREATE TABLE IF NOT EXISTS "NfeNumeroReserva" (
  "id"                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId"                TEXT NOT NULL,
  "companyFiscalConfigId" TEXT NOT NULL,
  "ambiente"              TEXT NOT NULL,
  "modelo"                TEXT NOT NULL,
  "serie"                 INTEGER NOT NULL,
  "numero"                INTEGER NOT NULL CHECK ("numero" > 0),
  "nfeId"                 TEXT NULL,               -- no FK: survives draft deletion
  "estado"                TEXT NOT NULL,
  "origem"                TEXT NOT NULL,           -- CONTADOR | LEGADO_V1 | READBACK_FOCUS
  "ultimoCStat"           INTEGER NULL,
  "ultimaClasse"          TEXT NULL,
  "motivo"                VARCHAR(500) NULL,
  "requerInutilizacao"    BOOLEAN NOT NULL DEFAULT false,
  "leaseAte"              TIMESTAMP(3) NULL,
  "versao"                INTEGER NOT NULL DEFAULT 0,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "NfeNumeroReserva_estado_chk" CHECK ("estado" IN
   ('RESERVADO','REJEITADO','EM_TRANSMISSAO','INCERTO','BLOQUEADO',
    'AUTORIZADO','CANCELADO','DENEGADO','INUTILIZADO','CONSUMIDO_EXTERNO','ABANDONADO'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "NfeNumeroReserva_chave_numero_key"
  ON "NfeNumeroReserva" ("companyFiscalConfigId","ambiente","modelo","serie","numero");
-- PARTIAL: at most ONE live reservation per document (DB-level backstop for double click)
CREATE UNIQUE INDEX IF NOT EXISTS "NfeNumeroReserva_nfeId_viva_key"
  ON "NfeNumeroReserva" ("nfeId")
  WHERE "estado" IN ('RESERVADO','REJEITADO','EM_TRANSMISSAO','INCERTO','BLOQUEADO');
CREATE INDEX IF NOT EXISTS "NfeNumeroReserva_userId_estado_idx" ON "NfeNumeroReserva" ("userId","estado");

CREATE TABLE IF NOT EXISTS "NfeTentativaEmissao" (
  "id"              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "reservaId"       TEXT NOT NULL REFERENCES "NfeNumeroReserva"("id") ON DELETE RESTRICT,
  "nfeId"           TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "seq"             INTEGER NOT NULL,
  "provider"        TEXT NOT NULL,              -- FOCUS_NFE | SEFAZ_DIRECT
  "fase"            TEXT NOT NULL,              -- PREPARADA | TRANSMITINDO | RESPONDIDA | FECHADA
  "tpEmis"          INTEGER NULL,
  "chaveAcesso"     CHAR(44) NULL,              -- always 44 digits (strips Focus "NFe")
  "cNF"             CHAR(8) NULL,
  "dhEmi"           TIMESTAMP(3) NULL,
  "digestValue"     TEXT NULL,
  "xmlAssinadoPath" TEXT NULL,
  "conteudoSha256"  TEXT NOT NULL,              -- hash of the content excluding cNF/dhEmi (loop guard)
  "focusRef"        TEXT NULL,
  "nRec"            TEXT NULL,
  "httpStatus"      INTEGER NULL,
  "cStat"           INTEGER NULL,
  "cStatBruto"      VARCHAR(64) NULL,
  "codigoProvedor"  VARCHAR(64) NULL,
  "classe"          TEXT NULL,
  "prova"           TEXT NULL,                  -- RESPOSTA_DEFINITIVA | CONSULTA_217_MADURA | FOCUS_404_MADURO | ...
  "mensagem"        VARCHAR(500) NULL,          -- no headers/tokens
  "numeroLido"      INTEGER NULL,
  "serieLida"       INTEGER NULL,
  "transmitidaEm"   TIMESTAMP(3) NULL,
  "respondidaEm"    TIMESTAMP(3) NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "NfeTentativaEmissao_reserva_seq_key" ON "NfeTentativaEmissao" ("reservaId","seq");
CREATE INDEX IF NOT EXISTS "NfeTentativaEmissao_chave_idx" ON "NfeTentativaEmissao" ("chaveAcesso");
CREATE INDEX IF NOT EXISTS "NfeTentativaEmissao_nfeId_idx" ON "NfeTentativaEmissao" ("nfeId");
```

- **Signed XML storage:** new method `FiscalStorageService.saveXmlTentativa(userId, nfeId, seq, xml)`. The path is also written to the existing, currently unused column `NfeEmitida.xmlAssinadoPath` (`schema.prisma:1939`; nothing in `app/` references it). That is not DDL.
- **Docs:** the partial-index runbook must add `NfeNumeroReserva_nfeId_viva_key`, bringing the count of indexes outside the schema to 12.

---

## 3. (a) Pure classifier: `app/fiscal/numeracao/cstat-numeracao.ts` (NEW)

`lookupCStat` stays untouched, because provider parsers and the listing use it (`nfe.repository.ts:753-757`).

```ts
export type Contexto = "AUTORIZACAO" | "RET_RECIBO" | "CONSULTA_CHAVE"
  | "FOCUS_POST" | "FOCUS_GET" | "INUTILIZACAO" | "FOCUS_INUTILIZACAO";
export type Transporte = "TIMEOUT" | "ABORTADO" | "REDE" | "HTTP_5XX" | "HTTP_4XX_SEFAZ" | "CORPO_INVALIDO";
export interface RetornoBruto {
  contexto: Contexto;
  cStat?: number | string | null;      // accepts "974"
  httpStatus?: number | null;
  focusStatus?: string | null;         // autorizado|erro_autorizacao|processando_autorizacao|cancelado|denegado
  focusCodigo?: string | null;         // erro_validacao_schema|already_processed|nfe_autorizada|pending_operation|em_processamento|requisicao_invalida|empresa_nao_habilitada|permissao_negada|formato_invalido|nao_encontrado
  transporte?: Transporte | null;
  xMotivo?: string | null;
  temProtNFe?: boolean;
}
export type Efeito = "NAO_CONSUMIDO" | "CONSUMIDO" | "CONSUMIDO_EXTERNO_OU_NOSSO" | "INDETERMINADO";
export type Acao = "FINALIZAR_AUTORIZADA" | "MANTER_NUMERO_REJEITADA" | "MANTER_NUMERO_NAO_ENVIADA"
  | "CONSULTAR" | "RECONCILIAR_DUPLICIDADE" | "FECHAR_CONSUMIDO" | "BLOQUEAR";
export interface Classificacao { classe: Classe; efeito: Efeito; acao: Acao; cStat: number | null;
  chaveReferida: string | null; retryAposMs?: number; }

export function normalizarCStat(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && /^\s*\d{1,4}\s*$/.test(v)) return Number(v.trim());
  return null; // "erro_validacao_schema" -> null (raw value stays in cStatBruto)
}
export function extrairChaveReferida(xMotivo?: string | null): string | null {
  const m = (xMotivo ?? "").match(/(\d{44})/); return m ? m[1] : null; // format varies by UF
}
```

### 3.1 Classification table

**Order of precedence:** transport error, then Focus HTTP/codigo, then cStat by context.

**Sources:** MOC 7.0 Anexo I; NT 2024.001, in production since Sept/2024, which removed denegação for modelo 55 (302/303 became rejections, 307 is a new rejection, 781 is a rejection). Items marked *(verificar)* must be checked against the Anexo I PDF before coding.

**Retry rule** means what happens on the next POST `/issue` for the same `nfeId`.

| Class | Codes / signals | Number effect | Reservation state | `NfeEmitida.status` | Retry rule | Loop guard |
|---|---|---|---|---|---|---|
| `AUTORIZADA` | 100, 150 (protNFe / consultation); Focus `status=autorizado` (201 sync or GET) | CONSUMIDO | AUTORIZADO | AUTHORIZED | Never; `/issue` returns `jaEmitida` | none |
| `DUPLICIDADE_MESMA_CHAVE` | 204 (authorization; V1 already maps it to "processando", `sefaz-direct.provider.ts:898-910`) | owner unknown | EM_TRANSMISSAO, then reconcile | SENDING | Consult **that** chave: 100 with `digVal` equal to the attempt's DigestValue means ours, AUTORIZADO. 100 with a different digVal, or 217, is an anomaly: BLOQUEADO. | none |
| `DUPLICIDADE_CHAVE_DIFERENTE` | 539 (authorization), 613 in any context *(verificar)*, 561/562 **in CONSULTA_CHAVE context** | CONSUMIDO by chave C′ | EM_TRANSMISSAO, then reconcile | SENDING, then AUTHORIZED or REJECTED | C′ = `extrairChaveReferida`. If C′ belongs to one of our attempts on this reservation, consult it: 100 means AUTORIZADO. Otherwise consult **all** our attempts: any 100 means ours; all 217 (mature) means `CONSUMIDO_EXTERNO`, row REJECTED, and the **next attempt renumbers** (I1 holds: someone else owns the number). | L2 |
| `CANCELADA_NA_BASE` | 218 (authorization; the current description in `cstat-mapper.ts:72-75` is wrong, although the category effect is right); 101/151/155 (consultation) | CONSUMIDO | ours: BLOQUEADO + CRITICAL audit (cancelled outside Dexo); foreign: CONSUMIDO_EXTERNO | SENDING (ours) / REJECTED | foreign: renumber; ours: manual | none |
| `DENEGADA` | 110, 301 (legacy), 205 (authorization context) | CONSUMIDO | DENEGADO | REJECTED (cStat int) | Renumber after fixing | none |
| `INUTILIZADA_NA_BASE` | 206 | CONSUMIDO | INUTILIZADO (audit `INUTILIZADA_FORA_DO_DEXO` if no matching `NfeInutilizacao`) | REJECTED | Renumber | none |
| `EM_PROCESSAMENTO_NA_SEFAZ` | 103 (+nRec), 105, 104 without protNFe (`sefaz-direct.provider.ts:925-941`), **635**, 106 in RET_RECIBO *(verificar)*; Focus 202 / `processando_autorizacao` / 422 `pending_operation`\|`em_processamento` | INDETERMINADO | EM_TRANSMISSAO, then INCERTO when polling is exhausted | SENDING | Reconcile only (§7). **Never** renumber, never mark rejected. | L3 |
| `JA_PROCESSADA_FOCUS` | 422 `already_processed` \| `nfe_autorizada` | CONSUMIDO (probably) | EM_TRANSMISSAO | SENDING | GET the ref, then classify | L3 |
| `NAO_CONSTA` | 217 (CONSULTA_CHAVE only); Focus GET 404 `nao_encontrado` | NAO_CONSUMIDO **for that attempt, if mature** | stays open; once every attempt is closed, RESERVADO | SENDING while resending | Mature = at least 120 s since `transmitidaEm` (SEFAZ) or 60 s (Focus), and no open nRec. Then resend **identical XML** with the same number (§5.4). Immature: inconclusive. | L3 |
| `SERVICO_INDISPONIVEL` | 108, 109 at lote level; 113/114 SVC status *(verificar)* | NAO_CONSUMIDO (lote refused) | RESERVADO | REJECTED (motivo "SEFAZ indisponível") | Same number; SVC per §9 | backoff 60 s |
| `CERTIFICADO_TRANSMISSOR` | 280–286 **only**. 287–289 are content rejections (e.g. 289 "Código da UF informada diverge da UF solicitada"), so `contingencia.service.ts:86` is wrong. | NAO_CONSUMIDO | RESERVADO | REJECTED | Same number after fixing the cert. **Never SVC.** | L1 |
| `CONSUMO_INDEVIDO` | 656 | NAO_CONSUMIDO | RESERVADO | REJECTED | Same number, blocked for 60 min | L1 hard |
| `PRE_ENVIO_DEFINITIVO` (Focus) | POST 400 `requisicao_invalida`\|`empresa_nao_habilitada`, 401 (HTML), 403, 404, 415 `formato_invalido`, 422 `permissao_negada`, 429 (`retryAposMs` from Retry-After, else 60 s) | NAO_CONSUMIDO (never reached SEFAZ) | RESERVADO | REJECTED (motivo; cStatRejeicao null) | Same number | L1 |
| `REJEITADA` | **Every other integer code 200–999** (215/225 schema, 228, 302/303/307, 561/562 in AUTORIZACAO context, 704, 778, 781, 897, 974, 975, 999 …); Focus 422 `erro_validacao_schema`; Focus `erro_autorizacao` whose `status_sefaz` is not special | NAO_CONSUMIDO | REJEITADO | REJECTED (cStat int) | **Same number** after correcting | L1 |
| `EPEC` | 691/692 and any xMotivo containing "EPEC" *(verificar exact wording)* | INDETERMINADO | BLOQUEADO | SENDING | Manual (Dexo does not emit EPEC) | none |
| `INCERTO` | Transport TIMEOUT/ABORTADO/REDE; SEFAZ HTTP ≥400 after possible delivery (`sefaz-direct.provider.ts:292-298`); SOAP body without cStat; Focus POST 5xx or unreadable body; Focus GET 401/403/5xx/HTML | INDETERMINADO | INCERTO | SENDING | Consult before anything else (requirement 7) | L3 |
| `DESCONHECIDO` | null/0 or an unlisted 1xx | INDETERMINADO | INCERTO | SENDING | Consult | L3 |

### 3.2 Why 999 and "invalid field" rejections keep the number

Keeping the number can never double-authorize (§0.1). If a rejected attempt had in fact been authorized, the resend gets 539 or 204 pointing to **our** chave, and reconciliation recovers the authorization. A weak proof only matters when renumbering.

### 3.3 Loop guards

| Guard | Rule |
|---|---|
| L1 | Same `conteudoSha256` as the last attempt, and that attempt was `REJEITADA`/`PRE_ENVIO`/`CERTIFICADO`, and it happened less than 2 min ago: do not transmit; return the stored rejection with `bloqueioRepeticao:true`. After 2 min a resend is allowed, because some fixes happen outside Dexo (Kiko 974 needs the UPD authorization, and the payload is identical). 5 identical rejections within 1 h: blocked for 1 h (avoids 656). 656: blocked 60 min. |
| L2 | Two consecutive `CONSUMIDO_EXTERNO` in the same key within 24 h: key blocked with audit `CONTADOR_ATRAS_DA_NUMERACAO_EXTERNA`, message "ajuste o próximo número". Stops the counter from walking forward one number per click. |
| L3 | At most 3 polls × 3 s per request (same as V1, `nfe-emission.usecase.ts:466-467`), and at most one consultation per attempt every 30 s. |
| L4 | The reservation's skip loop stops after 50 numbers, throws, and the transaction rolls back, so nothing is burned. |

---

## 4. States: `app/fiscal/numeracao/estado-reserva.ts` (NEW, pure)

### 4.1 Allowed transitions (forbidden ones are tested)

```
RESERVADO       -> EM_TRANSMISSAO | ABANDONADO | INUTILIZADO
REJEITADO       -> EM_TRANSMISSAO | ABANDONADO | INUTILIZADO
EM_TRANSMISSAO  -> AUTORIZADO | REJEITADO | RESERVADO | INCERTO | DENEGADO | CONSUMIDO_EXTERNO | INUTILIZADO | BLOQUEADO
INCERTO         -> EM_TRANSMISSAO (reconcile/resend) | AUTORIZADO | REJEITADO | RESERVADO | DENEGADO | CONSUMIDO_EXTERNO | INUTILIZADO | BLOQUEADO
BLOQUEADO       -> (manual only)
AUTORIZADO      -> CANCELADO
terminals: CANCELADO, DENEGADO, INUTILIZADO, CONSUMIDO_EXTERNO, ABANDONADO
```

- **Forbidden:** `INCERTO → ABANDONADO`, `INCERTO → INUTILIZADO` (unless the inutilização comes from SEFAZ 206), `EM_TRANSMISSAO → ABANDONADO`, `AUTORIZADO → anything except CANCELADO`.
- **Mapping to the existing `NfeEmitida.status`:** no new status values, so listing and stats are unaffected. RESERVADO maps to DRAFT (local error) or REJECTED (provider refused); REJEITADO, DENEGADO, CONSUMIDO_EXTERNO and INUTILIZADO map to REJECTED; EM_TRANSMISSAO, INCERTO and BLOQUEADO map to SENDING; AUTORIZADO maps to AUTHORIZED; CANCELADO maps to CANCELLED.

### 4.2 Pure helpers (I1 and I4)

```ts
export function tentativaFechadaSemAutorizacao(t: TentativaView, agora: Date): boolean {
  if (t.fase === "PREPARADA") return true;                          // never transmitted (I3)
  if (t.prova === "RESPOSTA_DEFINITIVA" && NAO_CONSUMIDO.has(t.classe)) return true;
  if (t.prova === "CONSULTA_217_MADURA" || t.prova === "FOCUS_404_MADURO") return true;
  return false;
}
export function podeRenumerar(reserva: ReservaView, tentativas: TentativaView[], agora: Date): boolean {
  if (["CONSUMIDO_EXTERNO", "DENEGADO", "INUTILIZADO", "ABANDONADO"].includes(reserva.estado)) return true;
  return false; // REJEITADO/RESERVADO keep the number; INCERTO/EM_TRANSMISSAO/BLOQUEADO block
}
export const provaMadura = (transmitidaEm: Date, consultadaEm: Date, provider: string) =>
  consultadaEm.getTime() - transmitidaEm.getTime() >= (provider === "FOCUS_NFE" ? 60_000 : 120_000);
```

---

## 5. Emission V2 flow and (b) SEFAZ direct in two phases

### 5.1 Dispatch: the only line added to the existing path

```ts
// app/usecases/nfe-emission.usecase.ts — first line of emit() (line 91)
async emit(userId: string, nfeId: string): Promise<EmissionResult> {
  if (isNfeNumeracaoV2Enabled(userId)) return this.v2().emit(userId, nfeId);
  // ... V1 byte-identical ...
}
private v2() { // lazy; passes V1 private methods as callbacks (no visibility change)
  return (this._v2 ??= new NfeEmissaoV2Orchestrator({
    nfeRepo: this.nfeRepo, configRepo: this.configRepo, calculator: this.calculator,
    xmlBuilder: this.xmlBuilder, storage: this.storage, numeracao: new NfeNumeracaoService(),
    validate: (d, c) => this.validate(d, c),
    handleAuthorized: (...a) => this.handleAuthorized(...a),
    loadNfe: (id) => this.loadNfe(id),
    buildEmitenteSnapshot: (c) => this.buildEmitenteSnapshot(c),
    providers: defaultProviderFactories, // SEFAZ two-phase + Focus V2 client; injectable in tests
  }));
}
```

`finance.usecase.ts:1910` (PDV NFC-e) calls `emit()`, so it inherits V2 automatically. The return type is still `EmissionResult` with **optional** fields added (`emAndamento?`, `jaEmitida?`, `bloqueioRepeticao?`, `numeracao?`). Finance already maps SENDING/VALIDATING to "processing" (`finance.usecase.ts:1911-1917`).

### 5.2 Orchestrator: `app/usecases/nfe-emissao-v2.orchestrator.ts` (NEW)

```ts
async emit(userId, nfeId): Promise<EmissionResult> {
  const row = await loadAnyStatus(userId, nfeId);                  // findFirst {id,userId} with narrow select
  if (!row) throw new Error("Rascunho nao encontrado");             // same 404 message
  if (row.status === "AUTHORIZED") return resultFromRow(row, { jaEmitida: true });
  if (row.status === "CANCELLED" || row.status === "INUTILIZED") throw new Error(`NF-e nao pode ser emitida (status: ${row.status})`);

  if (["VALIDATING", "SIGNING", "SENDING"].includes(row.status)) {
    const live = await numeracao.reservaViva(nfeId);
    if (!live) return resultFromRow(row, { emAndamento: true,       // legacy row: decision 3 — no reconciliation
      mensagem: "Emissão anterior à numeração v2 em processamento — consulte o suporte" });
    if (live.leaseAte && live.leaseAte > now()) return resultFromRow(row, { emAndamento: true });
    if (live.estado === "EM_TRANSMISSAO" || live.estado === "INCERTO") return this.reconciliar(userId, row, live);
    if (live.estado === "RESERVADO" && !(await numeracao.temTentativaTransmitida(live.id)))
      await takeoverClaimVencido(nfeId);                             // updateMany status IN(VALIDATING,SIGNING) -> DRAFT
    else return resultFromRow(row, { emAndamento: true });
  }

  const draft = await nfeRepo.findDraftById(userId, nfeId);          // unchanged
  const config = await resolveConfig(draft);                         // same as nfe-emission.usecase.ts:111-126
  deps.validate(draft, config);                                      // no number touched
  const claimed = await prisma.nfeEmitida.updateMany({ /* identical to :147-150 */ });
  if (claimed.count === 0) return resultFromRow(await loadAnyStatus(userId, nfeId), { emAndamento: true }); // (d) no 500

  let fase: "PRE" | "TRANSMITINDO" = "PRE";
  let tentativa: TentativaView | null = null;
  try {
    // calc + persistCalculo: identical to :162-217
    const key = { cfc: config.id, ambiente: config.ambiente, modelo, serie: draft.serie,
                  isDefault: draft.companyFiscalConfigId ? (config.isDefault ?? true) : true };
    const reserva = await numeracao.obterOuReservar(userId, nfeId, key, legacyView(draft));
    await writeRowNumero(nfeId, reserva.numero, config);             // same data as :262-278
    await nfeRepo.addAuditLog(nfeId, userId, "NUMERADA", { numero: reserva.numero, serie: draft.serie,
      reservaId: reserva.id, origem: reserva.origemDecisao });
    await transition("VALIDATING", "SIGNING");

    const nfe = await deps.loadNfe(nfeId);
    const prep = isSefazDirect
      ? await prepararSefaz(nfe, config, reserva)                      // §5.3; throws LOCALLY
      : prepararFocus(nfe, config, reserva);                           // §6
    const guard = await numeracao.guardRepeticao(reserva.id, prep.conteudoSha256);  // L1
    if (guard.bloqueado) return await finalizarNaoEnviada(nfeId, guard.ultimaRejeicao, { bloqueioRepeticao: true });

    tentativa = await numeracao.registrarTentativa(reserva, prep);   // fase PREPARADA (xml already on disk)
    await saveXmlOriginal(...); await transition("SIGNING", "SENDING"); await audit("ENVIADA");
    await numeracao.marcarTransmitindo(tentativa, leaseAte(config)); // COMMIT before the network (I3)
    fase = "TRANSMITINDO";

    const bruto = isSefazDirect
      ? await sefaz.transmitirPreparada(prep.sefaz, nfeId)
      : await focusV2.emitir(prep.focusPayload, nfeId, config.providerToken!);
    const cls = classificarRetorno(bruto.retorno);
    await numeracao.registrarResposta(tentativa, bruto, cls);
    return await this.aplicar(userId, nfeId, config, reserva, tentativa, bruto, cls); // §5.5
  } catch (err) {
    if (fase === "PRE") {                                            // nothing left the machine
      await forceStatus(nfeId, "DRAFT");                             // same as V1 :551-556
      await audit("EDITADA_DRAFT", { motivo: "Erro antes do envio - numero mantido", erro: msg(err) });
      // reservation stays RESERVADO -> retry reuses the number (case 1)
    } else {
      await numeracao.marcarIncertoSeAberta(tentativa!);             // never downgrades a terminal state
      await audit("ENVIO_INCERTO", { motivo: "Erro apos envio - reconciliar", erro: msg(err) });
    }
    throw err;
  }
}
```

### 5.3 SEFAZ direct in two phases (provider interface unchanged, `emitir()` untouched)

New **public methods on the class** in `app/fiscal/providers/sefaz-direct.provider.ts`, not on the `INfeProvider` interface. `emitir()` (`:156-303`) and its tests stay as they are. Adding them duplicates about 50 lines of build/sign/QR code; that is an accepted cost to keep existing behavior exactly the same. They reuse the module-private `parseRetEnviNFe`, `parseRetConsSitNFe`, `extractTagBlock` and `buildNfeProc`.

```ts
export interface SefazNfePreparada {
  modelo: "55" | "65"; tpEmis: 1 | 6 | 7; contingencia?: "SVC_AN" | "SVC_RS";
  chaveAcesso: string; cNF: string; dhEmi: Date; signedXml: string; digestValue: string;
}
/** Build + sign (+ QR for 65). THROWS on any local failure. Never touches the network. */
prepararEmissao(p: SefazEmitPayload): SefazNfePreparada {
  // identical to :179-251 BUT throw instead of makeEmitErrorResult; respTec: resolveRespTecFromEnv() (same
  // call as :197 — the per-company RT workstream must update BOTH call sites)
  // digestValue = extractDigestValue(signedXml)  (new app/fiscal/sefaz/digest.ts: <DigestValue> of the infNFe Reference)
}
export interface SefazTransmissao extends NfeProviderEmitResult {
  origemCStat: "PROT" | "LOTE" | null; nRec: string | null; transporte: Transporte | null; httpStatus: number | null;
}
async transmitirPreparada(p: SefazNfePreparada, ref: string): Promise<SefazTransmissao> {
  // envelope: buildEnviNFeEnvelope({ signedNfeXml: p.signedXml, tpAmb, idLote: defaultIdLote(), indSinc: "1" })
  // idLote is NOT part of the signature/chave -> a new idLote on resend keeps the chave
  // endpoint: same choice as :265-269 (by p.contingencia / p.modelo)
  // catch soap -> transporte "TIMEOUT"|"REDE" (INCERTO class); status>=500 -> "HTTP_5XX"; >=400 -> "HTTP_4XX_SEFAZ"
  // otherwise parseRetEnviNFe(body, p.chaveAcesso, p.signedXml, ref) + raw lote/prot cStat + nRec (:947)
}
export interface SefazConsultaDetalhada extends NfeProviderConsultaResult {
  cStatBruto: number | null; digVal: string | null; protNFeXml: string | null; transporte: Transporte | null;
}
async consultarDetalhado(chave: string): Promise<SefazConsultaDetalhada>          // same SOAP as :305-366
async consultarReciboDetalhado(nRec: string, chave: string): Promise<SefazConsultaDetalhada> // same as :376-428
```

How the orchestrator uses them:

- **`prepararSefaz`:** if the reservation's last attempt was closed with proof `CONSULTA_217_MADURA`, its XML is on disk, and it passes the "resend identical" rule (§5.4), then `signedXml` is **read from storage** and nothing is rebuilt. Otherwise `sefaz.prepararEmissao({ draft, config, numero })`, which gives a new cNF and dhEmi (`chave-acesso.ts:141`, builder default `dhEmi = new Date()` at `nfe-xml-builder-sefaz.service.ts:96`). The XML is saved with `storage.saveXmlTentativa` **before** `registrarTentativa`.
- **SOAP retries:** `SoapClientService` already resends the **same envelope** on ETIMEDOUT/ECONNRESET/ECONNABORTED/ENOTFOUND/EAI_AGAIN and on 5xx (`soap-client.service.ts:96-129, 211-221`). A duplicate delivery can at worst return 204 for our own chave, which gets reconciled. Since the provider only sees the last error, any transport exception is classified as **INCERTO**. Consultation resolves it cheaply.
- **Authorization recovered by consultation:** nfeProc = `buildNfeProc(signedXml stored, protNFeXml)` (`sefaz-direct.provider.ts:1117-1125`), passed as `xmlAutorizadoInline` to `handleAuthorized`. This removes `XML_AUTORIZADO_PENDENTE` for V2 rows. Ownership proof: `digVal` from the consultation equals the attempt's `digestValue` (the parser already reads `digVal`, `nfe-xml-parser.service.ts:147,419`).

### 5.4 When an identical resend is allowed, and why I4 is needed

- **Rule:** after `NAO_CONSTA` (mature), resend the same bytes when modelo 55 and dhEmi is less than 24 h old, or modelo 65 and dhEmi is less than 4 min old (NFC-e gets 704 for a late dhEmi). Otherwise rebuild with the **same number** and a new cNF/dhEmi.
- **Why rebuilding is safe:** if the old attempt A turns out authorized after all, the new attempt B gets 539 pointing to chave A, A is one of our attempts, so reconciliation marks it AUTORIZADO. SEFAZ never authorizes both.
- **No editing window:** between the 217 and the resend the row stays `SENDING` and the resend happens in the same request. That way the user cannot edit the note and A's content cannot diverge from B's. `updateDraft` already refuses SENDING rows (`nfe.repository.ts:413-418`).
- **Why a later rejection is not proof (I4):** SEFAZ does not guarantee that the 204 duplicity check runs before, say, 704. A 704 on resend B says nothing about attempt A.

### 5.5 `aplicar()`: from classification to effects

Every write is a single update per row, with no partial commits.

```ts
switch (cls.acao) {
  case "FINALIZAR_AUTORIZADA":
    await numeracao.fechar(reserva, "AUTORIZADO", cls);
    if (isFocus) await focusReadback(...);                          // §6.3
    return deps.handleAuthorized(nfeId, userId, numeroReal, serieReal, normalizarChave(bruto.chaveAcesso),
                                 bruto.protocolo, bruto.dataAutorizacao, providerCompat, config, bruto.xmlAutorizado);
  case "MANTER_NUMERO_REJEITADA": case "MANTER_NUMERO_NAO_ENVIADA":
    await numeracao.fechar(reserva, cls.acao === "MANTER_NUMERO_REJEITADA" ? "REJEITADO" : "RESERVADO", cls);
    return handleRejectedV2(nfeId, userId, reserva, bruto.mensagem, cls.cStat); // ONE update: status+motivo+cStat(int|null)
  case "FECHAR_CONSUMIDO":                                          // DENEGADA / INUTILIZADA_NA_BASE / foreign
    await numeracao.fechar(reserva, estadoDe(cls), cls);            // next obterOuReservar will renumber
    return handleRejectedV2(nfeId, userId, reserva, mensagemRenumeracao(cls), cls.cStat);
  case "CONSULTAR": case "RECONCILIAR_DUPLICIDADE":
    return this.reconciliar(userId, row, reserva, { pollNoRequest: true });
  case "BLOQUEAR":
    await numeracao.fechar(reserva, "BLOQUEADO", cls); await audit("NUMERACAO_BLOQUEADA_CRITICO", {...});
    return pendingV2(nfeId, reserva, "Situação exige conferência manual");
}
```

### 5.6 Reservation: `NfeNumeracaoRepository.obterOuReservar` (one `prisma.$transaction`, raw SQL)

```sql
-- 1) live reservation of the document (serializes same nfeId across processes)
SELECT * FROM "NfeNumeroReserva" WHERE "nfeId"=$nfeId
  AND "estado" IN ('RESERVADO','REJEITADO','EM_TRANSMISSAO','INCERTO','BLOQUEADO') FOR UPDATE;
```

```ts
if (live) {
  if (live.estado in {EM_TRANSMISSAO, INCERTO, BLOQUEADO}) throw new ReconciliarAntesError();   // I1
  if (sameKey(live, key) && row.numero === live.numero && !coberturaInutilizacao(live)) return live; // reuse
  // key changed (I2 / U3) OR V1 overwrote the number during a flag rollback:
  UPDATE live SET estado='ABANDONADO', motivo=(sameKey ? 'FLAG_ROLLBACK_V1' : 'CHAVE_DE_NUMERACAO_ALTERADA'),
                  requerInutilizacao=(live.ambiente='PRODUCAO');
}
if (!live && isLegacyRejectedReusable(row, key)) {
  // legacy row (no ledger): EXACTLY the V1 rule, plus stricter guards
  //   shouldReuseNumero(row, key.ambiente, isNfeReemissaoRejeitadaEnabled())      (nfe-number-reuse.ts:51)
  //   && classificarRetorno({contexto:"AUTORIZACAO", cStat: row.cStatRejeicao}).classe === "REJEITADA" // removes 205/206/110/301 (U1)
  //   && (row.cfc === key.cfc || (row.cfc == null && key.isDefault)) && row.serie === key.serie && row.modelo === key.modelo // U3
  //   && !inutilizacaoCobre(key, row.numero)                                                             // U2
  INSERT ... (numero=row.numero, estado='REJEITADO', origem='LEGADO_V1') ON CONFLICT DO NOTHING RETURNING id;
  if (inserted) return it;
}
```

```sql
-- 2) counter lock: SAME statement shape as nfe-sequence.service.ts:143-150 (legacy-row adoption included)
-- 3) loop (max 50, L4):
--      n := proximoNumero
--      taken := EXISTS NfeEmitida(key, numero=n, id<>$nfeId, incl. cfc NULL of the default emitter via userId)
--            OR EXISTS NfeInutilizacao(status IN ('ACEITA','PENDENTE'), key, n BETWEEN ini AND fim, modelo='55')
--      UPDATE "NfeSequence" SET "proximoNumero"=n+1, "companyFiscalConfigId"=$cfc, "updatedAt"=NOW() WHERE id=$seq
--      if taken: audit NUMERO_PULADO(n); continue
--      INSERT reserva(key, n, nfeId, 'RESERVADO', 'CONTADOR') ON CONFLICT DO NOTHING RETURNING id
--      no row: re-SELECT live by nfeId -> if present return it (concurrent same doc) else audit NUMERO_PULADO; continue
--      return
-- 4) first emission in this key: same INSERT ... ON CONFLICT DO NOTHING RETURNING logic as :188-208
```

- A throw anywhere rolls back the counter bump and the insert together. Nothing is lost and there is no numbering by row count.
- Deliberately **no pool of abandoned numbers**: "a new document gets the next number" (I5), abandoned numbers are never reassigned, and they are reported as needing inutilização (user decision 3).
- **Document identity is the row.** "Nova NF-e" can reopen the latest DRAFT (`nfe.repository.ts:225-235`), which may hold a `RESERVADO` 101. Getting 101 then is correct (never consumed). Skipping it would create a gap, so it is not recommended.

---

## 6. (c) Focus V2 client: `app/fiscal/providers/focus-nfe-v2.client.ts` (NEW)

`FocusNfeProvider` stays untouched, so `focus-nfce-path.spec.ts` and `provider-contract.spec.ts` are unaffected.

### 6.1 HTTP client

```ts
export interface FocusResposta { httpStatus: number | null; transporte: Transporte | null;
  body: Record<string, any> | null; textoBruto: string | null /* truncated to 500, never headers */; }
async function focusFetch(url, init, timeoutMs): Promise<FocusResposta> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();                       // 401 comes as text/html (B4)
    let body = null; try { body = JSON.parse(text); } catch {}
    return { httpStatus: res.status, transporte: body || res.status < 500 ? null : "HTTP_5XX", body, textoBruto: text.slice(0, 500) };
  } catch (e) {
    return { httpStatus: null, transporte: isAbort(e) ? "ABORTADO" : "REDE", body: null, textoBruto: null };
  }
}
// POST timeout FOCUS_POST_TIMEOUT_MS (default 45000); GET FOCUS_GET_TIMEOUT_MS (15000)
```

### 6.2 Mapping into `RetornoBruto`

**POST `/v2/{nfe|nfce}?ref=nfeId`** (the ref stays `nfeId`, because cancellation uses it: `nfe-cancelamento.usecase.ts:110`):

| Focus response | Mapped to |
|---|---|
| `transporte != null` (abort, network) | `INCERTO`, then GET ref |
| 5xx, or 2xx/422 with an unreadable body | `INCERTO` |
| 201/200 with `body.status==="autorizado"` | `AUTORIZADA`, read `numero`/`serie`/`chave_nfe` (current OpenAPI: sync authorization) |
| 201/202 with `processando_autorizacao` (or no status) | `EM_PROCESSAMENTO`, poll GET |
| 422 `erro_validacao_schema` | `REJEITADA` (never reached SEFAZ) |
| 422 `already_processed` \| `nfe_autorizada` | `JA_PROCESSADA_FOCUS`, GET |
| 422 `pending_operation` \| `em_processamento` | `EM_PROCESSAMENTO` |
| 422 `permissao_negada`; 400/401/403/404/415 | `PRE_ENVIO_DEFINITIVO` |
| 429 | `PRE_ENVIO_DEFINITIVO` with `retryAposMs` |

**GET `/v2/{nfe|nfce}/{ref}`:**

| Focus response | Mapped to |
|---|---|
| 200 `autorizado` | `AUTORIZADA` |
| 200 `cancelado` | `CANCELADA_NA_BASE` (ours) |
| 200 `denegado` (legacy) | `DENEGADA` |
| 200 `erro_autorizacao` | classify `normalizarCStat(status_sefaz)` in AUTORIZACAO context (e.g. "539" means duplicity, "974" means REJEITADA) |
| 200 `processando_autorizacao` | `EM_PROCESSAMENTO` |
| 404 `nao_encontrado` | `NAO_CONSTA` (mature ≥60 s) |
| 401/403/5xx/HTML/network | `INCERTO`. **Never** read as "not found": that is the V1 default `?? "processando"` without a `res.ok` check (`focus-nfe.provider.ts:141-155`). |

### 6.3 Dexo controls the numbering, then reads the real number back (user decision 1)

**Payload** (only with V2 and `isFocusEnviaNumeroEnabled()`):

```ts
const payload = xmlBuilder.build(nfe, config, reserva.numero);  // unchanged builder
payload.numero = String(reserva.numero);                          // real Focus field
payload.serie  = String(nfe.serie);                               // already there (nfe-xml-builder.service.ts:57)
// numero_nota stays as it is (Focus ignores it; removing it changes nothing and V1 snapshots stay identical)
```

- The same applies to NFC-e through Focus.
- `conteudoSha256` = sha256 of the stable-stringified payload without `data_emissao`.

**Read-back on every authorization** (pure: `app/fiscal/numeracao/focus-readback.ts`):

```ts
export function lerNumeroDaChave(chave: string): { serie: number; nNF: number; chave44: string } {
  const p = parseChave(chave.replace(/\D/g, ""));  // chave-acesso.ts:181 (validates DV; strips "NFe")
  return { serie: Number(p.serie), nNF: Number(p.nNF), chave44: chaveToString(p) };
}
export function decidirReadback(reservado: { numero: number; serie: number },
                                lido: { nNF: number; serie: number }, proximoNumero: number) {
  if (lido.nNF === reservado.numero && lido.serie === reservado.serie) return { tipo: "OK" };
  return { tipo: "DIVERGENTE", avancarContadorPara: lido.nNF >= proximoNumero ? lido.nNF + 1 : null };
}
```

When the numbers diverge (e.g. Focus renumbered itself in contingency):

1. Audit `NUMERO_DIVERGENTE_FOCUS` with reserved and actual numbers.
2. The original reservation becomes `ABANDONADO` (`requerInutilizacao` = ambiente is PRODUCAO).
3. `INSERT` a reservation for the actual number (`AUTORIZADO`, origem `READBACK_FOCUS`) with ON CONFLICT. If that conflicts with another document's live reservation, mark that one `BLOQUEADO` and audit `CRITICO_NUMERO_EM_DOIS_DOCUMENTOS`.
4. `UPDATE NfeEmitida SET numero, serie` to the actual values. On P2002, keep the reserved number on the row and audit `CRITICO`.
5. `NfeSequenceService.ajustarProximoNumero` only moves forward (`nfe-sequence.service.ts:248-275`), so it is used when `avancarContadorPara` is set.

**Chave format:** V2 writes `chaveAcesso` as 44 digits. Legacy rows keep the 47-character `NFe` form; nothing is rewritten.

### 6.4 Things to surface, not fix

Two Focus tokens are each shared by two different tenants. That does not collide numbering (refs are cuids and CNPJs differ), but it is an isolation problem. Kiko's 974 falls in the `REJEITADA` class, so the number is kept. The external fix (Kiko or the contador authorizing Focus in the PR UPD system) happens outside Dexo, which is why L1 allows a retry after 2 minutes.

---

## 7. Reconciliation: `app/fiscal/numeracao/reconciliacao.ts`

A pure decision function plus a thin I/O orchestrator. There is **no cron**. It runs only on explicit action: POST `/issue` on a SENDING V2 row, or `POST /fiscal/nfe/:id/consultar-situacao` (V2 only; returns 409 "nota anterior à numeração v2" for legacy rows, per decision 3).

```ts
async reconciliar(userId, row, reserva) {
  if (!(await numeracao.tomarLease(reserva, 3 * 60_000))) return pendingV2(..., { emAndamento: true }); // optimistic "versao"
  const tentativas = await numeracao.tentativas(reserva.id);                    // newest first
  const agora = new Date();
  for (const t of tentativas.filter(abertas)) {
    let r: RetornoBruto;
    if (t.provider === "SEFAZ_DIRECT") {
      const sefaz = await sefazFor(configDoProvider(t));                        // credentials of the ATTEMPT's provider
      const c = t.nRec && !t.reciboFechado ? await sefaz.consultarReciboDetalhado(t.nRec, t.chaveAcesso)
                                           : await sefaz.consultarDetalhado(t.chaveAcesso);
      r = { contexto: t.nRec ? "RET_RECIBO" : "CONSULTA_CHAVE", cStat: c.cStatBruto, transporte: c.transporte,
            xMotivo: c.mensagem, temProtNFe: !!c.protNFeXml };
      if (classe(r) === "AUTORIZADA" && c.digVal !== t.digestValue) r = anomalia("DIGVAL_DIVERGENTE");     // -> BLOQUEAR
    } else {
      r = await focusV2.consultar(t.focusRef!, token);                          // FOCUS_GET
    }
    const cls = classificarRetorno(r);
    if (cls.classe === "NAO_CONSTA" && !provaMadura(t.transmitidaEm, agora, t.provider)) continue; // inconclusive (I4)
    if (cls.classe === "DUPLICIDADE_CHAVE_DIFERENTE") { /* C' among our attempts? consult C'; else check all */ }
    await numeracao.registrarConsulta(t, r, cls);                               // prova = CONSULTA_217_MADURA etc.
    if (cls.acao === "FINALIZAR_AUTORIZADA") return aplicarAutorizadaViaConsulta(t, c);  // nfeProc = stored XML + protNFe
    if (terminalConsumido(cls)) return aplicar(...);
  }
  if (todasFechadasSemAutorizacao(tentativas, agora))                         // I1/I4
    return this.reenviarMesmoNumero(userId, row, reserva);                      // §5.4, same request, row stays SENDING
  await numeracao.fechar(reserva, "INCERTO", null);
  return pendingV2(row, reserva, "Situação ainda indefinida na SEFAZ — consulte novamente em instantes");
}
```

Notes:

- **Provider switch while an attempt is open (requirement 14):** reconciliation uses the provider stored on the attempt. If its credentials are gone (e.g. the Focus token was removed), the reservation stays `INCERTO` and only that document is blocked. Other documents keep reserving 102, 103 and so on.
- **Lease:** `leaseAte = now + SEFAZ_TIMEOUT_MS × (SEFAZ_RETRY_MAX + 1) + 60 s`. The defaults are 60 s and 3 retries (`soap-client.service.ts:228-238`), so about 5 min. Focus uses 2 min.

---

## 8. (d) POST /issue idempotency and the frontend

### 8.1 Backend

- **Claim loser:** today it throws at `nfe-emission.usecase.ts:151-155`, and the route turns that into a **500** because no substring matches (`fiscal.routes.ts:943-956`). Under V2 it returns HTTP 200 with the row's current status and `emAndamento:true`.
- **Already authorized:** today `findDraftById` returns null and the user sees "Rascunho nao encontrado" (404). Under V2 it returns 200 with `jaEmitida:true`, status AUTHORIZED, numero and chave.
- **SENDING with a live lease:** returns `emAndamento`. With the lease expired, it reconciles (§7).
- **No route change needed**, because the V2 result never throws in those cases. The only route addition is `POST /nfe/:id/consultar-situacao`, which returns 404 when the flag is OFF.
- **Proxy 504 while the server keeps working:** a client retry falls into `emAndamento`, then reconciliation. No 101/102/103.

### 8.2 Frontend (pure module, node tests; jsdom is broken)

`app/notas-fiscais/lib/nfe-emitir-decisao.ts` (NEW):

```ts
export function podeDispararEmissao(s: { draftId: string | null; emEnvioRef: boolean }): boolean {
  return !!s.draftId && !s.emEnvioRef;
}
export type InterpretacaoEmissao =
  | { tipo: "AUTORIZADA"; toast: string; redirecionar: true }
  | { tipo: "EM_ANDAMENTO"; toast: string } | { tipo: "PENDENTE_SEFAZ"; toast: string }
  | { tipo: "REJEITADA"; toast: string; mesmoNumero: boolean } | { tipo: "ERRO"; toast: string };
export function interpretarRespostaEmissao(httpOk: boolean, body: any): InterpretacaoEmissao { /* table-driven */ }
/** V2: any REJECTED row can be retried — the server decides the number (never the UI). */
export function podeTentarNovamente(n: { status: string; reaproveitavel?: boolean }, v2: boolean): boolean {
  return v2 ? n.status === "REJECTED" : n.status === "REJECTED" && !!n.reaproveitavel;
}
```

### 8.3 Wizard and list changes

- **Wizard** (`nfe-wizard.tsx:457-466`, behind `NEXT_PUBLIC_NFE_NUMERACAO_V2_UI_ENABLED`): `const emEnvioRef = useRef(false)`, set **synchronously** before `await saveCurrentStep()`. Today `isEmitting` is only set after the await, which leaves a double-click window. Reset in `finally`. Use `interpretarRespostaEmissao` for the toast.
- **List** (`nfe-list.tsx:784-799`): the retry button uses `podeTentarNovamente`. The backend listing (`nfe.repository.ts:753-757`) is unchanged; the extra rule is purely client-side.

### 8.4 Optional P3 control against S1

Under V2, `POST /fiscal/nfe/draft` with an `orderId` returns 409 when another row for the same `orderId` has a reservation in `EM_TRANSMISSAO`, `INCERTO` or `BLOQUEADO`.

---

## 9. (f) SVC contingency under V2

**Decision:**
- With V2 OFF, `SEFAZ_AUTO_FALLBACK_ENABLED` keeps exactly today's behavior (`nfe-emission.usecase.ts:377-454`, `contingencia.service.ts` untouched; its tests `tests/fiscal/sefaz/contingencia.spec.ts:60-63` assert 280–289 falls back).
- With V2 ON, the orchestrator ignores `shouldFallbackToSvc` and uses a new function in `app/fiscal/numeracao/contingencia-v2.ts`.

```ts
export function decidirSvcV2(cls: Classificacao, flagFallback: boolean, modelo: "55" | "65"):
  { usarSvc: boolean; motivo: string } {
  if (!flagFallback || modelo === "65") return { usarSvc: false, motivo: "desligado/NFC-e sem SVC" };
  if (cls.classe === "SERVICO_INDISPONIVEL") return { usarSvc: true, motivo: `cStat ${cls.cStat}: lote NÃO recebido pela origem` };
  return { usarSvc: false, motivo: "SVC só com indisponibilidade declarada pela origem" };
}
```

**Why this rule:**

- **108/109 are allowed.** The origin answered and said it did not receive the lote, so nothing is in flight. The same reservation gets a new attempt (`prepararEmissao({ ..., contingencia })` gives tpEmis 6/7 and a new chave), recorded **before** sending. The number stays the same, because the origin never saw it.
- **280–286 are not allowed.** They are our own certificate problem, and SVC would reject too. 287–289 are content errors.
- **Timeout followed by 217 does not trigger SVC.** This is the V1 path at `nfe-emission.usecase.ts:423-437`. After uncertainty, the rule the task attributes to MOC Anexo III §2.3.3 applies (the exact wording was not checked): do not renumber on a guess, contingency uses a **new document with a new number**, and the pending one is later cancelled if authorized or inutilized if not. V2 never does that automatically. The row stays `INCERTO` and a new contingency document is a manual action.
- **SVC answering 113/114 (SVC disabled):** classified `SERVICO_INDISPONIVEL`; the reservation stays `RESERVADO`.
- **Recommendation:** check on the VPS (read-only) the current value of `SEFAZ_AUTO_FALLBACK_ENABLED`, documented default false (`docs/fiscal-sefaz-direto.md:198`), and keep it off.

---

## 10. (g) Inutilização V2

Branch at the top of `NfeInutilizacaoUseCase.inutilizar` (`nfe-inutilizacao.usecase.ts:59`), behind the flag. Implementation in `app/fiscal/numeracao/inutilizacao-v2.ts`.

### 10.1 Guard

The guard is pure over the rows passed in. Key = (cfc, ambiente, "55", série). Tested per number in the range:

```ts
export function avaliarFaixa(input: { ini: number; fim: number; proximoNumero: number;
  reservas: ReservaView[]; notas: { numero: number; status: string }[]; descartarReservas: boolean }):
  { permitido: boolean; bloqueios: { numero: number; motivo: string }[]; reservasADescartar: string[] }
// BLOCK: note AUTHORIZED|CANCELLED|SENDING|VALIDATING|SIGNING; reservation AUTORIZADO|CANCELADO|DENEGADO|
//        EM_TRANSMISSAO|INCERTO|BLOQUEADO|CONSUMIDO_EXTERNO|INUTILIZADO
// RESERVADO|REJEITADO (and legacy REJECTED with numero in the range): only with descartarReservas=true
//        -> on success they become INUTILIZADO (the document RENUMBERS on the next emission — never 206 again)
```

### 10.2 Order of operations (no lock held across the network)

1. **Ranges fully below `proximoNumero`:** guard only. Reservations never take numbers below the counter, so no race.
2. **Ranges that reach the counter:** in one transaction, lock `NfeSequence` (same SQL), run the guard, create `NfeInutilizacao` as PENDENTE, move the counter **forward** past `fim`, commit. Reservations skip PENDENTE ranges (§5.6).
3. **Provider call:**
   - SEFAZ: unchanged (`sefaz-direct.provider.ts:543-616`), but the V2 classification reads the cStat with its own table instead of `parseRetInutNFe`'s "duplicidade is success" rule (`:1238-1241`).
   - Focus: new client. `success = body.status === "autorizado" && normalizarCStat(body.status_sefaz) === 102`, with `protocolo = body.protocolo_sefaz` (per Focus docs).
4. **Outcome codes:**

| Result | Handling |
|---|---|
| 102 | ACEITA; reservations to discard become `INUTILIZADO`; counter already moved |
| 563 "já existe pedido de inutilização com a mesma faixa" *(verificar)* | ACEITA without protocol, audited |
| 241 "um número da faixa já foi utilizado" | REJEITADA plus hint "possível autorização não registrada — rode consultar-situação/diagnóstico" |
| 256 "uma NF-e da faixa já está inutilizada" | REJEITADA plus hint for a partial range |
| Anything else | REJEITADA. Numbers the counter skipped in step 2 are recorded as `ABANDONADO` with `requerInutilizacao`. **Never `numero--`.** |

### 10.3 Gaps outside scope (reported, not fixed)

- NFC-e cannot be inutilized in Dexo: modelo `"55"` is hardcoded at `sefaz-direct.provider.ts:556`, Focus uses `/v2/nfe/inutilizacao` (`focus-nfe.provider.ts:239`), and `NfeInutilizacao` has no `modelo` column (`schema.prisma:2007-2024`).
- `serie < 1` rejects série 0 (`nfe-inutilizacao.usecase.ts:67`), even though série 0 is valid.
- **The inutilização screen must not offer "inutilizar todas as lacunas".** That would hide the counter bug instead of fixing it. The gaps come from the report (§12).

### 10.4 Cancellation hook

`nfe-cancelamento.usecase.ts:135-146`: after the successful update, and only under V2, `numeracao.marcarCancelado(nfeId)` best-effort (wrapped in try/catch; it never breaks the cancellation).

---

## 11. (e) Concurrency proof and test plan

### 11.1 What a real Postgres is needed for (opt-in, off in CI)

`tests/fiscal/db/nfe-numeracao.pg.spec.ts` uses `describe.skipIf(!process.env.NFE_PG_TEST_URL)`.

```
docker run --rm -d --name dexo-pg-num -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:15-alpine
NFE_PG_TEST_URL=postgresql://postgres:test@localhost:55432/postgres \
  npx vitest run tests/fiscal/db --pool=forks
```

**Bootstrap** (inside the spec, with `$executeRawUnsafe`):
- minimal `CREATE TABLE` for `NfeSequence`, `NfeEmitida` (id, userId, cfc, ambiente, modelo, serie, numero, status) and `NfeInutilizacao`;
- the partial unique indexes copied from `docs/multi-cnpj-sql.md:77-86`;
- **the V2 DDL file read verbatim**, which also proves it is valid SQL.

**Clients:** `NfeNumeracaoRepository` takes the client in its constructor (`constructor(private db = prisma)`). The test creates **two** `new PrismaClient({ datasourceUrl })` instances (Prisma 6.2.1) to simulate two API processes, each with `connection_limit=10`. Only raw SQL is used, so the new models do not need to be generated.

| Test | Proves |
|---|---|
| 40 concurrent `obterOuReservar` (20 per client, random jitter), same key | numbers are exactly {1..40}, counter = 41, 40 reservations (**FOR UPDATE for real**) |
| First emission in a new key, 10 concurrent | exactly one gets 1; no gaps (race on `INSERT … ON CONFLICT DO NOTHING RETURNING`) |
| Same `nfeId`, 10 concurrent | one live reservation; the others return it (**partial unique index works**) |
| Throw inside the transaction after the bump | counter unchanged, no reservation (no gap on rollback) |
| Interleaved keys: tenants A/B, séries 1/3, HOMOLOG/PROD | independent sequences (requirements 11–13 at DB level) |
| Seeded historic `NfeEmitida` numero=5, counter=5 | reservation returns 6 and audits `NUMERO_PULADO` (B10) |
| Inutilização step 2 concurrent with reservations | no reservation lands inside the PENDENTE range |

**Only mocks can cover:** SEFAZ/Focus responses, timeouts (fake timers plus AbortSignal), crashes between phases (storage or transition mock throws), digest comparison, and the application logic of the 14 cases. Mocks **cannot** prove locking; that is what the pg test is for.

### 11.2 Test specs

All run with vitest `--pool=forks` and follow the `vi.hoisted` pattern of `tests/fiscal/nfe-emission-company.spec.ts`.

| File | Covers |
|---|---|
| `tests/fiscal/numeracao/cstat-numeracao.spec.ts` | Table-driven over every code in §3 × context; strings "974"/"100"/"erro_validacao_schema"; 200–999 ranges; 287/288/289 are REJEITADA; 280–286 are CERTIFICADO; 205/206/110/301 are consumed; 635 in flight; 217 in AUTORIZACAO context is DESCONHECIDO; chave extracted from 539; every Focus codigo/status |
| `.../estado-reserva.spec.ts` | Complete transition matrix; `podeRenumerar`; `provaMadura` boundaries (119 s / 120 s) |
| `.../focus-client-v2.spec.ts` | fetch stub: 201 autorizado with numero/serie; 202; 401 HTML (no throw); 422 × every codigo; 429 Retry-After; 5xx; abort; GET 404/403/HTML; chave `NFe` normalization; inutilização 200 + `erro_autorizacao` gives failure; `protocolo_sefaz` |
| `.../sefaz-two-phase.spec.ts` | `prepararEmissao` deterministic with dhEmi/cNF override (uses `tests/fiscal/__helpers__/test-certificate.ts`); throws on missing codMunicipio; `transmitirPreparada` sends `signedXml` **byte-identical**; DigestValue extracted; **`emitir()` still produces the same envelope** (regression vs the existing fixture) |
| `.../emissao-v2-cenarios.spec.ts` | The 14 cases and the reported scenario (table below). In-memory fake `NfeNumeracaoRepository` (per-key counter with mutex, same interface), fake SEFAZ two-phase and Focus V2 clients, in-memory `nfeEmitida` store, storage mock |
| `.../inutilizacao-v2.spec.ts` | Guard over live rows; `descartarReservas`; counter moves only forward; 241/256/563 |
| `.../focus-readback.spec.ts` | Divergence; counter advance; P2002 keeps the number |
| `.../diagnostico-classificacao.spec.ts` | Pure audit-trail classification (§12) |
| `tests/nfe-emitir-decisao.spec.ts` | Frontend pure module |
| `tests/fiscal/numeracao/flag-off-regressao.spec.ts` | Flag OFF (and allowlist excluding the user): `emit()` never instantiates the orchestrator; `reservarProximoNumero` called with exactly the V1 arguments; inutilização/cancel/delete never touch the ledger |

### 11.3 The 14 mandatory cases and the reported scenario

| # | Steps | Assertion |
|---|---|---|
| 1 | Storage throws before `TRANSMITINDO`; retry | Row DRAFT, reservation RESERVADO 101; retry reuses **101** and gets authorized; another document gets **102** |
| 2 | SEFAZ protNFe 225 (and variants 974, 302, 999); `updateDraft` simulated (status becomes DRAFT, R1); retry | **101** authorized |
| 3 | Focus 422 `erro_validacao_schema`; Focus 401 HTML; Focus GET `erro_autorizacao` with `status_sefaz:"974"` | Row REJECTED, integer cStat 974, **no Prisma error**, no 500, retry 101 |
| 4 | Authorized; POST `/issue` again | `jaEmitida`, no provider call; next document 102 |
| 5 | Cancel V2 | Reservation CANCELADO; issue refused; inutilização of 101 blocked; next document 102 |
| 6 | REJECTED 101, inutilizar(101, `descartarReservas`), retry | Retry reserves **102**; 101 never sent again; inutilização of 101 while SENDING is **refused** |
| 7 | Transmit times out after `TRANSMITINDO` | SENDING/INCERTO. Retry immediately: `emAndamento` (lease). After the lease: **consultation before any transmit** (call order asserted); 217 before 120 s is inconclusive; 217 after 120 s leads to identical resend (same chave, same bytes) and authorized 101 |
| 8 | Timeout, then consultation returns 100 with matching digVal | AUTORIZADO; nfeProc = stored XML + protNFe; **zero** transmits; next document **102**. Mismatching digVal gives BLOQUEADO |
| 9 | Two `emit()` calls on the same `nfeId` with `Promise.all` | One reservation and one transmit; the loser returns `emAndamento`, no throw |
| 10 | Two `nfeId` in the same key concurrently (fake with mutex) | 101 and 102 distinct; plus the pg test |
| 11 | Tenants A and B | Both start at 1 |
| 12 | Séries 1 and 3 of the same cfc | Independent |
| 13 | HOMOLOG 101 REJECTED, config switched to PRODUCAO, retry | HOMOLOG reservation ABANDONADO (`requerInutilizacao=false`); PROD reserves from its own counter |
| 14 | Focus authorized 101 (read-back 101); switch to SEFAZ_DIRECT; new document | 102 from the same counter. Focus INCERTO attempt, then switch to SEFAZ, then retry: consultation goes **through Focus** (attempt's provider) |
| Reported scenario | Counter at 101 (100 authorized). Document X: SEFAZ direct with invalid field → `prepararEmissao` throws (B6); **and** a variant with Focus 422 `erro_validacao_schema`; fix via `updateDraft` (DRAFT); retry | **101 authorized**; document Y gets **102** |
| Extra | 635 then retry; 539 with our chave; 539 foreign twice (L2); 422 `already_processed`; key change (U3); legacy REJECTED 205 not reused (U1); flag rollback overwrite (`FLAG_ROLLBACK_V1`) | As described in §§1–7 |

### 11.4 Gates

- `tsc --noEmit`: multiset diff against the baseline of 98 errors; no new errors.
- `next build` runs eslint (prefer-const).
- No test changes the existing specs.

---

## 12. (h) Read-only diagnostic: `scripts/fiscal/diagnostico-numeracao-nfe.ts`

Classification logic is pure, in `app/fiscal/numeracao/diagnostico-classificacao.ts`.

### 12.1 CLI

```
npx tsx scripts/fiscal/diagnostico-numeracao-nfe.ts --user-email=<e> | --user-id=<id> | --todos
     [--ambiente=PRODUCAO|HOMOLOGACAO|todos (default PRODUCAO)] [--modelo=55|65|todos]
     [--consultar --max-consultas=50 --intervalo-ms=2000]   # provider calls: VPS only
```

### 12.2 Guarantees

- **No writes.** Phase 1 loads everything inside `prisma.$transaction(async tx => { await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY"); ... })`. The transaction is short and holds no pool connection during network calls (pooler incident). A source-guard test (`diagnostico-somente-leitura.spec.ts`) greps the script and forbids `.create(`, `.update(`, `.delete(`, `upsert` and `$executeRaw` except that one line. That guard only proves the lines don't exist; the runtime READ ONLY transaction is the real protection.
- **`--consultar`:**
  - It refuses to run unless `certificadoPath` exists on disk for SEFAZ configs, which is only true on the VPS. Otherwise it prints "rode na VPS".
  - It instantiates `SefazDirectProvider` / `FocusNfeClientV2` directly and calls **only** `consultarDetalhado`, `consultarReciboDetalhado` and GET ref.
  - It never uses the use cases, `buscarXml` or storage.
  - It never prints tokens. For each emitter it prints `certificadoSubjectCN` and the first 8 hex characters of md5(token), which is enough to report the shared-token groups.

### 12.3 Data read per key

`NfeSequence` (counter), all `NfeEmitida` rows with `numero > 0` (all statuses, including imported historic notes), `NfeAuditLog` for those rows (NUMERADA/ENVIADA/REJEITADA/ENVIO_INCERTO/EDITADA_DRAFT/AUTORIZADA/CONTINGENCIA_*), `NfeInutilizacao` with the emitter's provider, and the V2 ledger if it exists.

### 12.4 Classification of each number in `1..proximoNumero-1`

| Class | Rule |
|---|---|
| `AUTORIZADA_OK` | AUTHORIZED/CANCELLED row. **True number = nNF from the chave**; `DIVERGENCIA_FOCUS` when `row.numero ≠ nNF` |
| `INUTILIZADA` | ACEITA range; `INUTILIZADA_FOCUS_NAO_VERIFICADA` if provider was Focus under V1 (B11) |
| `REJEITADA_EM_POSSE` | REJECTED row holds it; sub-class via `classificarRetorno(cStatRejeicao)`, `CSTAT_PERDIDO_R3` when null and audit shows ENVIADA → ENVIO_INCERTO "Erro apos envio" |
| `EM_ABERTO_SENDING` | SENDING row; SEFAZ with or without chave / Focus / NFC-e |
| `ABANDONADA_POS_REJEICAO` | NUMERADA(n) → REJEITADA → later NUMERADA(m≠n) on the same row. **Gap, needs inutilização (never automatic)** |
| `ABANDONADA_ERRO_LOCAL` | NUMERADA(n) → EDITADA_DRAFT "Erro antes do envio". Gap |
| `ABANDONADA_INCERTA` | NUMERADA(n) → ENVIADA / ENVIO_INCERTO with no terminal event before a later NUMERADA. **May be authorized**; consult the chave from `ENVIO_INCERTO.detalhes.chaveAcesso` / `CONTINGENCIA_CONSULTA` (`nfe-emission.usecase.ts:398-406, 525-528`) |
| `SEM_RASTRO` | No row, audit or range (deleted draft — audit cascades — or manual counter adjustment). No consultation possible: SEFAZ has no service to query by number |
| `CONFLITO` | Two rows or audit claims for the same authorized number. CRITICAL |

### 12.5 Focus tenants (key nuance)

Under V1, Dexo's numbers never reached SEFAZ (B12). "Dexo gaps" and "SEFAZ gaps" are reported **separately**:
- Dexo gaps: numbers Dexo reserved and abandoned.
- SEFAZ gaps: holes in the sequence of nNF taken from the authorized chaves.

Only the second kind has fiscal weight. The "177 / 109 / 18 abandoned" counts must be recomputed with this split before anyone mentions inutilização. Also reported: `CONTADOR_ATRAS` when max(nNF from chave) ≥ `proximoNumero` (risk when switching Focus to SEFAZ), and the same CNPJ present in more than one tenant (U5).

### 12.6 `--consultar` over the 22 SENDING rows

| Rows | What it does |
|---|---|
| 18 SEFAZ direct with chave | `consultarDetalhado`: 100 gives "autorizada — registrar manualmente" with nProt/digVal (the snapshot in `xmlOriginal` is JSON, `nfe-emission.usecase.ts:307-316`, so ownership cannot be proven by digest; reported as "provável"); 217 gives "não autorizada — número não consumido"; 101/151 cancelled; 206 inutilized; errors are inconclusive |
| 3 Focus with 401 | GET ref with the current token; 401 again gives "token inválido — inconclusivo" |
| 1 NFC-e | Consultation by chave; the modelo in the chave routes it to the NFC-e endpoint (`sefaz-direct.provider.ts:323-326`) |

### 12.7 Output

`scripts/out/diagnostico-numeracao-<data>.{json,csv}` plus a console summary per tenant, emitter and key: counter, max nNF, counts per class, suggested action ("consultar", "inutilizar manualmente", "conferir"). **No automatic action.**

---

## 13. Files

### 13.1 New

- `app/fiscal/numeracao/flags.ts`
- `app/fiscal/numeracao/cstat-numeracao.ts`
- `app/fiscal/numeracao/estado-reserva.ts`
- `app/fiscal/numeracao/nfe-numeracao.repository.ts` (raw SQL, injectable client)
- `app/fiscal/numeracao/nfe-numeracao.service.ts`
- `app/fiscal/numeracao/reconciliacao.ts`
- `app/fiscal/numeracao/focus-readback.ts`
- `app/fiscal/numeracao/contingencia-v2.ts`
- `app/fiscal/numeracao/inutilizacao-v2.ts`
- `app/fiscal/numeracao/diagnostico-classificacao.ts`
- `app/fiscal/sefaz/digest.ts`
- `app/fiscal/providers/focus-nfe-v2.client.ts`
- `app/usecases/nfe-emissao-v2.orchestrator.ts`
- `app/notas-fiscais/lib/nfe-emitir-decisao.ts`
- `scripts/fiscal/diagnostico-numeracao-nfe.ts`
- `prisma/ddl/2026-09-XX-nfe-numeracao-v2.sql`
- `docs/nfe-numeracao-v2.md` (runbook: DDL, flags, rollback, partial index)
- the tests in §11

### 13.2 Changed (additive; all behind the flag)

| File | Change |
|---|---|
| `app/usecases/nfe-emission.usecase.ts` | One dispatch line in `emit()` plus the lazy `v2()` |
| `app/fiscal/providers/sefaz-direct.provider.ts` | `prepararEmissao` / `transmitirPreparada` / `consultarDetalhado` / `consultarReciboDetalhado`; `emitir` untouched |
| `app/fiscal/storage/fiscal-storage.service.ts` | `saveXmlTentativa` / `readXmlTentativa` |
| `app/routes/fiscal.routes.ts` | `POST /nfe/:id/consultar-situacao` |
| `app/usecases/nfe-inutilizacao.usecase.ts` | V2 branch |
| `app/usecases/nfe-cancelamento.usecase.ts` | Best-effort hook |
| `app/usecases/nfe-draft.usecase.ts` | `delete` hook: `ABANDONADO` |
| `app/notas-fiscais/components/nfe-wizard.tsx`, `nfe-list.tsx` | UI flag |
| `prisma/schema.prisma` | Two documentation models with no relation |

### 13.3 Explicitly untouched

`nfe-sequence.service.ts`, `cstat-mapper.ts`, `contingencia.service.ts`, `focus-nfe.provider.ts`, `nfe-number-reuse.ts`, `nfe.repository.ts` (`updateDraft`, `findEmitted`), `nfe-xml-builder*.ts`.

### 13.4 Why flag OFF stays identical

Every V2 entry point checks `isNfeNumeracaoV2Enabled(userId)`: `emit()`, inutilização, cancel hook, delete hook, new route, UI flag. With it off, the new tables are never read or written, no provider method changes, and no column is added to an existing model. `flag-off-regressao.spec.ts` asserts this.

---

## 14. Rollout, rollback, open checks

### 14.1 Rollout

1. Deploy code with flags OFF. No behavior change.
2. Run the DDL through `psql "$DIRECT_URL"` on the VPS (empty tables; no `db push`).
3. Run the diagnostic without `--consultar`, then with it for the 22 SENDING rows (VPS). Take the report to the user; every action on history is manual (decision 3).
4. Set `NFE_NUMERACAO_V2_ENABLED=true`, `NFE_NUMERACAO_V2_USER_IDS=<Kiko>`, `NFE_FOCUS_ENVIA_NUMERO_ENABLED=true` (homologação). Apply env changes following the existing VPS pm2 runbook (the memory warns against `--update-env`). Walk through cases 1–9 by hand in homologação.
5. Widen the allowlist, then everyone.

### 14.2 Rollback

- **Flag OFF:** the ledger goes inert. V2 REJECTED rows fall back to V1 behavior. V2 SENDING rows stay SENDING, which is what V1 already does with uncertain rows. Nothing is corrupted.
- **Turning it back on:** a number V1 overwrote in the meantime is detected (live reservation number ≠ `row.numero`), marked `ABANDONADO(FLAG_ROLLBACK_V1)`, and the row follows the legacy rule.

### 14.3 Open checks (not verifiable from code)

- Exact wording and context of 563, 613, 106, 113/114 and 691/692 (EPEC) in MOC 7.0 Anexo I. The 539 xMotivo format varies by UF; the design uses a `\d{44}` regex.
- The wording of MOC Anexo III §2.3.3 on SVC numbering (taken from the task statement).
- Focus: whether every 201/GET body carries `numero`/`serie`; whether Focus renumbers in contingency; whether 429 sends Retry-After.
- Production values of `SEFAZ_AUTO_FALLBACK_ENABLED`, `SEFAZ_TIMEOUT_MS`, `SEFAZ_RETRY_MAX` (read-only on the VPS).
- The per-company responsável técnico resolver is a separate workstream. It must update **both** `emitir()` (`sefaz-direct.provider.ts:197`) and `prepararEmissao()`.

External grounding used for the cStat table and Focus behavior:
- [Berga.App — tabela de rejeições NF-e/NFC-e](https://berga.app/base-de-conhecimento/rejeicoes-nfe) (204, 205, 206, 217, 218, 241, 256, 539, 613, 635, 999)
- [Oobj — Rejeição 280](https://oobj.com.br/bc/rejeicao-280-como-resolver/) and [Oobj — Rejeição 283](https://oobj.com.br/bc/rejeicao-283-como-resolver/) (280–286 transmitter certificate)
- [NS7 — Rejeição 289](https://ns7.com.br/docs/ns7/rejeicao-288-codigo-municipio-do-fato-gerador-do-transporte-inexistente/) (287–289 are content errors)
- [Tecnospeed — NT 2024.001](https://blog.tecnospeed.com.br/nf-e-e-nfc-e-nota-tecnica-2024-001-crt-4/), [Focus — NT 2024.001](https://focusnfe.com.br/notas-tecnicas/nfe/2024-001/), [Vinco — denegação passa a ser rejeição](https://blog.vinco.com.br/denegacao-de-nf-e-passa-a-ser-rejeicao/)
- [Focus docs — Inutilizar numeração](https://doc.focusnfe.com.br/reference/inutilizar_numeracao.md) (`status` autorizado/erro_autorizacao, `protocolo_sefaz`)
- [Focus docs — Emitir NF-e](https://doc.focusnfe.com.br/reference/emitir_nfe.md) (201/202/422 codigos, numero/serie in the response)
- [Tecnospeed — Rejeição 562](https://atendimento.tecnospeed.com.br/hc/pt-br/articles/360013192674-Rejei%C3%A7%C3%A3o-562-C%C3%B3digo-Num%C3%A9rico-informado-na-Chave-de-Acesso-difere-do-C%C3%B3digo-Num%C3%A9rico-da-NF-e)