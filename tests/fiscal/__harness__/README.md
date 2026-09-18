# Harness de emissão fiscal (F0)

Dirige o `NfeEmissionUseCase.emit` **real** de ponta a ponta, passando do
provider, sem banco, sem rede e sem certificado. É a base dos specs de
caracterização (`tests/fiscal/golden/emit-v1-bug-reproducao.spec.ts`) e dos
cenários da numeração V2.

| Arquivo | O que é |
|---|---|
| `in-memory-prisma.ts` | `createInMemoryPrisma()`: double do `prisma` com colunas do schema de 1549bc4, uniques parciais de produção (P2002), FK (P2003), cascata, `updateMany` atômico, `$transaction(fn)` com diário de desfazer, SQL cru plugável |
| `fake-authority.ts` | "verdade da SEFAZ" por (cnpj, ambiente, modelo, série, número): autorizada, cancelada, inutilizada, denegada; regras 100/204/539/206/205/218/217 |
| `scripted-provider.ts` | `createScriptedProvider()`: `INfeProvider` com fila de passos por operação e registro de chamadas; `passos.*` no formato exato dos providers reais |
| `numeracao-memory.ts` | `NfeSequenceService` V1 em memória (contrato público) com mutex por chave no lugar do `FOR UPDATE` |
| `invariants.ts` | Invariantes I1, I2, I5 e I3 do V1, como funções puras |
| `emit-world.ts` | `world()`: singleton com estado, seeds, fakes de storage/factory/DANFE/cliente e `modules` prontos para `vi.mock` |
| `harness.spec.ts` | Autoteste dos doubles (roda com a suíte) |

## Wiring num spec

Os arquivos do harness **não** chamam `vi.mock` (ele só sobe dentro do próprio
spec). As fábricas são assíncronas e importam o mundo de forma **lazy**. A
função `W` precisa de `vi.hoisted`, porque as fábricas sobem para o topo do
arquivo:

```ts
const W = vi.hoisted(() => () => import("../__harness__/emit-world").then((m) => m.world()));

vi.mock("../../../app/lib/prisma", async () => (await W()).modules.prisma);
vi.mock("@/app/lib/prisma", async () => (await W()).modules.prisma);
vi.mock("../../../app/fiscal/sequence/nfe-sequence.service", async () => (await W()).modules.sequenceV1);
vi.mock("../../../app/fiscal/providers/provider-factory", async () => (await W()).modules.providerFactory);
vi.mock("../../../app/fiscal/storage/fiscal-storage.service", async () => (await W()).modules.storage);
vi.mock("../../../app/fiscal/generators/danfe-pdf.service", async () => (await W()).modules.danfePdf);
vi.mock("../../../app/fiscal/generators/danfe-nfce-pdf.service", async () => (await W()).modules.danfeNfcePdf);
vi.mock("../../../app/repositories/customer.repository", async () => (await W()).modules.customerRepository);
vi.mock("../../../app/usecases/customer.usecase", async () => (await W()).modules.customerUseCase);

import { NfeEmissionUseCase } from "../../../app/usecases/nfe-emission.usecase";
import { NfeRepository } from "../../../app/repositories/nfe.repository"; // REAL
import { world } from "../__harness__/emit-world";
import { passos } from "../__harness__/scripted-provider";

const w = world();
beforeEach(() => {
  w.reset();
  vi.stubEnv("NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED", "true"); // valor de produção
  vi.stubEnv("SEFAZ_AUTO_FALLBACK_ENABLED", "false");
});
```

`NfeRepository` e `CompanyFiscalRepository` ficam **reais**, sobre o prisma em
memória. A R1 mora no `updateDraft` e só aparece assim.

### Regras que evitam carregamento circular

- Nenhum arquivo de `__harness__` importa, em tempo de execução, um módulo que
  os specs mockam. `import type` pode, porque é apagado na compilação.
- `world()` é um singleton **por arquivo de spec**: o vitest isola o grafo de
  módulos por arquivo. A fábrica do mock e o `import { world }` estático do
  spec recebem a mesma instância.
- `w.reset()` limpa o estado por dentro e nunca troca `w.modules` nem
  `w.prisma`, que as fábricas já entregaram ao código de produção.

## Uso típico

```ts
const cfg = w.seedConfig({ providerName: "SEFAZ_DIRECT" }); // Focus: token sentinela
w.seedAutorizada(100, { config: cfg });                      // linha AUTHORIZED + autoridade
w.setProximoNumero(101, { config: cfg });
const X = w.seedDraft({ config: cfg });                      // placeholder -(DRAFTs+1)

w.provider.fila("emitir", passos.rejeitar(225, "Rejeicao: ...", { autoridade: w.authority }));
await new NfeEmissionUseCase().emit(cfg.userId, X);

w.row(X);                          // linha atual (cópia)
w.audit(X);                        // ["NUMERADA", "ENVIADA", "REJEITADA"]
w.numerada(X);                     // números de cada NUMERADA
w.proximoNumero({ config: cfg });  // contador
w.authority.numerosAutorizados();  // o que a "SEFAZ" consumiu
w.assertInvariantes();
```

Falhas injetáveis:
- `w.storage.failNext("saveXmlOriginal")`
- `w.providerFactory.failNext()` (certificado ilegível)
- `w.db.falharProxima("nfeEmitida.update", erro, (args) => "numero" in args.data)`
- `passos.lancar(err)`, `passos.erro(msg)` (formato pré-envio/rede do SEFAZ direto)
- `passos.segurar()` (requisição em voo; `chegou` e `liberar(passo)`)

Polling (Focus `processando`, SEFAZ 103): `await w.comTimersFalsos(() => uc.emit(u, id))`
avança setTimeout de 3 s em 3 s até a promessa assentar.

Corridas determinísticas: `w.reset({ intercalar: true, semente: n })` faz cada
operação do prisma esperar de 0 a 3 microtasks, sorteadas por PRNG com semente.
Timers não entram.

## Pontos de extensão para a numeração V2

1. **Repositório da V2 por SQL cru.** Registre um handler que reconheça os
   statements do `numeracao.repository.ts` e mantenha as tabelas
   `NfeNumeroReserva`/`NfeNumeroTentativa` em memória:
   ```ts
   w.db.aoSqlCru((c, db) => {
     if (!/"NfeNumeroReserva"/.test(c.sql)) return SQL_NAO_TRATADO;
     // ... aplica, e para acompanhar rollback de $transaction:
     c.registrarDesfazer(() => { /* reverte o estado do fake */ });
     return linhas;
   });
   ```
   SQL que nenhum handler trata lança `InMemoryPrismaSqlCruNaoTratado`. É
   assim que a regra "flag desligada, nenhum statement a mais" (I8) aparece
   num teste.
2. **Repositório injetável.** Se a V2 aceitar `db`/repositório por injeção,
   passe `w.prisma` ou um fake que implemente a interface do repositório. Nesse
   caso não precisa de `vi.mock`. O mutex por chave de `numeracao-memory.ts`
   (`MutexPorChave`) modela o `FOR UPDATE`.
3. **Provider em duas fases / cliente Focus V2.** Adicione as operações novas
   (`prepararEmissao`, `transmitirPreparada`, `consultarDetalhado`…) a
   `OperacaoProvider` e ao objeto de `createScriptedProvider`, seguindo o mesmo
   padrão de fila, e exponha o módulo em `w.modules`.
4. **Tabelas novas no double.** Enquanto o DDL não existir, deixe-as **fora**
   de `SCHEMA`. Acesso por delegate lança "não suportado"/"Unknown argument",
   o que prova que o V1 não toca nelas. Para simular "DDL aplicado", registre o
   handler do item 1.
5. **Invariantes V2** (I1 a I8 do plano §4.2) entram em `invariants.ts` como
   funções puras novas, somadas em `todasViolacoes`.

## O que o harness não prova

- Semântica real de lock e isolamento do Postgres. Isso fica na suíte PG opt-in (`tests/fiscal/pg`).
- `$transaction([...])` em lote: as promessas já rodaram pelo cliente raiz, então o double só aguarda.
- Filtros por relação, agregações e `distinct`. Todos lançam "não suportado"; se o código de produção passar a usar, estenda o double.
