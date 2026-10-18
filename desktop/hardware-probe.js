const os = require('os');
const crypto = require('crypto');
const { exec, execSync } = require('child_process');

class HardwareProbe {
  constructor() {
    this._cachedStaticInfo = null;
    this._cachedFingerprint = null;
  }

  /**
   * Executa comando shell de forma segura retornando string ou nulo
   */
  _execSafe(command, timeout = 3000) {
    try {
      return execSync(command, { encoding: 'utf8', timeout, windowsHide:true, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  }

  /**
   * Gera a impressão digital única da máquina (Hardware Fingerprint)
   * Baseada em UUID da Placa-Mãe e ID do Processador
   */
  getHardwareFingerprint() {
    if (this._cachedFingerprint) return this._cachedFingerprint;

    let systemUuid = '';
    let cpuId = '';

    if (process.platform === 'win32') {
      const uuidOut = this._execSafe('powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystemProduct).UUID"');
      if (uuidOut) systemUuid = uuidOut;

      const cpuOut = this._execSafe('powershell -NoProfile -Command "(Get-CimInstance Win32_Processor).ProcessorId"');
      if (cpuOut) cpuId = cpuOut;
    } else if (process.platform === 'darwin') {
      const uuidOut = this._execSafe("ioreg -rd1 -c IOPlatformExpertDevice | awk -F'\"' '/IOPlatformUUID/{print $4}'");
      if (uuidOut) systemUuid = uuidOut;
      const cpuOut = this._execSafe('sysctl -n machdep.cpu.brand_string');
      if (cpuOut) cpuId = cpuOut;
    }

    if (!systemUuid) {
      // Fallback para hostname + interfaces de rede
      const interfaces = os.networkInterfaces();
      const macs = Object.values(interfaces).flat().map(i => i.mac).filter(m => m && m !== '00:00:00:00:00:00').sort();
      systemUuid = `${os.hostname()}-${macs[0] || 'default-host'}`;
    }

    const raw = `VMT-HW-${systemUuid}-${cpuId || os.cpus()[0]?.model || 'generic-cpu'}`;
    this._cachedFingerprint = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase().slice(0, 32);
    return this._cachedFingerprint;
  }

  /**
   * Detecta GPUs instaladas (NVIDIA via nvidia-smi ou CIM Win32_VideoController)
   */
  detectGpus() {
    const gpus = [];

    // 1. Tenta telemetria avançada NVIDIA (nvidia-smi)
    const nvsmi = this._execSafe('nvidia-smi --query-gpu=name,memory.total,memory.free,temperature.gpu,utilization.gpu --format=csv,noheader,nounits');
    if (nvsmi) {
      const lines = nvsmi.split(/\r?\n/).filter(Boolean);
      lines.forEach((line, idx) => {
        const parts = line.split(',').map(s => s.trim());
        if (parts.length >= 5) {
          gpus.push({
            id: idx,
            vendor: 'NVIDIA',
            name: parts[0],
            vramTotalMb: parseInt(parts[1], 10) || 0,
            vramFreeMb: parseInt(parts[2], 10) || 0,
            temperatureC: parseInt(parts[3], 10) || 0,
            utilizationPercent: parseInt(parts[4], 10) || 0,
            hasTensorCores: /RTX|Tesla|A100|H100|A10|T4|TITAN/i.test(parts[0]),
            backend: 'CUDA / TensorRT'
          });
        }
      });
    }

    // 2. Se não achou por nvidia-smi ou para listar iGPUs complementares (Intel/AMD)
    if (process.platform === 'win32') {
      const cimGpu = this._execSafe('powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, DriverVersion | ConvertTo-Json -Compress"');
      if (cimGpu) {
        try {
          const parsed = JSON.parse(cimGpu);
          const list = Array.isArray(parsed) ? parsed : [parsed];
          list.forEach((item, idx) => {
            const alreadyFound = gpus.some(g => g.name.toLowerCase() === (item.Name || '').toLowerCase());
            if (!alreadyFound && item.Name) {
              const ramMb = item.AdapterRAM ? Math.round(item.AdapterRAM / (1024 * 1024)) : 0;
              const isIntel = /Intel/i.test(item.Name);
              const isAmd = /AMD|Radeon/i.test(item.Name);
              gpus.push({
                id: gpus.length,
                vendor: isIntel ? 'Intel' : isAmd ? 'AMD' : 'Outro',
                name: item.Name,
                vramTotalMb: ramMb > 0 ? ramMb : 1024,
                vramFreeMb: null,
                temperatureC: null,
                utilizationPercent: null,
                hasTensorCores: false,
                backend: 'DirectML / OpenVINO'
              });
            }
          });
        } catch {}
      }
    } else if (process.platform === 'darwin') {
      const isAppleSilicon = os.cpus().some(c => /Apple/i.test(c.model));
      const modelName = isAppleSilicon ? (os.cpus()[0]?.model || 'Apple Silicon M-Series') : 'Apple Metal GPU';
      gpus.push({
        id: 0,
        vendor: 'Apple',
        name: modelName,
        vramTotalMb: Math.round(os.totalmem() / (1024 * 1024)), // Memória Unificada
        vramFreeMb: Math.round(os.freemem() / (1024 * 1024)),
        temperatureC: null,
        utilizationPercent: null,
        hasTensorCores: true, // Apple Neural Engine
        backend: 'Apple Metal / MPS / CoreML'
      });
    }

    if (gpus.length === 0) {
      gpus.push({
        id: 0,
        vendor: 'CPU Emulated',
        name: 'Processamento de Áudio e IA por CPU (Software Fallback)',
        vramTotalMb: 0,
        vramFreeMb: 0,
        temperatureC: null,
        utilizationPercent: 0,
        hasTensorCores: false,
        backend: 'ONNX CPU / AVX2'
      });
    }

    return gpus;
  }

  /**
   * Detecta dispositivos de som do sistema operacional e drivers ASIO profissionais
   */
  detectAudioDevices() {
    const soundDevices = [];
    const asioDrivers = [];

    if (process.platform === 'darwin') {
      asioDrivers.push({
        name: 'macOS CoreAudio Pro (HAL Nativo de Baixa Latência)',
        type: 'CoreAudio Ultra Low-Latency',
        latencyMsEstimated: 1.5,
        recommendedForStage: true
      });
      soundDevices.push({
        name: 'Dispositivo Agregado / Microfone CoreAudio',
        manufacturer: 'Apple CoreAudio',
        status: 'OK',
        isUsb: false,
        recommendedForStage: true
      });
    } else if (process.platform === 'win32') {
      // Drivers ASIO registrados no registro do Windows (Behringer, Yamaha, Dante, etc.)
      const asioCmd = `powershell -NoProfile -Command "
        $paths = @('HKLM:\\SOFTWARE\\ASIO', 'HKLM:\\SOFTWARE\\WOW6432Node\\ASIO');
        $found = @();
        foreach ($p in $paths) {
          if (Test-Path $p) {
            $found += Get-ChildItem $p | ForEach-Object { $_.PSChildName }
          }
        }
        $found | Select-Object -Unique | ConvertTo-Json -Compress
      "`;
      const asioOut = this._execSafe(asioCmd);
      if (asioOut && asioOut !== 'null') {
        try {
          const parsed = JSON.parse(asioOut);
          const list = Array.isArray(parsed) ? parsed : [parsed];
          list.forEach(name => {
            if (name && typeof name === 'string') {
              asioDrivers.push({
                name,
                type: 'ASIO Pro Audio',
                latencyMsEstimated: 2.6,
                recommendedForStage: true
              });
            }
          });
        } catch {}
      }

      // Dispositivos de som (WASAPI / WDM / USB)
      const soundCmd = 'powershell -NoProfile -Command "Get-CimInstance Win32_SoundDevice | Select-Object Name, Status, Manufacturer | ConvertTo-Json -Compress"';
      const soundOut = this._execSafe(soundCmd);
      if (soundOut && soundOut !== 'null') {
        try {
          const parsed = JSON.parse(soundOut);
          const list = Array.isArray(parsed) ? parsed : [parsed];
          list.forEach(item => {
            if (item && item.Name) {
              soundDevices.push({
                name: item.Name,
                manufacturer: item.Manufacturer || 'Padrão',
                status: item.Status || 'OK',
                isUsb: /USB/i.test(item.Name) || /USB/i.test(item.Manufacturer || ''),
                recommendedForStage: /USB|Behringer|Yamaha|Focusrite|Dante|Audio/i.test(item.Name)
              });
            }
          });
        } catch {}
      }
    }

    // Se nenhum ASIO físico estiver instalado, insere WASAPI de baixa latência como opção de palco
    if (asioDrivers.length === 0) {
      asioDrivers.push({
        name: 'WASAPI Exclusive de Baixa Latência (Driver Padrão Windows)',
        type: 'WASAPI Event-Driven',
        latencyMsEstimated: 8.5,
        recommendedForStage: true
      });
    }

    return { asioDrivers, soundDevices };
  }

  /**
   * Detecta capacidades de CPU, memória RAM e arquitetura
   */
  detectSystemMetrics() {
    const cpus = os.cpus();
    const totalRamGb = +(os.totalmem() / (1024 ** 3)).toFixed(1);
    const freeRamGb = +(os.freemem() / (1024 ** 3)).toFixed(1);

    return {
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      platform: process.platform,
      cpuModel: cpus[0]?.model || 'Generic Processor',
      cores: cpus.length,
      totalRamGb,
      freeRamGb,
      hasAvx2Support: true, // Padrão x64 moderno
      machineName: os.hostname(),
      uptimeSeconds: Math.floor(os.uptime())
    };
  }

  /**
   * Relatório completo e consolidado de Hardware para o aplicativo Desktop
   */
  getCompleteHardwareReport() {
    const fingerprint = this.getHardwareFingerprint();
    const system = this.detectSystemMetrics();
    const gpus = this.detectGpus();
    const audio = this.detectAudioDevices();

    const isMultiGpu = gpus.length > 1;
    const primaryGpu = gpus[0];
    const secondaryGpu = isMultiGpu ? gpus[1] : null;

    let topologyRecommendation = 'Single GPU Balanced Pipeline';
    if (isMultiGpu && primaryGpu.hasTensorCores) {
      topologyRecommendation = 'Dual-GPU Pipeline: GPU 0 -> STT WhisperX | GPU 1 -> TTS Voice Cloning';
    } else if (primaryGpu.hasTensorCores) {
      topologyRecommendation = 'Dedicated CUDA TensorRT Pipeline (Prioridade Alta para STT)';
    }

    return {
      fingerprint,
      timestamp: new Date().toISOString(),
      system,
      gpus,
      primaryGpu,
      secondaryGpu,
      isMultiGpu,
      topologyRecommendation,
      audio
    };
  }

  /**
   * Telemetria em tempo real (chamada periodicamente pelo Desktop UI)
   */
  getRealtimeMetrics() {
    const cpus = os.cpus();
    const freeRamGb = +(os.freemem() / (1024 ** 3)).toFixed(1);
    const totalRamGb = +(os.totalmem() / (1024 ** 3)).toFixed(1);
    const ramUsagePercent = Math.round(((totalRamGb - freeRamGb) / totalRamGb) * 100);

    let gpuTelemetry = null;
    const nvsmi = this._execSafe('nvidia-smi --query-gpu=memory.total,memory.free,temperature.gpu,utilization.gpu --format=csv,noheader,nounits', 1500);
    if (nvsmi) {
      const parts = nvsmi.split(',').map(s => parseInt(s.trim(), 10) || 0);
      if (parts.length >= 4) {
        gpuTelemetry = {
          vramTotalMb: parts[0],
          vramFreeMb: parts[1],
          vramUsedMb: parts[0] - parts[1],
          temperatureC: parts[2],
          utilizationPercent: parts[3]
        };
      }
    }

    return {
      timestamp: Date.now(),
      freeRamGb,
      ramUsagePercent,
      cpuCount: cpus.length,
      gpu: gpuTelemetry
    };
  }
}

module.exports = new HardwareProbe();
