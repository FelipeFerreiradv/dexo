# Importação de dados legados (painel Superadmin)

Ferramenta da equipe Dexo para integrar clientes novos: depois que os
produtos foram criados pelo **"Importar anúncios"** (chaveados por SKU), o
suporte importa as planilhas do sistema antigo do cliente pelo botão
**"Importar dados"** (aba Colaboradores → Equipe Dexo, por administrador).

Toda importação roda primeiro em **prévia** (dry-run, nada é gravado) e só é
aplicada com confirmação explícita, como **job assíncrono** com progresso.
Reimportar o mesmo arquivo é seguro: nada é duplicado nem re-vinculado.

**Ordem recomendada:** Clientes → Localizações → Sucatas → Vínculo de
produtos → Contas → NF-e.

## Sistemas e arquivos suportados

A detecção é pela **assinatura de colunas** (o nome do arquivo não importa).

### Vaapt (XLSX/XLS)

| Entidade | Arquivo | Colunas-chave |
| --- | --- | --- |
| Clientes | planilha de clientes | `# Cod Cliente`, `Nome Cliente`, `CPF`, `CNPJ`, `TipoPessoa` |
| Localizações | planilha de peças | `# Cod Peca`, `Localizacao` (texto plano, ex.: "Local 44 - Caixa 9") |
| Sucatas | planilha de veículos (nem todo pacote traz) | `# Codigo Veiculo`, `Marca`, `Modelo` |
| Vínculo de produtos | planilha de peças (+ veículos opcional) | `# Cod Peca` = SKU; `Localizacao`; `Cod Veiculo` |
| NF-e históricas | resumo de notas (aba "Java Books") | `N° NFe`, `Status da NFe`, `Chave de Acesso` |

### IBR / WebDesmonte (CSV)

| Entidade | Arquivo | Colunas-chave |
| --- | --- | --- |
| Localizações (hierárquicas) | `locations.csv` | `Id`, `InitialsPath`, `ParentId`, `Level`, `MaxQuantity` (vira capacidade) |
| Sucatas | `purchase_waste.csv` (+ `locations.csv` p/ vincular localização) | `Id`, `Brand`, `Model`, `LicensePlate`, `Chassis`, `PurchaseValue` |
| Clientes | `customers.csv` (quando o export traz) | `Id`, `Name`, `Type`, `Document` |
| Vínculo de produtos | `products.csv` **+** `locations.csv` (+ `purchase_waste.csv` opcional) | `Code` = SKU; `LocationId`/`PurchaseWasteId` (GUIDs) |
| **Pacote completo** (recomendado) | todos os CSVs numa importação só | fases executadas em ordem, com os vínculos resolvidos em memória |

## Template Dexo — contas a pagar/receber (CSV)

Nenhum export legado traz contas; use este template (UTF-8, separador vírgula):

```csv
tipo,documento,cliente_cpf_cnpj,cliente_nome,valor,vencimento,status,pago_em,forma_pagamento,parcelas,observacao
receber,NF 123,52998224725,,1234.56,31/05/2024,paga,05/06/2024,PIX,1,venda balcão
pagar,BOL 9,,Fornecedor X,500,30/06/2024,pendente,,BOLETO,2,aluguel do galpão
```

| Coluna | Regra |
| --- | --- |
| `tipo` | `receber` ou `pagar` (obrigatório) |
| `documento` | número do documento (opcional) |
| `cliente_cpf_cnpj` | CPF (11) ou CNPJ (14); tem prioridade sobre o nome |
| `cliente_nome` | usado se não houver documento; precisa casar EXATO com um cliente já importado |
| `valor` | número > 0 (aceita `1.234,56`) |
| `vencimento` | `dd/mm/aaaa` ou `aaaa-mm-dd` (obrigatório) |
| `status` | `pendente` (default), `paga`, `vencida` ou `cancelada` |
| `pago_em` | data do pagamento (obrigatória em contas pagas; sem ela, usa o vencimento) |
| `forma_pagamento` | `PIX`, `CREDITO`, `DEBITO`, `BOLETO`, `DINHEIRO`, `TRANSFERENCIA` ou `FIADO` (FIADO só em contas a receber) |
| `parcelas` | inteiro ≥ 1 (default 1) |
| `observacao` | texto livre |

O cliente **precisa existir antes** (importe Clientes primeiro) — a
importação de contas nunca cria cliente automaticamente. Contas históricas
pagas entram já como `PAGA` sem disparar baixa de estoque nem sincronização
de marketplace.

## Garantias

- **Prévia nunca escreve.** O `previewHash` garante que o apply roda sobre o
  arquivo byte-idêntico aprovado (arquivo trocado ⇒ 409, gere nova prévia).
- **Vínculo por SKU à prova de erro:** o casamento é por `skuNormalized`
  (caixa/espaço-insensível, o mesmo critério do "Importar anúncios"). SKU sem
  produto ⇒ reportado em `sem_produto`, nunca vinculado a outro; SKU que casa
  mais de um produto ⇒ reportado em `ambíguos`, nunca vinculado.
- **Idempotência:** dedup por markers em `notes` (`cliente #…`, `veículo #…`,
  `sucata #…`), por documento (CPF/CNPJ), por código de localização e por
  chave/número de NF-e. Os markers legados dos scripts de migração
  (`Legado <TENANT> · …`) também são reconhecidos.
- **Multi-tenant:** tudo é criado no admin-alvo escolhido; referências de
  outro tenant são rejeitadas pelas guardas dos UseCases.
- **Job resiliente:** se o servidor reiniciar no meio, o status vira
  `INTERROMPIDO` — re-executar é seguro.
