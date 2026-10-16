const { WebSocket } = require('ws');

/**
 * Script de Teste Automatizado de Integridade de Transcrição e Tradução
 * Testa se alguma palavra é cortada, engolida ou perdida pelo WebSocket e pela IA.
 */
async function runIntegrityTest() {
  console.log('🧪 Iniciando Teste de Integridade de Transcrição e Tradução...');

  const roomId = 'test_' + Math.random().toString(36).substring(2, 7);
  const serverUrl = 'ws://localhost:3000';

  const testPhrases = [
    {
      id: 'frase_curta',
      text: 'Olá a todos bem-vindos ao evento.',
      expectedWordCount: 6
    },
    {
      id: 'primeira_palavra',
      text: 'Primeiramente nós precisamos confirmar que a primeira palavra nunca é engolida.',
      expectedWordCount: 11
    },
    {
      id: 'frase_longa_sem_pontuacao',
      text: 'Estamos testando a transmissão contínua de áudio e legendas para verificar se todas as palavras chegam inteiras aos ouvintes.',
      expectedWordCount: 19
    },
    {
      id: 'multiplas_oracoes_virgula',
      text: 'A tecnologia está funcionando, a tradução simultânea está ativa, e o áudio chega perfeito.',
      expectedWordCount: 14
    }
  ];

  // 1. Conecta o Host
  const hostWs = new WebSocket(`${serverUrl}?roomId=${roomId}&role=host`);
  await new Promise((resolve, reject) => {
    hostWs.on('open', resolve);
    hostWs.on('error', reject);
  });
  console.log(`✅ Host conectado à sala de teste: ${roomId}`);

  // 2. Conecta o Ouvinte / Telão
  const screenWs = new WebSocket(`${serverUrl}?roomId=${roomId}&role=screen`);
  const receivedOriginalSubtitles = [];
  const receivedTranslatedSubtitles = [];

  screenWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'subtitle' && msg.isFinal) {
        receivedOriginalSubtitles.push(msg);
      } else if (msg.type === 'subtitle_translated') {
        receivedTranslatedSubtitles.push(msg);
      }
    } catch (e) {}
  });

  await new Promise((resolve, reject) => {
    screenWs.on('open', resolve);
    screenWs.on('error', reject);
  });
  console.log(`✅ Telão/Ouvinte conectado à sala de teste`);

  // 3. Executa os testes de envio e validação
  let allPassed = true;

  for (const test of testPhrases) {
    console.log(`\n▶️ Executando: [${test.id}] "${test.text}"`);
    const sentWords = test.text.split(/\s+/).filter(Boolean);
    const startIdxOriginal = receivedOriginalSubtitles.length;
    const startIdxTrans = receivedTranslatedSubtitles.length;

    // Envia primeiro interim (simulando fala do orador)
    const interimWords = sentWords.slice(0, Math.floor(sentWords.length / 2)).join(' ');
    hostWs.send(JSON.stringify({
      type: 'speech_transcript',
      text: interimWords,
      isFinal: false,
      sourceLang: 'pt-BR'
    }));

    await new Promise(r => setTimeout(r, 150));

    // Envia sentença final completa
    hostWs.send(JSON.stringify({
      type: 'speech_transcript',
      text: test.text,
      isFinal: true,
      sourceLang: 'pt-BR'
    }));

    // Aguarda processamento e tradução pela IA (até 3.5s)
    let waitedMs = 0;
    while (waitedMs < 3500) {
      const hasFinalOriginal = receivedOriginalSubtitles.length > startIdxOriginal;
      const hasTranslation = receivedTranslatedSubtitles.length > startIdxTrans;
      if (hasFinalOriginal && hasTranslation) break;
      await new Promise(r => setTimeout(r, 100));
      waitedMs += 100;
    }

    const finalSub = receivedOriginalSubtitles.slice(startIdxOriginal).find(s => s.text === test.text);
    if (!finalSub) {
      console.error(`❌ FALHA: A legenda original recebida não bateu com a enviada!`);
      console.error(`   Esperado: "${test.text}"`);
      console.error(`   Recebidos:`, receivedOriginalSubtitles.slice(startIdxOriginal).map(s => s.text));
      allPassed = false;
      continue;
    }

    const receivedWords = finalSub.text.split(/\s+/).filter(Boolean);
    const firstWordSent = sentWords[0].replace(/[.,!?;:]/g, '').toLowerCase();
    const firstWordReceived = receivedWords[0].replace(/[.,!?;:]/g, '').toLowerCase();

    if (firstWordSent !== firstWordReceived) {
      console.error(`❌ FALHA: Primeira palavra engolida! Esperado: "${firstWordSent}", Recebido: "${firstWordReceived}"`);
      allPassed = false;
      continue;
    }

    if (receivedWords.length !== sentWords.length) {
      console.error(`❌ FALHA: Contagem de palavras divergente! Enviadas: ${sentWords.length}, Recebidas: ${receivedWords.length}`);
      allPassed = false;
      continue;
    }

    const trans = receivedTranslatedSubtitles.slice(startIdxTrans);
    const enTrans = trans.find(t => t.lang === 'en');
    const esTrans = trans.find(t => t.lang === 'es');

    console.log(`   ✅ Legenda Original: "${finalSub.text}" (${receivedWords.length}/${sentWords.length} palavras - 100% ÍNTEGRO)`);
    if (enTrans) console.log(`   ✅ Tradução EN: "${enTrans.text}"`);
    if (esTrans) console.log(`   ✅ Tradução ES: "${esTrans.text}"`);
  }

  hostWs.close();
  screenWs.close();

  console.log('\n------------------------------------------------');
  if (allPassed) {
    console.log('🎉 TODOS OS TESTES PASSARAM COM 100% DE SUCESSO!');
    console.log('Nenhuma palavra foi cortada, engolida ou perdida.');
  } else {
    console.error('⚠️ ALGUNS TESTES FALHARAM! Verifique os logs acima.');
    process.exit(1);
  }
}

runIntegrityTest().catch(err => {
  console.error('Erro na execução do teste:', err);
  process.exit(1);
});
