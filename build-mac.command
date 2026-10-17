#!/usr/bin/env bash
# ==============================================================================
# Silent Stage AI - Compilador de Instalador .DMG macOS
# Videomappingtech - Palco Silencioso e Tradução Simultânea com IA
# ==============================================================================

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
if [ -f "$DIR/package.json" ]; then
    cd "$DIR"
elif [ -f "$DIR/../package.json" ]; then
    cd "$DIR/.."
fi

clear
echo "=========================================================="
echo "🍏 SILENT STAGE AI - GERADOR DO INSTALADOR .DMG (MACOS)"
echo "=========================================================="
echo ""

# 1. Checa Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js não foi encontrado no seu sistema."
    echo "Baixe e instale o Node.js LTS em https://nodejs.org/"
    echo "Ou via Homebrew no Terminal: brew install node"
    echo ""
    read -p "Pressione Enter para encerrar..."
    exit 1
fi

echo "✓ Node.js: $(node -v)"
echo "✓ NPM:     $(npm -v)"
echo ""

# 2. Instala dependências se necessário
if [ ! -d "node_modules" ] || [ ! -f "node_modules/.bin/electron-builder" ]; then
    echo "📦 Baixando dependências necessárias (primeira execução)..."
    npm install
fi

# 3. Detecta arquitetura
ARCH="$(uname -m)"
echo "🖥️ Arquitetura do Mac: $ARCH"
if [ "$ARCH" = "arm64" ]; then
    echo "   -> Apple Silicon (M1 / M2 / M3 / M4)"
    TARGET_FLAG="--arm64"
else
    echo "   -> Intel (x86_64)"
    TARGET_FLAG="--x64"
fi
echo ""

# 4. Desativa exigência de certificado Apple Developer pago (evita erro de codesign)
export CSC_IDENTITY_AUTO_DISCOVERY=false

echo "🔨 Iniciando compilação do pacote DMG..."
echo "Aguarde alguns instantes enquanto o instalador é gerado..."
echo ""

npx electron-builder --mac dmg $TARGET_FLAG --publish never

BUILD_STATUS=$?

echo ""
if [ $BUILD_STATUS -eq 0 ]; then
    echo "=========================================================="
    echo "🎉 SUCESSO! Instalador .DMG gerado com sucesso!"
    echo "=========================================================="
    echo ""
    echo "Arquivos gerados na pasta 'dist/':"
    ls -lh dist/*.dmg 2>/dev/null || ls -lh dist/
    echo ""
    echo "Abrindo pasta 'dist' no Finder..."
    open dist/
else
    echo "=========================================================="
    echo "⚠️ Ocorreu um erro durante a compilação do .DMG."
    echo "=========================================================="
fi

echo ""
read -p "Pressione Enter para fechar esta janela..."
