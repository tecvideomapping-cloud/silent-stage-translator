/* Commerce overview uses the existing administrator session. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const dates = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  const paymentLabels = { paid: 'Pago', pending: 'Pendente', awaiting_payment: 'Aguardando pagamento', processing: 'Processando', failed: 'Falhou', canceled: 'Cancelado', cancelled: 'Cancelado', expired: 'Expirado', refunded: 'Reembolsado',charged_back:'Contestado',rejected:'Não aprovado' };
  const emailLabels = { sent: 'Enviado', delivered: 'Entregue', pending: 'Pendente', queued: 'Na fila', failed: 'Falhou', error: 'Falhou', not_sent: 'Não enviado', skipped: 'Não enviado' };
  let loading = false;
  function text(value, fallback = '—') { return value === null || value === undefined || value === '' ? fallback : String(value); }
  function node(tag, className, value) { const el = document.createElement(tag); if (className) el.className = className; if (value !== undefined) el.textContent = value; return el; }
  function feedback(message, error = false) { const el = $('salesFeedback'); el.textContent = message; el.hidden = !message; el.classList.toggle('is-error', error); }
  function token() { try { return localStorage.getItem('vmt_admin_token') || ''; } catch { return ''; } }
  async function request(path, options = {}) {
    const auth = token();
    if (!auth) throw new Error('Entre no painel administrativo para consultar os pedidos.');
    const response = await fetch(path, { ...options, headers: { ...options.headers, Authorization: `Bearer ${auth}` }, cache: 'no-store' });
    if (response.status === 401 || response.status === 403) throw new Error('Sua sessão expirou ou não tem permissão. Entre novamente no painel administrativo.');
    if (!response.ok) throw new Error('Não foi possível concluir a solicitação. Tente novamente.');
    return response.json();
  }
  function money(cents) { return Number.isFinite(Number(cents)) ? currency.format(Number(cents) / 100) : '—'; }
  function date(value) { const parsed = new Date(value); return value && Number.isFinite(parsed.getTime()) ? dates.format(parsed) : '—'; }
  function count(value) { return Number.isFinite(Number(value)) ? new Intl.NumberFormat('pt-BR').format(Number(value)) : '—'; }
  function renderReadiness(readiness) {
    const list = $('readinessList'); list.replaceChildren();
    [['paymentConfigured', 'Pagamento'], ['emailConfigured', 'E-mail'], ['databaseConfigured', 'Banco de dados'], ['publicUrlConfigured', 'URL pública']].forEach(([key, label]) => {
      const ready = readiness[key] === true;
      const item = node('li', ready ? 'is-configured' : '', `${label}: ${ready ? 'configurado' : 'não configurado'}`);
      item.prepend(node('span', 'sales-service-dot')); list.append(item);
    });
  }
  function badge(value, labels, kind) {
    const status = text(value, 'unknown').toLowerCase();
    const state = kind === 'email' ? (['sent', 'delivered'].includes(status) ? 'sent' : ['failed', 'error'].includes(status) ? 'failed' : 'pending') : (status === 'paid' ? 'paid' : ['failed', 'canceled', 'cancelled', 'expired', 'refunded'].includes(status) ? 'failed' : 'pending');
    return node('span', `sales-badge ${state}`, labels[status] || (status === 'unknown' ? 'Não informado' : text(value)));
  }
  function renderOrders(orders) {
    const body = $('ordersRows'); body.replaceChildren();
    $('orderCount').textContent = `${count(orders.length)} ${orders.length === 1 ? 'pedido' : 'pedidos'}`;
    $('ordersState').hidden = orders.length > 0; $('ordersTableWrap').hidden = orders.length === 0;
    $('ordersState').textContent = 'Nenhum pedido recebido até o momento.';
    orders.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)).forEach((order) => {
      const row = node('tr'); const customer = node('td');
      customer.append(node('span', 'sales-customer', text(order.customerName)), node('span', 'sales-detail', text(order.customerEmail)), node('span', 'sales-detail', `Pedido ${text(order.id)}`));
      if (order.eventId) customer.append(node('span', 'sales-detail', `Evento ${text(order.eventId)}`));
      if (order.duplicatePayment) customer.append(node('span','sales-detail','Mais de um pagamento identificado: confira no provedor.'));
      const plan = node('td', '', text(order.planName)); const status = node('td'); status.append(badge(order.status, paymentLabels, 'payment'));
      const amount = node('td', 'sales-amount', money(order.amountCents)); const created = node('td', 'sales-date', date(order.createdAt)); const email = node('td'); email.append(badge(order.emailStatus, emailLabels, 'email'));
      if (String(order.status).toLowerCase() === 'paid' && order.id !== undefined && order.id !== null) {
        const resend = node('button', 'vmt-btn sales-email-action', 'Reenviar acesso'); resend.type = 'button'; resend.setAttribute('aria-label', `Reenviar acesso por e-mail para ${text(order.customerName, 'cliente')}`);
        resend.addEventListener('click', async () => {
          resend.disabled = true; resend.textContent = 'Reenviando…'; feedback('');
          try { const result = await request(`/api/admin/commerce/orders/${encodeURIComponent(String(order.id))}/retry-email`, { method: 'POST' }); if (result.success !== true) throw new Error('Não foi possível reenviar o acesso. Tente novamente.'); await load(); feedback('Reenvio do acesso solicitado com sucesso.'); }
          catch (error) { feedback(error.message || 'Não foi possível reenviar o acesso.', true); }
          finally { resend.disabled = false; resend.textContent = 'Reenviar acesso'; }
        }); email.append(resend);
      }
      row.append(customer, plan, status, amount, created, email); body.append(row);
    });
  }
  async function load() {
    if (loading) return;
    loading = true; $('refreshSales').disabled = true; $('ordersPanel').setAttribute('aria-busy', 'true'); feedback('');
    try {
      const data = await request('/api/admin/commerce/overview');
      if (!Array.isArray(data.orders) || !data.totals || !data.readiness) throw new Error('Os dados de vendas estão indisponíveis. Tente atualizar novamente.');
      $('paidRevenue').textContent = money(data.totals.paidCents); $('paidOrders').textContent = count(data.totals.paidOrders); $('pendingOrders').textContent = count(data.totals.pendingOrders);
      renderReadiness(data.readiness); renderOrders(data.orders.filter(order => order && typeof order === 'object'));
    } catch (error) {
      feedback(error.message || 'Não foi possível carregar os pedidos.', true);
      $('ordersTableWrap').hidden = true; $('ordersState').hidden = false; $('ordersState').textContent = 'Não foi possível carregar os pedidos. Use Atualizar para tentar novamente.';
      $('orderCount').textContent = 'Indisponível'; ['paidRevenue', 'paidOrders', 'pendingOrders'].forEach(id => { $(id).textContent = '—'; });
      $('readinessList').replaceChildren(node('li', '', 'Configuração indisponível.'));
    } finally { loading = false; $('refreshSales').disabled = false; $('ordersPanel').setAttribute('aria-busy', 'false'); }
  }
  let productsLoading = false;
  let editingProduct = null;
  let savingProduct = false;
  let dialogTrigger = null;
  const catalogUrl = '/api/admin/commerce/products';
  function catalogFeedback(message, error = false) {
    const el = $('catalogFeedback'); el.textContent = message; el.hidden = !message; el.classList.toggle('is-error', error);
  }
  function productPayload(product) {
    return { name: product.name, description: product.description || '', priceCents: product.priceCents ?? 0, currency: 'BRL', hours: product.hours, maxParticipants: product.maxParticipants ?? null, maxLanguages: product.maxLanguages, features: Array.isArray(product.features) ? product.features : [], active: product.active === true, selfService: product.selfService === true };
  }
  function closeProduct() {
    if (savingProduct) return;
    $('productDialog').close();
    if (dialogTrigger && document.contains(dialogTrigger)) dialogTrigger.focus();
  }
  function openProduct(product = null, trigger = null) {
    editingProduct = product; dialogTrigger = trigger || document.activeElement;
    $('productForm').reset(); $('productFormError').hidden = true; $('productFormError').textContent = '';
    $('productDialogTitle').textContent = product ? 'Editar produto' : 'Novo produto';
    $('saveProduct').textContent = product ? 'Salvar alterações' : 'Criar produto';
    $('productSlugField').hidden = Boolean(product); $('productSlug').disabled = Boolean(product);
    $('productName').value = product?.name || ''; $('productDescription').value = product?.description || '';
    $('productPrice').value = product && product.priceCents != null ? (Number(product.priceCents) / 100).toFixed(2).replace('.', ',') : '';
    $('productHours').value = product?.hours ?? ''; $('productParticipants').value = product?.maxParticipants ?? '';
    $('productLanguages').value = product?.maxLanguages ?? ''; $('productFeatures').value = Array.isArray(product?.features) ? product.features.join('\n') : '';
    $('productActive').checked = product ? product.active === true : true;
    $('productSelfService').checked = product ? product.selfService === true : true;
    $('productDialog').showModal(); $('productName').focus();
  }
  function renderProducts(products) {
    const list = $('productList'); list.replaceChildren();
    $('catalogState').hidden = products.length > 0; $('catalogState').textContent = 'Seu catálogo ainda está vazio. Crie o primeiro produto para começar.';
    products.forEach(product => {
      const card = node('article', 'sales-product-card'); const head = node('div', 'sales-product-top');
      head.append(node('span', `sales-badge ${product.active ? 'paid' : 'pending'}`, product.active ? 'Ativo' : 'Inativo'), node('span', 'sales-badge', product.selfService ? 'Compra direta' : 'Sob cotação'));
      const title = node('h3', '', text(product.name)); const price = node('strong', 'sales-product-price', !product.selfService && !product.priceCents ? 'Sob consulta' : money(product.priceCents));
      const limits = node('p', 'sales-product-limits', `${text(product.hours)} h · ${product.maxParticipants == null ? 'Participantes ilimitados' : `${text(product.maxParticipants)} participantes`} · ${text(product.maxLanguages)} idiomas`);
      const features = node('ul', 'sales-product-features'); (Array.isArray(product.features) ? product.features : []).forEach(feature => features.append(node('li', '', text(feature, ''))));
      const actions = node('div', 'sales-product-card-actions'); const edit = node('button', 'vmt-btn', 'Editar produto'); edit.type = 'button'; edit.setAttribute('aria-label', `Editar ${text(product.name)}`); edit.addEventListener('click', () => openProduct(product, edit));
      const toggle = node('button', 'vmt-btn', product.active ? 'Desativar' : 'Ativar'); toggle.type = 'button'; toggle.setAttribute('aria-label', `${product.active ? 'Desativar' : 'Ativar'} ${text(product.name)}`);
      toggle.addEventListener('click', async () => {
        toggle.disabled = true; edit.disabled = true; catalogFeedback('');
        try {
          const result = await request(`${catalogUrl}/${encodeURIComponent(String(product.id))}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...productPayload(product), active: !product.active }) });
          if (!result.product) throw new Error('O produto não pôde ser atualizado.');
          const refreshed = await loadProducts(); if (refreshed) catalogFeedback(`Produto ${product.active ? 'desativado' : 'ativado'} com sucesso.`);
        } catch (error) { catalogFeedback(error.message || 'Não foi possível atualizar o produto.', true); }
        finally { toggle.disabled = false; edit.disabled = false; }
      });
      actions.append(edit, toggle); card.append(head, title, price, node('p', 'sales-product-description', text(product.description, '')), limits, features, actions); list.append(card);
    });
  }
  async function loadProducts() {
    if (productsLoading) return false;
    productsLoading = true; $('refreshProducts').disabled = true; $('catalogPanel').setAttribute('aria-busy', 'true'); catalogFeedback('');
    try { const data = await request(catalogUrl); if (!Array.isArray(data.products)) throw new Error('O catálogo está indisponível. Tente atualizar novamente.'); renderProducts(data.products.filter(product => product && typeof product === 'object')); return true; }
    catch (error) { catalogFeedback(error.message || 'Não foi possível carregar o catálogo.', true); $('productList').replaceChildren(); $('catalogState').hidden = false; $('catalogState').textContent = 'Não foi possível carregar os produtos. Use Atualizar catálogo para tentar novamente.'; return false; }
    finally { productsLoading = false; $('refreshProducts').disabled = false; $('catalogPanel').setAttribute('aria-busy', 'false'); }
  }
  function readProductForm() {
    const selfService = $('productSelfService').checked;
    let rawPrice = $('productPrice').value.trim().replace(/\s/g, '');
    if (rawPrice.includes(',')) {
      if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}$/.test(rawPrice)) throw new Error('Informe o preço no formato 299,90 ou 1.299,90.');
      rawPrice = rawPrice.replace(/\./g, '').replace(',', '.');
    }
    if (rawPrice && !/^\d+(?:\.\d{1,2})?$/.test(rawPrice)) throw new Error('Informe o preço em reais, com até duas casas decimais.');
    const priceCents = Math.round(Number(rawPrice || 0) * 100);
    if (!Number.isSafeInteger(priceCents) || priceCents < 0 || (selfService && priceCents <= 0)) throw new Error('Produtos com compra direta precisam de um preço maior que zero.');
    const hours = Number($('productHours').value); const maxLanguages = Number($('productLanguages').value);
    const maxParticipants = $('productParticipants').value.trim() === '' ? null : Number($('productParticipants').value);
    if (!Number.isFinite(hours) || hours <= 0) throw new Error('Informe uma duração maior que zero.');
    if (!Number.isSafeInteger(maxLanguages) || maxLanguages < 0 || maxLanguages > 11) throw new Error('Informe uma quantidade inteira de idiomas, entre 0 e 11.');
    if (maxParticipants !== null && (!Number.isSafeInteger(maxParticipants) || maxParticipants < 1)) throw new Error('Informe participantes a partir de 1 ou deixe vazio para ilimitado.');
    const name = $('productName').value.trim(); if (!name) throw new Error('Informe o nome do produto.');
    const payload = { name, description: $('productDescription').value.trim(), priceCents, currency: 'BRL', hours, maxParticipants, maxLanguages, features: $('productFeatures').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean), active: $('productActive').checked, selfService };
    const slug = $('productSlug').value.trim();
    if (!editingProduct && slug) { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Use somente letras minúsculas, números e hífens no identificador.'); payload.id = slug; }
    return payload;
  }
  $('productForm').addEventListener('submit', async event => {
    event.preventDefault(); if (savingProduct) return;
    const errorBox = $('productFormError'); errorBox.hidden = true; let payload;
    try { payload = readProductForm(); } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; errorBox.focus(); return; }
    savingProduct = true; const submit = $('saveProduct'); submit.disabled = true; submit.textContent = 'Salvando…'; $('closeProductDialog').disabled = true; $('cancelProduct').disabled = true;
    try {
      const result = await request(editingProduct ? `${catalogUrl}/${encodeURIComponent(String(editingProduct.id))}` : catalogUrl, { method: editingProduct ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!result.product) throw new Error('Não foi possível salvar o produto.');
      savingProduct = false; closeProduct(); const refreshed = await loadProducts(); if (refreshed) catalogFeedback('Produto salvo com sucesso.');
    } catch (error) { errorBox.textContent = error.message || 'Não foi possível salvar o produto.'; errorBox.hidden = false; }
    finally { savingProduct = false; submit.disabled = false; submit.textContent = editingProduct ? 'Salvar alterações' : 'Criar produto'; $('closeProductDialog').disabled = false; $('cancelProduct').disabled = false; }
  });
  $('productDialog').addEventListener('cancel', event => { event.preventDefault(); closeProduct(); });
  $('closeProductDialog').addEventListener('click', closeProduct); $('cancelProduct').addEventListener('click', closeProduct);
  $('newProduct').addEventListener('click', () => openProduct()); $('refreshProducts').addEventListener('click', loadProducts);
  $('refreshSales').addEventListener('click', load); load(); loadProducts();
})();
