# Devolução fiscal

Habilitar `NFE_DEVOLUCAO_ENABLED` e a configuração em `NFE_DEVOLUCAO_CONFIG_IDS`, juntamente com numeração V2 aplicável ao provedor/modelo 55. O fluxo não altera estoque, vendas, recebíveis ou relatórios existentes.

## Fluxos

Na lista/detalhe de nota autorizada de saída, escolher devolução total ou parcial. O servidor usa o XML autorizado para itens, chave, número e série reais. Rascunho já aberto da original é reutilizado. A devolução manual admite XML autorizado importado ou chave válida com itens e confirmação explícita de ausência do XML.

O assistente existente recebe o rascunho. Informar que a mercadoria foi entregue, revisar quantidades/CFOP e confirmar tributação por item. Quantidade zero remove o item da seleção parcial. Campos de devolução usam PUT específico; o gravador comum não substitui os itens/referências. Pagamento é 90, sem duplicatas.

## Contrato

O arquivo `app/fiscal/devolucao/contrato.ts` é compartilhado pelo servidor e cliente:

- POST `/fiscal/nfe/:id/devolucao`
- GET `/fiscal/nfe/:id/devolucao/saldo`
- GET/PUT `/fiscal/nfe/draft/:id/devolucao`
- PUT `/fiscal/nfe/draft/:id/devolucao/itens`
- POST `/fiscal/nfe/devolucao/manual`

Erros têm código estável e, quando aplicável, issues de revisão. Empresa fora da allowlist retorna indisponível. O corpo manual tem limite de tamanho; XML não é registrado em logs.

## Regras de emissão

Validação ocorre antes do claim. O saldo é recontado sob advisory lock por tenant/chave, dentro da transação da reserva. Cabeçalho/referências são conferidos novamente contra alterações concorrentes. Autorizadas e notas em processamento consomem saldo; canceladas não. Cancelamento da original usa o mesmo lock e bloqueia se houver devolução autorizada ou em processamento.

Referência ITEM em homologação; em produção, NOTA antes de `NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE` (padrão 05/10/2026), ITEM a partir da data. Nunca enviar as duas formas. O contexto é aplicado antes do hash e da assinatura. O XML usa `impostoDevol` quando aplicável; os payloads Focus recebem o mesmo contexto. A integração não confirma que a Focus já suporta esses campos: isso permanece validação externa.

O vínculo fiscal permanece em NfeDevolucaoItem. Após autorização, a auditoria registra vínculos e recontagem de saldo. Falha de artefatos/auditoria pós-autorização não deve provocar retransmissão de uma nota autorizada.

## Limitações operacionais

Sem XML, não há prova automática da quantidade original: revisão e confirmação são obrigatórias. Tributação fora da allowlist exige ajuste. Não confundir recusa/não entrega com devolução após entrega. Alterações de regras tributárias ou calendário de referência devem ser validadas pelo responsável fiscal antes de habilitar o fluxo em produção.
