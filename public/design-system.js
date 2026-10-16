/* Presentation only: shared appearance and local line icons. */
(() => {
  const icons = {
    'audio-lines':'<path d="M3 10v4m4-8v12m5-15v18m5-15v12m4-8v4"/>',
    'calendar-days':'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6m10-6v6M3 11h18M7 15h1m4 0h1m4 0h1M7 18h1m4 0h1"/>',
    'user-round':'<circle cx="12" cy="7" r="4"/><path d="M4 22v-2a8 8 0 0 1 16 0v2"/>',
    'layout-grid':'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    'scan-line':'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M2 12h20"/>',
    'waves':'<path d="M2 6c4-6 6 6 10 0s6 6 10 0M2 12c4-6 6 6 10 0s6 6 10 0M2 18c4-6 6 6 10 0s6 6 10 0"/>',
    'sun':'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    'moon':'<path d="M20.8 13a9 9 0 0 1-9.8-9.8A9 9 0 1 0 20.8 13Z"/>',
    'arrow-up-right':'<path d="M7 17 17 7M7 7h10v10"/>',
    'arrow-right':'<path d="M4 12h16m-6-6 6 6-6 6"/>',
    'arrow-left':'<path d="M20 12H4m6-6-6 6 6 6"/>',
    'external-link':'<path d="M15 3h6v6m0-6L11 13M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
    'layers-2':'<path d="m12 3 10 6-10 6L2 9l10-6Zm-9 13 9 5 9-5"/>',
    'building-2':'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h1m6 0h1M8 11h1m6 0h1M8 15h1m6 0h1M10 21v-4h4v4"/>',
    'inbox':'<path d="M4 4h16l2 11v5H2v-5L4 4Z"/><path d="M2 15h6l2 3h4l2-3h6"/>',
    'book-open':'<path d="M12 5v16M3 3h5l4 2 4-2h5v16h-5l-4 2-4-2H3V3Z"/>',
    'headphones':'<path d="M3 14v-3a9 9 0 0 1 18 0v3"/><rect x="2" y="12" width="5" height="9" rx="2"/><rect x="17" y="12" width="5" height="9" rx="2"/>',
    'languages':'<path d="M3 5h12M9 3v2m-4 4 8 8M13 5c0 6-4 10-10 12m11 4 4-10 4 10m-6.8-3h5.6"/>',
    'radio':'<circle cx="12" cy="12" r="2"/><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16"/>',
    'mic':'<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8"/>',
    'monitor':'<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4m-4 0h8"/>',
    'play':'<path d="m8 4 12 8-12 8V4Z"/>',
    'pause':'<path d="M7 4h3v16H7zm7 0h3v16h-3z"/>',
    'plus':'<path d="M12 5v14M5 12h14"/>',
    'x':'<path d="m6 6 12 12M18 6 6 18"/>',
    'check':'<path d="m5 12 4 4L19 6"/>',
    'shield-check':'<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z"/><path d="m8 12 3 3 5-6"/>',
    'fingerprint':'<path d="M4 13v-2a8 8 0 0 1 16 0v2M7 16v-5a5 5 0 0 1 10 0v5m-7 4v-9a2 2 0 0 1 4 0v10M4 17v3m16-3v3"/>',
    'sparkles':'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Zm7-2v4m-2-2h4"/>',
    'log-out':'<path d="M10 3H4v18h6m-2-9h13m-5-5 5 5-5 5"/>',
    'key-round':'<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-3-3 3-3m-6 0 3-3"/>',
    'sliders-horizontal':'<path d="M3 6h4m4 0h10M3 12h10m4 0h4M3 18h4m4 0h10"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
    'folder-open':'<path d="M3 8V4h6l3 3h9v3M2 10h20l-3 10H4L2 10Z"/>',
    'volume-2':'<path d="M3 9h4l5-5v16l-5-5H3V9Zm13-2a7 7 0 0 1 0 10m3-13a11 11 0 0 1 0 16"/>',
    'volume-1':'<path d="M3 9h4l5-5v16l-5-5H3V9Zm13-2a7 7 0 0 1 0 10"/>',
    'captions':'<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M5 10h5m4 0h5M5 14h8m3 0h3"/>',
    'maximize':'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
    'chevron-right':'<path d="m9 5 7 7-7 7"/>',
    'copy':'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    'settings':'<path d="m10 2-1 3-3 1-3 1 1 4v2l-1 4 3 1 3 1 1 3h4l1-3 3-1 3-1-1-4v-2l1-4-3-1-3-1-1-3h-4Z"/><circle cx="12" cy="12" r="3"/>',
    'save':'<path d="M3 3h15l3 3v15H3V3Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/>',
    'trash-2':'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    'qr-code':'<path d="M3 3h6v6H3zm12 0h6v6h-6zM3 15h6v6H3zM15 15h3v3h3v3h-6v-6Zm-3-3v3m0 3v3m6-9h3M3 12h6"/>',
    'wifi':'<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0m-11 4a6 6 0 0 1 8 0"/><circle cx="12" cy="20" r="1"/>'
  };
  function paintIcons(scope=document) {
    scope.querySelectorAll('[data-icon]:not([data-icon-ready])').forEach(el=>{
      const paths=icons[el.dataset.icon]||icons['audio-lines'];
      el.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
      el.dataset.iconReady='true';
    });
  }
  function setTheme(theme) {
    document.documentElement.dataset.theme=theme;
    try { localStorage.setItem('vmt-theme',theme); } catch {}
    document.querySelectorAll('[data-theme-toggle]').forEach(btn=>{
      btn.innerHTML=`<span data-icon="${theme==='dark'?'sun':'moon'}"></span>`;
      btn.setAttribute('aria-label',theme==='dark'?'Ativar modo claro':'Ativar modo escuro');
      btn.setAttribute('title',theme==='dark'?'Modo claro':'Modo escuro');
    });
    paintIcons();
  }
  function init() {
    let theme='dark'; try { theme=localStorage.getItem('vmt-theme')||'dark'; } catch {}
    setTheme(theme==='light'?'light':'dark');
    document.addEventListener('click',e=>{if(e.target.closest('[data-theme-toggle]'))setTheme(document.documentElement.dataset.theme==='light'?'dark':'light');});
    let scheduled=false;
    new MutationObserver(records=>{
      if(scheduled||!records.some(r=>Array.from(r.addedNodes).some(n=>n.nodeType===1&&(!n.matches?.('svg,path,circle,rect')&&(n.matches?.('[data-icon]')||n.querySelector?.('[data-icon]:not([data-icon-ready])'))))))return;
      scheduled=true;requestAnimationFrame(()=>{scheduled=false;paintIcons();});
    }).observe(document.body,{childList:true,subtree:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
