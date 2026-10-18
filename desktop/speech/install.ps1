param([switch]$Diarization)
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
Write-Host 'Motor instalado. Reinicie o aplicativo desktop para utilizá-lo.'
Write-Host 'Os modelos serão baixados na primeira ativação. Pyannote exige aceite no Hugging Face e HF_TOKEN no ambiente.'
