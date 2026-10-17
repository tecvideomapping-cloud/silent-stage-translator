const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const hardwareProbe = require('../desktop/hardware-probe');
const licenseManager = require('../desktop/license-manager');
const desktopApiRouter = require('../desktop/desktop-api');

test('hardware probe: fingerprinting, GPU detection and audio devices', () => {
  const fp = hardwareProbe.getHardwareFingerprint();
  assert.equal(typeof fp, 'string');
  assert.ok(fp.length >= 16, 'Fingerprint deve ter tamanho criptográfico consistente');

  const report = hardwareProbe.getCompleteHardwareReport();
  assert.equal(report.fingerprint, fp);
  assert.ok(Array.isArray(report.gpus), 'Deve retornar lista de GPUs');
  assert.ok(report.gpus.length >= 1, 'Pelo menos uma GPU ou fallback deve ser identificado');
  assert.ok(report.system.cpuModel, 'Modelo da CPU deve ser identificado');
  assert.ok(report.system.cores > 0, 'Quantidade de núcleos deve ser maior que zero');

  const audio = hardwareProbe.detectAudioDevices();
  assert.ok(Array.isArray(audio.asioDrivers), 'Deve retornar lista de drivers ASIO ou fallback');
  assert.ok(audio.asioDrivers.length >= 1, 'Pelo menos um driver de palco (ASIO/WASAPI) deve estar disponível');
});

test('license manager: issue, signature validation, lease and hours quota', () => {
  const tempLeasePath = path.join(__dirname, '.test-license-lease.json');
  try { if (fs.existsSync(tempLeasePath)) fs.unlinkSync(tempLeasePath); } catch {}

  const lm = new (licenseManager.constructor)(tempLeasePath);

  // Status inicial sem licença
  const initial = lm.getStatus();
  assert.equal(initial.isActive, false);
  assert.equal(initial.mode, 'unlicensed');

  // Emissão de licença com assinatura criptográfica
  const issued = lm.issueLicense({
    hoursTotal: 6,
    company: 'Congresso Médico Internacional',
    validHours: 48
  });
  assert.ok(issued.signature, 'Licença deve conter assinatura');
  assert.equal(issued.hoursTotal, 6);

  // Ativação da licença
  const activation = lm.activateLicense(issued);
  assert.equal(activation.success, true);
  assert.equal(activation.lease.isActive, true);
  assert.equal(activation.lease.hoursRemaining, 6);

  // Consumo de 3600 segundos (1 hora)
  const consumed = lm.consumeTransmissionSeconds(3600);
  assert.equal(consumed.allowed, true);
  assert.equal(consumed.hoursRemaining, 5);

  // Adição de crédito via upsell
  const credited = lm.addHoursCredit(2);
  assert.equal(credited.hoursRemaining, 7);
  assert.equal(credited.hoursTotal, 8);

  // Rejeição de licença adulterada (tampering)
  const tampered = { ...issued, hoursTotal: 999 };
  const tamperedRes = lm.activateLicense(tampered);
  assert.equal(tamperedRes.success, false);
  assert.match(tamperedRes.error, /Assinatura criptográfica/);

  // Limpeza
  try { if (fs.existsSync(tempLeasePath)) fs.unlinkSync(tempLeasePath); } catch {}
});

test('desktop API router: endpoints respond correctly', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/desktop', desktopApiRouter);

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/desktop`;

  try {
    // 1. Hardware endpoint
    const hwRes = await fetch(`${baseUrl}/hardware`);
    assert.equal(hwRes.status, 200);
    const hwData = await hwRes.json();
    assert.equal(hwData.success, true);
    assert.ok(hwData.report.fingerprint);

    // 2. License endpoint
    const licRes = await fetch(`${baseUrl}/license`);
    assert.equal(licRes.status, 200);
    const licData = await licRes.json();
    assert.equal(licData.success, true);
    assert.ok(licData.license);

    // 3. Stage Kit endpoint
    const kitRes = await fetch(`${baseUrl}/stage-kit?roomId=palco-tech`);
    assert.equal(kitRes.status, 200);
    const kitData = await kitRes.json();
    assert.equal(kitData.success, true);
    assert.ok(kitData.kit.qrSvg.includes('<svg'));
    assert.ok(kitData.kit.listenerUrl.includes('palco-tech'));

    // 4. Upsell order generation
    const upsellRes = await fetch(`${baseUrl}/license/upsell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hours: 4 })
    });
    assert.equal(upsellRes.status, 200);
    const upsellData = await upsellRes.json();
    assert.equal(upsellData.success, true);
    assert.equal(upsellData.order.hours, 4);
    assert.ok(upsellData.order.pixPayload);
    assert.ok(upsellData.order.qrDataUrl.startsWith('data:image/png;base64,'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
