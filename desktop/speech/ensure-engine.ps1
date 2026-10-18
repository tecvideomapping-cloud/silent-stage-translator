param([switch]$CheckOnly,[switch]$Cuda,[switch]$Diarization,[string]$EnvironmentRoot=(Join-Path $env:USERPROFILE '.silentstageai\speech-env'))
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$env:PYTHONUTF8='1'
function Emit($type,$message,$report=$null){@{type=$type;message=$message;report=$report}|ConvertTo-Json -Compress -Depth 8|Write-Output}
$python=Join-Path $EnvironmentRoot 'Scripts\python.exe'
function Check-Environment {
 if(!(Test-Path -LiteralPath $python)){return @{pythonInstalled=$false;coreReady=$false;cudaReady=$false;diarizationReady=$false}}
 $code=@'
import json,importlib.metadata as m,importlib.util as u,sys
def version(name,value):
 try:return m.version(name)==value
 except m.PackageNotFoundError:return False
core=False
try:
 import faster_whisper,av
 core=version('faster-whisper','1.2.1') and version('av','15.1.0')
except Exception:pass
print(json.dumps({'pythonInstalled':True,'pythonVersion':sys.version.split()[0],'coreReady':core,'cudaReady':all(version(k,v) for k,v in {'nvidia-cublas-cu12':'12.9.2.10','nvidia-cudnn-cu12':'9.27.0.42','nvidia-cuda-runtime-cu12':'12.9.79','nvidia-cuda-nvrtc-cu12':'12.9.86'}.items()),'diarizationReady':version('pyannote.audio','4.0.7')}))
'@
 try{$result=& $python -c $code 2>$null;if($LASTEXITCODE -eq 0){return ($result|ConvertFrom-Json)}}catch{}
 return @{pythonInstalled=$false;coreReady=$false;cudaReady=$false;diarizationReady=$false}
}
try {
 $report=Check-Environment
 if($CheckOnly){Emit 'check' 'Verificação concluída.' $report;exit 0}
 if(!$report.pythonInstalled){
  Emit 'progress' 'Preparando Python e ambiente isolado…'
  $basePython=$null
  $command=Get-Command python.exe -ErrorAction SilentlyContinue
  $candidates=@((Join-Path $env:LOCALAPPDATA 'SilentStage\Python313\python.exe'),(Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe'),'C:\Python313\python.exe')
  if($command){$candidates+= $command.Source}
  foreach($candidate in $candidates){if($candidate -match '\\WindowsApps\\'){continue};if(Test-Path -LiteralPath $candidate){try{& $candidate -c 'import sys;sys.exit(0 if (3,11)<=sys.version_info[:2]<=(3,13) else 1)' 2>$null;if($LASTEXITCODE -eq 0){$basePython=$candidate;break}}catch{}}}
  if(!$basePython){
   Emit 'progress' 'Baixando Python oficial (28,5 MB)…'
   $download=Join-Path $env:TEMP ('silent-stage-python-'+[guid]::NewGuid()+'.exe')
   [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
   Invoke-WebRequest -UseBasicParsing -Uri 'https://www.python.org/ftp/python/3.13.16/python-3.13.16-amd64.exe' -OutFile $download
   if((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne 'FB4F9F5D438B2396DA0086DC70B935C530CB578E37ADC6D354F7AD2037FEE83B'){throw 'A integridade do instalador Python não foi confirmada.'}
   $target=Join-Path $env:LOCALAPPDATA 'SilentStage\Python313'
   $process=Start-Process -FilePath $download -ArgumentList @('/quiet','InstallAllUsers=0','PrependPath=0','Include_test=0','Include_launcher=0',('TargetDir="'+$target+'"')) -WindowStyle Hidden -Wait -PassThru
   if($process.ExitCode -notin @(0,3010)){throw 'Não foi possível instalar o Python.'}
   $basePython=Join-Path $target 'python.exe'
  }
  & $basePython -m venv $EnvironmentRoot *> $null
  if($LASTEXITCODE -ne 0){throw 'Não foi possível criar o ambiente isolado.'}
 }
 $report=Check-Environment
 if(!$report.coreReady){Emit 'progress' 'Instalando bibliotecas de transcrição…';& $python -m pip install --disable-pip-version-check --only-binary=:all: 'faster-whisper==1.2.1' 'av==15.1.0' *> $null;if($LASTEXITCODE -ne 0){throw 'A instalação da transcrição falhou. Confira a conexão e tente novamente.'}}
 if($Cuda -and !$report.cudaReady){Emit 'progress' 'Instalando bibliotecas NVIDIA CUDA 12/cuDNN (aproximadamente 1,4 GB)…';& $python -m pip install --disable-pip-version-check --only-binary=:all: 'nvidia-cublas-cu12==12.9.2.10' 'nvidia-cudnn-cu12==9.27.0.42' 'nvidia-cuda-runtime-cu12==12.9.79' 'nvidia-cuda-nvrtc-cu12==12.9.86' *> $null;if($LASTEXITCODE -ne 0){throw 'A instalação das bibliotecas NVIDIA falhou. A transcrição por CPU continua disponível.'}}
 if($Diarization -and !$report.diarizationReady){Emit 'progress' 'Instalando identificação opcional de locutores (Pyannote)…';& $python -m pip install --disable-pip-version-check 'pyannote.audio==4.0.7' *> $null;if($LASTEXITCODE -ne 0){throw 'A instalação do Pyannote falhou.'}}
 $report=Check-Environment
 if(!$report.coreReady -or ($Cuda -and !$report.cudaReady) -or ($Diarization -and !$report.diarizationReady)){throw 'A verificação final encontrou bibliotecas ausentes. Tente novamente.'}
 Emit 'complete' 'Bibliotecas verificadas. O download dos modelos ocorre na primeira ativação.' $report
}catch{Emit 'error' $_.Exception.Message;exit 1}

