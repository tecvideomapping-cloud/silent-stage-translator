const { WebSocket } = require('ws');

class AIPipeline {
  constructor() {
    this.deepgramKey = process.env.DEEPGRAM_API_KEY;
    this.openaiKey = process.env.OPENAI_API_KEY;
    this.groqKey = process.env.GROQ_API_KEY;
    this.deeplKey = process.env.DEEPL_API_KEY;
    this.cartesiaKey = process.env.CARTESIA_API_KEY;
    this.elevenlabsKey = process.env.ELEVENLABS_API_KEY;
    this.mockMode = process.env.MOCK_AI === 'true' || (!this.deepgramKey && !this.openaiKey);
    
    // Conexões ativas do Deepgram por sala
    this.sttSockets = new Map();
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
      // No modo mock o áudio original toca normalmente, mas simulamos transcrições esporádicas se não houver chaves de IA
      return;
    }

    const dg = this.getOrCreateDeepgramSession(roomId, sourceLang, onTranscript);
    if (dg && dg.readyState === WebSocket.OPEN) {
      dg.send(audioBuffer);
    }
  }

  /**
   * Traduz o texto para os idiomas alvo respeitando o glossário cadastrado
   */
  async translateText(text, targetLangs, glossary = {}) {
    const translations = {};

    // Dicionário de termos para substituição de glossário
    let glossaryInstructions = '';
    if (glossary && Object.keys(glossary).length > 0) {
      glossaryInstructions = `Glossário obrigatório de termos: ${JSON.stringify(glossary)}. Mantenha esses termos exatamente como definidos.`;
    }

    for (const targetLang of targetLangs) {
      if (this.mockMode) {
        // Mock simples de tradução para testes locais
        translations[targetLang] = `[${targetLang.toUpperCase()}] ${text}`;
        continue;
      }

      // Tentativa 1: OpenAI ou Groq via HTTP Fetch
      if (this.openaiKey || this.groqKey) {
        try {
          const endpoint = this.groqKey 
            ? 'https://api.groq.com/openai/v1/chat/completions' 
            : 'https://api.openai.com/v1/chat/completions';
          const key = this.groqKey || this.openaiKey;
          const model = this.groqKey ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini';

          const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${key}`
            },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: 'system',
                  content: `Você é um tradutor simultâneo ultrarrápido para eventos ao vivo. Traduza a fala a seguir para o idioma com código ISO '${targetLang}'. Retorne APENAS a tradução direta, sem comentários. ${glossaryInstructions}`
                },
                {
                  role: 'user',
                  content: text
                }
              ],
              temperature: 0.2,
              max_tokens: 300
            })
          });

          if (res.ok) {
            const data = await res.json();
            translations[targetLang] = data.choices?.[0]?.message?.content?.trim() || text;
            continue;
          }
        } catch (e) {
          console.error(`[AI-Translate] Erro na tradução para ${targetLang}:`, e.message);
        }
      }

      // Fallback
      translations[targetLang] = text;
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
