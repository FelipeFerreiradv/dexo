# Schemas XSD da NFe — Modelo 55 v4.00

Os schemas oficiais (PL_009*) **não estão versionados neste diretório** porque:

1. São arquivos governamentais regulados pela Receita Federal e devem ser baixados do Portal Nacional NFe.
2. Mudam de tempos em tempos (publicações de NTs). Versionar no repo cria risco de divergência com o que está em homologação/produção.
3. O conjunto completo contém dezenas de arquivos `.xsd` interrelacionados.

## Quando esses schemas serão usados

A validação contra XSD entra em cena na **Fase F-D** (emissão em homologação), antes de enviar o XML assinado ao SEFAZ. Falha de XSD = erro local antes da rede, mais barato que rejeição da SEFAZ.

## Como baixar (procedimento manual, fora do escopo desta migração)

1. Acessar https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=33ol5hhSYZk=
2. Baixar o pacote `PL_009_V4` (ou versão vigente — checar a data da última NT publicada).
3. Extrair em `app/fiscal/sefaz/xsd/PL_009_V4/`.
4. O arquivo principal para NFe modelo 55 é `nfe_v4.00.xsd`. Demais arquivos (`tiposBasico_v4.00.xsd`, `xmldsig-core-schema_v1.01.xsd`, etc.) são importados em cascata.
5. Para eventos (cancelamento, CCe): `procEventoNFe_v1.00.xsd` + `tipos eventos`.

## Versão sugerida (até 2026-05-14)

- `PL_009_V4` — última publicação vigente em maio/2026.
- Migrar tão logo SEFAZ publique nova NT.

## .gitignore

Considere adicionar `app/fiscal/sefaz/xsd/PL_*/` ao `.gitignore` se o tamanho for problemático. Outra opção: scripts/fiscal/download-xsd.ts (a criar) que sincroniza on-demand.

## Carregamento em runtime

`SefazXsdValidatorService` (a ser criado em F-D) deve:
- Carregar lazy via `fs.readFileSync` na primeira chamada.
- Cachear em memória por todo o lifetime do processo.
- Falhar com erro claro se diretório ausente em ambiente que tenha `SEFAZ_DIRECT_ENABLED=true`.
