(() => {
  'use strict';
  const container = document.getElementById('publicProducts');
  if (!container) return;
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }
  function fallback(message) {
    const panel = node('div', 'vmt-glass public-products-notice');
    const text = node('p', 'vmt-muted', message);
    const actions = node('div', 'public-products-actions');
    const retry = node('button', 'vmt-btn', 'Tentar novamente'); retry.type = 'button'; retry.addEventListener('click', load);
    const contact = node('a', 'vmt-btn vmt-primary', 'Pedir um orçamento'); contact.href = '#orcamento';
    actions.append(retry, contact); panel.append(text, actions); container.replaceChildren(panel);
  }
  function card(plan) {
    const article = node('article', 'marketing-plan vmt-glass public-product-card');
    const content = node('div');
    const quote = plan.selfService === false;
    const type = node('span', 'vmt-eyebrow', quote ? 'UMA EXPERIÊNCIA SOB MEDIDA' : 'PARA O SEU PRÓXIMO EVENTO');
    const title = node('h4', 'text-2xl font-bold text-white mt-1', plan.name);
    const description = node('p', 'text-xs text-slate-400 mt-2', plan.description || '');
    const priceBox = node('div', 'my-6');
    const price = node('span', 'text-3xl font-extrabold text-cyan-400');
    price.textContent = quote ? 'Sob consulta' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: plan.currency || 'BRL' }).format(plan.priceCents / 100);
    priceBox.append(price);
    const details = node('ul', 'text-xs text-slate-300 flex flex-col gap-2.5');
    const items = [];
    if (typeof plan.hours === 'number' && plan.hours > 0) items.push(`Até ${plan.hours} horas de evento`);
    if (plan.maxParticipants === null && !quote) items.push('Participantes ilimitados');
    else if (typeof plan.maxParticipants === 'number' && plan.maxParticipants > 0) items.push(`Até ${plan.maxParticipants} participantes simultâneos`);
    if (typeof plan.maxLanguages === 'number' && plan.maxLanguages > 0) items.push(`Tradução em até ${plan.maxLanguages} idiomas`);
    if (Array.isArray(plan.features)) items.push(...plan.features.filter(feature => typeof feature === 'string' && feature.trim()));
    for (const feature of new Set(items)) details.append(node('li', '', `✓ ${feature}`));
    content.append(type, title, description, priceBox, details);
    const action = node('a', quote ? 'vmt-btn public-product-action' : 'vmt-btn vmt-primary public-product-action', quote ? 'Falar com especialista' : 'Selecionar plano');
    action.href = quote ? '#orcamento' : `/checkout.html?plan=${encodeURIComponent(plan.id)}`;
    action.setAttribute('aria-label', `${quote ? 'Pedir orçamento para' : 'Selecionar'} ${plan.name}`);
    article.append(content, action); return article;
  }
  async function load() {
    container.setAttribute('aria-busy', 'true');
    container.replaceChildren(node('p', 'vmt-muted', 'Carregando planos disponíveis…'));
    try {
      const response = await fetch('/api/store/plans', { credentials: 'same-origin' });
      if (!response.ok) throw new Error('catalog');
      const data = await response.json();
      if (!Array.isArray(data.plans)) throw new Error('catalog');
      const plans = data.plans.filter(plan => plan && plan.active !== false && typeof plan.id === 'string' && typeof plan.name === 'string' && (plan.selfService === false || (Number.isInteger(plan.priceCents) && plan.priceCents >= 0)));
      if (!plans.length) { fallback('Estamos preparando os planos disponíveis. Fale com nossa equipe para planejar seu evento.'); return; }
      const cards = plans.map(card);
      container.replaceChildren(...cards);
    } catch {
      fallback('Não foi possível consultar os planos e valores agora. Tente novamente ou peça um orçamento.');
    } finally { container.setAttribute('aria-busy', 'false'); }
  }
  load();
})();
