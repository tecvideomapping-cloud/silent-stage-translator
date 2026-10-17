#!/usr/bin/env bash
# ==============================================================================
# Silent Stage AI - Lançador Desktop macOS (Workstation Edition)
# Videomappingtech - Palco Silencioso e Tradução Simultânea com IA
# ==============================================================================

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$DIR"

echo "---------------------------------------------------------"
echo "🎙️ SILENT STAGE AI - WORKSTATION PRO (MACOS)"
echo "---------------------------------------------------------"

if ! command -v node &> /dev/null; then
    echo "❌ Node.js não foi encontrado no seu Mac."
    echo "Por favor, instale o Node.js através de https://nodejs.org/ ou via Homebrew:"
    echo "  brew install node"
    echo ""
    read -p "Pressione Enter para sair..."
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "📦 Instalando dependências do projeto..."
    npm install
fi

echo "🚀 Iniciando estação Silent Stage AI com aceleração Metal e CoreAudio..."
npm run desktop
