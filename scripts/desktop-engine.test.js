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

test('license manager: only signed grants; no arbitrary activation or local credit',()=>{
 const crypto=require('crypto');const pair=crypto.generateKeyPairSync('ed25519');const old=process.env.VMT_LICENSE_PUBLIC_KEY;process.env.VMT_LICENSE_PUBLIC_KEY=pair.publicKey.export({type:'spki',format:'pem'});
 const file=path.join(__dirname,'.test-license-lease.json');const lm=new licenseManager.constructor(file);
 try{assert.equal(lm.activateLicense('ANY-KEY').success,false);const grant={eventId:'evt-test',key:'issued',customerId:'test',company:'Test',fingerprint:hardwareProbe.getHardwareFingerprint(),hoursTotal:6,maxListeners:50,languages:['en'],expiresAt:new Date(Date.now()+3600000).toISOString()};grant.signature=crypto.sign(null,Buffer.from(JSON.stringify(grant)),pair.privateKey).toString('base64');assert.equal(lm.activateLicense(grant).success,true);assert.equal(lm.getStatus().hoursRemaining,6);assert.equal(lm.activateLicense({...grant,hoursTotal:999}).success,false);assert.equal(lm.activateLicense({...grant,secondsConsumed:-999}).success,false);assert.equal(lm.verifySignature({...grant,signature:'ab'}),false);assert.equal(lm.consumeTransmissionSeconds(-3600).allowed,false);assert.throws(()=>lm.addHoursCredit(999));const reload=new licenseManager.constructor(file);assert.equal(reload.getStatus().hoursRemaining,6)}finally{if(old===undefined)delete process.env.VMT_LICENSE_PUBLIC_KEY;else process.env.VMT_LICENSE_PUBLIC_KEY=old;fs.rmSync(file,{force:true})}
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
    assert.equal(upsellRes.status,409);
    const simulated=await fetch(`${baseUrl}/license/confirm-mock-pix`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hours:999})});
    assert.equal(simulated.status,404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('desktop host: startServer opens port and serves desktop.html', async () => {
  const { startServer, server } = require('../server/index');
  const port = await startServer(0);
  assert.ok(port > 0);
  assert.equal(server.listening, true);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/desktop.html`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Workstation Pro'));
  } finally {
    await new Promise(r => server.close(r));
  }
});

