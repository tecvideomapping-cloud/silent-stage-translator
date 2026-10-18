const { test } = require('node:test');
const assert = require('node:assert/strict');

for (const k of ['DATABASE_URL', 'REDIS_URL', 'OPENAI_API_KEY', 'DEEPGRAM_API_KEY', 'GROQ_API_KEY', 'APP_BASE_URL']) {
  delete process.env[k];
}
process.env.NODE_ENV = 'development';
process.env.ADMIN_PASSWORD = 'Client-Management-Test-Password-2026';

const {
  saveClient,
  getClient,
  getClientByEmail,
  listClients,
  deleteClient,
  saveClientPayment,
  listClientPayments,
  deleteClientPayment
} = require('../server/db');

const { server, commerce, wss } = require('../server/index');

test('client management: unit functions for client registration, password, license and payments', async () => {
  // 1. Cadastrar cliente com senha e licença
  const created = await saveClient({
    company: 'Empresa Teste Alpha Ltda',
    name: 'Carlos Gestor',
    email: 'carlos@alphateste.com.br',
    phone: '(11) 98765-4321',
    cnpj_cpf: '12.345.678/0001-90',
    total_hours: 20,
    plan: 'Enterprise',
    license_status: 'active',
    max_rooms: 5,
    max_listeners: 500,
    password: 'SenhaSeguraCliente123!'
  });

  assert.ok(created.id, 'Cliente deve ter um ID gerado');
  assert.equal(created.company, 'Empresa Teste Alpha Ltda');
  assert.equal(created.has_password, true, 'has_password deve ser true');
  assert.equal(created.password_hash, undefined, 'password_hash não deve vazar no retorno');
  assert.equal(created.password_salt, undefined, 'password_salt não deve vazar no retorno');
  assert.equal(created.password, undefined, 'password em texto claro não deve vazar no retorno');
  assert.equal(created.plan, 'Enterprise');
  assert.equal(created.max_rooms, 5);
  assert.equal(created.max_listeners, 500);
  assert.equal(created.total_hours, 20);

  // 2. Buscar por ID e por e-mail
  const fetched = await getClient(created.id);
  assert.ok(fetched);
  assert.equal(fetched.id, created.id);
  assert.equal(fetched.has_password, true);

  const byEmail = await getClientByEmail('carlos@alphateste.com.br');
  assert.ok(byEmail);
  assert.ok(byEmail.password_hash.startsWith('scrypt:'));

  // 3. Edição do cadastro sem alterar senha (mantém senha anterior)
  const updated = await saveClient({
    id: created.id,
    company: 'Alpha Corporation S.A.',
    name: 'Carlos Silva',
    total_hours: 25
  });
  assert.equal(updated.company, 'Alpha Corporation S.A.');
  assert.equal(updated.total_hours, 25);
  assert.equal(updated.has_password, true, 'has_password deve continuar true');

  const afterUpdate = await getClientByEmail('carlos@alphateste.com.br');
  assert.equal(afterUpdate.password_hash, byEmail.password_hash, 'Hash da senha deve ser preservado ao editar sem fornecer nova senha');

  // 4. Edição fornecendo nova senha
  await saveClient({
    id: created.id,
    password: 'NovaSenhaDeAcesso987!'
  });
  const afterNewPassword = await getClientByEmail('carlos@alphateste.com.br');
  assert.notEqual(afterNewPassword.password_hash, byEmail.password_hash, 'Hash da senha deve mudar ao definir nova senha');

  // 5. Histórico de Pagamentos do Cliente
  const payment1 = await saveClientPayment({
    client_id: created.id,
    amount_cents: 150000, // R$ 1.500,00
    currency: 'BRL',
    status: 'paid',
    method: 'pix',
    description: 'Contratação inicial 20h'
  });
  assert.ok(payment1.id);
  assert.equal(payment1.amount_cents, 150000);

  const payment2 = await saveClientPayment({
    client_id: created.id,
    amount_cents: 50000, // R$ 500,00
    currency: 'BRL',
    status: 'pending',
    method: 'boleto',
    description: 'Fatura de horas adicionais'
  });
  assert.ok(payment2.id);

  const payments = await listClientPayments(created.id);
  assert.equal(payments.length, 2);
  assert.equal(payments[0].client_id, created.id);

  // 6. Excluir pagamento individual
  await deleteClientPayment(payment2.id, created.id);
  const remainingPayments = await listClientPayments(created.id);
  assert.equal(remainingPayments.length, 1);
  assert.equal(remainingPayments[0].id, payment1.id);

  // 7. Excluir cliente cascateia para pagamentos
  await deleteClient(created.id);
  assert.equal(await getClient(created.id), null);
  const paymentsAfterClientDeleted = await listClientPayments(created.id);
  assert.equal(paymentsAfterClientDeleted.length, 0);
});

test('client management: full API integration with license revision and payment ledger', async t => {
  await commerce.ready;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  t.after(async () => {
    commerce.stopWorkers();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(r => server.close(r));
  });

  const post = async (path, body, token) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      },
      body: JSON.stringify(body)
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  const put = async (path, body, token) => {
    const res = await fetch(base + path, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      },
      body: JSON.stringify(body)
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  const get = async (path, token) => {
    const res = await fetch(base + path, {
      headers: token ? { Authorization: 'Bearer ' + token } : {}
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  const del = async (path, token) => {
    const res = await fetch(base + path, {
      method: 'DELETE',
      headers: token ? { Authorization: 'Bearer ' + token } : {}
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  // Login de administrador
  const loginRes = await post('/api/auth/login', {
    email: 'admin@videomappingtech.com',
    password: process.env.ADMIN_PASSWORD
  });
  assert.equal(loginRes.status, 200);
  const token = loginRes.data.token;

  // 1. Criar cliente via API
  const createRes = await post('/api/clients', {
    company: 'Empresa Beta Tecnologias',
    name: 'Juliana Mendes',
    email: 'juliana@betatech.io',
    phone: '(21) 99999-8888',
    cnpj_cpf: '98.765.432/0001-10',
    total_hours: 15,
    plan: 'Pro',
    license_status: 'active',
    password: 'MinhaSenhaDeAcesso2026!'
  }, token);

  assert.equal(createRes.status, 200);
  assert.ok(createRes.data.client?.id);
  const clientId = createRes.data.client.id;
  assert.equal(createRes.data.client.has_password, true);

  // 2. Listar clientes e verificar que o novo cliente está listado com informações de licença
  const listRes = await get('/api/clients', token);
  assert.equal(listRes.status, 200);
  const found = listRes.data.clients.find(c => c.id === clientId);
  assert.ok(found);
  assert.equal(found.company, 'Empresa Beta Tecnologias');
  assert.equal(found.has_password, true);

  // 3. Obter detalhes do cliente
  const detailRes = await get('/api/clients/' + clientId, token);
  assert.equal(detailRes.status, 200);
  assert.equal(detailRes.data.client.id, clientId);
  assert.ok(Array.isArray(detailRes.data.rooms));

  // 4. Revisão de Licença via PUT /api/clients/:id/license
  const licenseRes = await put('/api/clients/' + clientId + '/license', {
    plan: 'Enterprise',
    license_status: 'trial',
    max_rooms: 4,
    max_listeners: 800,
    total_hours: 30,
    license_expires_at: '2026-12-31T23:59:59.000Z'
  }, token);

  assert.equal(licenseRes.status, 200);
  assert.equal(licenseRes.data.client.plan, 'Enterprise');
  assert.equal(licenseRes.data.client.license_status, 'trial');
  assert.equal(licenseRes.data.client.max_rooms, 4);
  assert.equal(licenseRes.data.client.max_listeners, 800);
  assert.equal(licenseRes.data.client.total_hours, 30);

  // 5. Adicionar Pagamento com incremento de horas adicionais
  const paymentRes = await post('/api/clients/' + clientId + '/payments', {
    amount_cents: 250000,
    currency: 'BRL',
    status: 'paid',
    method: 'pix',
    description: 'Renovação e pacote extra de 10 horas',
    add_hours: 10
  }, token);

  assert.equal(paymentRes.status, 200);
  assert.ok(paymentRes.data.payment?.id);
  const paymentId = paymentRes.data.payment.id;

  // Verifica que as horas foram incrementadas
  const updatedClientRes = await get('/api/clients/' + clientId, token);
  assert.equal(updatedClientRes.data.client.total_hours, 40, 'Total de horas deve ser 30 + 10 = 40');

  // 6. Consultar Histórico de Pagamentos
  const paymentsRes = await get('/api/clients/' + clientId + '/payments', token);
  assert.equal(paymentsRes.status, 200);
  assert.equal(paymentsRes.data.payments.length, 1);
  assert.equal(paymentsRes.data.payments[0].amount_cents, 250000);

  // 7. Excluir Pagamento
  const delPayRes = await del('/api/clients/' + clientId + '/payments/' + paymentId, token);
  assert.equal(delPayRes.status, 200);

  const paymentsAfterDel = await get('/api/clients/' + clientId + '/payments', token);
  assert.equal(paymentsAfterDel.data.payments.length, 0);

  // 8. Excluir Cliente
  const delClientRes = await del('/api/clients/' + clientId, token);
  assert.equal(delClientRes.status, 200);

  const getDeleted = await get('/api/clients/' + clientId, token);
  assert.equal(getDeleted.status, 404);
});
