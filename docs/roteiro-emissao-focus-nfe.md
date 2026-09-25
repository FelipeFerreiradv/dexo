# Roteiro para emitir NF-e pela Focus no Dexo

## O que está pronto

O código local integra a Focus ao fluxo V2 e passou nos testes simulados de emissão, rejeição, correção com o mesmo número e próxima numeração. Implantado na VPS pelo PR #353 em 18/09/2026, com os DDLs aplicados e smoke aprovado; em 25/09/2026 a VPS roda o commit `db6fbd14`. Desde 22/09/2026 a numeração V2 está **ligada em produção para uma única configuração fiscal**, a DLS AUTO PEÇAS (`cmr9omjlt30xw18jqt3m5oyc3`, modelo 55), e em 23/09/2026 ela autorizou notas reais dessa empresa. Desde 24/09/2026 a devolução também está ligada, só para essa config. **Isso não é homologação da Focus:** `NFE_NUMERACAO_V2_FOCUS_ENABLED` continua `false`, e com a sub-flag desligada só o SEFAZ direto passa pelo V2 (`isNumeracaoV2ParaEmissao`, em `app/fiscal/flags.ts`). As confirmações da Focus seguem pendentes e nenhuma empresa emite pela Focus com numeração V2. Consulte o [registro do deploy](handoff-nfe-evolucao/12-DEPLOY-VPS.md) e a evidência do canário em [operação da numeração V2](fiscal-numeracao-v2.md).

## 1. Conferir a empresa na Focus

Confirme com quem administra a conta Focus que o CNPJ emissor está habilitado, com certificado e dados fiscais configurados, e obtenha a credencial do **ambiente correto**. Não envie o token por chat nem o coloque em documentação.

Para a Kiko/PR, o handoff registra pendências de autorização do fornecedor no UPD e de responsável técnico/CSRT na Focus. Confirme com o contador e suporte Focus se foram resolvidas. Rejeição relacionada a essas configurações pode continuar mesmo com o Dexo atualizado. Não substitua o CNPJ do responsável técnico por um valor presumido.

Confirme também com a Focus que a conta aceita o número/série explícitos, a mesma `ref` após correção de rejeição e o comportamento esperado do contador. Estes pontos são condições do canário V2.

## 2. Preparar a versão e o banco — responsável técnico pela implantação

A versão foi publicada pelo PR #353, commit `84b915d`. Os três DDLs abaixo já foram aplicados e verificados na VPS; não é necessário reaplicá-los para este canário.

Após autorização operacional, publicar esta versão e aplicar os DDLs aditivos revisados:

- `prisma/ddl/2026-09-18-nfe-numeracao-v2.sql`
- `prisma/ddl/2026-09-18-company-fiscal-resp-tec.sql`
- `prisma/ddl/2026-09-18-nfe-devolucao.sql`

Os dois testes PostgreSQL também foram concluídos em banco local isolado após iniciar o Docker Desktop. Não usar `prisma db push`. Conferir a existência das tabelas/índices depois do DDL. A ausência das tabelas pode fazer notas comuns seguirem pelo V1; **uma emissão aceita, sozinha, não comprova que o V2 foi ativado**.

## 3. Configurar a empresa no Dexo

Na área **Notas fiscais**, abra a configuração fiscal da empresa emissora:

1. Confira CNPJ, inscrição estadual, regime tributário, endereço e série com o responsável fiscal.
2. Na etapa de ambiente, selecione **Focus NFe** como provedor.
3. Comece em **Homologação** e informe o **Token do provedor** correspondente.
4. Salve a configuração. Token em branco em edições seguintes mantém o valor já salvo; ao mudar de ambiente, informe a credencial correta.
5. O certificado usado pela Focus é configurado no lado do fornecedor. O upload de certificado do Dexo atende ao caminho SEFAZ Direto.

Se o card de responsável técnico por empresa estiver habilitado, use o modo **PROVEDOR** para Focus. O Dexo não envia CSRT próprio à Focus. Para o primeiro teste de NF-e comum, não é necessário habilitar devolução nem RT por empresa.

## 4. Habilitar V2 somente para a empresa piloto — servidor

⛔ Esta seção só vale depois de cumpridos os [pré-requisitos da trilha Focus](#pré-requisitos-da-trilha-focus). Até lá, `NFE_NUMERACAO_V2_FOCUS_ENABLED` fica `false` e nenhuma config Focus entra na V2.

Obtenha o `id` da configuração fiscal (`CompanyFiscalConfig.id`) pela resposta autenticada de `GET /fiscal/config` ou pela configuração da empresa em `/fiscal/companies`. **Não use o userId, CNPJ ou companyId.**

**A allowlist já não está vazia em produção: ela contém a DLS AUTO PEÇAS (`cmr9omjlt30xw18jqt3m5oyc3`) e, depois da fase A do plano de 25/09/2026, a lista explícita das configs SEFAZ direto.** Quem *definir* `NFE_NUMERACAO_V2_CONFIG_IDS` com o id de um cliente novo **retira as demais da V2 sem perceber**, e as notas delas com número reservado passam a responder 409 `NUMERACAO_EMITENTE_FORA_V2` (ver "Retorno ao estado anterior"). Um cliente novo se **acrescenta** à lista existente, separado por vírgula, partindo do valor atual da linha no `.env` (não do exemplo deste roteiro):

```dotenv
NFE_NUMERACAO_V2_CONFIG_IDS=<lista atual>,ID_DA_CONFIGURACAO_FISCAL
```

Config Focus não entra em `NFE_DEVOLUCAO_CONFIG_IDS`: com a sub-flag desligada, a devolução dela termina em 422 `EXIGE_NUMERACAO_V2`.

**`NFE_NUMERACAO_V2_FOCUS_ENABLED` não tem allowlist própria: usa a MESMA `NFE_NUMERACAO_V2_CONFIG_IDS`** (`ENV_ALLOWLIST` em `app/fiscal/flags.ts`). Ligá-la não é uma decisão sobre a empresa piloto: vale de uma vez para toda config da lista que emita pela Focus.

Estado configurado no ambiente do processo da API em 25/09/2026 (numeração desde 22/09, devolução desde 24/09):

```dotenv
NFE_NUMERACAO_V2_ENABLED=true
NFE_NUMERACAO_V2_CONFIG_IDS=cmr9omjlt30xw18jqt3m5oyc3
NFE_NUMERACAO_V2_MODELOS=55
NFE_NUMERACAO_V2_FOCUS_ENABLED=false
NFE_DEVOLUCAO_ENABLED=true
NFE_DEVOLUCAO_CONFIG_IDS=cmr9omjlt30xw18jqt3m5oyc3
NFE_RESP_TEC_EMPRESA_ENABLED=false
# NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE ausente: vale o padrão 2026-10-05
```

Na fase A do plano de ligação, `NFE_NUMERACAO_V2_CONFIG_IDS` e `NFE_DEVOLUCAO_CONFIG_IDS` passam a ter a mesma lista explícita das configs `SEFAZ_DIRECT`, nenhuma Focus: a devolução liga junto com a numeração (decisão do dono, 25/09/2026). O procedimento, com gate de pré-voo e rollback, está em [operação da numeração V2](fiscal-numeracao-v2.md).

Passar `NFE_NUMERACAO_V2_FOCUS_ENABLED=true` só depois de todos os pré-requisitos abaixo; enquanto estiver `false`, apenas o SEFAZ direto passa pelo V2. **Nunca** com `NFE_NUMERACAO_V2_CONFIG_IDS=*`.

Recarregue só a API, depois do gate de pré-voo estrito: `pm2 restart dexo-api`, sem `--update-env` e sem `restart all`. Lista vazia não habilita nenhuma empresa; nunca usar `*`. Não criar `.env` no worktree de desenvolvimento. Flags são de servidor e não usam `NEXT_PUBLIC_`.

### Pré-requisitos da trilha Focus

Antes de qualquer `NFE_NUMERACAO_V2_FOCUS_ENABLED=true`, todos estes itens:

1. **218/420 e 206/563 idempotentes no V2.** O V1 já trata "já cancelada" (218/420) e "já inutilizada" (206 em faixa de um número só, e 563) como sucesso; o cliente Focus V2 ainda os trata como falha. Sem isso, nota cancelada na SEFAZ fica `AUTHORIZED` no Dexo e a faixa inutilizada nunca fica aceita. A correção passa pelo ledger, no cliente V2 e no caso de uso, com prova pela consulta.
2. **Allowlist própria da Focus**, fail-closed e exigida além de `NFE_NUMERACAO_V2_CONFIG_IDS`. Hoje a sub-flag lê a mesma lista da V2 e liga de uma vez toda config Focus que estiver nela.
3. **Troca de token com nota pendente.** Com nota INCERTO e o token revogado na Focus, a consulta volta 401 e a troca de credencial é recusada com 409: a empresa para de emitir. É preciso liberar a troca do token (não do ambiente) quando a consulta pendente respondeu 401/403.
4. **Numeração real medida por config.** No V1 quem numera é a Focus, e o contador do Dexo é fictício; a V2 manda número explícito. Antes de ligar, comparar o maior nNF real (chaves autorizadas, painel da Focus ou portal da SEFAZ) com o contador. Config desalinhada vai por série nova ou fica de fora.
5. **Confirmações escritas da Focus** (seção 1): número/série explícitos, mesma `ref` depois de rejeição e comportamento do contador.
6. **Homologação com token próprio**, não compartilhado: emitir, rejeitar e reenviar, cancelar duas vezes, inutilizar e repetir, com timeout.
7. **Canário numa config só**, sem histórico ou em série nova, com os critérios de vigília da [operação da numeração V2](fiscal-numeracao-v2.md). Só então ampliar, config a config.

## 5. Fazer a primeira emissão de homologação

Com autorização explícita para o teste fiscal, crie uma NF-e modelo 55 para o emitente configurado. Revise destinatário, itens, CFOP, tributos, pagamento e totais com os dados aprovados pelo responsável fiscal. Use série de homologação combinada, sem alterar a série produtiva apenas para contornar erro.

Clique em **Emitir** uma vez. Confira o resultado:

- **Autorizada:** conferir chave, número/série reais e disponibilidade de XML/DANFE. Na resposta da API, `numeracao` comprova o despacho V2.
- **Rejeitada conclusivamente:** corrija os dados da mesma nota e reenvie; a reserva deve manter o número. Conteúdo idêntico pode receber cooldown.
- **Em processamento / resultado incerto:** use **Consultar situação**. Não crie outra nota para a mesma operação nem avance o número manualmente. A consulta respeita lease e maturidade, podendo pedir nova consulta mais tarde.
- **Confirmação de descarte:** revisar a troca de configuração/ambiente/série antes de confirmar. Isso abandona a reserva anterior; não significa liberar o número para outra nota.

Endpoint de acompanhamento: `POST /fiscal/nfe/:id/consultar-situacao`. Consulta não retransmite a nota. HTTP 200 isolado não significa autorização fiscal; confira `status`, chave e protocolo.

## 6. Liberar produção após a homologação

Com autorização operacional, configure `FISCAL_PRODUCTION_UNLOCKED=true` no servidor; a aplicação preserva esse bloqueio existente. Depois selecione **Produção** na configuração da empresa e informe a credencial Focus apropriada. Confira a série e numeração com o histórico da empresa e da Focus antes da primeira emissão real.

Mantenha a Focus restrita à config piloto. Após emitir a primeira nota real autorizada, confira XML, chave, protocolo, número/série e DANFE. Libere outras empresas apenas depois dessa conferência.

## Se não emitir

| Sintoma | Conferência necessária |
|---|---|
| Produção bloqueada | `FISCAL_PRODUCTION_UNLOCKED` e recarga do serviço |
| Sem token / autenticação recusada | Token salvo no emitente certo e ambiente correspondente |
| Não aparece `numeracao` | Versão implantada, flags, ID da configuração, modelo 55, subflag Focus e DDL |
| Rejeição sobre RT/CSRT | Texto/código da rejeição, cadastro do fornecedor, suporte Focus e contador; não insistir sem correção |
| Pendência de autorização do fornecedor no PR | Situação do UPD com contador/Focus |
| Emissão incerta | Consultar a nota existente; respeitar o prazo informado |
| Número/série divergentes | Conferir a chave autorizada e o histórico; não apagar a autorização nem reduzir contador |
| XML/DANFE pendente após autorização | Recuperar os artefatos; não emitir novamente uma operação já autorizada |

Para atendimento, registrar ID da nota, ambiente, código/mensagem fiscal e horário. Não registrar token, CSRT, certificado ou XML integral em logs de suporte.

## Retorno ao estado anterior

**Faça o rollback pela allowlist (`NFE_NUMERACAO_V2_CONFIG_IDS`) ou pela sub-flag Focus, nunca desligando `NFE_NUMERACAO_V2_ENABLED`.** Com o global desligado o ledger deixa de ser consultado (invariante de não tocar o banco fora da V2) e uma nota renumerada pela V2 volta a ser cancelada com a referência errada, o que a Focus recusa.

Depois de tirar a config da allowlist, rascunhos e notas rejeitadas que já tenham número reservado pela V2 respondem 409 `NUMERACAO_EMITENTE_FORA_V2` em vez de emitir pelo V1 (isso é proposital: emitir pelo V1 deixaria o número órfão, e ele travaria a inutilização daquela faixa). Para liberar cada um: reative a V2 para a empresa e emita, ou exclua o rascunho com `?descartarNumero=true`. O mesmo 409 aparece se o emitente da nota for trocado para uma empresa fora da V2.

Trocar ambiente ou token da empresa é bloqueado com 409 enquanto houver nota pendente de consulta (reserva em transmissão ou incerta). Resolva pelo botão **Consultar situação** antes de passar a empresa para produção — a Focus usa um token por ambiente, e a consulta de uma nota de homologação com token de produção só devolve 401.

Retirar a configuração da allowlist interrompe novos despachos V2. Antes disso, reconciliar as notas em andamento e revisar o contador da Focus. Preservar reservas e tentativas; não apagar dados nem liberar legado automaticamente. O rollback de numeração exige conferir o contador interno do fornecedor. O procedimento completo (pré-voo filtrado pela config, as duas listas, restart só do dexo-api) está em [operação da numeração V2](fiscal-numeracao-v2.md).
