# Frontend design: NF-e de devolução (quick action + existing wizard)

Scope: UI only, plus the API contract it needs. Backend numbering v2 and devolução emission are separate designs. Every claim about existing code cites file:line in the worktree at `1549bc4`.

---

## 0. What the current code means for this design

| Fact | Evidence | What it means for the design |
|---|---|---|
| The wizard always loads `?draft=` on mount, but only reads `window.location.search` once | `nfe-wizard.tsx:163-226`, `:171-172` | The quick action must navigate from another route (Emitidas). Inside the wizard, context comes from explicit handlers. |
| Every step's "Próximo" saves without waiting | `nfe-wizard.tsx:419` | In devolução mode, step 3 must wait for the save (409/422 must stop the user from moving on). |
| `saveDraft` fails silently | `use-nfe-draft.ts:115-128` | Devolução writes cannot use it. They need dedicated helpers that surface errors. |
| `updateDraft` forces DRAFT and clears the rejection | `nfe.repository.ts:379-381`; `/calculate` calls it at `fiscal.routes.ts:865-867` | R1. The UI must not promise number reuse on its own, and in devolução mode it only sends a PUT when something changed. |
| PUT `itens` deletes and recreates `NfeItem` rows | `nfe.repository.ts:434-441` | There is no stable item id, so devolução items go through a dedicated endpoint keyed by `nItemOriginal`. |
| `POST /fiscal/nfe/draft` without an order reuses the latest DRAFT 55, whatever its finalidade | `nfe-draft.usecase.ts:118-124`, `nfe.repository.ts:225-235` | Collision risk. Backend requirement plus a frontend defense (§5.2). |
| After create, the wizard only sets `serie` and never populates a reused draft | `nfe-wizard.tsx:210` | Already true today. The flag-on defense handles the devolução case. |
| Double-click window: the guard reads state, `await save` runs, and state is set only afterwards | `nfe-wizard.tsx:458,464,466` | Fix with `useRef` (§5.9). |
| The claim loser throws "ja esta em processamento", which the route maps to 500 | `nfe-emission.usecase.ts:151-155`, `fiscal.routes.ts:944-957` | While the backend still returns 500, the pure function treats that message the same as a 409. |
| After authorization the wizard redirects to `/notas-fiscais/nfe` | `nfe-wizard.tsx:488-490` | Devolução mode redirects to `/notas-fiscais/emitidas`. Normal mode is unchanged. |
| The quantity schema is `positive()` | `nfe-form-schema.ts:73` | Partial "0" means the item is left out of `itens`. The strip is separate state. |
| `chave-acesso.ts` imports `node:crypto` | `chave-acesso.ts:12` | Needs a new pure DV module and a parity test against `calcularDV` (`:103-122`). Do not edit the original file. |
| `cfop-catalog.ts` is pure and already imported by the client | `step-produtos.tsx:28`, `cfop-catalog.ts:1-9` | The new `devolucao-cfop.ts` goes next to it in `app/fiscal/domain`, shared with the backend. |
| 20 of the 105 indDevol CFOPs are missing from the local catalog (1212-1216, 2212-2216, 3212, 5213-5216, 6213-6216, 7212). 1949 and 2949 are present. | read-only check on `cfop-catalog.ts` | Descriptions need a fallback. Do not edit the catalog: it would change the normal-mode combobox. |
| The list has no "devolved" data. `hasXml` = autorizado OR original. | `nfe.repository.ts:749`; list select `:716-718` | Eligibility is checked per row in the pure function. The balance is fetched only when the menu opens, like the PDV (`pdv-sale-actions.tsx:138-149`). |
| POST with JSON Content-Type and an empty body fails in Fastify | `pdv-fiscal-docs.ts:44-49` | The API helper sends `{}` on POST/PUT and no Content-Type on DELETE. |
| The final step's text hardcodes "ambiente de homologacao" | `step-finalizar.tsx:192-196` | False in production. Do not repeat it in the devolução copy (out of scope to fix). |
| Vitest runs in `environment: "node"`; SSR rendering has a precedent | `vitest.config.ts:171`, `tests/highlight-text.spec.tsx:3` | Golden SSR snapshots without jsdom (§8). |

---

## 1. Flags

| Flag | Read by | Meaning |
|---|---|---|
| `NEXT_PUBLIC_NFE_DEVOLUCAO_ENABLED` | Front: `isNfeDevolucaoUiEnabled()`, literal reference inside the function. Next inlines it; tests use `vi.stubEnv`. Backend: same name read at call time, same pattern as `nfe-number-reuse.ts:24-26`, so the two cannot diverge. | Menu, badge, detail-sheet button, wizard modality, dedicated routes. |
| `NEXT_PUBLIC_NFE_EMISSAO_GUARD_ENABLED` | Front only | `useRef` guard and polling for 409 / "em processamento" in **normal** mode. Devolução mode always uses V2. |

Both return `=== "true"`, so `"1"`, `"TRUE"` and `""` are off. Rollout: backend with routes and flag off, then DDL for the new tables, then backend flag on, then front rebuilt with the flag. Turning the front flag on before the routes exist is handled: 404 gives the toast "recurso indisponível".

---

## 2. API contract the UI consumes

All routes are new; existing handlers are not touched. Headers are `{ email }`, plus `Content-Type` only when there is a body.

| # | Route | 2xx | Errors (`{ code, error, ... }`) |
|---|---|---|---|
| A | `POST /fiscal/nfe/:originalId/devolucao` body `{}` | 201 `{ draftId, reused:false }` / 200 `{ draftId, reused:true }` (idempotent: returns the open DRAFT/REJECTED devolução for that original) | 409: `DEVOLUCAO_TOTAL_JA_EMITIDA`, `DEVOLUCAO_EM_ENVIO`, `ORIGINAL_NAO_AUTORIZADA`, `ORIGINAL_CANCELADA`. 422: `ORIGINAL_SEM_XML`, `ORIGINAL_ENTRADA`, `MODELO_NAO_SUPORTADO`, `AMBIENTE_DIVERGENTE`, `EMITENTE_NAO_ENCONTRADO`, `ESCOLHA_NECESSARIA` (with optional `draftId`). 404. |
| B | `GET /fiscal/nfe/:originalId/devolucao/saldo` | `{ totalmenteDevolvida, rascunhoAberto:{draftId,status}\|null, emissaoEmAndamento:{nfeId,numero,status}\|null }` | 404 |
| C | `GET /fiscal/nfe/draft/:draftId/devolucao` | `{ contexto: DevolucaoContexto }` | 404 `SEM_REFERENCIA` |
| D | `POST /fiscal/nfe/draft/:draftId/devolucao/referencia` body `{ chave }` | `{ draft: NfeDraftResponse, contexto }` (converts the draft on the server) | 404 `ORIGINAL_NAO_ENCONTRADA`, the 409/422 codes from A, 409 `NAO_EDITAVEL` |
| E | `PUT /fiscal/nfe/draft/:draftId/devolucao` body `{ tipo?, entregaConfirmada?, itens?: [{nItemOriginal, quantidade, cfop}] }` | `{ draft, contexto }` | 409 `SALDO_INSUFICIENTE` (with fresh `contexto`), 409 `NAO_EDITAVEL`, 422 `VALIDACAO` (with `erros:[{nItemOriginal,campo,mensagem}]`) |
| F | `DELETE /fiscal/nfe/draft/:draftId/devolucao` | `{ draft }` (back to NORMAL/SAIDA, items and references removed) | 409 `NAO_EDITAVEL` |
| G (existing) | `GET /fiscal/nfe/:id` | `{ nfe: row }` (`fiscal.routes.ts:1123-1153`), used for polling | 404 |

Optional additive fields, only when the backend flag is on:
- list item `hasXmlAutorizado` (the column is already selected at `nfe.repository.ts:716`);
- `numeracao?: { reaproveitara: boolean; serie: number; numero: number|null }` on the GET draft (existing) and on `contexto`, computed by the **same** predicate that `emit` uses (numbering v2).

Backend requirements this UI depends on (not UI work):
1. Values in E and D are server-authoritative: price, NCM and description come from the original authorized XML, and `nItem` comes from `det@nItem`.
2. PUT `/draft/:id` (`fiscal.routes.ts:729-760`) must refuse `itens`, `finalidade`, `tipoOperacao`, `destinoOperacao`, `numeroPedido`, `pagamentosJson` and `duplicatasJson` on a draft with a reference. Otherwise a stale tab, or a front without the flag, overwrites it silently (`use-nfe-draft.ts:120-128`).
3. `findExistingDraft` must exclude devolução drafts.
4. E, F and `/calculate` must not demote REJECTED to DRAFT (numbering v2).

---

## 3. Pure modules

### 3.1 `app/fiscal/domain/chave-acesso-dv.ts` (new, no imports)

```ts
export interface ChaveAcessoInfo { chave: string; cUF: string; uf: string | null; ano: number; mes: number;
  cnpj: string; modelo: string; serie: number; numero: number; tpEmis: string }
export type ValidacaoChave =
  | { ok: true; info: ChaveAcessoInfo }
  | { ok: false; codigo: "VAZIA"|"CARACTER_INVALIDO"|"TAMANHO"|"DV"|"MODELO"|"MES"; mensagem: string };

/** Remove "NFe" inicial (Focus grava 47 chars), espaços, pontos, hífens. Outro não-dígito ⇒ null. */
export function normalizarChave(raw: string): string | null;
/** Módulo 11, pesos 2..9 da direita — mesma regra de chave-acesso.ts:103-122. null se base≠43 dígitos. */
export function calcularDvChave(base43: string): string | null;
export function validarChaveAcesso(raw: string, opts?: { modelos?: readonly string[] /* default ["55","65"] */ }): ValidacaoChave;
export function formatarChaveAcesso(chave: string): string; // grupos de 4
const UF_POR_CUF: Record<string, string> = { "11":"RO","12":"AC","13":"AM","14":"RR","15":"PA","16":"AP","17":"TO",
  "21":"MA","22":"PI","23":"CE","24":"RN","25":"PB","26":"PE","27":"AL","28":"SE","29":"BA","31":"MG","32":"ES",
  "33":"RJ","35":"SP","41":"PR","42":"SC","43":"RS","50":"MS","51":"MT","52":"GO","53":"DF" };
```

Messages:
- VAZIA: "Informe a chave de acesso."
- CARACTER_INVALIDO: "A chave de acesso tem só números (44 dígitos)."
- TAMANHO: "Faltam N dígitos." or "A chave tem 44 dígitos — sobraram N."
- DV: "Chave inválida: o dígito verificador não confere. Confira a digitação."
- MODELO: "Esta chave não é de NF-e nem de NFC-e (modelo XX)."
- MES: "Chave inválida: mês de emissão XX."

### 3.2 `app/fiscal/domain/devolucao-cfop.ts` (new, no imports; shared with the backend)

```ts
const E_NAC = ["201","202","203","204","208","209","212","213","214","215","216","410","411","503","504","505","506","553","660","661","662","918","919"];
const E_EXT = ["201","202","211","212","503","553"];
const S_NAC = ["201","202","208","209","210","213","214","215","216","410","411","412","413","503","553","555","556","660","661","662","918","919","921"];
const S_EXT = ["201","202","210","211","212","553","556"];
/** NT 2026.009 I08-140 — indDevol=1 (105 códigos). */
export const CFOPS_IND_DEVOL: ReadonlySet<string> = new Set([
  ...E_NAC.map(s=>"1"+s), ...E_NAC.map(s=>"2"+s), ...E_EXT.map(s=>"3"+s),
  ...S_NAC.map(s=>"5"+s), ...S_NAC.map(s=>"6"+s), ...S_EXT.map(s=>"7"+s)]);
export const CFOPS_EXCECAO_DEVOLUCAO: ReadonlySet<string> = new Set(["1949","2949"]);            // rej. 327
export const CFOPS_MEI_DEVOLUCAO: ReadonlySet<string> = new Set(["1202","1553","2202","2553","5202","6202"]); // rej. 1179
const MAPA_VENDA: Readonly<Record<string,string>> = { "5101":"1201","5102":"1202","5401":"1410","5403":"1411","5405":"1411",
  "6101":"2201","6107":"2201","6102":"2202","6108":"2202","6401":"2410","6403":"2411" };
const SEM_INVERSO: Readonly<Record<string, readonly string[]>> = { "6404":["2411","2949"], "5949":["1949"], "6949":["2949"], "5929":["1949"], "6929":["2949"] };

export type IdDest = 1 | 2 | 3;
export interface CtxCfopDevolucao { idDestOriginal: IdDest; crt?: number | null }
export type SugestaoCfopDevolucao =
  | { tipo: "UNICO"; cfop: string }
  | { tipo: "ESCOLHA"; opcoes: string[]; motivo: "SEM_INVERSO_OFICIAL" | "DESTINO_DIVERGENTE" | "SEM_MAPEAMENTO" };

/** Entrada de devolução de venda: 1º dígito espelha o idDest ORIGINAL; MEI só 1202/1553/2202/2553; 1949/2949 exceção (não para 3). */
export function cfopsPermitidosDevolucaoEntrada(ctx: CtxCfopDevolucao): string[];
export function cfopValidoDevolucaoEntrada(cfop: string, ctx: CtxCfopDevolucao): boolean;
export function sugerirCfopDevolucaoDeVenda(cfopOriginal: string, ctx: CtxCfopDevolucao): SugestaoCfopDevolucao;
// ordem: crt 4 → "1202"/"2202" (idDest 3 ⇒ ESCOLHA [] SEM_MAPEAMENTO);
// MAPA_VENDA com 1º dígito == idDest ⇒ UNICO; divergente ⇒ ESCOLHA([d+sufixo] filtrado válido || permitidos, DESTINO_DIVERGENTE);
// SEM_INVERSO filtrado por dígito ⇒ ESCOLHA(..., SEM_INVERSO_OFICIAL) (vazio ⇒ permitidos);
// resto ⇒ ESCOLHA(permitidos, SEM_MAPEAMENTO). 7xxx cai aqui (sem inverso inventado).
```

### 3.3 `app/notas-fiscais/lib/nfe-devolucao.ts` (new, pure: no React, no fetch)

```ts
import { validarChaveAcesso, normalizarChave, formatarChaveAcesso } from "@/app/fiscal/domain/chave-acesso-dv";
import { cfopValidoDevolucaoEntrada, type IdDest } from "@/app/fiscal/domain/devolucao-cfop";
export { validarChaveAcesso, normalizarChave, formatarChaveAcesso };

export function isNfeDevolucaoUiEnabled(): boolean { return process.env.NEXT_PUBLIC_NFE_DEVOLUCAO_ENABLED === "true"; }
export function isNfeEmissaoGuardUiEnabled(): boolean { return process.env.NEXT_PUBLIC_NFE_EMISSAO_GUARD_ENABLED === "true"; }

// ── Tipos do contexto (espelham a rota C) ──
export type DevolucaoTipo = "TOTAL" | "PARCIAL";
export interface NumeracaoInfo { reaproveitara: boolean; serie: number; numero: number | null }
export interface DevolucaoReferenciaInfo { originalNfeId: string | null; origem: "ACAO_RAPIDA" | "MANUAL";
  chave: string; modelo: "55" | "65"; serie: number; numero: number; dataEmissao: string | null;
  destinatarioNome: string | null; destinatarioCpfCnpj: string | null; idDest: IdDest; crt: number | null }
export interface DevolucaoLinha { nItemOriginal: number; codigo: string; descricao: string; unidade: string; ncm: string;
  qtdOriginal: number; qtdJaDevolvida: number; qtdEmAndamento?: number; quantidade: number; valorUnitario: number;
  cfopOriginal: string; cfop: string | null; cfopOpcoes: string[]; cfopPrecisaEscolha: boolean }
export interface DevolucaoContexto { referencia: DevolucaoReferenciaInfo; tipo: DevolucaoTipo;
  entregaConfirmada: boolean | null; linhas: DevolucaoLinha[]; numeracao?: NumeracaoInfo }

// ── Quantidades (ponto fixo 4 casas — qCom) ──
const ESC = 10_000; const q4 = (n: number) => Math.round((Number(n) || 0) * ESC);
export function disponivelDaLinha(l: DevolucaoLinha): number { return Math.max(0, q4(l.qtdOriginal) - q4(l.qtdJaDevolvida) - q4(l.qtdEmAndamento ?? 0)) / ESC; }
export function aplicarTipoDevolucao(linhas: DevolucaoLinha[], tipo: DevolucaoTipo): DevolucaoLinha[]; // TOTAL ⇒ q=disp; PARCIAL ⇒ clamp [0,disp]
export interface ValidacaoLinhas { ok: boolean; porItem: Record<number, string[]>; geral: string[] }
export function validarLinhasDevolucao(linhas: DevolucaoLinha[], tipo: DevolucaoTipo, idDest: IdDest, crt: number | null): ValidacaoLinhas;
export function resumoDevolucao(linhas: DevolucaoLinha[]): { itens: number; valorEstimado: number };
export function linhasParaPayload(linhas: DevolucaoLinha[]): Array<{ nItemOriginal: number; quantidade: number; cfop: string | null }>;

// ── Ação de linha (lista / detalhe) ──
export interface NfeRowForActions { status: string; modelo?: string; finalidade: string; tipoOperacao: string;
  hasXml: boolean; hasXmlAutorizado?: boolean; temItens?: boolean }
export interface DevolucaoSaldoResumo { totalmenteDevolvida: boolean; rascunhoAbertoId: string | null; emissaoEmAndamento: boolean }
export interface NfeRowAction { kind: "devolucao"; label: string; intent: "criar" | "continuar"; visible: boolean; disabled: boolean; reason?: string }
export function buildNfeRowActions(i: { flagOn: boolean; row: NfeRowForActions; saldo?: DevolucaoSaldoResumo | null }): NfeRowAction[];
export function isDevolucaoStaticamenteElegivel(row: NfeRowForActions): boolean; // == enabled com saldo undefined

// ── Criação / erros ──
export type ResultadoCriacao = { kind: "abrir"; draftId: string; aviso?: string } | { kind: "erro"; mensagem: string };
export function interpretarCriacaoDevolucao(httpStatus: number, body: unknown): ResultadoCriacao;
export function mensagemErroDevolucao(httpStatus: number, body: unknown): string; // code → copy; senão body.error (≤300 chars); senão genérico

// ── Wizard ──
export type WizardModoKind = "NORMAL" | "DEVOLUCAO_PENDENTE" | "DEVOLUCAO" | "DEVOLUCAO_LEGADA" | "DEVOLUCAO_ERRO";
export function resolverModoInicial(flagOn: boolean, finalidade: string, ctx: "ok" | "ausente" | "erro" | "nao_consultado"): WizardModoKind;
export function validarPassoDevolucao(step: number, s: { modo: WizardModoKind; ctx: DevolucaoContexto | null; linhas: DevolucaoLinha[] }): { ok: true } | { ok: false; mensagem: string };
export function formTemDadosDigitados(d: { itens: unknown[]; destinatario: { cpfCnpj: string; nome: string } }): boolean;
export function montarBannerDevolucao(ref: DevolucaoReferenciaInfo | null, tipo: DevolucaoTipo | null): { titulo: string; detalhe: string | null };
export function textoNumeracaoRejeitada(info: NumeracaoInfo | undefined | null): string;
export function descricoesPassosDevolucao<T extends { id: number; description: string }>(steps: readonly T[], modo: WizardModoKind): readonly T[]; // NORMAL ⇒ mesma referência
export function payloadMudou(anterior: unknown, atual: unknown): boolean; // JSON com chaves ordenadas
export const PAGAMENTO_DEVOLUCAO = [{ meio: "SEM_PAGAMENTO" as const, valor: 0 }];

// ── Emissão V2 ──
export type RespostaEmissao =
  | { kind: "autorizada"; numero: number; serie: number } | { kind: "processando" } | { kind: "em_andamento" }
  | { kind: "rejeitada"; mensagem: string } | { kind: "erro"; mensagem: string };
export function interpretarRespostaEmissao(httpStatus: number, body: any): RespostaEmissao;
// !ok: (409 && code==="EMISSAO_EM_ANDAMENTO") || (500 && /ja esta em processamento/i.test(body?.error)) ⇒ em_andamento
// ok: success&&AUTHORIZED ⇒ autorizada; success ⇒ processando; !success ⇒ rejeitada(body.mensagem) — espelha nfe-wizard.tsx:476-499
export const POLL_INTERVALO_MS = 3000, POLL_MAX = 10;
export type DecisaoPoll = { kind: "continuar" } | { kind: "autorizada"; numero: number; serie: number }
  | { kind: "rejeitada"; motivo: string | null } | { kind: "cancelada" } | { kind: "liberada" } | { kind: "tempo_esgotado" };
export function decidirPollEmissao(s: { status: string; numero: number; serie: number; motivoRejeicao: string | null } | null, tentativa: number, max?: number): DecisaoPoll;
// null(erro de rede)/VALIDATING/SIGNING/SENDING ⇒ continuar até max ⇒ tempo_esgotado; DRAFT ⇒ liberada (R5); AUTHORIZED/REJECTED/CANCELLED mapeados
```

**Precedence in `buildNfeRowActions`** (first match wins; `visible = flagOn`, and flag off returns `[]`):
1. `CANCELLED`
2. `status !== "AUTHORIZED"`
3. `finalidade === "DEVOLUCAO"`
4. `tipoOperacao === "ENTRADA"`
5. `modelo` not in `55`, `65`, `undefined` (undefined means 55, see `nfe-list.tsx:70`)
6. `(hasXmlAutorizado ?? hasXml) === false`
7. `temItens === false`
8. `saldo?.totalmenteDevolvida`
9. `saldo?.emissaoEmAndamento`
10. `saldo?.rascunhoAbertoId` gives an enabled item "Continuar devolução (rascunho)" with intent `continuar`
11. Otherwise enabled, "Emitir nota de devolução". An unknown balance counts as enabled: the backend is the guard and returns 409.

**Step gating (`validarPassoDevolucao`):**
- Step 1 in PENDENTE, LEGADA or ERRO blocks with the matching message.
- Step 1 in DEVOLUCAO requires `entregaConfirmada === true`.
- Step 3 requires `validarLinhasDevolucao(...).ok`.
- Every other step passes.

### 3.4 `app/notas-fiscais/lib/nfe-devolucao-api.ts` (new, client I/O, no React)

```ts
export interface ApiResp<T> { ok: boolean; status: number; data: T | null; body: any }
async function chamar<T>(method: string, path: string, email: string, body?: unknown): Promise<ApiResp<T>> {
  try {
    const res = await fetch(`${getApiBaseUrl()}${path}`, { method,
      headers: body === undefined ? { email } : { "Content-Type": "application/json", email },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data: res.ok ? (json as T) : null, body: json };
  } catch { return { ok: false, status: 0, data: null, body: null }; }
}
const e = encodeURIComponent;
export const iniciarDevolucao        = (id: string, em: string) => chamar<{draftId:string;reused:boolean}>("POST", `/fiscal/nfe/${e(id)}/devolucao`, em, {});
export const consultarSaldoDevolucao = (id: string, em: string) => chamar<any>("GET", `/fiscal/nfe/${e(id)}/devolucao/saldo`, em);
export const carregarContexto        = (d: string, em: string) => chamar<{contexto:DevolucaoContexto}>("GET", `/fiscal/nfe/draft/${e(d)}/devolucao`, em);
export const vincularOriginal        = (d: string, em: string, chave: string) => chamar<{draft:any;contexto:DevolucaoContexto}>("POST", `/fiscal/nfe/draft/${e(d)}/devolucao/referencia`, em, { chave });
export const salvarDevolucao         = (d: string, em: string, patch: object) => chamar<{draft:any;contexto:DevolucaoContexto}>("PUT", `/fiscal/nfe/draft/${e(d)}/devolucao`, em, patch);
export const removerDevolucao        = (d: string, em: string) => chamar<{draft:any}>("DELETE", `/fiscal/nfe/draft/${e(d)}/devolucao`, em);
export const consultarStatusNfe      = async (id: string, em: string) => { const r = await chamar<{nfe:any}>("GET", `/fiscal/nfe/${e(id)}`, em);
  const n = r.data?.nfe; return n ? { status: n.status, numero: n.numero, serie: n.serie, motivoRejeicao: n.motivoRejeicao ?? null } : null; };
```

`consultarStatusNfe` only picks the fields it needs. Nothing is logged, and no token or certificate data exists in these responses.

---

## 4. List and detail sheet

### 4.1 `app/notas-fiscais/hooks/use-nfe-devolucao-quick-action.ts` (new)

```ts
export function useNfeDevolucaoQuickAction({ email, onToast }: { email: string; onToast: (m: string, t: "success" | "error") => void }) {
  const router = useRouter();
  const inFlight = useRef<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const start = useCallback(async (originalId: string) => {
    if (inFlight.current) return;                         // 1 por página
    if (!email) { onToast("Sessão expirada — entre novamente.", "error"); return; }
    inFlight.current = originalId; setBusyId(originalId);
    let navegou = false;
    try {
      const r = await iniciarDevolucao(originalId, email);
      const out = r.status === 0 ? { kind: "erro" as const, mensagem: "Erro de conexão ao preparar a devolução. Tente de novo." }
                                 : interpretarCriacaoDevolucao(r.status, r.body);
      if (out.kind === "abrir") { navegou = true; router.push(`/notas-fiscais/nfe?draft=${encodeURIComponent(out.draftId)}`); return; }
      onToast(out.mensagem, "error");
    } finally { if (!navegou) { inFlight.current = null; setBusyId(null); } }  // lock mantido durante a navegação
  }, [email, onToast, router]);
  return { start, busyId };
}
```

### 4.2 `app/notas-fiscais/components/nfe-row-actions-menu.tsx` (new)

This copies the structure of `pdv-sale-actions.tsx:284-369`: DropdownMenu, a trigger with `MoreHorizontal` or a spinner, a label, and a disabled item with its reason on a second line.

```tsx
interface Props {
  nota: { id: string; numero: number; serie: number; status: string; modelo?: string; finalidade: string;
          tipoOperacao: string; hasXml: boolean; hasXmlAutorizado?: boolean };
  email: string;
  busy: boolean;        // esta linha em voo
  anyBusy: boolean;     // outra linha em voo
  onEmitirDevolucao: (nfeId: string) => void;
}
// estado local: saldo: DevolucaoSaldoResumo | null | undefined (undefined = não consultado)
// onOpenChange(open): se open && saldo===undefined && isDevolucaoStaticamenteElegivel(nota) ⇒ consultarSaldoDevolucao → map → setSaldo (falha ⇒ null)
// actions = buildNfeRowActions({ flagOn: true, row: nota, saldo }).filter(a => a.visible)
// <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label={`Mais ações da nota nº ${nota.numero}`} disabled={anyBusy}>
//   {busy ? <Loader2 className="size-4 animate-spin"/> : <MoreHorizontal className="size-4"/>}</Button></DropdownMenuTrigger>
// <DropdownMenuContent align="end" className="w-72"><DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Ações da nota</DropdownMenuLabel>
//   {actions.map(a => <DropdownMenuItem key={a.kind} disabled={a.disabled} title={a.reason} onSelect={() => onEmitirDevolucao(nota.id)}>
//     <Undo2 className="h-4 w-4"/><span className="flex flex-col"><span>{a.label}</span>
//     {a.disabled && a.reason && <span className="text-[11px] text-muted-foreground">{a.reason}</span>}</span></DropdownMenuItem>)}
```

### 4.3 `nfe-list.tsx` (modified, additive)

- Near `:61-64`, add `const DEVOLUCAO_UI = isNfeDevolucaoUiEnabled();`.
- In the local interface (`:66-89`), add `hasXmlAutorizado?: boolean;`. This is type-only.
- Inside `NfeList`: `const devolucao = useNfeDevolucaoQuickAction({ email: session?.user?.email ?? "", onToast: showToast });`. The hook only runs `useRouter`, a ref and state, so it has no effect on the DOM or the network.
- Badge next to the NFC-e badge (`:656-663`): `{DEVOLUCAO_UI && nota.finalidade === "DEVOLUCAO" && <Badge variant="outline" className="px-1.5 py-0 font-sans text-[10px] font-medium text-muted-foreground">Devolução</Badge>}`.
- Last child of the actions div, after the RotateCcw block (`:784-807`):
  `{DEVOLUCAO_UI && <NfeRowActionsMenu nota={nota} email={session?.user?.email ?? ""} busy={devolucao.busyId === nota.id} anyBusy={devolucao.busyId !== null} onEmitirDevolucao={devolucao.start} />}`
- On the detail sheet (`:863-871`): `devolucao={DEVOLUCAO_UI ? { busyId: devolucao.busyId, onEmitir: devolucao.start } : undefined}`.
- The header (`:647`) is not changed.

### 4.4 `nfe-detail-sheet.tsx` (modified, additive)

- New optional prop: `devolucao?: { busyId: string | null; onEmitir: (nfeId: string) => void }`.
- Local state `saldo` (undefined/null/value). Fetch it in a **read-only** effect keyed on `[open, nfeId, devolucao ? 1 : 0, nfe?.status]`, only when `devolucao && nfe && isDevolucaoStaticamenteElegivel(row)`. The effect writes local state only, never a form.
- `row = { status: nfe.status, modelo: nfe.modelo, finalidade: nfe.finalidade, tipoOperacao: nfe.tipoOperacao, hasXml: !!(nfe.xmlAutorizadoPath || nfe.xmlOriginalPath), hasXmlAutorizado: !!nfe.xmlAutorizadoPath, temItens: (nfe.itens?.length ?? 0) > 0 }`.
- In "Ações rápidas", after Cancelar (`:312-321`):

```tsx
{devolucao && nfe && (() => { const [a] = buildNfeRowActions({ flagOn: true, row, saldo }); if (!a) return null; return (<>
  <Button variant="outline" size="sm" disabled={a.disabled || devolucao.busyId !== null} title={a.reason} onClick={() => devolucao.onEmitir(nfeId!)}>
    {devolucao.busyId === nfeId ? <Loader2 className="size-4 mr-1 animate-spin"/> : <Undo2 className="size-4 mr-1"/>}{a.label}</Button>
  {a.disabled && a.reason && <p className="w-full text-xs text-muted-foreground">{a.reason}</p>}</>); })()}
```

- Header (`:195-202`): `{devolucao && nfe.finalidade === "DEVOLUCAO" && <Badge ...>Nota de devolução</Badge>}`.

---

## 5. Wizard

### 5.1 State in `nfe-wizard.tsx` (additive)

```ts
const DEVOLUCAO_UI = isNfeDevolucaoUiEnabled();        // módulo
const EMISSAO_GUARD_UI = isNfeEmissaoGuardUiEnabled(); // módulo
const [modo, setModo] = useState<WizardModoKind>("NORMAL");
const [devCtx, setDevCtx] = useState<DevolucaoContexto | null>(null);
const [devLinhas, setDevLinhas] = useState<DevolucaoLinha[]>([]);
const [devBusy, setDevBusy] = useState(false);
const [chaveErro, setChaveErro] = useState<string | null>(null);
const [confirmar, setConfirmar] = useState<null | "PARA_NORMAL" | "SUBSTITUIR">(null);
const chavePendenteRef = useRef<string | null>(null);
const snapshotRef = useRef<Record<number, unknown>>({});   // dirty-check por passo (modo devolução)
const emitLockRef = useRef(false);
const stepLockRef = useRef(false);
const mountedRef = useRef(true);  useEffect(() => () => { mountedRef.current = false; }, []);
const [aguardandoSefaz, setAguardandoSefaz] = useState(false);
const emDevolucao = DEVOLUCAO_UI && modo !== "NORMAL";
```

**Rule:** no new `useEffect` reads `useWatch`/`watch` or calls `setValue`/`reset`. Form writes happen only inside handlers: `populateFormFromDraft` (`:228-310`) and `setValue("itens", ...)` after server responses. RHF effects fire synchronously inside `setValue`/`reset` and have overwritten forms before.

`aplicarContexto(ctx)` is a function, not an effect: `setDevCtx(ctx); setDevLinhas(ctx.linhas); snapshotRef.current[1] = { tipo: ctx.tipo, entregaConfirmada: ctx.entregaConfirmada }; snapshotRef.current[3] = linhasParaPayload(ctx.linhas);`

### 5.2 Loading (inside the existing mount effect)

- After `populateFormFromDraft(draft)` (`:180`): `if (DEVOLUCAO_UI && draft.finalidade === "DEVOLUCAO") { const r = await carregarContexto(existingId, email); if (cancelled) return; const k = resolverModoInicial(true, draft.finalidade, r.ok ? "ok" : r.status === 404 ? "ausente" : "erro"); if (r.ok) aplicarContexto(r.data!.contexto); setModo(k); }`
- Collision defense after `:210`: `if (DEVOLUCAO_UI && newDraft.finalidade === "DEVOLUCAO") { populateFormFromDraft(newDraft); window.history.replaceState(null, "", `?draft=${newDraft.id}`); /* mesmo carregarContexto acima */ }`
- Keep the existing rejection banner (`:534-549`) as it is. In devolução mode, the numbering text comes **only** from `textoNumeracaoRejeitada(devCtx?.numeracao)`:
  - `reaproveitara` true: "Corrija e emita de novo — o número S/N será reaproveitado."
  - `reaproveitara` false: "Corrija e emita de novo. A nova tentativa receberá outro número."
  - Missing: "Corrija o que deu errado e emita novamente."

  The UI never derives reuse from `reaproveitavel` in devolução mode. The existing normal-mode banner can promise wrongly after R1; switch it to `numeracao` under the numbering-v2 flag (recommendation only).

### 5.3 Step 1: modality toggle and panel

`StepInformacoesGerais` gets an optional prop. When it is absent, the render is identical.

```ts
devolucao?: { modo: WizardModoKind; busy: boolean; onModoChange: (next: "NORMAL" | "DEVOLUCAO") => void; painel: React.ReactNode }
```

Inside the step:
- `const emDev = !!devolucao && devolucao.modo !== "NORMAL";`
- At the top of the tree: `{devolucao && <DevolucaoModalidadeToggle modo={devolucao.modo} busy={devolucao.busy} onChange={devolucao.onModoChange}/>}{emDev && devolucao!.painel}`
- Finalidade options (`:208`): `devolucao ? entries.filter(([k]) => emDev ? k === "DEVOLUCAO" : k !== "DEVOLUCAO") : entries`.
- Selects for tipoOperacao (`:181`), finalidade (`:203`) and destino (`:225`), and the company selector (`:115`): add `{...(emDev ? { disabled: true } : {})}`. A conditional spread keeps the DOM identical. Under the selector: `{emDev && <p className="text-xs text-muted-foreground">A devolução é emitida pelo mesmo CNPJ da nota original.</p>}`.
- Número do pedido (`:293-307`): wrap it as `{!emDev && (...)}`. A devolução never carries `numeroPedido`, because it would collide with the PDV idempotency link (`nfe.repository.ts:277-312`).

Wizard handlers:

```ts
const handleModoChange = (next: "NORMAL" | "DEVOLUCAO") => {
  if (next === "DEVOLUCAO") { if (modo === "NORMAL") setModo("DEVOLUCAO_PENDENTE"); return; }
  if (modo === "DEVOLUCAO_PENDENTE" || modo === "DEVOLUCAO_ERRO") { setModo("NORMAL"); return; }
  setConfirmar("PARA_NORMAL");
};
const confirmarParaNormal = async () => {
  setDevBusy(true);
  try {
    if (modo === "DEVOLUCAO_LEGADA") { await saveDraft(draftId!, { finalidade: "NORMAL" } as any); setValue("finalidade", "NORMAL"); }
    else { const r = await removerDevolucao(draftId!, email); if (!r.ok) { showToast(mensagemErroDevolucao(r.status, r.body), "error"); return; }
           populateFormFromDraft(r.data!.draft); }
    setDevCtx(null); setDevLinhas([]); snapshotRef.current = {}; setModo("NORMAL");
  } finally { setDevBusy(false); setConfirmar(null); }
};
const handleBuscarChave = async (raw: string) => {
  const v = validarChaveAcesso(raw); if (!v.ok) { setChaveErro(v.mensagem); return; }
  setChaveErro(null);
  if (formTemDadosDigitados(getValues())) { chavePendenteRef.current = v.info.chave; setConfirmar("SUBSTITUIR"); return; }
  await vincular(v.info.chave);
};
const vincular = async (chave: string) => {
  setDevBusy(true);
  try {
    const r = await vincularOriginal(draftId!, email, chave);
    if (!r.ok) { setChaveErro(mensagemErroDevolucao(r.status, r.body)); return; }
    populateFormFromDraft(r.data!.draft); aplicarContexto(r.data!.contexto); setModo("DEVOLUCAO");
    showToast(`Itens da ${r.data!.contexto.referencia.modelo === "65" ? "NFC-e" : "NF-e"} nº ${r.data!.contexto.referencia.numero} carregados.`, "info");
  } finally { setDevBusy(false); setConfirmar(null); }
};
const handleTipoChange = (tipo: DevolucaoTipo) => { setDevCtx(c => c && { ...c, tipo }); setDevLinhas(l => aplicarTipoDevolucao(l, tipo)); };
const handleEntregaChange = (v: boolean) => setDevCtx(c => c && { ...c, entregaConfirmada: v });
```

`components/devolucao/devolucao-panel.tsx`:

```ts
interface DevolucaoPanelProps {
  modo: Exclude<WizardModoKind, "NORMAL">;
  contexto: DevolucaoContexto | null;
  busy: boolean;
  chaveErro: string | null;
  onBuscarChave: (chave: string) => void;
  onRecarregar: () => void;                 // DEVOLUCAO_ERRO
  onTipoChange: (t: DevolucaoTipo) => void;
  onEntregaChange: (v: boolean) => void;
  cnpjsEmitentes?: string[];                // de `companies` (multi-CNPJ) — só aviso, nunca bloqueio; nada hardcoded
}
```

- **PENDENTE and LEGADA:** chave input (local text state), live `validarChaveAcesso`, parsed preview ("NF-e modelo 55 · série S · nº N · emitida em MM/AAAA · UF PR"), a "Buscar nota" button, and the hint. If `cnpjsEmitentes` is set and does not contain `info.cnpj`, show the amber warning.
- **DEVOLUCAO:** read-only grid (Número, Série, Emitida em, Destinatário, Chave with `formatarChaveAcesso`), a TOTAL/PARCIAL segmented control (`role="radiogroup"`, buttons with `aria-checked`), the entrega question (two buttons plus explanation, and a destructive notice when the answer is "Não"), and `textoNumeracaoRejeitada` when the draft is REJECTED.
- **ERRO:** error message and a "Tentar de novo" button.

### 5.4 Step 2: destinatário

`StepDestinatario` gets an optional prop `identidade?: { bloqueada: boolean; aviso: string }`.
- When `bloqueada`, the customer search block (`step-destinatario.tsx:173-219`) is not rendered and the aviso shows instead. The `tipoPessoa`, `cpfCnpj` and `nome` controllers (`:233-330`) get `{...(bloq ? { disabled: true } : {})}`.
- The wizard passes `bloqueada: !!devCtx?.referencia.destinatarioCpfCnpj`. An NFC-e without a consumer stays unlocked, with the "informe CPF e nome" aviso.

### 5.5 Step 3: devolved items (the wizard picks the body; `StepProdutos` is not changed)

`{currentStep === 3 && (emDevolucao && modo === "DEVOLUCAO" ? <DevolucaoItensEditor .../> : <StepProdutos .../>)}`

Product search and "Item manual" (`step-produtos.tsx:176-220`) do not exist in this path.

`components/devolucao/devolucao-itens-editor.tsx`:

```ts
interface Props {
  linhas: DevolucaoLinha[]; tipo: DevolucaoTipo; idDest: IdDest; crt: number | null;
  erros: ValidacaoLinhas;              // validarLinhasDevolucao(...) calculado no render do wizard
  disabled: boolean;
  onQuantidadeChange: (nItemOriginal: number, q: number) => void;
  onCfopChange: (nItemOriginal: number, cfop: string) => void;
  onExcluir: (nItemOriginal: number) => void;   // PARCIAL ⇒ 0
  onIncluir: (nItemOriginal: number) => void;   // PARCIAL ⇒ disponível
}
```

Each card shows:
- Header: "Item {nItemOriginal} da nota original · {codigo}", then the description, NCM, unit and read-only unit value.
- **Strip:** `Qtd original {q} {un} · Já devolvida {q} {un} · Disponível {q} {un}`, plus "{q} em outra devolução aguardando a SEFAZ" when `qtdEmAndamento > 0`.
- **Quantidade a devolver:**
  - TOTAL: read-only value plus the lock hint.
  - PARCIAL: `ValorInput` (0..disponível) with "Não devolver este item" / "Incluir na devolução".
  - Disponível 0: "Já devolvido integralmente", locked at 0.
- **CFOP:** "CFOP da venda: 5102" and "CFOP da devolução: 1202 — {findCfop(c)?.descricao ?? 'CFOP de devolução'}".
  - If `cfopPrecisaEscolha`, show a `Select` with `cfopOpcoes`, or with `cfopsPermitidosDevolucaoEntrada(ctx)` when the options are empty, plus the hint.
  - A plain `Select` is used, not `CfopCombobox`, which stays untouched.
- Errors from `erros.porItem[n]`. The footer shows `erros.geral`, the estimate from `resumoDevolucao`, and the note that the total comes from step 8.

The handlers update only `devLinhas` through pure functions. No form writes at this point.

### 5.6 Save strategy in devolução mode

```ts
const salvarPassoDevolucao = async (step: number): Promise<boolean> => {
  const data = getValues();
  if (step === 1) {
    const geral = { serie: data.serie, naturezaOperacao: data.naturezaOperacao, indPresenca: data.indPresenca,
      intermediador: data.intermediador, informacoesComplementares: data.informacoesComplementares,
      dataEmissao: data.dataEmissao, dataSaida: data.dataSaida };              // sem tipoOperacao/finalidade/destino/numeroPedido
    if (payloadMudou(snapshotRef.current[10], geral)) { await saveDraft(draftId!, geral as any); snapshotRef.current[10] = geral; }
    const cab = { tipo: devCtx!.tipo, entregaConfirmada: devCtx!.entregaConfirmada };
    if (!payloadMudou(snapshotRef.current[1], cab)) return true;
    return aplicarRespostaDevolucao(await salvarDevolucao(draftId!, email, cab));
  }
  if (step === 3) {
    const itens = linhasParaPayload(devLinhas);
    if (!payloadMudou(snapshotRef.current[3], itens) && !payloadMudou(snapshotRef.current[1], { tipo: devCtx!.tipo, entregaConfirmada: devCtx!.entregaConfirmada })) return true;
    return aplicarRespostaDevolucao(await salvarDevolucao(draftId!, email, { tipo: devCtx!.tipo, itens }));
  }
  if (step === 6 || step === 7) return true;                                  // servidor controla (sem duplicatas; tPag 90)
  const legado = payloadPassoLegado(step, data);                              // mesmos campos de nfe-wizard.tsx:380-404
  if (legado && payloadMudou(snapshotRef.current[step], legado)) { await saveDraft(draftId!, legado as any); snapshotRef.current[step] = legado; }
  return true;
};
const aplicarRespostaDevolucao = (r: ApiResp<{ draft: any; contexto: DevolucaoContexto }>): boolean => {
  if (r.ok) { aplicarContexto(r.data!.contexto); setValue("itens", mapItensForm(r.data!.draft.itens)); return true; }
  if (r.status === 409 && r.body?.code === "SALDO_INSUFICIENTE" && r.body?.contexto) { aplicarContexto(r.body.contexto);
    showToast("Outra devolução desta nota foi emitida enquanto você editava. As quantidades disponíveis foram atualizadas — revise.", "warning"); return false; }
  showToast(mensagemErroDevolucao(r.status, r.body), "error"); return false;
};
```

`payloadPassoLegado` is a private copy, inside the wizard, of the step 2/4/5 payloads (`:381-404`). `saveCurrentStep` itself is not edited.

`mapItensForm` is the same mapping as `populateFormFromDraft` `:274-289`, extracted as a local const that both paths use. In NORMAL mode the call site keeps the exact same values.

```ts
const handleNextDevolucao = async () => {
  if (stepLockRef.current) return;
  const v = validarPassoDevolucao(currentStep, { modo, ctx: devCtx, linhas: devLinhas });
  if (!v.ok) { showToast(v.mensagem, "warning"); return; }
  if (currentStep === 2 && !(await trigger(["destinatario.cpfCnpj", "destinatario.nome"]))) { showToast("Corrija os campos obrigatorios antes de avancar", "warning"); return; }
  if (currentStep === 4 || currentStep === 5) { if (!(await validateCurrentStep())) { showToast("Corrija os campos obrigatorios antes de avancar", "warning"); return; } }
  stepLockRef.current = true;
  try {
    if (!(await salvarPassoDevolucao(currentStep))) return;
    if (currentStep === 8) { const d = await loadDraft(draftId!); if (d?.numeracao && devCtx) setDevCtx({ ...devCtx, numeracao: d.numeracao }); }
    setCurrentStep(s => Math.min(TOTAL_STEPS, s + 1));
  } finally { stepLockRef.current = false; }
};
const onNext = emDevolucao ? handleNextDevolucao : handleNext;   // handleNext (:413) intocado
```

For Back and `goToStep`, in devolução mode call `void salvarPassoDevolucao(currentStep)` without waiting; errors come back as a toast. Otherwise the legacy handlers run.

Steps 6, 7 and 8:
- Step 6: `emDevolucao ? <DevolucaoAvisoCard variante="duplicatas"/> : <StepDuplicatas/>`.
- Step 7: `emDevolucao ? <DevolucaoAvisoCard variante="pagamento"/> : <StepPagamentos/>`. The server wrote `PAGAMENTO_DEVOLUCAO` at conversion time, and `populateFormFromDraft` loads it.
- Step 8: `{emDevolucao && <p className="text-sm text-muted-foreground">…proporcional…</p>}<StepImpostos .../>`.

### 5.7 Step 9 and the banner

`StepFinalizar` gets an optional prop:

```ts
devolucao?: { resumo: React.ReactNode; textoEmissao: string }
```

- Divergence block (`:57`): `{diff > 0.01 && !devolucao && (...)}`.
- Before "Informacoes Gerais": `{devolucao?.resumo}`.
- Payments card (`:169-190`): when `devolucao` is set, one line "Sem pagamento (tPag 90)".
- Blue box (`:192-196`): `{devolucao ? devolucao.textoEmissao : <legacy text>}`.
- The step-7 divergence (`step-pagamentos.tsx:191-195`) never appears, because `StepPagamentos` is not rendered in devolução mode.

`DevolucaoResumoSection` shows the referenced note, the type, one line per item (`q de disponível · CFOP`), "Sem pagamento", the confirmation, `textoNumeracaoRejeitada`, and the stock notice.

`DevolucaoContextBanner` sits above `StepperHeader` (`:551`): `{emDevolucao && <DevolucaoContextBanner {...montarBannerDevolucao(devCtx?.referencia ?? null, devCtx?.tipo ?? null)} />}`. Stepper steps come from `descricoesPassosDevolucao(STEPS, modo)`, which returns the same reference in NORMAL.

### 5.8 Persistence and the rascunho flow

- **The devolução draft is a normal `NfeEmitida` DRAFT.** Route A creates it, and `?draft=` reopens it (`:171-180`).
- **Quick action on an original with an open draft:** A returns that draft. The menu already labels the item "Continuar devolução (rascunho)".
- **REJECTED devolução:** reopened by the existing "Tentar novamente" (`nfe-list.tsx:784-807`), then routed into devolução mode by §5.2.
- **Devolução-specific data:** reference, type, entrega, per-item quantities and CFOP. It goes **only** through D, E and F, and backend tables are keyed by `nItemOriginal`. Why not PUT `/draft`:
  - (a) item rows are deleted and recreated, so there is no stable link (`nfe.repository.ts:434-441`);
  - (b) the client must not dictate price, NCM or description;
  - (c) PUT `/draft` demotes REJECTED to DRAFT (`:379-381`);
  - (d) `saveDraft` swallows errors (`use-nfe-draft.ts:120-128`), and devolução needs 409/422.
- **General fields** (serie, natureza, obs, destinatário address, frete, volumes) still use PUT `/draft`, always behind `payloadMudou`. That cuts the needless demotions R1 causes until numbering v2 lands.
- **Numbering:** the UI only states what `numeracao` (server) says. If `numeracao` is missing, it says nothing about reuse.

### 5.9 Emission V2: ref guard and 409 as a polling state

```ts
const handleEmitirV2 = async () => {
  if (!draftId || emitLockRef.current) return;
  emitLockRef.current = true;                   // síncrono: 2º clique sai aqui
  try {
    if (emDevolucao) {
      for (const p of [1, 3]) { const v = validarPassoDevolucao(p, { modo, ctx: devCtx, linhas: devLinhas }); if (!v.ok) { showToast(v.mensagem, "warning"); return; } }
      if (!(await salvarPassoDevolucao(currentStep))) return;
    } else {
      await saveCurrentStep();                  // closure do clique: isEmitting=false ⇒ salva (mesmo PUT do legado)
    }
    setIsEmitting(true);
    let res: Response, body: any;
    try { res = await fetch(`${getApiBaseUrl()}/fiscal/nfe/${draftId}/issue`, { method: "POST", headers: { "Content-Type": "application/json", email }, body: "{}" });
          body = await res.json().catch(() => ({})); }
    catch { showToast("Erro de conexao ao emitir NF-e", "error"); return; }
    const r = interpretarRespostaEmissao(res.status, body);
    if (r.kind === "erro") { showToast(r.mensagem, "error"); return; }
    if (r.kind === "rejeitada") { showToast(r.mensagem, "error"); await recarregarRejeitada(); return; }
    if (r.kind === "autorizada") return concluirAutorizada(r.numero, body.chaveAcesso);
    if (r.kind === "em_andamento") showToast("Esta nota já está sendo emitida. Acompanhando o resultado…", "info");
    setAguardandoSefaz(true);
    const d = await acompanharEmissao(draftId);
    if (!d || !mountedRef.current) return;
    if (d.kind === "autorizada") return concluirAutorizada(d.numero, null);
    if (d.kind === "rejeitada") { showToast(`Rejeitada pela SEFAZ: ${d.motivo ?? "sem motivo informado"}`, "error"); await recarregarRejeitada(); return; }
    if (d.kind === "liberada") { showToast("A emissão não chegou a ser enviada. Revise os dados e tente de novo.", "warning"); return; }
    if (d.kind === "cancelada") { showToast("Esta nota consta como cancelada.", "warning"); return; }
    showToast("A SEFAZ ainda não respondeu. Não emita de novo: acompanhe o status em Notas emitidas.", "warning");
  } finally { emitLockRef.current = false; setIsEmitting(false); setAguardandoSefaz(false); }
};
const acompanharEmissao = async (id: string) => {
  for (let t = 1; ; t++) {
    await new Promise(r => setTimeout(r, POLL_INTERVALO_MS));
    if (!mountedRef.current) return null;
    const d = decidirPollEmissao(await consultarStatusNfe(id, email), t, POLL_MAX);
    if (d.kind !== "continuar") return d;
  }
};
const concluirAutorizada = (numero: number, chave: string | null) => {
  showToast(emDevolucao ? `Nota de devolução nº ${numero} autorizada. Abrindo Notas emitidas…`
                        : `NF-e ${numero} autorizada! Chave: ${chave?.slice(0, 20)}...`, "success");
  setTimeout(() => { window.location.href = emDevolucao ? "/notas-fiscais/emitidas" : "/notas-fiscais/nfe"; }, 2000);
};
// recarregarRejeitada: loadDraft → populateFormFromDraft → setRejeicaoInfo (mesma regra :183-196) → se emDevolucao, carregarContexto
const onSubmit = emDevolucao || EMISSAO_GUARD_UI ? handleEmitirV2 : handleEmitir;   // handleEmitir (:457-505) intocado
// StepperFooter: submitLabel={aguardandoSefaz ? "Aguardando SEFAZ..." : isEmitting ? "Emitindo..." : emDevolucao ? "Emitir nota de devolução" : "Emitir NF-e"}
```

With the flag off, `onSubmit === handleEmitir` and the label expression evaluates exactly to the current `:637`.

---

## 6. New components and props

| File | Props |
|---|---|
| `components/nfe-row-actions-menu.tsx` | §4.2 |
| `components/devolucao/devolucao-modalidade-toggle.tsx` | `{ modo: WizardModoKind; busy: boolean; onChange(next: "NORMAL" \| "DEVOLUCAO"): void }`. Two buttons in `role="radiogroup"`; "Nota de devolução" is pressed for every mode other than NORMAL. |
| `components/devolucao/devolucao-panel.tsx` | §5.3 |
| `components/devolucao/devolucao-itens-editor.tsx` | §5.5 |
| `components/devolucao/devolucao-context-banner.tsx` | `{ titulo: string; detalhe: string \| null }` (presentational) |
| `components/devolucao/devolucao-aviso-card.tsx` | `{ variante: "pagamento" \| "duplicatas" }` |
| `components/devolucao/devolucao-resumo-section.tsx` | `{ contexto: DevolucaoContexto; linhas: DevolucaoLinha[] }` |
| `components/devolucao/devolucao-confirm-dialog.tsx` | `{ tipo: "PARA_NORMAL" \| "SUBSTITUIR" \| null; referencia: DevolucaoReferenciaInfo \| null; busy: boolean; onCancel(): void; onConfirm(): void }` (AlertDialog; `preventDefault` on the action, as in `pdv-sale-actions.tsx:418-423`) |

---

## 7. Copy (pt-BR, exported as `DEVOLUCAO_COPY` in `nfe-devolucao.ts`)

### Menu and detail reasons

| Key | Text |
|---|---|
| CANCELADA | Nota cancelada — não há o que devolver. |
| NAO_AUTORIZADA | Só notas autorizadas pela SEFAZ podem ser devolvidas. |
| JA_E_DEVOLUCAO | Esta já é uma nota de devolução. |
| NOTA_DE_ENTRADA | Nota de entrada — devolução de compra ainda não é emitida por aqui. |
| MODELO | Só NF-e (55) e NFC-e (65) podem ser devolvidas. |
| SEM_XML | Nota sem XML autorizado no Dexo (importada de outro sistema) — não dá para referenciar os itens. |
| SEM_ITENS | Nota sem itens registrados no Dexo. |
| TOTALMENTE_DEVOLVIDA | Todos os itens desta nota já foram devolvidos. |
| EM_ENVIO | Uma devolução desta nota está aguardando a SEFAZ. Acompanhe o resultado antes de emitir outra. |
| Labels | Emitir nota de devolução · Continuar devolução (rascunho) · Ações da nota |

### Error codes (A/D/E/F)

| Code | Text |
|---|---|
| DEVOLUCAO_TOTAL_JA_EMITIDA | = TOTALMENTE_DEVOLVIDA |
| DEVOLUCAO_EM_ENVIO | = EM_ENVIO |
| ORIGINAL_NAO_AUTORIZADA | = NAO_AUTORIZADA |
| ORIGINAL_CANCELADA | = CANCELADA |
| ORIGINAL_SEM_XML | = SEM_XML |
| ORIGINAL_ENTRADA | = NOTA_DE_ENTRADA |
| AMBIENTE_DIVERGENTE | A nota original e o emissor estão em ambientes diferentes (teste × produção). A devolução precisa ser no mesmo ambiente. |
| EMITENTE_NAO_ENCONTRADO | O CNPJ que emitiu a nota original não está mais configurado. Cadastre-o em Configuração fiscal. |
| ORIGINAL_NAO_ENCONTRADA | Não encontramos esta nota entre as notas autorizadas emitidas pelo Dexo nesta conta. |
| NAO_EDITAVEL | Esta nota já foi enviada à SEFAZ e não pode mais ser alterada. |
| 404 without code | Nota não encontrada ou recurso de devolução indisponível. |
| 403 | Você não tem permissão para emitir notas fiscais. |
| Fallback | `body.error` (cut to 300 characters), otherwise "Não foi possível iniciar a devolução (HTTP N)." |
| Network | Erro de conexão ao preparar a devolução. Tente de novo. |

### Wizard

| Where | Text |
|---|---|
| Toggle | Tipo de nota · Nota normal · Nota de devolução |
| PENDENTE hint | Informe a chave de acesso (44 dígitos) da NF-e ou NFC-e que o cliente está devolvendo. Dica: em Notas emitidas, o menu ⋯ da nota tem "Emitir nota de devolução", que já preenche tudo. |
| Button | Buscar nota |
| Emitter warning | Esta chave foi emitida pelo CNPJ {cnpj}, que não é um emitente configurado nesta conta. Só é possível devolver notas emitidas pelo Dexo nesta conta. |
| Step-1 gate (PENDENTE) | Informe a nota original e clique em Buscar nota antes de continuar. |
| LEGADA | Este rascunho foi marcado como devolução antes do novo fluxo e não tem a nota original vinculada. Informe a chave da nota original ou volte para nota normal. |
| ERRO | Não foi possível carregar os dados da devolução. · Tentar de novo |
| Referenced note | Nota original · Número · Série · Emitida em · Destinatário · Chave de acesso |
| Type | Devolução total — Todos os itens, com toda a quantidade ainda disponível. · Devolução parcial — Você escolhe itens e quantidades no passo Produtos. |
| Question | A mercadoria chegou a ser entregue ao cliente? · Sim, foi entregue e o cliente devolveu · Não — foi recusada ou não foi entregue |
| Explanation | Recusa no recebimento ou destinatário não localizado não é devolução: a mercadoria nunca chegou a ser do cliente. Esse caso usa outro tipo de nota (nota de crédito, finalidade 5), que o Dexo ainda não emite. Fale com seu contador. |
| Gate, no answer | Responda se a mercadoria foi entregue e devolvida pelo cliente. |
| Gate, "Não" | Recusa ou não entrega não é devolução — esta nota não pode ser emitida para esse caso. |
| Destinatário locked | Destinatário da nota original — CPF/CNPJ e nome não podem ser alterados na devolução. Endereço e contato podem ser atualizados. |
| NFC-e without consumer | A NFC-e original não identificou o consumidor. Informe CPF e nome de quem está devolvendo. |
| Strip | Qtd original · Já devolvida · Disponível · Quantidade a devolver · Não devolver este item · Incluir na devolução · Fora desta devolução · Já devolvido integralmente |
| TOTAL lock | Na devolução total as quantidades são todo o saldo disponível. Para escolher, mude para devolução parcial no passo Informações. |
| CFOP | CFOP da venda · CFOP da devolução · Não há correspondência automática para o CFOP {x}. Escolha o CFOP de devolução (confirme com seu contador). · Escolha o CFOP de devolução deste item. · O CFOP {x} não é de devolução para esta operação. |
| Quantity | Quantidade não pode ser negativa. · Use no máximo 4 casas decimais. · Máximo {d} {un} — {j} {un} já devolvida(s). · Escolha pelo menos um item para devolver. |
| Payment card | **Sem pagamento** — Nota de devolução não tem forma de pagamento: a SEFAZ exige "Sem pagamento" (código 90). Se houver reembolso ao cliente, registre-o no Financeiro. |
| Duplicatas card | Nota de devolução não tem duplicatas (cobrança). Esta etapa não se aplica. |
| Step 8 | Na devolução, bases e alíquotas repetem as da nota original, proporcionalmente à quantidade devolvida. |
| Stock notice | Esta nota é só fiscal: o estoque não é alterado. Se a peça voltou para a prateleira, ajuste o estoque do produto. |
| Emission box | Ao clicar em "Emitir nota de devolução", a nota de entrada será validada, numerada e enviada à SEFAZ, referenciando a {NF-e\|NFC-e} nº {n} série {s}. |
| Banner | Emitindo devolução da {NF-e\|NFC-e} nº {n} série {s} · Cliente: {nome} · emitida em {dd/mm/aaaa} · devolução {total\|parcial}. PENDENTE: "Nota de devolução — informe a nota original no passo Informações." |
| Dialog PARA_NORMAL | Voltar para nota normal? · A ligação com a {NF-e} nº {n} série {s} e os itens da devolução serão removidos deste rascunho. Os dados do destinatário continuam. · Manter devolução · Voltar para nota normal |
| Dialog SUBSTITUIR | Substituir os dados deste rascunho? · Os itens e o destinatário preenchidos serão trocados pelos da nota original. · Cancelar · Substituir |
| Steps (devolução) | 3 "Itens devolvidos" · 6 "Não se aplica" · 7 "Sem pagamento" |

Dates are formatted with `toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })`, which keeps them deterministic in tests.

---

## 8. Proving flag-off is identical (jsdom is broken)

1. **Commit 1, on clean HEAD before any change:** add `tests/fiscal/nfe-devolucao-dom-golden.spec.tsx`. It runs in node, uses `renderToString`, mocks `next-auth/react` with `vi.mock` (as in `tests/scrap-link-section-form.spec.tsx:73`) and `@/lib/api`, and wraps each step in a harness that calls `useForm({ defaultValues: DEFAULT_NFE_DRAFT })`.
   - It renders `StepInformacoesGerais` (with and without 2 companies), `StepDestinatario`, and `StepFinalizar` (with divergence and without), each with `toMatchSnapshot()`.
   - Commit it with the snapshots. Every later commit must keep them green with the flags unset.
2. **Pure pins:**
   - `buildNfeRowActions({ flagOn: false })` returns `[]`.
   - `resolverModoInicial(false, "DEVOLUCAO", *)` returns `"NORMAL"`.
   - `descricoesPassosDevolucao(STEPS, "NORMAL") === STEPS` (same reference).
   - `interpretarRespostaEmissao` matches the legacy branches of `:476-499`.
3. **Structure:**
   - Every new JSX branch is gated by `DEVOLUCAO_UI` or by an absent optional prop, using conditional spreads.
   - `handleNext`, `handleEmitir`, `saveCurrentStep` and `populateFormFromDraft` keep their bodies. Only the selectors (`onNext`, `onSubmit`) and the added mount-effect blocks behind `DEVOLUCAO_UI` change.
   - No new network call without a flag. The only always-on addition is the `mountedRef` effect, which has no I/O.
4. **Gates:** `tsc --noEmit` multiset diff against the baseline worktree, eslint (`prefer-const`) through `next build`, `vitest --pool=forks`.

---

## 9. Tests (node, pure)

**`tests/fiscal/nfe-devolucao-ui.spec.ts`**
- Flags: `"true"` is on; `""`, `"1"`, `"TRUE"`, `"false"` and unset are off, for both readers (`vi.stubEnv`, `afterEach(vi.unstubAllEnvs)`).
- `buildNfeRowActions`:
  - Invariants over the product of 8 statuses × modelo {55, 65, undefined, 57} × finalidade {NORMAL, DEVOLUCAO} × tipo {SAIDA, ENTRADA} × hasXml/hasXmlAutorizado {t/t, t/f, f/undef} × temItens {undef, false} × saldo {undefined, null, total, em envio, rascunho}:
    - (1) disabled implies a non-empty reason;
    - (2) enabled implies AUTHORIZED ∧ ¬DEVOLUCAO ∧ SAIDA ∧ modelo ok ∧ autorizado XML ∧ ¬total ∧ ¬em envio;
    - (3) flag off gives `[]`;
    - (4) `isDevolucaoStaticamenteElegivel(row)` equals "enabled with saldo undefined".
  - Precedence cases: CANCELLED + DEVOLUCAO gives CANCELADA; REJECTED + no XML gives NAO_AUTORIZADA.
  - Label and intent "continuar" when a draft is open. NFC-e 65 AUTHORIZED is enabled. `hasXmlAutorizado` missing falls back to `hasXml`.
- `interpretarCriacaoDevolucao` / `mensagemErroDevolucao`:
  - 200/201 gives "abrir"; 201 without `draftId` gives "erro".
  - Each 409/422 code maps to its copy; 422 with `draftId` gives "abrir" with an aviso.
  - 404, 403, 500 with and without `body.error`; `body.error` longer than 300 characters is cut.
  - A non-object body does not throw.
- Quantities:
  - `disponivelDaLinha` in fixed point (0.1+0.2 cases, 3 − 1.0001), clamped at 0 when there is `qtdEmAndamento`.
  - `aplicarTipoDevolucao` TOTAL/PARCIAL, and back again.
  - `validarLinhasDevolucao`: negative; 5 decimals; above disponível (message uses the unit); sum 0; everything already returned; ambiguous without CFOP; CFOP 1202 with `idDest` 2; MEI with 1411; line at q=0 ignores CFOP; TOTAL with q≠disp.
  - `linhasParaPayload` keeps order and `nItemOriginal` (not positional).
- Wizard:
  - `resolverModoInicial` full table.
  - `validarPassoDevolucao` for steps 1/3 in every mode, entrega null/false/true.
  - `formTemDadosDigitados`.
  - `payloadMudou` with the same keys in a different order returns false.
  - `descricoesPassosDevolucao`: NORMAL keeps the same reference; DEVOLUCAO changes only 3/6/7.
  - `montarBannerDevolucao`: 55 vs 65, no name, no date, null reference.
  - `textoNumeracaoRejeitada`: true, false, undefined (never mentions "reaproveitado").
- Emission:
  - `interpretarRespostaEmissao`: 409 EMISSAO_EM_ANDAMENTO; 500 "NF-e ja esta em processamento de emissao ou ja foi emitida" gives em_andamento; 500 other message gives erro; 200 success AUTHORIZED / SENDING / !success.
  - `decidirPollEmissao`: null and SENDING continue until `max` then give tempo_esgotado; DRAFT gives liberada; AUTHORIZED, REJECTED (with motivo) and CANCELLED map through.

**`tests/fiscal/devolucao-cfop.spec.ts`**
- Set size is 105; contains 1212, 2919, 3553, 5921 and 7556; excludes 5102, 1102, 5949 and 1949.
- Each `MAPA_VENDA` entry gives UNICO. 6404 with idDest 2 gives ESCOLHA [2411, 2949]. 5949 with idDest 1 gives [1949]. 5102 with idDest 2 gives DESTINO_DIVERGENTE [2202]. 5117 gives SEM_MAPEAMENTO with first digit 1 plus 1949. 7101 gives only 3xxx options.
- crt 4: 5405 gives 1202, 6403 gives 2202, idDest 3 gives ESCOLHA [].
- Properties: every UNICO and every option passes `cfopValidoDevolucaoEntrada`. Validator: 1949 ok for idDest 1; 3949 false; 5202 false.

**`tests/fiscal/chave-acesso-dv.spec.ts`**
- Parity: `calcularDvChave(b) === calcularDV(b)` (imported from `app/fiscal/sefaz/chave-acesso.ts`) for 500 deterministic 43-digit bases (seeded LCG).
- Round trip: `montarChave` with explicit `cNF` parses with `validarChaveAcesso`, and `info` matches `parseChave`.
- Inputs: "NFe" + 44 digits (47 characters) is ok; spaces, dots and dashes are ok; a letter in the middle, 43 digits, 45 digits, wrong DV, modelo 57 and month 13 each give their code.
- `formatarChaveAcesso` gives 11 groups.

**`tests/fiscal/nfe-devolucao-dom-golden.spec.tsx`:** §8.1.

---

## 10. File list and commit order

**New**
- `app/fiscal/domain/chave-acesso-dv.ts`
- `app/fiscal/domain/devolucao-cfop.ts`
- `app/notas-fiscais/lib/nfe-devolucao.ts`
- `app/notas-fiscais/lib/nfe-devolucao-api.ts`
- `app/notas-fiscais/hooks/use-nfe-devolucao-quick-action.ts`
- `app/notas-fiscais/components/nfe-row-actions-menu.tsx`
- `app/notas-fiscais/components/devolucao/{devolucao-modalidade-toggle,devolucao-panel,devolucao-itens-editor,devolucao-context-banner,devolucao-aviso-card,devolucao-resumo-section,devolucao-confirm-dialog}.tsx`
- `tests/fiscal/{nfe-devolucao-ui,devolucao-cfop,chave-acesso-dv}.spec.ts`
- `tests/fiscal/nfe-devolucao-dom-golden.spec.tsx`

**Modified (additive)**
- `app/notas-fiscais/components/nfe-list.tsx`
- `app/notas-fiscais/components/nfe-detail-sheet.tsx`
- `app/notas-fiscais/components/nfe-wizard.tsx`
- `app/notas-fiscais/components/steps/step-informacoes-gerais.tsx`
- `app/notas-fiscais/components/steps/step-destinatario.tsx`
- `app/notas-fiscais/components/steps/step-finalizar.tsx`
- `app/interfaces/nfe.interface.ts`: optional `hasXmlAutorizado?` on `NfeListItem` (`:243`), `numeracao?` on `NfeDraftResponse` (`:129`)
- `docs/fiscal-sefaz-direto.md`: flags section

**Not touched:** `step-produtos.tsx`, `step-pagamentos.tsx`, `step-duplicatas.tsx`, `step-impostos.tsx`, `use-nfe-draft.ts`, `cfop-combobox.tsx`, `cfop-catalog.ts`, `chave-acesso.ts`, `nfe-form-schema.ts`, `nfe-defaults.ts`.

**Commits**
1. Golden SSR snapshots on clean HEAD.
2. Pure domain modules (`chave-acesso-dv`, `devolucao-cfop`) with tests.
3. `nfe-devolucao.ts` and its tests.
4. API helper and hook.
5. List, menu and detail sheet.
6. Wizard: mode, step 1 and panel.
7. Steps 2/3/6/7/8/9, save strategy and banner.
8. Emission V2 (ref guard and polling).

Each commit must pass the gates in §8.4.

---

## 11. Open items and risks to surface

1. **Backend requirements that block safe use:** §2 items 1-4. The most important is PUT `/draft` refusing server-owned fields on drafts with a reference; without it, a stale tab overwrites them silently.
2. **Devolução de compra** (SAÍDA, buyer returning to the supplier) and originals from outside Dexo: blocked in v1 with the NOTA_DE_ENTRADA and ORIGINAL_NAO_ENCONTRADA messages. That flow would need the supplier's XML and a manually typed `nItem`.
3. **Refusal or non-delivery (finNFe=5):** the UI only explains and blocks. It is mandatory in 2027.
4. **CFOP 6404 and 59xx/69xx:** the options follow the established facts, but the final choice is the user's. Recommend that the contador validate the table before the flag goes on in production.
5. **Local CFOP catalog** is missing 20 indDevol codes. The devolução UI uses a fallback description; updating the catalog is a separate data PR, because it changes the normal combobox.
6. **Existing false copy:**
   - "ambiente de homologacao" in `step-finalizar.tsx:192-196`;
   - the reuse promise in `nfe-wizard.tsx:544-546`, which R1 makes false after any save. Fix both under the numbering-v2 flag, not in this work.
7. **Polling** uses `GET /fiscal/nfe/:id`, which returns the whole row with items and 20 events (`fiscal.routes.ts:1133-1139`). At most 10 calls per emission is acceptable. A `?view=status` variant is an optional optimization.
8. **The wizard does not re-read `?draft=`** when the search changes on the same page (`:171`, effect deps `[email]`). The quick action always leaves from Emitidas, so this does not affect it. Do not use `router.push` to `?draft=` from inside the wizard.