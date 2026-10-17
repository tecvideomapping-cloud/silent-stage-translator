const express = require('express');
const QRCode = require('qrcode');
const hardwareProbe = require('./hardware-probe');
const licenseManager = require('./license-manager');

const router=express.Router();
const {Worker}=require('worker_threads');
const path=require('path');
const cache=new Map();let activeProbe=null;
async function probe(type){const hit=cache.get(type);if(hit&&hit.until>Date.now())return hit.value;if(activeProbe)return activeProbe.then(()=>probe(type));activeProbe=new Promise((resolve,reject)=>{const worker=new Worker(path.join(__dirname,'hardware-worker.js'),{workerData:type});const timeout=setTimeout(()=>{worker.terminate();reject(new Error('Tempo de coleta excedido.'))},12000);worker.once('message',result=>{clearTimeout(timeout);worker.terminate();if(result.error)return reject(new Error('Coleta indisponível.'));cache.set(type,{value:result.value,until:Date.now()+(type==='metrics'?8000:600000)});resolve(result.value)});worker.once('error',e=>{clearTimeout(timeout);reject(e)})}).finally(()=>{activeProbe=null});return activeProbe;}

/**
 * GET /api/desktop/hardware
 * Retorna o relatório completo de hardware da máquina (GPUs, ASIO, CPU, RAM e Fingerprint)
 */
router.get('/hardware', async (req, res) => {
  try {
    const report=await probe('static');
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/desktop/hardware/metrics
 * Telemetria em tempo real (GPU VRAM, Temp, CPU e RAM)
 */
router.get('/hardware/metrics', async (req, res) => {
  try {
    const metrics=await probe('metrics');
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
router.post('/license/consume',(req,res)=>res.status(409).json({error:'O consumo é controlado pelo evento contratado.'}));
router.post('/license/upsell',(req,res)=>res.status(409).json({error:'Contrate adicionais na mesa de operações do evento.',url:(process.env.APP_BASE_URL||'')+'/customer.html'}));

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

router.probe=probe;
module.exports=router;
