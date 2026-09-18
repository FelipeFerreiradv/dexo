# Continuidade Dexo NF-e — relatório técnico

Data: 18/09/2026. Prioridade final solicitada: viabilizar emissão Focus e documentar a ativação com economia de execução.

## 1. Resultado e limites da entrega

Implementados os caminhos de numeração V2, responsável técnico por empresa, devolução fiscal, orquestração, interface e diagnóstico. A emissão Focus V2 está integrada e passou em testes com transporte simulado. **Não houve emissão real nem implantação; não declarar a conta do cliente homologada.** A validação em PostgreSQL real e a homologação operacional continuam pendentes. Roteiro prioritário: [emissão Focus](../roteiro-emissao-focus-nfe.md).

## 2. Estado do repositório

Worktree `receivable-stock-listing-sync-9b376d`, branch `claude/dexo-nfe-module-evolution-3abbea`, HEAD `1549bc462e3f6e05280628fa401684f05449f028`. Alterações anteriores foram preservadas; nenhuma alteração foi commitada ou enviada. `.codex/config.toml` e seu backup foram preservados. Não foi criado `.env`. Base limpa reconstruída em `tsc-base-1549bc4` para comparação.

## 3. P1 — persistência da numeração

Serviço e repositório SQL parametrizado com cliente injetável; fake com mutex e rollback. Reserva por nota, isolamento por configuração/ambiente/modelo/série, contador crescente, evidência para legado, leases, tentativas duráveis, cancelamento, abandono, inutilização e referências Focus. Versão da reserva impede resposta atrasada. Confirmação de descarte e identificação do ator são persistidas em auditoria transacional. Não existe pool de números abandonados.

## 4. P2 — responsável técnico

Repositório, resolver, validação, CSRT criptografado, GET/PUT por empresa e card de configuração. Resposta pública contém apenas indicação de segredo configurado. Token vazio preserva; exclusão é explícita. Resolução Focus delega RT ao provedor; cadastrar CSRT no Dexo não corrige automaticamente a configuração do fornecedor.

## 5. P3 e P5 — devolução fiscal

Criação manual por XML/chave e a partir da original, edição de quantidades e tributação, saldo, parser e contexto de emissão. Referências ITEM/NOTA exclusivas, pagamento 90 e devolução de IPI. Validação antes do claim e revalidação do saldo sob lock na transação da reserva; cancelamento da original protegido por lock comum. Vínculos e auditoria após autorização. Nenhuma movimentação de estoque foi adicionada.

## 6. P4 — emissão V2 e Focus

Despacho por flags/configuração/modelo/provedor; cálculo e contexto antes do hash. Persistência da tentativa antes da rede; classificação, reconciliação, consulta madura e proteção de respostas tardias. Payload Focus envia `numero` e `serie`; referência persistida é reutilizada quando cabível. Leitura da chave autorizada realinha numeração e contador sem reduzir sequência. Timeout não gera reenvio automático. Integrações com cancelamento, inutilização e PDV preservam o despacho V1 fora do escopo.

## 7. P6 — interface

Wizard existente reutilizado para devolução, revisão tributária e pagamento; ações em lista/detalhe. Consulta de situação e indicação de número mantido vêm de metadados do servidor. Descarte exige ação explícita. Guards síncronas protegem emissão e ações contra duplo clique. Componentes novos dependem das capacidades retornadas pela API. Compilação verificada; sessão interativa de UAT no navegador não foi executada.

## 8. P7 — operação e diagnóstico

Documentados rollout, rollback, flags, tabelas e pendências; `.env.example` mantém recursos desligados. Diagnóstico usa transação `READ ONLY`, não carrega `.env`, não consulta provedores e não efetua correções. Relata contadores, intervalos sem consumo registrado, retenções, histórico NUMERADA, divergências e tokens compartilhados sem expor os tokens. Intervalos excluem inutilizações aceitas e continuam exigindo conferência humana. Script não foi executado contra banco real.

## 9. Testes e gates

| Verificação | Resultado |
|---|---|
| Suíte completa na base limpa | 6.633 testes aprovados; zero falhas |
| Suíte completa no worktree | 7.937 testes aprovados; zero falhas |
| Fiscal + adjacentes após correções | 2.302 aprovados; 2 PostgreSQL ignorados; 105 arquivos aprovados |
| Numeração após ajustes finais de auditoria/timeouts | 881 aprovados; 2 PostgreSQL ignorados |
| TypeScript comparado como multiconjunto | 98 erros preexistentes na base e no head; zero novos, zero removidos |
| ESLint de TS/TSX alterados e novos, com `--no-ignore` | Aprovado; apenas aviso da configuração legada do ESLint |
| Next build flags off/on | Ambos aprovados; allowlist sentinela ausente do bundle público |
| Prisma validate | Aprovado |
| git diff --check | Aprovado |
| PostgreSQL real isolado | Não executado: engine Docker local indisponível |

A suíte completa foi executada uma vez por versão; correções posteriores receberam os checks afetados. Os dois builds finais precedem apenas os ajustes de timeouts/cooldown no backend e diagnóstico, verificados por testes afetados, TypeScript e lint. Não foram repetidos builds sem alteração de frontend.

Evidência compacta: [11-EVIDENCIAS-GATES.json](11-EVIDENCIAS-GATES.json). Logs detalhados desta máquina em `%TEMP%/nfe-*`; não são artefatos permanentes de CI.

## 10. Cenários e revisão adversarial

**Cenário obrigatório aprovado nos dois provedores simulados: 100 autorizada / 101 erro / 101 retry / 101 autorizada / 102 próxima.** Cobertura adicional de concorrência, rollback, preservação após DRAFT, troca confirmada, legado, duplo clique, falha pré-envio, timeout, maturidade, takeover, resposta tardia e divergência Focus. Goldens V1 passaram.

A revisão corrigiu hash instável após persistência dos cálculos, omissão de número/série no payload Focus, fencing de preparação/reutilização, cooldown, preservação da chave referida em duplicidade, cálculo de devolução na rota correta e uso dos timeouts configuráveis. Não há evidência de homologação real dos cenários 1–14; a evidência disponível é automatizada local, com mocks/fakes e classificadores.

## 11. Pendências externas e de validação

**Focus:** confirmar respeito a número/série, reenvio da mesma referência após rejeição, contador interno e RT/CSRT para a empresa/UF. **Kiko:** confirmar credenciais do ambiente, habilitação do CNPJ e autorização do fornecedor no UPD com o contador. Tokens compartilhados entre tenants, reportados no handoff anterior, não foram alterados. Estas pendências podem bloquear emissão e não são resolvidas pelos testes.

**Validação local pendente:** executar os dois testes PostgreSQL em banco local isolado (`NFE_TEST_DATABASE_URL`, host local e banco `nfe_test`); validar as telas interativamente. Por isso, P8 não deve ser registrado como validação integral concluída em banco real.

## 12. Próxima ação para atender o cliente

Seguir [o roteiro Focus](../roteiro-emissao-focus-nfe.md): confirmar a conta do emitente, preparar implantação/DDL autorizados, habilitar somente a configuração piloto, homologar e então liberar produção. Não foram realizados SSH, DDL remoto, commit, push, deploy, emissão fiscal real ou início de workers. Essas ações permanecem separadas conforme a autorização definida pelo usuário.
