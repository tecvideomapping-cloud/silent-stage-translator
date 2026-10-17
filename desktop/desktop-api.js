const express = require('express');
const QRCode = require('qrcode');
const hardwareProbe = require('./hardware-probe');
const licenseManager = require('./license-manager');

const router = express.Router();

/**
 * GET /api/desktop/hardware
 * Retorna o relatório completo de hardware da máquina (GPUs, ASIO, CPU, RAM e Fingerprint)
 */
router.get('/hardware', (req, res) => {
  try {
    const report = hardwareProbe.getCompleteHardwareReport();
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/desktop/hardware/metrics
 * Telemetria em tempo real (GPU VRAM, Temp, CPU e RAM)
 */
router.get('/hardware/metrics', (req, res) => {
  try {
    const metrics = hardwareProbe.getRealtimeMetrics();
    res.json({ success: true, metrics });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/desktop/license
 * Retorna o status atual da licença/lease de evento
 */
router.get('/license', (req, res) => {
  try {
    const status = licenseManager.getStatus();
    res.json({ success: true, license: status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/desktop/license/activate
 * Ativa uma chave de licença no desktop
 */
router.post('/license/activate', express.json(), (req, res) => {
  try {
    const { key, licenseData } = req.body || {};
    const input = licenseData || key;
    if (!input) {
      return res.status(400).json({ success: false, error: 'Chave de licença não fornecida.' });
    }
    const result = licenseManager.activateLicense(input);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/desktop/license/consume
 * Registra segundos de áudio ativos transmitidos no palco
 */
router.post('/license/consume', express.json(), (req, res) => {
  try {
    const { seconds = 1 } = req.body || {};
    const result = licenseManager.consumeTransmissionSeconds(Number(seconds) || 1);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/desktop/license/upsell
 * Gera pedido de recarga rápida de horas via PIX dinâmico
 */
router.post('/license/upsell', express.json(), async (req, res) => {
  try {
    const { hours = 2 } = req.body || {};
    const priceMap = { 2: 180, 4: 320, 8: 550 };
    const price = priceMap[hours] || hours * 90;
    const txId = `PIX-UPGRADE-${Date.now()}`;
    const pixPayload = `00020126580014br.gov.bcb.pix0136pix@videomappingtech.com520400005303986540${price}.005802BR5920Videomappingtech6009Sao Paulo62240520${txId}6304`;

    const qrDataUrl = await QRCode.toDataURL(pixPayload, { margin: 1, scale: 6 });

    res.json({
      success: true,
      order: {
        txId,
        hours,
        price,
        pixPayload,
        qrDataUrl,
        expiresInSeconds: 900
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/desktop/license/confirm-mock-pix
 * Confirmação simulada/webhook de pagamento PIX no palco
 */
router.post('/license/confirm-mock-pix', express.json(), (req, res) => {
  try {
    const { hours = 2 } = req.body || {};
    const updated = licenseManager.addHoursCredit(Number(hours) || 2);
    res.json({ success: true, message: `Crédito de +${hours}h adicionado com sucesso!`, license: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/desktop/stage-kit
 * Gera o Kit de Palco com QR Code SVG e instruções para o público
 */
router.get('/stage-kit', async (req, res) => {
  try {
    const { roomId = 'palco1', host = req.get('host') || '192.168.1.100:3000' } = req.query;
    const protocol = req.protocol || 'http';
    const listenerUrl = `${protocol}://${host}/?room=${encodeURIComponent(roomId)}`;
    const qrSvg = await QRCode.toString(listenerUrl, { type: 'svg', margin: 1, scale: 6 });

    res.json({
      success: true,
      kit: {
        roomId,
        listenerUrl,
        qrSvg,
        instructions: [
          'Conecte o seu smartphone na rede Wi-Fi do evento',
          'Aponte a câmera para o QR Code na mesa ou no telão',
          'Coloque seus fones de ouvido e selecione o idioma desejado'
        ]
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
