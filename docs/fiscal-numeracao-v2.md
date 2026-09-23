# Numeração NF-e V2 — operação

As flags são avaliadas no servidor a cada chamada. Habilitar exige `NFE_NUMERACAO_V2_ENABLED=true` e o ID da **configuração fiscal** em `NFE_NUMERACAO_V2_CONFIG_IDS`. Lista vazia não habilita nenhuma empresa; `*` habilita todas. O modelo padrão é 55. Focus exige também `NFE_NUMERACAO_V2_FOCUS_ENABLED=true`, que **não tem allowlist própria: lê a mesma `NFE_NUMERACAO_V2_CONFIG_IDS`** — ligá-la vale para toda config da lista, não por empresa.

## Persistência e concorrência

`NfeNumeroReserva` guarda a identidade fiscal; `NfeNumeroTentativa` registra cada transmissão. O repositório usa SQL parametrizado e transações com cliente injetável. A ordem é sequência → reserva → tentativas → nota. A reserva/reutilização e os cálculos da nota são gravados na mesma transação. Um contador nunca diminui (`GREATEST`). Não existe reaproveitamento entre documentos.

Salvar como DRAFT não libera a reserva. A mesma nota reutiliza seu número após rejeição conclusiva ou consulta madura que encerre todas as tentativas. Legado só é adotado com evidência; linhas Focus legadas não são adotadas automaticamente. Contador inicial considera chaves autorizadas/canceladas/em envio e inutilizações aceitas, não o maior número de rascunho.

O claim pré-envio usa a versão da nota; reutilizar a reserva avança sua versão. Antes da rede, o XML assinado é armazenado (SEFAZ) e a tentativa/lease é persistida. Respostas atrasadas precisam da mesma versão da reserva. Uma falha de preparação preserva o número e não registra uma transmissão.

## Situação e descarte

`POST /fiscal/nfe/:id/consultar-situacao` nunca transmite. Consulta respeita emitente, ambiente e provedor da tentativa. Timeout/resultado inconclusivo conserva a reserva. Ausência só encerra tentativa madura; a nota só é liberada quando todas estiverem encerradas. Legado SENDING sem reserva V2 não é liberado automaticamente.

`POST /fiscal/nfe/:id/issue` aceita `confirmarDescarteNumero`. Em produção, troca de empresa/ambiente/modelo/série exige confirmação. Exclusão usa `DELETE /fiscal/nfe/draft/:id?descartarNumero=true`; reserva abandonada fica fora de uso e pode exigir inutilização. Números autorizados, cancelados ou pendentes não são liberados pela exclusão.

### Focus (revisão de 22/09/2026)

A NF-e 55 na Focus é assíncrona: o POST devolve 202 `processando_autorizacao` e o resultado (autorização ou rejeição da SEFAZ) chega pela consulta. Por isso:

- a consulta usa `?completa=1`, única forma de a Focus devolver `protocolo` e `protocolo_nota_fiscal.{numero_protocolo, data_recebimento}`;
- autorização Focus vale com `status: autorizado` e chave de 44 dígitos compatível com o emitente, **mesmo sem protocolo** (o 201 síncrono e a consulta simples não trazem protocolo); no SEFAZ direto o protocolo continua obrigatório;
- rejeição, 108/109 e 656 recebidos na consulta são a resposta da MESMA tentativa: gravam motivo e cStat reais na nota e na reserva (transição INCERTO → REJEITADO/RESERVADO);
- 539/562/613 na consulta: chave citada compatível com emitente/série/número ⇒ `CONSUMIDO_EXTERNO` (a mensagem traz a chave para conferência); chave ausente ou inconsistente ⇒ `BLOQUEADO` para conferência manual. A nota nunca fica INCERTO indefinidamente;
- o payload leva `data_emissao` (obrigatório) do instante da tentativa atual, e esse mesmo instante é gravado em `NfeEmitida.dataEmissao`;
- após o 202, a V2 faz consultas curtas (`NFE_NUMERACAO_V2_FOCUS_PAUSAS_MS`, padrão 2s/3s/4s) antes de responder "em andamento";
- a referência de reemissão é alfanumérica (`<nfeId>n<numero>`).

Falha na pós-autorização (XML/DANFE/auditoria) não desfaz a autorização: fica marcada em `POS_AUTORIZACAO_PENDENTE` e é refeita na próxima consulta/replay, uma única vez (a marca de conclusão é o evento `AUTORIZADA`).

Respostas V2 incluem `numeracao` (null quando não há reserva viva) e `emAndamento`. O frontend só promete manutenção quando o servidor informa `reutilizavel`. Na Focus, a chave autorizada prevalece para número/série; divergência é realinhada sem reduzir contador. Chave incompatível com CNPJ/modelo bloqueia para conferência. A referência Focus da tentativa acompanha recuperação de XML e cancelamento.

## Responsável técnico

GET/PUT `/fiscal/config/resp-tec` ou `/fiscal/companies/:id/resp-tec`. Modos: PADRAO, PROVEDOR, PERSONALIZADO e NENHUM, limitados pelo provedor/UF/ambiente. CSRT é cifrado com `FISCAL_CERT_ENC_KEY`; a API retorna apenas `csrtConfigurado`. Token vazio preserva o segredo; remoção exige `removerCsrt`. Não registrar corpos contendo credenciais, CSRT ou XML importado.

## Rollout e rollback

1. Revisar o relatório técnico e pendências externas. As flags são fail-closed: sem `..._ENABLED=true` e sem o id na allowlist, nenhuma empresa entra na V2. Em produção, desde 22/09/2026, `NFE_NUMERACAO_V2_ENABLED=true` com **uma única config na allowlist** (DLS AUTO PEÇAS, `cmr9omjlt30xw18jqt3m5oyc3`, modelo 55); `NFE_NUMERACAO_V2_FOCUS_ENABLED`, `NFE_DEVOLUCAO_ENABLED` e `NFE_RESP_TEC_EMPRESA_ENABLED` seguem desligadas, e todo o resto da base continua no V1. Para incluir outra empresa, **acrescentar** o id à lista: redefinir a variável com um id só retira a DLS da V2.
2. Com autorização operacional separada, aplicar os três DDLs versionados de 18/09/2026 e verificar índices/constraints/RLS. Nunca usar `prisma db push`.
3. Executar o diagnóstico somente leitura e revisar divergências históricas. Nenhuma correção histórica é automática.
4. Validar em homologação, em série dedicada, com autorização explícita para emissão. Habilitar primeiro uma configuração.
5. Focus só entra no canário após confirmar comportamento de número/série/ref com o fornecedor.
6. Rollback: retirar a configuração da allowlist (ou a sub-flag Focus) — **não** desligar `NFE_NUMERACAO_V2_ENABLED`, senão o ledger deixa de ser consultado no cancelamento e na exclusão. Nota com reserva viva numa config fora da V2 responde 409 `NUMERACAO_EMITENTE_FORA_V2` (emitir pelo V1 deixaria o número órfão); libere reativando a empresa ou descartando o número na exclusão. Trocar ambiente/token com nota pendente de consulta responde 409. Não apagar reservas ou tentativas. Antes de alternar Focus/V1, consultar envios pendentes e preservar a referência registrada; não renumerar automaticamente documentos incertos.

Tabela V2 ausente é detectada **antes do claim** e conserva o caminho V1 para notas comuns. Devolução habilitada nunca cai para emissão V1. Falha após mutação V2 não dispara fallback.

### Canário em produção (22–23/09/2026)

Ativada em 22/09/2026 para a DLS AUTO PEÇAS (`cmr9omjlt30xw18jqt3m5oyc3`, modelo 55); VPS no commit `21270f2`. Com a sub-flag Focus desligada, o canário corre pelo **SEFAZ direto** — é o único provedor que `isNumeracaoV2ParaEmissao` libera nessa configuração.

Primeira emissão real em 23/09/2026. A nota 710 levou três tentativas — cStat 232, 232 e então 100, autorizada, protocolo `242260451012429` — **mantendo o mesmo número e a mesma chave de acesso**. A nota 711 autorizou de primeira. O contador foi de 710 para 712: nenhum número queimado, que é a invariante que a V2 existe para sustentar.

A chave se repete entre as tentativas porque **o `cNF` mora na reserva, não na tentativa**. Isso é deliberado: sortear um `cNF` novo na retransmissão geraria uma segunda chave para o mesmo (CNPJ, modelo, série, nNF), e é exatamente esse par chave-nova/número-repetido que a SEFAZ devolve como cStat 539. Reenviar a chave idêntica, no pior caso, volta como 204.

## Diagnóstico e testes locais

`scripts/fiscal/diagnostico-numeracao-nfe.ts` exige DATABASE_URL explícita e abre transação `READ ONLY`. Produz JSON/CSV em `scripts/out`; lista divergências, emissões antigas, intervalos candidatos, reservas pendentes, empresas PR/produção e compartilhamento de tokens (sem retornar token ou fingerprint). Intervalos candidatos precisam de conferência fiscal: não autorizam inutilização.

Os testes PostgreSQL são opt-in por `NFE_TEST_DATABASE_URL`: somente localhost e banco com `nfe_test` no nome. Criam schema aleatório, aplicam DDL local e removem apenas esse schema. Não apontar testes a produção. A suíte normal usa fake com mutex/rollback e transportes simulados.

## Dependências externas

Focus: confirmar CNPJ do RT, CSRT no PR, respeito a número/série explícitos, re-POST da mesma ref após rejeição, resposta a duplicidade, evolução do contador interno e webhook. Kiko: verificar token do ambiente, habilitação da empresa e autorização de uso do fornecedor no UPD com o contador. Tributos da devolução dependem de revisão do responsável fiscal quando sinalizados. Nenhum desses itens é provado por testes de código.

Notas presas: **zero**. As 14 que restavam foram encerradas em 23/09/2026, depois de a auditoria provar que **nenhuma chegou a ser transmitida à SEFAZ** — todas pararam antes do envio (CA bundle local ausente, token Focus inválido, empresa não habilitada na Focus). Fechadas como `REJECTED` com o motivo real e **`cStatRejeicao` nulo**, porque não houve rejeição da SEFAZ para registrar; backup em `ops_backup.nfe_presas_sending_20260923`. ⚠️ Fechar a nota **não devolve o número ao contador**: os números 8–10 da série 3 da Kiko seguem livres na SEFAZ mas viram vão na numeração do Dexo (inutilização disponível até 10/10/2026). Nenhuma faixa foi liberada automaticamente. Kiko 4x4 e VN Motors (cujo CNPJ padrão é o da Veiga Auto Peças LTDA, 65416054000188) seguem **ativos e usando o sistema** — nenhum dos dois cancelou, e "Veiga" não é um cliente.
