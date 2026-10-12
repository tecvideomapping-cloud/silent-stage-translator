# Videomappingtech Silent Translator & AI Interpretation

Plataforma de **Palestras Silenciosas (Silent Stage)** e **Tradução / Legendagem Simultânea com IA** em tempo real para eventos, auditórios e congressos.

---

## 🌟 Principais Recursos

1. **🎙️ Modo Palestra Silenciosa (Silent Theater / Silent Stage):**
   - Transmissão do **áudio original sem atraso** da mesa de som diretamente para o smartphone e fones de ouvido dos ouvintes.
   - Ideal para feiras e congressos com múltiplos palcos simultâneos no mesmo pavilhão.
2. **🌐 Tradução Simultânea Multilíngue:**
   - Transcrição em tempo real (STT) via **Deepgram Nova-2**.
   - Tradução com **Groq / OpenAI / DeepL** com injeção de **Glossário Customizado** pré-evento.
   - Síntese de voz em tempo real (TTS) via **Cartesia Sonic** ou **ElevenLabs**.
3. **📱 Acesso Zero Fricção (QR Code):**
   - Ouvintes acessam via link curto ou QR Code no navegador mobile.
   - Sem download de aplicativo nem cadastro obrigatório.
4. **📺 Telão de Palco & Modo Chroma Key:**
   - Rota `/screen.html?room=ID` para projeção ou painéis de LED.
   - Modo Verde Chroma Key (`#00FF00`) para corte direto em mesas de vídeo (vMix, OBS, ATEM).

---

## 🚀 Como Rodar Localmente

1. Entre no diretório do projeto:
   ```bash
   cd "C:\Users\Ivan Xavier\.gemini\antigravity\scratch\videomappingtech-silent-translator"
   ```

2. Instale as dependências:
   ```bash
   npm install
   ```

3. Configure o arquivo de variáveis de ambiente:
   ```bash
   cp .env.example .env
   ```
   *(Caso não adicione chaves de IA no momento, o projeto funciona em modo local/mock para testar a transmissão do áudio original e legendas).*

4. Inicie o servidor:
   ```bash
   npm start
   ```

5. Abra no navegador:
   - **Ouvinte / Participante:** [http://localhost:3000](http://localhost:3000)
   - **Transmissor / Palco (Host):** [http://localhost:3000/host.html](http://localhost:3000/host.html)
   - **Telão de Projeção:** [http://localhost:3000/screen.html](http://localhost:3000/screen.html)

---

## 🚢 Publicando no GitHub da `videomappingtech` e no Railway

### 1. Inicializar Git e Enviar para o GitHub
No terminal do projeto:

```bash
git init
git add .
git commit -m "feat: initial commit - silent stage & realtime ai translator"
git branch -M main
git remote add origin https://github.com/videomappingtech/silent-stage-translator.git
git push -u origin main
```

### 2. Deploy no Railway
1. Acesse o painel do [Railway](https://railway.app).
2. Clique em **+ New Project** $\rightarrow$ **Deploy from GitHub repo** e selecione o repositório da `videomappingtech`.
3. No mesmo projeto do Railway, clique em **+ New Service** e adicione:
   - **PostgreSQL Database** (o Railway injetará automaticamente a variável `DATABASE_URL`).
   - **Redis** (o Railway injetará automaticamente a variável `REDIS_URL`).
4. Nas **Variables** do serviço web, adicione as chaves de IA conforme desejar:
   - `DEEPGRAM_API_KEY`: para STT streaming ultrarrápido.
   - `OPENAI_API_KEY` ou `GROQ_API_KEY`: para tradução com glossário.
   - `CARTESIA_API_KEY`: para TTS de voz sintetizada.
5. Em **Settings** do serviço, clique em **Generate Domain** (ex: `silent-stage-production.up.railway.app`).
6. Pronto! O serviço estará 100% no ar com certificados SSL/WSS automáticos.
