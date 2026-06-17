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

# Provisionamento de infraestrutura para instalações existentes (corre como root)
echo "Verificando infraestrutura (SSL personalizado e rota /login)..."

# Garante a pasta de certificados SSL personalizados (ex: Cloudflare Origin Certificate)
mkdir -p /etc/ssl/bestcode
chown -R root:bcp /etc/ssl/bestcode
chmod -R 770 /etc/ssl/bestcode

# Garante a extensão php-redis (necessária para o SSO do phpMyAdmin ler o token no Redis)
if ! php -m 2>/dev/null | grep -qi '^redis$'; then
  echo "Instalando extensão php-redis..."
  apt-get install -y php-redis || true
  systemctl restart "$(basename "$(ls /lib/systemd/system/php*-fpm.service 2>/dev/null | head -n 1)" .service)" 2>/dev/null || true
fi

# Re-aplica o script de SSO do phpMyAdmin (vive fora do repositório, em /usr/share/phpmyadmin)
if [ -d /usr/share/phpmyadmin ] && [ -f /opt/bestcode-cp/scripts/phpmyadmin-signon.php ]; then
  echo "Atualizando script de SSO do phpMyAdmin..."
  cp /opt/bestcode-cp/scripts/phpmyadmin-signon.php /usr/share/phpmyadmin/signon.php
  chmod 644 /usr/share/phpmyadmin/signon.php
fi

# Corrige instalações antigas: adiciona a rota limpa /login ao Nginx do painel se faltar
# (evita o ciclo de redireccionamento infinito / flicker na página de login)
PANEL_NGINX="/etc/nginx/sites-available/bestcode-cp"
if [ -f "$PANEL_NGINX" ] && ! grep -q "location = /login" "$PANEL_NGINX"; then
  echo "Aplicando correção da rota /login no Nginx do painel..."
  sed -i '/location \/ {/i\    # Clean login path\n    location = /login {\n        try_files /login.html =404;\n    }\n    location = /login.html {\n        return 301 /login;\n    }\n' "$PANEL_NGINX"
  if nginx -t; then
    systemctl reload nginx
  else
    echo "[AVISO] nginx -t falhou após a correção do /login. Verifica $PANEL_NGINX manualmente."
  fi
fi

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
