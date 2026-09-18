# NF-e de devolução (finNFe=4), só fiscal: design de backend, dados e XML

Nada foi alterado: é só o design, e todo arquivo citado foi lido a partir do HEAD `1549bc4`.

## Resumo

Três achados no código mudam a forma que o pedido sugeria:

1. **Não dá para ligar a referência ao id do item.** `NfeItem.id` muda a cada gravação: `updateDraft` apaga e recria os itens (`app/repositories/nfe.repository.ts:434-441`). `persistCalculo` faz o mesmo (`:467-473`) e roda em toda tentativa de emissão (`app/usecases/nfe-emission.usecase.ts:211-214`). Uma FK para `NfeItem.id` seria apagada, ou quebraria, no primeiro "Próximo" do wizard e de novo na emissão.
   - A ligação passa a ser por posição: `(devolucaoNfeId, ordem)`, com `ordem = NfeItem.numero = nItem` da devolução.
   - Para essa posição valer, o editor de devolução é o único que grava itens de uma devolução gerenciada.
2. **Mandar a referência dentro do item, pelo formulário, não é seguro.** `nfeItemSchema` é um `z.object` que descarta chaves desconhecidas (`app/notas-fiscais/lib/nfe-form-schema.ts:62-77`). Além disso, `step-produtos.tsx` numera com `fields.length + 1` (`:128`, `:152`) e `remove(idx)` não renumera (`:246`), o que gera `numero` repetido. Por isso as referências ficam só no servidor.
3. **Qualquer erro do montador de XML queima número.** No SEFAZ direto, a falha do montador vira `status:"erro"` (`app/fiscal/providers/sefaz-direct.provider.ts:186-205`). A emissão trata isso como `ENVIO_INCERTO` e deixa a nota em SENDING depois de reservar o número (`nfe-emission.usecase.ts:521-536`). Logo, toda regra de devolução precisa rodar **antes** do claim atômico (`:147-155`), e os montadores nunca podem lançar erro por dado de devolução.

Por que tabelas novas e não colunas: `NfeEmitida` e `NfeItem` são lidos com `include`, que lista todas as colunas escalares (`nfe.repository.ts:229-233`, `:321-324`; `nfe-emission.usecase.ts:1127-1130`; `app/routes/fiscal.routes.ts:1133-1139`). Uma coluna nova quebraria essas leituras antes do DDL. Com tabelas novas, o código sobe primeiro (flag desligada), depois roda o DDL, depois liga a flag. **Não entra nenhum campo, relação ou coluna nova em `NfeEmitida` nem em `NfeItem`.**

---

## 1. Modelo de dados

### 1.1 Prisma: dois modelos novos, nenhum modelo existente alterado

As FKs existem **só no DDL**. Uma relação no Prisma exigiria o campo inverso em `NfeEmitida`, e mantemos esse modelo idêntico. Isso segue a convenção de índices e restrições gerenciados pelo banco (`prisma/schema.prisma:1864-1869`, `:1883-1889`). O projeto usa `relationMode` padrão (FK nativa, `schema.prisma:5-9`), então o CASCADE e o SET NULL ficam a cargo do Postgres.

```prisma
/// NF-e de DEVOLUÇÃO (finNFe=4) — cabeçalho 1:1 com a NfeEmitida da devolução.
/// ADITIVO/ISOLADO: nenhuma coluna ou relação nova em NfeEmitida/NfeItem.
/// FKs só no DDL (prisma/ddl/2026-09-17-nfe-devolucao.sql):
///   nfeId → NfeEmitida.id ON DELETE CASCADE
/// ⛔ Nunca `prisma db push` (apagaria FKs/índices DB-managed).
model NfeDevolucao {
  id                   String   @id @default(cuid())
  nfeId                String   @unique // NfeEmitida da devolução
  userId               String // dono dos dados (dataOwnerId)
  tipo                 String // VENDA_ENTRADA | COMPRA_SAIDA
  fonte                String // DEXO | XML_IMPORTADO | MANUAL
  escopoSolicitado     String // TOTAL | PARCIAL
  devolvidaAposEntrega Boolean // precisa ser true (recusa/não entrega = finNFe 5, fora de escopo)
  confirmadoSemXml     Boolean  @default(false) // chave externa sem XML: saldo não verificável
  indFinal             String // "0" | "1" — derivado na criação (ver 5.4)
  origensJson          Json // OrigemDevolucaoSnapshot[] (itens do XML autorizado)
  createdByUserId      String // request.user.id (ATOR — colaborador ou admin)
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  @@index([userId, createdAt])
}

/// Referência por item (det/DFeReferenciado). Vínculo com NfeItem é POSICIONAL:
/// (devolucaoNfeId, ordem) ↔ NfeItem(nfeId, numero). NfeItem.id NÃO é estável
/// (recriado em updateDraft/persistCalculo). FKs só no DDL:
///   devolucaoNfeId → NfeEmitida.id ON DELETE CASCADE
///   originalNfeId  → NfeEmitida.id ON DELETE SET NULL
model NfeDevolucaoItem {
  id                    String   @id @default(cuid())
  devolucaoNfeId        String
  userId                String
  ordem                 Int // 1..990 = det@nItem da devolução = NfeItem.numero
  originalNfeId         String? // NfeEmitida original quando conhecida no Dexo
  chaveAcessoOriginal   String // 44 dígitos normalizados (sem prefixo "NFe")
  nItemOriginal         Int // det@nItem do XML AUTORIZADO da original (nunca NfeItem.numero)
  codigoOriginal        String // cProd — trava de alinhamento com NfeItem.codigo
  quantidadeOriginal    Decimal? @db.Decimal(15, 4) // null = externa sem XML
  valorUnitarioOriginal Decimal? @db.Decimal(15, 4)
  quantidade            Decimal  @db.Decimal(15, 4) // devolvida nesta nota
  valor                 Decimal  @db.Decimal(15, 2) // vProd desta linha
  impostoOriginalJson   Json? // ImpostoOriginal normalizado (ver 5.1)
  tributacaoJson        Json // TributacaoDevolucaoItem (ver 5.2)
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  @@unique([devolucaoNfeId, ordem])
  @@unique([devolucaoNfeId, chaveAcessoOriginal, nItemOriginal], map: "NfeDevolucaoItem_devol_chave_nitem_key") // Rejeição 1072 no banco
  @@index([userId, chaveAcessoOriginal, nItemOriginal], map: "NfeDevolucaoItem_user_chave_nitem_idx") // saldo por item original
  @@index([originalNfeId])
}
```

O `map:` explícito é necessário porque os nomes gerados passariam de 63 bytes, e o Postgres truncaria em silêncio.

### 1.2 DDL: `prisma/ddl/2026-09-17-nfe-devolucao.sql`

O formato segue `prisma/ddl/2026-08-14-receivable-event.sql`. Como são tabelas novas e vazias, índice normal dentro de transação no editor do Supabase basta; `CONCURRENTLY` não é necessário.

```sql
-- NF-e de DEVOLUÇÃO (finNFe=4) — tabelas NfeDevolucao + NfeDevolucaoItem
-- ORDEM: 1) deploy do código com NFE_DEVOLUCAO_ENABLED ausente (nada lê/escreve)
--        2) rodar ESTE arquivo no SQL editor do Supabase
--        3) NFE_DEVOLUCAO_ENABLED=true na API + restart; depois NEXT_PUBLIC_NFE_DEVOLUCAO_ENABLED=true + build
-- 100% ADITIVO: nenhuma coluna existente tocada. ⛔ nunca `prisma db push`.
BEGIN;

CREATE TABLE IF NOT EXISTS "NfeDevolucao" (
  "id"                   TEXT NOT NULL,
  "nfeId"                TEXT NOT NULL,
  "userId"               TEXT NOT NULL,
  "tipo"                 TEXT NOT NULL,
  "fonte"                TEXT NOT NULL,
  "escopoSolicitado"     TEXT NOT NULL,
  "devolvidaAposEntrega" BOOLEAN NOT NULL,
  "confirmadoSemXml"     BOOLEAN NOT NULL DEFAULT false,
  "indFinal"             TEXT NOT NULL,
  "origensJson"          JSONB NOT NULL,
  "createdByUserId"      TEXT NOT NULL,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NfeDevolucao_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NfeDevolucao_tipo_chk"   CHECK ("tipo" IN ('VENDA_ENTRADA','COMPRA_SAIDA')),
  CONSTRAINT "NfeDevolucao_fonte_chk"  CHECK ("fonte" IN ('DEXO','XML_IMPORTADO','MANUAL')),
  CONSTRAINT "NfeDevolucao_escopo_chk" CHECK ("escopoSolicitado" IN ('TOTAL','PARCIAL')),
  CONSTRAINT "NfeDevolucao_indFinal_chk" CHECK ("indFinal" IN ('0','1'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "NfeDevolucao_nfeId_key" ON "NfeDevolucao" ("nfeId");
CREATE INDEX IF NOT EXISTS "NfeDevolucao_userId_createdAt_idx" ON "NfeDevolucao" ("userId","createdAt");
ALTER TABLE "NfeDevolucao" DROP CONSTRAINT IF EXISTS "NfeDevolucao_nfeId_fkey";
ALTER TABLE "NfeDevolucao" ADD CONSTRAINT "NfeDevolucao_nfeId_fkey"
  FOREIGN KEY ("nfeId") REFERENCES "NfeEmitida"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NfeDevolucao" ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "NfeDevolucaoItem" (
  "id"                    TEXT NOT NULL,
  "devolucaoNfeId"        TEXT NOT NULL,
  "userId"                TEXT NOT NULL,
  "ordem"                 INTEGER NOT NULL,
  "originalNfeId"         TEXT,
  "chaveAcessoOriginal"   TEXT NOT NULL,
  "nItemOriginal"         INTEGER NOT NULL,
  "codigoOriginal"        TEXT NOT NULL,
  "quantidadeOriginal"    DECIMAL(15,4),
  "valorUnitarioOriginal" DECIMAL(15,4),
  "quantidade"            DECIMAL(15,4) NOT NULL,
  "valor"                 DECIMAL(15,2) NOT NULL,
  "impostoOriginalJson"   JSONB,
  "tributacaoJson"        JSONB NOT NULL,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NfeDevolucaoItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NfeDevolucaoItem_chave_chk" CHECK ("chaveAcessoOriginal" ~ '^[0-9]{44}$'),
  CONSTRAINT "NfeDevolucaoItem_nItem_chk" CHECK ("nItemOriginal" BETWEEN 1 AND 990),
  CONSTRAINT "NfeDevolucaoItem_ordem_chk" CHECK ("ordem" BETWEEN 1 AND 990),
  CONSTRAINT "NfeDevolucaoItem_qtd_chk"   CHECK ("quantidade" > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "NfeDevolucaoItem_devolucaoNfeId_ordem_key"
  ON "NfeDevolucaoItem" ("devolucaoNfeId","ordem");
CREATE UNIQUE INDEX IF NOT EXISTS "NfeDevolucaoItem_devol_chave_nitem_key"
  ON "NfeDevolucaoItem" ("devolucaoNfeId","chaveAcessoOriginal","nItemOriginal");
-- "devoluções da original X" e "saldo por item original"
CREATE INDEX IF NOT EXISTS "NfeDevolucaoItem_user_chave_nitem_idx"
  ON "NfeDevolucaoItem" ("userId","chaveAcessoOriginal","nItemOriginal");
CREATE INDEX IF NOT EXISTS "NfeDevolucaoItem_originalNfeId_idx"
  ON "NfeDevolucaoItem" ("originalNfeId");
ALTER TABLE "NfeDevolucaoItem" DROP CONSTRAINT IF EXISTS "NfeDevolucaoItem_devolucaoNfeId_fkey";
ALTER TABLE "NfeDevolucaoItem" ADD CONSTRAINT "NfeDevolucaoItem_devolucaoNfeId_fkey"
  FOREIGN KEY ("devolucaoNfeId") REFERENCES "NfeEmitida"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NfeDevolucaoItem" DROP CONSTRAINT IF EXISTS "NfeDevolucaoItem_originalNfeId_fkey";
ALTER TABLE "NfeDevolucaoItem" ADD CONSTRAINT "NfeDevolucaoItem_originalNfeId_fkey"
  FOREIGN KEY ("originalNfeId") REFERENCES "NfeEmitida"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NfeDevolucaoItem" ENABLE ROW LEVEL SECURITY;

COMMIT;
-- Verificação:
-- SELECT indexname FROM pg_indexes WHERE tablename IN ('NfeDevolucao','NfeDevolucaoItem');
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid IN ('"NfeDevolucao"'::regclass,'"NfeDevolucaoItem"'::regclass);
-- ROLLBACK (desligar as DUAS flags + restart ANTES):
-- BEGIN; DROP TABLE IF EXISTS "NfeDevolucaoItem"; DROP TABLE IF EXISTS "NfeDevolucao"; COMMIT;
```

Motivo de cada FK:

- **CASCADE nas linhas da devolução:** `deleteDraft` apaga a `NfeEmitida` (`nfe.repository.ts:488-490`) e as referências vão junto, como os itens (`schema.prisma:1986`).
- **SET NULL na original:** `scripts/delete-migrated-nfes.ts:101-102` pode apagar notas importadas. A chave continua na linha, então o saldo por chave sobrevive.

### 1.3 Como ficam as ligações, sem tocar nas tabelas quentes

| Ligação | Como é expressa |
|---|---|
| devolução → cabeçalho | `NfeDevolucao.nfeId` único (1:1) |
| devolução → itens | `NfeItem(nfeId, numero)` ↔ `NfeDevolucaoItem(devolucaoNfeId, ordem)`, conferido na emissão (regra D04) |
| devolução → original | `chaveAcessoOriginal` (sempre) + `originalNfeId` (quando é nota do Dexo) |
| original → devoluções | índice `(userId, chaveAcessoOriginal, nItemOriginal)` + JOIN em `NfeEmitida` pela PK |

As chaves são normalizadas com `onlyDigits`, porque as notas da Focus guardam `"NFe"+44` (47 caracteres). Para achar uma nota do Dexo por chave, a consulta usa `chaveAcesso IN (k, 'NFe'||k)` (`chaveAcesso @unique`, `schema.prisma:1896`).

### 1.4 Auditoria e ator

- `NfeAuditLog.userId` continua sendo o dono dos dados (`dataOwnerId`), como em toda gravação atual: a rota passa `user.dataOwnerId` (`fiscal.routes.ts:937`), e ele é resolvido em `app/middlewares/auth.middleware.ts:24-25`.
- O ator (`request.user.id`) vai em `detalhes.actorUserId` e em `NfeDevolucao.createdByUserId`. O schema não muda.

| Evento | Grava em | `detalhes` |
|---|---|---|
| `DEVOLUCAO_RASCUNHO_CRIADO` | devolução | `{ originalNfeId\|null, chavesOriginais[], tipo, fonte, escopo, itens:[{ordem,nItem,quantidade}], actorUserId }` |
| `DEVOLUCAO_ITENS_EDITADOS` | devolução | `{ itens:[{ordem,chave,nItem,quantidade,cfop}], actorUserId }` |
| `DEVOLUCAO_SALDO_RESERVADO` | devolução (dentro da transação do claim) | `{ itens:[{chave,nItem,quantidade,disponivelAntes}] }` |
| `DEVOLUCAO_SALDO_EXCEDIDO` | devolução (recontagem pós-autorização, anomalia) | `{ excessos:[{chave,nItem,original,autorizada}] }` |
| `DEVOLUCAO_EMITIDA` | **cada original do Dexo** | `{ devolucaoNfeId, numero, serie, chaveAcesso, itens:[{nItem,quantidade}], actorUserId }` |
| `DEVOLUCAO_POS_AUTORIZACAO_FALHOU` | devolução | `{ erro }` (só a mensagem, sem segredo) |
| `DEVOLUCAO_CANCELADA` (opcional) | cada original do Dexo | `{ devolucaoNfeId, protocolo }` |

`NfeEmitida.emittedByUserId` continua sendo o dono dos dados, como faz o `createDraft` (`nfe.repository.ts:265`).

---

## 2. Módulos puros de domínio, que o front também pode importar

Local: `app/fiscal/domain/devolucao/`. Já é padrão importar `app/fiscal/domain/*` do cliente (`step-produtos.tsx:28` importa `cfop-catalog`). Nesses arquivos não entra `prisma`, `node:*`, `fast-xml-parser` nem leitura de env fora de `flags.ts`.

| Arquivo | Exporta |
|---|---|
| `flags.ts` | `isNfeDevolucaoEnabled()` → `process.env.NFE_DEVOLUCAO_ENABLED === "true"` (API, lido na hora da chamada); `isNfeDevolucaoUiEnabled()` → `process.env.NEXT_PUBLIC_NFE_DEVOLUCAO_ENABLED === "true"` (front) |
| `devolucao.types.ts` | `TipoDevolucao`, `FonteDevolucao`, `OrigemDevolucaoSnapshot`, `ImpostoOriginal`, `TributacaoDevolucaoItem`, `NfeDevolucaoContexto`, `DevolucaoIssue`, `SaldoItemOriginal` |
| `errors.ts` | `class DevolucaoError extends Error { code; httpStatus: 400\|404\|409\|422; issues? }` |
| `chave-acesso-dv.ts` | `normalizarChaveAcesso(raw)` (tira não dígitos e o prefixo `NFe`); `validarChaveAcesso(c)` → `{ok, motivo?, partes:{cUF,aamm,cnpj,mod,serie,nNF,tpEmis}}`. Módulo 11 reimplementado **sem** `node:crypto`, porque `chave-acesso.ts:12` importa `randomInt` e não roda no cliente |
| `cfop-devolucao.ts` | `CFOPS_IND_DEVOL` (105), `CFOPS_EXCECAO_DEVOL` (`1949`,`2949`), `isCfopDevolucaoPermitido`, `idDestDoCfop`, `mapearCfopVendaParaDevolucao`, `sugerirCfopDevolucaoCompra` |
| `imposto-original.ts` | `extrairImpostoOriginal(rawImposto)` (entrada: o `ParsedItem.imposto` bruto, `nfe-xml-parser.service.ts:94-95,329`) |
| `tributacao-devolucao.ts` | `derivarTributacaoDevolucao(...)`, `aplicarOverrideTributacao(...)`, `ICMS_SUPORTADOS`, `PIS_COFINS_SUPORTADOS` |
| `calculo-devolucao.ts` | `calcularTributosDevolucao(regime, itens, refs, frete?)` → `CalculoNfeResult` com `totais.totalIpiDevol` |
| `saldo-devolucao.ts` | `calcularSaldoPorItem`, `verificarSaldoParaEmissao` (inteiros escalados ×10⁴) |
| `elegibilidade.ts` | `avaliarElegibilidadeOriginal(row)`; `MODELOS_ORIGINAIS_PERMITIDOS = ["55"]` na v1 |
| `validar-devolucao.ts` | `validarDevolucao(input)` → `DevolucaoIssue[]`; `checarEdicaoDevolucaoGerenciada(input, header, itensAtuais)` |
| `montar-rascunho-devolucao.ts` | `montarRascunhoDeOriginal(...)`, `montarRascunhoManual(...)`, `derivarIndFinalDevolucao(...)`, `parearItensXmlComNfeItem(...)` |
| `aplicar-contexto.ts` | `aplicarContextoDevolucao(draft, ctx)`: preenche em memória `draft.devolucao`, `item.devolucaoRef`, `item.cstIcms/cstPis/cstCofins` |

### 2.1 Tipos novos e opcionais em interfaces existentes

Todos são opcionais e nunca são preenchidos pelos dois mappers existentes.

```ts
// app/interfaces/nfe.interface.ts
export interface NfeItemDevolucaoRef {
  chaveAcesso: string;                  // 44
  nItem: number;                        // 1..990 (original)
  impostoDevol?: { pDevol: number; vIPIDevol: number } | null;
  ipi?: { cst: string; cEnq: string } | null;   // IPI destacado (contribuinte)
  icmsModBC?: string | null;            // CSOSN 900/CST com valores
}
// NfeDraftItem (linha 43): + devolucaoRef?: NfeItemDevolucaoRef | null;
// NfeDraftResponse (129):  + devolucao?: { tipo: "VENDA_ENTRADA"|"COMPRA_SAIDA"; indFinal: "0"|"1" } | null;
// NfeListFilters (227):    + finalidade?: FinalidadeNfe;
// NfeListItem (243):       + hasXmlAutorizado?: boolean;
// app/fiscal/domain/nfe.types.ts NfeTotais (192): + totalIpiDevol?: number;
```

Os dois mappers são `toDraftResponse` (`nfe.repository.ts:56-117`) e `loadNfe` (`nfe-emission.usecase.ts:1126-1193`). O contexto é colado depois, por `aplicarContextoDevolucao`, e só na emissão. Não nasce um terceiro mapper.

### 2.2 Adição ao parser (sem flag, só leitura)

Em `ParsedIde` (`nfe-xml-parser.service.ts:28-42`) entram `idDest?: string|null; indFinal?: string|null; indPres?: string|null;`, preenchidos em `parseIde` (`:221-238`). Nenhum consumidor lê esses campos hoje. O teste do DANFE a partir do XML (`tests/fiscal/danfe-from-xml.spec.ts`) precisa continuar passando.

---

## 3. Endpoints

Todos ficam em `app/routes/fiscal.routes.ts` com prefixo `/fiscal` (`app/api/api.ts:251-252`) e `preHandler: [authMiddleware]`.

Regras comuns:

- **Flag lida na chamada:** com `!isNfeDevolucaoEnabled()`, responde `404 {error:"Not Found"}` antes de qualquer acesso ao banco. É indistinguível de uma rota inexistente.
- **Identidade:** `userId = user.dataOwnerId`, `actorUserId = user.id`.
- **Erros:** `DevolucaoError` vira `reply.status(e.httpStatus).send({ error, code, issues })`.

### 3.1 `POST /fiscal/nfe/:id/devolucao`: rascunho novo a partir de uma original autorizada

Requisição:

```json
{ "devolvidaAposEntrega": true, "escopo": "PARCIAL",
  "itens": [{ "nItem": 1, "quantidade": 1 }], "forcarNovo": false }
```

Pseudo-código, em `NfeDevolucaoUseCase.criarDeOriginal(userId, actorUserId, originalId, body)`:

```ts
if (body.devolvidaAposEntrega !== true)
  throw new DevolucaoError("RECUSA_NAO_E_DEVOLUCAO",
    "Mercadoria recusada/não entregue é NF-e de crédito (finNFe 5) — fora deste fluxo", 422);

const original = await prisma.nfeEmitida.findFirst({ where: { id: originalId, userId }, select: {
  id, status, modelo, finalidade, tipoOperacao, destinoOperacao, ambiente, serie, numero,
  chaveAcesso, companyFiscalConfigId, customerId, destinatarioJson, xmlAutorizadoPath, dataEmissao } });
if (!original) throw new DevolucaoError("NAO_ENCONTRADA", "NF-e nao encontrada", 404);

const eleg = avaliarElegibilidadeOriginal(original);
// AUTHORIZED; CANCELLED → 409; modelo "55"; finalidade != DEVOLUCAO; tipoOperacao SAIDA;
// xmlAutorizadoPath != null (notas históricas importadas não têm — createHistoric
// nfe.repository.ts:188-215 não grava XML) → 422 "use a devolução manual"
if (!eleg.ok) throw new DevolucaoError(eleg.code, eleg.mensagem, eleg.httpStatus);

const xml = await storage.readFile(original.xmlAutorizadoPath);        // fiscal-storage.service.ts:108
const parsed = parseNfeXml(xml.toString("utf-8"));                     // nfe-xml-parser.service.ts:157
const chave = normalizarChaveAcesso(parsed.chaveAcesso);
// validarChaveAcesso ok; se o banco tem chave: normalizar(original.chaveAcesso) === chave;
// parsed.protNFe?.cStat ∈ {100,150} quando presente; parsed.itens.length > 0

const config = original.companyFiscalConfigId
  ? await configRepo.findByIdForUser(original.companyFiscalConfigId, userId)
  : await configRepo.findByUserId(userId);
if (!config || onlyDigits(config.cnpj) !== onlyDigits(parsed.emit.CNPJ))
  throw new DevolucaoError("EMITENTE_ORIGINAL_AUSENTE", "O CNPJ emissor da nota original não está configurado", 409);

const abertas = await devolucaoRepo.devolucoesAbertasPorChave(userId, chave); // DRAFT|REJECTED
if (abertas.length && !body.forcarNovo)
  throw new DevolucaoError("DEVOLUCAO_RASCUNHO_EXISTENTE", "Já existe devolução em aberto", 409, undefined, { nfeIds: abertas });

const linhas = await devolucaoRepo.linhasPorChaves(userId, [chave]);   // sem lock (UX)
const itensNfe = await prisma.nfeItem.findMany({ where: { nfeId: original.id },
  select: { numero, codigo, descricao, quantidade, valorTotal, productId } });
const r = montarRascunhoDeOriginal({ original, parsed, config, linhas, itensNfe, selecao: body });
// r = { cabecalho, itens: NfeDraftItem[] (numero = ordem), refs, destinatario, destinoOperacao,
//       naturezaOperacao: "DEVOLUCAO DE VENDA", informacoesComplementares, indFinal, issues }
// TOTAL e alguma item.disponivel < original → 409 "nota já parcialmente devolvida"
// soma disponivel == 0 → 409 "nota já totalmente devolvida"

const nfeId = await devolucaoRepo.criarRascunho(userId, actorUserId, config, r); // 1 transação (3.7)
return { draft: await nfeRepo.findDraftById(userId, nfeId), devolucao: await usecase.detalhe(userId, nfeId) };
```

O que `montarRascunhoDeOriginal` **garante** (e o teste cobre):

- Nunca copia `id`, `chaveAcesso`, `protocoloAutorizacao`, `dataAutorizacao`, `xml*Path`, `danfePdfPath`, `status`, `numero`, `motivoRejeicao`, `cStatRejeicao`, `orderId` nem `numeroPedido`. Os caminhos que dependem desses campos ficam de fora: `findAuthorizedByOrderId` (`nfe.repository.ts:925-955`), `findByNumeroPedidoAndModelo` (`:277-312`) e o status "faturada" do financeiro por `numeroPedido startsWith "receivable:"` (`app/repositories/finance.repository.ts:858-865`).
- Cabeçalho da nota:
  - `tipoOperacao: "ENTRADA"`, `finalidade: "DEVOLUCAO"`, `modelo: "55"`.
  - `destinoOperacao` = `ide.idDest` do XML original (1/2/3 → INTERNA/INTERESTADUAL/EXTERIOR); na falta, `original.destinoOperacao`.
  - `indPresenca: "NAO_SE_APLICA"`, `modalidadeFrete: "SEM_FRETE"`, `pagamentosJson: []`, `duplicatasJson: null`, `notasReferenciadasJson: null`.
  - `serie: config.serieNfe ?? 1`, `ambiente: config.ambiente`, `companyFiscalConfigId: config.id`.
  - `customerId: original.customerId`.
- Destinatário:
  - `destinatarioJson` = `original.destinatarioJson`, que é a cópia com o nome real.
  - Não usa o `dest/xNome` do XML, porque em homologação ele é o literal da regra 598 (`nfe-xml-builder-sefaz.service.ts:333-337`).
- Itens: um por `det` do XML **com saldo disponível > 0**.
  - `nItemOriginal = det@nItem` (`nfe-xml-parser.service.ts:317`).
  - `codigo/descricao/ncm/cest/unidade` vêm de `prod`, e `origem` vem do grupo ICMS `orig`.
  - `valorUnitario = vUnCom`, `valorTotal = round2(q × vUnCom)`, `desconto = round2(vDesc × q/qCom)`.
  - `productId` só entra se `parearItensXmlComNfeItem` achar par único (`cProd==codigo ∧ |qCom−quantidade|<1e-4 ∧ |vProd−valorTotal|<0,01`); senão fica `null`. É só informativo, porque a devolução não mexe em estoque.
- CFOP: vem de `mapearCfopVendaParaDevolucao(det.CFOP)` (3.8). Se precisar de escolha, `cfop: ""` e emitir fica bloqueado (D11).
- `informacoesComplementares` (editável): `Devolucao ref. NF-e ${numero} serie ${serie} de ${dd/mm/aaaa}, chave ${chave}`, passado por `sanitizeFreeText` (`inf-cpl.ts:27-38`). `composeInfCpl` não muda.

Resposta `201`:

```json
{ "draft": { "...NfeDraftResponse...": "" },
  "devolucao": { "nfeId": "…", "tipo": "VENDA_ENTRADA", "fonte": "DEXO", "escopoSolicitado": "PARCIAL", "indFinal": "1",
    "origens": [{ "chaveAcesso": "4126…", "originalNfeId": "…", "numero": 12, "serie": 3 }],
    "itens": [{ "ordem": 1, "chaveAcesso": "4126…", "nItem": 1, "codigo": "…", "descricao": "…",
                "quantidadeOriginal": 2, "quantidade": 1, "cfop": "1202", "cfopStatus": "MAPEADO",
                "cfopOpcoes": ["1202"], "tributacao": { "...": "" }, "requerRevisao": false }],
    "issues": [{ "code": "PIS_CST_SAIDA_EM_ENTRADA", "severidade": "AVISO", "ordem": 1, "mensagem": "…" }] } }
```

### 3.2 `GET /fiscal/nfe/:id/devolucao/saldo` (`:id` = original)

```json
{ "original": { "nfeId": "…", "chaveAcesso": "…", "numero": 12, "serie": 3, "modelo": "55",
                "status": "AUTHORIZED", "dataEmissao": "…", "destinatarioNome": "…" },
  "elegivel": true, "motivo": null,
  "itens": [{ "nItem": 1, "codigo": "…", "descricao": "…", "unidade": "UN",
              "quantidadeOriginal": 2, "valorUnitario": 150,
              "devolvidaAutorizada": 1, "emProcessamento": 0, "emRascunho": 1, "disponivel": 1 }],
  "devolucoes": [{ "nfeId": "…", "numero": 15, "serie": 3, "status": "AUTHORIZED",
                   "itens": [{ "nItem": 1, "quantidade": 1 }] }],
  "totalmenteDevolvida": false }
```

Regras do saldo (`calcularSaldoPorItem`):

| Status da nota de devolução | Contagem | Consome saldo? |
|---|---|---|
| `AUTHORIZED` | `devolvidaAutorizada` | sim |
| `VALIDATING`, `SIGNING`, `SENDING` | `emProcessamento` | sim (reserva) |
| `DRAFT`, `REJECTED` | `emRascunho` | não, só informativo |
| `CANCELLED`, `INUTILIZED` | ignorado | não |

`disponivel = max(0, original − autorizada − emProcessamento)`. Os itens originais vêm do XML autorizado (lido do disco, sem custo de banco).

SQL (repositório):

```sql
SELECT di."devolucaoNfeId", di."chaveAcessoOriginal", di."nItemOriginal",
       di."quantidade"::text AS quantidade, n."status", n."numero", n."serie"
FROM "NfeDevolucaoItem" di
JOIN "NfeEmitida" n ON n."id" = di."devolucaoNfeId"
WHERE di."userId" = ${userId}
  AND di."chaveAcessoOriginal" = ANY(${chaves}::text[])
  AND n."userId" = ${userId} AND n."finalidade" = 'DEVOLUCAO'
ORDER BY n."createdAt"
```

Existe também `GET /fiscal/nfe/devolucao/saldo?chave=<44>`, a mesma resposta para chaves externas. `original` vem `null` quando não há nota no Dexo; com XML nenhum, `quantidadeOriginal` sai `null` e `disponivel: null`.

### 3.3 `GET /fiscal/nfe/:id/devolucao` (`:id` = devolução)

Retorna cabeçalho, itens com referência, resumo das origens e `issues` (resultado de `validarDevolucao`, prévia para a UI). Sem cabeçalho, responde 404 `DEVOLUCAO_NAO_GERENCIADA`.

### 3.4 `PUT /fiscal/nfe/:id/devolucao/itens`: editor, único que grava itens de devolução gerenciada

Requisição (substitui a lista inteira):

```json
{ "itens": [{ "chaveAcesso": "4126…", "nItem": 1, "quantidade": 1, "cfop": "1202",
              "tributacao": { "icms": { "cst": "900", "modBC": "3", "pICMS": 12 } },
              "confirmarTributacao": true }] }
```

```ts
header = findHeader(userId, id) ?? 404
source = header.origensJson[chave].itens[nItem] ?? 422 "item não existe na nota original"
qty: > 0 && (quantidadeOriginal == null || qty <= quantidadeOriginal)   // teto estático; o saldo autoritativo é na emissão
cfop ∈ opcoesDoItem(source.CFOP, tipo)  // mapeado | opções | CFOPS_IND_DEVOL com dígito do idDest
valorUnitario = source.vUnCom (não editável); desconto proporcional
trib = aplicarOverrideTributacao(derivar(source.imposto, …), body.tributacao, body.confirmarTributacao)
// override passa por allowlist de CST/CSOSN suportados, alíquotas 0..100; não suportado → 422
await prisma.$transaction(async tx => {
  const g = await tx.nfeEmitida.updateMany({ where: { id, userId, status: { in: ["DRAFT","REJECTED"] } },
                                             data: { updatedAt: new Date() } });   // PRESERVA o status
  if (g.count === 0) throw new DevolucaoError("DEVOLUCAO_EM_EMISSAO", "…", 409);
  await tx.nfeItem.deleteMany({ where: { nfeId: id } });
  await tx.nfeItem.createMany({ data: itens.map((it, i) => ({ ...it, nfeId: id, numero: i + 1, tributosJson: null })) });
  await tx.nfeDevolucaoItem.deleteMany({ where: { devolucaoNfeId: id } });
  await tx.nfeDevolucaoItem.createMany({ data: refs.map((r, i) => ({ ...r, ordem: i + 1, userId })) });
  await tx.nfeDevolucao.update({ where: { nfeId: id }, data: { escopoSolicitado } });
  await tx.nfeAuditLog.create({ data: { nfeId: id, userId, evento: "DEVOLUCAO_ITENS_EDITADOS", detalhes: {…, actorUserId} } });
});
```

O status **não** é rebaixado para DRAFT, ao contrário de `updateDraft` (`nfe.repository.ts:379-381`, a causa R1). Assim o reaproveitamento de número numa rejeição continua valendo.

### 3.5 `PUT /fiscal/nfe/:id/devolucao`: cabeçalho

Aceita `{ confirmadoSemXml?: boolean, escopoSolicitado?: "TOTAL"|"PARCIAL" }`, com a mesma trava de status e auditoria.

### 3.6 Devolução manual

Há duas entradas, e ambas criam o rascunho pelo mesmo `montarRascunhoManual` e `criarRascunho`.

**A) XML por multipart:** `POST /fiscal/nfe/devolucao/manual/xml`, campo de arquivo `xml` e campo `payload` com JSON.

- Multipart **de propósito**: o middleware global grava `sanitizeDeep(request.body)` no SystemLog (`app/middlewares/logging.middleware.ts:63`). `sanitizeDeep` só redige por nome de chave (`:405-432`), então um XML em JSON (endereços, CPF) ficaria salvo inteiro.
- Mesmo padrão de leitura da importação de produto (`app/routes/product.routes.ts:244`), com teto de 1 MiB.
- `payload = { tipo: "COMPRA_SAIDA"|"VENDA_ENTRADA", companyFiscalConfigId?, devolvidaAposEntrega: true, itens?: [{nItem, quantidade}] }`.

Validações sobre `parseNfeXml`:

- `protNFe.cStat ∈ {100,150}`, senão 422 "XML sem protocolo de autorização".
- Chave com DV válido e `ide.mod === "55"`.
- `tpAmb` coerente com `config.ambiente`.
- **COMPRA_SAIDA** (compra devolvida ao fornecedor):
  - `dest.CNPJ === config.cnpj`, senão 422 "a nota não foi emitida para este CNPJ".
  - Cabeçalho: `tipoOperacao: "SAIDA"`, `naturezaOperacao: "DEVOLUCAO DE COMPRA"`.
  - O destinatário da devolução é o `emit` do XML (CNPJ, xNome, IE e `enderEmit` → `NfeDestinatario`).
  - `indFinal` e CFOP seguem 3.8 e 5.4.
- **VENDA_ENTRADA** (nota própria com XML fora do Dexo): `emit.CNPJ === config.cnpj`, com o destinatário vindo do `dest` do XML.

Para qualquer chave, busca a nota no Dexo por `chaveAcesso IN (k,'NFe'||k)`. Se existir, grava `originalNfeId`; se estiver `CANCELLED`/`INUTILIZED`, responde 409. `fonte = "XML_IMPORTADO"`.

**B) Chave digitada:** `POST /fiscal/nfe/devolucao/manual` (JSON).

```json
{ "tipo": "COMPRA_SAIDA", "companyFiscalConfigId": null, "devolvidaAposEntrega": true,
  "confirmadoSemXml": true,
  "destinatario": { "...NfeDestinatario...": "" },
  "chaves": [{ "chaveAcesso": "35…", "itens": [{ "nItem": 3, "codigo": "…", "descricao": "…",
      "ncm": "87089990", "cest": null, "origem": 0, "unidade": "UN", "cfopOriginal": "5102",
      "quantidadeOriginal": null, "valorUnitario": 80, "quantidade": 1 }] }] }
```

- `fonte = "MANUAL"`.
- Toda a tributação nasce com `requerRevisao: true`, porque não há XML e não se inventa nada.
- `quantidadeOriginal: null` deixa o saldo não verificável. Por isso é obrigatório `confirmadoSemXml: true`; sem isso, D22 bloqueia.

### 3.7 Criação em transação (`NfeDevolucaoRepository.criarRascunho`)

Dentro de `prisma.$transaction`:

1. `nfeEmitida.create` com os mesmos campos base de `createDraft` (`nfe.repository.ts:246-268`) mais os sobrescritos de 3.1. O placeholder de `numero` vem de `-(count DRAFT)+1`, na mesma fórmula de `:242-257`.
2. `nfeItem.createMany` com `numero = ordem`.
3. `nfeDevolucao.create`.
4. `nfeDevolucaoItem.createMany`.
5. `nfeAuditLog.create` com `DEVOLUCAO_RASCUNHO_CRIADO`.

Devolve só o `id`. A resposta é montada por `nfeRepo.findDraftById`, o que evita exportar `toDraftResponse` e evita um terceiro mapper.

### 3.8 Tabela de CFOP (`cfop-devolucao.ts`)

```ts
export const CFOPS_IND_DEVOL = new Set([
 "1201","1202","1203","1204","1208","1209","1212","1213","1214","1215","1216","1410","1411",
 "1503","1504","1505","1506","1553","1660","1661","1662","1918","1919",
 "2201","2202","2203","2204","2208","2209","2212","2213","2214","2215","2216","2410","2411",
 "2503","2504","2505","2506","2553","2660","2661","2662","2918","2919",
 "3201","3202","3211","3212","3503","3553",
 "5201","5202","5208","5209","5210","5213","5214","5215","5216","5410","5411","5412","5413",
 "5503","5553","5555","5556","5660","5661","5662","5918","5919","5921",
 "6201","6202","6208","6209","6210","6213","6214","6215","6216","6410","6411","6412","6413",
 "6503","6553","6555","6556","6660","6661","6662","6918","6919","6921",
 "7201","7202","7210","7211","7212","7553","7556",
]); // 105 — I08-140 (NT 2026.009)
export const CFOPS_EXCECAO_DEVOL = new Set(["1949","2949"]); // só tpNF=0

const VENDA_PARA_DEVOL: Record<string,string> = {
  "5102":"1202","6102":"2202","6108":"2202","5101":"1201","6101":"2201","6107":"2201",
  "5405":"1411","5403":"1411","6403":"2411","5401":"1410","6401":"2410" };
const VENDA_ESCOLHA: Record<string,string[]> = {
  "6404":["2411","2949"], "5949":["1949"], "6949":["2949"], "5929":["1949"], "6929":["2949"] };

export function mapearCfopVendaParaDevolucao(cfopOriginal: string):
  { status: "MAPEADO"; cfop: string; opcoes: string[] }
| { status: "ESCOLHA_OBRIGATORIA"; cfop: ""; opcoes: string[] } {
  const c = cfopDigits(cfopOriginal);
  if (VENDA_PARA_DEVOL[c]) return { status: "MAPEADO", cfop: VENDA_PARA_DEVOL[c], opcoes: [VENDA_PARA_DEVOL[c]] };
  const d = ({ "5":"1","6":"2","7":"3" } as any)[c[0]];
  const opcoes = VENDA_ESCOLHA[c] ?? [...CFOPS_IND_DEVOL].filter(x => x[0] === d).concat(d === "1" ? ["1949"] : d === "2" ? ["2949"] : []);
  return { status: "ESCOLHA_OBRIGATORIA", cfop: "", opcoes };
}
// COMPRA_SAIDA: SEMPRE ESCOLHA_OBRIGATORIA (a finalidade da NOSSA entrada é desconhecida);
// sugestão por CFOP do fornecedor (mesmo dígito 5/6): 5101/6101→x201, 5102/6102/6108→x202,
// 5401/6401→x410, 5403/5405/6403/6404→x411; opcoes = CFOPS_IND_DEVOL com 1º dígito 5|6|7.
export const idDestDoCfop = (cfop: string) => ({ "1":"1","5":"1","2":"2","6":"2","3":"3","7":"3" } as any)[cfop[0]];
```

---

## 4. Validação e mudanças na emissão

### 4.1 Regras de validação (`validarDevolucao`, puro)

| Código | Regra | Sev. | Rejeição SEFAZ |
|---|---|---|---|
| D01 | `draft.modelo === "55"` | BLOQ | 706/715 |
| D02 | finalidade DEVOLUCAO **e** cabeçalho existe (devolução gerenciada) | BLOQ | 321 |
| D03 | `notasReferenciadasJson` vazio/nulo (nunca é enviado) | BLOQ | 1010 |
| D04 | `itens.length === refs.length`; ∀i: `itens[i].numero === i+1 === refs[i].ordem` e `itens[i].codigo === refs[i].codigoOriginal` | BLOQ | 321 |
| D05 | sem referência órfã (`ordem > itens.length`) | BLOQ | — |
| D06 | chave com 44 dígitos, DV válido (módulo 11 puro), `mod ∈ MODELOS_ORIGINAIS_PERMITIDOS` | BLOQ | 321 |
| D07 | `nItem` inteiro 1..990 | BLOQ | 1048 |
| D08 | par (chave, nItem) único na nota | BLOQ | 1072 |
| D09 | todas as chaves com o mesmo CNPJ emitente (posições 7-20) | BLOQ | 1193 |
| D10 | tpNF=1 ⇒ CNPJ da chave == dígitos do CPF/CNPJ do destinatário; tpNF=0 ⇒ CNPJ da chave == `config.cnpj` (regra local mais estrita) | BLOQ | 1194 |
| D11 | `cfop ∈ CFOPS_IND_DEVOL ∪ (tpNF=0 ? {1949,2949} : ∅)`; cfop vazio = "CFOP requer escolha" | BLOQ | 327 |
| D12 | `idDestDoCfop(cfop) === DESTINO_OPERACAO_COD[destinoOperacao]` | BLOQ | 731/732/733 |
| D13 | VENDA_ENTRADA ⇒ `tipoOperacao==="ENTRADA"`; COMPRA_SAIDA ⇒ `"SAIDA"` | BLOQ | — |
| D14 | `quantidade>0`; `quantidadeOriginal!=null ⇒ quantidade ≤ original`; `valorTotal ≤ round2(vProdOrig×q/qOrig)+0,01`; `valorUnitario === valorUnitarioOriginal` (±0,0001) | BLOQ | 545/546 |
| D15 | `tributacao.requerRevisao === false` e grupos ICMS/PIS/COFINS/IPI dentro dos suportados (5.3) | BLOQ | 1002/745/748/schema |
| D16 | `impostoDevol`: `0 < pDevol ≤ 100`, `vIPIDevol ≥ 0` | BLOQ | — |
| D17 | `pagamentosJson` com algum `meio !== "SEM_PAGAMENTO"` ⇒ aviso "será enviado tPag=90"; `duplicatasJson` não vazio ⇒ aviso "cobrança não é enviada" | AVISO | 871 |
| D18 | `header.devolvidaAposEntrega === true` | BLOQ | — |
| D19 | original do Dexo: status AUTHORIZED; `ambiente === config.ambiente`; VENDA_ENTRADA ⇒ `original.companyFiscalConfigId ?? default === config.id` | BLOQ | — |
| D20 | totais da nota ≤ totais proporcionais da origem + R$ 1 (vProd, vICMS, vIPI, vPIS, vCOFINS) | BLOQ | 545/546/566/567/581 |
| D21 | CPF/CNPJ do destinatário ≠ destinatário da original (VENDA_ENTRADA) | AVISO | — |
| D22 | alguma origem sem XML ⇒ exige `header.confirmadoSemXml` | BLOQ | — |
| D23 | CST de PIS/COFINS de saída (01-49) numa nota de entrada | AVISO | — |

`validate()` já confere o dígito do CFOP contra o tipo de operação (`nfe-emission.usecase.ts:751-774`). D12 complementa isso com o `idDest`.

Sobre o MEI (CRT 4): `crtFromRegime` nunca devolve 4 (`nfe-xml-builder-sefaz.service.ts:956-960`), então a lista 1179 não se aplica hoje. Fica registrado.

### 4.2 `NfeEmissionUseCase.emit`, com mudanças só atrás de flag

A assinatura passa a ser `emit(userId, nfeId, actorUserId?: string)`, parâmetro final e opcional. A rota (`fiscal.routes.ts:939`) passa `user.id`. A chamada de `finance.usecase.ts:1910` continua igual (lá a finalidade é sempre NORMAL, `nfe-draft.usecase.ts:600`).

```ts
// após this.validate(draft, config)  (linha 129)
const devolucaoOn = isNfeDevolucaoEnabled() && draft.finalidade === "DEVOLUCAO";
let devCtx: NfeDevolucaoContexto | null = null;
if (devolucaoOn) {
  devCtx = await this.devolucaoRepo.carregarContexto(userId, nfeId);
  // { header|null, refs[], originaisDexo[{id,status,ambiente,companyFiscalConfigId,modelo,chave}] }
  const bloqueios = validarDevolucao({ draft, config, ...devCtx }).filter(i => i.severidade === "BLOQUEIO");
  if (bloqueios.length)
    throw new DevolucaoError("DEVOLUCAO_INVALIDA", bloqueios[0].mensagem, 422, bloqueios); // ANTES do claim
}

// claim (linhas 140-155): claimData idêntico
const claimed = devCtx
  ? await this.devolucaoRepo.claimComSaldo({ userId, nfeId, claimData, ctx: devCtx, itens: draft.itens })
  : await (prisma as any).nfeEmitida.updateMany({ where: { id: nfeId, userId, status: { in: ["DRAFT","REJECTED"] } }, data: claimData }); // INALTERADO
if (claimed.count === 0) throw new Error("NF-e ja esta em processamento de emissao ou ja foi emitida");

try {
  // cálculo (linhas 163-199)
  const calcResult = devCtx
    ? calcularTributosDevolucao(regime, draft.itens, devCtx.refs, freteOpts)
    : this.calculator.calcular(regime, itensInput, freteOpts);   // INALTERADO
  // persistência (202-214) inalterada: numero preservado ⇒ ordem preservada
  ...
  const nfeWithNumero = await this.loadNfe(nfeId);                // linha 290
  if (devCtx) aplicarContextoDevolucao(nfeWithNumero, devCtx);    // em memória, antes de montar payload/snapshot
  ...
  // handleAuthorized(..., devCtx, actorUserId)  ← 2 parâmetros finais opcionais
}
// catch (547-564) INALTERADO: volta para DRAFT, o que libera a reserva automaticamente
```

### 4.3 `claimComSaldo`: claim com lock (repositório)

A ordem dos locks é fixa, o que evita deadlock: linha da própria devolução → advisory locks por chave (em ordem) → originais `FOR UPDATE` (em ordem de id). Nenhum outro código pega esses advisory locks. O cancelamento só pega o lock da linha da original.

```ts
return prisma.$transaction(async (tx) => {
  // 1) serializa com o editor (3.4) e com clique duplo na MESMA devolução
  const own = await tx.$queryRaw`SELECT "id","status" FROM "NfeEmitida"
                                  WHERE "id" = ${nfeId} AND "userId" = ${userId} FOR UPDATE`;
  if (!own.length || !["DRAFT","REJECTED"].includes(own[0].status)) return { count: 0 };

  // 2) serializa devoluções concorrentes da MESMA chave (Dexo ou externa)
  const chaves = [...new Set(ctx.refs.map(r => r.chaveAcessoOriginal))].sort();
  for (const k of chaves)
    await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtextextended(${`nfe-devolucao:${userId}:${k}`}, 0))`;
    // "SELECT 1 FROM …": o Prisma não desserializa coluna do tipo void

  // 3) status da original re-checado SOB lock de linha
  const variantes = chaves.flatMap(k => [k, `NFe${k}`]);
  const originais = await tx.$queryRaw`SELECT "id","status","ambiente","companyFiscalConfigId","chaveAcesso"
      FROM "NfeEmitida" WHERE "userId" = ${userId} AND "chaveAcesso" = ANY(${variantes}::text[])
      ORDER BY "id" FOR UPDATE`;
  if (originais.some(o => o.status !== "AUTHORIZED"))
    throw new DevolucaoError("ORIGINAL_NAO_AUTORIZADA", "A nota original não está mais autorizada", 409);

  // 4) rascunho não mudou entre o carregarContexto e o lock
  const refsTx  = await tx.nfeDevolucaoItem.findMany({ where: { devolucaoNfeId: nfeId }, orderBy: { ordem: "asc" },
                     select: { ordem: true, chaveAcessoOriginal: true, nItemOriginal: true, quantidade: true } });
  const itensTx = await tx.nfeItem.findMany({ where: { nfeId }, orderBy: { numero: "asc" },
                     select: { numero: true, codigo: true, quantidade: true } });
  if (!mesmoFingerprint(refsTx, ctx.refs) || !mesmoFingerprint(itensTx, itens))
    throw new DevolucaoError("RASCUNHO_ALTERADO", "A devolução foi alterada durante a emissão — tente novamente", 409);

  // 5) saldo: AUTHORIZED + em voo, EXCLUINDO esta nota
  const linhas = await tx.$queryRaw`SELECT di."chaveAcessoOriginal", di."nItemOriginal",
        SUM(di."quantidade")::text AS consumida
      FROM "NfeDevolucaoItem" di JOIN "NfeEmitida" n ON n."id" = di."devolucaoNfeId"
      WHERE di."userId" = ${userId} AND di."chaveAcessoOriginal" = ANY(${chaves}::text[])
        AND di."devolucaoNfeId" <> ${nfeId} AND n."finalidade" = 'DEVOLUCAO'
        AND n."status" IN ('AUTHORIZED','VALIDATING','SIGNING','SENDING')
      GROUP BY 1, 2`;
  const faltas = verificarSaldoParaEmissao(ctx.refs, linhas);   // só onde quantidadeOriginal != null
  if (faltas.length) throw new DevolucaoError("SALDO_INSUFICIENTE", faltas[0].mensagem, 409, faltas);

  // 6) claim idêntico ao atual + auditoria atômica
  const claimed = await tx.nfeEmitida.updateMany({ where: { id: nfeId, userId, status: { in: ["DRAFT","REJECTED"] } }, data: claimData });
  if (claimed.count === 1)
    await tx.nfeAuditLog.create({ data: { nfeId, userId, evento: "DEVOLUCAO_SALDO_RESERVADO", detalhes: {…} } });
  return claimed;
}, { maxWait: 5_000, timeout: 10_000 });
```

Por que funciona:

- **Serialização entre devoluções:** no READ COMMITTED, cada comando enxerga o que foi commitado antes dele. Uma devolução B que espera o advisory lock de A vê A já em `VALIDATING` no passo 5. Assim duas devoluções da mesma chave nunca passam juntas.
- **Liberação da reserva:** vale em REJECTED (`handleRejected`), na volta para DRAFT (`catch`, `:551-556`) e em CANCELLED (`nfe-cancelamento.usecase.ts:136-142`).
- **Custo:** a transação tem ~7 comandos, dura milissegundos e só existe para `finalidade DEVOLUCAO` com a flag ligada.

### 4.4 Recontagem na autorização

É um hook opcional no fim de `handleAuthorized` (`nfe-emission.usecase.ts:789-937`), depois de `maybeAutoCreateCustomer`, no mesmo estilo de "melhor esforço, nunca derruba":

```ts
if (devCtx) await this.registrarDevolucaoAutorizada(nfeId, userId, numero, serie, chaveAcesso, devCtx, actorUserId);
// try {
//   linhas = SUM(quantidade) por (chave,nItem) WHERE n.status='AUTHORIZED' (inclui esta)
//   excessos = compararComOriginal(ctx.header.origensJson, linhas); if (excessos.length) audit DEVOLUCAO_SALDO_EXCEDIDO
//   ∀ originalNfeId distinto: addAuditLog(originalId, userId, "DEVOLUCAO_EMITIDA", {...})
// } catch (e) { addAuditLog(nfeId, userId, "DEVOLUCAO_POS_AUTORIZACAO_FALHOU", { erro: msg }) }
```

DANFE da devolução via Focus: hoje o PDF sai do banco quando não há XML inline (`:860-899`), e o banco não guarda CST por item. Com `devCtx`, aplica-se `aplicarContextoDevolucao(nfeData, devCtx)` antes de `danfeService.generate`, só nesse ramo.

### 4.5 Mapa de erros nas rotas (aditivo)

Nos `catch` de `POST /nfe/:id/issue` (`fiscal.routes.ts:941-958`) e `PUT /nfe/draft/:id` (`:751-757`), entra como **primeira** linha:

```ts
if (error instanceof DevolucaoError) return reply.status(error.httpStatus).send({ error: error.message, code: error.code, issues: error.issues ?? [] });
```

Para qualquer outro erro, o mapeamento por substring atual continua igual.

---

## 5. Tributação da devolução

### 5.1 `ImpostoOriginal`, normalizado de `ParsedItem.imposto`

```ts
interface ImpostoOriginal {
  icms: { grupo: string /* "ICMS00"|"ICMSSN102"|… */; orig: number; cst?: string; csosn?: string;
          modBC?: string; vBC: number; pRedBC?: number; pICMS?: number; vICMS: number;
          vBCST: number; vICMSST: number; pCredSN?: number; vCredICMSSN?: number } | null;
  ipi:   { cEnq: string; cst: string; vBC: number; pIPI: number; vIPI: number } | null;
  pis:   { grupo: string; cst: string; vBC: number; pPIS: number; vPIS: number } | null;
  cofins:{ grupo: string; cst: string; vBC: number; pCOFINS: number; vCOFINS: number } | null;
  temIbsCbs: boolean;
}
```

### 5.2 `TributacaoDevolucaoItem`, guardada em `NfeDevolucaoItem.tributacaoJson`

```ts
interface TributacaoDevolucaoItem {
  fonte: "XML_ORIGINAL" | "PADRAO_REGIME" | "USUARIO";
  proporcionalAoOriginal: boolean;   // true ⇒ valores = original × q/qOrig
  requerRevisao: boolean;            // true ⇒ D15 bloqueia até confirmarTributacao
  motivoRevisao?: string | null;
  icms:   { cst: string; modBC?: string | null; pICMS?: number | null; pRedBC?: number | null };
  ipi?:   { cst: string; cEnq: string; pIPI: number } | null;   // IPI destacado
  ipiDevol?: { ativo: true } | null;                               // impostoDevol (não contribuinte)
  pis:    { cst: string; pPIS?: number | null };
  cofins: { cst: string; pCOFINS?: number | null };
}
```

Regras de `derivarTributacaoDevolucao({ tipo, regimeEmitente, imposto, crtOriginal })`:

- **Sem XML:** `fonte PADRAO_REGIME`, com CSOSN/CST e PIS/COFINS padrão do regime, os mesmos de `nfe-emission.usecase.ts:171-174`. Vem com `requerRevisao: true` e motivo "Nota sem XML — confirme a tributação".
- **VENDA_ENTRADA** (mesmo emitente):
  - ICMS: copia CST/CSOSN, modBC, pICMS e pRedBC. Se a família do grupo (SN ou normal) diferir do regime atual, `requerRevisao`.
  - IPI com `vIPI > 0`: IPI destacado com CST de entrada mapeado (50→00, 51→01, 52→02, 53→03, 54→04, 55→05, 99→49) e `requerRevisao: true`.
  - PIS/COFINS: copia CST e alíquota, que é "o CST da configuração" com que a original saiu. Se for CST de saída numa entrada, gera AVISO D23, sem bloquear.
- **COMPRA_SAIDA:**
  - Emitente SIMPLES com fornecedor CRT 3/2 e `vICMS > 0`: `icms {cst:"900", modBC: orig.modBC, pICMS: orig.pICMS}`, `proporcionalAoOriginal`, `requerRevisao: true`, motivo "CGSN 140 art. 59 — confirme com o contador".
  - Emitente SIMPLES nos demais casos: `cst:"900"` sem valores e `requerRevisao: true`.
  - Emitente NORMAL: copia CST e alíquota do fornecedor, proporcional, sem revisão (é o estorno do crédito).
  - IPI com `vIPI > 0`: `ipiDevol` ligado, com `requerRevisao: true` ("sua empresa é contribuinte do IPI?"). Se o usuário responder que sim, troca para IPI destacado.
  - PIS/COFINS: SIMPLES → "49" sem revisão; NORMAL → padrão do regime com `requerRevisao: true`.
- **Fora do suportado (5.3):** `requerRevisao: true` e `motivoRevisao: "Tributação não suportada: <grupo>"`. `aplicarOverrideTributacao` não limpa esse caso, e só um override para grupo suportado libera.
- **`temIbsCbs`:** gera AVISO. O IBSCBS não é enviado, igual às notas normais de hoje; a regra UB12-10 ainda não vale em produção e o `gDevTrib` nunca é usado.

### 5.3 Grupos suportados pelos montadores atuais (lidos no código)

| Grupo | Suportado | Motivo |
|---|---|---|
| ICMS SN 102, 103, 300, 400, 500 | sim | só `orig`+`CSOSN` (`nfe-xml-builder-sefaz.service.ts:457-470`) |
| ICMS SN 900 | sim | com valores só na devolução (6.1) |
| ICMS SN 101, 201, 202, 203 | **não** | exigem pCredSN/vCredICMSSN/ST, que o montador não calcula |
| ICMS normal 00, 90 | sim | modBC/vBC/pICMS/vICMS na ordem do XSD (`:495-500`) |
| ICMS normal 40, 41, 50, 60 | sim | `orig`+`CST` (`:475-503`) |
| ICMS normal 10, 20, 30, 51, 70 | **não** | pRedBC/ST ausentes no montador |
| PIS/COFINS 01, 02, 04, 06-09, 49-56, 60-67, 70-75, 98, 99 | sim | `:535-554` |
| PIS/COFINS 03, 05 | **não** | Qtde / NT sem 05 no montador |

### 5.4 Cálculo (`calcularTributosDevolucao`) e `indFinal`

Por item, com `f = q / qOrig` quando `qOrig` é conhecido:

- `valorBruto = round2(q×vUn)`, `desconto` proporcional, `base = valorBruto − desconto`.
- **ICMS:**
  - `proporcionalAoOriginal`: `bcIcms = round2(o.vBC×f)`, `valorIcms = round2(o.vICMS×f)`, `aliquotaIcms = o.pICMS`.
  - Senão, com `pICMS` e CST 00/90/900: `bc = base` (+ frete rateado se CIF, igual a `fiscal-calculator.service.ts:85-86`) e `v = round2(bc×p/100)`.
  - SN ≠ 900 → 0, e para 101/201 **nunca** calcula crédito.
- **IPI destacado:** proporcional ou `base×pIPI`. Com `ipiDevol`, `valorIpi = 0`.
- **impostoDevol:** `pDevol = round2(f×100)`, `vIPIDevol = round2(o.ipi.vIPI×f)`. Os dois vão em `devolucaoRef` via `aplicarContextoDevolucao`.
- **PIS/COFINS:** proporcional quando vem do XML; senão alíquota × base para CST 01/02; senão 0.
- **Totais:** mesma forma de `totalizar` (`fiscal-calculator.service.ts:162-219`), mais `totalIpiDevol`. `totalNota = produtos − desconto + IPI + IPIDevol + frete`, pela regra W16.

`derivarIndFinalDevolucao`:

- VENDA_ENTRADA: espelha `ide.indFinal` da original quando é "0"/"1".
- Senão: `indIEDest === "9"` → "1" (regra 696); caso contrário → "0".

As originais do Dexo sempre saíram com "1" (`nfe-xml-builder-sefaz.service.ts:211`, `nfe-xml-builder.service.ts:54`), então na prática o valor não muda.

A rota `POST /nfe/draft/:id/calculate` ganha um ramo com flag. Com devolução gerenciada, usa `calcularTributosDevolucao` e **não** chama `updateDraft` (`fiscal.routes.ts:865-867`), que rebaixaria para DRAFT (R1). Devolve o resultado e, se a UI precisar, grava `totaisJson` com `updateMany where status in (DRAFT,REJECTED)` sem mexer no status. Sem a flag, a rota fica como está.

---

## 6. XML e JSON

A regra dos montadores: o comportamento novo é guardado pela **presença do contexto**, nunca pela env. Os montadores continuam puros.

```ts
// helper puro compartilhado (aplicar-contexto.ts)
export const contextoDevolucao = (d: NfeDraftResponse) =>
  d.finalidade === "DEVOLUCAO" && d.devolucao ? d.devolucao : null;
```

### 6.1 Montador SEFAZ (`app/fiscal/sefaz/nfe-xml-builder-sefaz.service.ts`)

| Ponto | Hoje | Com `dev` |
|---|---|---|
| `build` `:165-187` | — | calcula `dev` e passa como último parâmetro opcional para `buildIde`, `buildDet`, `buildTotal`, `buildPag`; `if (modelo !== "65" && !dev) buildCobr` |
| `buildIde` `:211` | `indFinal = "1"` | `dev ? dev.indFinal : "1"` |
| `buildDet` `:436-443` | termina em `<imposto>` | depois dele: `impostoDevol` (se `vIPIDevol>0`) e **por último** `DFeReferenciado` |
| `buildIcms` SN `:457-470` | `orig`+`CSOSN` | `dev && csosn==="900" && (bc>0\|\|v>0)` ⇒ `modBC`, `vBC`, `pICMS`, `vICMS` (ordem do XSD ICMSSN900) |
| `buildIpi` `:510-522` | `cEnq 999`, `CST 50` | `dev && item.devolucaoRef?.ipi` ⇒ `cEnq`/`CST` da ref |
| `buildTotal` `:626` | `vIPIDevol "0.00"` | `dev ? fmt2(totais.totalIpiDevol ?? 0) : "0.00"` |
| `buildPag` `:736-770` | lê `pagamentosJson` | `dev` ⇒ um único `detPag` com `tPag 90` e `vPag 0.00` (871) |
| NFref | nunca emitido | continua nunca emitido (1010) |

Também atualizar o comentário de cabeçalho PL_009 (`:5`, só cosmético). Em nenhum ramo o montador lança erro por dado de devolução: a validação é toda anterior (4.1).

Forma exata do `<det>` de devolução (ordem PL_010f: prod, imposto, impostoDevol, infAdProd, obsItem, vItem, DFeReferenciado; o montador não emite infAdProd, obsItem nem vItem):

```xml
<det nItem="1">
  <prod>
    <cProd>PECA-9662</cProd><cEAN>SEM GTIN</cEAN><xProd>SENSOR ABS DIANTEIRO</xProd>
    <NCM>87089990</NCM><CFOP>1202</CFOP><uCom>UN</uCom><qCom>1.0000</qCom>
    <vUnCom>150.0000</vUnCom><vProd>150.00</vProd><cEANTrib>SEM GTIN</cEANTrib>
    <uTrib>UN</uTrib><qTrib>1.0000</qTrib><vUnTrib>150.0000</vUnTrib><indTot>1</indTot>
  </prod>
  <imposto>
    <ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS>
    <PIS><PISOutr><CST>49</CST><vBC>0.00</vBC><pPIS>0.00</pPIS><vPIS>0.00</vPIS></PISOutr></PIS>
    <COFINS><COFINSOutr><CST>49</CST><vBC>0.00</vBC><pCOFINS>0.00</pCOFINS><vCOFINS>0.00</vCOFINS></COFINSOutr></COFINS>
  </imposto>
  <!-- opcional: só com IPI devolvido por não contribuinte -->
  <impostoDevol><pDevol>50.00</pDevol><IPI><vIPIDevol>5.00</vIPIDevol></IPI></impostoDevol>
  <DFeReferenciado>
    <chaveAcesso>41260911386276000176550030000000121000000123</chaveAcesso>
    <nItem>1</nItem>
  </DFeReferenciado>
</det>
```

Variante CSOSN 900 com valores (COMPRA_SAIDA confirmada):

```xml
<ICMS><ICMSSN900><orig>0</orig><CSOSN>900</CSOSN><modBC>3</modBC><vBC>100.00</vBC><pICMS>12.00</pICMS><vICMS>12.00</vICMS></ICMSSN900></ICMS>
```

Cabeçalho:

- `<ide>…<tpNF>0</tpNF><idDest>1</idDest>…<finNFe>4</finNFe><indFinal>1</indFinal><indPres>0</indPres>…`, sem `<NFref>`.
- `<ICMSTot>…<vIPI>0.00</vIPI><vIPIDevol>5.00</vIPIDevol>…<vNF>155.00</vNF>`.
- `<pag><detPag><tPag>90</tPag><vPag>0.00</vPag></detPag></pag>`, sem `<cobr>`.

Implementação do `DFeReferenciado`, no fim de `buildDet`:

```ts
if (dev && item.devolucaoRef) {
  const ref = item.devolucaoRef;
  if (ref.impostoDevol && ref.impostoDevol.vIPIDevol > 0) {
    const idv = det.ele("impostoDevol");
    idv.ele("pDevol").txt(fmt2(ref.impostoDevol.pDevol)).up();
    idv.ele("IPI").ele("vIPIDevol").txt(fmt2(ref.impostoDevol.vIPIDevol)).up().up();
    idv.up();
  }
  const dfe = det.ele("DFeReferenciado");
  dfe.ele("chaveAcesso").txt(ref.chaveAcesso).up();
  dfe.ele("nItem").txt(String(ref.nItem)).up();
  dfe.up();
}
```

### 6.2 Montador Focus (`app/fiscal/generators/nfe-xml-builder.service.ts`)

| Ponto | Com `dev` (atribuições na **mesma posição** de hoje, para a ordem das chaves do JSON não mudar) |
|---|---|
| `:54` | `payload.consumidor_final = dev ? dev.indFinal : "1"` |
| `:134-138` `buildItems(..., dev)` | chaves novas **no fim** do item: `chave_acesso_dfe_referenciado`, `numero_item_dfe_referenciado`; com `impostoDevol`, `percentual_devolvido` e `valor_ipi_devolvido`; com CSOSN 900 com valores, `icms_modalidade_base_calculo`, `icms_base_calculo`, `icms_aliquota`, `icms_valor`; com `ref.ipi`, `ipi_situacao_tributaria`, `ipi_codigo_enquadramento_legal`, `ipi_base_calculo`, `ipi_aliquota`, `ipi_valor` |
| `:172-179` duplicatas | `&& !dev` |
| `:182-203` formas_pagamento | `dev` ⇒ `[{ forma_pagamento: "90", valor_pagamento: "0.00" }]` |
| `:205-211` notas_referenciadas | `!dev && …`, nunca enviado em devolução |

```json
{
  "natureza_operacao": "DEVOLUCAO DE VENDA",
  "forma_pagamento": "0",
  "tipo_documento": "0",
  "local_destino": "1",
  "finalidade_emissao": "4",
  "consumidor_final": "1",
  "presenca_comprador": "0",
  "...emitente/destinatário inalterados...": "",
  "items": [{
    "numero_item": "1", "codigo_produto": "PECA-9662", "descricao": "SENSOR ABS DIANTEIRO",
    "codigo_ncm": "87089990", "cfop": "1202", "unidade_comercial": "UN",
    "quantidade_comercial": "1", "valor_unitario_comercial": "150.0000", "valor_bruto": "150.00",
    "unidade_tributavel": "UN", "quantidade_tributavel": "1", "valor_unitario_tributavel": "150.0000",
    "origem": "0", "inclui_no_total": "1",
    "icms_situacao_tributaria": "102", "icms_origem": "0",
    "pis_situacao_tributaria": "49", "cofins_situacao_tributaria": "49",
    "chave_acesso_dfe_referenciado": "41260911386276000176550030000000121000000123",
    "numero_item_dfe_referenciado": "1",
    "percentual_devolvido": "50.00",
    "valor_ipi_devolvido": "5.00"
  }],
  "modalidade_frete": "9",
  "formas_pagamento": [{ "forma_pagamento": "90", "valor_pagamento": "0.00" }]
}
```

As duas últimas chaves do item (`percentual_devolvido`, `valor_ipi_devolvido`) só aparecem com IPI devolvido.

A Focus numera por conta própria (`numero_nota` não é campo dela, `:56`). Isso fica com a trilha de numeração; a devolução não depende disso.

---

## 7. Colisões e o que muda (ou não) fora do fluxo

| Ponto | Decisão |
|---|---|
| `findExistingDraft` (`nfe.repository.ts:225-235`) | `where: { userId, status:"DRAFT", modelo, ...(isNfeDevolucaoEnabled() ? { finalidade: { not: "DEVOLUCAO" } } : {}) }`. Sem a flag, o objeto é idêntico; a assinatura não muda (`tests/fiscal/nfe-draft-modelo-isolation.spec.ts:80` segue verde). Com a flag, rascunho de devolução nunca reabre em "Nova NF-e" (`nfe-draft.usecase.ts:123-124`); ele é acessado pelo saldo da original (`devolucoes[]`) ou por `?draft=` |
| `NfeDraftUseCase.update` (`nfe-draft.usecase.ts:494-522`) | com flag **e** `existing.finalidade === "DEVOLUCAO"` (já carregado em `:500`, sem consulta extra para notas normais): busca o cabeçalho; se existir, `checarEdicaoDevolucaoGerenciada` (lista abaixo). Sem cabeçalho (devolução manual antiga), segue igual e a emissão bloqueia em D02 |
| `POST /nfe/draft` sem `orderId` | continua reaproveitando rascunho (agora sem os de devolução); a devolução tem endpoints próprios |
| `orderId` / `numeroPedido` | nunca copiados (3.1) |
| `getStats` (`nfe.repository.ts:770-831`) | **sem mudança**. O card é contador de documentos, e `valorTotal` já soma todo AUTHORIZED de qualquer tipo, inclusive notas de ENTRADA (`:804-810`). Excluir devolução mudaria o critério e os números dos tenants com notas de entrada. Em produção não há devolução autorizada (3 tentativas, todas REJECTED), então nenhum número existente se move. Um card de "valor devolvido" pode vir depois, com flag própria |
| Relatório mensal (`nfe-listing.usecase.ts:73`, `relatorio-mensal-xml.ts:75-78,120-123`) | **sem mudança**. O contador precisa de todo documento autorizado; o `nfeProc` vai literal com `finNFe=4` e `tpNF=0` e se identifica sozinho |
| `findEmitted` (`nfe.repository.ts:637-768`) | com flag: `finalidade` válida vira filtro, e cada item ganha `hasXmlAutorizado: !!r.xmlAutorizadoPath` (a coluna já está no select, `:716`; o `hasXml` de `:749` mistura com `xmlOriginalPath`). Sem flag, where, select e chaves da resposta ficam idênticos. O rótulo vem do `finalidade` já retornado (`:707`) |
| Cancelamento (`nfe-cancelamento.usecase.ts:136-151`) | nada muda no fluxo; hook opcional (flag + `nfe.finalidade === "DEVOLUCAO"`; o `findFirst` de `:50-52` já traz a linha inteira) grava `DEVOLUCAO_CANCELADA` nas originais. A liberação do saldo é automática (filtro por status) |
| `maybeAutoCreateCustomer` | `customerId` copiado da original ⇒ sem criação nova |
| Números / `shouldReuseNumero` | mesmo pipeline e mesma sequência; não há regra específica de devolução |

Lista de `checarEdicaoDevolucaoGerenciada`:

- `itens` presentes: se forem idênticos aos atuais (mesma contagem e, por posição, `codigo`, `quantidade` ±1e-4, `cfop`, `valorUnitario` ±1e-4), remove `itens` do input, sem regravar nada. Se diferirem, 409 `DEVOLUCAO_ITENS_PELO_EDITOR`. Isso mantém o "Próximo" do wizard funcionando.
- `finalidade ≠ DEVOLUCAO`, ou `tipoOperacao` incoerente com o tipo, ou `destinoOperacao` ≠ `idDest` da origem: 409.
- `companyFiscalConfigId` diferente do atual: 409.
- `pagamentosJson` com algum `meio ≠ SEM_PAGAMENTO`, ou `duplicatasJson` não vazio, ou `notasReferenciadasJson` não nulo: 409.

---

## 8. Flags, identidade com flag desligada, implantação

**Nomes:** `NFE_DEVOLUCAO_ENABLED` na API e `NEXT_PUBLIC_NFE_DEVOLUCAO_ENABLED` no front (build), ambos `=== "true"` e lidos na hora da chamada (mesmo padrão de `nfe-number-reuse.ts:24-26`).

Isso diverge da convenção de nome único deste módulo (`frete.ts:22-31`) por necessidade. A API só pode ligar **depois** do DDL, e o front só **depois** da API. Com um nome único no `.env` compartilhado, o build do front ligaria a API no próximo restart, possivelmente antes do DDL.

Com a flag desligada, o comportamento é idêntico:

- **Rotas novas:** 404 antes de tocar no banco.
- **`emit`:** nenhuma consulta nova; claim, calculadora, `loadNfe` e payload iguais; `handleAuthorized` recebe parâmetros extras `undefined`.
- **Montadores:** o guard é o contexto, que só a emissão com flag cola. Notas normais saem byte a byte iguais **com a flag ligada ou desligada**, provado por golden (seção 10).
- **Repositório:** `findExistingDraft` e `findEmitted` com objetos idênticos; `update` não busca cabeçalho; a rota de cálculo fica como está.
- **Parser:** ganha só campos opcionais, sem consumidor; os bytes do DANFE não mudam (teste).
- **Tabelas novas:** o Prisma nunca as consulta sem a flag. Não há relação em modelo quente, então o código roda antes do DDL.

Implantação:

1. Deploy com as duas flags ausentes.
2. Rodar o DDL de 1.2 no editor do Supabase e fazer as verificações.
3. Testar em homologação (Kiko: Focus, PR, SIMPLES, HOMOLOGACAO; e um tenant SEFAZ direto em homologação).
4. `NFE_DEVOLUCAO_ENABLED=true` + restart pelo runbook da VPS (sem `--update-env`).
5. `NEXT_PUBLIC_NFE_DEVOLUCAO_ENABLED=true` + build.

Rollback: desligar o front (build) e depois a API (restart). As linhas nas tabelas ficam inertes, e as devoluções autorizadas continuam documentos válidos.

---

## 9. Arquivos

**Novos:**

- `prisma/ddl/2026-09-17-nfe-devolucao.sql`
- `app/fiscal/domain/devolucao/{flags,devolucao.types,errors,chave-acesso-dv,cfop-devolucao,imposto-original,tributacao-devolucao,calculo-devolucao,saldo-devolucao,elegibilidade,validar-devolucao,montar-rascunho-devolucao,aplicar-contexto}.ts`
- `app/repositories/nfe-devolucao.repository.ts`: `findHeader`, `carregarContexto`, `linhasPorChaves`, `devolucoesAbertasPorChave`, `criarRascunho`, `substituirItens`, `atualizarCabecalho`, `claimComSaldo`, `somaAutorizadaPorChaves`
- `app/usecases/nfe-devolucao.usecase.ts`: `criarDeOriginal`, `criarManualXml`, `criarManualChaves`, `saldoDaOriginal`, `saldoPorChave`, `detalhe`, `atualizarItens`, `atualizarCabecalho`
- `app/notas-fiscais/lib/nfe-devolucao-actions.ts` (contrato do front, puro): `podeDevolver(item, flag)` = AUTHORIZED ∧ modelo 55 ∧ SAIDA ∧ finalidade≠DEVOLUCAO ∧ `hasXmlAutorizado === true`

**Alterados (aditivo, atrás de flag ou contexto):**

- `prisma/schema.prisma`: só os dois modelos novos, depois de `NfeInutilizacao` (`:2007-2024`)
- `app/interfaces/nfe.interface.ts`, `app/fiscal/domain/nfe.types.ts`: campos opcionais (2.1)
- `app/fiscal/sefaz/nfe-xml-parser.service.ts`: `ParsedIde` +3 campos opcionais
- `app/fiscal/sefaz/nfe-xml-builder-sefaz.service.ts`, `app/fiscal/generators/nfe-xml-builder.service.ts`: 6.1 e 6.2
- `app/usecases/nfe-emission.usecase.ts`: 4.2, 4.3 (chamada), 4.4
- `app/usecases/nfe-draft.usecase.ts`: guard de edição (7)
- `app/repositories/nfe.repository.ts`: `findExistingDraft` e `findEmitted`
- `app/routes/fiscal.routes.ts`: 8 rotas novas; ramo `DevolucaoError` nos catch de issue/PUT draft; ramo de devolução na rota de cálculo; `finalidade` passado ao listing
- `app/usecases/nfe-cancelamento.usecase.ts`: hook opcional de auditoria
- `.env.example`: as duas flags

---

## 10. Testes

vitest com `--pool=forks`, dublês com `vi.hoisted` e módulos mockados, no padrão de `tests/fiscal/nfe-emission-company.spec.ts:13-72`.

**Identidade primeiro, com golden:**

- **Commit 1**, no HEAD limpo: gerar goldens fixando `dhEmi`/`cNF` para os fixtures de `tests/fiscal/__helpers__/test-draft.ts`, em `tests/fiscal/__golden__/*.xml|json`. Casos: SIMPLES; LP; NFC-e 65; frete ligado e desligado; `finalidade:"DEVOLUCAO"` sem contexto; Focus com `notasReferenciadasJson`. Specs `nfe-xml-builder-sefaz-golden.spec.ts` e `nfe-xml-builder-focus-golden.spec.ts` passando.
- **Commits seguintes:** os mesmos specs precisam continuar verdes com `NFE_DEVOLUCAO_ENABLED` indefinida e com `"true"` (`vi.stubEnv`).

**Puros** (`tests/fiscal/devolucao/`):

- `chave-acesso-dv.spec.ts`:
  - DV idêntico a `calcularDV` de `chave-acesso.ts:96-114` em 1.000 chaves de `montarChave`;
  - aceita prefixo `NFe`;
  - rejeita DV errado e mod ≠ 55;
  - checagem de fronteira: o fonte do módulo não tem especificador `node:`.
- `cfop-devolucao.spec.ts`: conjunto exato com 105 códigos; cada entrada do mapeamento; casos de escolha; exceções 1949/2949 só em entrada; `idDestDoCfop`.
- `imposto-original.spec.ts`: ICMSSN102/500/900 com valores, ICMS00/60, IPITrib, PISOutr/PISAliq/PISNT.
- `tributacao-devolucao.spec.ts`:
  - SIMPLES com fornecedor normal ⇒ CSOSN 900 com `requerRevisao`;
  - grupos ST/20/101/PIS 03 ⇒ não suportado;
  - sem XML ⇒ revisão;
  - override com e sem confirmação.
- `calculo-devolucao.spec.ts`: proporcionalidade; `pDevol`/`vIPIDevol`; `totalNota` com IPIDevol; soma de devoluções parciais ≤ original + R$ 1.
- `saldo-devolucao.spec.ts`:
  - baldes por status; CANCELLED/REJECTED não consomem; exclui a própria nota;
  - aritmética escalada (0,1 + 0,2 exato);
  - `quantidadeOriginal null` ⇒ sem verificação.
- `validar-devolucao.spec.ts`: um caso positivo e um negativo por regra D01–D23.
- `montar-rascunho-devolucao.spec.ts`:
  - nunca copia id/chave/protocolo/xml/status/numero/orderId/numeroPedido;
  - destinatário vem de `destinatarioJson`, não do xNome de homologação;
  - `nItem` vem do XML quando `NfeItem.numero` não é posicional;
  - `tPag` 90 (`pagamentosJson []`); `idDest` espelhado; `indFinal`.

**Montadores com contexto:**

- `nfe-xml-builder-sefaz-devolucao.spec.ts`:
  - filhos de `det` na ordem `[prod, imposto, impostoDevol?, DFeReferenciado]`, com DFeReferenciado sempre por último;
  - sem `NFref`; `finNFe 4`, `tpNF 0`, `indFinal` do contexto;
  - `detPag` único 90/0.00 **mesmo** com `pagamentosJson` preenchido; sem `cobr`;
  - `vIPIDevol` no total; ICMSSN900 na ordem modBC, vBC, pICMS, vICMS.
- `nfe-xml-builder-focus-devolucao.spec.ts`: chaves novas no fim do item; sem `notas_referenciadas` mesmo com `notasReferenciadasJson`; `formas_pagamento` forçado; sem `duplicatas`.

**Casos de uso e repositório (dublês):**

- `nfe-emission-devolucao.spec.ts`:
  - flag off ⇒ `carregarContexto` e `claimComSaldo` nunca chamados, `updateMany` com os argumentos exatos de hoje;
  - flag on + bloqueio ⇒ lança **antes** de `updateMany`/`reservarProximoNumero`;
  - saldo insuficiente ⇒ nenhuma reserva;
  - caminho feliz até a `PARADA-CONTROLADA` (`persistCalculo`) com `calcularTributosDevolucao`;
  - pós-autorização grava `DEVOLUCAO_EMITIDA` na original e `DEVOLUCAO_SALDO_EXCEDIDO` no excesso, e uma falha do hook não propaga.
- `nfe-devolucao-repository-claim.spec.ts`: captura a sequência na transação (lock próprio → advisory locks em ordem → originais `FOR UPDATE` → fingerprint → soma → `updateMany` → auditoria); aborta antes do `updateMany` quando o fingerprint diverge ou o saldo falta.
- `nfe-draft-devolucao-guard.spec.ts`:
  - flag off ou nota normal ⇒ nenhuma busca de cabeçalho;
  - devolução gerenciada: itens idênticos são removidos do input; itens diferentes ⇒ 409; finalidade trocada ⇒ 409.
- `nfe-list-devolucao.spec.ts`: flag off ⇒ where, select e chaves idênticos; flag on ⇒ filtro de finalidade e `hasXmlAutorizado`.
- Parser: chaves antigas iguais em deep-equal; campos novos presentes; `danfe-from-xml.spec.ts` verde.

**Lock com Postgres real (opcional):** `tests/integration/devolucao-lock.pg.spec.ts`, com `describe.skipIf(!process.env.PG_TEST_URL)`. Faz duas `claimComSaldo` concorrentes da mesma chave e espera exatamente uma com sucesso. Não há Postgres local hoje, então fica como verificação manual quando houver um.

**Critérios de aceite:**

- `tsc --noEmit` pelo diff do multiset contra o baseline do HEAD limpo;
- `next build` (eslint `prefer-const`);
- `prisma generate` no `node_modules` compartilhado, **restaurado depois**.

---

## 11. Riscos, dependências e o que verificar antes de ligar em produção

1. **Schema de produção antes de 05/10/2026.** Não está confirmado que a produção aceita `DFeReferenciado` antes da data em que a regra passa a valer; se não aceitar, a nota cai em rejeição de schema (225, número reaproveitável). Ligar a API em produção só depois de 05/10, ou com evidência de autorização na UF. Homologação já exige a regra.
2. **Aceitação a confirmar em homologação:**
   - CSOSN 102 / PIS 49 copiados numa nota de entrada;
   - `indPres=0` com `finNFe=4`;
   - nomes dos campos da Focus (`chave_acesso_dfe_referenciado`, `numero_item_dfe_referenciado`, `percentual_devolvido`, `valor_ipi_devolvido`).
3. **Pré-requisitos da trilha de numeração:**
   - R3: o cStat em string da Focus faz a rejeição da devolução virar 500 e queimar número. Corrigir antes de ligar para tenants Focus.
   - R4/R5: notas presas em SENDING/SIGNING reservam saldo para sempre (não há reconciliador). O saldo mostra isso em `emProcessamento`, com ids.
4. **Kiko:** a rejeição 974 (UPD/PR não autoriza a Focus como responsável técnico) bloqueia qualquer emissão até o contador autorizar.
5. **Fora da v1, bloqueado com mensagem explícita:**
   - originais NFC-e (modelo 65), porque `DFeReferenciado` com chave 65 ainda não tem evidência;
   - ICMS-ST e CST 10/20/30/51/70, CSOSN 101/201-203;
   - PIS/COFINS 03/05;
   - IBS/CBS (não enviado, igual a hoje);
   - recusa ou não entrega (finNFe 5).
6. **Regra local mais estrita que a SEFAZ:** tpNF=0 exige chave com o mesmo CNPJ do emitente, e VENDA_ENTRADA exige o mesmo emitente configurado da original. Motivo: multi-CNPJ e rejeição 1193.
7. **Isolamento:** tudo filtra por `dataOwnerId`. Há dois tokens Focus compartilhados entre tenants (fato já levantado); a devolução não piora isso, mas também não corrige.