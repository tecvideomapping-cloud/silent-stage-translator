/**
 * Silent Stage AI - Web Audio DSP & Noise Gate Engine
 * Videomappingtech (C) 2026
 *
 * Cadeia de processamento acústico para palcos ao vivo:
 * 1. High-Pass Rumble Filter (corta sub-graves < 80Hz: passos, batidas de mesa, ar-condicionado)
 * 2. Dynamic Noise Gate (down-expander com histerese suave para cortar chiado entre frases)
 * 3. Dynamics Compressor & Brickwall Limiter (nivelamento suave e proteção anti-clipping)
 */

class StageAudioDSP {
  constructor(audioContext) {
    this.ctx = audioContext;
    this.mode = 'direct'; // 'direct' (puro/transparente sem cortes) | 'stage_mic' | 'noisy_hall'
    this.gateThresholdDb = -42; // Limiar de corte do portão em dB
    this.gateHysteresisDb = 4; // Histerese para evitar trepidação (chattering)
    this.gateFloorGain = 0.08; // Atenuação de ~-22dB durante pausas (não silêncio digital artificial)
    this.isGateOpen = true;
    this.gateGain = 1.0;
    this.lastGateChange = 0;
    this.onGateStateChange = null;

    this.rumbleFilter = null;
    this.noiseGateGainNode = null;
    this.compressor = null;
    this.outputNode = null;
    this.isInitialized = false;
  }

  init(sourceNode) {
    if (!this.ctx || !sourceNode) return sourceNode;

    // 1. Rumble Filter (High-pass em 80Hz)
    this.rumbleFilter = this.ctx.createBiquadFilter();
    this.rumbleFilter.type = 'highpass';
    this.rumbleFilter.frequency.value = 80;
    this.rumbleFilter.Q.value = 0.707;

    // 2. Dynamic Noise Gate (Gain Node modulado pelo RMS da fala)
    this.noiseGateGainNode = this.ctx.createGain();
    this.noiseGateGainNode.gain.value = 1.0;

    // 3. Dynamics Compressor (Nivelamento suave)
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18; // dB
    this.compressor.knee.value = 6; // transição suave
    this.compressor.ratio.value = 2.8; // compressão musical natural
    this.compressor.attack.value = 0.008; // 8ms (rápido para transientes)
    this.compressor.release.value = 0.12; // 120ms

    // 4. Conexão em cascata: source -> rumbleFilter -> noiseGate -> compressor
    sourceNode.connect(this.rumbleFilter);
    this.rumbleFilter.connect(this.noiseGateGainNode);
    this.noiseGateGainNode.connect(this.compressor);

    this.outputNode = this.compressor;
    this.isInitialized = true;
    this.applyMode(this.mode);

    return this.outputNode;
  }

  setMode(mode) {
    this.mode = mode;
    this.applyMode(mode);
  }

  applyMode(mode) {
    if (!this.isInitialized) return;
    const now = this.ctx.currentTime;

    if (mode === 'direct') {
      // Modo Mesa de Som / Flat: bypass transparente
      this.rumbleFilter.frequency.setTargetAtTime(15, now, 0.05); // Highpass inaudível
      this.noiseGateGainNode.gain.setTargetAtTime(1.0, now, 0.05);
      this.compressor.threshold.setTargetAtTime(0, now, 0.05); // Sem compressão
      this.compressor.ratio.setTargetAtTime(1, now, 0.05);
    } else if (mode === 'noisy_hall') {
      // Modo Salão Ruidoso / Eco de PA: filtros mais agressivos
      this.rumbleFilter.frequency.setTargetAtTime(110, now, 0.05); // Corta até 110Hz
      this.gateThresholdDb = -36; // Corta ruídos mais altos
      this.compressor.threshold.setTargetAtTime(-22, now, 0.05);
      this.compressor.ratio.setTargetAtTime(3.8, now, 0.05);
    } else {
      // Modo Padrão: Microfone de Palco / Lapela
      this.rumbleFilter.frequency.setTargetAtTime(80, now, 0.05);
      this.gateThresholdDb = -42;
      this.compressor.threshold.setTargetAtTime(-18, now, 0.05);
      this.compressor.ratio.setTargetAtTime(2.8, now, 0.05);
    }
  }

  setGateThreshold(thresholdDb) {
    this.gateThresholdDb = Math.max(-60, Math.min(-20, thresholdDb));
  }

  /**
   * Chamado em cada frame pelo requestAnimationFrame do VU meter
   * @param {number} rms Nível de energia acústica atual (0.0 a 1.0)
   */
  processRms(rms) {
    if (!this.isInitialized || this.mode === 'direct') return;

    // Converte RMS para escala dBFS
    const currentDb = rms > 0.00001 ? 20 * Math.log10(rms) : -100;
    const openThreshold = this.gateThresholdDb;
    const closeThreshold = this.gateThresholdDb - this.gateHysteresisDb;
    const now = this.ctx.currentTime;

    let shouldOpen = this.isGateOpen;
    if (this.isGateOpen && currentDb < closeThreshold) {
      shouldOpen = false;
    } else if (!this.isGateOpen && currentDb > openThreshold) {
      shouldOpen = true;
    }

    if (shouldOpen !== this.isGateOpen) {
      this.isGateOpen = shouldOpen;
      this.lastGateChange = Date.now();

      if (this.isGateOpen) {
        // Abertura rápida (10ms) para não engolir o ataque da primeira consoante
        this.noiseGateGainNode.gain.cancelScheduledValues(now);
        this.noiseGateGainNode.gain.setTargetAtTime(1.0, now, 0.010);
      } else {
        // Fechamento suave (100ms) para esmaecer naturalmente as caudas de reverberação
        this.noiseGateGainNode.gain.cancelScheduledValues(now);
        this.noiseGateGainNode.gain.setTargetAtTime(this.gateFloorGain, now, 0.090);
      }

      if (typeof this.onGateStateChange === 'function') {
        this.onGateStateChange(this.isGateOpen);
      }
    }
  }

  getReductionPercent() {
    if (!this.isInitialized || this.mode === 'direct' || this.isGateOpen) return 0;
    return Math.round((1.0 - this.gateFloorGain) * 100);
  }
}

if (typeof window !== 'undefined') {
  window.StageAudioDSP = StageAudioDSP;
}
