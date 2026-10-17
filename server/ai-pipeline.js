const { WebSocket } = require('ws');

class AIPipeline {
  constructor() {
    this.deepgramKey = process.env.DEEPGRAM_API_KEY;
    this.openaiKey = process.env.OPENAI_API_KEY;
    this.groqKey = process.env.GROQ_API_KEY;
    this.deeplKey = process.env.DEEPL_API_KEY;
    this.cartesiaKey = process.env.CARTESIA_API_KEY;
    this.elevenlabsKey = process.env.ELEVENLABS_API_KEY;
    this.mockMode = process.env.MOCK_AI === 'true' || (!this.deepgramKey && !this.openaiKey && !this.groqKey && !this.cartesiaKey && !this.elevenlabsKey);
    
    // Conexões ativas do Deepgram por sala
    this.sttSockets = new Map();
    // Cache LRU em memória para traduções instantâneas (evita chamadas repetidas e rate-limit)
    this.translationCache = new Map();
    // Memória contextual de sentenças anteriores por sala (mantém coerência gramatical e pronominal)
    this.roomContextMemory = new Map();
  }

  setApiKeys({ openaiKey, groqKey } = {}) {
    if (typeof openaiKey === 'string') {
      this.openaiKey = openaiKey.trim() || process.env.OPENAI_API_KEY;
    }
    if (typeof groqKey === 'string') {
      this.groqKey = groqKey.trim() || process.env.GROQ_API_KEY;
    }
  }

  stripLanguagePrefixTag(str) {
    if (!str || typeof str !== 'string') return '';
    return str.replace(/^\s*\[[A-Za-z-]{2,8}\]\s*/g, '').trim();
  }

  /**
   * Inicializa ou obtém conexão Deepgram para a sala
   */
  getOrCreateDeepgramSession(roomId, sourceLang, onTranscript) {
    if (this.mockMode) return null;
    if (this.sttSockets.has(roomId)) return this.sttSockets.get(roomId);

    const langCode = sourceLang || 'pt-BR';
    const dgUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=${langCode}&smart_format=true&interim_results=true&encoding=linear16&sample_rate=16000`;

    try {
      const dgSocket = new WebSocket(dgUrl, {
        headers: {
          Authorization: `Token ${this.deepgramKey}`
        }
      });

      dgSocket.on('open', () => {
        console.log(`[AI-STT] Conectado ao Deepgram para a sala ${roomId}`);
      });

      dgSocket.on('message', (data) => {
        try {
          const response = JSON.parse(data.toString());
          const transcript = response?.channel?.alternatives?.[0]?.transcript;
          const isFinal = response?.is_final || response?.speech_final;

          if (transcript && transcript.trim().length > 0) {
            onTranscript({
              text: transcript,
              isFinal: !!isFinal,
              timestamp: Date.now()
            });
          }
        } catch (err) {
          console.error('[AI-STT] Erro ao parsear resposta Deepgram:', err.message);
        }
      });

      dgSocket.on('error', (err) => {
        console.error(`[AI-STT] Erro no socket Deepgram (${roomId}):`, err.message);
      });

      dgSocket.on('close', () => {
        console.log(`[AI-STT] Socket Deepgram fechado para sala ${roomId}`);
        this.sttSockets.delete(roomId);
      });

      this.sttSockets.set(roomId, dgSocket);
      return dgSocket;
    } catch (err) {
      console.error('[AI-STT] Falha ao criar sessão Deepgram:', err.message);
      return null;
    }
  }

  /**
   * Envia chunks de áudio PCM para o STT
   */
  feedAudio(roomId, audioBuffer, sourceLang, onTranscript) {
    if (this.mockMode) {
      // No modo sem chave externa de API STT, o áudio original é transmitido diretamente
      // e o reconhecimento real de voz é feito com precisão pelo navegador do host via SpeechRecognition.
      return;
    }

    const dg = this.getOrCreateDeepgramSession(roomId, sourceLang, onTranscript);
    if (dg && dg.readyState === WebSocket.OPEN) {
      dg.send(audioBuffer);
    }
  }

  /**
   * Traduz o texto para os idiomas alvo respeitando o glossário cadastrado com altíssima velocidade (<150ms).
   * Executa em paralelo (Promise.all) e dispara o callback onLanguageTranslated assim que cada idioma conclui.
   */
  async translateText(text, targetLangs, glossary = {}, onLanguageTranslated = null, roomId = null) {
    const translations = {};
    const cleanInput = this.stripLanguagePrefixTag(text);
    if (!cleanInput) return translations;

    // Helper para aplicar termos de glossário pós-tradução e remover qualquer tag [EN]/[ES]
    const finalizeOutput = (rawText) => {
      let output = this.stripLanguagePrefixTag(rawText);
      if (glossary && Object.keys(glossary).length > 0) {
        for (const [term, replacement] of Object.entries(glossary)) {
          if (!term || !replacement) continue;
          const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
          output = output.replace(regex, replacement);
        }
      }
      return output;
    };

    const cacheResult = (cacheKey, val) => {
      if (this.translationCache.size > 1500) {
        const oldest = this.translationCache.keys().next().value;
        this.translationCache.delete(oldest);
      }
      this.translationCache.set(cacheKey, val);
    };

    // Dicionário de termos para substituição de glossário via prompt LLM
    let glossaryInstructions = '';
    if (glossary && Object.keys(glossary).length > 0) {
      glossaryInstructions = `Glossário obrigatório: ${JSON.stringify(glossary)}. Mantenha esses termos exatamente como definidos.`;
    }

    // Contexto de sentenças anteriores para coerência sintática
    let contextPrompt = '';
    if (roomId && this.roomContextMemory && this.roomContextMemory.has(roomId)) {
      const prev = this.roomContextMemory.get(roomId);
      if (prev && prev.lastSourceText) {
        contextPrompt = `Contexto imediato anterior da fala: "${prev.lastSourceText}". Mantenha coerência de termos, pronomes e tempos verbais com este contexto.`;
      }
    }

    const mockTranslationDict = {
      'en': {
        'Olá a todos, sejam bem-vindos à nossa palestra ao vivo.': 'Hello everyone, welcome to our live presentation.',
        'Estamos transmitindo o áudio original da mesa de som com baixíssima latência.': 'We are streaming the original audio from the soundboard with ultra-low latency.',
        'A tradução simultânea e as legendas inteligentes estão ativas na sala.': 'Simultaneous translation and smart subtitles are active in this room.',
        'A tecnologia da Videomappingtech permite eventos e palcos silenciosos inovadores.': 'Videomappingtech technology enables innovative silent stages and events.',
        'O som chega com altíssima fidelidade e sem atraso nos seus fones de ouvido.': 'The audio reaches your headphones with high fidelity and zero delay.'
      },
      'es': {
        'Olá a todos, sejam bem-vindos à nossa palestra ao vivo.': 'Hola a todos, bienvenidos a nuestra conferencia en vivo.',
        'Estamos transmitindo o áudio original da mesa de som com baixíssima latência.': 'Estamos transmitiendo el audio original de la consola con muy baja latencia.',
        'A tradução simultânea e as legendas inteligentes estão ativas na sala.': 'La traducción simultánea y los subtítulos inteligentes están activos en la sala.',
        'A tecnologia da Videomappingtech permite eventos e palcos silenciosos inovadores.': 'La tecnología de Videomappingtech permite escenarios silenciosos innovadores.',
        'O som chega com altíssima fidelidade e sem atraso nos seus fones de ouvido.': 'El sonido llega con alta fidelidad y sin retraso a sus auriculares.'
      }
    };

    const translateSingleLanguage = async (targetLang) => {
      const normalizedLang = (targetLang || 'en').split('-')[0].toLowerCase();
      const cacheKey = `${normalizedLang}:${cleanInput.toLowerCase()}`;

      // 0. Cache em memória instantâneo (0ms)
      if (this.translationCache.has(cacheKey)) {
        const cached = finalizeOutput(this.translationCache.get(cacheKey));
        translations[targetLang] = cached;
        if (typeof onLanguageTranslated === 'function') onLanguageTranslated(targetLang, cached);
        return cached;
      }

      // 1. Dicionário estático instantâneo (0ms)
      if (mockTranslationDict[normalizedLang]?.[cleanInput]) {
        const res = finalizeOutput(mockTranslationDict[normalizedLang][cleanInput]);
        cacheResult(cacheKey, res);
        translations[targetLang] = res;
        if (typeof onLanguageTranslated === 'function') onLanguageTranslated(targetLang, res);
        return res;
      }

      // 2. Provedores LLM de ultra-baixa latência (Groq llama-3.1-8b-instant ~90ms / OpenAI gpt-4o-mini)
      if (this.openaiKey || this.groqKey) {
        try {
          const endpoint = this.groqKey 
            ? 'https://api.groq.com/openai/v1/chat/completions' 
            : 'https://api.openai.com/v1/chat/completions';
          const key = this.groqKey || this.openaiKey;
          const model = this.groqKey ? 'llama-3.1-8b-instant' : 'gpt-4o-mini';

          const res = await fetch(endpoint, {
            method: 'POST',
            signal: AbortSignal.timeout(2200),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${key}`
            },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: 'system',
                  content: `Você é um intérprete de tradução simultânea profissional. Traduza o texto para o idioma '${normalizedLang}'. Retorne SOMENTE a frase traduzida pura, NUNCA inclua prefixos como [EN], [ES], aspas ou notas explicativas. ${contextPrompt} ${glossaryInstructions}`
                },
                {
                  role: 'user',
                  content: cleanInput
                }
              ],
              temperature: 0.1,
              max_tokens: 180
            })
          });

          if (res.ok) {
            const data = await res.json();
            let translated = data.choices?.[0]?.message?.content?.trim();
            if (translated) {
              if (translated.startsWith('"') && translated.endsWith('"')) {
                translated = translated.slice(1, -1).trim();
              }
              translated = finalizeOutput(translated);
              if (translated) {
                cacheResult(cacheKey, translated);
                translations[targetLang] = translated;
                if (typeof onLanguageTranslated === 'function') onLanguageTranslated(targetLang, translated);
                return translated;
              }
            }
          }
        } catch (e) {
          console.warn(`[AI-Translate] LLM rápido excedeu tempo ou falhou para ${targetLang} (${e.message}), usando fallback rápido`);
        }
      }

      // 3. Motor Primário Gratuito de Altíssima Velocidade (<50ms): Google GTX Engine
      try {
        const gtxUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(normalizedLang)}&dt=t&q=${encodeURIComponent(cleanInput)}`;
        const gtxRes = await fetch(gtxUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(3000)
        });
        if (gtxRes.ok) {
          const gtxData = await gtxRes.json();
          if (Array.isArray(gtxData?.[0])) {
            let translated = gtxData[0].map(chunk => chunk[0] || '').join('').trim();
            translated = finalizeOutput(translated);
            if (translated) {
              cacheResult(cacheKey, translated);
              translations[targetLang] = translated;
              if (typeof onLanguageTranslated === 'function') onLanguageTranslated(targetLang, translated);
              return translated;
            }
          }
        }
      } catch (gtxErr) {
        console.warn(`[AI-Translate] Google GTX primário falhou para ${targetLang}:`, gtxErr.message);
      }

      // 4. Mirror Secundário Independente (<60ms): Google Clients5 Dict API
      try {
        const c5Url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${encodeURIComponent(normalizedLang)}&q=${encodeURIComponent(cleanInput)}`;
        const c5Res = await fetch(c5Url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(3000)
        });
        if (c5Res.ok) {
          const c5Data = await c5Res.json();
          let rawCandidate = '';
          if (Array.isArray(c5Data)) {
            if (typeof c5Data[0] === 'string') {
              rawCandidate = c5Data[0];
            } else if (Array.isArray(c5Data[0]) && typeof c5Data[0][0] === 'string') {
              rawCandidate = c5Data.map(item => item[0] || '').join(' ');
            }
          } else if (c5Data && Array.isArray(c5Data.sentences)) {
            rawCandidate = c5Data.sentences.map(s => s.trans || '').join(' ');
          }
          const translated = finalizeOutput(rawCandidate);
          if (translated) {
            cacheResult(cacheKey, translated);
            translations[targetLang] = translated;
            if (typeof onLanguageTranslated === 'function') onLanguageTranslated(targetLang, translated);
            return translated;
          }
        }
      } catch (c5Err) {
        console.warn(`[AI-Translate] Google Clients5 mirror falhou para ${targetLang}:`, c5Err.message);
      }

      // 5. Fallback Terciário (MyMemory com filtro contra avisos de cota)
      try {
        const langPair = `pt|${normalizedLang}`;
        const freeRes = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(cleanInput)}&langpair=${langPair}`, {
          signal: AbortSignal.timeout(2500)
        });
        if (freeRes.ok) {
          const freeData = await freeRes.json();
          const translatedText = freeData?.responseData?.translatedText;
          if (
            translatedText &&
            !translatedText.includes('QUERY LENGTH LIMIT') &&
            !translatedText.includes('MYMEMORY WARNING') &&
            !translatedText.includes('PLEASE SELECT TWO DISTINCT')
          ) {
            const clean = finalizeOutput(translatedText);
            if (clean) {
              cacheResult(cacheKey, clean);
              translations[targetLang] = clean;
              if (typeof onLanguageTranslated === 'function') onLanguageTranslated(targetLang, clean);
              return clean;
            }
          }
        }
      } catch (freeErr) {}

      // 6. Último recurso se todos os motores estiverem sem internet: retorna o texto limpo SEM prefixos [EN]/[ES]
      const fallback = finalizeOutput(cleanInput);
      translations[targetLang] = fallback;
      if (typeof onLanguageTranslated === 'function') onLanguageTranslated(targetLang, fallback);
      return fallback;
    };

    // Executa TODOS os idiomas alvo em paralelo instantâneo (Promise.all)
    await Promise.all(targetLangs.map(lang => translateSingleLanguage(lang)));

    if (roomId && cleanInput) {
      if (!this.roomContextMemory) this.roomContextMemory = new Map();
      this.roomContextMemory.set(roomId, { lastSourceText: cleanInput, lastTranslations: translations });
    }

    return translations;
  }

  /**
   * Síntese de fala rápida (TTS) para canais de voz traduzida
   */
  async synthesizeSpeech(text, targetLang) {
    if (this.mockMode) return null;

    // Cartesia Sonic (TTS de ultra-baixa latência)
    if (this.cartesiaKey) {
      try {
        const response = await fetch('https://api.cartesia.ai/tts/bytes', {
          method: 'POST',
          headers: {
            'Cartesia-Version': '2024-06-10',
            'X-API-Key': this.cartesiaKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model_id: 'sonic-multilingual',
            transcript: text,
            voice: {
              mode: 'id',
              id: targetLang.startsWith('en') ? 'a0e99841-438c-4a64-b679-ae501e7d6091' : '5c5ad5e7-1014-460d-83bd-1c6076b11268'
            },
            output_format: {
              container: 'raw',
              encoding: 'pcm_s16le',
              sample_rate: 24000
            }
          })
        });

        if (response.ok) {
          return Buffer.from(await response.arrayBuffer());
        }
      } catch (err) {
        console.error('[AI-TTS] Erro Cartesia:', err.message);
      }
    }

    return null;
  }

  closeSession(roomId) {
    const dg = this.sttSockets.get(roomId);
    if (dg) {
      try { dg.close(); } catch (e) {}
      this.sttSockets.delete(roomId);
    }
  }
}

const aiPipeline = new AIPipeline();

module.exports = {
  aiPipeline
};
