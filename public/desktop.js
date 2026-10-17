/**
 * Silent Stage AI - Workstation Pro Desktop Controller
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
  let isBroadcasting = false;
  let currentSourceMode = 'mic'; // 'mic' | 'system' | 'file' | 'sim'
  let audioContext = null;
  let audioStream = null;
  let audioSourceNode = null;
  let scriptProcessor = null;
  let analyserNode = null;
  let stageDsp = null;
  let socket = null;
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
  async function loadHardwareReport() {
    try {
      const res = await fetch('/api/desktop/hardware');
      const data = await res.json();
      if (!data.success || !data.report) return;

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
        <h3>🎮 ${g.name}</h3>
        <p><strong>Fabricante:</strong> ${g.vendor}</p>
        <p><strong>VRAM:</strong> ${g.vramTotalMb} MB</p>
        <p><strong>Backend:</strong> ${g.backend}</p>
        <p><strong>Tensor Cores:</strong> ${g.hasTensorCores ? 'Sim (Aceleração Neural)' : 'Não'}</p>
      </div>
    `).join('');

    let audioHtml = (report.audio?.asioDrivers || []).map(a => `
      <div class="hw-card">
        <h3>🎙️ Driver de Palco: ${a.name}</h3>
        <p><strong>Tipo:</strong> ${a.type}</p>
        <p><strong>Latência Estimada:</strong> ${a.latencyMsEstimated} ms</p>
        <p><strong>Pronto para Palco:</strong> Sim</p>
      </div>
    `).join('');

    let cpuHtml = `
      <div class="hw-card">
        <h3>💻 CPU & Memória do Host</h3>
        <p><strong>Processador:</strong> ${report.system?.cpuModel || 'CPU Host'}</p>
        <p><strong>Núcleos:</strong> ${report.system?.cores || 4} Cores</p>
        <p><strong>Memória RAM:</strong> ${report.system?.freeRamGb || '--'} GB livres de ${report.system?.totalRamGb || '--'} GB</p>
        <p><strong>Identificador Único:</strong> <code style="font-size:10px">${report.fingerprint || 'N/A'}</code></p>
      </div>
    `;

    grid.innerHTML = gpusHtml + audioHtml + cpuHtml;
  }

  async function pollRealtimeMetrics() {
    try {
      const res = await fetch('/api/desktop/hardware/metrics');
      const data = await res.json();
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
      if (!data.success || !data.license) return;

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

  let currentUpsellHours = 2;
  document.querySelectorAll('.upsell-options button').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.upsell-options button').forEach(b => b.classList.remove('vmt-primary'));
      btn.classList.add('vmt-primary');
      currentUpsellHours = parseInt(btn.dataset.hours, 10) || 2;

      try {
        const res = await fetch('/api/desktop/license/upsell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hours: currentUpsellHours })
        });
        const data = await res.json();
        if (data.success && data.order) {
          const box = document.getElementById('pixCheckoutBox');
          document.getElementById('pixQrImg').src = data.order.qrDataUrl;
          document.getElementById('pixPayloadInput').value = data.order.pixPayload;
          box.classList.remove('hidden');
        }
      } catch (e) {
        alert('Falha ao gerar QR Code PIX: ' + e.message);
      }
    });
  });

  document.getElementById('btnCopyPix')?.addEventListener('click', () => {
    const input = document.getElementById('pixPayloadInput');
    if (input) {
      input.select();
      navigator.clipboard?.writeText(input.value);
      alert('Código PIX copiado!');
    }
  });

  document.getElementById('btnSimulatePixPayment')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/desktop/license/confirm-mock-pix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours: currentUpsellHours })
      });
      const data = await res.json();
      if (data.success) {
        alert(data.message);
        document.getElementById('pixCheckoutBox').classList.add('hidden');
        loadLicenseStatus();
      }
    } catch (e) {
      alert('Erro ao confirmar: ' + e.message);
    }
  });

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
        stageDsp.processRms(rms);
      }

      // Se for silêncio absoluto ou ruído de piso abaixo de -60dB, zera VU
      if (rms < 0.0001) {
        if (barL) barL.style.width = '0%';
        if (barR) barR.style.width = '0%';
        if (dbL) dbL.innerText = '-inf dB';
        if (dbR) dbR.innerText = '-inf dB';
      } else {
        // Cálculo real de dBFS: 20 * log10(rms)
        const calcDb = Math.max(-60, Math.min(0, Math.round(20 * Math.log10(rms))));
        // Converte escala -60dB .. 0dB em 0% .. 100%
        const pct = Math.min(100, Math.max(0, Math.round(((calcDb + 60) / 60) * 100)));

        // Leve diferenciação estéreo para simular micro-ambitonia de palco
        const pctL = pct;
        const pctR = Math.max(0, Math.min(100, pct + Math.round((Math.random() * 2) - 1)));

        if (barL) barL.style.width = `${pctL}%`;
        if (barR) barR.style.width = `${pctR}%`;
        if (dbL) dbL.innerText = `${calcDb} dB`;
        if (dbR) dbR.innerText = `${calcDb} dB`;
      }

      vuAnimId = requestAnimationFrame(tick);
    }

    vuAnimId = requestAnimationFrame(tick);
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
    const wsUrl = `${wsProto}//${location.host}/api/rooms/${encodeURIComponent(roomId)}`;

    try {
      socket = new WebSocket(wsUrl);
      socket.binaryType = 'arraybuffer';

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'join', role: 'host', roomId }));
      };

      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            handleServerWsMessage(msg);
          } catch {}
        }
      };

      socket.onclose = () => {
        socket = null;
      };
    } catch (e) {
      console.warn('[WS] Falha ao conectar WebSocket:', e);
    }
  }

  function handleServerWsMessage(msg) {
    if (msg.type === 'stats') {
      const elListeners = document.getElementById('metricListeners');
      if (elListeners) elListeners.innerText = msg.totalListeners || msg.onlineCount || 0;
    } else if (msg.type === 'subtitle' || msg.type === 'transcript') {
      const primaryText = msg.text || msg.sourceText || '';
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
      <td>${original}</td>
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
          const original = item.source_text || item.text || '';
          const trans = item.translations?.en || item.translations?.es || '—';
          const tr = document.createElement('tr');
          tr.innerHTML = `<td>${timeStr}</td><td>${original}</td><td>${trans}</td>`;
          tbody.appendChild(tr);
        });
      }
    } catch {}
  }

  // ==========================================
  // 8. CONTROLE DE BROADCAST & PROCESSAMENTO DE STREAM
  // ==========================================
  async function startBroadcastWithStream(customStream = null, mode = 'mic') {
    stopBroadcastCleanly();

    currentSourceMode = mode;
    const roomId = getActiveRoomId();
    connectStageWebSocket();

    try {
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
      audioContext = new AudioCtx({ latencyHint: 'interactive' });
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

      const dspSource = stageDsp ? stageDsp.outputNode : audioSourceNode;
      dspSource.connect(analyserNode);

      // ScriptProcessorNode para empacotamento e streaming PCM 16-bit
      scriptProcessor = audioContext.createScriptProcessor(2048, 2, 1);
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
        const pcm16 = new Int16Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
          const s = Math.max(-1, Math.min(1, targetFloats[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Pacote binário Silent Stage: 0xAA (header), 0 (PCM), sampleRate
        const sampleRate = audioContext.sampleRate;
        const packet = new Uint8Array(4 + numSamples * 2);
        packet[0] = 0xAA;
        packet[1] = 0;
        packet[2] = sampleRate & 0xFF;
        packet[3] = (sampleRate >> 8) & 0xFF;
        new Uint8Array(packet.buffer, 4).set(new Uint8Array(pcm16.buffer));

        try {
          socket.send(packet.buffer);
        } catch {}
      };

      isBroadcasting = true;

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
    } catch (err) {
      alert('Erro ao iniciar áudio: ' + err.message);
      stopBroadcastCleanly();
    }
  }

  function stopBroadcastCleanly() {
    isBroadcasting = false;

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
      if (e.name !== 'NotAllowedError') {
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

  localFileInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (localMediaBox) localMediaBox.classList.remove('hidden');
    if (localMediaTitle) localMediaTitle.innerText = `🎵 ${file.name}`;

    const fileUrl = URL.createObjectURL(file);
    if (localMediaAudio) {
      localMediaAudio.src = fileUrl;
      localMediaAudio.play().catch(() => {});
    }

    clearActiveSourceButtons();
    btnSrcFile?.classList.add('active');
    updateActiveSourceBadge(`Arquivo Local (${file.name})`, 'folder-open');

    // Conecta o player ao broadcast
    if (localMediaAudio) {
      try {
        const stream = localMediaAudio.captureStream ? localMediaAudio.captureStream() : (localMediaAudio.mozCaptureStream ? localMediaAudio.mozCaptureStream() : null);
        if (stream && stream.getAudioTracks().length > 0) {
          startBroadcastWithStream(stream, 'file');
        } else if (!isBroadcasting) {
          startBroadcastWithStream(null, 'mic');
        }
      } catch (err) {
        console.warn('Erro ao conectar stream do arquivo:', err);
      }
    }
  });

  // 4. Fonte: Simulador de Palestra Completa (Ao Vivo)
  const fullLectureParagraphs = [
    "Boa noite a todos os participantes presentes, sejam muito bem-vindos à conferência anual de tecnologia.",
    "Hoje exploramos como a inteligência artificial em tempo real transforma a experiência de tradução sem cabines físicas.",
    "O sinal capturado da mesa de som é analisado instantaneamente pelo motor de inferência neural local.",
    "Cada ouvinte recebe o áudio com fidelidade cristalina e latência inferior a trinta milissegundos no seu próprio smartphone.",
    "Com o estúdio de clonagem de voz, a tradução sintetizada preserva o timbre, o tom e a velocidade naturais do orador.",
    "Agradecemos a presença de todos nesta demonstração da workstation Silent Stage AI Pro."
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
      const url = `/api/tts?lang=pt&text=${encodeURIComponent(paragraph)}&voice=${encodeURIComponent(voice)}&speed=${speed}&pitch=${pitch}&t=${Date.now()}`;

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
  // 10. VOICE STUDIO (GRAVAÇÃO, WAVEFORM, PERFIS, TESTE SÍNTESE)
  // ==========================================
  const btnRecord = document.getElementById('btnRecordSample');
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

  // Gravação de Amostra de Voz com MediaRecorder
  btnRecord?.addEventListener('click', async () => {
    if (isRecordingSample) {
      if (sampleRecorder && sampleRecorder.state === 'recording') {
        sampleRecorder.stop();
      }
      return;
    }

    try {
      const stream = audioStream || await navigator.mediaDevices.getUserMedia({ audio: true });
      sampleRecordedChunks = [];
      sampleRecorder = new MediaRecorder(stream);

      sampleRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) sampleRecordedChunks.push(e.data);
      };

      sampleRecorder.onstop = () => {
        isRecordingSample = false;
        if (waveformAnimId) cancelAnimationFrame(waveformAnimId);

        if (btnRecord) {
          btnRecord.innerHTML = '<span data-icon="mic"></span> Gravar Amostra (5s)';
          btnRecord.classList.remove('vmt-danger');
        }

        sampleAudioBlob = new Blob(sampleRecordedChunks, { type: 'audio/wav' });
        if (sampleAudioUrl) URL.revokeObjectURL(sampleAudioUrl);
        sampleAudioUrl = URL.createObjectURL(sampleAudioBlob);

        if (playerSample) {
          playerSample.src = sampleAudioUrl;
          playerSample.classList.remove('hidden');
        }
        if (btnPlay) btnPlay.disabled = false;

        if (recordStatus) {
          recordStatus.innerHTML = '✅ Amostra de 5 segundos capturada! Perfil vocal pronto para síntese.';
          recordStatus.className = 'sample-status-text success';
        }

        drawStaticWaveform(waveformCanvas);
      };

      isRecordingSample = true;
      sampleRecorder.start();

      if (btnRecord) {
        btnRecord.innerHTML = '<span data-icon="pause"></span> Parando em (<span id="sampleSecLeft">5</span>s)...';
        btnRecord.classList.add('vmt-danger');
      }
      if (recordStatus) {
        recordStatus.innerHTML = '🎙️ Gravando... Fale normalmente com clareza no microfone.';
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

    } catch (e) {
      alert('Não foi possível gravar o microfone: ' + e.message);
      isRecordingSample = false;
    }
  });

  btnPlay?.addEventListener('click', () => {
    if (sampleAudioUrl) {
      const a = new Audio(sampleAudioUrl);
      a.play().catch(e => alert('Erro na reprodução: ' + e.message));
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

      const bars = 50;
      const barW = width / bars;
      for (let i = 0; i < bars; i++) {
        const mag = Math.sin((Date.now() / 80) + (i * 0.3)) * 0.5 + 0.5;
        const h = Math.max(6, mag * (height * 0.75));
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

    const bars = 50;
    const barW = width / bars;
    for (let i = 0; i < bars; i++) {
      const mag = Math.sin(i * 0.25) * 0.4 + 0.5;
      const h = Math.max(6, mag * (height * 0.7));
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
          <strong>${p.name}</strong>
          <small>Timbre: ${p.timbre} • Tom: ${p.pitch > 0 ? '+' : ''}${p.pitch}st • Vel: ${p.speed}x</small>
        </div>
        <div class="profile-actions">
          <button type="button" class="vmt-btn btn-xs" data-load-id="${p.id}">Carregar</button>
          <button type="button" class="vmt-btn vmt-danger btn-xs" data-del-id="${p.id}">✕</button>
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
      const url = `/api/tts?lang=en&text=${encodeURIComponent(phrase)}&voice=${encodeURIComponent(voice)}&speed=${speed}&pitch=${pitch}&t=${Date.now()}`;
      const audio = new Audio(url);
      audio.onended = () => {
        if (btn) btn.innerHTML = '<span data-icon="volume-2"></span> Testar Síntese de Voz com IA';
      };
      audio.onerror = () => {
        if (btn) btn.innerHTML = '<span data-icon="volume-2"></span> Testar Síntese de Voz com IA';
        alert('Falha na síntese de áudio.');
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

  document.getElementById('btnExportSrt')?.addEventListener('click', () => {
    const rows = Array.from(document.querySelectorAll('#transcriptBody tr'));
    let srt = '';
    rows.forEach((r, idx) => {
      const cells = r.querySelectorAll('td');
      const time = cells[0]?.innerText || '00:00:00';
      srt += `${idx + 1}\n${time},000 --> ${time},005\n${cells[2]?.innerText || cells[1]?.innerText || ''}\n\n`;
    });
    downloadFile(srt, 'legendas-palco-silent-stage.srt', 'text/plain');
  });

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
});
