# Design: cStat normalization and classification (A), Focus hardening with Dexo-controlled numbering (B), and a per-company provider and responsável técnico resolver (C)

Worktree HEAD is `1549bc4`, the same commit production runs. Nothing was edited or run. Every file:line below is from that commit.

---

## 0. Summary, flags and rollout order

| # | Flag (backend flags are read at call time with `=== "true"`) | Gates | Needs DDL? |
|---|---|---|---|
| A1 | `NFE_CSTAT_NORMALIZADO_ENABLED` | cStat normalized at the Focus boundary; `handleRejected` does one update; raw code goes into the audit log. Fixes R3. | no |
| A2 | `NFE_CSTAT_CLASSIFICACAO_V2_ENABLED` | Rejection codes ≥600 and 4-digit codes become reusable. 205, 206, 301–303, 562 and 613 are never reusable. Fixes R2. | no |
| B1 | `NFE_FOCUS_HARDENING_ENABLED` | Focus status mapping, `res.ok` checks, safe body parsing, timeouts, the new outcome field, the reconciliation loop, the consult-before-resend check, stripping the "NFe" prefix from the chave on write, writing back the real nNF. **Turns A1 and A2 on with it** (a denied note needs the V2 classes). Fixes R4. | no |
| B2 | `NFE_REUSO_NAO_ENVIADA_ENABLED` | Reuses the number when the last recorded outcome is "never sent" (`NAO_ENVIADA`) or "refused by the provider before SEFAZ" (`REJEITADA_PROVEDOR`), for all providers. Also covers the catch path (R5) and SEFAZ-direct build/sign failures. | no |
| B3 | `NFE_FOCUS_NUMERACAO_DEXO_ENABLED` + `NFE_FOCUS_NUMERACAO_DEXO_EMPRESAS` (CompanyFiscalConfig ids, comma-separated, or `*`) | Payload sends `numero` instead of `numero_nota`. Only takes effect when B1 is on and the config id is on the list. | no |
| C1 | `NFE_RESP_TEC_POR_EMPRESA_ENABLED` | Reads `CompanyFiscalRespTec`, applies the resolver, enables the resp-tec routes | **yes (new table)** |
| UI | `NEXT_PUBLIC_NFE_RESP_TEC_POR_EMPRESA_ENABLED`, `NEXT_PUBLIC_NFE_ENVIO_DESFECHO_UI_ENABLED` | The responsável técnico card; wording of the rejection banner | build |
| tunables | `NFE_FOCUS_TIMEOUT_EMITIR_MS` (30000), `NFE_FOCUS_TIMEOUT_CONSULTA_MS` (15000), `NFE_FOCUS_TIMEOUT_XML_MS` (15000), `NFE_FOCUS_TIMEOUT_EVENTO_MS` (30000), `NFE_FOCUS_RECONCILIAR_ESPERAS_MS` ("2000,4000,8000"), `NFE_FOCUS_ORCAMENTO_EMISSAO_MS` (40000) | Valid range 1000–120000; anything else falls back to the default | – |

**Rollout order:**
1. Deploy with every flag off. Behaviour is identical.
2. A1, then A2.
3. C1 DDL → `prisma generate` on the VPS → pm2 restart (never `--update-env`) → C1 on → front build.
4. Configure Kiko's responsável técnico as `PROVEDOR`.
5. B1 + B2 (and the banner build flag).
6. Run the diagnostic script → B3 for Kiko's config id, homologação first.
7. External steps (§5).

With every flag off, every existing flow runs the legacy code unchanged (branches are chosen at the top of each function).

---

## 1. Code facts this design depends on (plus side findings)

**Emission (`app/usecases/nfe-emission.usecase.ts`)**
- Config load: :111-120. Token check: :124-126. `validate`: :129. Claim: :140-155 (clears `cStatRejeicao` when REEMISSAO is on, :146).
- Reuse or reserve: :226-254. Number written to the row: :262-278. `NUMERADA` audit: :280-283.
- Focus builder: :319. `xmlOriginal` saved: :325-334. Provider created: :344-354.
- `sentToSefaz = true` at :357. `emitir` at :358-362.
- Focus poll: :462-468. Rejected-after-consult: :485-494. Pending: :496-503. Provider status `erro` → `ENVIO_INCERTO` + stays SENDING: :521-536. Rejected: :539-546.
- Catch: :547-564 (DRAFT when `!sentToSefaz`).
- `handleAuthorized`: :789-937. `buscarXml(nfeId)`: :814-823. DANFE built from the DB when there is no inline XML (the Focus case): :860-900.
- `handleRejected`: :1051-1084 = `forceStatus` (:1059) + a second update (:1065-1070) + audit `{mensagem}` (:1072).
- `pollForResult`: :1086-1101. `redactConfig`: :1218-1225.

**Focus provider (`app/fiscal/providers/focus-nfe.provider.ts`)**
- `fetch` calls have no `signal` (:64-68, :141-144, :187-190, :209-215, :242-252).
- `res.json()` is called unconditionally (:70, :146, :217, :254), so Focus's HTML 401 throws and lands in the catch as status `erro`.
- 200/201/202 always map to `processando` (:72-87). `codigoStatus: body.status_sefaz` is a string (:82).
- 422 gives `codigoStatus: body.codigo ?? body.status_sefaz`, a string (:96).
- Any other status puts the HTTP code into `codigoStatus` (:110).
- `consultar` has no `res.ok` check; unknown statuses map to `processando` (:155); `status_sefaz` is a string (:164); `denegado` is not mapped (:148-153).
- `cancelar` and `inutilizar` report success on HTTP 200 regardless of `body.status` (:220, :257).

**Interfaces and factory**
- `codigoStatus: number | null` is declared (`nfe-provider.interface.ts:26,40`), but Focus puts strings there at runtime.
- The contract test pins the status union (`tests/fiscal/provider-contract.spec.ts:271,282`), so new information goes in **optional** fields and the union stays as is.
- `createNfeProviderFromConfig` drops `modelo` for Focus (`provider-factory.ts:120-121`). Latent bug: NFC-e would hit `/v2/nfe`. Emission avoids it by calling `createNfeProvider` directly (:352-354).

**Focus builder (`app/fiscal/generators/nfe-xml-builder.service.ts`)**
- `payload.numero_nota` at :56 (not a Focus field). `payload.serie` at :57. No responsável técnico fields.

**Responsável técnico today**
- `resolveRespTecFromEnv` (`app/fiscal/sefaz/resp-tec.ts:18-35`) is documented as "o MESMO para todos os tenants" (:4-6).
- It is called only at `sefaz-direct.provider.ts:197`.
- The builder throws on an incomplete group (`nfe-xml-builder-sefaz.service.ts:806-819`). That happens **inside** `emitir`, after `sentToSefaz = true`, and comes back as status `erro` (`sefaz-direct.provider.ts:199-205`). Result today: `ENVIO_INCERTO`, stuck in SENDING, number burned. Sign and QR failures behave the same way (:216-223, :243-250).
- The CSRT hash is computed at :830-836.

**cStat mapping**
- `lookupCStat` (`app/fiscal/sefaz/cstat-mapper.ts:100-130`): only 200–599 count as `rejeitada` (:111-117); a string input becomes NaN.
- 218 is labelled "duplicidade", but MOC 218 means "já cancelada". The non-reusable outcome is still correct.
- `shouldReuseNumero`: `nfe-number-reuse.ts:51-62`.

**Repository and write sites**
- `updateDraft` forces DRAFT and clears the motivo but **does not clear `cStatRejeicao`** (`nfe.repository.ts:379-381`).
- `reaproveitavel` is computed at :93-95 and :751-757.
- `addAuditLog`: :493-507. `NfeAuditLog` has an index on `nfeId` (`schema.prisma:2003`).

**Routes, secrets and logging**
- `/issue` maps to HTTP 400 only when the message contains `incompleto|obrigat|invalid|sem NCM|sem CFOP|Token` (`fiscal.routes.ts:944-956`). The match is unaccented: "inválido" does **not** match.
- `sanitizeFiscalConfig`: :110-141.
- `GET /nfe/:id` returns the audit rows' `detalhes` (:1133-1143).
- `GET /nfe/:id/xml` falls back to `xmlOriginalPath` (:1174).
- The logging middleware logs PUT bodies to `/fiscal/*config*` (`logging.middleware.ts:177-185`). Redaction matches field-name substrings (:383-408). **`csrt` is not on the list.** `fone` and `xContato` are logged as-is.

**Other**
- Dexo CSRT/token encryption helper: `CertificateManagerService.encryptPassword/decryptPassword` (AES-256-GCM, `certificate-manager.service.ts:59-91`). It refuses to start in production without a key (:37-46).
- `isValidCnpj` lives in `app/lib/masks.ts:63` (client-safe).
- `chave-acesso.ts:12` imports `node:crypto`, so it is not client-safe.
- `parseNfeXml` strips the "NFe" prefix (:193) and returns `ide.nNF` / `ide.serie` (:227-228).
- `NfeSequenceService.ajustarProximoNumero` only moves the sequence forward (:270-275).
- PDV result mapping: REJECTED → `rejected`, SENDING with `success` → `processing` (`finance.usecase.ts:1910-1918`).

**Side findings (outside A/B/C, handle separately)**
1. `.env.example:19` hardcodes a CNPJ (`NFE_RESP_TEC_CNPJ="51195502000156"`, and the comment says "Jotabê (Dexo)"). This breaks the no-hardcoded-CNPJ rule and is stale (production uses a different CNPJ).
2. `redactConfig` (:1221) removes the certificate password and the token but **not `cscToken`**. The SEFAZ-direct `xmlOriginal` snapshot therefore stores the CSC. It can be downloaded through `/nfe/:id/xml` whenever there is no authorized XML (:1174), including by collaborators.
3. `schema.prisma:1824` says `providerToken` is "encriptado", but it is stored in plain text (`company-fiscal.repository.ts:73`).
4. `parseRetConsReciNFe` maps unknown cStats (≥600) to `processando` (`sefaz-direct.provider.ts:1009-1013`). This could explain some of the 18 SEFAZ-direct rows stuck in SENDING whose last audit is `ENVIADA`. Check read-only before changing anything (suggested later flag `NFE_SEFAZ_PARSE_CSTAT_V2_ENABLED`, not in this batch).
5. Focus `cancelar` marks CANCELLED on any HTTP 200 (:220), even when the body says the cancellation failed.

---

## 2. (A) cStat normalization and classification

### 2.1 New pure module `app/fiscal/domain/cstat.ts` (no imports except `lookupCStat`)

```ts
/** Normalizes a cStat that came from a provider. Valid range 100..9999. */
export function normalizeCStat(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number")
    return Number.isInteger(raw) && raw >= 100 && raw <= 9999 ? raw : null;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!/^\d{3,4}$/.test(t)) return null;          // "erro_validacao_schema", "97a", "" → null
    const n = Number(t);
    return n >= 100 && n <= 9999 ? n : null;          // "0974" → 974
  }
  return null;                                         // objects, booleans
}
/** Raw code for the audit log (never parsed back). */
export function codigoRawDe(raw: unknown): string | null {
  if (raw == null || typeof raw === "object") return null;
  const s = String(raw).trim().slice(0, 120);
  return s.length ? s : null;
}

export type CStatClasseV2 = "autorizada"|"denegada"|"inutilizada"|"duplicidade"
  |"nao_consta"|"lote"|"evento"|"infra_nao_processado"|"rejeitada"|"desconhecido";
const AUT = new Set([100, 150]);
const DEN = new Set([110, 205, 301, 302, 303]);
const INUT = new Set([206]);
const DUP = new Set([204, 218, 539, 562, 613, 573]); // 562/613: check MOC Anexo I — conservative
const LOTE = new Set([103, 104, 105]);
const EVT = new Set([101, 102, 135, 136, 151, 155]);
const INFRA = new Set([108, 109]);                   // lote not processed ⇒ number free

export function classificarCStatV2(c: number | null): { classe: CStatClasseV2; reaproveitavel: boolean } {
  if (c == null) return { classe: "desconhecido", reaproveitavel: false };
  if (AUT.has(c)) return { classe: "autorizada", reaproveitavel: false };
  if (DEN.has(c)) return { classe: "denegada", reaproveitavel: false };
  if (INUT.has(c)) return { classe: "inutilizada", reaproveitavel: false };
  if (DUP.has(c)) return { classe: "duplicidade", reaproveitavel: false };
  if (c === 217) return { classe: "nao_consta", reaproveitavel: false };
  if (LOTE.has(c)) return { classe: "lote", reaproveitavel: false };
  if (EVT.has(c)) return { classe: "evento", reaproveitavel: false };
  if (INFRA.has(c)) return { classe: "infra_nao_processado", reaproveitavel: true };
  if (c >= 200 && c <= 9999) return { classe: "rejeitada", reaproveitavel: true }; // 280-289, 974, 704, 781, 999, 1010...
  return { classe: "desconhecido", reaproveitavel: false };
}

/** One entry point for "is this rejection's number reusable?". v2=false ⇒ legacy logic unchanged. */
export function isCStatRejeicaoReaproveitavel(cStat: number | null | undefined, v2: boolean): boolean {
  if (cStat == null) return false;
  if (!v2) return lookupCStat(cStat).categoria === "rejeitada";   // identical to nfe-number-reuse.ts:61
  return classificarCStatV2(normalizeCStat(cStat)).reaproveitavel;
}
```

`lookupCStat` stays **unchanged**: the SEFAZ-direct parsers (`sefaz-direct.provider.ts:874,963,1007,1029,1054`) and contingência (`contingencia.service.ts:83`) keep today's behaviour.

### 2.2 Flags module `app/fiscal/domain/nfe-flags.ts`

```ts
export const isFocusHardeningEnabled = () => process.env.NFE_FOCUS_HARDENING_ENABLED === "true";
export const isNfeCStatNormalizadoEnabled = () =>
  process.env.NFE_CSTAT_NORMALIZADO_ENABLED === "true" || isFocusHardeningEnabled();
export const isNfeCStatClassificacaoV2Enabled = () =>
  process.env.NFE_CSTAT_CLASSIFICACAO_V2_ENABLED === "true" || isFocusHardeningEnabled();
export const isReusoNaoEnviadaEnabled = () => process.env.NFE_REUSO_NAO_ENVIADA_ENABLED === "true";
export const isRespTecPorEmpresaEnabled = () => process.env.NFE_RESP_TEC_POR_EMPRESA_ENABLED === "true";
export function isFocusNumeracaoDexo(configId: string, env = process.env): boolean {
  if (env.NFE_FOCUS_HARDENING_ENABLED !== "true" || env.NFE_FOCUS_NUMERACAO_DEXO_ENABLED !== "true") return false;
  const ids = (env.NFE_FOCUS_NUMERACAO_DEXO_EMPRESAS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return ids.includes("*") || ids.includes(configId);
}
export function lerMs(name: string, def: number, env = process.env): number {
  const n = Number(env[name]); return Number.isInteger(n) && n >= 1000 && n <= 120000 ? n : def;
}
```

### 2.3 Honest provider typing (`nfe-provider.interface.ts`, additive only)

```ts
export type NfeEnvioDesfecho = "AUTORIZADA" | "PROCESSANDO" | "REJEITADA_SEFAZ" | "DENEGADA"
  | "DUPLICIDADE" | "REJEITADA_PROVEDOR" | "NAO_ENVIADA" | "INCERTA";
export type NfeConsultaDesfecho = NfeEnvioDesfecho | "NAO_CONSTA" | "CANCELADA";

export interface NfeProviderEmitResult {
  // ...existing fields unchanged...
  /** SEFAZ code. After normalizeCStat this is number|null. WARNING: FocusNfeProvider in legacy mode
   *  (A1/B1 off) passes status_sefaz/codigo through RAW (string). Whoever persists it MUST normalize. */
  codigoStatus: number | null;
  /** Raw provider code ("974", "erro_validacao_schema"), audit only. Filled only by the new paths. */
  codigoRaw?: string | null;
  /** HTTP status of the provider call. Never put into codigoStatus on the new paths. */
  httpStatus?: number | null;
  desfecho?: NfeEnvioDesfecho;
  numeroAutorizado?: number | null;   // nNF actually used (Focus)
  serieAutorizada?: number | null;
  retryAfterMs?: number | null;
}
export interface NfeProviderConsultaResult {
  // ...existing fields...
  codigoRaw?: string | null; httpStatus?: number | null; desfecho?: NfeConsultaDesfecho;
  numeroAutorizado?: number | null; serieAutorizada?: number | null; retryAfterMs?: number | null;
}
```

### 2.4 Focus boundary with A1 on and B1 off (minimal, inside the legacy methods)

- `focus-nfe.provider.ts:82`: `codigoStatus: normalizeCStat(body.status_sefaz), codigoRaw: codigoRawDe(body.status_sefaz)`
- `:96`: `codigoStatus: normalizeCStat(body.status_sefaz) ?? normalizeCStat(body.codigo), codigoRaw: codigoRawDe(body.codigo ?? body.status_sefaz)`
- `:110`: `codigoStatus: null, httpStatus: res.status`. Nothing downstream reads cStat in the `erro` branch (:521-536).
- `:164` (consultar): same normalization plus `codigoRaw`.
- Flag off: each object literal is exactly what it is today (`isNfeCStatNormalizadoEnabled() ? {...novo} : {...legado}`).

### 2.5 `handleRejected`

**Bit-identity decision:** with A1 off, keep the **two** updates and the `{mensagem}` audit exactly as they are (:1059-1072). That includes today's R3 crash when REEMISSAO is on and cStat is a string. A test pins this behaviour. With A1 on, write status, motivo and cStat in **one** update.

```ts
private async handleRejected(nfeId, userId, numero, serie, mensagem: string,
                             cStat?: unknown, extra?: RejeicaoExtra): Promise<EmissionResult> {
  if (!isNfeCStatNormalizadoEnabled()) { /* :1059-1072 verbatim */ }
  const cStatNum = normalizeCStat(cStat);                  // defensive: "974" → 974
  const data: Record<string, unknown> = { status: "REJECTED", motivoRejeicao: mensagem };
  if (isNfeReemissaoRejeitadaEnabled()) data.cStatRejeicao = cStatNum; // column still guarded by the existing flag
  await (prisma as any).nfeEmitida.update({ where: { id: nfeId }, data, select: { id: true } });
  await this.nfeRepo.addAuditLog(nfeId, userId, "REJEITADA", {
    mensagem, cStat: cStatNum,
    codigoRaw: extra?.codigoRaw ?? codigoRawDe(cStat),
    httpStatus: extra?.httpStatus ?? null,
    desfecho: extra?.desfecho ?? "REJEITADA_SEFAZ",
    ...(extra?.tupla ?? {}),               // {numero, serie, ambiente, modelo, companyFiscalConfigId, provider}
  });
  return { success: false, nfeId, status: "REJECTED", numero, serie, chaveAcesso: null, protocolo: null, mensagem };
}
interface RejeicaoExtra { codigoRaw?: string|null; httpStatus?: number|null; desfecho?: NfeEnvioDesfecho; tupla?: TuplaNumeracao }
```

Call sites :486-493 and :539-546 pass `extra` from the provider result (`codigoRaw`, `httpStatus`, `desfecho`) plus the `tupla`. The `tupla` is built once after :262-278:

```ts
const tupla = { numero, serie: draft.serie, ambiente, modelo, companyFiscalConfigId: config.id, provider: config.providerName ?? "FOCUS_NFE" };
```

### 2.6 Using the V2 classification

- `shouldReuseNumero(draft, ambiente, flagOn, opts?: { classificacaoV2?: boolean })`. Change only :60-61 to `return isCStatRejeicaoReaproveitavel(draft.cStatRejeicao, opts?.classificacaoV2 === true)`. Existing 3-argument calls keep legacy behaviour. Call site :226 passes `{ classificacaoV2: isNfeCStatClassificacaoV2Enabled() }`.
- `nfe.repository.ts:93-95` and `:753-757`: `isCStatRejeicaoReaproveitavel(row.cStatRejeicao, isNfeCStatClassificacaoV2Enabled())`.

### 2.7 Inventory

**Writes to `status/motivoRejeicao/cStatRejeicao`:**

| Site | What it writes | Change |
|---|---|---|
| `nfe-emission.usecase.ts:140-150` (claim) | VALIDATING, motivo null, cStat null (flag :146) | none |
| `:1059` + `:1065-1070` (`handleRejected`) | REJECTED, motivo, cStat raw | A1: one update, normalized |
| `:552` (catch, `forceStatus` DRAFT) | status | B2: extra audit (§3.6.5) |
| `nfe.repository.ts:380-381` (`updateDraft`) | DRAFT, motivo null (cStat **kept**) | none (belongs to the numbering design, R1) |
| `nfe-cancelamento.usecase.ts:135-141` | CANCELLED, motivo = cancellation reason (field reused) | none |
| `nfe.repository.ts:188-214` (`createHistoric`) | does not write these | none |
| **NEW** `handleNaoEnviada` (§3.6.2) | REJECTED, motivo, cStat null | B1/B2 |

**Reads/consumers:** `nfe.repository.ts:91-95` (draft GET), `:719-722` + `:751-757` (listing), `nfe-emission.usecase.ts:231` (reuse), `:1170-1171` (`loadNfe`), `nfe-wizard.tsx:183-196` (banner), `nfe-list.tsx:784-800` (retry button), `nfe.repository.ts:277-312` (PDV motivo), `nfe-detail-sheet.tsx:526-536`. Consult paths feeding `handleRejected`: `pollForResult` (:1095, Focus string) and `pollSefazResult` (:639, SEFAZ number).

### 2.8 Tests for (A)

- `tests/fiscal/cstat-normalize.spec.ts`
  - `normalizeCStat`: 974→974, "974"→974, "  974 "→974, "0974"→974, "1010"→1010, null→null, undefined→null, "erro_validacao_schema"→null, 0→null, "0"→null, -1→null, 974.5→null, NaN→null, 10000→null, {}→null, ""→null.
  - `codigoRawDe`: "erro_validacao_schema" is kept; 974→"974"; objects→null; truncation at 120 characters.
- `tests/fiscal/cstat-classificacao-v2.spec.ts`
  - Full table from §2.1.
  - Legacy `lookupCStat(974).categoria === "desconhecido"` stays as it is (proves nothing changed).
  - `isCStatRejeicaoReaproveitavel` with `v2=false` equals the legacy result for 100..1100.
- `tests/fiscal/nfe-emission-reuse.spec.ts` (extend): 3-argument calls unchanged; `{classificacaoV2:true}` makes 974 reusable and 301/205/206/562 not.
- `tests/fiscal/nfe-emission-rejected-write.spec.ts` (pattern from `nfe-emission-company.spec.ts:13-78`)
  - Mock `provider-factory` to return a `MockNfeProvider` queued with `{status:"rejeitada", codigoStatus:"974" as any, mensagem:"Rejeicao 974"}`.
  - Also mock `fiscal-storage.service`, `nfe-sequence.service`, and prisma `findUnique` to return the draft with items.
  - (a) REEMISSAO + A1 on: exactly **one** `nfeEmitida.update` with `{status:"REJECTED", motivoRejeicao, cStatRejeicao:974}`; audit `REJEITADA` has `codigoRaw:"974"`; the result is REJECTED and nothing throws.
  - (b) A1 off: two updates, the second with `cStatRejeicao:"974"` (characterizes R3); when the second update rejects, `emit` throws and writes `ENVIO_INCERTO`.
  - (c) `"erro_validacao_schema"` gives `cStatRejeicao:null` with the raw code kept.
  - (d) `undefined` and `null` give null.
  - (e) `0` gives null.

---

## 3. (B) Focus hardening and Dexo-controlled numbering

### 3.1 New pure modules

**`app/fiscal/domain/chave-acesso-formato.ts`** (client-safe, no `node:crypto`)

```ts
export function normalizeChaveAcesso(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const d = raw.trim().replace(/^NFe/i, "").replace(/\D/g, "");
  return d.length === 44 && dvValido(d) ? d : null;
}
// layout: cUF[0,2) AAMM[2,6) CNPJ[6,20) mod[20,22) serie[22,25) nNF[25,34) tpEmis[34] cNF[35,43) cDV[43]
export function extrairNumeracaoDaChave(chave44: string) {
  return { modelo: chave44.slice(20,22), serie: Number(chave44.slice(22,25)), nNF: Number(chave44.slice(25,34)),
           tpEmis: chave44.slice(34,35) };
}
function dvValido(c: string): boolean { /* mod-11 with weights 2..9; same result as calcularDV (chave-acesso.ts:96) */ }
```

Test: `dvValido` agrees with `calcularDV` from `chave-acesso.ts` on 1,000 random bases.

**`app/fiscal/providers/focus-response.ts`** (pure; takes `{http, json, headers, ambiente, cnpjEmitente}`)

```ts
export async function lerCorpo(res: Response): Promise<{ json: any|null; texto: string }>  // text() + safe JSON.parse
export function parseRetryAfterMs(h: Headers): number|null  // Retry-After (s|date), Rate-Limit-Reset / X-RateLimit-Reset (s) — confirm names in Focus docs
export function mensagemFocus(json: any, fallback: string): string // mensagem_sefaz ?? mensagem + erros[].mensagem joined by "; " (≤500 chars)
export function classificarEmissaoFocus(ctx): NfeProviderEmitResult
export function classificarConsultaFocus(ctx): NfeProviderConsultaResult
export function classificarErroRedeFocus(err: unknown, ctx): NfeProviderEmitResult
```

`ambLabel` = "PRODUÇÃO" or "HOMOLOGAÇÃO". `cnpjFmt` comes from `nfeData.cnpj_emitente`, i.e. the tenant's own data; nothing is hardcoded.

**Emission table (`POST /v2/{nfe|nfce}?ref=`)**

| HTTP | body | `status` | `desfecho` | cStat / other |
|---|---|---|---|---|
| 200/201/202 | `status:"autorizado"` with a valid `chave_nfe` and `protocolo` | autorizada | AUTORIZADA | `normalizeCStat(status_sefaz)`, `chaveAcesso=normalizeChaveAcesso(chave_nfe)`, `numeroAutorizado/serieAutorizada` from `numero/serie` (fallback: the chave) |
| 200/201/202 | `autorizado` but no chave or protocolo | processando | PROCESSANDO | poll |
| 200/201/202 | `erro_autorizacao` | rejeitada | V2 class `denegada` ⇒ DENEGADA; `duplicidade` ⇒ DUPLICIDADE; otherwise REJEITADA_SEFAZ | cStat, `codigoRaw`, `mensagem_sefaz` |
| 200/201/202 | `denegado` | rejeitada | DENEGADA | cStat |
| 200/201/202 | `processando_autorizacao`, missing, unknown, `cancelado`, or unparsable body | processando | PROCESSANDO | – |
| 422 | `codigo ∈ {already_processed, nfe_autorizada, pending_operation, em_processamento}` | processando | PROCESSANDO | the ref exists, so consult |
| 422 | `erro_validacao_schema` | rejeitada | REJEITADA_PROVEDOR | cStat null, `codigoRaw`, message with `erros[]` |
| 422 or 403 | `permissao_negada` | erro | NAO_ENVIADA | "O token Focus não tem permissão para emitir pelo CNPJ {cnpjFmt} no ambiente {amb}." |
| 422 | other with numeric `status_sefaz` | rejeitada | REJEITADA_SEFAZ | legacy compatibility |
| 422 | other without cStat | rejeitada | REJEITADA_PROVEDOR | – |
| 400 | `empresa_nao_habilitada` | erro | NAO_ENVIADA | "CNPJ {cnpjFmt} não está habilitado no Focus para o ambiente {amb}." |
| 400 | `requisicao_invalida` or other | rejeitada | REJEITADA_PROVEDOR | – |
| 401 (HTML) | – | erro | NAO_ENVIADA | "Token Focus inválido para o ambiente {amb} (HTTP 401) — confira o token em Configurações fiscais." |
| 403, 404, 405, 415, other 4xx (not 408/429) | – | erro | NAO_ENVIADA | "O Focus recusou a requisição (HTTP {s})." |
| 429 | – | erro | NAO_ENVIADA | `retryAfterMs`; "Limite de requisições do Focus atingido — aguarde {n} s e tente novamente." |
| 408, 5xx | – | erro | INCERTA | reconcile by ref |
| network error before connecting (`cause.code ∈ ENOTFOUND, EAI_AGAIN, ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT, CERT_*, UNABLE_TO_VERIFY_LEAF_SIGNATURE`) | – | erro | NAO_ENVIADA | "Não foi possível conectar ao Focus ({code}) — nada foi enviado." |
| `TimeoutError`/`AbortError`, `ECONNRESET`, `UND_ERR_SOCKET`, `UND_ERR_HEADERS_TIMEOUT`, unknown | – | erro | INCERTA | – |

In every row, `httpStatus` is filled and `codigoStatus` **never** holds the HTTP code. Messages never contain the token.

**Consult table (`GET /v2/{path}/{ref}`)**

| HTTP | body.status | `status` | `desfecho` |
|---|---|---|---|
| 200 | autorizado | autorizada | AUTORIZADA (plus chave, protocolo, numero, serie, and `xmlUrl` from `caminho_xml_nota_fiscal` if present; confirm the field name) |
| 200 | cancelado | cancelada | CANCELADA |
| 200 | erro_autorizacao | rejeitada | REJEITADA_SEFAZ, DENEGADA or DUPLICIDADE by V2 class |
| 200 | denegado | rejeitada | DENEGADA |
| 200 | processando_autorizacao or unknown | processando | PROCESSANDO |
| 404 | (`nao_encontrado` or anything) | erro | NAO_CONSTA |
| 401/403 | – | erro | NAO_ENVIADA |
| 429 | – | erro | INCERTA (+ `retryAfterMs`) |
| 5xx, network, timeout | – | erro | INCERTA |

### 3.2 `FocusNfeProvider` changes

```ts
async emitir(input) {
  if (isFocusHardeningEnabled()) return this.emitirV2(input);
  /* legacy :60-130, with only the A1 normalization from §2.4 */
}
private async emitirV2(input) {
  const url = `${getBaseUrl(this.ambiente)}/v2/${this.path}?ref=${encodeURIComponent(input.ref)}`;
  try {
    const res = await fetch(url, { method: "POST", headers: authHeader(input.token), body: JSON.stringify(input.nfeData),
                                   signal: AbortSignal.timeout(lerMs("NFE_FOCUS_TIMEOUT_EMITIR_MS", 30000)) });
    const { json } = await lerCorpo(res);
    return classificarEmissaoFocus({ http: res.status, json, headers: res.headers, ambiente: this.ambiente,
                                     cnpjEmitente: input.nfeData?.cnpj_emitente, ref: input.ref });
  } catch (err) { return classificarErroRedeFocus(err, { ambiente: this.ambiente }); }
}
```

- `consultarV2`: same pattern with `NFE_FOCUS_TIMEOUT_CONSULTA_MS` and `classificarConsultaFocus`.
- `buscarXml` with B1 on: `signal` timeout `NFE_FOCUS_TIMEOUT_XML_MS`; optional third argument `opts?: { xmlUrl?: string }` (download `${baseUrl}${xmlUrl}` first, then fall back to `.xml`); returns `null` unless `res.ok` and the body starts with `<`.
- `cancelar` / `inutilizar` with B1 on: timeout `NFE_FOCUS_TIMEOUT_EVENTO_MS`; `lerCorpo`; `success = res.ok && body.status ∈ {"cancelado"}` (cancel) / `{"autorizado"}` (inutilização) (**confirm in Focus docs before turning on**). On INCERTA, cancel consults `GET ref`: `cancelado` ⇒ success. Flag off: :201-271 as they are.
- Add `export function focusBaseUrl(amb)` (additive re-export of `getBaseUrl`) for the resolver.

### 3.3 Focus builder: numbering and responsável técnico

`nfe-xml-builder.service.ts:41-45`:

```ts
export interface FocusBuildOptions { numeracaoDexo?: boolean; respTec?: FocusRespTecCampos | null }
export interface FocusRespTecCampos { cnpj: string; contato: string; email: string; telefone: string }
build(draft, config, numero, opts?: FocusBuildOptions) {
  ...
  // :56 — same position in the object
  if (opts?.numeracaoDexo) payload.numero = String(numero); else payload.numero_nota = String(numero);
  payload.serie = String(draft.serie);                    // :57 unchanged
  ...
  // after :217 (infCpl), before return:
  if (opts?.respTec) {
    payload.cnpj_responsavel_tecnico = opts.respTec.cnpj;
    payload.contato_responsavel_tecnico = opts.respTec.contato;
    payload.email_responsavel_tecnico = opts.respTec.email;
    payload.telefone_responsavel_tecnico = opts.respTec.telefone;
    // NEVER identificador_csrt/hash_csrt: the hash needs the final chave (cNF generated by Focus).
  }
```

A 3-argument call produces the same payload as today.

### 3.4 Emission integration (`nfe-emission.usecase.ts`)

Constructor: `constructor(deps?: { sleep?: (ms:number)=>Promise<void>; now?: ()=>number })` (additive; defaults to `setTimeout`/`Date.now`). New dependency: `this.respTecRepo = new CompanyFiscalRespTecRepository()`.

**3.4.1 Before the claim (after :111-120, replacing :124-126 only when the resolver is active)**

```ts
const usarResolver = isRespTecPorEmpresaEnabled() || isFocusHardeningEnabled();
let resolved: NfeProviderResolved | null = null;
if (usarResolver) {
  const respTecRow = isRespTecPorEmpresaEnabled() ? await this.respTecRepo.findByConfigId(config.id) : null;
  resolved = resolveNfeProviderConfig(config, { modelo, respTecRow, env: process.env, decryptSecret });  // throws BEFORE the claim
} else if (!isSefazDirect && !config.providerToken) {
  throw new Error("Token do provedor fiscal nao configurado");                                       // :124-126 unchanged
}
this.validate(draft, config);                                                                          // :129
```

**3.4.2 Reuse decision (at :226-254)**

```ts
let reusarNumero = shouldReuseNumero({...}, ambiente, reemissaoRejeitadaEnabled, { classificacaoV2: isNfeCStatClassificacaoV2Enabled() });
let precisaConsultaPrevia = false;
if (!reusarNumero && isReusoNaoEnviadaEnabled() && draft.numero > 0) {
  const ultimo = await this.nfeRepo.findUltimoDesfechoEnvio(nfeId);
  const d = decidirReusoPorDesfecho(
    { numero: draft.numero, serie: draft.serie, ambienteDraft: draft.ambiente, ambienteAtual: ambiente,
      modelo, companyFiscalConfigId: config.id }, ultimo);
  reusarNumero = d.reusar; precisaConsultaPrevia = d.precisaConsultaPrevia;
}
```

The `NUMERADA` audit (:280) gets `{ ..., reaproveitado: reusarNumero, origemReuso }` when either flag is on.

New pure module `app/fiscal/domain/nfe-reuso-desfecho.ts`:

```ts
export const EVENTOS_DESFECHO = ["NUMERADA","NAO_ENVIADA","REJEITADA","AUTORIZADA","ENVIO_INCERTO","CONTINGENCIA_ADIADA"] as const;
export function decidirReusoPorDesfecho(atual, ultimo: { evento: string; detalhes: any } | null) {
  const nao = { reusar: false, precisaConsultaPrevia: false };
  if (!ultimo || !(atual.numero > 0)) return nao;
  const d = ultimo.detalhes ?? {};
  const eleg = ultimo.evento === "NAO_ENVIADA" || (ultimo.evento === "REJEITADA" && d.desfecho === "REJEITADA_PROVEDOR");
  if (!eleg) return nao;
  const mesmaTupla = d.numero === atual.numero && d.serie === atual.serie && d.ambiente === atual.ambienteAtual
    && atual.ambienteDraft === atual.ambienteAtual && d.modelo === atual.modelo && d.companyFiscalConfigId === atual.companyFiscalConfigId;
  return mesmaTupla ? { reusar: true, precisaConsultaPrevia: d.confirmado === false } : nao;
}
```

Repository `nfe.repository.ts`:

```ts
findUltimoDesfechoEnvio(nfeId) {
  return prisma.nfeAuditLog.findFirst({
    where: { nfeId, evento: { in: EVENTOS_DESFECHO } },
    orderBy: { createdAt: "desc" },
    select: { evento: true, detalhes: true, createdAt: true } });
}
```

- **Why the audit log and not a new column:** no DDL, the existing index on `nfeId` covers it, and NUMERADA already records the numbering history.
- **Conservative by design:** a later NUMERADA or a different tuple means a new number is reserved.
- **Extension point for the numbering design (R1):** accepting `REJEITADA` with `desfecho:"REJEITADA_SEFAZ"` and `isCStatRejeicaoReaproveitavel(d.cStat, v2)` would fix edit→DRAFT without touching `updateDraft`. Not enabled in this batch.

**3.4.3 Payload (:295-321)**

- SEFAZ: `if (resolved?.respTec.origem === "EMPRESA") sefazPayload.respTec = resolved.respTec.dados; else if (resolved?.respTec.origem === "OMITIR") sefazPayload.respTec = null;` The `ENV_LEGADO` case does not create the key.
- Focus: `this.xmlBuilder.build(nfeWithNumero, config, numero, resolved ? { numeracaoDexo: resolved.numeracao === "DEXO", respTec: resolved.respTec.origem === "EMPRESA" ? paraFocus(resolved.respTec.dados) : null } : undefined)`.
- The `xmlOriginal` snapshot (:307-316) keeps using `redactConfig(config)`. **The CSRT lives only in `payload.respTec` and is never serialized.**

**3.4.4 Consult before resending, then send (:357-362)**

```ts
sentToSefaz = true;
let providerResult: NfeProviderEmitResult | null = null;
if (precisaConsultaPrevia && !isSefazDirect && isFocusHardeningEnabled()) {
  const previa = await provider.consultar(nfeId, token);
  await this.nfeRepo.addAuditLog(nfeId, userId, "CONSULTA_PREVIA", { status: previa.status, desfecho: previa.desfecho ?? null, httpStatus: previa.httpStatus ?? null });
  if (previa.status === "autorizada") providerResult = consultaComoEmitResult(previa);                  // skip the POST
  else if (previa.status === "processando") return this.pendingResult(nfeId, numero, draft.serie, previa, "NF-e em processamento no Focus — reconsultar");
  else if (previa.desfecho === "NAO_ENVIADA" || previa.desfecho === "INCERTA")
    return this.handleNaoEnviada(nfeId, userId, numero, draft.serie, previa, tupla, false);
  // NAO_CONSTA or rejeitada ⇒ POST normally (Focus accepts a re-POST of the same ref after erro_autorizacao)
}
providerResult ??= await provider.emitir({ nfeData: payload, token, ref: nfeId });
```

Contingência 7b (:377) gets an extra `&& providerResult.desfecho !== "NAO_ENVIADA"`.

**3.4.5 Handling the result (before :457)**

```ts
if (providerResult.desfecho === "NAO_ENVIADA")
  return this.handleNaoEnviada(nfeId, userId, numero, draft.serie, providerResult, tupla, true);
if (!isSefazDirect && isFocusHardeningEnabled() &&
    (providerResult.status === "processando" || providerResult.desfecho === "INCERTA")) {
  const c = await this.reconciliarFocus(provider, nfeId, token, { postIncerto: providerResult.desfecho === "INCERTA" });
  if (c.status === "autorizada") return this.handleAuthorized(..., c.chaveAcesso!, c.protocolo!, c.dataAutorizacao, provider, config, null,
                                                             { numeracao: resolved!.numeracao, provedor: c, xmlUrl: c.xmlUrl, sequenceOpts });
  if (c.status === "rejeitada") return this.handleRejected(nfeId, userId, numero, draft.serie, c.mensagem, c.codigoStatus,
                                                          { codigoRaw: c.codigoRaw, httpStatus: c.httpStatus, desfecho: c.desfecho as any, tupla });
  if (c.desfecho === "NAO_CONSTA" && providerResult.desfecho === "INCERTA")
    return this.handleNaoEnviada(nfeId, userId, numero, draft.serie,
      { ...c, mensagem: "Não foi possível confirmar o envio ao Focus e nada consta para esta nota. Tente novamente: a mesma referência será consultada antes do reenvio." }, tupla, false);
  if (providerResult.desfecho === "INCERTA")
    await this.nfeRepo.addAuditLog(nfeId, userId, "ENVIO_INCERTO", { mensagem: c.mensagem, desfecho: c.desfecho, httpStatus: c.httpStatus ?? null, codigoRaw: c.codigoRaw ?? null });
  return this.pendingResult(nfeId, numero, draft.serie, providerResult, "NF-e enviada — aguardando processamento (reconsultar)");
}
// Focus "autorizada" (sync 201) → :506-519 with extras { numeracao, provedor: providerResult }
// "rejeitada" → :539-546 with extra (desfecho REJEITADA_PROVEDOR|REJEITADA_SEFAZ|DENEGADA|DUPLICIDADE)
// flag off → :457-546 verbatim
```

`reconciliarFocus` (private):

```ts
const esperas = parseEsperas(process.env.NFE_FOCUS_RECONCILIAR_ESPERAS_MS) ?? [2000, 4000, 8000];
const fim = this.now() + lerMs("NFE_FOCUS_ORCAMENTO_EMISSAO_MS", 40000);
let naoConsta = 0, feitas = 0, ultimo: NfeProviderConsultaResult | null = null;
for (const e of esperas) {
  const espera = Math.min(Math.max(e, ultimo?.retryAfterMs ?? 0), 10000);
  if (this.now() + espera > fim) break;
  await this.sleep(espera); feitas++;
  const c = await provider.consultar(ref, token); ultimo = c;
  if (c.status === "autorizada" || c.status === "rejeitada" || c.status === "cancelada") return c;
  if (c.desfecho === "NAO_CONSTA") naoConsta++;
}
const todasNaoConsta = feitas > 0 && naoConsta === feitas;
return { ...(ultimo ?? processandoVazio()),
         desfecho: opts.postIncerto && todasNaoConsta ? "NAO_CONSTA" : (ultimo?.desfecho === "INCERTA" ? "INCERTA" : "PROCESSANDO") };
```

After a POST that returned 202, a 404 is treated as PROCESSANDO: Focus accepted the POST, so it is eventual consistency.

**3.4.6 `handleNaoEnviada` (new)**

```ts
private async handleNaoEnviada(nfeId, userId, numero, serie, r, tupla, confirmado: boolean): Promise<EmissionResult> {
  const data: Record<string, unknown> = { status: "REJECTED", motivoRejeicao: r.mensagem };
  if (isNfeReemissaoRejeitadaEnabled()) data.cStatRejeicao = null;
  await (prisma as any).nfeEmitida.update({ where: { id: nfeId }, data, select: { id: true } });
  await this.nfeRepo.addAuditLog(nfeId, userId, "NAO_ENVIADA", {
    mensagem: r.mensagem, httpStatus: r.httpStatus ?? null, codigoRaw: r.codigoRaw ?? null, confirmado, ...tupla });
  return { success: false, nfeId, status: "REJECTED", numero, serie, chaveAcesso: null, protocolo: null, mensagem: r.mensagem };
}
```

- HTTP 200 with `success:false`: the wizard shows `data.mensagem` (`nfe-wizard.tsx:494-498`) and the PDV shows `rejected` (`finance.usecase.ts:1914`).
- The `NAO_ENVIADA` audit is always written, so a retry after B2 is turned on still finds the evidence.

**3.4.7 SEFAZ direct and the catch path (B2)**

- `sefaz-direct.provider.ts:199-205, :216-223, :243-250`: when `isReusoNaoEnviadaEnabled()`, return `{ ...makeEmitErrorResult(...), desfecho: "NAO_ENVIADA" }`. These are local failures, so nothing left the machine.
- Catch at :551-556:

```ts
if (!sentToSefaz) {
  await this.forceStatus(nfeId, "DRAFT");
  await this.nfeRepo.addAuditLog(nfeId, userId, "EDITADA_DRAFT", {...});        // as today
  if (isReusoNaoEnviadaEnabled() && numeroGravado)                                // set to true right after :262-278
    await this.nfeRepo.addAuditLog(nfeId, userId, "NAO_ENVIADA", { ...tupla, confirmado: true, fase: "pre_envio",
                                                                     mensagem: String(msg).slice(0, 300) });
}
```

**3.4.8 `handleAuthorized` with the real numbering written back (B1, Focus only)**

New optional 11th parameter: `extras?: { numeracao: "DEXO"|"PROVEDOR"; provedor?: {numeroAutorizado?, serieAutorizada?}; xmlUrl?: string; sequenceOpts: SequenceEmitterOpts }`.

Order of operations:
1. Transition to AUTHORIZED (:802).
2. `buscarXml(nfeId, token, { xmlUrl })`.
3. Normalize the chave: `const chave = normalizeChaveAcesso(chaveAcesso) ?? chaveAcesso;` If it stays invalid, audit `CHAVE_FORMATO_INVALIDO`.
4. Find the real numbering. Preference order:
   1. `extrairNumeracaoDaChave(chave)` when the chave is valid (it is what SEFAZ authorized);
   2. `parseNfeXml(xml).ide`;
   3. `provedor.numeroAutorizado/serieAutorizada`.
   If the sources disagree, audit `NUMERACAO_FONTES_DIVERGENTES`.
5. `const final = await this.gravarNumeracaoReal({...})` (below).
6. DANFE: with B1 on and XML available, try `generateFromXml(xml)` first (same pattern as :849-859), then fall back to the DB, which `loadNfe` now reads with the corrected number.
7. Update (:907-916) with the normalized `chaveAcesso`.
8. Audit `AUTORIZADA` `{chaveAcesso, protocolo, numero: final.numero, serie: final.serie}`.
9. Return `final.numero`/`final.serie`.

```ts
private async gravarNumeracaoReal(ctx): Promise<{ numero: number; serie: number }> {
  if (ctx.real.nNF === ctx.numero && ctx.real.serie === ctx.serie) return { numero: ctx.numero, serie: ctx.serie };
  let gravado = false, conflito = false, erro: string | null = null;
  try {
    await (prisma as any).nfeEmitida.update({ where: { id: ctx.nfeId }, data: { numero: ctx.real.nNF, serie: ctx.real.serie }, select: { id: true } });
    gravado = true;
  } catch (e: any) { conflito = e?.code === "P2002"; if (!conflito) erro = String(e?.message ?? e).slice(0, 300); }
  // NEVER rethrow: the note is already authorized. A P2002 means another row holds that number (the prod case: DB 12 vs nNF 3).
  await this.nfeRepo.addAuditLog(ctx.nfeId, ctx.userId, "NUMERO_DIVERGENTE", {
    numeroReservado: ctx.numero, serieReservada: ctx.serie, numeroReal: ctx.real.nNF, serieReal: ctx.real.serie,
    fonte: ctx.real.fonte, numeracao: ctx.numeracao, gravado, conflito, erro });
  if (ctx.numeracao === "DEXO") {
    try {
      const prox = await this.sequenceService.consultarProximoNumero(ctx.userId, ctx.ambiente, ctx.real.serie, ctx.modelo, ctx.sequenceOpts);
      if (ctx.real.nNF + 1 > prox) {
        await this.sequenceService.ajustarProximoNumero(ctx.userId, ctx.ambiente, ctx.real.serie, ctx.real.nNF + 1, ctx.modelo, ctx.sequenceOpts);
        await this.nfeRepo.addAuditLog(ctx.nfeId, ctx.userId, "SEQUENCIA_AVANCADA", { de: prox, para: ctx.real.nNF + 1 });
      }
    } catch { /* best-effort: the sequence only ever moves forward */ }
  }
  return gravado ? { numero: ctx.real.nNF, serie: ctx.real.serie } : { numero: ctx.numero, serie: ctx.serie };
}
```

`sequenceOpts` is the same object passed at :248-253; capture it in a `const` before the reservation.

### 3.5 List and wizard

- **List** (`nfe.repository.ts:690-759`), with B2 on:
  - Add `companyFiscalConfigId: true` to the select.
  - Run **one** extra query only for page rows that are `REJECTED` with `cStatRejeicao == null`: `nfeAuditLog.findMany({ where: { nfeId: { in: ids }, evento: { in: EVENTOS_DESFECHO } }, orderBy: { createdAt: "desc" }, select: { nfeId, evento, detalhes, createdAt } })`. Take the first row per `nfeId` and set `reaproveitavel ||= decidirReusoPorDesfecho(tupla da linha, ultimo).reusar`.
  - This makes the "Tentar novamente" button (`nfe-list.tsx:784-800`) appear for notes that were never sent.
- **Draft GET** (`nfe-draft.usecase.ts:483-492`), with B2 on:
  - For REJECTED rows, attach `origemRejeicao: "SEFAZ" | "PROVEDOR" | "NAO_ENVIADA"` from the last recorded outcome.
  - Set `reaproveitavel ||= decidirReusoPorDesfecho(...).reusar`.
  - Additive fields in `nfe.interface.ts:169-171`.
- **Banner:** new pure module `app/notas-fiscais/lib/rejeicao-banner.ts` exporting `tituloRejeicao(origem?: string): string`:
  - SEFAZ or undefined: "Esta nota foi rejeitada pela SEFAZ"
  - PROVEDOR: "O provedor fiscal recusou os dados antes de enviá-los à SEFAZ"
  - NAO_ENVIADA: "Esta nota não chegou a ser enviada"
  
  `nfe-wizard.tsx:539` uses it only when `NEXT_PUBLIC_NFE_ENVIO_DESFECHO_UI_ENABLED === "true"`.

### 3.6 Existing Focus tenants in homologação

With every flag off, the payload is built by the 3-argument `build` path, the provider methods run their legacy code, and `emit` takes the legacy branches. With B1 on and B3 off, numbering stays with Focus (`numero_nota` is sent as before, and Focus ignores it). The only differences are in classification, the real nNF being written back, and the chave being normalized.

### 3.7 Tests for (B)

- `tests/fiscal/focus-response.spec.ts` (pure): every row of both tables in §3.1, plus: HTML body on 401; `Retry-After: 30` gives 30000; `Rate-Limit-Reset: 5` gives 5000; `codigoStatus` never equals the HTTP status; the message never contains the token string passed in context.
- `tests/fiscal/focus-provider-hardening.spec.ts` (fetch stub like `focus-nfce-path.spec.ts:18-31`):
  - B1 on: `init.signal` is an `AbortSignal` in all 5 methods; 201 `autorizado` with chave `"NFe"+44` gives 44 digits and `numeroAutorizado` 11.
  - `cancelar` 200 with `status:"erro_cancelamento"` gives `success:false`.
  - **Regression with B1 off:** 201 gives `processando`; 401 with HTML gives status `erro` with the JSON parse message; consult 404 JSON gives `processando`; 422 `codigoStatus` equals the raw string.
- `tests/fiscal/nfe-xml-builder-focus-numeracao.spec.ts`:
  - 3-argument call: `numero_nota === "12"`, no `numero` key, no `*_responsavel_tecnico`, and the full key list equals the legacy snapshot.
  - `{numeracaoDexo:true}`: `numero === "12"`, `serie === "3"`, no `numero_nota`.
  - `respTec`: the 4 fields present; `identificador_csrt` and `hash_csrt` never present.
- `tests/fiscal/chave-acesso-formato.spec.ts`: prefix stripped; 44 digits in, same out; invalid DV gives null; `extrairNumeracaoDaChave`; `dvValido` agrees with `calcularDV`.
- `tests/fiscal/nfe-reuso-desfecho.spec.ts`:
  - Matching tuple gives reuse; each field that differs (numero, serie, ambiente, draft ambiente, modelo, cfc) gives no reuse.
  - `evento NUMERADA` gives no reuse; `REJEITADA` with REJEITADA_SEFAZ gives no reuse (legacy path); `confirmado:false` sets `precisaConsultaPrevia`.
- `tests/fiscal/nfe-emission-focus-desfecho.spec.ts` (vi.hoisted, `MockNfeProvider`, injected `sleep`):
  1. Emit returns 401/NAO_ENVIADA: one update `{REJECTED, motivo, cStatRejeicao:null}`, audit `NAO_ENVIADA` with the tuple, no `ENVIO_INCERTO`, result REJECTED, nothing thrown.
  2. Retry with that audit row as the last outcome: `reservarProximoNumero` **not** called and the number reused. A different series means it **is** called.
  3. INCERTA followed by consults returning NAO_CONSTA ×3: REJECTED plus `NAO_ENVIADA{confirmado:false}`.
  4. Next retry: consult first returns `autorizada`, `emitCalls.length === 0`, and `handleAuthorized` runs.
  5. 422 `erro_validacao_schema`: `REJEITADA{desfecho:"REJEITADA_PROVEDOR"}`, reusable.
  6. `denegado` 302: cStat 302, not reusable.
  7. Write-back: DB 12, chave nNF 3, update rejects with P2002: audit `NUMERO_DIVERGENTE{conflito:true}`, status stays AUTHORIZED, `EmissionResult.numero === 12`, nothing thrown. Without the conflict: `numero === 3`.
  8. DEXO numbering with nNF 20 and next number 15: `ajustarProximoNumero(…,21,…)`.
  9. **Flag-off characterization:** 401 gives SENDING plus `ENVIO_INCERTO` (R4, unchanged).
  10. Catch path with B2 on and `numeroGravado`: `EDITADA_DRAFT` plus `NAO_ENVIADA{fase:"pre_envio"}`.
- `tests/fiscal/sefaz/sefaz-direct-provider.spec.ts` (extend): build failure with B2 on gives `desfecho:"NAO_ENVIADA"`; with B2 off the result is deep-equal to the current one.
- `tests/rejeicao-banner.spec.ts` (node).

---

## 4. (C) Central provider resolver and per-company responsável técnico

### 4.1 Resolver `app/fiscal/providers/nfe-provider-resolver.ts` (pure; env and decrypt are injected)

```ts
export type RespTecModo = "PADRAO" | "PROVEDOR" | "PERSONALIZADO" | "NENHUM";
export interface RespTecRow { modo: RespTecModo; cnpj: string|null; xContato: string|null; email: string|null;
  fone: string|null; idCsrt: string|null; csrtEnc: string|null }
export type RespTecPolicy =
  | { origem: "ENV_LEGADO" }                   // SEFAZ: provider resolves from env (sefaz-direct.provider.ts:197) — unchanged
  | { origem: "PROVEDOR" }                     // Focus: send nothing (today)
  | { origem: "OMITIR" }                       // SEFAZ: payload.respTec = null ⇒ no <infRespTec>
  | { origem: "EMPRESA"; dados: NfeRespTec };  // SEFAZ: payload.respTec; Focus: 4 fields, no CSRT
export interface NfeProviderResolved {
  providerName: "FOCUS_NFE" | "SEFAZ_DIRECT"; ambiente: "HOMOLOGACAO" | "PRODUCAO"; modelo: "55" | "65";
  focus: { baseUrl: string; path: "nfe" | "nfce"; token: string } | null;   // never log this object
  sefaz: { uf: string } | null;
  numeracao: "DEXO" | "PROVEDOR";
  respTec: RespTecPolicy;
}
export function resolveNfeProviderConfig(config: CompanyFiscalConfig, o: {
  modelo: "55"|"65"; respTecRow: RespTecRow | null; env: Record<string,string|undefined>; decryptSecret: (enc: string) => string;
}): NfeProviderResolved {
  const providerName = config.providerName === "SEFAZ_DIRECT" ? "SEFAZ_DIRECT" : "FOCUS_NFE";   // same default as provider-factory.ts:37-39
  const ambiente = config.ambiente === "PRODUCAO" ? "PRODUCAO" : "HOMOLOGACAO";
  let focus = null;
  if (providerName === "FOCUS_NFE") {
    const token = (config.providerToken ?? "").trim();
    if (!token) throw new Error(`Token do provedor Focus NFe nao configurado para o ambiente ${ambiente} — informe em Configuracoes fiscais`);
    focus = { baseUrl: focusBaseUrl(ambiente === "PRODUCAO" ? "producao" : "homologacao"), path: o.modelo === "65" ? "nfce" : "nfe", token };
  }
  return { providerName, ambiente, modelo: o.modelo, focus,
    sefaz: providerName === "SEFAZ_DIRECT" ? { uf: config.uf ?? "" } : null,
    numeracao: providerName === "SEFAZ_DIRECT" ? "DEXO" : (isFocusNumeracaoDexo(config.id, o.env) ? "DEXO" : "PROVEDOR"),
    respTec: resolveRespTec(providerName, o.env.NFE_RESP_TEC_POR_EMPRESA_ENABLED === "true" ? o.respTecRow : null, o.decryptSecret) };
}
export function resolveRespTec(provider, row: RespTecRow | null, decrypt): RespTecPolicy {
  const modo = row?.modo ?? "PADRAO";
  if (provider === "SEFAZ_DIRECT") {
    if (modo === "PADRAO") return { origem: "ENV_LEGADO" };
    if (modo === "NENHUM") return { origem: "OMITIR" };
    if (modo === "PROVEDOR") throw new Error("Responsavel tecnico invalido: o modo 'Provedor' nao se aplica ao SEFAZ Direto — escolha Padrao, Personalizado ou Nenhum");
  } else if (modo !== "PERSONALIZADO") return { origem: "PROVEDOR" };            // PADRAO/PROVEDOR/NENHUM on Focus
  const v = validarRespTec({ ...row!, csrtConfigurado: !!row!.csrtEnc }, provider); // throws "incompleto"/"invalido" (unaccented ⇒ HTTP 400, fiscal.routes.ts:948-954)
  if (!v.ok) throw new Error(`Responsavel tecnico incompleto ou invalido — ${Object.values(v.erros).join("; ")}`);
  const dados: NfeRespTec = { cnpj: v.normalizado.cnpj, xContato: v.normalizado.xContato, email: v.normalizado.email, fone: v.normalizado.fone };
  if (provider === "SEFAZ_DIRECT" && row!.idCsrt && row!.csrtEnc) {
    let csrt: string;
    try { csrt = decrypt(row!.csrtEnc); } catch { throw new Error("CSRT do responsavel tecnico invalido ou ilegivel — cadastre novamente"); }
    Object.assign(dados, { idCSRT: row!.idCsrt, csrt });
  }
  return { origem: "EMPRESA", dados };
}
```

**Mode semantics**

| Mode | SEFAZ direct | Focus |
|---|---|---|
| PADRAO (or no row, or C1 off) | env `NFE_RESP_TEC_*`, unchanged (empty env ⇒ group omitted) | sends nothing (unchanged) |
| PROVEDOR | not allowed (validation on save; error before the claim if the provider changes later) | sends nothing (Focus fills it) |
| PERSONALIZADO | company data; `idCSRT` + `hashCSRT` when both exist | `cnpj/contato/email/telefone_responsavel_tecnico`; **never `hash_csrt`**, because the hash needs the final chave including the cNF that Focus generates |
| NENHUM | `<infRespTec>` omitted | treated as PROVEDOR (Dexo cannot make Focus omit it); the UI does not offer it |

In this batch the resolver is only wired into emission. Cancellation (`nfe-cancelamento.usecase.ts:89-107`) and inutilização (`:93-136`) adopt it later, after characterization tests, because they do not carry a responsável técnico. The resolver passes `modelo` along, which avoids the `provider-factory.ts:120-121` bug.

### 4.2 Validation `app/fiscal/domain/resp-tec.ts` (pure, client-safe; imports `isValidCnpj` from `app/lib/masks`)

```ts
export function modosPermitidos(providerName: string | null): RespTecModo[] {
  return providerName === "SEFAZ_DIRECT" ? ["PADRAO","PERSONALIZADO","NENHUM"] : ["PADRAO","PROVEDOR","PERSONALIZADO"];
}
export function validarRespTec(i: { modo; cnpj?; xContato?; email?; fone?; idCsrt?; csrtNovo?: string|null; csrtConfigurado: boolean; removerCsrt?: boolean }, providerName)
  : { ok: true; normalizado } | { ok: false; erros: Record<string,string> }
```

- The mode must be in `modosPermitidos`.
- **PERSONALIZADO:**
  - `cnpj`: 14 digits and `isValidCnpj`
  - `xContato`: trimmed, 2–60 characters
  - `email`: 6–60 characters, `^[^\s@]+@[^\s@]+\.[^\s@]{2,}$`
  - `fone`: digits only, 6–14
  - `idCsrt`: empty or `^\d{2}$`
  - CSRT: 1–128 characters, no whitespace
  - `idCsrt` and a CSRT (new or already saved, and not being removed) must come together
  - **Focus plus a new CSRT or `idCsrt` is an error:** "O CSRT não é enviado via Focus: o hash depende do cNF gerado pelo Focus."
- Other modes: data fields are ignored; stored values stay so the user can switch back.
- Error messages are unaccented where they are thrown into `/issue` (400 mapping).

### 4.3 New table, `prisma/ddl/2026-09-17-company-fiscal-resp-tec.sql`

```sql
-- EXECUTE BEFORE TURNING ON NFE_RESP_TEC_POR_EMPRESA_ENABLED. NEW table: code can deploy first (flag off never touches it).
BEGIN;
CREATE TABLE IF NOT EXISTS "CompanyFiscalRespTec" (
  "id" TEXT NOT NULL,
  "companyFiscalConfigId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "modo" TEXT NOT NULL DEFAULT 'PADRAO',          -- PADRAO|PROVEDOR|PERSONALIZADO|NENHUM (TEXT, validated in code)
  "cnpj" TEXT, "xContato" TEXT, "email" TEXT, "fone" TEXT,
  "idCsrt" TEXT,
  "csrtEnc" TEXT,                                   -- AES-256-GCM (FISCAL_CERT_ENC_KEY); never leaves the API
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CompanyFiscalRespTec_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "CompanyFiscalRespTec" DROP CONSTRAINT IF EXISTS "CompanyFiscalRespTec_companyFiscalConfigId_fkey";
ALTER TABLE "CompanyFiscalRespTec" ADD CONSTRAINT "CompanyFiscalRespTec_companyFiscalConfigId_fkey"
  FOREIGN KEY ("companyFiscalConfigId") REFERENCES "CompanyFiscalConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "CompanyFiscalRespTec_companyFiscalConfigId_key" ON "CompanyFiscalRespTec" ("companyFiscalConfigId");
CREATE INDEX IF NOT EXISTS "CompanyFiscalRespTec_userId_idx" ON "CompanyFiscalRespTec" ("userId");
ALTER TABLE "CompanyFiscalRespTec" ENABLE ROW LEVEL SECURITY;
COMMIT;
-- Verification: SELECT indexname FROM pg_indexes WHERE tablename='CompanyFiscalRespTec';
-- Rollback: flag off + restart → DROP TABLE IF EXISTS "CompanyFiscalRespTec";
```

Prisma model (scalar only, **no `@relation`**, so `CompanyFiscalConfig` stays untouched; the foreign key lives only in the DDL):

```prisma
model CompanyFiscalRespTec {
  id                    String   @id @default(cuid())
  companyFiscalConfigId String   @unique
  userId                String
  modo                  String   @default("PADRAO")
  cnpj                  String?
  xContato              String?
  email                 String?
  fone                  String?
  idCsrt                String?
  csrtEnc               String?
  updatedByUserId       String?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  @@index([userId])
}
```

The unique index is a full one, so it can be represented in the schema. `prisma db push` stays forbidden. Tests mock prisma, so no local generate is needed. If one is run, restore the shared client afterwards.

### 4.4 Repository, use case, routes

**Repository `app/repositories/company-fiscal-resp-tec.repository.ts`**
- `findByConfigId(id)`: `findUnique({ where: { companyFiscalConfigId: id } })`
- `upsert(configId, userId, data)`: `upsert({ where: { companyFiscalConfigId }, create: {...}, update: data })`

**Encryption helper `app/fiscal/certificate/fiscal-secret.ts`:** `encryptFiscalSecret` / `decryptFiscalSecret`, delegating lazily to `CertificateManagerService` (:59-91).

**Use case `app/usecases/company-fiscal-resp-tec.usecase.ts`**

```ts
async get(userId, companyId: string|null) {
  const config = companyId ? await cfgRepo.findByIdForUser(companyId, userId) : await cfgRepo.findByUserId(userId);
  if (!config) throw new Error("Empresa não encontrada");
  const row = await repo.findByConfigId(config.id);
  return { respTec: publico(row), efetivo: descreverEfetivo(config.providerName, row, process.env), modosPermitidos: modosPermitidos(config.providerName) };
}
// publico: {modo, cnpj, xContato, email, fone, idCsrt, csrtConfigurado: !!csrtEnc, updatedAt} — NEVER csrtEnc
// descreverEfetivo: SEFAZ+PADRAO ⇒ {origem:"ENV", cnpj: resolveRespTecFromEnv(env)?.cnpj ?? null}; Focus ⇒ {origem:"PROVEDOR"}; etc.
async put(userId, actorId, companyId, body) {
  const config = ...; const atual = await repo.findByConfigId(config.id);
  const v = validarRespTec({ ...body, csrtNovo: body.csrtToken?.trim() || null, csrtConfigurado: !!atual?.csrtEnc, removerCsrt: body.removerCsrt === true }, config.providerName);
  if (!v.ok) throw new Error(`Dados do responsável técnico inválidos: ${Object.values(v.erros).join("; ")}`);
  const data = { modo: v.normalizado.modo, cnpj, xContato, email, fone, idCsrt, updatedByUserId: actorId,
    ...(v.normalizado.csrtNovo ? { csrtEnc: encryptFiscalSecret(v.normalizado.csrtNovo) } : body.removerCsrt ? { csrtEnc: null, idCsrt: null } : {}) };
  await repo.upsert(config.id, userId, data);
  await SystemLogService.log({ userId, action: "UPDATE_FISCAL_CONFIG", resource: "CompanyFiscalRespTec", resourceId: config.id, level: "INFO",
    message: "Responsável técnico alterado", details: { modoAnterior: atual?.modo ?? "PADRAO", modoNovo: data.modo,
      cnpjAlterado: atual?.cnpj !== data.cnpj, contatoAlterado: ..., csrtAlterado: !!v.normalizado.csrtNovo, csrtRemovido: body.removerCsrt === true } });
  return this.get(userId, companyId);
}
```

`UPDATE_FISCAL_CONFIG` already exists at `system-log.interface.ts:22`. Values are never logged.

**Routes in `fiscal.routes.ts`, next to :329-529**
- `GET/PUT /config/resp-tec` (default company) and `GET/PUT /companies/:id/resp-tec`.
- When `!isRespTecPorEmpresaEnabled()`: 404 `{error:"Recurso não habilitado"}`.
- Tenant: `user.dataOwnerId`. Actor: `user.id` (`auth.middleware.ts:24-25`).
- Errors go through `companyErrorStatus` (:336-355): "inválid" gives 400, "não encontrad" gives 404.
- PUT body: `{ modo, cnpj?, xContato?, email?, fone?, idCsrt?, csrtToken?, removerCsrt? }`. The secret field is named **`csrtToken`** so the middleware redacts it by the "token" substring.

### 4.5 Sanitize, redaction and logging rules

- `logging.middleware.ts:383-403`: add `"csrt"` to `SENSITIVE_FIELD_PATTERNS`. Only log content changes, and no existing field contains that substring.
- `sanitizeFiscalConfig` (:136-139): add `delete safe.respTec; delete safe.csrtEnc;` as a defensive no-op, since today's objects do not carry them.
- `redactConfig` (:1221): also strip `respTec` and `csrtEnc`.
- (Side finding #2, a separate task: `cscToken`.)
- Rules for implementers:
  - The CSRT is decrypted only inside `resolveRespTec`, lives only in `SefazEmitPayload.respTec`, and is never passed to `addAuditLog`, `console`, `JSON.stringify(payload)` or error messages.
  - `NfeProviderResolved.focus.token` is never logged. Add `resolvedParaLog(r)`, which drops `focus.token` and `respTec.dados.csrt`.
  - Focus's `xmlOriginal` may contain `cnpj/contato/email/telefone_responsavel_tecnico`. These are public (they appear on the DANFE/XML).

### 4.6 Plumbing into the SEFAZ-direct provider

- `SefazEmitPayload` (`sefaz-direct.provider.ts:103-120`) gains `respTec?: NfeRespTec | null` (absent means env, `null` means omit).
- :197 becomes `respTec: payload.respTec === undefined ? resolveRespTecFromEnv() : (payload.respTec ?? undefined),`.
- Contingência (`reemitViaSvc`, :587-591) spreads the payload, so the setting carries over.
- Update the comment at `nfe-xml-builder-sefaz.service.ts:61-66` and `resp-tec.ts:4-6` (no longer "the same for every tenant").

### 4.7 UI

**`app/notas-fiscais/components/steps/resp-tec-card.tsx`**
- Rendered in `environment-step.tsx` after :259/:286 when `const RESP_TEC_UI = process.env.NEXT_PUBLIC_NFE_RESP_TEC_POR_EMPRESA_ENABLED === "true"` and `configExists`.
- Props already present in the step (:19-32): `userEmail`, `companyId`, `configExists`, plus `providerName` from the existing `useWatch` (:46).
- Local state only, outside RHF, so `fiscal-config-schema` and the form submit are untouched.
- On mount or `companyId` change: GET `${api}/fiscal/${companyId ? `companies/${companyId}` : "config"}/resp-tec` with header `email`.
- Save button is `type="button"` and does a PUT.
- Contents:
  - Mode select filtered by `modosPermitidos`.
  - Summary of what is in effect (`efetivo`).
  - PERSONALIZADO fields: CNPJ (mask), contact, e-mail, phone.
  - SEFAZ only: idCSRT, CSRT as a password field with "•••• (CSRT salvo — deixe em branco para manter)", and a "Remover CSRT" checkbox.
  - If the watched `providerName` differs from `efetivo.providerName`: notice "Salve a troca de provedor antes de ajustar o responsável técnico" and saving is disabled.
  - Focus note: "No Focus NFe, o responsável técnico é preenchido pelo provedor, salvo no modo Personalizado. O CSRT não é enviado via Focus."

**Pure logic `app/notas-fiscais/lib/resp-tec-card.ts`** (node tests): `rotuloModo`, `camposVisiveis(provider, modo)`, `podeSalvar(form, providerSalvo, providerAtual)`, `montarPayload(form)` (sends `csrtToken` only when typed), `resumoEfetivo(resp)`, `avisos(provider, modo, csrtConfigurado)`. It reuses `validarRespTec`.

### 4.8 Tests for (C)

- `tests/fiscal/nfe-provider-resolver.spec.ts`:
  - SEFAZ with no row gives `ENV_LEGADO`; with the flag off, a PERSONALIZADO row is **ignored**; SEFAZ NENHUM gives `OMITIR`; SEFAZ PROVEDOR throws a message containing "invalido".
  - SEFAZ PERSONALIZADO gives the data plus a decrypted CSRT (decrypt stub).
  - Focus PADRAO/PROVEDOR/NENHUM give `PROVEDOR`; Focus PERSONALIZADO gives data **without** CSRT even when `csrtEnc` exists.
  - Focus without a token throws a message containing "Token" and the ambiente, and the message never contains token-like data.
  - `numeracao` by allowlist (`*`, id, empty, B1 off). `focus.path` is `nfce` for 65.
- `tests/fiscal/resp-tec-validacao.spec.ts`: CNPJ with a bad check digit; email; phone 5/6/14/15 digits; `xContato` 1/2/60/61; `idCsrt` "1"/"01"/"001"; only one of idCsrt/CSRT; Focus plus CSRT; `modosPermitidos`.
- `tests/fiscal/sefaz/sefaz-direct-resptec-payload.spec.ts`: `payload.respTec` undefined uses env (existing behaviour); `null` gives no `<infRespTec>` even with `NFE_RESP_TEC_CNPJ` set; an object gives the group plus `hashCSRT`.
- `tests/fiscal/nfe-emission-resptec.spec.ts`: resolver error means `nfeEmitida.updateMany` (claim) and `reservarProximoNumero` are **not** called; flag off means `respTecRepo.findByConfigId` is not called.
- `tests/fiscal/company-fiscal-resp-tec.usecase.spec.ts`: GET never returns `csrtEnc`; PUT with blank `csrtToken` keeps the saved value; `removerCsrt` clears it; the SystemLog `details` contain no values; another tenant's config gives "Empresa não encontrada".
- `tests/security/log-redaction.spec.ts` (extend): `csrtToken`, `csrt` and `idCsrt` are redacted.
- `tests/resp-tec-card.spec.ts` (node).

---

## 5. Kiko 4 X 4: what to configure (data only, nothing in code)

1. **`CompanyFiscalRespTec`** for config `cmrxiixko1spi1837uhscntiy`: `modo = PROVEDOR`, saved through the new card. **No CNPJ is stored**, because Focus supplies its own. This is behaviourally the same as PADRAO but records the decision.
2. **`providerToken`** must belong to the Focus environment matching `ambiente`. The config is HOMOLOGACAO today; the production 401s (série 3, nº 8, 9, 10) point to a token from the wrong environment. When switching to PRODUCAO, swap the token too.
3. **Dexo-controlled numbering:**
   - Run the diagnostic (§7) with `--config cmrxiixko1spi1837uhscntiy`.
   - Confirm `proximoNumero > max nNF autorizado` for (HOMOLOGACAO, série 3, 55).
   - Then set `NFE_FOCUS_NUMERACAO_DEXO_EMPRESAS=cmrxiixko1spi1837uhscntiy` and `NFE_FOCUS_NUMERACAO_DEXO_ENABLED=true` (with B1 on).
   - Kiko has no authorized production notes, so production série 3 starts from the current sequence. The legacy SENDING rows 8–10 **are not touched** (decision 3); the script only reports the gaps.
4. **External steps:**
   - Kiko's contador authorizes Focus as fornecedor/responsável técnico for CNPJ 11386276000176 in Receita PR/UPD. The **exact CNPJ Focus sends** must come from Focus support. 07504505000132 is only presumed; Dexo must not assume it.
   - Focus support to confirm:
     - that Focus sends `infRespTec` **and** the PR CSRT in production (rejection 975, mandatory since 01/04/2026);
     - that the JSON `numero` field is honoured, and how it interacts with automatic numbering;
     - whether a re-POST of the same ref is accepted after `erro_validacao_schema`;
     - the rate-limit header names;
     - the `caminho_xml_nota_fiscal` field versus `.xml`;
     - the `status` values returned by DELETE/inutilização.
   - Test emission in homologação: expect authorization (no 974), no `NUMERO_DIVERGENTE`, and the DB `numero` equal to the nNF in the chave.
   - Only then unlock production for Kiko.

---

## 6. Two tenants sharing one Focus token (diagnostic only)

- No automatic change and **no in-app warning to the tenant**: telling a tenant "this token is also used by someone else" would reveal whether another tenant's token is valid.
- The script lists groups by `sha256(providerToken)`, printing only 8 hex characters, where the group spans more than one distinct `userId`. It shows config ids, userId, masked CNPJ, ambiente and the date of the last note.
- Risk to report: with a shared token, one tenant could emit, consult or cancel on a CNPJ enabled in the other's Focus account (refs are cuids, so accidental collisions do not happen).
- Human action: contact both clients and Focus. Possible later step: a superadmin-only endpoint.

---

## 7. Read-only diagnostic script `scripts/fiscal/diagnostico-focus-resptec.ts`

- Runs everything inside `prisma.$transaction(async tx => { await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY"); ... }, { timeout: 60000 })`. Use `DIRECT_URL` on the VPS. Flags: `--json` and `--config <id>`. No CNPJ is embedded; tokens are never printed.
- **Section 1, Focus configs** (`providerName` null or `FOCUS_NFE`): id, userId, masked CNPJ, ambiente, `serieNfe`/`serieNfce`, `tokenHash8` or `SEM_TOKEN`.
- **Section 2, shared tokens:** as described in §6.
- **Section 3, numbering** per (cfc, ambiente, serie, modelo):
  - `NfeSequence.proximoNumero` and max DB `numero`;
  - from AUTHORIZED/CANCELLED rows, after `normalizeChaveAcesso`: max nNF, count of `numero ≠ nNF` (sample of 10 ids), count of 47-character chaves;
  - SENDING rows (id, numero, createdAt, last audit event);
  - REJECTED rows with a positive `numero` by `cStatRejeicao`;
  - `seguroLigarNumeracaoDexo = proximoNumero > maxNNFAutorizado`;
  - gaps `[1..proximoNumero-1] \ nNF autorizados` (count and the first 20).
- **Section 4, responsável técnico:** env `NFE_RESP_TEC_CNPJ` present? (masked); if the table exists (P2021 caught): counts per mode, PERSONALIZADO rows that are incomplete, Focus rows with `csrtEnc`.
- **Section 5, recent 974/975 rejections** per config, from `NfeAuditLog` `REJEITADA` `detalhes.cStat` or `motivoRejeicao ILIKE '%974%' OR '%Responsavel Tecnico%'`.
- (Optional, side finding #4) SEFAZ-direct SENDING rows whose last event is `ENVIADA`: list them so someone can inspect the `xmlOriginal` by hand.

---

## 8. `.env.example` and docs

**`.env.example`**
- Line 19: `NFE_RESP_TEC_CNPJ=""`. Remove the CNPJ and the "Jotabê" comment; explain it is set per environment. Rewrite :11-13 to say "padrão quando a empresa não tem RT próprio (ver CompanyFiscalRespTec)".
- New block (names only):

```
NFE_CSTAT_NORMALIZADO_ENABLED=""
NFE_CSTAT_CLASSIFICACAO_V2_ENABLED=""
NFE_FOCUS_HARDENING_ENABLED=""
NFE_REUSO_NAO_ENVIADA_ENABLED=""
NFE_FOCUS_NUMERACAO_DEXO_ENABLED=""
NFE_FOCUS_NUMERACAO_DEXO_EMPRESAS=""
NFE_FOCUS_TIMEOUT_EMITIR_MS=""
NFE_FOCUS_TIMEOUT_CONSULTA_MS=""
NFE_FOCUS_TIMEOUT_XML_MS=""
NFE_FOCUS_TIMEOUT_EVENTO_MS=""
NFE_FOCUS_RECONCILIAR_ESPERAS_MS=""
NFE_FOCUS_ORCAMENTO_EMISSAO_MS=""
NFE_RESP_TEC_POR_EMPRESA_ENABLED=""
NEXT_PUBLIC_NFE_RESP_TEC_POR_EMPRESA_ENABLED=""
NEXT_PUBLIC_NFE_ENVIO_DESFECHO_UI_ENABLED=""
```

**Docs**
- `docs/fiscal-sefaz-direto.md` (flags table around :189): one row per new flag, stating dependencies (B1 implies A1+A2; B3 needs B1 and the allowlist; C1 needs the DDL plus generate).
- `schema.prisma:1997`: add the new events to the comment list (`NAO_ENVIADA`, `NUMERO_DIVERGENTE`, `SEQUENCIA_AVANCADA`, `CONSULTA_PREVIA`, `NUMERACAO_FONTES_DIVERGENTES`, `CHAVE_FORMATO_INVALIDO`). Comment only.
- Fix the stale comment at :1824.

---

## 9. Files

**New**
- `app/fiscal/domain/cstat.ts`
- `app/fiscal/domain/nfe-flags.ts`
- `app/fiscal/domain/chave-acesso-formato.ts`
- `app/fiscal/domain/nfe-reuso-desfecho.ts`
- `app/fiscal/domain/resp-tec.ts`
- `app/fiscal/providers/focus-response.ts`
- `app/fiscal/providers/nfe-provider-resolver.ts`
- `app/fiscal/certificate/fiscal-secret.ts`
- `app/repositories/company-fiscal-resp-tec.repository.ts`
- `app/usecases/company-fiscal-resp-tec.usecase.ts`
- `app/notas-fiscais/components/steps/resp-tec-card.tsx`
- `app/notas-fiscais/lib/resp-tec-card.ts`
- `app/notas-fiscais/lib/rejeicao-banner.ts`
- `prisma/ddl/2026-09-17-company-fiscal-resp-tec.sql`
- `scripts/fiscal/diagnostico-focus-resptec.ts`
- Tests from §§2.8, 3.7, 4.8

**Modified**
- `app/fiscal/providers/nfe-provider.interface.ts`
- `app/fiscal/providers/focus-nfe.provider.ts`
- `app/fiscal/providers/sefaz-direct.provider.ts` (:103-120, :197, :199-250)
- `app/fiscal/generators/nfe-xml-builder.service.ts` (:41-57, :217)
- `app/fiscal/domain/nfe-number-reuse.ts` (:51-62)
- `app/usecases/nfe-emission.usecase.ts` (constructor, :111-129, :226-283, :295-362, :377, :457-546, :551-556, :789-937, :1051-1084, :1218-1225)
- `app/repositories/nfe.repository.ts` (:93-95, :690-759, new `findUltimoDesfechoEnvio`)
- `app/usecases/nfe-draft.usecase.ts` (:483-492)
- `app/interfaces/nfe.interface.ts` (:169-171)
- `app/routes/fiscal.routes.ts` (4 routes; :136-139)
- `app/middlewares/logging.middleware.ts` (:383-403)
- `app/fiscal/sefaz/resp-tec.ts` (comment)
- `app/fiscal/sefaz/nfe-xml-builder-sefaz.service.ts` (comment :61-66)
- `app/notas-fiscais/components/steps/environment-step.tsx`
- `app/notas-fiscais/components/nfe-wizard.tsx` (:539)
- `prisma/schema.prisma` (new model; comments)
- `.env.example`
- `docs/fiscal-sefaz-direto.md`

---

## 10. Gates and rollback

**Gates**
- `vitest run --pool=forks` (8 GB heap, main repo `node_modules`) on the new specs plus the existing affected ones:
  - `provider-contract`, `focus-nfce-path`, `nfe-emission-reuse`, `nfe-emission-company`, `nfe-resp-tec-env`
  - `sefaz/nfe-infresptec`, `sefaz/sefaz-direct-provider`, `sefaz/contingencia`
  - `nfe-update-draft-guard`, `nfe-frete-focus-e-danfe`, `nfe-xml-builder-focus-infcpl`, `pagamento-card`
  - `finance-nfce-endpoint`, `pdv-actions`, `security/log-redaction`, `company-fiscal-nfce-config`
- `tsc --noEmit` as a multiset diff against the clean HEAD baseline (98).
- `next build` (ESLint, `prefer-const`).

**Rollback**
- Each flag off, then pm2 restart; UI flags need a rebuild.
- The RT table: C1 off, then `DROP TABLE`.
- The new audit events stay in place and are inert.

---

## 11. Risks and open questions

1. **Focus documentation to confirm before turning on B1/B3:** the items listed in §5, step 4.
2. **Denied note (`DENEGADA`):** the Focus ref (= nfeId) is burned. A corrected note needs a **new draft**; the same row can never be authorized. The limitation exists today; the fix (a ref per attempt) is out of scope.
3. **INCERTA that ends as `processando`/unknown still goes to SENDING with no reconciler.** Only the "nothing on record at Focus" case becomes REJECTED. A reconciler or a "Consultar situação" action for new rows is a later batch (user decision 3 only concerns legacy rows).
4. **Consult-before-resend after an edit:** if the first send was actually authorized and the user edited the note meanwhile, the stored items may differ from the authorized XML. Mitigations: the DANFE is built from the fetched XML, and the audit logs `CONSULTA_PREVIA`. Recommendation for the numbering design: block item edits while the last outcome is `NAO_ENVIADA{confirmado:false}`.
5. **Codes 562 and 613 as duplicates** is a conservative reading (worst case: a gap in the numbering). Confirm against MOC 7.0 Anexo I.
6. **Rolling out B3 without the diagnostic** can cause 539/204 rejections for tenants whose Focus counter is ahead of Dexo's. That is why the allowlist exists.
7. **Side findings** #1–#5 in §1 need their own tasks, especially #2 (CSC readable through `/nfe/:id/xml`) and #5 (false CANCELLED from Focus).