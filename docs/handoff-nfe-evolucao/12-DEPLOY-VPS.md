# Deploy NF-e — 18/09/2026

## Publicação efetuada

PR [#353](https://github.com/FelipeFerreiradv/dexo/pull/353) criado e mesclado. Commit implantado: `84b915d48eccc76853835edcd6d17aae6adad792`.

As correções recentes de main foram integradas antes da publicação. A revalidação fiscal/adjacente passou com 2.314 testes aprovados e 2 testes PostgreSQL ignorados. Build de produção concluído em diretório separado na VPS, usando as dependências existentes (não houve mudança de dependências nesta entrega).

Aplicados os três DDLs aditivos de 18/09/2026. Verificados: cinco tabelas com RLS habilitado e 21 índices válidos. Não houve alteração corretiva de notas históricas nem emissão fiscal.

A API e o frontend foram reiniciados sem `--update-env`. Workers não foram reiniciados. Backup da configuração e do build anterior em `/var/www/dexo-deploy-backups/nfe-20260918-175157`; a revisão anterior está no arquivo `previous-revision`. Script de troca preparado com rollback automático caso o smoke falhasse; não foi necessário executá-lo.

## Verificação pós-deploy

- API local e pública: HTTP 200 no health.
- Frontend público `https://home.usedexo.com.br`: HTTP 200.
- Frontend local: HTTP 307 (redirecionamento existente).
- Rotas de RT e disponibilidade de devolução sem credencial: HTTP 401, conforme esperado.
- API e frontend online, sem novos reinícios espontâneos entre as verificações.
- Git da VPS em `84b915d`, sem mudanças em arquivos rastreados.
- `/api/version` respondeu `dev-1789764583555`: o build foi produzido por `git archive`, sem `.git` no diretório temporário; o SHA implantado foi verificado diretamente no checkout. Não há divergência de build ID entre os arquivos e o frontend.

## Focus/Kiko: estado real

Consulta somente leitura à Focus autenticou com HTTP 200. A última nota consultada permanece registrada como `erro_autorizacao`, cStat `974`. Nenhuma nova emissão ou retransmissão foi feita. Esse resultado histórico não comprova a resolução da configuração atual de RT/UPD.

O usuário confirmou nesta execução que **ainda não recebeu** as duas confirmações do suporte Focus sobre respeito a número/série e manutenção do número no reenvio da mesma referência após rejeição. Conforme o plano aprovado, **a numeração V2 Focus permanece desligada**. As flags novas não foram adicionadas ao ambiente. O provedor Focus já configurado para a empresa continua no caminho existente, agora com as correções de normalização/publicação desta entrega.

Para ativação, seguir [roteiro Focus](../roteiro-emissao-focus-nfe.md), começando pela configuração piloto da Kiko em homologação. Não afirmar ao cliente que a emissão fiscal foi homologada ou que a rejeição 974 já foi resolvida.

## Diagnóstico somente leitura

Executado após deploy; arquivos na VPS:

`/var/www/dexo/scripts/out/diagnostico-numeracao-2026-09-18T20-53-06-119Z.json`

CSV correspondente no mesmo diretório. O diagnóstico encontrou 4 divergências históricas, 33 registros antigos de emissão/preparação, 360 intervalos candidatos de numeração e 2 grupos com tokens compartilhados. São registros para análise humana; nenhum foi corrigido automaticamente. As novas reservas estão vazias e o diagnóstico não encontrou duplicidade de vínculo vivo.

## Validação complementar e pendências

- Suporte Focus: confirmações sobre número/série/ref e RT/CSRT.
- Contador/Kiko: verificar autorização do fornecedor no UPD e condições fiscais.
- Homologação real e UAT das telas ativadas, após liberar o canário conforme o plano.
- PostgreSQL local isolado: pendência encerrada nesta execução. Após iniciar o Docker Desktop, os dois testes passaram em PostgreSQL 16 Alpine, banco descartável `nfe_test` vinculado somente a 127.0.0.1:54329. Concorrência de 40 reservas e rollback após incremento aprovados. O container foi encerrado após o teste; nenhum teste de escrita foi apontado ao banco de produção.

A publicação, os DDLs e o smoke estão concluídos. A ativação do V2 e a homologação não estão concluídas.
