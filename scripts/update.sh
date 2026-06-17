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

# Corrige e atualiza a configuração do Nginx do painel com cabeçalhos de segurança e sem loops
PANEL_NGINX="/etc/nginx/sites-available/bestcode-cp"
if [ -f "$PANEL_NGINX" ]; then
  echo "Atualizando a configuração do Nginx do painel com cabeçalhos de segurança e correção de redirect loop..."
  
  # Extrai o domínio atual configurado no Nginx
  CURRENT_DOMAIN=$(grep -E "server_name" "$PANEL_NGINX" | head -n 1 | awk '{print $2}' | tr -d ';')
  if [ -z "$CURRENT_DOMAIN" ]; then
    CURRENT_DOMAIN="_"
  fi
  
  cat <<EOF > "$PANEL_NGINX"
server {
    listen 80;
    server_name $CURRENT_DOMAIN;

    # Oculta versão do Nginx nos cabeçalhos de resposta
    server_tokens off;

    # Cabeçalhos de Segurança (Security Headers)
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://accounts.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https://lh3.googleusercontent.com; connect-src 'self' ws: wss: https://api.github.com https://raw.githubusercontent.com; frame-src https://accounts.google.com;" always;

    root /opt/bestcode-cp/frontend;
    index index.html;

    include snippets/phpmyadmin.conf;

    # Redireciona acessos diretos a .html no browser para URL limpa (evita loop interno)
    if (\$request_uri ~* "/login\.html") {
        return 301 /login;
    }

    # Clean login path
    location = /login {
        try_files /login.html =404;
    }

    # Backend API e WebSocket Proxy
    location /api {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }

    # Tratamento para SPA (redireciona rotas para o index.html)
    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF

  if nginx -t; then
    systemctl reload nginx
    echo "Nginx recarregado com sucesso."
  else
    echo "[AVISO] Configuração do Nginx gerada em $PANEL_NGINX é inválida. Por favor, reveja."
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
