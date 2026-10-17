/**
 * Desktop Workstation Pro Controller - Videomappingtech
 */
document.addEventListener('DOMContentLoaded', () => {
  // 1. NAVEGAÇÃO ENTRE ABAS
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
    });
  });

  // 2. HARDWARE & TELEMETRIA EM TEMPO REAL
  async function loadHardwareReport() {
    try {
      const res = await fetch('/api/desktop/hardware');
      const data = await res.json();
      if (!data.success || !data.report) return;

      const { gpus, primaryGpu, system, audio } = data.report;
      if (primaryGpu) {
        document.getElementById('gpuNameText').innerText = primaryGpu.name;
        document.getElementById('gpuMetricText').innerText = `${primaryGpu.vramTotalMb} MB VRAM • ${primaryGpu.backend}`;
      }

      if (audio && audio.asioDrivers && audio.asioDrivers[0]) {
        document.getElementById('audioDriverText').innerText = audio.asioDrivers[0].name;
        document.getElementById('audioLatencyText').innerText = `~${audio.asioDrivers[0].latencyMsEstimated}ms buffer`;
      }

      // Renderiza resumo detalhado de Hardware na aba correspondente
      renderHardwareSummary(data.report);
    } catch (e) {
      console.warn('[Hardware] Falha ao carregar relatório:', e);
    }
  }

  function renderHardwareSummary(report) {
    const grid = document.getElementById('hwSummaryGrid');
    if (!grid) return;

    let gpusHtml = report.gpus.map(g => `
      <div class="hw-card">
        <h3>🎮 ${g.name}</h3>
        <p><strong>Fabricante:</strong> ${g.vendor}</p>
        <p><strong>VRAM:</strong> ${g.vramTotalMb} MB</p>
        <p><strong>Backend:</strong> ${g.backend}</p>
        <p><strong>Tensor Cores:</strong> ${g.hasTensorCores ? 'Sim (Alta Performance)' : 'Não'}</p>
      </div>
    `).join('');

    let audioHtml = report.audio.asioDrivers.map(a => `
      <div class="hw-card">
        <h3>🎙️ Driver de Palco: ${a.name}</h3>
        <p><strong>Tipo:</strong> ${a.type}</p>
        <p><strong>Latência Estimada:</strong> ${a.latencyMsEstimated} ms</p>
        <p><strong>Recomendado para Palco:</strong> Sim</p>
      </div>
    `).join('');

    let cpuHtml = `
      <div class="hw-card">
        <h3>💻 CPU & Memória do Host</h3>
        <p><strong>Processador:</strong> ${report.system.cpuModel}</p>
        <p><strong>Núcleos:</strong> ${report.system.cores} Cores (AVX2 Ativo)</p>
        <p><strong>Memória RAM:</strong> ${report.system.freeRamGb} GB livres de ${report.system.totalRamGb} GB</p>
        <p><strong>Hardware Fingerprint:</strong> <code style="font-size:10px">${report.fingerprint}</code></p>
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
        document.getElementById('gpuMetricText').innerText = `${gpu.vramUsedMb || 0}/${gpu.vramTotalMb} MB • ${gpu.temperatureC || '--'}°C (${gpu.utilizationPercent || 0}%)`;
      }
    } catch {}
  }

  setInterval(pollRealtimeMetrics, 3000);
  loadHardwareReport();

  // 3. LICENCIAMENTO & RECARGA
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
        statusText.innerText = 'Licença Ativa (Offline Lease)';
        hoursText.innerText = `${lic.hoursRemaining}h restantes`;
        detailsBox.innerHTML = `
          <p style="color:var(--vmt-green)"><strong>✓ Licença Verificada no Hardware</strong></p>
          <p>Cliente: <strong>${lic.company || 'Autorizado'}</strong></p>
          <p>Horas Totais: ${lic.hoursTotal}h | Consumidas: ${+(lic.secondsConsumed / 3600).toFixed(2)}h</p>
          <p>Capacidade: Até ${lic.maxListeners} participantes simultâneos</p>
          <p>Válido até: ${new Date(lic.expiresAt).toLocaleString()}</p>
        `;
      } else {
        statusText.innerText = 'Modo Avaliação de Palco';
        hoursText.innerText = '02:00:00';
        detailsBox.innerHTML = `
          <p style="color:var(--vmt-warning)"><strong>Atenção: Operando em modo de avaliação técnica (2h).</strong></p>
          <p>Ative uma chave de evento ou realize uma recarga rápida abaixo para liberar a diária completa.</p>
        `;
      }
    } catch {}
  }

  loadLicenseStatus();

  // Ativação de Chave
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
        alert('Licença ativada com sucesso!');
        loadLicenseStatus();
      } else {
        alert(`Erro na ativação: ${data.error}`);
      }
    } catch (e) {
      alert(`Falha ao conectar: ${e.message}`);
    }
  });

  // Recarga Rápida PIX
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

  // 4. ÁUDIO DSP & SIMULAÇÃO DE VU METERS EM TEMPO REAL
  let isBroadcasting = false;
  let audioCtx = null;
  let animId = null;

  document.getElementById('btnToggleBroadcast')?.addEventListener('click', async () => {
    isBroadcasting = !isBroadcasting;
    const btn = document.getElementById('btnToggleBroadcast');
    const badge = document.getElementById('liveStatusBadge');

    if (isBroadcasting) {
      btn.innerHTML = '<span data-icon="pause"></span> Interromper Transmissão';
      btn.classList.add('vmt-danger');
      badge.innerText = '● NO AR (TRANSMITINDO EM ALTA DEFINIÇÃO)';
      badge.style.background = 'var(--vmt-green-wash)';
      badge.style.color = 'var(--vmt-green)';
      startVuMeterAnimation();
    } else {
      btn.innerHTML = '<span data-icon="play"></span> Iniciar Transmissão no Palco';
      btn.classList.remove('vmt-danger');
      badge.innerText = 'TRANSMISSÃO PAUSADA';
      badge.style.background = 'var(--vmt-wash)';
      badge.style.color = 'var(--vmt-muted)';
      stopVuMeterAnimation();
    }
  });

  function startVuMeterAnimation() {
    function frame() {
      if (!isBroadcasting) return;
      // Simulação viva de dinâmica vocal com picos realistas
      const levelL = Math.min(100, Math.max(8, Math.round(50 + Math.sin(Date.now() / 150) * 35 + (Math.random() * 15))));
      const levelR = Math.min(100, Math.max(6, Math.round(levelL + (Math.random() * 8 - 4))));

      const barL = document.getElementById('vuBarL');
      const barR = document.getElementById('vuBarR');
      const dbL = document.getElementById('vuDbL');
      const dbR = document.getElementById('vuDbR');

      if (barL) barL.style.width = `${levelL}%`;
      if (barR) barR.style.width = `${levelR}%`;

      const calcDbL = -Math.round((100 - levelL) * 0.4);
      const calcDbR = -Math.round((100 - levelR) * 0.4);

      if (dbL) dbL.innerText = `${calcDbL} dB`;
      if (dbR) dbR.innerText = `${calcDbR} dB`;

      animId = requestAnimationFrame(frame);
    }
    frame();
  }

  function stopVuMeterAnimation() {
    if (animId) cancelAnimationFrame(animId);
    const barL = document.getElementById('vuBarL');
    const barR = document.getElementById('vuBarR');
    if (barL) barL.style.width = '0%';
    if (barR) barR.style.width = '0%';
    document.getElementById('vuDbL').innerText = '-inf dB';
    document.getElementById('vuDbR').innerText = '-inf dB';
  }

  // 5. SIMULADOR DE SMARTPHONE INTERATIVO
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

  // 6. GERADOR DE KIT DE PALCO
  document.getElementById('btnGenerateStageKit')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/desktop/stage-kit?roomId=palco1');
      const data = await res.json();
      if (data.success && data.kit) {
        const blob = new Blob([data.kit.qrSvg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'kit-de-mesa-qr-palco1.svg';
        a.click();
        URL.revokeObjectURL(url);
        alert('Kit de Palco (QR Code SVG de Alta Resolução) baixado com sucesso!');
      }
    } catch (e) {
      alert('Erro ao gerar kit: ' + e.message);
    }
  });

  // 7. EXPORTAÇÕES SRT / TXT
  document.getElementById('btnExportTxt')?.addEventListener('click', () => {
    const rows = Array.from(document.querySelectorAll('#transcriptBody tr'));
    const text = rows.map(r => {
      const cells = r.querySelectorAll('td');
      return `[${cells[0]?.innerText}] PALCO: ${cells[1]?.innerText} | TRADUÇÃO: ${cells[2]?.innerText}`;
    }).join('\n');
    downloadFile(text, 'transcricao-palco-silent-stage.txt', 'text/plain');
  });

  document.getElementById('btnExportSrt')?.addEventListener('click', () => {
    const rows = Array.from(document.querySelectorAll('#transcriptBody tr'));
    let srt = '';
    rows.forEach((r, idx) => {
      const cells = r.querySelectorAll('td');
      const time = cells[0]?.innerText || '00:00:00';
      srt += `${idx + 1}\n${time},000 --> ${time},005\n${cells[2]?.innerText || cells[1]?.innerText}\n\n`;
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

  // 8. LANÇADOR DE TELÃO EM JANELA SECUNDÁRIA
  document.getElementById('btnOpenScreenWindow')?.addEventListener('click', () => {
    window.open('/screen.html?room=palco1', '_blank', 'width=1920,height=1080');
  });

  document.getElementById('btnLaunchProjector')?.addEventListener('click', () => {
    window.open('/screen.html?room=palco1', '_blank', 'fullscreen=yes,menubar=no,toolbar=no');
  });
});
