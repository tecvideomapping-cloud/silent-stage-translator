param([switch]$Diarization,[switch]$Cuda)
$ErrorActionPreference = 'Stop'
$speechRoot = Join-Path $env:USERPROFILE '.silentstageai\speech-env'
if (-not (Test-Path -LiteralPath (Join-Path $speechRoot 'Scripts\python.exe'))) {
  python -m venv $speechRoot
  if ($LASTEXITCODE -ne 0) { throw 'Não foi possível criar o ambiente Python.' }
}
$speechPython = Join-Path $speechRoot 'Scripts\python.exe'
& $speechPython -m pip install 'faster-whisper==1.2.1' 'av==15.1.0'
if ($LASTEXITCODE -ne 0) { throw 'A instalação do Faster-Whisper falhou.' }
if ($Diarization) {
  & $speechPython -m pip install 'pyannote.audio==4.0.7'
  if ($LASTEXITCODE -ne 0) { throw 'A instalação do Pyannote falhou.' }
}
if ($Cuda) {
  & $speechPython -m pip install --only-binary=:all: 'nvidia-cublas-cu12==12.9.2.10' 'nvidia-cudnn-cu12==9.27.0.42' 'nvidia-cuda-runtime-cu12==12.9.79' 'nvidia-cuda-nvrtc-cu12==12.9.86'
  if ($LASTEXITCODE -ne 0) { throw 'A instalação das bibliotecas CUDA do motor falhou.' }
  Write-Host 'Bibliotecas NVIDIA instaladas apenas neste ambiente. O PyTorch/Pyannote continua usando o backend já instalado.'
}
Write-Host 'Motor instalado. Reinicie o aplicativo desktop para utilizá-lo.'
Write-Host 'Os modelos serão baixados na primeira ativação. Pyannote exige aceite no Hugging Face e HF_TOKEN no ambiente.'
