# Roteiro para emitir NF-e pela Focus no Dexo

## O que está pronto

O código local integra a Focus ao fluxo V2 e passou nos testes simulados de emissão, rejeição, correção com o mesmo número e próxima numeração. Implantado na VPS pelo PR #353 em 18/09/2026, com os DDLs aplicados e smoke aprovado. A numeração V2 permanece desligada enquanto faltam as confirmações da Focus; não houve homologação com a conta do cliente. Consulte o [registro do deploy](handoff-nfe-evolucao/12-DEPLOY-VPS.md).

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

Obtenha o `id` da configuração fiscal (`CompanyFiscalConfig.id`) pela resposta autenticada de `GET /fiscal/config` ou pela configuração da empresa em `/fiscal/companies`. **Não use o userId, CNPJ ou companyId.**

Configure no ambiente do processo da API, substituindo o marcador:

```dotenv
NFE_NUMERACAO_V2_ENABLED=true
NFE_NUMERACAO_V2_CONFIG_IDS=ID_DA_CONFIGURACAO_FISCAL
NFE_NUMERACAO_V2_MODELOS=55
NFE_NUMERACAO_V2_FOCUS_ENABLED=true
NFE_DEVOLUCAO_ENABLED=false
NFE_RESP_TEC_EMPRESA_ENABLED=false
```

Recarregue o serviço pelo procedimento de implantação existente para que receba essas variáveis. Lista vazia não habilita nenhuma empresa; não usar `*` para o primeiro cliente. Não criar `.env` no worktree de desenvolvimento. Flags são de servidor e não usam `NEXT_PUBLIC_`.

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

Mantenha a allowlist restrita à empresa piloto. Após emitir a primeira nota real autorizada, confira XML, chave, protocolo, número/série e DANFE. Libere outras empresas apenas depois dessa conferência.

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

Retirar a configuração da allowlist interrompe novos despachos V2. Antes disso, reconciliar as notas em andamento e revisar o contador da Focus. Preservar reservas e tentativas; não apagar dados nem liberar legado automaticamente. O rollback de numeração exige conferir o contador interno do fornecedor.
