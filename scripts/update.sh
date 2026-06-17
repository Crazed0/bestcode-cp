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

echo "Instalando dependências do Backend..."
cd backend
npm install --omit=dev

echo "Instalando dependências do Wings Daemon..."
cd ../daemon
npm install --omit=dev

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
