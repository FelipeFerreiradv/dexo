# REVIEW fiscal

[blocker] Numbering V2 × Devolução (emission path)
PROBLEM: All devolução emission hooks sit inside the V1 lines of emit(), but numbering V2 hands emit() to a separate orchestrator whenever V2 is on. With both flags on, a finNFe=4 draft is emitted by V2 with none of the devolução logic. It skips validarDevolucao (D01–D23), the claimComSaldo lock and balance check, calcularTributosDevolucao, and aplicarContextoDevolucao (no DFeReferenciado, forced tPag 90, impostoDevol, vIPIDevol or CST/CSOSN from context). The post-authorization hook is skipped too.
EVIDENCE: Devolução backend §4.2/4.3 swaps the claim at nfe-emission.usecase.ts:147-155, the calc at :195, adds context after loadNfe at :290 and the hook in handleAuthorized :789-937. Numbering V2 §4.21(1) says lines 92–564 run unchanged only when the flag is off; when on, nfe-emissao-v2.orchestrator runs. Its calculo-emissao.ts mirrors only usecase:163-193 (the default calculator, CST 102/00 from :171-174). Without context, the SEFAZ builder emits the default det (:385-444) and pag from pagamentosJson (:736-770), so there are no references (321). In production before 05/10, a legacy devolução whose notasReferenciadasJson is still consumed by the Focus builder (nfe-xml-builder.service.ts:205-211) could be authorized with no balance check.
FIX: Define one DevolucaoEmissionHooks interface: preClaimValidate, claimWithSaldo(tx), calcular, applyContext, postAuthorized. Call it from BOTH the V1 path and the V2 orchestrator. In V2, take the advisory locks and check the balance inside the same transaction as the reservation, and apply the context before prepararEmissao/hashConteudo so the digest covers DFeReferenciado. Alternatively, make NFE_DEVOLUCAO_ENABLED require V2 at runtime and implement the hooks only in the orchestrator. Add a spec that runs a DEVOLUCAO draft through V2 and asserts DFeReferenciado and tPag=90 in the transmitted XML.

[blocker] Focus hardening B1 (INCERTA → NAO_CONSTA)
PROBLEM: After a POST that timed out or returned 5xx, the design confirms 'not received' after 3 GET 404 within the 2s/4s/8s waits (≤14 s, 40 s budget). It then turns the row into REJECTED via handleNaoEnviada. The client-side AbortSignal (30 s) does not stop Focus from finishing the request, and Focus may create the ref only after the synchronous SEFAZ answer, so an early 404 proves nothing. A REJECTED row can be deleted, and the banner says the note 'não chegou a ser enviada'. The user deletes it and issues a new draft under a new ref, and both documents get authorized. That is a duplicate NF-e.
EVIDENCE: Today V1 keeps these rows in SENDING (nfe-emission.usecase.ts:521-536), and findDraftById only returns DRAFT|REJECTED (nfe.repository.ts:321-323), so a SENDING row can be neither re-emitted nor deleted. After B1 the row is REJECTED. DELETE /nfe/draft/:id (fiscal.routes.ts:762-781) goes through nfe-draft.usecase.ts:524-531, which accepts REJECTED, and deleteDraft has no status check (nfe.repository.ts:479-491). Numbering V2 requires maturity (provaMadura 120 s, 'GET 404 mature vs immature').
FIX: Reuse V2's provaMadura: before ≥120 s have passed since the POST started, a 404 stays INCERTA and the row stays SENDING, with a 'Consultar situação' action. Never write REJECTED for NAO_ENVIADA{confirmado:false}. Keep the row SENDING until a mature 404 is confirmed. Refuse delete (409) and draft edits while the last outcome is ENVIO_INCERTO or NAO_ENVIADA{confirmado:false}. Add a test: timeout, then 404×3 within 14 s, then row still SENDING, DELETE returns 409.

[blocker] Devolução API contract (fiscal gating finNFe 4 vs 5)
PROBLEM: The frontend and backend contracts for devolução don't match, and the delivery question that separates devolução (finNFe=4) from refusal (finNFe=5) sits at different points. The frontend creates the draft with POST body {} and asks 'devolvida após entrega?' later in step 1 (route E). The backend rejects creation unless devolvidaAposEntrega===true, so every quick action fails. The two sides also disagree on routes, bodies, idempotency and eligible models.
EVIDENCE: Backend §3.1 throws RECUSA_NAO_E_DEVOLUCAO (422) when body.devolvidaAposEntrega !== true. Frontend §3.4 calls iniciarDevolucao(...) with body {} and expects 201/200 {draftId, reused}, while the backend returns {draft, devolucao} or 409 DEVOLUCAO_RASCUNHO_EXISTENTE. Frontend routes C/D/E/F are /fiscal/nfe/draft/:draftId/devolucao..., backend routes are /fiscal/nfe/:id/devolucao and PUT /:id/devolucao/itens with {chaveAcesso,nItem,tributacao,confirmarTributacao}. The frontend enables NFC-e 65 originals (buildNfeRowActions); the backend has MODELOS_ORIGINAIS_PERMITIDOS=['55'].
FIX: Pick one contract. Recommended: the backend accepts creation without the delivery answer, stores devolvidaAposEntrega=null, and D18 blocks at emission until it is true. Keep one route set, keyed by (chave, nItemOriginal), with explicit tributação fields. Disable 65 originals in the UI until the backend supports them. Add a contract test shared by lib/nfe-devolucao-api.ts and the route schemas.

[major] Devolução XML: ICMS group tags
PROBLEM: The SEFAZ builder names the ICMS group directly from the CST/CSOSN (ICMSSN${csosn}, ICMS${cst}). Layout 4.00 has no ICMSSN103, ICMSSN300, ICMSSN400, ICMSSN203, ICMS41 or ICMS50: those codes belong in ICMSSN102, ICMSSN202 and ICMS40. The bug is latent today because item.cstIcms is never persisted. The devolução design marks SN 103/300/400 and CST 41/50 as 'supported' and copies the CST/CSOSN from the original XML, so every such devolução fails schema validation (225).
EVIDENCE: nfe-xml-builder-sefaz.service.ts:459-461 has `const csosn = item.cstIcms ?? "102"; const tag = `ICMSSN${csosn}``, and :473,:490 have `const tag = `ICMS${cst}``. loadNfe items do not map cstIcms (nfe-emission.usecase.ts:1174-1191), and the only uses are defaults (:171, fiscal.routes.ts:841). Devolução §5.3 says 'ICMS SN 102, 103, 300, 400, 500 sim' and 'ICMS normal 40, 41, 50, 60 sim'. §2 aplicarContextoDevolucao sets item.cstIcms from ImpostoOriginal, whose grupo is ICMSSN102 while csosn is 400.
FIX: When a devolução context is present, map the tag from the code: SN {102,103,300,400}→ICMSSN102, {202,203}→ICMSSN202 (still unsupported), normal {40,41,50}→ICMS40. Keep the current path byte-identical when there is no context. Alternatively, shrink the D15 allowlist to SN 102/500/900 and CST 00/40/60/90. Add golden XML tests per supported group (ICMSSN102 with CSOSN 400, ICMS40 with CST 41), validated against PL_010 XSD order.

[major] cStat classification (Focus design A2 vs V2)
PROBLEM: The A2 classifier marks every unlisted code ≥200 as reusable 'rejeitada'. That includes 635 ('NF-e com mesmo número e série já transmitida e aguardando processamento'), which the legacy mapper leaves as desconhecido and non-reusable, so this is a regression. Reusing the number while the earlier transmission is still processing leads to a later 539, which A2 marks DUPLICIDADE non-reusable, so the next click reserves a new number. The earlier transmission is authorized without Dexo recording it, and the new number is authorized too: a duplicate. A2 also marks 204/539/562/613 as non-reusable with no consult, while V1 SEFAZ parsing sends duplicidade to reconciliation and V2/tests require consulting by chave.
EVIDENCE: Focus design §2.1: `if (c >= 200 && c <= 9999) return { classe: "rejeitada", reaproveitavel: true }`, and DUP = {204,218,539,562,613,573} with no 635. Legacy cstat-mapper.ts:111-129 marks only 200–599 as rejeitada, so 635 is desconhecido. sefaz-direct.provider.ts:898-910 and :963-976 return 'processando' for duplicidade 'para o use case RECONCILIAR'. Numbering V2 tests include '635 then retry is blocked' and '539 with our chave … AUTORIZADO'. The tests design case 2 says 204/539 'consult by chave first'.
FIX: Use one classifier module for V2, Focus hardening and the listing's reaproveitavel. Map 635 (and Focus pending_operation) to INCERTO: no reuse, no new number, consult. Map 204/539/562/613 to CONSULTAR: parse the chave from xMotivo, consult it, and mark AUTORIZADO or BLOQUEADO; never offer a new number automatically. Add 635 to the classification spec with the expectation 'not reusable and not new-number'.

[major] Denegada handling outside V2 (Focus design A2/B1)
PROBLEM: A2/B1 only make denegada codes (110/205/301–303, Focus 'denegado') non-reusable. The row still ends up REJECTED, which is editable, re-emittable and deletable. The next emit reserves a new number and overwrites numero and chaveAcesso, and handleRejected never stores the denial protocol. The consumed, denied number disappears from Dexo, deleting the row also cascades the audit log, and the diagnostic reports it as a hole to inutilize, which SEFAZ refuses because the number was used.
EVIDENCE: NfeStatus has no denied state (nfe.types.ts:3-11), and REJECTED→VALIDATING/DRAFT is allowed (:141). handleRejected writes only status/motivo/cStat (nfe-emission.usecase.ts:1059-1072). The row is renumbered at :262-278, and the chave is overwritten at :367-371. Delete is allowed for REJECTED (nfe-draft.usecase.ts:524-531). Focus design §11 risk 2 admits 'the same row can never be authorized' for Focus, but nothing blocks it on SEFAZ direct.
FIX: Under A2/B1 (independent of V2): for a DENEGADA outcome, persist chave, nProt and numero in the audit log and the ledger, block re-emit and delete of that row (409 'nota denegada — crie um novo rascunho'), and exclude it from the inutilização suggestion. Or declare denegada handling as V2-only and do not ship A2's denegada classes without V2's DENEGADO state.

[major] Focus read-back and sequence (Focus design gravarNumeracaoReal)
PROBLEM: (1) The sequence is advanced past the authorized nNF only in DEXO mode. In PROVEDOR mode (the default for current Focus tenants), Focus's own counter can get ahead of Dexo's, and switching to SEFAZ direct then reserves numbers Focus already authorized: 539, burned numbers, one per click. This violates 'switching Focus↔SEFAZ keeps sequence consistent'. (2) The advance uses consultarProximoNumero plus ajustarProximoNumero, a read followed by an unconditional update. A concurrent reservation in between is overwritten and the counter moves backward, violating 'no numero--'.
EVIDENCE: Focus design §3.4.8: `if (ctx.numeracao === "DEXO") { const prox = await this.sequenceService.consultarProximoNumero(...); if (ctx.real.nNF + 1 > prox) await this.sequenceService.ajustarProximoNumero(...) }`. nfe-sequence.service.ts:264-286 does a findFirst, then `if (novoNumero <= atual) throw`, then `update({ where: { id }, data: { proximoNumero: novoNumero } })`, with no FOR UPDATE and no GREATEST. reservarProximoNumero increments under FOR UPDATE in a separate transaction.
FIX: Always advance to real nNF+1 when greater, whatever the numbering mode, and audit it as consumido_externo. Implement it as one statement inside the same lock as reservation: `UPDATE "NfeSequence" SET "proximoNumero" = GREATEST("proximoNumero", $n) WHERE <emitter key>`, creating the row with ON CONFLICT when missing. Never call ajustarProximoNumero from emission. Add a PG concurrency test: interleave the adjustment with 20 reservations and assert the counter never decreases.

[major] Focus design B2: consult-before-resend after edits
PROBLEM: The reuse decision reads the last outcome event even after the wizard has demoted the row to DRAFT (R1). If the consult finds the earlier POST authorized, the row becomes AUTHORIZED with the edited items and totals, while the authorized XML holds the old content. The DB fiscal record then diverges from the authorized document: listing, reports, devolução balance and the DANFE fallback all read it.
EVIDENCE: Focus design §3.4.2 only checks draft.numero > 0 plus the last event among EVENTOS_DESFECHO, and EDITADA_DRAFT is not in the list. §3.4.4 `if (previa.status === "autorizada") providerResult = consultaComoEmitResult(previa)` then calls handleAuthorized. updateDraft replaces the items (nfe.repository.ts:427-441). The DANFE falls back to DB data when there is no XML (nfe-emission.usecase.ts:860-899). §11 risk 4 acknowledges this but does not mitigate it.
FIX: Refuse updateDraft (409) while the last outcome is NAO_ENVIADA{confirmado:false} or ENVIO_INCERTO. When authorization is found for a row edited after the attempt, rebuild NfeItem and totaisJson from the authorized XML (parseNfeXml), keep the edited version only in the audit log, and emit autorizada_com_conteudo_anterior, as V2 does.

[major] Devolução rollout gating
PROBLEM: The backend devolução flag is a single global boolean with no config allowlist, no ambiente/date guard and no dependency on the numbering fixes. (a) Testing in homologação turns it on for every production tenant before 05/10/2026, while production still applies the old finNFe=4 reference rule, so a note with DFeReferenciado and no NFref gets 321. (b) Devolução-specific rejections 1010/1048/1072/1193/1194/731–733/871 are ≥600, so V1 never reuses their numbers, and R1 renumbers anyway, which burns numbers systematically.
EVIDENCE: Devolução backend §8: `isNfeDevolucaoEnabled() → process.env.NFE_DEVOLUCAO_ENABLED === "true"` with no allowlist. §11.1 says production only after 05/10 'ou com evidência', which is procedural only. nfe-number-reuse.ts:60-61 plus cstat-mapper.ts:111-129 mean codes ≥600 are not reusable. updateDraft forces DRAFT (nfe.repository.ts:379-381). The tests design assumes NFE_DEVOLUCAO_ENABLED + _CONFIG_IDS.
FIX: Add NFE_DEVOLUCAO_CONFIG_IDS (fail-closed) and a pre-claim guard: when config.ambiente=PRODUCAO and today < NFE_DEVOLUCAO_PROD_DESDE (default 2026-10-05), return 422 without claiming. At runtime, require numbering V2 (or at least A1+A2 plus the PUT paths that keep REJECTED) to be effective for the same config before a DEVOLUCAO draft may be emitted.

[major] Devolução: tributação review missing in UI
PROBLEM: The backend marks many items requerRevisao: IPI destacado, a Simples/normal family mismatch with the original, manual devolução without XML, COMPRA_SAIDA with CSOSN 900. D15 blocks emission until an override with confirmarTributacao arrives. The frontend contract and editor have no tributação fields, so these devoluções can never be emitted from the UI. Relaxing D15 to unblock them would send CST/aliquots that don't match the original (545/546/1002).
EVIDENCE: Backend §3.4 body has `tributacao` and `confirmarTributacao`, and §5.2 plus D15 block on `requerRevisao === true`. Frontend §2 route E body is `{ tipo?, entregaConfirmada?, itens?: [{nItemOriginal, quantidade, cfop}] }`, and §5.5 DevolucaoItensEditor props have no tributação.
FIX: Add a per-item tributação review in step 3/8, restricted to the backend allowlist (after the ICMS group fix): show the original group and values, the proposed CST/CSOSN and aliquots, and an explicit confirmation that sends confirmarTributacao. Otherwise, have the backend return 422 at creation for items the UI cannot resolve, instead of creating a draft that can never be emitted.

[major] Responsável técnico resolver (974/975/972)
PROBLEM: Validation only checks that idCSRT and CSRT come together, so configurations that are rejected on every emission can be saved. Focus PERSONALIZADO can never carry a CSRT. SEFAZ PERSONALIZADO without a CSRT is accepted. Both give 975 on every production emission in PR, where CSRT is mandatory since 01/04/2026. SEFAZ NENHUM omits infRespTec in UFs that require it (972). Every SEFAZ-direct PR tenant on PADRAO keeps using the global env RT, which has no CSRT (975, or 974 if Dexo is not authorized in UPD), and nothing surfaces this.
EVIDENCE: Focus design §4.2 validarRespTec lists only CNPJ, contato, email, fone and '`idCsrt` and a CSRT … must come together', with no UF rule. §4.1 resolveRespTec for Focus PERSONALIZADO has 'NEVER hash_csrt'. The facts note PR CSRT mandatory in production since 01/04/2026 (975). resp-tec.ts is used by sefaz-direct.provider.ts:197 for all tenants, and prod NFE_RESP_TEC_CNPJ has no CSRT.
FIX: Add a per-UF requirement table (starting with PR: infRespTec+CSRT required in PRODUCAO). Block saving SEFAZ PERSONALIZADO without CSRT and NENHUM there, block Focus PERSONALIZADO where a CSRT is required (Focus must stay RT), and warn in the card. Add a diagnostic section listing SEFAZ-direct PRODUCAO configs in PR resolving to ENV_LEGADO, and fail emission before the claim with a clear message instead of a guaranteed 975.

[major] Devolução × cancelamento of the original
PROBLEM: Nothing stops cancelling an original that already has authorized or in-flight devoluções referencing it, and the claimed serialization with cancelamento does not exist. Cancellation takes no lock and calls SEFAZ before updating the database, so a devolução can pass the 'original AUTHORIZED under FOR UPDATE' re-check while the original is already cancelled at SEFAZ. The result is a cancelled sale with an authorized devolução.
EVIDENCE: nfe-cancelamento.usecase.ts:50-60 checks only status === 'AUTHORIZED'. :109-115 calls provider.cancelar, then :135-141 does the DB update (no FOR UPDATE, no advisory lock). Devolução §4.3 claims 'O cancelamento só pega o lock da linha da original', and §7 adds only an optional audit hook.
FIX: When the flag is on, the cancel use case takes pg_advisory_xact_lock('nfe-devolucao:{userId}:{chave}') before provider.cancelar. Inside it, refuse (409) when any NfeDevolucaoItem for that chave belongs to a devolução in AUTHORIZED/VALIDATING/SIGNING/SENDING. Hold the lock until the status update, or record CANCELANDO under the lock first.

[minor] Focus design consult-before-resend
PROBLEM: The consult-first path re-POSTs whenever the consult result is 'rejeitada'. That includes DENEGADA and DUPLICIDADE, whose number is consumed, so the same number is sent again.
EVIDENCE: Focus design §3.4.4: '// NAO_CONSTA or rejeitada ⇒ POST normally', and §3.1 consult table maps erro_autorizacao/denegado to status 'rejeitada' with desfecho DENEGADA/DUPLICIDADE.
FIX: Only desfecho ∈ {NAO_CONSTA, REJEITADA_SEFAZ(reusable class), REJEITADA_PROVEDOR} proceeds to POST. DENEGADA or DUPLICIDADE goes to handleRejected with the terminal state, without a POST.

[minor] Focus design 422 classification
PROBLEM: Any 422 whose codigo is not in the list and has no numeric status_sefaz is marked REJEITADA_PROVEDOR, which is reusable. Unknown Focus codes that mean the ref or number is already used would be treated as 'never reached SEFAZ'.
EVIDENCE: Focus design §3.1 table: '422 | other without cStat | rejeitada | REJEITADA_PROVEDOR'. Today the provider passes body.codigo raw (focus-nfe.provider.ts:89-101).
FIX: Mark only the documented schema/validation codes (erro_validacao_schema, requisicao_invalida) reusable. Send unknown 422 codigos to INCERTA with a consult by ref before any reuse or new number.

[minor] A2 listing promise vs R1
PROBLEM: A2 turns reaproveitavel on for ≥600 codes (974, 704…), so more list rows show 'Tentar novamente — reaproveita o nº'. That button opens the wizard, whose first 'Próximo' calls updateDraft and demotes the row to DRAFT, so V1 reserves a new number anyway.
EVIDENCE: nfe-list.tsx:784-806 shows the tooltip 'Tentar novamente — reaproveita o nº'. nfe.repository.ts:379-381 has updateDraft set status DRAFT. Focus design §2.6 changes nfe.repository.ts:93-95 and :753-757 to the V2 classifier.
FIX: Do not change reaproveitavel under A2 unless V2 (or an R1 fix) is effective for that config, or change the tooltip text to not promise reuse.

[minor] Focus B3 with legacy rows
PROBLEM: With Dexo-controlled numbering on (B3) under V1 reuse, a Focus row REJECTED before B3 reuses its DB numero. That number was never a real nNF, because Focus auto-numbered, and it may already be authorized under Focus's own sequence, giving repeated 539 churn. Numbering V2 explicitly refuses to adopt legacy Focus rows; B3 does not.
EVIDENCE: nfe-xml-builder.service.ts:56 sends numero_nota, which Focus ignores (prod: DB 12/13/14 vs nNF 3/4/5). shouldReuseNumero (nfe-number-reuse.ts:51-62) doesn't know the provider or the numbering mode. Focus design §3.3 switches to payload.numero whenever isFocusNumeracaoDexo.
FIX: Under B3, reuse a number only when its NUMERADA audit is later than the B3 enable time for that config, or when the reservation carries numeracao='DEXO'. Otherwise reserve a new number.

[minor] Devolução idDest/indPres
PROBLEM: idDest is copied from the original while indPres is forced to 0. For a presencial sale to an out-of-state consumer (idDest=1 via the presencial exception, dest UF ≠ emit UF), the devolução carries idDest=1 with indPres=0. Rule 773 (internal operation with a different destination UF) grants its exception only to presencial operations, so the note may be rejected. Confirm against MOC 7.0.
EVIDENCE: Devolução §3.1 sets indPresenca 'NAO_SE_APLICA' and destinoOperacao from ide.idDest. The builder emits idDest from destinoOperacao and indPres from indPresenca (nfe-xml-builder-sefaz.service.ts:208-215, :234, :243).
FIX: When the original has idDest=1 and dest UF ≠ emit UF, mirror the original indPres (add it to ParsedIde, as §2.2 already plans) or require a user choice. Cover it with a validarDevolucao test.

[minor] Devolução text for Focus originals
PROBLEM: The infCpl ('Devolucao ref. NF-e ${numero} serie ${serie}') and the UI banner take the original's number from the database. For Focus-authorized originals that number is fake (DB 12 vs nNF 3), so the devolução's printed text cites the wrong document number.
EVIDENCE: Devolução §3.1 builds infCpl from the original's numero and serie. The facts show Focus prod rows with DB numero 12/13/14 against chave nNF 3/4/5. The parser returns ide.nNF/serie (nfe-xml-parser.service.ts:227-228 per the Focus design).
FIX: Use parsed.ide.nNF, parsed.ide.serie and dhEmi from the authorized XML (or the chave) for all human-readable references, never NfeEmitida.numero.

[minor] Devolução IPI and ICMS details in builder
PROBLEM: (1) The design maps IPI CST 51–55 to 01–05, but the builder only has an IPITrib group, and CST 01–05 belong in IPINT. (2) The SEFAZ builder hardcodes modBC='3' and never writes pRedBC for CST 00/90, so a copied modBC/pRedBC is lost and vBC×pICMS no longer matches vICMS for reduced-base originals.
EVIDENCE: nfe-xml-builder-sefaz.service.ts:513-520 emits `ipi.ele("IPITrib")` with CST fixed, and :496 `node.ele("modBC").txt("3")` with no pRedBC. Devolução §5.2 IPI mapping '50→00, 51→01 … 55→05' and icms {modBC, pRedBC}.
FIX: Restrict the IPI destacado mapping to 50→00 and 99→49. Block normal-regime originals with pRedBC or modBC≠3 in D15, or extend the builder under the devolução context only.

[minor] Chave/CNPJ alfanumérico
PROBLEM: Devolução validation assumes an all-digit chave: the DDL CHECK, normalizarChaveAcesso, the frontend 'só números' message and the CNPJ comparisons in D09/D10. Alphanumeric CNPJs are being issued from July 2026 (RFB IN 2.229/2024), and a new supplier's or tenant's chave may contain letters, with a different check-digit calculation. The NF-e layout date needs confirming.
EVIDENCE: Devolução DDL `CHECK ("chaveAcessoOriginal" ~ '^[0-9]{44}$')`. §2 normalizarChaveAcesso 'tira não dígitos'. Frontend §3.1 CARACTER_INVALIDO 'A chave de acesso tem só números'.
FIX: Confirm the NT and date for alphanumeric CNPJ in NF-e. If it is in force, accept [0-9A-Z] at positions 7–20, compute the check digit with ASCII−48 values, and compare CNPJs as uppercase alphanumerics.

CONFLICTS:
- Changes to emit() collide. Numbering V2 routes emit() to an orchestrator and says lines 92–564 stay unchanged. Devolução backend rewrites the claim, calc, context and handleAuthorized inside those lines. Focus/cStat design B rewrites :111-129, :226-362 and :457-556 in the same V1 body. With V2 on, the devolução and Focus-hardening code is skipped entirely.
- emit() third parameter: numbering V2 uses emit(userId, nfeId, opts?: EmitOpts) and finance.usecase.ts:1910 passes {confirmarDescarteNumero}. Devolução uses emit(userId, nfeId, actorUserId?: string) and the route passes user.id. handleAuthorized gets conflicting optional trailing parameters: V2's one parameter, devolução's (devCtx, actorUserId), Focus design's 11th `extras`.
- Files each design claims are unchanged are modified by another. Numbering V2 §4.21(3) lists focus-nfe.provider.ts, nfe-xml-builder.service.ts, nfe-xml-builder-sefaz.service.ts, cstat-mapper.ts and nfe-number-reuse.ts as unchanged, and says sefaz-direct emitir stays byte-identical. The Focus design modifies focus-nfe.provider.ts, nfe-xml-builder.service.ts:56, nfe-number-reuse.ts:60-61 and sefaz-direct.provider.ts:197-250. Devolução modifies both builders.
- Focus handling is designed twice: V2's focus-nfe-v2.client.ts plus classificacao.ts (classificarPostFocus/GetFocus) versus the Focus design's FocusNfeProvider.emitirV2 plus focus-response.ts. They disagree on 401/403/400: V2 keeps the reservation RESERVADO, Focus B turns the row REJECTED via NAO_ENVIADA. They also disagree on 404 maturity: V2 waits 120 s, Focus B confirms within ≤14 s.
- cStat classes: V2/tests route 204/539 through a consult and block 635. Focus A2 marks 204/539/562/613 DUPLICIDADE non-reusable with no consult and makes 635 reusable. V2's `normalizarCStat` and A2's `normalizeCStat` accept different ranges.
- Dexo-controlled Focus numbering flags: numbering uses NFE_NUMERACAO_V2_FOCUS_ENABLED plus NFE_NUMERACAO_V2_USER_IDS (userId allowlist). Focus design uses NFE_FOCUS_NUMERACAO_DEXO_ENABLED plus _EMPRESAS (configId). Tests use NFE_FOCUS_NUMERO_DEXO_ENABLED plus _CONFIG_IDS and require V2. Focus B3 can send `numero` under V1 numbering, which V2 forbids.
- RT flag name: NFE_RESP_TEC_POR_EMPRESA_ENABLED in the Focus design versus NFE_RESP_TEC_EMPRESA_ENABLED in the tests design.
- Devolução flags: the backend uses separate NFE_DEVOLUCAO_ENABLED (API) and NEXT_PUBLIC_NFE_DEVOLUCAO_ENABLED (build), precisely so the API is not switched on before the DDL. The frontend says the backend reads NEXT_PUBLIC_NFE_DEVOLUCAO_ENABLED 'so the two cannot diverge'. Tests use NFE_DEVOLUCAO_ENABLED plus _CONFIG_IDS.
- Numbering ledger schema: V2 has table NfeNumeroReserva with states RESERVADO/REJEITADO/EM_TRANSMISSAO/INCERTO/BLOQUEADO/ABANDONADO/… The tests design has NfeNumeroFiscal plus NfeEmissaoTentativa with REJEITADO_REUSAVEL/LIBERADO/CONFLITO, a different partial-unique set, and a 'LIBERADO' release policy that V2 does not have (user decision 3).
- Double-click/lost claim response: V2 case 9 says the loser returns emAndamento without throwing (HTTP 200). Tests design expects 409. Devolução frontend expects 409 EMISSAO_EM_ANDAMENTO or legacy 500.
- Frontend: two different `interpretarRespostaEmissao` (nfe-numeracao-ui.ts and nfe-devolucao.ts, different unions) and two replacement emit handlers in nfe-wizard.tsx. Numbering uses emEnvioRef gated by the payload having `numeracao`; devolução uses handleEmitirV2 gated by NEXT_PUBLIC_NFE_EMISSAO_GUARD_ENABLED plus polling.
- NfeDraftResponse.numeracao shape: V2 has {numero, serie, ambiente, companyFiscalConfigId, estado, reutilizavel}; the devolução frontend expects {reaproveitara, serie, numero}. The Focus design adds origemRejeicao and ORs reaproveitavel with outcome events.
- NfeRepository.findEmitted gets three independent additions: V2 adds a NfeNumeroReserva query plus `numeracao`, devolução adds a finalidade filter plus hasXmlAutorizado, Focus B2 adds an audit-log query that ORs reaproveitavel.
- Audit event vocabularies differ for the same facts. Divergent Focus number: NUMERACAO_DIVERGENTE_FOCUS (V2), NUMERO_DIVERGENTE (Focus design), NUMERO_DIVERGENTE_COLISAO (tests). Never sent: ENVIO_NAO_REGISTRADO (V2) vs NAO_ENVIADA (Focus).
- Devolução contract between frontend and backend: routes (/draft/:draftId/devolucao… vs /:id/devolucao…), creation body ({} vs devolvidaAposEntrega/escopo/itens), idempotency (200 reused vs 409 DEVOLUCAO_RASCUNHO_EXISTENTE), eligible originals (55+65 vs 55 only), COMPRA_SAIDA (blocked in UI vs manual XML/chave endpoints in backend), item body (nItemOriginal vs chaveAcesso+nItem+tributacao).
- NfeDevolucaoItem indexes: the backend has (userId, chaveAcessoOriginal, nItemOriginal) and unique (devolucaoNfeId, chaveAcessoOriginal, nItemOriginal); the tests design indexes (originalNfeId, nItemOriginal).
MISSING:
- A single cStat/Focus outcome classifier shared by V2, Focus hardening and listing. It must handle 635 as in-flight, send 204/539/562/613 through a consult by chave, and treat Focus 'denegado' and unknown 422 codes conservatively.
- Denegada as a terminal fiscal state outside V2: keep numero, chave and nProt, forbid re-emit and delete of the row, and exclude the number from inutilização suggestions.
- Focus hardening needs a maturity rule (≥120 s since POST) before 'not found' counts as proof. Rows stay SENDING and cannot be deleted until then.
- Block draft edits and delete while the last outcome is uncertain (ENVIO_INCERTO / NAO_ENVIADA{confirmado:false}), and rebuild items from the authorized XML when authorization is found late.
- Advance the sequence on Focus read-back in every numbering mode, with an atomic GREATEST update (no read-then-write through ajustarProximoNumero).
- Devolução hooks must be integrated into the numbering V2 orchestrator (balance lock in the reservation transaction, context applied before digest/hash).
- Devolução needs a per-config allowlist and a PRODUCAO start-date guard (05/10/2026). Emission must be refused at runtime unless the numbering fixes (V2 or A1+A2 plus REJECTED-preserving edits) are active.
- Devolução needs an ICMS group tag mapping (ICMSSN102/ICMSSN202/ICMS40) plus golden XML tests per supported CST/CSOSN group.
- Devolução needs a frontend tributação review/confirmation UI matching backend D15/requerRevisao.
- Refuse cancelling an original with authorized or in-flight devoluções, under the same advisory lock as the devolução claim.
- Per-UF validation of responsável técnico and CSRT (PR production CSRT, UFs requiring infRespTec), plus a diagnostic of SEFAZ-direct PR tenants resolving to the env RT without CSRT.
- Devolução of Focus-authorized originals: re-fetch the authorized XML by ref when xmlAutorizadoPath is missing, and always use the real nNF/série from the XML or chave in references and texts.
- Decide whether NFC-e (65) originals and COMPRA_SAIDA are in v1, and make frontend eligibility match backend.
- Confirm the alphanumeric CNPJ timeline for chave de acesso and adapt chave validation and check digit if it applies.

# REVIEW regression

[blocker] Cross-design / emission pipeline (V2 orchestrator vs V1-integrated features)
PROBLEM: With V2 on, `emit()` sends allowlisted users to `nfe-emissao-v2.orchestrator.ts` and lines 92–564 never run (numbering §4.21 #1). Three other designs attach their behaviour inside exactly those V1 lines:
- **Devolução:** `validarDevolucao` before the claim, `claimComSaldo` in place of the claim, `calcularTributosDevolucao`, `aplicarContextoDevolucao` before the payload, and the post-authorization hook.
- **Per-company RT (C1):** resolver before the claim, and `sefazPayload.respTec` / builder `opts.respTec`.
- **Focus A1/B1/B2/B3:** single-update `handleRejected`, `emitirV2` classification, `handleNaoEnviada`, consult-before-resend, `numero` vs `numero_nota`, and nNF write-back.

For any V2-allowlisted tenant these features silently disappear:
- A devolução is built with regime-default taxes and no `DFeReferenciado`, and never takes the saldo lock.
- A company-level RT (PERSONALIZADO/NENHUM) is ignored, because V2's `prepararEmissao` is not specified to read `payload.respTec`, so the global env RT is sent (974/972).
- Focus runs through a second client.
EVIDENCE: - `app/usecases/nfe-emission.usecase.ts:91-564` is the only emit body.
- Devolução design §4.2 inserts at `:129`, `:147-155`, `:195-199`, `:290` and `handleAuthorized` `:789`.
- Focus design §3.4 edits `:111-129`, `:226-283`, `:295-362`, `:457-556`, `:1051-1084`.
- RT reaches SEFAZ only through the provider build at `app/fiscal/providers/sefaz-direct.provider.ts:188-198` (`respTec: resolveRespTecFromEnv()` at `:197`).
- The numbering design adds separate `prepararEmissao`/`transmitirPreparada` methods, and its `calculo-emissao.ts` is "equivalent to usecase:163-193" (regime defaults).
FIX: Define one emission pipeline with explicit extension hooks and make both V1 and V2 call them:
- `preClaimValidators[]` (devolução D-rules, RT resolver)
- `claimStrategy` (plain `updateMany` vs `claimComSaldo`)
- `taxCalculator` (regime vs devolução)
- `payloadDecorators` (devolução context, RT, Focus `numero`)
- `postAuthorizationHooks`

Until that exists, add a hard guard: V2 refuses (falls back to V1) when `draft.finalidade === 'DEVOLUCAO'` or when the config has a non-PADRAO `CompanyFiscalRespTec` row. Also add a combined-flag test (V2 + devolução, V2 + C1) asserting `claimComSaldo` and the RT decorator run.

[blocker] Devolução frontend ↔ backend contract and flag names
PROBLEM: The two devolução designs specify incompatible APIs and flags, so the feature cannot work as designed and the rollout order is unsafe.

API mismatches:
- **Creation body:** the frontend POSTs `{}` to `POST /fiscal/nfe/:originalId/devolucao` and expects `{draftId, reused}` (idempotent: returns the open draft). The backend rejects any body without `devolvidaAposEntrega === true` with 422 `RECUSA_NAO_E_DEVOLUCAO`, answers an open draft with 409 `DEVOLUCAO_RASCUNHO_EXISTENTE` unless `forcarNovo`, and returns `{draft, devolucao}`.
- **Routes:** the frontend needs routes C/D/E/F (`GET/PUT/DELETE /fiscal/nfe/draft/:id/devolucao`, `POST .../referencia {chave}`) keyed by `nItemOriginal`. The backend offers `GET /fiscal/nfe/:id/devolucao`, `PUT /fiscal/nfe/:id/devolucao/itens {chaveAcesso,nItem,...}` and `PUT /fiscal/nfe/:id/devolucao`. It has no convert-by-chave route and no revert route.
- **Scope:** the frontend enables NFC-e 65 originals; the backend has `MODELOS_ORIGINAIS_PERMITIDOS=['55']`.

Flag mismatch: the frontend says the backend reads `NEXT_PUBLIC_NFE_DEVOLUCAO_ENABLED` at call time. The backend design deliberately uses `NFE_DEVOLUCAO_ENABLED`, because with a shared `.env` the front build flag would turn the API on at the next pm2 restart, possibly before the DDL.
EVIDENCE: - The API reads the same `/var/www/dexo/.env` as Next (`ecosystem.config.cjs` header comment: API imports `dotenv/config`, Next loads `.env` natively).
- `findDraftById` only serves DRAFT/REJECTED (`app/repositories/nfe.repository.ts:321-323`).
- The 3 prod REJECTED devolução rows would enter the frontend `DEVOLUCAO_LEGADA` mode, which needs route D. The backend has no route D, and its D02 blocks unmanaged devolução emission.
FIX: Freeze one OpenAPI-style contract before implementation:
- Choose `devolvidaAposEntrega` either in the creation body (with the frontend asking before POST) or in the PUT, not both.
- Make creation idempotent (return the open draft with 200) or have the UI handle 409.
- Add or drop routes D/F explicitly.
- Align the modelo 65 scope.
- Keep separate names: `NFE_DEVOLUCAO_ENABLED` for the API and `NEXT_PUBLIC_NFE_DEVOLUCAO_ENABLED` for the UI only.

Add a contract test that imports the backend route schemas and the frontend `nfe-devolucao-api.ts` payload builders.

[major] Signature conflicts in NfeEmissionUseCase
PROBLEM: Three designs claim the same optional positional parameters with different types:
- **`emit`:** numbering adds `emit(userId, nfeId, opts?: EmitOpts)` (route reads `body.confirmarDescarteNumero`; `finance.usecase.ts:1910` passes opts). Devolução adds `emit(userId, nfeId, actorUserId?: string)` and the route passes `user.id`.
- **`handleAuthorized` (currently 10 params):** numbering adds an 11th optional param, devolução adds `(devCtx, actorUserId)` as 11th/12th, and Focus B1 adds `extras` as 11th.

Merged naively, `user.id` would be read as `EmitOpts`, or `devCtx` as Focus `extras`; `(prisma as any)` casts hide it from tsc.
EVIDENCE: - `app/usecases/nfe-emission.usecase.ts:91` (`emit(userId: string, nfeId: string)`) and `:789-800` (`handleAuthorized`, 10 params).
- `app/routes/fiscal.routes.ts:939` (`nfeEmission.emit(userId, id)`).
- `app/usecases/finance.usecase.ts:1910`.
FIX: Use one options object: `emit(userId, nfeId, opts?: { actorUserId?; confirmarDescarteNumero?; ... })` and `handleAuthorized(ctx: AuthorizedCtx)` built from a single context object. Add a tsc-level test (a typed call with each option) so positional drift cannot compile.

[major] Rollout: flag ON before DDL (blast radius beyond emit)
PROBLEM: The only test covering a flag turned on before its DDL is R-2, and it covers `emit` only. Other flag-gated reads and writes hit the new tables unguarded:
- **Numbering V2:** `nfeDraft.getById` attach, `findEmitted` extra raw query on `"NfeNumeroReserva"`, and the cancel/inutilização/delete branches. A missing relation gives GET draft 500 (wizard cannot open), list 500 for the allowlisted tenant, and possibly an exception after the provider cancel succeeded (SEFAZ cancelled, row still AUTHORIZED) if `marcarCancelado` runs before the row update.
- **C1 is a global flag** and reads `CompanyFiscalRespTec` before the claim on every emission, so every NF-e and PDV NFC-e for every tenant fails until the flag is reverted.
- **Devolução API flag:** `NfeDraftUseCase.update` for finalidade DEVOLUCAO rows queries the header table, so autosave 500s are swallowed silently by the wizard.
EVIDENCE: - Numbering §4.20: `findEmitted` runs `SELECT ... FROM "NfeNumeroReserva"`. §4.21 #7 lists getById, delete, inutilização, cancel and findEmitted as V2-gated.
- Focus design §3.4.1 calls `respTecRepo.findByConfigId(config.id)` whenever `isRespTecPorEmpresaEnabled()`.
- The wizard save is silent: `app/notas-fiscais/hooks/use-nfe-draft.ts:115-128`.
- PDV emission: `app/usecases/finance.usecase.ts:1910`.
FIX: In every gated read path, catch Postgres 42P01 / Prisma P2021:
- getById/findEmitted: omit `numeracao` (V1 UI).
- cancel: do the ledger mark best-effort after the row update to CANCELLED.
- RT: fail only allowlisted configs.

Make C1 per-config allowlisted (fail-closed), like the other flags. Add a `to_regclass` preflight log at API start. Add specs with `v2DdlApplied=false` for getById, findEmitted, cancel, inutilização, delete and draft update.

[major] Focus flags have no canary scope (A1/A2/B1/B2/C1 global)
PROBLEM: The Focus design reads `NFE_FOCUS_HARDENING_ENABLED`, `NFE_REUSO_NAO_ENVIADA_ENABLED` and `NFE_RESP_TEC_POR_EMPRESA_ENABLED` as plain `=== 'true'`. B1 also force-enables A1+A2 for every tenant and every provider. Turning B1 on for Kiko therefore:
- changes the reuse policy (`shouldReuseNumero`, `reaproveitavel` in list/banner) for all SEFAZ-direct PRODUCAO tenants;
- adds 30 s POST timeouts plus a 40 s reconciliation budget to every Focus emission, including PDV NFC-e and the two shared-token tenant groups.

The tests/rollout design assumes `_CONFIG_IDS` allowlists for these same features; numbering uses a per-userId allowlist.
EVIDENCE: - Focus design §2.2 `nfe-flags.ts`: `isNfeCStatClassificacaoV2Enabled = ... || isFocusHardeningEnabled()`.
- Reuse affects `app/repositories/nfe.repository.ts:93-95` and `:751-757`, and `app/fiscal/domain/nfe-number-reuse.ts:51-62`, for all tenants.
- Tests design §0 lists `NFE_FOCUS_HARDENING_ENABLED + _CONFIG_IDS` and `NFE_RESP_TEC_EMPRESA_ENABLED + _CONFIG_IDS`.
FIX: Adopt the single `isFiscalFeatureOn(feature, configId, env)` resolver (fail-closed allowlist) for every new backend flag, including A1/A2/B1/B2/C1 and V2. Decide one allowlist dimension: configId is better, because a per-user allowlist also silently covers a tenant's future PRODUCAO configs. Remove the implicit B1→A1/A2 global coupling; make it per-config.

[major] Focus Dexo numbering without V2 creates real SEFAZ gaps
PROBLEM: B3 (`NFE_FOCUS_NUMERACAO_DEXO_ENABLED` + `_EMPRESAS`) only requires B1. Today Focus ignores `numero_nota` and auto-numbers, so Dexo's renumbering after R1/R5 does not create real nNF gaps at SEFAZ.

With B3 on and V2 off:
- **R1:** every edit after a SEFAZ rejection makes the draft DRAFT and a new Dexo number, and that number is now sent to SEFAZ. B2 covers only `NAO_ENVIADA`/`REJEITADA_PROVEDOR`, not `REJEITADA_SEFAZ`.
- **R5 when B2 is off:** the same.
- **B1 without B2:** an INCERTA→NAO_CONSTA→REJECTED retry skips the consult (`precisaConsultaPrevia` is computed only inside the B2 branch) and reserves a new number.

Each case burns a real nNF that needs inutilização. This is a regression the flag introduces. The tests design says Focus Dexo numbering only takes effect with V2, and V2 has its own `NFE_NUMERACAO_V2_FOCUS_ENABLED`: three flags for one behaviour.
EVIDENCE: - `app/fiscal/generators/nfe-xml-builder.service.ts:56` (`numero_nota`).
- `app/repositories/nfe.repository.ts:379-381` (forces DRAFT).
- `app/fiscal/domain/nfe-number-reuse.ts:56` (status must be REJECTED).
- `app/usecases/nfe-emission.usecase.ts:551-556` (catch sets DRAFT).
- Focus design §3.4.2 `decidirReusoPorDesfecho` only accepts `NAO_ENVIADA` or `REJEITADA` with `REJEITADA_PROVEDOR`.
FIX: Delete B3 and keep Dexo-controlled Focus numbering only inside V2 (`NFE_NUMERACAO_V2_FOCUS_ENABLED`). If B3 is kept, gate it as `B3 && B2 && isNumeracaoV2ParaConfig(configId)`, and add a test for reported scenario (b) through Focus with B3 on and V2 off, asserting no second nNF.

[major] Rollback of Dexo-controlled Focus numbering is not instant or safe
PROBLEM: Once `numero`+`serie` have been sent to Focus (V2 Focus sub-flag or B3), turning the flag off reverts the builder to `numero_nota`, so Focus auto-numbering resumes from Focus's internal counter. The designs do not know whether that counter advanced past the explicitly sent numbers. If it did not, the next V1 emission reuses an authorized nNF and gets 539 rejections (or 204); if it did, gaps appear.

V2 also authorizes renumbered Focus notes under ref `${nfeId}-n…`, which V1 cancel (ref `nfeId`) and B1 `consultar(nfeId)` cannot find: a 404 there is read as NAO_CONSTA.

The numbering rollback section calls the flag-off 'instant' and treats only the cancel case as a caveat.
EVIDENCE: - `app/usecases/nfe-cancelamento.usecase.ts:117-123` (`ref: nfeId`).
- `app/fiscal/providers/focus-nfe.provider.ts:137-156` (consult by ref).
- Numbering §4.24 step 8 ("Turn the flag off (instant)").
- Focus design §3.1 consult table maps 404 to `NAO_CONSTA`.
- The Focus `numero` + auto-numbering interaction is listed as unconfirmed.
FIX: Treat Dexo-controlled Focus numbering as one-way per config:
- After first use, keep sending `numero` from the Dexo counter even when V2 is off (a separate sticky per-config setting, not the canary flag).
- Add Focus homologação check (f): post an explicit `numero` N, then omit `numero`, and verify the next auto number is > N.
- Persist the Focus ref per authorized note (V2 ledger/attempt) and make V1 cancel and B1 consult resolve the ref from there, falling back to nfeId.

[major] Counter moved backwards by the Focus write-back (B1)
PROBLEM: `gravarNumeracaoReal` calls `consultarProximoNumero` and then `ajustarProximoNumero`. Neither runs in the reservation transaction, and `ajustarProximoNumero` does an unlocked read-then-`update`.

Race:
1. The write-back reads next=12.
2. Two concurrent `reservarPorEmitente` calls (`FOR UPDATE`) hand out 12 and 13 and commit next=14.
3. The write-back then sets `proximoNumero=13`.

The counter has gone backwards and 13 is issued twice, violating 'no numero--' and 'concurrency ⇒ distinct numbers'. The design claims 'the sequence only ever moves forward'.
EVIDENCE: - `app/fiscal/sequence/nfe-sequence.service.ts:264-286`: `findFirst`, then `update { proximoNumero: novoNumero }`, no lock, no `GREATEST`.
- The reservation locks at `:143-176`.
- The same pattern is already in `app/usecases/nfe-inutilizacao.usecase.ts:173-190`; that is pre-existing in V1, but B1 puts it on the emission hot path.
FIX: Use an atomic monotonic bump in the numbering layer:

`UPDATE "NfeSequence" SET "proximoNumero" = GREATEST("proximoNumero", $n), "updatedAt"=NOW() WHERE <same emitter where incl. legacy-NULL adoption>`

Alternatively, run it inside the same `SELECT ... FOR UPDATE` transaction. Leave `NfeSequenceService` untouched per the tests design and add a new method. Add PG test P9b: write-back interleaved with 20 reservations never lowers the counter.

[major] V2 Focus nNF write-back collides after authorization
PROBLEM: The V2 guard test writes the row numero to the chave's nNF before `handleAuthorized` ("nNF 3 against reserved 12 sets row numero 3"), but no P2002 path is specified. Kiko's homologação série 3 already has legacy rows holding DB numero 1..14 (REJECTED/SENDING/AUTHORIZED 12/13/14). In the first canary, if Focus does not honour `numero` (still unconfirmed), writing numero 6 violates `(cfc, ambiente, serie, numero, modelo) WHERE numero>0`. The throw happens after SEFAZ authorized, so the note stays SENDING/ENVIO_INCERTO while it is actually authorized.
EVIDENCE: - Partial unique index documented at `prisma/schema.prisma:1883-1889`.
- Post-send catch keeps SENDING and writes ENVIO_INCERTO: `app/usecases/nfe-emission.usecase.ts:557-561`.
- The numbering guard list in §4.23 has no collision case; the tests design case 8 does (`NUMERO_DIVERGENTE_COLISAO`, still AUTHORIZED); Focus B1 §3.4.8 handles `conflito`.
FIX: In the orchestrator's authorized path:
- Catch P2002 on the numero write, keep the reserved numero on the row, set AUTHORIZED, and write an audit `NUMERACAO_DIVERGENTE_FOCUS {conflito:true}`.
- Mark the ledger for review (BLOQUEADO or CONFLITO) and never rethrow.
- Order the writes as: status AUTHORIZED + chave + protocolo first, then the best-effort numero write.
- Add this case to `emissao-v2-guardas.spec.ts`.

[major] Devolução draft placeholder numero formula
PROBLEM: Devolução §3.7 says the placeholder is "`-(count DRAFT)+1`, the same formula as `:242-257`". The code is `-(draftCount + 1)`. As written, the first draft gets numero **+1**, which is positive and has a `companyFiscalConfigId`, so it enters the partial unique index. Either `create` fails with P2002 against an authorized nº1, or the draft squats nº1 so a later reservation of 1 fails at `emit :262` (P2002, catch sets DRAFT, number burned).
EVIDENCE: - `app/repositories/nfe.repository.ts:242-257` (`numero: -(draftCount + 1)`).
- Unique partial WHERE `numero > 0`: `prisma/schema.prisma:1886-1888`.
FIX: Call `nfeRepo.createDraft`'s formula literally (`-(count+1)`), or better, extract it into a shared helper used by both `createDraft` and `criarRascunho`. Add a unit test asserting the placeholder is `< 0` for count 0 and 1.

[major] Numbering V2 UI never engages for new or reused drafts
PROBLEM: V2 UI is detected only through `numeracao` attached by `nfeDraft.getById`. The wizard's normal entry ("Nova NF-e") calls `POST /fiscal/nfe/draft`, which returns `findExistingDraft`/`createDraft` without `numeracao`, so `usaNumeracaoV2` is false:
- The legacy `handleEmitir` keeps the double-click window.
- A V2 409 `NUMERACAO_CONFIRMAR_DESCARTE` (key change on a reused draft holding a RESERVADO PROD number) surfaces as a generic error toast, with no way to confirm.

A reused DRAFT can hold a V2 reservation (case 1 leaves the row DRAFT with RESERVADO 101).
EVIDENCE: - `app/notas-fiscais/components/nfe-wizard.tsx:202-210` (create path; only `setValue('serie')`).
- `:457-505` (`handleEmitir` sets `isEmitting` after `await`).
- `app/routes/fiscal.routes.ts:676-694`.
- `app/usecases/nfe-draft.usecase.ts:123-137`.
- Only `getById` (`:483-492`) is designed to attach.
FIX: Attach `numeracao` in every draft-returning endpoint (POST/PUT draft, via a single `attachNumeracao()` in the use case), or have the wizard `loadDraft(newDraft.id)` after create when V2 is detected. Apply the ref-based double-click guard unconditionally: it is behaviour-neutral for the single-click path.

[major] V2 list hides the existing 'Tentar novamente' button (flag-on regression)
PROBLEM: For V2-allowlisted tenants, `findEmitted` attaches `numeracao` (null when there is no live reservation) to every row, and the list then takes its actions only from `acaoListaNumeracao`, which returns null for `numeracao` null. Affected rows:
- legacy REJECTED rows that are `reaproveitavel` today;
- all V1-managed rows (NFC-e 65 while `MODELOS=55`, Focus without the sub-flag).

These lose the current retry button and become reachable only by typing a `?draft=` URL. Decision 3 forbade a *new* reconcile button for legacy rows, not the removal of the existing retry. It also makes V2's legacy adoption (`decidirAdocaoLegado`) unreachable from the UI.
EVIDENCE: - `app/notas-fiscais/components/nfe-list.tsx:784-807` (retry shown when `REEMISSAO_REJEITADA_ENABLED && status==='REJECTED' && reaproveitavel`).
- Numbering §4.20: "When `nota.numeracao !== undefined`, the actions come from `acaoListaNumeracao` ... numeracao null/undefined ⇒ null".
- `app/repositories/nfe.repository.ts:753-757`.
FIX: In `acaoListaNumeracao`, fall back to the legacy rule when `numeracao === null` (return `TENTAR_NOVAMENTE_LEGADO` iff `status==='REJECTED' && reaproveitavel`). Alternatively, attach `numeracao` only for rows in V2 scope (modelo in `MODELOS`, provider in scope). Add a test for the legacy-row fallback.

[major] V2 dispatch spec is unsatisfiable as written
PROBLEM: §4.21 #1 claims one synchronous env read in `emit()` with lines 92–564 unchanged when it is false. The flag-off spec then requires, with V2 on for the user, that "modelo 65 with default modelos" and "Focus without the sub-flag" never construct the orchestrator. Both conditions need the draft (`modelo`) and the config (`providerName`), which are loaded inside lines 93-121.

At the same time V2 cases 4 and 7 need `/issue` to handle AUTHORIZED and SENDING rows, which `findDraftById` rejects with "Rascunho nao encontrado" (404). So V2 must load the row itself and then fall back to V1, which double-loads and constructs the orchestrator.
EVIDENCE: - `app/usecases/nfe-emission.usecase.ts:93-100` (only DRAFT/REJECTED), `:104` (modelo), `:111-121` (provider).
- `app/repositories/nfe.repository.ts:321-323`.
- Numbering §4.23 `flag-off-regressao.spec.ts` bullet and cases 4 and 7.
FIX: Specify the dispatch precisely:
1. `if (!isNumeracaoV2ParaUsuario(userId)) return this.v1(...)`.
2. Otherwise run a minimal `findFirst` select (`status`, `modelo`, `companyFiscalConfigId`) plus `providerName`.
3. If out of scope, call `this.v1(...)`.

Rewrite the regression spec to assert V1 arguments and outcomes (not "never constructed") for allowlisted-but-out-of-scope cases, and keep "never constructed" only for users not on the allowlist.

[major] Two cStat classifiers and two sources of truth for 'reusable number'
PROBLEM: The designs ship parallel, disagreeing implementations.

Classifiers:
- **Numbering:** `app/fiscal/numeracao/classificacao.ts` (`normalizarCStat`, `classificarEnvioSefaz`, `classificarPostFocus`, `classificarGetFocus`).
- **Focus:** `app/fiscal/domain/cstat.ts` (`normalizeCStat`, `classificarCStatV2`), plus `focus-response.ts`, plus audit-log-based `nfe-reuso-desfecho.ts`.

Disagreements:
- 539: A2 says duplicidade, not reusable; V2 says AUTORIZADO if the chave is ours.
- 217: A2 `nao_consta`, not reusable; V2 treats a mature proof as RESERVADO.
- 656: A2 reusable; V2 cooldown.
- 108/109: A2 reusable.

State and event names diverge (`NAO_ENVIADA` vs `ENVIO_NAO_REGISTRADO`, `NUMERO_DIVERGENTE` vs `NUMERACAO_DIVERGENTE_FOCUS`). If the B-series ships first, rows it writes (REJECTED, `cStatRejeicao` null, audit `NAO_ENVIADA`) lack the evidence V2 legacy adoption requires, so V2 renumbers them when enabled — the exact burn the user wants to eliminate.
EVIDENCE: - Numbering §4.22 new files.
- Focus design §2.1 and §3.4.2.
- Numbering `decidirAdocaoLegado` refuses ENVIO_INCERTO and "cStat 205" and requires evidence A/B.
- The `reaproveitavel` computation exists today at `app/repositories/nfe.repository.ts:93-95` and `:753-757`.
FIX: Keep one classifier module (numbering's `classificacao.ts`) and one normalizer; Focus A1/B1 must import it. Drop B2's audit-derived reuse in favour of the V2 ledger, or, if B2 must ship first, teach `decidirAdocaoLegado` to accept `NAO_ENVIADA`/`REJEITADA{desfecho}` evidence and add a test: "B2-written row adopted by V2 keeps its number". Unify the audit event names in one enum file.

[major] Combined flag-off identity checklist is invalid
PROBLEM: Numbering §4.21 #3/#4 declares these files unchanged, which the flag-off proof relies on:
- `focus-nfe.provider.ts`
- `nfe-xml-builder.service.ts`
- `nfe-xml-builder-sefaz.service.ts`
- `nfe-number-reuse.ts`
- `sefaz-direct.provider.ts` `emitir` (byte-identical)

The other designs change them:
- Focus A1/B1 edit `focus-nfe.provider.ts` object literals and add `emitirV2`.
- B2 changes SEFAZ `emitir` error returns.
- B3/C1 change the Focus builder.
- Devolução changes both builders and the parser (unflagged).
- Focus changes `shouldReuseNumero`'s signature and extends `nfe-emission-reuse.spec.ts` (tests design: "leave untouched").

The combined design has no single identity proof for these edits.
EVIDENCE: - `app/fiscal/providers/sefaz-direct.provider.ts:199-250` (the B2 target).
- `app/fiscal/generators/nfe-xml-builder.service.ts:41-57`, `:134-138`, `:172-211`.
- `app/fiscal/domain/nfe-number-reuse.ts:51-62`.
- Devolução §2.2 adds `ParsedIde` fields with no flag.
FIX: Make PR-0 a single characterization/golden commit covering:
- Focus payload, SEFAZ XML (SIMPLES/LP/65/frete/finalidade DEVOLUCAO without context), `emitir` results for build/sign/network errors, Focus HTTP legacy mapping;
- `shouldReuseNumero` over cStat 100..1100 × status;
- `parseNfeXml` deep-equal on existing fields.

Every design's PR must keep those goldens green with all flags unset. Replace the per-design "unchanged files" lists with that golden gate.

[major] V2 lease/maturity vs SEFAZ transport retries
PROBLEM: The V2 takeover and consult-before-resend (`provaMadura` 120 s, stale VALIDATING takeover, lease) are not tied to the transport's worst-case in-flight time. `SoapClientService` defaults:
- timeout 60 s;
- `retryMax` 3 (4 attempts);
- exponential backoff capped at 8 s;
- ETIMEDOUT/ECONNRESET/ENOTFOUND retries that re-POST the same envelope.

One `transmitirPreparada` call can therefore run about 4.5 min. A second request after the lease or after 120 s could consult (217, not yet processed), mark RESERVADO and resend while the first request is still retrying. The chave is the same so no double authorization results, but the two requests race on ledger and row state, and the first one's late result can overwrite the second's.
EVIDENCE: - `app/fiscal/sefaz/soap-client.service.ts:96-127` (retry loop) and `:207-238` (backoff cap 8000, timeout 60 000, `retryMax` 3).
- Emission creates the provider without overrides: `app/usecases/nfe-emission.usecase.ts:344-351`.
- Numbering §4.23 case 7 ("217 at ≥ 120 s: RESERVADO, then resend in the same request").
FIX: Derive the lease and `provaMadura` from `SEFAZ_TIMEOUT_MS × (SEFAZ_RETRY_MAX+1) + Σbackoff + poll budget`, or pass `retryMax: 0` and an explicit timeout to V2's transmit. Guard every post-transmit state write with `WHERE attemptId = $mine AND estado = 'EM_TRANSMISSAO'` so a superseded request cannot overwrite. Add a fake-timer test where the first request's response arrives after takeover.

[minor] Tests design static guard fails on unchanged HEAD
PROBLEM: `static-guards.spec.ts` bans `orderBy: { numero: "desc" }` in `nfe.repository.ts` and 14-digit CNPJ literals with a valid check digit in `app/fiscal/**`. HEAD already contains both (listing order, and a real tenant CNPJ in a doc comment), so the gate fails without touching existing code.
EVIDENCE: - `app/repositories/nfe.repository.ts:697` (`orderBy: { numero: "desc" }` in `findEmitted`).
- `app/fiscal/certificate/certificate-loader.service.ts:173` (CNPJ in the comment example).
FIX: Scope the numero guard to numbering-path files (`app/fiscal/numeracao/**`, `nfe-emissao-v2.orchestrator.ts`, sequence services). For CNPJ, scan string literals via the TS AST (not comments) and allowlist the existing comment, or fix the comment in a separate PR.

[minor] DDL applied on hot table without lock_timeout
PROBLEM: The devolução DDL runs `ALTER TABLE ... ADD CONSTRAINT ... REFERENCES "NfeEmitida"` inside BEGIN in the Supabase editor. Adding an FK takes SHARE ROW EXCLUSIVE on `NfeEmitida`, so it waits behind in-flight emission transactions (`persistCalculo`, `claimComSaldo`, `updateDraft` item swaps) and blocks every writer queued behind it for as long as it waits.
EVIDENCE: - Devolução §1.2 (two FKs to `NfeEmitida`).
- Precedent for guarding this: `prisma/ddl/2026-08-21-product-listing-image-urls-override-idx.sql:199` (`SET LOCAL lock_timeout = '5s'`).
- Interactive transactions on `NfeEmitida`: `app/repositories/nfe.repository.ts:427-443`, `:458-476`.
FIX: Add `SET LOCAL lock_timeout = '5s';` after BEGIN in the devolução DDL (and the numbering/RT DDL if they reference hot tables). Optionally add FKs `NOT VALID` and then `VALIDATE CONSTRAINT`; the tables are empty, so validation is instant.

[minor] Read-only diagnostic scripts
PROBLEM: `diagnostico-focus-resptec.ts`:
- Selects `providerToken` into process memory to sha256 it, contradicting the tests design's "never selects providerToken".
- Catches P2021 (table missing) inside a `SET TRANSACTION READ ONLY` interactive transaction. After a server-side error Postgres aborts the transaction (25P02), so sections 5+ fail.

There are also two diagnostic scripts with overlapping numbering sections.
EVIDENCE: - Focus design §7 (sections 1-5 in one `$transaction`; "if the table exists (P2021 caught)").
- Tests design §6.4 ("Never selects providerToken").
FIX: Compute `left(md5("providerToken"),8)` in SQL. Check `to_regclass('"CompanyFiscalRespTec"')` before querying instead of catching. Merge the numbering sections into the single `scripts/fiscal/diagnostico-numeracao-nfe.ts`.

[minor] Numbering frontend references a non-existent delete UI
PROBLEM: §4.20 says the draft delete action handles 409 `NUMERACAO_CONFIRMAR_DESCARTE` with `?descartarNumero=true`. No component calls `DELETE /fiscal/nfe/draft/:id`: the hook exists but is unused, and the list excludes DRAFT rows. The confirmation flow therefore has no UI, so PROD numbers held by abandoned drafts can only be discarded through the API.
EVIDENCE: - `app/notas-fiscais/hooks/use-nfe-draft.ts:143-155` (`deleteDraft`).
- `app/notas-fiscais/components/nfe-wizard.tsx:130` destructures without `deleteDraft`.
- `app/repositories/nfe.repository.ts:641-644` (`status: { not: 'DRAFT' }`).
FIX: Either drop the UI bullet or design the entry point explicitly (for example a 'Descartar rascunho' action in the wizard behind V2 detection).

[minor] SystemLog labels and the multipart rationale
PROBLEM: Devolução justifies multipart for the manual XML route to keep XML out of SystemLog, but `/fiscal` POSTs are logged only for `/nfe/emission`, `/nfe/draft` and `/nfe/inutilizacao`, so `/fiscal/nfe/devolucao/manual*` is not logged at all. Conversely:
- Frontend route D (`POST /fiscal/nfe/draft/:id/devolucao/referencia`) is logged as `CREATE_NFE_DRAFT`.
- Route F (`DELETE /fiscal/nfe/draft/:id/devolucao`) and numbering's `DELETE ?descartarNumero` are logged as `CANCEL_NFE`.
EVIDENCE: - `app/middlewares/logging.middleware.ts:154-176`.
FIX: Keep multipart if desired, but correct the rationale. Add explicit `determineActionType` branches for the new routes (tested, like existing ones) so forensic queries by `details.url` stay reliable.

[minor] Stats with devolução enabled
PROBLEM: The `getStats` `valorTotal` sums `totalNota` of every AUTHORIZED note regardless of finalidade or tipo. Once devoluções (ENTRADA, finNFe 4) are authorized, the revenue card increases by the returned amount instead of decreasing. The design argues nothing changes because prod has no authorized devolução yet, but the feature introduces the distortion as soon as it is used.
EVIDENCE: - `app/repositories/nfe.repository.ts:804-810` (`WHERE status='AUTHORIZED'`, no finalidade/tipo filter).
FIX: Document the behaviour. Behind the devolução flag, either exclude `finalidade='DEVOLUCAO'` from `valorTotal` or add a separate `valorDevolvido` card, and confirm the choice with the user.

[minor] Rollout smoke tests and PDV auto-confirm
PROBLEM: Two rollout risks in the numbering design:
- Step 2 says to smoke-test "issue, cancel, CC-e, inutilização" after deploy, without restricting it to homologação configs. Inutilização and cancel in PRODUCAO are irreversible.
- `finance.usecase.ts` would pass `{confirmarDescarteNumero:true}` automatically on a PDV emitter switch. Once `MODELOS=55,65`, this abandons PROD NFC-e numbers (requiring inutilização) with no human confirmation.
EVIDENCE: - Numbering §4.24 step 2 and §4.21 #8.
- The PDV emitter switch is in `app/usecases/finance.usecase.ts` (the `companyFiscalConfigId !== existing.companyFiscalConfigId` branch just before `:1910`).
FIX: Restrict post-deploy smoke tests to homologação configs (as the tests design §5.1 does). For the PDV, return a 409 to the PDV UI and require explicit confirmation, or keep modelo 65 out of V2 until a PDV confirmation UX exists.

[minor] Rollback of V2-classified denied/inutilized rows
PROBLEM: After a V2 rollback, REJECTED rows that V2 classified DENEGADO (301/302/303/110) or INUTILIZADO (206) fall back to V1 `shouldReuseNumero`. V1's `lookupCStat` classes 205/206/301-303 as "rejeitada", so V1 re-sends the consumed number. SEFAZ rejects each attempt, so the user is stuck in a rejection loop (no double authorization).
EVIDENCE: - `app/fiscal/domain/nfe-number-reuse.ts:51-62` (reuse iff `lookupCStat(...).categoria==='rejeitada'`).
- Established fact: `lookupCStat` maps 200–599 as rejeitada, including 205/206/301-303.
FIX: When V2 records DENEGADO/INUTILIZADO, write `cStatRejeicao` so V1 also refuses reuse (for example keep it null, which V1 treats as non-reusable). Add a rollback test for it.

[minor] Secret in the SEFAZ snapshot persists under V2
PROBLEM: `redactConfig` strips only `certificadoSenhaEnc` and `providerToken`. The CSC (`cscToken`) is written into the SEFAZ-direct `xmlOriginal` JSON and can be downloaded through `/nfe/:id/xml` whenever no authorized XML exists. V2's new snapshot and attempt storage would keep writing it.
EVIDENCE: - `app/usecases/nfe-emission.usecase.ts:307-316` and `:1218-1224`.
- `app/routes/fiscal.routes.ts:1174` (falls back to `xmlOriginalPath`).
FIX: In every new V2 snapshot writer, also strip `cscToken` (and future `csrtEnc`/`respTec`), and add a sentinel test (tests design invariant I7 already covers the sink). The V1 fix can be a separate flagged task.

CONFLICTS:
- The V2 orchestrator replaces V1 `emit` wholesale, but the devolução backend (pre-claim validation, `claimComSaldo`, devolução taxes, XML context), per-company RT (C1 resolver and `payload.respTec`) and Focus A1/B1/B2/B3 are all integrated inside the V1 body (`nfe-emission.usecase.ts:92-564`). With V2 on, those features are silently bypassed.
- Third positional parameter of `emit`: numbering wants `opts: EmitOpts` (`confirmarDescarteNumero`), devolução wants `actorUserId: string`. Trailing parameter of `handleAuthorized`: numbering adds one optional param, devolução adds `(devCtx, actorUserId)`, Focus B1 adds `extras`.
- Dexo-controlled Focus numbering has three flags: numbering `NFE_NUMERACAO_V2_FOCUS_ENABLED`, Focus design `NFE_FOCUS_NUMERACAO_DEXO_ENABLED` + `NFE_FOCUS_NUMERACAO_DEXO_EMPRESAS` (requires only B1), and tests design `NFE_FOCUS_NUMERO_DEXO_ENABLED` + `_CONFIG_IDS` (effective only with V2).
- Allowlist dimension differs: numbering uses `NFE_NUMERACAO_V2_USER_IDS` (per tenant); Focus design flags are global (no allowlist); the tests design uses `_CONFIG_IDS` for every feature. RT flag name also differs: `NFE_RESP_TEC_POR_EMPRESA_ENABLED` vs `NFE_RESP_TEC_EMPRESA_ENABLED`.
- Devolução flag: the backend design requires `NFE_DEVOLUCAO_ENABLED` (API) separate from `NEXT_PUBLIC_NFE_DEVOLUCAO_ENABLED` (UI); the frontend design says the backend reads `NEXT_PUBLIC_NFE_DEVOLUCAO_ENABLED` at call time.
- Devolução API contract: the frontend expects `POST /nfe/:originalId/devolucao` with `{}` returning an idempotent `{draftId,reused}`, plus draft-scoped routes C/D/E/F keyed by `nItemOriginal`. The backend requires `devolvidaAposEntrega` in the body, returns 409 on an open draft, returns `{draft,devolucao}`, uses `/nfe/:id/devolucao(/itens)` keyed by `chaveAcesso`+`nItem`, and has no convert-by-chave or revert routes.
- Devolução scope: the frontend allows NFC-e 65 originals and blocks ENTRADA (devolução de compra); the backend allows only modelo 55 originals and supports COMPRA_SAIDA through manual XML or typed chave.
- The `numeracao` field on `NfeDraftResponse` has two shapes: numbering `{numero, serie, ambiente, companyFiscalConfigId, estado, reutilizavel}` detected by key presence; devolução frontend `{reaproveitara, serie, numero}`.
- `interpretarRespostaEmissao` is defined twice with different result unions (`nfe-numeracao-ui.ts` vs `nfe-devolucao.ts`). There are two double-click guards (`emEnvioRef` inside `handleEmitir` vs `emitLockRef` + `handleEmitirV2` behind `NEXT_PUBLIC_NFE_EMISSAO_GUARD_ENABLED`); numbering says no `NEXT_PUBLIC` flag is needed.
- Claim-loser HTTP contract: numbering V2 returns 200 `emAndamento` without throwing; the tests design expects 409; the devolução frontend expects 409 `code EMISSAO_EM_ANDAMENTO` (or the legacy 500 message).
- Focus ref strategy: numbering V2 uses per-number refs `${nfeId}-n…`; the Focus design keeps ref = nfeId, says a per-attempt ref is out of scope, and has B1 consult by nfeId, which returns 404 (read as NAO_CONSTA) for V2-authorized renumbered notes.
- Two Focus HTTP stacks: numbering `focus-nfe-v2.client.ts` (own classification and timeouts) vs Focus design `FocusNfeProvider.emitirV2`/`consultarV2` + `focus-response.ts` + `NFE_FOCUS_TIMEOUT_*`. Two reconciliation mechanisms: V2 lease + `consultar-situacao` endpoint vs B1 inline `reconciliarFocus` + `CONSULTA_PREVIA`.
- Two cStat normalizers and classifiers (`numeracao/classificacao.ts` vs `domain/cstat.ts`) disagree on 539, 217, 656 and 108/109. Two reuse sources of truth: V2 ledger states vs B2 audit-derived `decidirReusoPorDesfecho`. The same B2 rule would also be appended to V1 list/draft `reaproveitavel`.
- Audit event vocabularies diverge: `ENVIO_NAO_REGISTRADO` vs `NAO_ENVIADA`; `NUMERACAO_DIVERGENTE_FOCUS` vs `NUMERO_DIVERGENTE` vs `NUMERO_DIVERGENTE_COLISAO`. V2 legacy adoption does not recognize the B-series events.
- Ledger naming and states: numbering `NfeNumeroReserva` with RESERVADO/REJEITADO/EM_TRANSMISSAO/INCERTO/BLOQUEADO/ABANDONADO; tests design `NfeNumeroFiscal`/`NfeEmissaoTentativa` with REJEITADO_REUSAVEL/LIBERADO/CONFLITO.
- Nfe write-back: numbering V2 renumbers the row plus ABANDONADO plus counter forward, with no collision path. Focus B1 `gravarNumeracaoReal` uses the unlocked `ajustarProximoNumero` and handles P2002.
- Chave DV/normalization is implemented three times (`domain/devolucao/chave-acesso-dv.ts`, `domain/chave-acesso-dv.ts`, `domain/chave-acesso-formato.ts`), and devolução CFOP twice (`domain/devolucao/cfop-devolucao.ts` without MEI rules vs `domain/devolucao-cfop.ts` with MEI and DESTINO_DIVERGENTE handling).
- The numbering flag-off checklist lists `focus-nfe.provider.ts`, both builders, `nfe-number-reuse.ts` and `sefaz-direct` `emitir` as unchanged, but the Focus and devolução designs modify them. The tests design says to leave `nfe-emission-reuse.spec.ts` untouched; the Focus design extends it.
- `findEmitted` and `nfe-list.tsx` actions are edited by three designs: numbering replaces actions when `numeracao` is defined; devolução adds `hasXmlAutorizado`, a finalidade filter and a DropdownMenu; Focus B2 adds `companyFiscalConfigId` to the select plus an audit query.
- The Focus design ships diagnostic script `diagnostico-focus-resptec.ts`; numbering and tests use `diagnostico-numeracao-nfe.ts`. Their numbering sections overlap and their secret-handling rules differ.
MISSING:
- A single explicit numbering state machine across providers. The B-series adds a parallel audit-log-derived outcome model next to the V2 ledger, so 'reserved vs consumed' has two sources of truth.
- 'No numero--' and concurrency ⇒ distinct numbers: the Focus B1 write-back uses the unlocked read-then-update `ajustarProximoNumero`, which can move `proximoNumero` backwards under concurrent reservations.
- 'Switching Focus↔SEFAZ keeps sequence consistent' is not guaranteed in two cases. First, a V2-allowlisted tenant whose Focus path runs V1 because the sub-flag is off (Focus auto-numbering vs Dexo counter). Second, B3 enabled without V2 (R1 edits still renumber, now with real nNF gaps).
- Idempotency/double-click protection in the UI for drafts opened through POST /fiscal/nfe/draft, because V2 detection only happens via GET draft.
- Timeout/unknown ⇒ consult first, then reuse the same number: no requirement ties the V2 lease or maturity window to SEFAZ transport retry time (60 s × 4 attempts by default).
- 'Always write back the real nNF/série from the authorized chave, auditing divergence' (user decision 1): the V2 path has no specified P2002 collision handling after authorization.
- Per-company RT 'centralized in a resolver' (user decision 2) is not applied on the V2 emission path.
- Devolução 'serialize concurrent devoluções of the same original' and 'block over-return' are not enforced when V2 handles the emission (no `claimComSaldo`).
- The devolução UI must ask 'devolvida após entrega?': the frontend and backend contracts disagree on where this answer is sent, so creation fails with 422.
- Zero regression for allowlisted tenants: V2 removes the existing 'Tentar novamente' action for legacy and V1-managed REJECTED rows.
- A safe instant rollback for Dexo-controlled Focus numbering (Focus internal counter and per-number refs).
- Combined-flag tests: V2+devolução, V2+C1 RT, B3 without V2 (reported scenario b through Focus), B1 without B2.
- Flag-on-before-DDL degradation tests for getById, findEmitted, cancel, inutilização, delete, draft update and C1 emission.
- A PG race test showing the write-back never lowers the counter.
- A frontend↔backend devolução contract test.
- A single golden/characterization gate (PR-0) covering every file the four designs touch (Focus provider HTTP mapping, both builders, SEFAZ `emitir` error results, `shouldReuseNumero` truth table, parser), since the per-design 'unchanged files' lists contradict each other.

