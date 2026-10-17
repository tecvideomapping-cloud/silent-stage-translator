/* Owner-only budget controls. Polling never starts microphone capture. */
(() => {
  'use strict';
  const el = (tag, cls, value) => { const n = document.createElement(tag); if (cls) n.className = cls; if (value !== undefined) n.textContent = String(value); return n; };
  const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value) / 100);
  const number = value => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(Number(value));
  const state = { event: '', data: null, polling: false, saving: false, selected: null, keys: new Map(), orderKeys: new Map(), exhausted: false, timer: null, stopped: false, lastRefresh: null };
  const root = el('section', 'vmt-glass host-upsells'); root.hidden = true; root.setAttribute('aria-label', 'Consumo e capacidade do evento');
  const heading = el('div', 'upsell-heading'); const headingText = el('div'); headingText.append(el('span', 'host-eyebrow', 'CAPACIDADE DO EVENTO'), el('h2', '', 'Capacidade para o seu evento'));
  const updated = el('span', 'upsell-updated'); heading.append(headingText, updated);
  const budgets = el('div', 'upsell-budgets'); const feedback = el('p', 'upsell-feedback'); feedback.hidden = true; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const offers = el('div', 'upsell-offers'); const pending = el('div', 'upsell-pending'); const resume = el('button', 'vmt-btn', 'Liberar retomada manual da transmissão'); resume.type = 'button'; resume.hidden = true;
  root.append(heading, budgets, feedback, offers, pending, resume);
  const main = document.querySelector('.host-main'); if (!main) return; const title = main.querySelector('.host-page-heading'); if (title) title.after(root); else main.prepend(root);
  const dialog = el('dialog', 'upsell-dialog'); dialog.setAttribute('aria-labelledby', 'upsellDialogTitle');
  const dialogTitle = el('h2', '', 'Ampliar capacidade'); dialogTitle.id = 'upsellDialogTitle';
  const details = el('div', 'upsell-confirm-details'); const total = el('strong', 'upsell-total'); const explanation = el('p', '', 'O adicional será liberado após a confirmação do pagamento. A transmissão continua nesta página.');
  const termsLabel = el('label', 'upsell-terms'); const terms = el('input'); terms.type = 'checkbox'; termsLabel.append(terms, document.createTextNode('Aceito contratar este adicional pelo valor total indicado e os termos da contratação.'));
  const dialogError = el('p', 'upsell-feedback'); dialogError.setAttribute('role', 'alert'); dialogError.hidden = true;
  const actions = el('div', 'upsell-dialog-actions'); const cancel = el('button', 'vmt-btn', 'Cancelar'); cancel.type = 'button'; const pay = el('button', 'vmt-btn vmt-primary', 'Ir para pagamento'); pay.type = 'button'; pay.disabled = true; actions.append(cancel, pay);
  dialog.append(dialogTitle, details, total, explanation, termsLabel, dialogError, actions); document.body.append(dialog);
  let trigger = null;
  let dialogEvent = '';
  function message(value, error = false) { feedback.textContent = value; feedback.hidden = !value; feedback.classList.toggle('is-error', error); }
  function safeUrl(value) { try { const u = new URL(value); const allowed = ['mercadopago.com', 'mercadopago.com.br']; return u.protocol === 'https:' && !u.username && !u.password && allowed.some(domain => u.hostname === domain || u.hostname.endsWith('.' + domain)) ? u.href : ''; } catch { return ''; } }
  async function api(path, options = {}) {
    const response = await fetch('/api/customer' + path, { credentials: 'same-origin', cache: 'no-store', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(response.status === 409 ? 'A oferta mudou ou já existe um pedido pendente. Atualize e confira as condições.' : 'Não foi possível atualizar esta informação. Tente novamente.'); error.status = response.status; throw error; }
    return data;
  }
  function currentEvent() { const input = document.getElementById('roomIdInput'); const params = new URLSearchParams(location.search); return String(input?.value || params.get('room') || params.get('roomId') || '').trim().toLowerCase(); }
  function increments(offer) { return [[offer.addHours, 'horas'], [offer.addParticipants, 'participantes'], [offer.addLanguages, 'idiomas']].filter(([v]) => Number(v) > 0).map(([v, label]) => `+${number(v)} ${label}`).join(' · '); }
  const statuses = { pending: 'Aguardando pagamento', processing: 'Processando pagamento', paid: 'Pagamento confirmado', failed: 'Pagamento não concluído', canceled: 'Cancelado', cancelled: 'Cancelado', expired: 'Expirado', refunded: 'Reembolsado' };
  function render(data) {
    root.hidden = false; budgets.replaceChildren(); offers.replaceChildren(); pending.replaceChildren();
    for (const [key, label, unit] of [['hours', 'Horas de transmissão', 'h'], ['participants', 'Participantes', ''], ['languages', 'Idiomas', '']]) {
      const metric = data.usage[key]; if (!metric) continue;
      const card = el('div', 'upsell-budget'); const unlimited = metric.limit === null; const percentage = Math.max(0, Math.min(100, Number(metric.percent) || 0));
      card.append(el('span', 'upsell-budget-label', label), el('strong', '', `${number(metric.used)}${unit ? ` ${unit}` : ''} / ${unlimited ? 'ilimitado' : `${number(metric.limit)}${unit ? ` ${unit}` : ''}`}`));
      const bar = el('div', 'upsell-budget-track'); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', label); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(percentage)); bar.setAttribute('aria-valuetext', unlimited ? `${number(metric.used)} utilizados; ilimitado` : `${number(metric.used)} de ${number(metric.limit)} utilizados`);
      const fill = el('span'); fill.style.width = `${unlimited ? 0 : percentage}%`; bar.append(fill); card.append(bar, el('small', '', unlimited ? 'Sem limite de capacidade' : `${number(Math.max(0, Number(metric.remaining) || 0))}${unit ? ` ${unit}` : ''} disponíveis`)); if (percentage >= 85) card.classList.add('is-near'); budgets.append(card);
    }
    const orders = Array.isArray(data.pendingOrders) ? data.pendingOrders : [];
    const hasPending = orders.length > 0;
    for (const offer of Array.isArray(data.offers) ? data.offers : []) {
      const card = el('article', 'upsell-offer'); const copy = el('div'); copy.append(el('span', 'host-eyebrow', 'AMPLIAR CAPACIDADE'), el('h3', '', offer.name), el('p', '', offer.description || offer.reason || ''), el('strong', 'upsell-increments', increments(offer)));
      if (Array.isArray(offer.features) && offer.features.length) { const list = el('ul'); offer.features.forEach(feature => list.append(el('li', '', feature))); copy.append(list); }
      const purchase = el('div', 'upsell-purchase'); purchase.append(el('strong', 'upsell-price', money(offer.priceCents)));
      const button = el('button', 'vmt-btn vmt-primary', hasPending ? 'Pagamento pendente' : 'Ampliar evento'); button.type = 'button'; button.disabled = hasPending || data.checkoutAvailable !== true || state.saving;
      button.addEventListener('click', () => openOffer(offer, button)); purchase.append(button); card.append(copy, purchase); offers.append(card);
    }
    if (data.offers?.length && data.checkoutAvailable !== true) offers.append(el('p', 'upsell-feedback', 'O pagamento está temporariamente indisponível.'));
    for (const order of orders) {
      const row = el('div', 'upsell-order'); const text = el('div'); text.append(el('strong', '', order.planName || 'Adicional do evento'), el('p', '', `${statuses[order.status] || 'Status em atualização'} · ${money(order.amountCents)}`)); row.append(text);
      const href = safeUrl(order.checkoutUrl); if (href && order.status !== 'paid') { const link = el('a', 'vmt-btn', 'Continuar pagamento'); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); } pending.append(row);
    }
    const recentOrders = Array.isArray(data.recentOrders) ? data.recentOrders : [];
    for (const order of recentOrders) if (order.status === 'paid' && state.orderKeys.has(String(order.id))) { const key = state.orderKeys.get(String(order.id)); state.keys.delete(key); state.orderKeys.delete(String(order.id)); }
    const recent = recentOrders.find(order => order.status === 'paid');
    if (recent) pending.append(el('p', 'upsell-paid-note', 'Pagamento de adicional confirmado. A capacidade acima já reflete os limites atuais.'));
    if (Number(data.usage.hours?.remaining) <= 0 && data.usage.hours?.limit !== null) state.exhausted = true;
    const broadcast = document.getElementById('broadcastBtn'); resume.hidden = !(state.exhausted && Number(data.usage.hours?.remaining) > 0 && broadcast?.disabled);
    updated.textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  }
  function openOffer(offer, button) { state.selected = offer; dialogEvent = state.event; trigger = button; details.replaceChildren(el('h3', '', offer.name), el('p', '', offer.description || ''), el('strong', 'upsell-increments', increments(offer))); total.textContent = `Total: ${money(offer.priceCents)}`; terms.checked = false; pay.disabled = true; dialogError.hidden = true; dialog.showModal(); cancel.focus(); }
  function closeDialog() { if (state.saving) return; dialog.close(); if (trigger?.isConnected) trigger.focus(); }
  cancel.addEventListener('click', closeDialog); dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); }); terms.addEventListener('change', () => { pay.disabled = !terms.checked || state.saving; });
  pay.addEventListener('click', async () => {
    if (!terms.checked || state.saving || !state.selected) return;
    if (currentEvent() !== dialogEvent) { dialogError.textContent = 'O evento foi alterado. Feche esta confirmação e confira a oferta do evento atual.'; dialogError.hidden = false; return; }
    // Open synchronously with the user gesture; media capture in the host tab is untouched.
    const paymentWindow = window.open('about:blank', '_blank'); if (paymentWindow) paymentWindow.opener = null;
    if (!paymentWindow) { dialogError.textContent = 'Permita abrir uma nova aba para continuar o pagamento sem sair da transmissão.'; dialogError.hidden = false; return; }
    state.saving = true; pay.disabled = true; cancel.disabled = true; dialogError.hidden = true; pay.textContent = 'Preparando pagamento…';
    const selected = state.selected; const targetEvent = dialogEvent; const key = `${targetEvent}:${selected.id}:${selected.revision}`; if (!state.keys.has(key)) state.keys.set(key, crypto.randomUUID());
    try {
      const session = await api('/me'); if (!session.csrfToken) throw new Error('Entre novamente na sua conta para contratar o adicional.');
      const result = await api(`/events/${encodeURIComponent(targetEvent)}/upsells/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': state.keys.get(key) }, body: JSON.stringify({ offerId: selected.id, offerVersion: selected.revision, termsAccepted: true }) });
      if (result.order?.id) state.orderKeys.set(String(result.order.id), key);
      const href = safeUrl(result.checkoutUrl || result.order?.checkoutUrl); if (!href) throw new Error('O link de pagamento ainda não está disponível. Confira o pedido pendente abaixo.');
      paymentWindow.location.replace(href); state.saving = false; closeDialog(); message('Pagamento aberto em outra aba. A capacidade será atualizada aqui após a confirmação.'); await refresh();
    } catch (error) { paymentWindow.close(); dialogError.textContent = error.message; dialogError.hidden = false; if ([401, 404].includes(error.status)) { state.stopped = true; root.hidden = true; } else if (error.status === 409) await refresh(); }
    finally { state.saving = false; pay.disabled = !terms.checked; cancel.disabled = false; pay.textContent = 'Ir para pagamento'; }
  });
  resume.addEventListener('click', () => {
    const button = document.getElementById('broadcastBtn'); if (!button || !state.data || Number(state.data.usage.hours?.remaining) <= 0) return;
    // Reconnect operator transport only. The operator must click the existing Start button.
    try { if (typeof socket !== 'undefined' && socket && socket.readyState < 2) { /* Already connected/connecting. */ } else if (typeof window.connectHostWS === 'function') window.connectHostWS(); button.disabled = false; resume.hidden = true; state.exhausted = false; message('Capacidade disponível. Clique em Iniciar transmissão quando estiver pronto.'); button.focus(); }
    catch { message('Não foi possível reconectar. Tente novamente em instantes.', true); }
  });
  async function refresh() {
    if (state.polling || state.stopped) return;
    const event = currentEvent(); if (!event.startsWith('evt-')) { root.hidden = true; return; }
    if (event !== state.event) { state.event = event; state.data = null; state.exhausted = false; root.hidden = true; }
    state.polling = true;
    try { const data = await api(`/events/${encodeURIComponent(event)}/usage`); if (currentEvent() !== event) return; if (!data.usage) throw new Error('Não foi possível consultar a capacidade.'); state.data = data; state.lastRefresh = Date.now(); render(data); if (!state.saving && !dialog.open) message(''); }
    catch (error) { if ([401, 404].includes(error.status)) { root.hidden = true; if (dialog.open && !state.saving) closeDialog(); } else { if (state.data) root.hidden = false; message('Não foi possível atualizar o consumo. Os últimos valores disponíveis foram mantidos; aguardando nova consulta.', true); } }
    finally { state.polling = false; }
  }
  window.addEventListener('vmt-host-policy-stop', event => {
    if (/(?:hora|hour|quota|limite|limit|esgot|exhaust|capacidade)/i.test(event.detail?.reason || '')) state.exhausted = true;
    refresh();
  });
  refresh(); state.timer = setInterval(refresh, 10000); window.addEventListener('pagehide', () => clearInterval(state.timer), { once: true });
})();
