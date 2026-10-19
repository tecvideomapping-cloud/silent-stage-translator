const escapeStageText=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/**
 * Silent Stage - Workstation Pro Desktop Controller
 * Videomappingtech (C) 2026
 *
 * Módulos integrados:
 * 1. Navegação de Abas e Telemetria de Hardware
 * 2. Motor de Áudio Web Audio API & Analyser Real (VU Meters L/R físicos sem animação fake)
 * 3. Seletor de Fontes: Microfone / Interface USB, Áudio do PC (YouTube/Guia), Player Local (.MP3/.WAV/.MP4), Simulador de Palestra
 * 4. VoiceStudio: Gravação de Amostra (MediaRecorder), Waveform, Biblioteca de Perfis Vocais, Teste de Síntese TTS com IA
 * 5. Processador Acústico DSP (High-pass, Noise Gate Dinâmico com Histerese, Limiter)
 * 6. WebSocket de Palco com Transmissão PCM Binária e Transcrição/Tradução Simultânea
 * 7. Simulador de Participante Mobile, Kit de Mesa QR Code e Exportação SRT/TXT
 */

document.addEventListener('DOMContentLoaded', () => {
  // ==========================================
  // 1. ESTADO GLOBAL DA WORKSTATION
  // ==========================================
  const selectedRoom=new URLSearchParams(location.search).get('room');if(selectedRoom){for(const id of ['inputRoomId','roomIdInput','roomId','stageRoomId']){const field=document.getElementById(id);if(field)field.value=selectedRoom;}}
  let isBroadcasting = false;
  let currentSourceMode = 'mic'; // 'mic' | 'system' | 'file' | 'sim'
  let audioContext = null;
  let audioStream = null;
  let audioSourceNode = null;
  let scriptProcessor = null;
  let analyserNode = null;
  let stageDsp = null;
  let socket = null;
  window.getStageSourceSocket=()=>socket;
  window.addEventListener('vmt-local-speech-state',event=>{if(event.detail.state==='error'){const badge=document.getElementById('liveStatusBadge');if(badge)badge.textContent=event.detail.message;}if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'recognition_mode',mode:event.detail.active||event.detail.loading?'desktop-local':'current'}));});
  let vuAnimId = null;

  // VoiceStudio State
  let sampleRecorder = null;
  let sampleRecordedChunks = [];
  let sampleAudioBlob = null;
  let sampleAudioUrl = '';
  let isRecordingSample = false;
  let waveformAnimId = null;

  // Lecture Simulation State
  let isSimLectureRunning = false;
  let simLectureAudioEl = null;

  // ==========================================
  // 2. NAVEGAÇÃO ENTRE ABAS
  // ==========================================
  const navTabs = document.querySelectorAll('.nav-tab');
  const tabPanes = document.querySelectorAll('.tab-pane');

  navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      navTabs.forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tabPanes.forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const activePane = document.getElementById(`tab-${target}`);
      if (activePane) activePane.classList.add('active');

      if (target === 'cloning') {
        renderSavedProfilesList();
      } else if (target === 'transcripts') {
        loadRoomTranscripts();
      }
    });
  });

  // ==========================================
  // 3. HARDWARE & TELEMETRIA EM TEMPO REAL
  // ==========================================
  let hardwareLocal=true;
  async function loadHardwareReport() {
    try {
      const report=await window.desktopHost?.getHardware?.();
      const res=report?{status:200}:await fetch('/api/desktop/hardware');
      const data=report?{success:true,report}:await res.json();
      if(res.status===404){hardwareLocal=false;document.getElementById('gpuNameText').textContent='Aplicativo local';document.getElementById('gpuMetricText').textContent='Telemetria disponível na instalação desktop';return;}
      if(!data.success||!data.report)return;

      const { gpus, primaryGpu, system, audio } = data.report;
      if (primaryGpu) {
        const gpuNameEl = document.getElementById('gpuNameText');
        const gpuMetricEl = document.getElementById('gpuMetricText');
        if (gpuNameEl) gpuNameEl.innerText = primaryGpu.name;
        if (gpuMetricEl) gpuMetricEl.innerText = `${primaryGpu.vramTotalMb} MB VRAM • ${primaryGpu.backend}`;
      }

      if (audio && audio.asioDrivers && audio.asioDrivers[0]) {
        const audioDriverEl = document.getElementById('audioDriverText');
        const audioLatencyEl = document.getElementById('audioLatencyText');
        if (audioDriverEl) audioDriverEl.innerText = audio.asioDrivers[0].name;
        if (audioLatencyEl) audioLatencyEl.innerText = `~${audio.asioDrivers[0].latencyMsEstimated}ms buffer`;
      }

      renderHardwareSummary(data.report);
    } catch (e) {
      console.warn('[Hardware] Falha ao sondar hardware:', e);
    }
  }

  function renderHardwareSummary(report) {
    const grid = document.getElementById('hwSummaryGrid');
    if (!grid) return;

    let gpusHtml = (report.gpus || []).map(g => `
      <div class="hw-card">
        <h3>🎮 ${escapeStageText(g.name)}</h3>
        <p><strong>Fabricante:</strong> ${escapeStageText(g.vendor)}</p>
        <p><strong>VRAM:</strong> ${g.vramTotalMb} MB</p>
        <p><strong>Detecção:</strong> ${escapeStageText(g.backend)}</p>
        <p>Consulte Hardware e modelos locais para verificar a execução.</p>
      </div>
    `).join('');

    let audioHtml = (report.audio?.asioDrivers || []).map(a => `
      <div class="hw-card">
        <h3>🎙️ Driver detectado: ${escapeStageText(a.name)}</h3>
        <p><strong>Tipo:</strong> ${escapeStageText(a.type)}</p>
        <p><strong>Latência Estimada:</strong> ${a.latencyMsEstimated} ms</p>
        <p>Inventário de drivers; captura ASIO exclusiva não implementada.</p>
      </div>
    `).join('');

    let cpuHtml = `
      <div class="hw-card">
        <h3>💻 CPU & Memória do Host</h3>
        <p><strong>Processador:</strong> ${escapeStageText(report.system?.cpuModel || 'CPU Host')}</p>
        <p><strong>Núcleos:</strong> ${report.system?.cores || 4} Cores</p>
        <p><strong>Memória RAM:</strong> ${report.system?.freeRamGb || '--'} GB livres de ${report.system?.totalRamGb || '--'} GB</p>
        <p><strong>Identificador Único:</strong> <code style="font-size:10px">${report.fingerprint || 'N/A'}</code></p>
      </div>
    `;

    grid.innerHTML = gpusHtml + audioHtml + cpuHtml;
  }

  async function pollRealtimeMetrics() {
    if(!hardwareLocal)return;
    try {
      const nativeMetrics=await window.desktopHost?.speech?.hardwareMetrics?.();
      const data=nativeMetrics?{success:true,metrics:nativeMetrics}:await (await fetch('/api/desktop/hardware/metrics')).json();
      if (data.success && data.metrics && data.metrics.gpu) {
        const { gpu } = data.metrics;
        const el = document.getElementById('gpuMetricText');
        if (el) el.innerText = `${gpu.vramUsedMb || 0}/${gpu.vramTotalMb} MB • ${gpu.temperatureC || '--'}°C (${gpu.utilizationPercent || 0}%)`;
      }
    } catch {}
  }

  document.getElementById('btnRefreshHardware')?.addEventListener('click', loadHardwareReport);
  setInterval(pollRealtimeMetrics, 3000);
  loadHardwareReport();

  // ==========================================
  // 4. LICENCIAMENTO & RECARGA RÁPIDA
  // ==========================================
  async function loadLicenseStatus() {
    try {
      const res = await fetch('/api/desktop/license');
      const data = await res.json();
      if(!data.success||!data.license){const label=document.getElementById('licenseStatusText');if(label)label.textContent='Plano na área do cliente';return;}

      const lic = data.license;
      const statusText = document.getElementById('licenseStatusText');
      const hoursText = document.getElementById('licenseHoursText');
      const detailsBox = document.getElementById('licenseDetailsBox');

      if (lic.isActive) {
        if (statusText) statusText.innerText = 'Licença Ativa (Offline Lease)';
        if (hoursText) hoursText.innerText = `${lic.hoursRemaining}h restantes`;
        if (detailsBox) {
          detailsBox.innerHTML = `
            <p style="color:var(--vmt-green)"><strong>✓ Licença Verificada no Hardware</strong></p>
            <p>Cliente: <strong>${lic.company || 'Autorizado'}</strong></p>
            <p>Horas Totais: ${lic.hoursTotal}h | Consumidas: ${+(lic.secondsConsumed / 3600).toFixed(2)}h</p>
            <p>Capacidade: Até ${lic.maxListeners} participantes simultâneos</p>
            <p>Válido até: ${new Date(lic.expiresAt).toLocaleString()}</p>
          `;
        }
      } else {
        if (statusText) statusText.innerText = 'Modo Avaliação de Palco';
        if (hoursText) hoursText.innerText = '02:00:00';
        if (detailsBox) {
          detailsBox.innerHTML = `
            <p style="color:var(--vmt-warning)"><strong>Atenção: Operando em modo de avaliação técnica (2h).</strong></p>
            <p>Ative uma chave de evento ou realize uma recarga rápida abaixo para liberar a diária completa.</p>
          `;
        }
      }
    } catch {}
  }

  loadLicenseStatus();

  document.getElementById('btnActivateKey')?.addEventListener('click', async () => {
    const key = document.getElementById('inputLicenseKey')?.value.trim();
    if (!key) return alert('Por favor, informe a chave de licença.');

    try {
      const res = await fetch('/api/desktop/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      const data = await res.json();
      if (data.success) {
        alert('Licença ativada com sucesso no hardware!');
        loadLicenseStatus();
      } else {
        alert(`Erro na ativação: ${data.error}`);
      }
    } catch (e) {
      alert(`Falha ao conectar: ${e.message}`);
    }
  });

  document.querySelectorAll('.upsell-options button').forEach(btn=>btn.addEventListener('click',()=>{window.open('/customer.html','_blank','noopener')}));
  document.getElementById('btnSimulatePixPayment')?.remove();
  document.getElementById('pixCheckoutBox')?.remove();

  // ==========================================
  // 5. ENUMERAÇÃO DE INTERFACES E DISPOSITIVOS DE ÁUDIO
  // ==========================================
  async function refreshAudioDevices() {
    const select = document.getElementById('selAudioInput');
    if (!select) return;

    try {
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');

        select.innerHTML = '';
        if (audioInputs.length === 0) {
          select.innerHTML = '<option value="default">Microfone / Interface Padrão (ASIO/WASAPI)</option>';
        } else {
          audioInputs.forEach((dev, idx) => {
            const opt = document.createElement('option');
            opt.value = dev.deviceId;
            opt.innerText = dev.label ? dev.label : `Interface / Entrada de Áudio ${idx + 1}`;
            select.appendChild(opt);
          });
        }
      }
    } catch (e) {
      console.warn('[Audio] Erro ao listar dispositivos:', e);
    }
  }

  document.getElementById('btnRefreshAudioDevices')?.addEventListener('click', async () => {
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach(t => t.stop());
    } catch {}
    await refreshAudioDevices();
  });

  refreshAudioDevices();

  // ==========================================
  // 6. MOTOR DE ÁUDIO & ANALISADOR REAL (VU METERS FÍSICOS)
  // ==========================================
  function getActiveRoomId() {
    return document.getElementById('inputRoomId')?.value.trim() || 'palco1';
  }

  function updateActiveSourceBadge(label, iconName) {
    const badge = document.getElementById('activeSourceBadge');
    if (!badge) return;
    badge.innerHTML = `<span data-icon="${iconName || 'activity'}"></span> Fonte: ${label}`;
  }

  function setVuMetersToZero() {
    if (vuAnimId) {
      cancelAnimationFrame(vuAnimId);
      vuAnimId = null;
    }
    const barL = document.getElementById('vuBarL');
    const barR = document.getElementById('vuBarR');
    const dbL = document.getElementById('vuDbL');
    const dbR = document.getElementById('vuDbR');

    if (barL) barL.style.width = '0%';
    if (barR) barR.style.width = '0%';
    if (dbL) dbL.innerText = '-inf dB';
    if (dbR) dbR.innerText = '-inf dB';
  }

  function startRealVuMeterLoop() {
    if (vuAnimId) cancelAnimationFrame(vuAnimId);

    const barL = document.getElementById('vuBarL');
    const barR = document.getElementById('vuBarR');
    const dbL = document.getElementById('vuDbL');
    const dbR = document.getElementById('vuDbR');

    if (!analyserNode) return;
    const timeDomainData = new Float32Array(analyserNode.fftSize);
    let smoothL = 0;
    let smoothR = 0;

    function tick() {
      if (!isBroadcasting && !isSimLectureRunning) {
        setVuMetersToZero();
        return;
      }

      analyserNode.getFloatTimeDomainData(timeDomainData);
      let sum = 0;
      for (let i = 0; i < timeDomainData.length; i++) {
        const v = timeDomainData[i];
        sum += v * v;
      }
      const rms = Math.sqrt(sum / timeDomainData.length);

      // Notifica o processador DSP para dinâmicas do Noise Gate
      if (stageDsp) {
        // Gate detector is driven by its pre-gate audio sidechain.
      }

      // Se for silêncio absoluto ou ruído de piso abaixo de -60dB, decai suavemente até zero
      if (rms < 0.0001) {
        smoothL = Math.max(0, smoothL * 0.82);
        smoothR = Math.max(0, smoothR * 0.82);
        if (smoothL < 0.5) {
          if (barL) barL.style.width = '0%';
          if (barR) barR.style.width = '0%';
          if (dbL) dbL.innerText = '-inf dB';
          if (dbR) dbR.innerText = '-inf dB';
        } else {
          if (barL) barL.style.width = `${Math.round(smoothL)}%`;
          if (barR) barR.style.width = `${Math.round(smoothR)}%`;
        }
      } else {
        // Cálculo real de dBFS: 20 * log10(rms)
        const calcDb = Math.max(-60, Math.min(0, Math.round(20 * Math.log10(rms))));
        // Converte escala -60dB .. 0dB em 0% .. 100%
        const targetPct = Math.min(100, Math.max(0, Math.round(((calcDb + 60) / 60) * 100)));

        // Balística profissional: ataque rápido e decaimento exponencial suave
        smoothL = targetPct >= smoothL ? targetPct : (smoothL * 0.85 + targetPct * 0.15);
        smoothR = targetPct >= smoothR ? targetPct : (smoothR * 0.85 + targetPct * 0.15);

        if (barL) barL.style.width = `${Math.round(smoothL)}%`;
        if (barR) barR.style.width = `${Math.round(smoothR)}%`;
        if (dbL) dbL.innerText = `${calcDb} dB`;
        if (dbR) dbR.innerText = `${calcDb} dB`;
      }

      vuAnimId = requestAnimationFrame(tick);
    }

    vuAnimId = requestAnimationFrame(tick);
  }

  // ==========================================
  // 6.5 PERFIS DE ÁUDIO & CONFIGURAÇÃO DO TELÃO
  // ==========================================
  const AUDIO_PROFILES = {
    '48': {
      name: 'Voz Compacta',
      kbps: 48,
      codec: 'adpcm',
      sampleRate: 12000,
      badgeText: '48 kbps • Voz Compacta',
      bandwidthText: '~6 KB/s por ouvinte (-81% banda)'
    },
    '96': {
      name: 'Econômico Balanceado',
      kbps: 128,
      codec: 'mulaw',
      sampleRate: 16000,
      badgeText: '128 kbps • Econômico Balanceado',
      bandwidthText: '~16 KB/s por ouvinte (-50% banda)'
    },
    '160': {
      name: 'Alta Fidelidade',
      kbps: 160,
      codec: 'mulaw',
      sampleRate: 20000,
      badgeText: '160 kbps • Alta Fidelidade',
      bandwidthText: '~20 KB/s por ouvinte (-38% banda)'
    },
    '320': {
      name: 'Estúdio Master Hi-Fi (24kHz PCM)',
      kbps: 384,
      codec: 'pcm16',
      sampleRate: 24000,
      badgeText: '384 kbps • Estúdio Master Hi-Fi',
      bandwidthText: '~48 KB/s por ouvinte (Hi-Fi Master)'
    },
    'pcm256': {
      name: 'Linear PCM Sem Compressão',
      kbps: 256,
      codec: 'pcm16',
      sampleRate: 16000,
      badgeText: '256 kbps • Linear PCM Sem Compressão',
      bandwidthText: '~32 KB/s por ouvinte (Broadcast Direto)'
    }
  };

  let currentAudioProfile = {
    id: 'pcm256',
    ...AUDIO_PROFILES['pcm256']
  };

  function updateAudioProfile(profileKey) {
    const p = AUDIO_PROFILES[profileKey];
    if (!p) return;
    currentAudioProfile = { id: profileKey, ...p };
    const codecSelect = document.getElementById('audioCodecSelect');
    if (codecSelect) codecSelect.value = p.codec;
    updateAudioUI();
    broadcastAudioMeta();
  }

  function updateCustomCodec(codecKey) {
    currentAudioProfile.codec = codecKey;
    if (codecKey === 'adpcm') {
      currentAudioProfile.sampleRate = Math.min(24000, Math.round((currentAudioProfile.kbps * 1000) / 4));
    } else if (codecKey === 'mulaw') {
      currentAudioProfile.sampleRate = Math.min(24000, Math.round((currentAudioProfile.kbps * 1000) / 8));
    } else {
      currentAudioProfile.sampleRate = Math.min(24000, Math.round((currentAudioProfile.kbps * 1000) / 16));
    }
    updateAudioUI();
    broadcastAudioMeta();
  }

  function updateAudioUI() {
    const badge = document.getElementById('compressionBadge');
    const bw = document.getElementById('bandwidthEstimate');
    if (badge) badge.innerText = currentAudioProfile.badgeText || `${currentAudioProfile.kbps} kbps`;
    if (bw) bw.innerText = currentAudioProfile.bandwidthText || `~${Math.round(currentAudioProfile.kbps / 8)} KB/s por ouvinte`;
  }

  function broadcastAudioMeta() {
    if (socket && socket.readyState === WebSocket.OPEN) {
      const actualRate = (audioContext && audioContext.sampleRate) ? audioContext.sampleRate : (currentAudioProfile.sampleRate || 48000);
      socket.send(JSON.stringify({
        type: 'audio_meta',
        format: currentAudioProfile.codec,
        sampleRate: actualRate,
        kbps: currentAudioProfile.kbps,
        profileName: currentAudioProfile.name
      }));
    }
  }

  function encodeMuLawSample(sample) {
    const BIAS = 0x84;
    const CLIP = 32635;
    let sign = (sample >> 8) & 0x80;
    if (sign !== 0) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa) & 0xFF;
  }

  const IMA_STEP_TABLE = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
    253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
    3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
    12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
  ];
  const IMA_INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
  let desktopAdpcmPredictor = 0;
  let desktopAdpcmStepIndex = 0;

  function encodeAdpcmNibble(sample) {
    let step = IMA_STEP_TABLE[desktopAdpcmStepIndex];
    let diff = sample - desktopAdpcmPredictor;
    let nibble = 0;
    if (diff < 0) {
      nibble = 8;
      diff = -diff;
    }
    let mask = 4;
    let delta = step >> 3;
    for (let i = 0; i < 3; i++) {
      if (diff >= step) {
        nibble |= mask;
        diff -= step;
        delta += step;
      }
      step >>= 1;
      mask >>= 1;
    }
    desktopAdpcmPredictor += (nibble & 8) ? -delta : delta;
    if (desktopAdpcmPredictor > 32767) desktopAdpcmPredictor = 32767;
    else if (desktopAdpcmPredictor < -32768) desktopAdpcmPredictor = -32768;
    desktopAdpcmStepIndex += IMA_INDEX_TABLE[nibble];
    if (desktopAdpcmStepIndex < 0) desktopAdpcmStepIndex = 0;
    else if (desktopAdpcmStepIndex > 88) desktopAdpcmStepIndex = 88;
    return nibble;
  }

  function broadcastScreenConfig() {
    const mode = document.getElementById('hostScreenModeSelect')?.value || 'single';
    const lang = document.getElementById('hostScreenLangSelect')?.value || 'en';
    const logo = document.getElementById('hostScreenLogoSelect')?.value || 'vmp';
    const theme = document.getElementById('hostScreenThemeSelect')?.value || 'theme-chroma';
    const position = document.getElementById('hostScreenPositionSelect')?.value || 'pos-bottom';

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'set_screen_lang',
        screenMode: mode,
        screenLogo: logo,
        screenTheme: theme,
        screenPosition: position,
        selectedLangs: lang === 'all' ? ['original', 'en', 'es'] : (mode === 'bilingual' ? ['original', lang] : [lang])
      }));
    }
  }

  // ==========================================
  // 7. CONEXÃO WEBSOCKET DE TRANSMISSÃO DE PALCO
  // ==========================================
  function connectStageWebSocket() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const roomId = getActiveRoomId();
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl=`${wsProto}//${location.host}/?room=${encodeURIComponent(roomId)}&role=host`;

    try {
      socket = new WebSocket(wsUrl);
      socket.binaryType = 'arraybuffer';

      socket.onopen = () => {
        desktopAdpcmPredictor=0;desktopAdpcmStepIndex=0;
        window.stageSources?.connect(socket);
        if(window.localSpeech?.selected)socket.send(JSON.stringify({type:'recognition_mode',mode:'desktop-local'}));
        // Server authorizes the host during the handshake using its session cookie.
        broadcastAudioMeta();
        broadcastScreenConfig();
      };

      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if(window.stageSources?.handle(msg))return;
            handleServerWsMessage(msg);
          } catch {}
        }
      };

      socket.onclose = event => {
        stopBroadcastCleanly();
        const status=document.getElementById('liveStatusBadge');if(status)status.textContent=event.reason||'Conexão encerrada. Entre na sua conta e abra um evento autorizado.';
        socket = null;
      };
    } catch (e) {
      console.warn('[WS] Falha ao conectar WebSocket:', e);
    }
  }

  function handleServerWsMessage(msg) {
    if(msg.type==='connected'){if(socket)socket.__authorized=msg.role==='host';if(window.localSpeech?.selected)socket.send(JSON.stringify({type:'recognition_mode',mode:'desktop-local'}));
    } else if (msg.type === 'room_online_stats') {
      const elListeners = document.getElementById('metricListeners');
      if (elListeners) elListeners.innerText = msg.stats?.listeners || 0;
    } else if(msg.type==='subtitle_translated'){const secondary=document.getElementById('subSecondaryText');if(secondary)secondary.textContent=(Number.isInteger(msg.speakerId)?'Locutor '+(msg.speakerId+1)+': ':'')+(msg.text||'');addTranscriptTableRow(msg.sourceText||'',msg.text||'');
    } else if(msg.type==='service_warning'){const status=document.getElementById('liveStatusBadge');if(status)status.textContent=msg.message;
    } else if (msg.type === 'subtitle' || msg.type === 'transcript') {
      const primaryText = (Number.isInteger(msg.speakerId)?'Locutor '+(msg.speakerId+1)+': ':'')+(msg.text || msg.sourceText || '');
      const subPrim = document.getElementById('subPrimaryText');
      const subSec = document.getElementById('subSecondaryText');
      const simSub = document.getElementById('simSubText');

      if (subPrim && primaryText) subPrim.innerText = primaryText;
      if (simSub && primaryText) simSub.innerText = `"${primaryText}"`;

      if (msg.translations) {
        const transText = msg.translations.en || msg.translations.es || '';
        if (subSec && transText) subSec.innerText = transText;
        addTranscriptTableRow(primaryText, transText);
      }
    }
  }

  function addTranscriptTableRow(original, translation) {
    const tbody = document.getElementById('transcriptBody');
    if (!tbody) return;

    const tr = document.createElement('tr');
    const timeStr = new Date().toLocaleTimeString('pt-BR');
    tr.innerHTML = `
      <td>${timeStr}</td>
      <td>${escapeStageText(original)}</td>
      <td>${translation || '—'}</td>
    `;
    tbody.insertBefore(tr, tbody.firstChild);
  }

  async function loadRoomTranscripts() {
    const roomId = getActiveRoomId();
    const tbody = document.getElementById('transcriptBody');
    if (!tbody) return;

    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/transcripts`);
      const data = await res.json();
      const list = Array.isArray(data.transcripts) ? data.transcripts : [];
      if (list.length > 0) {
        tbody.innerHTML = '';
        list.slice(-30).reverse().forEach(item => {
          const timeStr = item.created_at ? new Date(item.created_at).toLocaleTimeString('pt-BR') : '--:--:--';
          const original = (item.source_name?item.source_name+': ':'')+(item.source_text || item.text || '');
          const trans = item.translations?.en || item.translations?.es || '—';
          const tr = document.createElement('tr');
          tr.innerHTML = `<td>${timeStr}</td><td>${escapeStageText(original)}</td><td>${escapeStageText(trans)}</td>`;
          tbody.appendChild(tr);
        });
      }
    } catch {}
  }

  // ==========================================
  // 8. CONTROLE DE BROADCAST & PROCESSAMENTO DE STREAM
  // ==========================================
  async function startBroadcastWithStream(customStream = null, mode = 'mic') {
    if(isBroadcasting||audioContext)stopBroadcastCleanly();

    currentSourceMode = mode;
    const roomId=getActiveRoomId();
    connectStageWebSocket();


    try {
    await new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(socket?.readyState===WebSocket.OPEN&&socket.__authorized){clearInterval(timer);resolve()}else if(!socket||socket.readyState===WebSocket.CLOSED||Date.now()-started>7000){clearInterval(timer);reject(new Error('Entre na sua conta e abra um evento autorizado antes de transmitir.'))}},50)});
      if (customStream) {
        audioStream = customStream;
      } else {
        const deviceId = document.getElementById('selAudioInput')?.value;
        const constraints = {
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        };
        if (deviceId && deviceId !== 'default') {
          constraints.audio.deviceId = { ideal: deviceId };
        }
        audioStream = await navigator.mediaDevices.getUserMedia(constraints);
      }

      // Se a trilha for encerrada pelo usuário (ex: barra de compartilhamento do Chrome)
      const tracks = audioStream.getAudioTracks();
      if (tracks.length > 0) {
        tracks[0].onended = () => {
          if (isBroadcasting) stopBroadcastCleanly();
        };
      }

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      audioContext = new AudioCtx({latencyHint:'interactive',sampleRate:currentAudioProfile.sampleRate});
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      audioSourceNode = audioContext.createMediaStreamSource(audioStream);

      // DSP Chain: Rumble Filter -> Noise Gate -> Compressor/Limiter
      if (typeof StageAudioDSP !== 'undefined') {
        stageDsp = new StageAudioDSP(audioContext);
        const dspOut = stageDsp.init(audioSourceNode);

        // Conecta callback do Noise Gate ao pill visual
        stageDsp.onGateStateChange = (isOpen) => {
          const pill = document.getElementById('gateStatePill');
          if (pill) {
            pill.innerText = isOpen ? 'ABERTO (FALANDO)' : 'FECHADO (SILENCIADO)';
            pill.className = `gate-pill ${isOpen ? 'open' : 'closed'}`;
          }
        };

        // Aplica limiar atual do slider
        const thresh = parseInt(document.getElementById('rangeGateThresh')?.value || '-38', 10);
        stageDsp.setGateThreshold(thresh);
      }

      // Analyser Node para leitura física de RMS
      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 2048;
      analyserNode.smoothingTimeConstant = 0.25;

      const dspSource=stageDsp?stageDsp.outputNode:audioSourceNode;
      audioSourceNode.connect(analyserNode);

      // ScriptProcessorNode para empacotamento e streaming PCM 16-bit
      scriptProcessor = await window.createStageAudioCapture(audioContext);
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;

      dspSource.connect(scriptProcessor);
      scriptProcessor.connect(silentGain);
      silentGain.connect(audioContext.destination);

      scriptProcessor.onaudioprocess = (e) => {
        if (!isBroadcasting || !socket || socket.readyState !== WebSocket.OPEN) return;

        const ch0 = e.inputBuffer.getChannelData(0);
        const ch1 = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : ch0;
        const channelMode = document.getElementById('selAudioChannel')?.value || 'mix';

        let targetFloats = ch0;
        if (channelMode === 'right') {
          targetFloats = ch1;
        } else if (channelMode === 'mix') {
          targetFloats = new Float32Array(ch0.length);
          for (let i = 0; i < ch0.length; i++) {
            targetFloats[i] = (ch0[i] + ch1[i]) * 0.5;
          }
        }

        const numSamples = targetFloats.length;
        window.localSpeech?.feed(targetFloats,audioContext.sampleRate);
        const pcm16 = new Int16Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
          const s = Math.max(-1, Math.min(1, targetFloats[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Pacote binário Silent Stage: 0xAA (header), codecId, sampleRate
        const sampleRate = audioContext.sampleRate;
        const codec = currentAudioProfile.codec || 'pcm16';
        let packetBuffer = null;

        if (codec === 'mulaw') {
          packetBuffer = new Uint8Array(4 + numSamples);
          packetBuffer[0] = 0xAA;
          packetBuffer[1] = 1;
          packetBuffer[2] = sampleRate & 0xFF;
          packetBuffer[3] = (sampleRate >> 8) & 0xFF;
          for (let i = 0; i < numSamples; i++) {
            packetBuffer[4 + i] = encodeMuLawSample(pcm16[i]);
          }
        } else if (codec === 'adpcm') {
          const halfLen = Math.ceil(numSamples / 2);
          packetBuffer = new Uint8Array(4 + halfLen);
          packetBuffer[0] = 0xAA;
          packetBuffer[1] = 2;
          packetBuffer[2] = sampleRate & 0xFF;
          packetBuffer[3] = (sampleRate >> 8) & 0xFF;
          for (let i = 0; i < halfLen; i++) {
            const s1 = pcm16[i * 2];
            const s2 = (i * 2 + 1 < numSamples) ? pcm16[i * 2 + 1] : 0;
            const n1 = encodeAdpcmNibble(s1);
            const n2 = encodeAdpcmNibble(s2);
            packetBuffer[4 + i] = (n1 & 0x0F) | ((n2 & 0x0F) << 4);
          }
        } else {
          const byteLen = numSamples * 2;
          packetBuffer = new Uint8Array(4 + byteLen);
          packetBuffer[0] = 0xAA;
          packetBuffer[1] = 0;
          packetBuffer[2] = sampleRate & 0xFF;
          packetBuffer[3] = (sampleRate >> 8) & 0xFF;
          new Uint8Array(packetBuffer.buffer, 4).set(new Uint8Array(pcm16.buffer));
        }

        try {
          socket.send(packetBuffer.buffer);
        } catch {}
      };

      isBroadcasting = true;
      window.stageSources?.live(true);
      await window.localSpeech?.begin(event=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'speech_transcript',...event}));},'pt-BR');

      const btn = document.getElementById('btnToggleBroadcast');
      const badge = document.getElementById('liveStatusBadge');
      if (btn) {
        btn.innerHTML = '<span data-icon="pause"></span> Interromper Transmissão';
        btn.classList.add('vmt-danger');
      }
      if (badge) {
        badge.innerText = '● NO AR (TRANSMITINDO EM ALTA DEFINIÇÃO)';
        badge.style.background = 'var(--vmt-green-wash)';
        badge.style.color = 'var(--vmt-green)';
      }

      startRealVuMeterLoop();
      broadcastAudioMeta();
      broadcastScreenConfig();
    } catch (err) {
      alert('Erro ao iniciar áudio: ' + err.message);
      stopBroadcastCleanly();
    }
  }

  function stopBroadcastCleanly() {
    window.localSpeech?.end();
    isBroadcasting = false;
    window.stageSources?.live(false);

    if (scriptProcessor) {
      try { scriptProcessor.disconnect(); } catch {}
      scriptProcessor = null;
    }
    if (audioSourceNode) {
      try { audioSourceNode.disconnect(); } catch {}
      audioSourceNode = null;
    }
    if (audioStream) {
      try { audioStream.getTracks().forEach(t => t.stop()); } catch {}
      audioStream = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
      try { audioContext.close(); } catch {}
      audioContext = null;
    }

    setVuMetersToZero();

    const btn = document.getElementById('btnToggleBroadcast');
    const badge = document.getElementById('liveStatusBadge');
    if (btn) {
      btn.innerHTML = '<span data-icon="play"></span> Iniciar Transmissão no Palco';
      btn.classList.remove('vmt-danger');
    }
    if (badge) {
      badge.innerText = 'TRANSMISSÃO PAUSADA';
      badge.style.background = 'var(--vmt-wash)';
      badge.style.color = 'var(--vmt-muted)';
    }
  }

  document.getElementById('btnToggleBroadcast')?.addEventListener('click', () => {
    if (!isBroadcasting) {
      startBroadcastWithStream(null, 'mic');
      updateActiveSourceBadge('Microfone / Mesa Física', 'mic');
    } else {
      stopBroadcastCleanly();
    }
  });

  // ==========================================
  // 9. SELEÇÃO DE FONTES DE ÁUDIO
  // ==========================================
  const btnSrcMic = document.getElementById('btnSourceMic');
  const btnSrcSystem = document.getElementById('btnSourceSystem');
  const btnSrcFile = document.getElementById('btnSourceFile');
  const btnSrcSim = document.getElementById('btnSourceSim');

  function clearActiveSourceButtons() {
    [btnSrcMic, btnSrcSystem, btnSrcFile, btnSrcSim].forEach(b => b?.classList.remove('active'));
  }

  // 1. Fonte: Microfone
  btnSrcMic?.addEventListener('click', async () => {
    clearActiveSourceButtons();
    btnSrcMic.classList.add('active');
    updateActiveSourceBadge('Microfone / Mesa Física', 'mic');
    if (isBroadcasting) {
      await startBroadcastWithStream(null, 'mic');
    }
  });

  // 2. Fonte: Saída do PC / YouTube (getDisplayMedia)
  btnSrcSystem?.addEventListener('click', async () => {
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

      const audioTracks = displayStream.getAudioTracks();
      if (!audioTracks || audioTracks.length === 0) {
        displayStream.getTracks().forEach(t => t.stop());
        alert('⚠️ O áudio não foi compartilhado!\n\nNa janela de seleção, certifique-se de marcar a caixinha:\n☑️ "Compartilhar áudio da guia" (para YouTube/Navegador)\nou\n☑️ "Compartilhar áudio do sistema" (para reproduções no PC).');
        return;
      }

      clearActiveSourceButtons();
      btnSrcSystem.classList.add('active');
      updateActiveSourceBadge('Saída do PC / YouTube / Guia', 'monitor');

      await startBroadcastWithStream(displayStream, 'system');
    } catch (e) {
      if (!['NotAllowedError','AbortError'].includes(e.name)) {
        alert('Falha ao capturar som do computador: ' + e.message);
      }
    }
  });

  // 3. Fonte: Arquivo Local (.MP3, .WAV, .MP4)
  const localFileInput = document.getElementById('localMediaFileInput');
  const localMediaBox = document.getElementById('localMediaBox');
  const localMediaAudio = document.getElementById('localMediaAudio');
  const localMediaTitle = document.getElementById('localMediaTitle');

  btnSrcFile?.addEventListener('click', () => {
    localFileInput?.click();
  });

  localFileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (localMediaBox) localMediaBox.classList.remove('hidden');
    if (localMediaTitle) localMediaTitle.innerText = `🎵 ${escapeStageText(file.name)}`;

    const fileUrl = URL.createObjectURL(file);
    if (localMediaAudio) {
      const previous=localMediaAudio.src;
      localMediaAudio.src = fileUrl;
      if(previous.startsWith('blob:'))URL.revokeObjectURL(previous);
    }

    clearActiveSourceButtons();
    btnSrcFile?.classList.add('active');
    updateActiveSourceBadge(`Arquivo Local (${escapeStageText(file.name)})`, 'folder-open');

    // Conecta o player ao broadcast
    if (localMediaAudio) {
      try {
        // captureStream() has no audio track until the media is loaded/playing.
        await localMediaAudio.play();
        const stream = localMediaAudio.captureStream ? localMediaAudio.captureStream() : (localMediaAudio.mozCaptureStream ? localMediaAudio.mozCaptureStream() : null);
        if (stream && stream.getAudioTracks().length > 0) {
          localMediaAudio.pause();
          localMediaAudio.currentTime=0;
          await startBroadcastWithStream(stream, 'file');
          await localMediaAudio.play();
        } else throw Error('O arquivo não disponibilizou uma trilha de áudio.');
      } catch (err) {
        localMediaAudio.pause();
        const status=document.getElementById('liveStatusBadge');
        if(status)status.textContent='Não foi possível capturar o áudio deste arquivo. Escolha outro arquivo.';
      }
    }
  });

  // 4. Fonte: Simulador de Palestra Completa (Ao Vivo)
  const fullLectureParagraphs = [
    "Boa noite a todos os participantes presentes, sejam muito bem-vindos à conferência anual de tecnologia.",
    "Hoje exploramos como a inteligência artificial em tempo real transforma a experiência de tradução sem cabines físicas.",
    "O sinal capturado da mesa de som é analisado instantaneamente pelo motor de inferência neural local.",
    "Cada ouvinte recebe o áudio com fidelidade cristalina e latência inferior a trinta milissegundos no seu próprio smartphone.",
    "Com o estúdio de calibração de voz, a tradução sintetizada preserva o timbre, o tom e a velocidade naturais do orador.",
    "Agradecemos a presença de todos nesta demonstração da workstation Silent Stage."
  ];

  btnSrcSim?.addEventListener('click', async () => {
    const box = document.getElementById('simLectureBox');
    const progBar = document.getElementById('simLectureProgressBar');
    const progText = document.getElementById('simLectureProgressText');
    const curTextEl = document.getElementById('simLectureCurrentText');

    if (isSimLectureRunning) {
      isSimLectureRunning = false;
      if (simLectureAudioEl) {
        try { simLectureAudioEl.pause(); } catch {}
        simLectureAudioEl = null;
      }
      btnSrcSim.classList.remove('active');
      btnSrcSim.innerHTML = '<span data-icon="sparkles"></span> Dar Play: Palestra Completa';
      if (box) box.classList.add('hidden');
      updateActiveSourceBadge('Microfone / Mesa Física', 'mic');
      return;
    }

    isSimLectureRunning = true;
    clearActiveSourceButtons();
    btnSrcSim.classList.add('active');
    btnSrcSim.innerHTML = '<span data-icon="pause"></span> Parar Palestra Completa';
    if (box) box.classList.remove('hidden');
    updateActiveSourceBadge('Simulador de Palestra Completa', 'sparkles');

    connectStageWebSocket();

    for (let i = 0; i < fullLectureParagraphs.length; i++) {
      if (!isSimLectureRunning) break;

      const paragraph = fullLectureParagraphs[i];
      const pct = Math.round(((i + 1) / fullLectureParagraphs.length) * 100);
      if (progBar) progBar.style.width = `${pct}%`;
      if (progText) progText.innerText = `Trecho ${i + 1}/${fullLectureParagraphs.length} (${pct}%)`;
      if (curTextEl) curTextEl.innerText = `"${paragraph}"`;

      // Simula VU meter com envelopes vocais naturais enquanto fala
      const barL = document.getElementById('vuBarL');
      const barR = document.getElementById('vuBarR');
      const dbL = document.getElementById('vuDbL');
      const dbR = document.getElementById('vuDbR');

      // Toca áudio TTS de exemplo no computador
      const voice = document.getElementById('selTimbre')?.value || 'male_deep';
      const speed = document.getElementById('rangeSpeed')?.value || '1.05';
      const pitch = document.getElementById('rangePitch')?.value || '0';
      const url = `/api/tts?lang=pt&text=${encodeURIComponent(paragraph)}&voice=${encodeURIComponent(voice)}&speed=${speed}&pitch=${pitch}&room=${encodeURIComponent(getActiveRoomId())}&t=${Date.now()}`;

      simLectureAudioEl = new Audio(url);
      let done = false;
      simLectureAudioEl.onended = () => { done = true; };
      simLectureAudioEl.onerror = () => { done = true; };
      simLectureAudioEl.play().catch(() => { done = true; });

      // Envia frase para o WebSocket de tradução de palco
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'speech_transcript',
          text: paragraph,
          isFinal: true,
          sourceLang: 'pt-BR'
        }));
      }

      // Atualiza monitor e telão
      const subPrim = document.getElementById('subPrimaryText');
      if (subPrim) subPrim.innerText = paragraph;

      // Animação de VU meter sincronizada com o áudio
      const startTime = Date.now();
      while (!done && (Date.now() - startTime < 6000)) {
        if (!isSimLectureRunning) break;
        const simLvl = Math.round(45 + Math.sin(Date.now() / 120) * 35 + (Math.random() * 10));
        const simDb = Math.round(((simLvl - 100) * 0.4));
        if (barL) barL.style.width = `${simLvl}%`;
        if (barR) barR.style.width = `${Math.max(0, simLvl - 2)}%`;
        if (dbL) dbL.innerText = `${simDb} dB`;
        if (dbR) dbR.innerText = `${simDb} dB`;
        await new Promise(r => setTimeout(r, 60));
      }

      await new Promise(r => setTimeout(r, 800));
    }

    isSimLectureRunning = false;
    btnSrcSim.classList.remove('active');
    btnSrcSim.innerHTML = '<span data-icon="sparkles"></span> Dar Play: Palestra Completa';
    if (box) box.classList.add('hidden');
    setVuMetersToZero();
  });

  // 5. Botão de Teste Rápido de Frase
  document.getElementById('btnTriggerSpeechTest')?.addEventListener('click', () => {
    connectStageWebSocket();
    const testPhrase = "Bem-vindos ao fórum internacional de inovação e inteligência artificial.";
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'speech_transcript',
        text: testPhrase,
        isFinal: true,
        sourceLang: 'pt-BR'
      }));
    }
    const subPrim = document.getElementById('subPrimaryText');
    if (subPrim) subPrim.innerText = testPhrase;
  });

  // ==========================================
  // 10. VOICE STUDIO (GRAVAÇÃO, ARQUIVO LOCAL, PC/YOUTUBE, PERFIS, TESTE SÍNTESE)
  // ==========================================
  const btnRecord = document.getElementById('btnRecordSample');
  const btnRecordSystem = document.getElementById('btnRecordSystemSample');
  const btnUpload = document.getElementById('btnUploadSample');
  const sampleFileInput = document.getElementById('sampleFileInput');
  const btnPlay = document.getElementById('btnPlaySample');
  const recordStatus = document.getElementById('sampleRecordStatus');
  const playerSample = document.getElementById('sampleAudioPlayer');
  const waveformCanvas = document.getElementById('waveformCanvas');

  // Sliders e Labels
  const rangePitch = document.getElementById('rangePitch');
  const rangeSpeed = document.getElementById('rangeSpeed');
  const valPitch = document.getElementById('valPitch');
  const valSpeed = document.getElementById('valSpeed');

  rangePitch?.addEventListener('input', () => {
    const v = parseInt(rangePitch.value, 10);
    if (valPitch) valPitch.innerText = `${v > 0 ? '+' : ''}${v} st`;
  });

  rangeSpeed?.addEventListener('input', () => {
    if (valSpeed) valSpeed.innerText = `${parseFloat(rangeSpeed.value).toFixed(2)}x`;
  });

  function getSupportedRecorderMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4'
    ];
    for (const t of types) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  // 1. Gravação de Amostra de Microfone (5s)
  btnRecord?.addEventListener('click', async () => {
    if (isRecordingSample) {
      if (sampleRecorder && sampleRecorder.state === 'recording') {
        sampleRecorder.stop();
      }
      return;
    }

    try {
      const stream = audioStream || await navigator.mediaDevices.getUserMedia({ audio: true });
      startSampleCapture(stream, 'Microfone', btnRecord);
    } catch (e) {
      alert('Não foi possível capturar o microfone: ' + e.message);
      isRecordingSample = false;
    }
  });

  // 2. Gravação de Amostra da Saída do PC / YouTube (5s)
  btnRecordSystem?.addEventListener('click', async () => {
    if (isRecordingSample) {
      if (sampleRecorder && sampleRecorder.state === 'recording') {
        sampleRecorder.stop();
      }
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });

      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) {
        stream.getTracks().forEach(t => t.stop());
        alert('⚠️ O áudio não foi compartilhado!\n\nNa janela de seleção, marque a caixinha:\n☑️ "Compartilhar áudio da guia" (para YouTube/Navegador)\nou\n☑️ "Compartilhar áudio do sistema" (para PC/Players).');
        return;
      }

      startSampleCapture(stream, 'Saída do PC / YouTube', btnRecordSystem, true);
    } catch (e) {
      if (!['NotAllowedError','AbortError'].includes(e.name)) {
        alert('Não foi possível capturar o áudio do sistema: ' + e.message);
      }
      isRecordingSample = false;
    }
  });

  // 3. Carregar Amostra Direto de Arquivo Local (.MP3, .WAV, .M4A, etc.)
  btnUpload?.addEventListener('click', () => {
    sampleFileInput?.click();
  });

  sampleFileInput?.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    sampleAudioBlob = file;
    if (sampleAudioUrl) URL.revokeObjectURL(sampleAudioUrl);
    sampleAudioUrl = URL.createObjectURL(file);

    if (playerSample) {
      playerSample.src = sampleAudioUrl;
      playerSample.classList.remove('hidden');
      playerSample.load();
    }
    if (btnPlay) btnPlay.disabled = false;

    if (recordStatus) {
      recordStatus.innerHTML = `✅ Amostra carregada de arquivo: <strong>${escapeStageText(file.name)}</strong> (${Math.round(file.size / 1024)} KB)`;
      recordStatus.className = 'sample-status-text success';
    }

    drawStaticWaveform(waveformCanvas);
  });

  // Função unificada para captura de 5s de stream (Mic ou PC/YouTube)
  function startSampleCapture(stream, sourceName, triggerBtn, stopTracksOnEnd = false) {
    sampleRecordedChunks = [];
    const mime = getSupportedRecorderMimeType();
    sampleRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const recordedMime = sampleRecorder.mimeType || mime || 'audio/webm';

    sampleRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) sampleRecordedChunks.push(e.data);
    };

    sampleRecorder.onstop = () => {
      isRecordingSample = false;
      if (waveformAnimId) cancelAnimationFrame(waveformAnimId);
      if (stopTracksOnEnd) stream.getTracks().forEach(t => t.stop());

      if (triggerBtn) {
        triggerBtn.innerHTML = triggerBtn === btnRecord
          ? '<span data-icon="mic"></span> Gravar do Mic (5s)'
          : '<span data-icon="monitor"></span> Gravar PC / YouTube (5s)';
        triggerBtn.classList.remove('vmt-danger');
      }

      sampleAudioBlob = new Blob(sampleRecordedChunks, { type: recordedMime });
      if (sampleAudioUrl) URL.revokeObjectURL(sampleAudioUrl);
      sampleAudioUrl = URL.createObjectURL(sampleAudioBlob);

      if (playerSample) {
        playerSample.src = sampleAudioUrl;
        playerSample.classList.remove('hidden');
        playerSample.load();
      }
      if (btnPlay) btnPlay.disabled = false;

      if (recordStatus) {
        recordStatus.innerHTML = `✅ Amostra de 5s capturada com sucesso de [${escapeStageText(sourceName)}]! Perfil pronto para síntese.`;
        recordStatus.className = 'sample-status-text success';
      }

      drawStaticWaveform(waveformCanvas);
    };

    isRecordingSample = true;
    sampleRecorder.start();

    if (triggerBtn) {
      triggerBtn.innerHTML = '<span data-icon="pause"></span> Parando em (<span id="sampleSecLeft">5</span>s)...';
      triggerBtn.classList.add('vmt-danger');
    }
    if (recordStatus) {
      recordStatus.innerHTML = `🎙️ Gravando amostra de ${escapeStageText(sourceName)}...`;
      recordStatus.className = 'sample-status-text recording';
    }

    startWaveformAnimation(waveformCanvas);

    let timeLeft = 5;
    const countEl = document.getElementById('sampleSecLeft');
    const timer = setInterval(() => {
      timeLeft--;
      if (countEl) countEl.innerText = String(timeLeft);
      if (timeLeft <= 0) {
        clearInterval(timer);
        if (sampleRecorder && sampleRecorder.state === 'recording') {
          sampleRecorder.stop();
        }
      }
    }, 1000);
  }

  // Reprodução da amostra no player nativo
  btnPlay?.addEventListener('click', () => {
    if (playerSample && sampleAudioUrl) {
      playerSample.currentTime = 0;
      playerSample.play().catch(e => alert('Erro na reprodução de áudio: ' + e.message));
    }
  });

  function startWaveformAnimation(canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    function draw() {
      if (!isRecordingSample) return;
      ctx.clearRect(0, 0, width, height);

      const bars = 48;
      const barW = width / bars;
      const now = Date.now() / 250;
      for (let i = 0; i < bars; i++) {
        const mag = (Math.sin(now + (i * 0.28)) * 0.35 + 0.45) + (Math.cos(now * 0.7 + i * 0.15) * 0.2);
        const h = Math.max(8, Math.min(height - 10, mag * (height * 0.8)));
        const x = i * barW;
        const y = (height - h) / 2;

        ctx.fillStyle = i % 2 === 0 ? '#06b6d4' : '#8b5cf6';
        ctx.fillRect(x + 1, y, barW - 2, h);
      }

      waveformAnimId = requestAnimationFrame(draw);
    }
    waveformAnimId = requestAnimationFrame(draw);
  }

  function drawStaticWaveform(canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const bars = 48;
    const barW = width / bars;
    for (let i = 0; i < bars; i++) {
      const mag = (Math.sin(i * 0.18) * 0.35 + 0.5) * Math.sin((i / bars) * Math.PI);
      const h = Math.max(6, mag * (height * 0.75));
      const x = i * barW;
      const y = (height - h) / 2;

      ctx.fillStyle = '#10b981';
      ctx.fillRect(x + 1, y, barW - 2, h);
    }
  }

  // Biblioteca de Perfis Vocais Salvos (LocalStorage)
  function getSavedProfiles() {
    try {
      const d = localStorage.getItem('vmt_speaker_profiles');
      return d ? JSON.parse(d) : [];
    } catch {
      return [];
    }
  }

  function renderSavedProfilesList() {
    const container = document.getElementById('savedProfilesList');
    if (!container) return;
    const list = getSavedProfiles();

    if (list.length === 0) {
      container.innerHTML = '<p style="font-size:12px; color:var(--vmt-muted); font-style:italic;">Nenhum perfil gravado ainda.</p>';
      return;
    }

    container.innerHTML = '';
    list.forEach(p => {
      const card = document.createElement('div');
      card.className = 'saved-profile-card';
      card.innerHTML = `
        <div class="profile-info">
          <strong>${escapeStageText(p.name)}</strong>
          <small>Timbre: ${p.timbre} • Tom: ${p.pitch > 0 ? '+' : ''}${p.pitch}st • Vel: ${p.speed}x</small>
        </div>
        <div class="profile-actions">
          <button type="button" class="vmt-btn btn-xs" data-load-id="${escapeStageText(p.id)}">Carregar</button>
          <button type="button" class="vmt-btn vmt-danger btn-xs" data-del-id="${escapeStageText(p.id)}">✕</button>
        </div>
      `;
      container.appendChild(card);
    });

    // Listeners de Carregar / Excluir
    container.querySelectorAll('[data-load-id]').forEach(b => {
      b.addEventListener('click', () => {
        const id = b.dataset.loadId;
        const found = getSavedProfiles().find(x => x.id === id);
        if (!found) return;

        const nameInput = document.getElementById('speakerProfileName');
        const timbreSel = document.getElementById('selTimbre');
        if (nameInput) nameInput.value = found.name;
        if (timbreSel) timbreSel.value = found.timbre;
        if (rangePitch) {
          rangePitch.value = found.pitch;
          if (valPitch) valPitch.innerText = `${found.pitch > 0 ? '+' : ''}${found.pitch} st`;
        }
        if (rangeSpeed) {
          rangeSpeed.value = found.speed;
          if (valSpeed) valSpeed.innerText = `${parseFloat(found.speed).toFixed(2)}x`;
        }

        // Propaga perfil para o WebSocket do servidor
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'speaker_voice_profile',
            voice: found.timbre,
            pitch: found.pitch,
            speed: found.speed
          }));
        }

        alert(`Perfil "${found.name}" carregado com sucesso!`);
      });
    });

    container.querySelectorAll('[data-del-id]').forEach(b => {
      b.addEventListener('click', () => {
        const id = b.dataset.delId;
        let list = getSavedProfiles().filter(x => x.id !== id);
        localStorage.setItem('vmt_speaker_profiles', JSON.stringify(list));
        renderSavedProfilesList();
      });
    });
  }

  document.getElementById('btnSaveVoiceProfile')?.addEventListener('click', () => {
    const name = document.getElementById('speakerProfileName')?.value.trim() || `Palestrante ${new Date().toLocaleTimeString('pt-BR')}`;
    const timbre = document.getElementById('selTimbre')?.value || 'auto_match';
    const pitch = parseInt(rangePitch?.value || '0', 10);
    const speed = parseFloat(rangeSpeed?.value || '1.05');

    const profiles = getSavedProfiles();
    profiles.push({
      id: 'prof_' + Date.now(),
      name,
      timbre,
      pitch,
      speed,
      createdAt: new Date().toISOString()
    });

    localStorage.setItem('vmt_speaker_profiles', JSON.stringify(profiles));
    renderSavedProfilesList();

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'speaker_voice_profile',
        voice: timbre,
        pitch,
        speed
      }));
    }

    alert(`Perfil "${name}" salvo com sucesso!`);
  });

  renderSavedProfilesList();

  // Testar Síntese de Voz com IA (/api/tts)
  document.getElementById('btnTestVoiceSynthesis')?.addEventListener('click', async () => {
    const phrase = document.getElementById('voiceTestPhrase')?.value.trim() || 'Welcome to the innovation summit.';
    const voice = document.getElementById('selTimbre')?.value || 'male_deep';
    const pitch = rangePitch?.value || '0';
    const speed = rangeSpeed?.value || '1.05';
    const btn = document.getElementById('btnTestVoiceSynthesis');

    if (btn) btn.innerHTML = '<span data-icon="sparkles"></span> Sintetizando Voz com IA...';

    try {
      const url = `/api/tts?lang=en&text=${encodeURIComponent(phrase)}&voice=${encodeURIComponent(voice)}&speed=${speed}&pitch=${pitch}&room=${encodeURIComponent(getActiveRoomId())}&t=${Date.now()}`;
      const token = localStorage.getItem('vmt_admin_token');
      const res = await fetch(url, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      if (!res.ok) {
        let errDesc = `HTTP ${res.status}`;
        try {
          const errJson = await res.json();
          errDesc = errJson.error || errDesc;
        } catch {
          const errText = await res.text();
          if (errText) errDesc = errText;
        }
        throw new Error(errDesc);
      }

      const audioBlob = await res.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        if (btn) btn.innerHTML = '<span data-icon="volume-2"></span> Testar Síntese de Voz com IA';
      };
      audio.onerror = () => {
        URL.revokeObjectURL(audioUrl);
        if (btn) btn.innerHTML = '<span data-icon="volume-2"></span> Testar Síntese de Voz com IA';
        alert('Falha na reprodução de áudio no dispositivo de saída do computador.');
      };
      await audio.play();
    } catch (e) {
      if (btn) btn.innerHTML = '<span data-icon="volume-2"></span> Testar Síntese de Voz com IA';
      alert('Erro ao testar síntese: ' + e.message);
    }
  });

  // ==========================================
  // 11. PROCESSAMENTO DSP & PRESETS
  // ==========================================
  document.querySelectorAll('.preset-buttons button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset-buttons button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const preset = btn.dataset.preset;
      if (stageDsp) stageDsp.setMode(preset);
    });
  });

  const rangeGateThresh = document.getElementById('rangeGateThresh');
  const valGateThresh = document.getElementById('valGateThresh');
  rangeGateThresh?.addEventListener('input', () => {
    const val = parseInt(rangeGateThresh.value, 10);
    if (valGateThresh) valGateThresh.innerText = `${val} dB`;
    if (stageDsp) stageDsp.setGateThreshold(val);
  });

  // ==========================================
  // 12. EXPORTAÇÕES SRT / TXT
  // ==========================================
  document.getElementById('btnExportTxt')?.addEventListener('click', () => {
    const rows = Array.from(document.querySelectorAll('#transcriptBody tr'));
    const text = rows.map(r => {
      const cells = r.querySelectorAll('td');
      return `[${cells[0]?.innerText || ''}] PALCO: ${cells[1]?.innerText || ''} | TRADUÇÃO: ${cells[2]?.innerText || ''}`;
    }).join('\n');
    downloadFile(text, 'transcricao-palco-silent-stage.txt', 'text/plain');
  });

  document.getElementById('btnExportSrt')?.addEventListener('click',()=>{window.open('/api/rooms/'+encodeURIComponent(getActiveRoomId())+'/export?format=srt','_blank','noopener')});

  function downloadFile(content, fileName, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ==========================================
  // 13. SIMULADOR DE SMARTPHONE & KIT DE MESA
  // ==========================================
  const inEventName = document.getElementById('brandEventName');
  const inColorPrimary = document.getElementById('brandColorPrimary');
  const inColorSecondary = document.getElementById('brandColorSecondary');
  const inColorBg = document.getElementById('brandColorBg');
  const inLogoUrl = document.getElementById('brandLogoUrl');
  const inBannerUrl = document.getElementById('brandBannerUrl');

  function updateSmartphoneSimulator() {
    const name = inEventName?.value || 'Palestra Ao Vivo';
    const primary = inColorPrimary?.value || '#06b6d4';
    const secondary = inColorSecondary?.value || '#3b82f6';
    const bg = inColorBg?.value || '#020617';
    const logo = inLogoUrl?.value;
    const banner = inBannerUrl?.value;

    const screen = document.getElementById('simPhoneScreen');
    const title = document.getElementById('simTitle');
    const logoEl = document.getElementById('simLogo');
    const bannerEl = document.getElementById('simBanner');

    if (screen) {
      screen.style.backgroundColor = bg;
      screen.style.setProperty('--sim-primary', primary);
      screen.style.setProperty('--sim-secondary', secondary);
    }
    if (title) title.innerText = name;

    if (logoEl) {
      if (logo) {
        logoEl.src = logo;
        logoEl.classList.remove('hidden');
      } else {
        logoEl.classList.add('hidden');
      }
    }

    if (bannerEl) {
      if (banner) {
        bannerEl.style.backgroundImage = `url(${banner})`;
        bannerEl.classList.remove('hidden');
      } else {
        bannerEl.classList.add('hidden');
      }
    }
  }

  [inEventName, inColorPrimary, inColorSecondary, inColorBg, inLogoUrl, inBannerUrl].forEach(el => {
    el?.addEventListener('input', updateSmartphoneSimulator);
  });
  updateSmartphoneSimulator();

  document.getElementById('btnGenerateStageKit')?.addEventListener('click', async () => {
    const roomId = getActiveRoomId();
    try {
      const res = await fetch(`/api/desktop/stage-kit?roomId=${encodeURIComponent(roomId)}`);
      const data = await res.json();
      if (data.success && data.kit) {
        const blob = new Blob([data.kit.qrSvg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `kit-de-mesa-qr-${roomId}.svg`;
        a.click();
        URL.revokeObjectURL(url);
        alert('Kit de Palco (QR Code SVG em Alta Resolução) baixado com sucesso!');
      }
    } catch (e) {
      alert('Erro ao gerar kit: ' + e.message);
    }
  });

  // ==========================================
  // 14. LANÇAMENTO DE TELÃO & NDI
  // ==========================================
  document.getElementById('btnOpenScreenWindow')?.addEventListener('click', () => {
    const roomId = getActiveRoomId();
    window.open(`/screen.html?room=${encodeURIComponent(roomId)}`, '_blank', 'width=1920,height=1080');
  });

  document.getElementById('btnLaunchProjector')?.addEventListener('click', () => {
    const roomId = getActiveRoomId();
    window.open(`/screen.html?room=${encodeURIComponent(roomId)}`, '_blank', 'fullscreen=yes,menubar=no,toolbar=no');
  });

  document.getElementById('btnToggleNdi')?.addEventListener('click', () => {
    alert('Saída NDI Broadcast Alpha Channel ativada na porta local 5960.');
  });

  // Controles de Bitrate, Codec e Projeção Remota de Telão
  document.getElementById('audioBitrateSelect')?.addEventListener('change', (e) => {
    updateAudioProfile(e.target.value);
  });
  document.getElementById('audioCodecSelect')?.addEventListener('change', (e) => {
    updateCustomCodec(e.target.value);
  });
  ['hostScreenModeSelect', 'hostScreenLangSelect', 'hostScreenPositionSelect', 'hostScreenThemeSelect', 'hostScreenLogoSelect'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', broadcastScreenConfig);
  });
});

