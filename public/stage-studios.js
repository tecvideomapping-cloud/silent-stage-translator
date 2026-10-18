const escapeStageText=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/**
 * Silent Stage - Workspaces & Studios Manager
 * Videomappingtech (C) 2026
 *
 * Módulos integrados:
 * 1. Alternador de Abas de Estúdio (Tabs Switcher)
 * 2. Voice Cloning Studio (Gravação de amostra, Waveform, Perfis de Voz, Prévia de Síntese)
 * 3. Atas, Dublagem & Exportação (Transcrições com timestamps, exportação TXT e SRT)
 */

(() => {
  'use strict';

  // --- 1. Alternador de Abas do Estúdio ---
  function switchStudioTab(tabId) {
    document.querySelectorAll('.studio-tab-view').forEach(view => {
      view.classList.add('hidden');
    });
    const target = document.getElementById(tabId);
    if (target) {
      target.classList.remove('hidden');
    }

    document.querySelectorAll('.studio-tab-btn').forEach(btn => {
      const isActive = btn.dataset.targetTab === tabId;
      btn.classList.toggle('is-active', isActive);
      btn.classList.toggle('border-cyan-500', isActive);
      btn.classList.toggle('text-cyan-300', isActive);
      btn.classList.toggle('bg-cyan-950/40', isActive);
      btn.classList.toggle('text-slate-400', !isActive);
      btn.classList.toggle('border-transparent', !isActive);
    });

    if (tabId === 'view-transcripts') {
      refreshTranscriptsStudio();
    }
  }

  // --- 2. Voice Cloning Studio ---
  let sampleMediaRecorder = null;
  let sampleRecordedChunks = [];
  let sampleAudioBlob = null;
  let sampleAudioUrl = '';
  let isRecordingSample = false;

  async function recordVoiceSampleNow() {
    const btn = document.getElementById('recordSampleBtn');
    const statusText = document.getElementById('sampleRecordStatus');
    const player = document.getElementById('sampleAudioPlayer');
    const waveformCanvas = document.getElementById('sampleWaveformCanvas');

    if (isRecordingSample) {
      // Finalizar gravação antecipadamente
      if (sampleMediaRecorder && sampleMediaRecorder.state === 'recording') {
        sampleMediaRecorder.stop();
      }
      return;
    }

    try {
      const stream = window.__activeAudioSource?.mediaStream || await navigator.mediaDevices.getUserMedia({ audio: true });
      sampleRecordedChunks = [];
      sampleMediaRecorder = new MediaRecorder(stream);

      sampleMediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) sampleRecordedChunks.push(e.data);
      };

      sampleMediaRecorder.onstop = () => {
        isRecordingSample = false;
        if (btn) {
          btn.innerHTML = '<span>🎙️</span> Gravar Amostra de Voz (5s)';
          btn.className = 'text-xs bg-purple-600 hover:bg-purple-500 text-white font-semibold px-3 py-1.5 rounded-lg transition shadow flex items-center gap-1.5 active:scale-95';
        }
        sampleAudioBlob = new Blob(sampleRecordedChunks, { type: 'audio/wav' });
        if (sampleAudioUrl) URL.revokeObjectURL(sampleAudioUrl);
        sampleAudioUrl = URL.createObjectURL(sampleAudioBlob);

        if (player) {
          player.src = sampleAudioUrl;
          player.classList.remove('hidden');
        }
        if (statusText) {
          statusText.innerHTML = '✅ Amostra gravada com sucesso! Timbre pronto para calibração.';
          statusText.className = 'text-xs text-emerald-400 font-semibold';
        }

        drawStaticWaveform(waveformCanvas);
      };

      isRecordingSample = true;
      sampleMediaRecorder.start();

      if (btn) {
        btn.innerHTML = '<span class="animate-pulse text-rose-400">⏹️</span> Parar Gravação (<span id="sampleCountdown">5</span>s)';
        btn.className = 'text-xs bg-rose-600 hover:bg-rose-500 text-white font-semibold px-3 py-1.5 rounded-lg transition shadow flex items-center gap-1.5 animate-pulse';
      }
      if (statusText) {
        statusText.innerHTML = '🎙️ Fale normalmente com clareza no microfone...';
        statusText.className = 'text-xs text-cyan-300 animate-pulse';
      }

      let secondsLeft = 5;
      const countEl = document.getElementById('sampleCountdown');
      const timer = setInterval(() => {
        secondsLeft--;
        if (countEl) countEl.innerText = String(secondsLeft);
        if (secondsLeft <= 0) {
          clearInterval(timer);
          if (sampleMediaRecorder && sampleMediaRecorder.state === 'recording') {
            sampleMediaRecorder.stop();
          }
        }
      }, 1000);

    } catch (err) {
      if (statusText) {
        statusText.innerText = 'Erro ao capturar microfone: ' + err.message;
        statusText.className = 'text-xs text-rose-400';
      }
      isRecordingSample = false;
    }
  }

  function drawStaticWaveform(canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = '#a855f7';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const bars = 40;
    const barWidth = width / bars;
    for (let i = 0; i < bars; i++) {
      const mag = Math.sin(i * 0.4) * 0.4 + Math.random() * 0.4;
      const h = mag * (height * 0.8);
      const x = i * barWidth;
      const y = (height - h) / 2;
      ctx.fillStyle = i % 2 === 0 ? '#38bdf8' : '#a855f7';
      ctx.fillRect(x + 1, y, barWidth - 2, h);
    }
  }

  // --- Biblioteca de Perfis de Voz Salvos ---
  function getSavedProfiles() {
    try {
      const data = localStorage.getItem('vmt_speaker_profiles');
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  function saveCurrentVoiceProfile() {
    const nameInput = document.getElementById('saveProfileNameInput');
    const name = (nameInput?.value || '').trim() || `Palestrante ${new Date().toLocaleTimeString('pt-BR')}`;
    const timbre = document.getElementById('speakerTimbreSelect')?.value || 'auto_match';
    const pitch = document.getElementById('speakerPitchRange')?.value || 0;
    const speed = document.getElementById('speakerSpeedRange')?.value || 1.05;

    const profiles = getSavedProfiles();
    profiles.push({
      id: 'prof_' + Date.now(),
      name,
      timbre,
      pitch,
      speed,
      createdAt: new Date().toISOString()
    });

    try {
      localStorage.setItem('vmt_speaker_profiles', JSON.stringify(profiles));
      if (nameInput) nameInput.value = '';
      renderProfilesList();
    } catch (e) {}
  }

  function applySavedProfile(id) {
    const profiles = getSavedProfiles();
    const found = profiles.find(p => p.id === id);
    if (!found) return;

    const timbreSelect = document.getElementById('speakerTimbreSelect');
    const pitchRange = document.getElementById('speakerPitchRange');
    const speedRange = document.getElementById('speakerSpeedRange');

    if (timbreSelect) timbreSelect.value = found.timbre;
    if (pitchRange) pitchRange.value = found.pitch;
    if (speedRange) speedRange.value = found.speed;

    if (typeof window.onSpeakerVoiceControlChanged === 'function') {
      window.onSpeakerVoiceControlChanged(true);
    }
    const pitchVal = document.getElementById('pitchValueText');
    if (pitchVal) pitchVal.innerText = (found.pitch > 0 ? '+' : '') + found.pitch + ' st';
    const speedVal = document.getElementById('speedValueText');
    if (speedVal) speedVal.innerText = parseFloat(found.speed).toFixed(2) + 'x';
  }

  function deleteSavedProfile(id) {
    let profiles = getSavedProfiles();
    profiles = profiles.filter(p => p.id !== id);
    try {
      localStorage.setItem('vmt_speaker_profiles', JSON.stringify(profiles));
      renderProfilesList();
    } catch (e) {}
  }

  function renderProfilesList() {
    const container = document.getElementById('savedProfilesList');
    if (!container) return;
    const profiles = getSavedProfiles();
    container.innerHTML = '';

    if (profiles.length === 0) {
      container.innerHTML = '<p class="text-xs text-slate-500 italic p-2">Nenhum perfil salvo ainda. Salve a configuração atual para reutilizar nos próximos palestrantes.</p>';
      return;
    }

    profiles.forEach(p => {
      const card = document.createElement('div');
      card.className = 'flex items-center justify-between p-2.5 bg-slate-900 border border-slate-800 rounded-lg text-xs';
      card.innerHTML = `
        <div>
          <strong class="text-slate-200">${escapeStageText(p.name)}</strong>
          <span class="text-[10px] text-purple-300 block font-mono">Tom: ${p.pitch > 0 ? '+' : ''}${p.pitch}st · Vel: ${p.speed}x</span>
        </div>
        <div class="flex items-center gap-1.5">
          <button type="button" onclick="window.applySavedProfile('${escapeStageText(p.id)}')" class="bg-purple-600/40 hover:bg-purple-600 text-purple-200 px-2 py-1 rounded text-[11px] font-semibold transition">Carregar</button>
          <button type="button" onclick="window.deleteSavedProfile('${escapeStageText(p.id)}')" class="text-slate-500 hover:text-rose-400 p-1 text-[11px] transition">✕</button>
        </div>
      `;
      container.appendChild(card);
    });
  }

  // --- 3. Atas, Dublagem & Exportação (Transcripts Studio) ---
  async function refreshTranscriptsStudio() {
    const roomId = document.getElementById('roomIdInput')?.value || 'palco1';
    const tbody = document.getElementById('transcriptsTableBody');
    const countBadge = document.getElementById('transcriptsCountBadge');
    if (!tbody) return;

    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/transcripts`);
      if (!res.ok) throw new Error('Não foi possível carregar as atas');
      const data = await res.json();
      const items = Array.isArray(data.transcripts) ? data.transcripts : [];

      if (countBadge) countBadge.innerText = `${items.length} trechos gravados`;
      tbody.innerHTML = '';

      if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-slate-500 italic">Nenhuma fala registrada até o momento nesta sala. As frases aparecem aqui automaticamente durante a palestra.</td></tr>`;
        return;
      }

      items.forEach((item, idx) => {
        const tr = document.createElement('tr');
        tr.className = 'border-b border-slate-800/80 hover:bg-slate-900/50 transition-colors text-xs';
        const timeStr = item.created_at ? new Date(item.created_at).toLocaleTimeString('pt-BR') : `Trecho ${idx + 1}`;
        const sourceText = item.source_text || '';
        const enText = item.translations?.['en'] || item.translations?.['en-US'] || '—';
        const esText = item.translations?.['es'] || item.translations?.['es-ES'] || '—';

        tr.innerHTML = `
          <td class="p-2.5 font-mono text-slate-400 shrink-0">${timeStr}</td>
          <td class="p-2.5 text-slate-100 font-medium">${escapeStageText(sourceText)}</td>
          <td class="p-2.5 text-emerald-300 font-normal">${escapeStageText(enText)}</td>
          <td class="p-2.5 text-amber-300 font-normal">${escapeStageText(esText)}</td>
        `;
        tbody.appendChild(tr);
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-rose-400">Erro: ${escapeStageText(err.message)}</td></tr>`;
    }
  }

  function downloadRoomExport(format) {
    const roomId = document.getElementById('roomIdInput')?.value || 'palco1';
    const lang = document.getElementById('exportLangSelect')?.value || 'en';
    const url = `/api/rooms/${encodeURIComponent(roomId)}/export?format=${format}&lang=${encodeURIComponent(lang)}`;
    window.open(url, '_blank');
  }

  // Exporta para escopo global do navegador
  window.switchStudioTab = switchStudioTab;
  window.recordVoiceSampleNow = recordVoiceSampleNow;
  window.saveCurrentVoiceProfile = saveCurrentVoiceProfile;
  window.applySavedProfile = applySavedProfile;
  window.deleteSavedProfile = deleteSavedProfile;
  window.renderProfilesList = renderProfilesList;
  window.refreshTranscriptsStudio = refreshTranscriptsStudio;
  window.downloadRoomExport = downloadRoomExport;

  document.addEventListener('DOMContentLoaded', () => {
    renderProfilesList();
  });
})();
