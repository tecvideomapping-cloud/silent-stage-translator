# Ofertas adicionais — Silent Translator

## Configurar no painel

Em **Vendas e pedidos → Ofertas adicionais**, escolha **Nova oferta**. Informe nome, descrição, preço total, vantagens e os acréscimos de horas, participantes simultâneos e/ou idiomas. Informe zero no que não será ampliado.

Escolha todos os produtos ou apenas os serviços elegíveis. Defina qual limite dispara a oferta e o percentual usado para alertar. Para horas, configure também a antecedência em minutos: o alerta aparece quando qualquer um dos dois critérios for atingido. Exemplo: 80% de uso OU 30 minutos restantes. A oferta deve ampliar o recurso que dispara o alerta.

Marque **Oferta ativa** e salve. Ofertas novas começam inativas no formulário. Nenhum preço comercial ou oferta ativa foi cadastrado automaticamente.

## Experiência do cliente

A mesa de operações mostra consumo de horas, público simultâneo e idiomas configurados. Ofertas elegíveis aparecem perto dos limites, com os benefícios e o preço. A consulta é atualizada a cada 10 segundos.

O cliente confirma o adicional e o valor antes de abrir o Mercado Pago em outra aba. A mesa permanece aberta. Enquanto o pagamento está pendente, o saldo não muda e o pedido pode ser retomado. Após a confirmação pelo provedor, o limite aumenta no mesmo evento sem recarregar a mesa ou zerar o consumo. A confirmação por e-mail usa a fila do Resend existente.

Se as horas já tiverem acabado, a compra ainda pode ser feita. Depois da liberação, o operador pode reconectar e iniciar a transmissão manualmente. O recurso não garante que o pagamento termine antes do saldo acabar: configure antecedência suficiente para a operação.

## Regras

- Limites e preços vêm do servidor. Editar uma oferta não altera compras anteriores.
- Alterações de preço durante um pedido pendente exigem conferir as condições do pedido existente.
- Confirmações repetidas do pagamento não duplicam créditos nem criam outro evento.
- Reembolso do adicional retira seus créditos e preserva a compra do plano base. Idiomas configurados acima do novo limite são reduzidos.
- Ofertas de participantes não são vendidas a planos com participantes ilimitados. O total de idiomas respeita os 11 idiomas disponíveis; pedidos pendentes reservam esse limite.
- Cada cliente acessa somente seus eventos. Compras exigem sessão válida e confirmação das condições.
- A oferta vale para o evento comprado, sem recorrência ou cobrança automática.

## Ativação

Código aplicado ao projeto local. Reinicie o servidor após a atualização. Em produção é necessário publicar a versão e concluir a configuração existente de PostgreSQL, Mercado Pago, URL pública e Resend. Sem essas integrações, o pagamento fica indisponível. Os testes usam provedores simulados; nenhuma cobrança ou mensagem real foi enviada.

## Validação

20 testes automatizados de self-service e adicionais passaram, incluindo limites em tempo real, propriedade, concorrência, pagamentos e reembolsos. A proteção final de preço pendente foi verificada na suíte de 10 testes de adicionais. As telas foram verificadas no desktop e no celular, em claro e escuro, sem erros de JavaScript ou rolagem horizontal.
