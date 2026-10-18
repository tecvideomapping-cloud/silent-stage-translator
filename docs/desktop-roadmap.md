# Desktop: execução por etapas

Atualizado em 18/10/2026. Este documento separa entrega, integração e homologação. Uma placa detectada não prova que um modelo a utiliza. As metas de latência do plano mestre são objetivos, não medições do produto atual.

## 1 — Diagnóstico e controle local (versão 1.0.7)

- Painel “Hardware e modelos locais” na mesa, com acesso pela sidebar do desktop.
- Inventário de CPU, RAM e GPUs; compatibilidade real consultada no ambiente Python.
- CPU/RAM do processo de inferência, tempo de processamento, espera de fila e RTF.
- Uso/VRAM/temperatura globais de cada GPU NVIDIA; VRAM do processo somente quando o driver a informa.
- Seleção CPU/CUDA, índice da GPU, precisão e threads. O dispositivo só aparece como “em execução” após carregar e aquecer o modelo. Sem fallback silencioso para CPU.
- Correção de indicadores que anunciavam backends e recomendações não implementados.
- Aviso quando há áudio mas nenhum reconhecimento disponível; não substituir silenciosamente áudio do PC por microfone.

Validação prevista: transcrever o mesmo áudio em CPU e GPU, comparar texto e tempo, conferir métricas e interromper sem resultados antigos vazarem para outra sessão.

## 2 — Distribuição de motores e instalação assistida

- STT e diarização têm dispositivos independentes. É possível atribuí-los a GPUs diferentes quando CTranslate2 e PyTorch disponibilizam os respectivos dispositivos.
- A configuração não divide um único modelo entre placas nem promete redução de latência com duas GPUs. Não há TTS local alocado a uma GPU nesta entrega.
- Nesta máquina: RTX 3050 Ti 4 GB validada para STT CUDA; PyTorch instalado é CPU. Duas GPUs físicas ainda precisam de homologação.
- Instalador Windows abre um assistente que verifica e instala dependências ausentes no ambiente isolado do usuário. CUDA e Pyannote são opcionais; Python oficial é preparado quando necessário.
- Atalho “Silent Stage - Preparar motor local” permite repetir a verificação. Modelos não são baixados sem a primeira ativação; o token do Hugging Face não entra no instalador.

Aceite: instalação limpa de CPU, repetição sem reinstalar bibliotecas presentes, falhas visíveis, revisão da integridade do download de Python e validação no executável empacotado.

## 3 — Tradução e voz locais

Ainda pendente. Integrar motores como provedores separados, com instalação guiada, licença e tamanho dos modelos exibidos. Validar português/inglês/espanhol, qualidade, duração da fala, cancelamento, filas e funcionamento sem rede. Clonagem neural real exige um motor próprio e amostras autorizadas; os perfis atuais não são clonagem.

Aceite: transmissão completa sem rede após preparar modelos, sem chamar provedores externos, com texto/voz sincronizados e medições comparáveis ao serviço atual.

## 4 — Licença e consumo offline

Ainda pendente. Emitir concessões assinadas por evento/dispositivo, reservar saldo na nuvem, registrar consumo local e reconciliar sem crédito duplicado. Tratar expiração, relógio alterado, perda de rede, troca de máquina e reembolso. O saldo online existente não deve ser inventado ou duplicado no desktop.

## 5 — Áudio profissional e captura por aplicativo

Ainda pendente. Implementar backend nativo de captura e processamento com testes próprios. Enumerar ASIO não implementa ASIO exclusivo. Isolar áudio de Spotify/Media Player no Windows exige captura por processo; o loopback atual captura o sistema inteiro. Medir continuidade, atraso e CPU antes de introduzir RNNoise/DeepFilterNet ou prometer buffers profissionais.

## 6 — macOS e distribuição

Ainda pendente de homologação em Macs reais. Validar Apple Silicon/Intel, permissões de áudio/tela, instalação de runtime, assinatura/notarização, atualização e dispositivo de captura. CUDA NVIDIA não se aplica à GPU Apple; o motor atual usa CPU no Mac. Adicionar um backend Apple somente após integração e medição.

## Ordem e proteção da operação

Publicar etapas pequenas, preservar eventos e saldos e manter o caminho atual de áudio. Testes não devem interromper transmissões de clientes. Não declarar uma etapa concluída apenas por haver controles na interface ou um instalador compilado.
