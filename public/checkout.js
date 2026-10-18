(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const query = new URLSearchParams(location.search);
  const state = { plans: [], plan: null, customer: null, csrf: '', available: false, mode: 'register', busy: false, orderId: query.get('order'), timer: null, pollUntil: 0 };
  const money = (cents, currency = 'BRL') => new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(cents / 100);
  const show = (id, text) => { $(id).textContent = text; $(id).hidden = !text; };
  const errorText = error => error.message || 'Não foi possível concluir. Tente novamente.';
  async function request(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const e = new Error(typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : 'Não foi possível concluir esta solicitação. Tente novamente.'); e.status = response.status; throw e; }
    return data;
  }
  function applySession(data) {
    state.customer = data.customer || null;
    state.csrf = data.csrfToken || '';
    $('signedIn').hidden = !state.customer;
    $('authArea').hidden = !!state.customer;
    if (state.customer) {
      $('customerName').textContent = state.customer.name || 'Sua conta';
      $('customerEmail').textContent = state.customer.email || '';
      $('accountPassword').value = '';
    }
    updateButton();
  }
  function updateButton() {
    $('payButton').disabled = state.busy || !state.plan || !state.customer || !state.csrf || !state.available;
    $('paymentHint').textContent = !state.available ? 'O pagamento online está em configuração. Nenhuma cobrança foi iniciada.' : !state.customer ? 'Acesse sua conta para continuar com este pedido.' : 'Você será direcionado ao provedor para concluir o pagamento.';
  }
  function choosePlan(plan) {
    state.plan = plan;
    $('summaryPlan').textContent = plan.name;
    $('summaryDescription').textContent = plan.description || '';
    $('summaryPrice').textContent = money(plan.priceCents, plan.currency);
    const features = Array.isArray(plan.features) ? plan.features.filter(x => typeof x === 'string') : [];
    const limits = [`${plan.hours} horas de evento`, plan.maxParticipants == null ? 'Participantes ilimitados' : `Até ${plan.maxParticipants} participantes simultâneos`, `Tradução em até ${plan.maxLanguages} idiomas`];
    $('summaryFeatures').replaceChildren(...[...new Set([...limits, ...features])].map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
    for (const input of document.querySelectorAll('input[name="plan"]')) input.checked = input.value === plan.id;
    updateButton();
  }
  function renderPlans(plans) {
    $('planChoices').replaceChildren();
    for (const plan of plans) {
      const label = document.createElement('label'); label.className = 'checkout-plan';
      const input = document.createElement('input'); input.type = 'radio'; input.name = 'plan'; input.value = plan.id; input.addEventListener('change', () => choosePlan(plan));
      const name = document.createElement('strong'); name.textContent = plan.name;
      const price = document.createElement('span'); price.className = 'plan-price'; price.textContent = money(plan.priceCents, plan.currency);
      const details = document.createElement('small'); details.textContent = `${plan.hours} horas · ${plan.maxLanguages} idiomas`;
      const audience = document.createElement('small'); audience.textContent = plan.maxParticipants == null ? 'Participantes ilimitados' : `Até ${plan.maxParticipants} participantes`;
      label.append(input, name, price, details, audience); $('planChoices').append(label);
    }
    const selected = plans.find(plan => plan.id === query.get('plan')) || plans[0];
    if (selected) choosePlan(selected);
    else show('pageMessage', 'Os planos não estão disponíveis no momento. Volte em instantes ou fale com nossa equipe.');
  }
  function setMode(mode) {
    state.mode = mode;
    const register = mode === 'register';
    $('registerTab').classList.toggle('is-active', register); $('registerTab').setAttribute('aria-pressed', String(register));
    $('loginTab').classList.toggle('is-active', !register); $('loginTab').setAttribute('aria-pressed', String(!register));
    for (const label of document.querySelectorAll('.register-only')) { label.hidden = !register; label.querySelector('input').disabled = !register; }
    $('accountName').required = register;
    $('accountPassword').autocomplete = register ? 'new-password' : 'current-password';
    $('accountPassword').minLength = register ? 10 : 1;
    $('passwordHelp').hidden = !register;
    $('accountSubmit').textContent = register ? 'Criar conta e continuar' : 'Entrar na minha conta';
    show('authError', '');
  }
  $('registerTab').addEventListener('click', () => setMode('register'));
  $('loginTab').addEventListener('click', () => setMode('login'));
  $('accountForm').addEventListener('submit', async event => {
    event.preventDefault(); show('authError', '');
    const button = $('accountSubmit'); const old = button.textContent; button.disabled = true; button.textContent = 'Aguarde…';
    try {
      const body = { email: $('accountEmail').value.trim(), password: $('accountPassword').value };
      if (state.mode === 'register') Object.assign(body, { name: $('accountName').value.trim(), company: $('accountCompany').value.trim(), phone: $('accountPhone').value.trim() });
      applySession(await request(`/api/customer/${state.mode === 'register' ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(body) }));
      if (!state.customer || !state.csrf) throw new Error('Não foi possível confirmar seu acesso. Entre novamente.');
      if (state.orderId) { state.pollUntil = Date.now() + 120000; await checkOrder(); }
      else $('termsAccepted').focus();
    } catch (error) { show('authError', errorText(error)); }
    finally { button.disabled = false; button.textContent = old; }
  });
  function approvedCheckoutUrl(value) {
    const url = new URL(value);
    const allowed = ['mercadopago.com', 'mercadopago.com.br'];
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !allowed.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) throw new Error('O provedor retornou um endereço de pagamento inválido. Consulte seu pedido na área do cliente.');
    return url.href;
  }
  $('payButton').addEventListener('click', async () => {
    show('checkoutError', '');
    if (!state.available || !state.plan || !state.customer || !state.csrf || state.busy) return;
    if (!$('eventName').value.trim()) { $('eventName').reportValidity(); $('eventName').focus(); return; }
    if (!$('termsAccepted').checked) { show('checkoutError', 'Confirme que concorda com o plano, valor, duração e limites apresentados.'); $('termsAccepted').focus(); return; }
    state.busy = true; updateButton(); $('payButton').textContent = 'Preparando seu pagamento…';
    try {
      const data = await request('/api/customer/checkout', { method: 'POST', headers: { 'X-CSRF-Token': state.csrf }, body: JSON.stringify({ planId: state.plan.id, planVersion: state.plan.revision || state.plan.updatedAt || state.plan.createdAt, eventName: $('eventName').value.trim(), termsAccepted: true }) });
      if (!data.checkoutUrl) throw new Error('O pagamento ainda não está disponível. Consulte seu pedido na área do cliente.');
      location.assign(approvedCheckoutUrl(data.checkoutUrl));
    } catch (error) { show('checkoutError', errorText(error)); state.busy = false; updateButton(); $('payButton').textContent = 'Continuar para pagamento'; }
  });
  const statuses = {
    paid: ['Pagamento confirmado', 'Seu pagamento foi confirmado. Acesse a área do cliente para organizar o evento.', true],
    approved: ['Pagamento confirmado', 'Seu pagamento foi confirmado. Acesse a área do cliente para organizar o evento.', true],
    pending: ['Aguardando confirmação', 'Seu pagamento ainda está em confirmação. A liberação acontece após a confirmação do provedor.', false],
    in_process: ['Pagamento em análise', 'O provedor está analisando o pagamento. Consulte novamente em instantes.', false],
    processing: ['Pagamento em análise', 'O provedor está analisando o pagamento. Consulte novamente em instantes.', false],
    rejected: ['Pagamento não aprovado', 'O pagamento não foi aprovado. Consulte as opções disponíveis na área do cliente.', true],
    failed: ['Pagamento não concluído', 'Não há confirmação de pagamento. Consulte seu pedido na área do cliente.', true],
    cancelled: ['Pedido cancelado', 'Este pedido foi cancelado. Consulte seus pedidos na área do cliente.', true],
    expired: ['Pedido expirado', 'O prazo deste checkout terminou. Escolha um plano para iniciar um novo pedido.', true],
    refunded: ['Pagamento reembolsado', 'O reembolso deste pedido foi registrado. Consulte os detalhes na área do cliente.', true],
    charged_back: ['Pagamento contestado', 'Este pagamento está contestado. Consulte os detalhes na área do cliente.', true],
    created: ['Aguardando pagamento', 'Seu pedido foi criado e ainda não possui pagamento confirmado.', false]
  };
  function orderDetails(order) {
    const details = [['Pedido', order.id], ['Evento', order.eventName || order.event_name], ['Plano', order.planName || order.plan_name || order.plan?.name]];
    const amount = order.priceCents ?? order.amountCents ?? order.price_cents;
    if (Number.isInteger(amount)) details.push(['Valor', money(amount, order.currency || 'BRL')]);
    $('returnDetails').replaceChildren();
    for (const [name, value] of details) if (value != null) { const dt = document.createElement('dt'); dt.textContent = name; const dd = document.createElement('dd'); dd.textContent = String(value); $('returnDetails').append(dt, dd); }
  }
  async function checkOrder() {
    clearTimeout(state.timer); $('refreshOrder').disabled = true;
    try {
      const data = await request('/api/customer/orders');
      const orders = Array.isArray(data) ? data : data.orders || [];
      const order = orders.find(item => String(item.id) === state.orderId);
      if (!order) { $('returnHeading').textContent = 'Pedido não localizado'; $('returnStatus').textContent = 'Não encontramos este pedido na sua conta. Confira o acesso usado na compra ou consulte a área do cliente.'; $('pollNote').hidden = true; return; }
      const status = statuses[order.status] || ['Status do pedido', `Situação registrada pela plataforma: ${String(order.status || 'aguardando atualização')}.`, false];
      $('returnHeading').textContent = status[0]; $('returnStatus').textContent = order.kind === 'upsell' && order.status === 'paid' ? 'Pagamento confirmado. Os adicionais já estão disponíveis no seu evento. Você pode voltar à mesa de operações.' : status[1]; orderDetails(order);
      if ((order.status === 'paid' || order.status === 'approved') && order.eventId) {
        const stageKit = $('stageKitContainer');
        if (stageKit) {
          stageKit.hidden = false;
          const hostUrl = '/host.html?room=' + encodeURIComponent(order.eventId);
          const screenUrl = '/screen.html?room=' + encodeURIComponent(order.eventId);
          const audienceUrl = location.origin + '/?room=' + encodeURIComponent(order.eventId);
          const qrSvgUrl = '/api/qr?text=' + encodeURIComponent(audienceUrl);

          stageKit.innerHTML = `
            <div class="stage-kit-header">
              <span class="vmt-icon"><span data-icon="sparkles" aria-hidden="true"></span></span>
              <div>
                <h3>✨ Sua Sala foi Ativada com Sucesso!</h3>
                <p class="checkout-fine" style="margin:2px 0 0;">Transmissão, telão e canais de áudio já estão provisionados.</p>
              </div>
            </div>
            <div class="stage-kit-actions">
              <a href="${hostUrl}" target="_blank" rel="noopener noreferrer" class="vmt-btn vmt-primary">
                🎙️ Abrir Mesa do Transmissor (Host)
              </a>
              <a href="${screenUrl}" target="_blank" rel="noopener noreferrer" class="vmt-btn">
                📺 Abrir Telão de Legendas
              </a>
              <a href="/customer.html" class="vmt-btn">
                ⚙️ Painel de Personalização
              </a>
            </div>
            <div class="stage-kit-share">
              <div class="stage-kit-qr">
                <img src="${qrSvgUrl}" alt="QR Code dos Participantes">
              </div>
              <div class="stage-kit-info">
                <label style="font-size:12px; font-weight:600; color:var(--vmt-ink);">Link de Acesso dos Participantes:</label>
                <div style="display:flex; gap:8px;">
                  <input type="text" id="audienceLinkInput" value="${audienceUrl}" readonly onclick="this.select()">
                  <button type="button" class="vmt-btn" id="copyAudienceBtn" style="white-space:nowrap;">Copiar Link</button>
                </div>
                <div style="display:flex; gap:8px; margin-top:6px;">
                  <a href="${qrSvgUrl}" download="${order.eventId}-qrcode.svg" class="vmt-btn" style="font-size:11px; padding:6px 10px;">Baixar QR Code (SVG)</a>
                  <button type="button" class="vmt-btn" id="printSignBtn" style="font-size:11px; padding:6px 10px;">Imprimir Placa de Mesa</button>
                </div>
              </div>
            </div>
          `;

          const copyBtn = document.getElementById('copyAudienceBtn');
          if (copyBtn) {
            copyBtn.onclick = () => {
              navigator.clipboard.writeText(audienceUrl).then(() => {
                copyBtn.textContent = 'Copiado!';
                setTimeout(() => { copyBtn.textContent = 'Copiar Link'; }, 2500);
              }).catch(() => {
                const inp = document.getElementById('audienceLinkInput');
                if (inp) { inp.focus(); inp.select(); }
              });
            };
          }

          const printBtn = document.getElementById('printSignBtn');
          if (printBtn) {
            printBtn.onclick = () => {
              const printWin = window.open('', '_blank');
              if (printWin) {
                printWin.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Placa de Mesa - ${order.eventName || 'Palestra'}</title><style>body{font-family:sans-serif;text-align:center;padding:40px;margin:0;background:#fff;color:#111}.card{border:2px solid #222;border-radius:20px;padding:40px;max-width:480px;margin:0 auto;box-shadow:0 4px 20px rgba(0,0,0,.1)}h1{font-size:26px;margin:0 0 10px}h2{font-size:16px;font-weight:400;color:#555;margin:0 0 25px}img{width:220px;height:220px;margin:0 auto 20px;display:block}.inst{font-size:18px;font-weight:700;margin-bottom:8px}.url{font-family:monospace;font-size:14px;color:#333;word-break:break-all}.ft{margin-top:30px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px}</style></head><body><div class="card"><h1>${order.eventName || 'Tradução Simultânea'}</h1><h2>Aponte a câmera do seu celular para ouvir a tradução ao vivo</h2><img src="${qrSvgUrl}"><div class="inst">Tradução & Legendas no Celular</div><div class="url">${audienceUrl}</div><div class="ft">Silent Stage</div></div><script>window.onload=function(){window.print();}</script></body></html>`);
                printWin.document.close();
              }
            };
          }
        }
      } else if (order.kind === 'upsell' && order.eventId) {
        let link = document.getElementById('returnToOperations');
        if (!link) {
          link = document.createElement('a');
          link.id = 'returnToOperations';
          link.className = 'vmt-btn vmt-primary';
          $('returnPanel').append(link);
        }
        link.href = '/host.html?room=' + encodeURIComponent(order.eventId);
        link.textContent = 'Voltar à mesa de operações';
      }
      if (!status[2] && Date.now() < state.pollUntil) { $('pollNote').hidden = false; state.timer = setTimeout(checkOrder, 5000); }
      else { $('pollNote').textContent = status[2] ? 'Status confirmado pela plataforma.' : 'A consulta automática foi encerrada. Use “Consultar novamente” para atualizar o pedido.'; $('pollNote').hidden = false; }
    } catch (error) {
      if (error.status === 401) { $('returnHeading').textContent = 'Acesse sua conta para consultar'; $('returnStatus').textContent = 'Entre com o e-mail usado na contratação para verificar o status real do pedido.'; $('returnPanel').append($('accountPanel')); setMode('login'); }
      else { $('returnHeading').textContent = 'Não foi possível consultar agora'; $('returnStatus').textContent = errorText(error); }
      $('pollNote').hidden = true;
    } finally { $('refreshOrder').disabled = false; }
  }
  $('refreshOrder').addEventListener('click', () => { state.pollUntil = Date.now() + 120000; checkOrder(); });
  window.addEventListener('pagehide', () => clearTimeout(state.timer));
  async function init() {
    const returning = !!state.orderId;
    $('returnPanel').hidden = !returning; $('purchaseFlow').hidden = returning;
    if (returning) { document.querySelector('.checkout-intro > p:last-child').textContent = 'Acompanhe a confirmação do pedido com os dados da plataforma.'; }
    const session = request('/api/customer/me').then(applySession).catch(error => { if (error.status !== 401) show('pageMessage', 'Não foi possível verificar sua conta. Entre novamente para continuar.'); });
    if (returning) { await session; state.pollUntil = Date.now() + 120000; await checkOrder(); return; }
    await Promise.all([session, request('/api/store/plans').then(data => {
      state.plans = (Array.isArray(data.plans) ? data.plans : []).filter(plan => plan && plan.active !== false && plan.selfService !== false && typeof plan.id === 'string' && typeof plan.name === 'string' && Number.isInteger(plan.priceCents) && plan.priceCents >= 0);
      state.available = data.checkoutAvailable === true; renderPlans(state.plans);
      if (!state.available) show('pageMessage', 'O pagamento online está em configuração. Você pode conhecer os planos e criar sua conta; a contratação será liberada assim que o pagamento estiver disponível.');
    }).catch(error => { $('planChoices').textContent = 'Não foi possível carregar os planos.'; show('pageMessage', errorText(error)); })]);
    updateButton();
  }
  init();
})();
