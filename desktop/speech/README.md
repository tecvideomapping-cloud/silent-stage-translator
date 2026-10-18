# Reconhecimento local no desktop

O aplicativo Electron captura a fonte selecionada na mesa (microfone, saída do PC ou arquivo), converte uma cópia para PCM mono de 16 kHz e envia essa cópia ao processo Python pelo IPC nativo. O áudio dos participantes continua no caminho existente. O motor local não abre portas HTTP e não grava áudio ou transcrições em arquivos.

## Windows

Instale Python 3.11 ou superior. Na pasta do projeto, execute:

```powershell
powershell -ExecutionPolicy Bypass -File desktop/speech/install.ps1
npm run desktop
```

O ambiente isolado fica em `%USERPROFILE%/.silentstageai/speech-env`. O app o reconhece na próxima inicialização. Também é possível definir `VMT_SPEECH_PYTHON` com o caminho absoluto de outro Python que tenha as dependências instaladas. Não coloque esse caminho nas variáveis do Railway.

Na mesa de operação do aplicativo instalado, selecione **Ativar motor local**. Use Base como ponto de partida; Tiny reduz custo de processamento e Small prioriza precisão. Os modelos são baixados na primeira ativação para o cache do Hugging Face. Carregamento e aquecimento terminam antes do estado “pronto”. Não existe promessa de latência inferior a dois segundos.

O botão **Usar modo atual** volta ao reconhecimento já disponível. Parar a transmissão, navegar ou fechar o aplicativo encerra o processo e descarta os resultados pendentes. O motor precisa ser ativado novamente para uma nova transmissão. Se a máquina não acompanhar, a fila limitada interrompe o motor com aviso, em vez de acumular atraso. Na mesa host, o reconhecimento atual pode ser retomado; na workstation local, use uma configuração mais leve ou a mesa host.

## Identificação opcional de locutores

Não é requisito da transcrição. Para habilitar:

1. Aceite os termos de https://huggingface.co/pyannote/speaker-diarization-community-1.
2. Crie um token de leitura em https://huggingface.co/settings/tokens.
3. Configure `HF_TOKEN` somente no ambiente local que inicia o aplicativo, sem inserir a chave em páginas, código ou variáveis públicas.
4. Execute o instalador com `-Diarization` e reinicie o aplicativo.
5. Marque **Separar locutores (Pyannote)** antes de ativar o motor.

No Windows, a integração também lê a credencial do arquivo `.silentstageai/huggingface.encrypted` no perfil do usuário, protegido pelo armazenamento seguro do Electron. A configuração desse arquivo é uma operação administrativa local; não há endpoint ou campo web que leia a chave. A variável `HF_TOKEN`, se existir no ambiente do aplicativo, tem precedência.

O Pyannote executa na CPU em uma janela de até 30 segundos. Isso pode aumentar o atraso. Os rótulos entre janelas são associados pelo áudio em comum. Quando um locutor retorna depois de sair do contexto, pode receber outro número. Sobreposição ambígua fica sem rótulo; não inferimos identidade ou gênero pelo texto ou pelo tom da voz.

## Escopo e distribuição

- A transcrição pode funcionar sem internet após o download. Tradução, cobrança, eventos e voz continuam dependendo dos serviços atuais. Isso não transforma todo o produto em um sistema offline.
- O código de integração foi escrito para este projeto; não incorpora o aplicativo VoiceStudio nem seu sintetizador OmniVoice.
- Electron e os arquivos de integração entram no instalador. Python, suas dependências e os modelos são instalados separadamente. Em macOS/Linux, crie um ambiente com as dependências de `requirements.txt` (ou apenas Faster-Whisper), configure `VMT_SPEECH_PYTHON` e valide na plataforma; esta entrega foi testada no Windows.
- As rotas e os metadados compartilhados aceitam a transcrição do desktop autenticado; o navegador comum não recebe o seletor nem inicia processos locais.
