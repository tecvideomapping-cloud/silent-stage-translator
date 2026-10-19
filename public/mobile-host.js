'use strict';
(() => {
  const enabled = new URLSearchParams(location.search).get('mode') === 'mobile' || (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) <= 900);
  if (!enabled || window.desktopHost?.isElectron) return;
  const panel = document.getElementById('mobileHostPanel');
  if (!panel) return;
  panel.hidden = false;
  document.body.classList.add('mobile-host-focus');
  const state = document.getElementById('mobileCaptureState'), message = document.getElementById('mobileAudioMessage'), wakeState = document.getElementById('mobileWakeState'), resume = document.getElementById('mobileResumeAudio');
  const broadcastButton = document.getElementById('broadcastBtn');
  panel.insertBefore(broadcastButton, message);
  let active = false, connected = false, context = null, wake = null, wakePending = false, generation = 0, waitingForHost = false, cleanup = () => {};
  function describe() {
    if (!active) return;
    state.textContent = !connected ? 'Reconectando ao evento…' : context?.state !== 'running' ? 'Microfone interrompido' : 'Ao vivo · microfone transmitindo';
    resume.hidden = context?.state === 'running';
    if (!connected) message.textContent = 'A conexão caiu. Tentando reconectar; o áudio deste intervalo não será transmitido.';
    else if (context?.state !== 'running') message.textContent = 'Volte a esta página e toque em Retomar microfone. Uma chamada ou o bloqueio da tela pode interromper a captura.';
    else message.textContent = 'Microfone ativo. Mantenha esta página aberta e acompanhe o nível de entrada abaixo.';
  }
  async function keepAwake() {
    if (!active || document.hidden || wake || wakePending) return;
    if (!navigator.wakeLock?.request) { wakeState.textContent = 'Mantenha a tela ligada manualmente durante a transmissão.'; return; }
    const attempt = generation;
    wakePending = true;
    try {
      const acquired = await navigator.wakeLock.request('screen');
      if (!active || attempt !== generation) { await acquired.release(); return; }
      wake = acquired;
      wakeState.textContent = 'Tela mantida acesa durante a transmissão.';
      acquired.addEventListener('release', () => { if (wake === acquired) { wake = null; wakeState.textContent = 'A tela pode bloquear. Mantenha o celular aberto nesta página.'; } }, { once: true });
    } catch { wakeState.textContent = 'Não foi possível manter a tela acesa. Evite bloquear o celular.'; }
    finally { wakePending = false; if (attempt !== generation && active) keepAwake(); }
  }
  async function restore() {
    if (!active || document.hidden) return;
    try { if (context && context.state !== 'running' && context.state !== 'closed') await context.resume(); } catch {}
    describe();
    keepAwake();
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && active) message.textContent = 'Volte ao estúdio para manter a transmissão. O celular pode interromper o microfone em segundo plano.'; else restore(); });
  resume.addEventListener('click', restore);
  window.addEventListener('offline', () => { if (active) { connected = false; describe(); } });
  window.addEventListener('pagehide', () => { if (wake) wake.release().catch(() => {}); });
  document.getElementById('mobileAdvancedToggle').addEventListener('click', event => {
    const expanded = document.body.classList.toggle('mobile-host-advanced');
    event.currentTarget.setAttribute('aria-expanded', String(expanded));
    event.currentTarget.textContent = expanded ? 'Ocultar controles avançados' : 'Mostrar controles avançados';
  });
  window.mobileHost = {
    enabled: true,
    constraints() { const supported = navigator.mediaDevices.getSupportedConstraints?.() || {}; const options = {}; for (const k of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) if (supported[k]) options[k] = true; if (supported.channelCount) options.channelCount = 1; return options; },
    onConnection(value, reason = '') {
      connected = value;
      if (!active && !value && reason.includes('Já existe um transmissor')) {
        waitingForHost = true;
        state.textContent = 'Outra mesa está conectada';
        message.textContent = 'Feche a mesa aberta no computador ou em outro celular. Este aparelho tentará conectar novamente automaticamente.';
      } else if (!active && value && waitingForHost) {
        waitingForHost = false; state.textContent = 'Pronto para transmitir'; message.textContent = 'Mesa conectada. Toque em Iniciar Transmissão para usar o microfone deste celular.';
      }
      describe();
    },
    onPreparing() { state.textContent = 'Preparando microfone…'; message.textContent = 'Permita o uso do microfone quando o navegador solicitar.'; },
    onCaptureStart(audioContext, stream, online) {
      cleanup(); active = true; connected = online; generation++; context = audioContext;
      const changed = () => describe();
      const muted = () => { if (active) { state.textContent = 'Microfone temporariamente indisponível'; message.textContent = 'Verifique a lapela, chamadas em andamento e a permissão de microfone do navegador.'; } };
      const tracks = stream.getAudioTracks();
      context.addEventListener('statechange', changed);
      for (const track of tracks) { track.addEventListener('mute', muted); track.addEventListener('unmute', changed); }
      cleanup = () => { audioContext.removeEventListener('statechange', changed); for (const track of tracks) { track.removeEventListener('mute', muted); track.removeEventListener('unmute', changed); } };
      describe(); keepAwake();
    },
    onCaptureStop() { active = false; generation++; cleanup(); context = null; resume.hidden = true; if (wake) { const held = wake; wake = null; held.release().catch(() => {}); } state.textContent = 'Transmissão encerrada'; message.textContent = 'O microfone foi desligado. Você pode iniciar uma nova transmissão.'; wakeState.textContent = 'A tela pode voltar a bloquear normalmente.'; },
    onError(error) { state.textContent = 'Não foi possível iniciar'; message.textContent = error.name === 'NotAllowedError' ? 'Permita o microfone nas configurações deste site e tente novamente.' : error.name === 'NotFoundError' ? 'Nenhum microfone foi encontrado. Confira o microfone ou a lapela conectada.' : error.name === 'NotReadableError' ? 'O microfone está ocupado. Encerre a chamada ou o aplicativo que está usando a entrada.' : error.message; return true; }
  };
})();
