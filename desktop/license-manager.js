const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const hardwareProbe = require('./hardware-probe');

const MASTER_SIGNING_SECRET = process.env.VMT_LICENSE_SECRET || 'vmt-silent-stage-ed25519-master-2026-secret-key';
const LEASE_FILE_PATH = path.join(__dirname, '.vmt-license-lease.json');

class LicenseManager {
  constructor(storagePath = LEASE_FILE_PATH) {
    this.storagePath = storagePath;
    this.currentLease = null;
    this.lastCheckedSystemTime = Date.now();
    this.loadLocalLease();
  }

  /**
   * Assina criptograficamente um payload de licença
   */
  signPayload(payload, secret = MASTER_SIGNING_SECRET) {
    const canonical = JSON.stringify({
      key: payload.key,
      customerId: payload.customerId,
      fingerprint: payload.fingerprint,
      hoursTotal: payload.hoursTotal,
      maxListeners: payload.maxListeners,
      languages: (payload.languages || []).sort(),
      expiresAt: payload.expiresAt,
      features: (payload.features || []).sort()
    });
    return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  }

  /**
   * Verifica a assinatura de uma licença
   */
  verifySignature(payload, secret = MASTER_SIGNING_SECRET) {
    if (!payload || !payload.signature) return false;
    const expected = this.signPayload(payload, secret);
    return crypto.timingSafeEqual(Buffer.from(payload.signature, 'hex'), Buffer.from(expected, 'hex'));
  }

  /**
   * Cria uma nova licença válida (emitida pelo servidor ou para testes)
   */
  issueLicense({
    key = `VMT-PRO-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
    customerId = 'CLI-2026',
    company = 'Produções de Eventos Pro',
    fingerprint = hardwareProbe.getHardwareFingerprint(),
    hoursTotal = 8,
    maxListeners = 500,
    languages = ['en', 'es', 'fr'],
    validHours = 72,
    features = ['stage_dsp', 'voice_cloning', 'multi_gpu', 'srt_export']
  } = {}) {
    const expiresAt = new Date(Date.now() + validHours * 3600 * 1000).toISOString();
    const payload = {
      key,
      customerId,
      company,
      fingerprint,
      hoursTotal,
      hoursRemaining: hoursTotal,
      secondsConsumed: 0,
      maxListeners,
      languages,
      expiresAt,
      features,
      issuedAt: new Date().toISOString()
    };
    payload.signature = this.signPayload(payload);
    return payload;
  }

  /**
   * Carrega a licença/lease armazenada localmente
   */
  loadLocalLease() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const data = JSON.parse(raw);
        if (this.verifySignature(data)) {
          this.currentLease = data;
          this.lastCheckedSystemTime = Math.max(Date.now(), data.lastRecordedTime || 0);
          return this.currentLease;
        }
      }
    } catch {}
    this.currentLease = null;
    return null;
  }

  /**
   * Salva a licença/lease em disco com detecção de rollback de relógio
   */
  saveLocalLease() {
    if (!this.currentLease) return;
    try {
      this.currentLease.lastRecordedTime = Date.now();
      fs.writeFileSync(this.storagePath, JSON.stringify(this.currentLease, null, 2), 'utf8');
    } catch (e) {
      console.error('[LicenseManager] Falha ao persistir lease local:', e);
    }
  }

  /**
   * Ativa uma licença no desktop
   */
  activateLicense(licenseData) {
    let payload = licenseData;
    if (typeof licenseData === 'string') {
      try {
        payload = JSON.parse(licenseData);
      } catch {
        // Formato simplificado de chave: simula validação online ou verificação local
        payload = this.issueLicense({ key: licenseData });
      }
    }

    if (!this.verifySignature(payload)) {
      return { success: false, error: 'Assinatura criptográfica da licença inválida ou corrompida.' };
    }

    const currentHw = hardwareProbe.getHardwareFingerprint();
    if (payload.fingerprint && payload.fingerprint !== '*' && payload.fingerprint !== currentHw) {
      return {
        success: false,
        error: `Esta licença está vinculada a outro hardware (${payload.fingerprint.slice(0, 8)}...). Hardware atual: ${currentHw.slice(0, 8)}...`
      };
    }

    if (new Date(payload.expiresAt).getTime() < Date.now()) {
      return { success: false, error: 'Esta licença de evento expirou.' };
    }

    this.currentLease = payload;
    this.saveLocalLease();

    return {
      success: true,
      lease: this.getStatus()
    };
  }

  /**
   * Consome tempo ativo de transmissão (chamado a cada segundo de áudio no palco)
   */
  consumeTransmissionSeconds(seconds = 1) {
    if (!this.currentLease) return { allowed: false, reason: 'Sem licença ativa.' };

    const now = Date.now();
    // Proteção Anti-Tamper: detecção de relógio atrasado propositalmente
    if (now < this.lastCheckedSystemTime - 60000) {
      return { allowed: false, reason: 'Detectada alteração indevida no relógio do sistema (Anti-Tamper Lock).' };
    }
    this.lastCheckedSystemTime = now;

    if (new Date(this.currentLease.expiresAt).getTime() < now) {
      return { allowed: false, reason: 'Período contratado do evento expirou.' };
    }

    const maxSeconds = (this.currentLease.hoursTotal || 0) * 3600;
    this.currentLease.secondsConsumed = (this.currentLease.secondsConsumed || 0) + seconds;
    const remainingSeconds = Math.max(0, maxSeconds - this.currentLease.secondsConsumed);
    this.currentLease.hoursRemaining = +(remainingSeconds / 3600).toFixed(2);

    if (this.currentLease.secondsConsumed % 60 === 0) {
      this.saveLocalLease();
    }

    if (remainingSeconds <= 0) {
      return {
        allowed: false,
        reason: 'Limite de horas contratadas atingido. Adquira créditos adicionais.',
        needsUpsell: true
      };
    }

    return {
      allowed: true,
      hoursRemaining: this.currentLease.hoursRemaining,
      secondsRemaining: remainingSeconds,
      warningNearLimit: remainingSeconds <= 1800 // Alerta quando faltar <= 30 minutos
    };
  }

  /**
   * Adiciona créditos de horas (via Upsell in-app aprovado)
   */
  addHoursCredit(additionalHours) {
    if (!this.currentLease) {
      this.currentLease = this.issueLicense({ hoursTotal: additionalHours });
    } else {
      this.currentLease.hoursTotal = (this.currentLease.hoursTotal || 0) + additionalHours;
      const maxSeconds = this.currentLease.hoursTotal * 3600;
      const remainingSeconds = Math.max(0, maxSeconds - (this.currentLease.secondsConsumed || 0));
      this.currentLease.hoursRemaining = +(remainingSeconds / 3600).toFixed(2);
      // Reassina o payload com os novos limites
      this.currentLease.signature = this.signPayload(this.currentLease);
    }
    this.saveLocalLease();
    return this.getStatus();
  }

  /**
   * Retorna o status consolidado da licença para a UI do Desktop
   */
  getStatus() {
    if (!this.currentLease) {
      // Se não há licença gravada, inicia em modo Trial/Avaliação Técnica de Palco (2 horas)
      return {
        isActive: false,
        mode: 'unlicensed',
        message: 'Nenhuma licença de evento ativa. Modo Avaliação de Palco disponível (2h).',
        trialAvailable: true,
        hoursRemaining: 2.0,
        maxListeners: 50,
        languages: ['en', 'es'],
        hardwareFingerprint: hardwareProbe.getHardwareFingerprint()
      };
    }

    const now = Date.now();
    const isExpired = new Date(this.currentLease.expiresAt).getTime() < now;
    const isExhausted = (this.currentLease.hoursRemaining || 0) <= 0;

    return {
      isActive: !isExpired && !isExhausted,
      mode: 'offline_lease',
      key: this.currentLease.key,
      company: this.currentLease.company,
      hoursTotal: this.currentLease.hoursTotal,
      hoursRemaining: this.currentLease.hoursRemaining,
      secondsConsumed: this.currentLease.secondsConsumed,
      maxListeners: this.currentLease.maxListeners,
      languages: this.currentLease.languages,
      expiresAt: this.currentLease.expiresAt,
      isExpired,
      isExhausted,
      features: this.currentLease.features,
      hardwareFingerprint: hardwareProbe.getHardwareFingerprint()
    };
  }
}

module.exports = new LicenseManager();
