# Numeração NF-e V2 — operação

As flags são avaliadas no servidor a cada chamada. Habilitar exige `NFE_NUMERACAO_V2_ENABLED=true` e o ID da **configuração fiscal** em `NFE_NUMERACAO_V2_CONFIG_IDS`. Lista vazia não habilita nenhuma empresa; `*` habilita todas. O modelo padrão é 55. Focus exige também `NFE_NUMERACAO_V2_FOCUS_ENABLED=true`.

## Persistência e concorrência

`NfeNumeroReserva` guarda a identidade fiscal; `NfeNumeroTentativa` registra cada transmissão. O repositório usa SQL parametrizado e transações com cliente injetável. A ordem é sequência → reserva → tentativas → nota. A reserva/reutilização e os cálculos da nota são gravados na mesma transação. Um contador nunca diminui (`GREATEST`). Não existe reaproveitamento entre documentos.

Salvar como DRAFT não libera a reserva. A mesma nota reutiliza seu número após rejeição conclusiva ou consulta madura que encerre todas as tentativas. Legado só é adotado com evidência; linhas Focus legadas não são adotadas automaticamente. Contador inicial considera chaves autorizadas/canceladas/em envio e inutilizações aceitas, não o maior número de rascunho.

O claim pré-envio usa a versão da nota; reutilizar a reserva avança sua versão. Antes da rede, o XML assinado é armazenado (SEFAZ) e a tentativa/lease é persistida. Respostas atrasadas precisam da mesma versão da reserva. Uma falha de preparação preserva o número e não registra uma transmissão.

## Situação e descarte

`POST /fiscal/nfe/:id/consultar-situacao` nunca transmite. Consulta respeita emitente, ambiente e provedor da tentativa. Timeout/resultado inconclusivo conserva a reserva. Ausência só encerra tentativa madura; a nota só é liberada quando todas estiverem encerradas. Legado SENDING sem reserva V2 não é liberado automaticamente.

`POST /fiscal/nfe/:id/issue` aceita `confirmarDescarteNumero`. Em produção, troca de empresa/ambiente/modelo/série exige confirmação. Exclusão usa `DELETE /fiscal/nfe/draft/:id?descartarNumero=true`; reserva abandonada fica fora de uso e pode exigir inutilização. Números autorizados, cancelados ou pendentes não são liberados pela exclusão.

Respostas V2 incluem `numeracao` e `emAndamento`. O frontend só promete manutenção quando o servidor informa `reutilizavel`. Na Focus, a chave autorizada prevalece para número/série; divergência é realinhada sem reduzir contador. Chave incompatível com CNPJ/modelo bloqueia para conferência. A referência Focus da tentativa acompanha recuperação de XML e cancelamento.

## Responsável técnico

GET/PUT `/fiscal/config/resp-tec` ou `/fiscal/companies/:id/resp-tec`. Modos: PADRAO, PROVEDOR, PERSONALIZADO e NENHUM, limitados pelo provedor/UF/ambiente. CSRT é cifrado com `FISCAL_CERT_ENC_KEY`; a API retorna apenas `csrtConfigurado`. Token vazio preserva o segredo; remoção exige `removerCsrt`. Não registrar corpos contendo credenciais, CSRT ou XML importado.

## Rollout e rollback

1. Revisar o relatório técnico e pendências externas. As flags permanecem desligadas por padrão.
2. Com autorização operacional separada, aplicar os três DDLs versionados de 18/09/2026 e verificar índices/constraints/RLS. Nunca usar `prisma db push`.
3. Executar o diagnóstico somente leitura e revisar divergências históricas. Nenhuma correção histórica é automática.
4. Validar em homologação, em série dedicada, com autorização explícita para emissão. Habilitar primeiro uma configuração.
5. Focus só entra no canário após confirmar comportamento de número/série/ref com o fornecedor.
6. Rollback: retirar a configuração da allowlist. Não apagar reservas ou tentativas. Antes de alternar Focus/V1, consultar envios pendentes e preservar a referência registrada; não renumerar automaticamente documentos incertos.

Tabela V2 ausente é detectada **antes do claim** e conserva o caminho V1 para notas comuns. Devolução habilitada nunca cai para emissão V1. Falha após mutação V2 não dispara fallback.

## Diagnóstico e testes locais

`scripts/fiscal/diagnostico-numeracao-nfe.ts` exige DATABASE_URL explícita e abre transação `READ ONLY`. Produz JSON/CSV em `scripts/out`; lista divergências, emissões antigas, intervalos candidatos, reservas pendentes, empresas PR/produção e compartilhamento de tokens (sem retornar token ou fingerprint). Intervalos candidatos precisam de conferência fiscal: não autorizam inutilização.

Os testes PostgreSQL são opt-in por `NFE_TEST_DATABASE_URL`: somente localhost e banco com `nfe_test` no nome. Criam schema aleatório, aplicam DDL local e removem apenas esse schema. Não apontar testes a produção. A suíte normal usa fake com mutex/rollback e transportes simulados.

## Dependências externas

Focus: confirmar CNPJ do RT, CSRT no PR, respeito a número/série explícitos, re-POST da mesma ref após rejeição, resposta a duplicidade, evolução do contador interno e webhook. Kiko: verificar token do ambiente, habilitação da empresa e autorização de uso do fornecedor no UPD com o contador. Tributos da devolução dependem de revisão do responsável fiscal quando sinalizados. Nenhum desses itens é provado por testes de código.
