#!/bin/bash
# scripts/update.sh
# Script de auto-atualização do BestCode Control Panel (BCP)

echo "Iniciando atualização do BestCode CP..."

# Direciona todo output para arquivo de log
LOG_FILE="/opt/bestcode-cp/backend/temp/update.log"
mkdir -p /opt/bestcode-cp/backend/temp
exec > >(tee -ia "$LOG_FILE") 2>&1

cd /opt/bestcode-cp || { echo "Falha ao acessar diretório /opt/bestcode-cp"; exit 1; }

# Garante que o git confia no diretório para rodar comandos como root
git config --global --add safe.directory /opt/bestcode-cp

echo "Limpando alterações locais e baixando última versão do GitHub..."
git fetch --all
git reset --hard origin/main

# Função para rodar npm install apenas se package.json ou package-lock.json mudaram
run_npm_install_if_needed() {
  local dir=$1
  cd "/opt/bestcode-cp/$dir" || return
  
  local hash_file=".package_hash"
  local current_hash
  current_hash=$(sha256sum package.json package-lock.json 2>/dev/null || md5sum package.json package-lock.json 2>/dev/null || echo "none")

  if [ -d "node_modules" ] && [ -f "$hash_file" ] && [ "$(cat "$hash_file")" = "$current_hash" ]; then
    echo "Dependências de $dir já estão na versão correta. Pulando npm install..."
  else
    echo "Instalando dependências de $dir..."
    npm install --prefer-offline --no-audit --no-fund --omit=dev
    echo "$current_hash" > "$hash_file"
  fi
}

run_npm_install_if_needed "backend"
run_npm_install_if_needed "daemon"

echo "Reiniciando serviços do painel..."
if systemctl list-units --type=service | grep -q "bestcode-cp.service"; then
  echo "Reiniciando serviços via Systemd..."
  systemctl daemon-reload
  systemctl restart bestcode-cp
  systemctl restart bestcode-cp-daemon || true
else
  echo "Systemd não encontrado ou serviço inativo. Tentando reiniciar via PM2..."
  pm2 restart all || true
fi

echo "Atualização concluída com sucesso!"
