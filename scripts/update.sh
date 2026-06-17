#!/bin/bash
# scripts/update.sh
# Script de auto-atualização do BestCode Control Panel (BCP)

# Se não estiver a correr a cópia do /tmp, e não for apenas atualização do Nginx, copia e executa a partir do /tmp
# Isso previne que o script seja modificado em disco enquanto corre (problema comum no git reset/pull)
if [ "$1" != "--stage2" ] && [ "$1" != "--nginx-only" ]; then
  TMP_SCRIPT="/tmp/bcp_update_$(date +%s).sh"
  cp "$0" "$TMP_SCRIPT"
  chmod +x "$TMP_SCRIPT"
  exec "$TMP_SCRIPT" --stage2 "$@"
fi

# Direciona todo output para arquivo de log, exceto se for apenas configuração do Nginx
if [ "$1" != "--nginx-only" ]; then
  LOG_FILE="/opt/bestcode-cp/backend/temp/update.log"
  mkdir -p /opt/bestcode-cp/backend/temp
  exec > >(tee -ia "$LOG_FILE") 2>&1
fi

# Se for apenas Nginx, pula as etapas de atualização de código e npm install
if [ "$1" != "--nginx-only" ]; then
  echo "Iniciando atualização do BestCode CP..."
  
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

  # Garante pacotes necessários de e-mail e webmail (postfix-sqlite, roundcube)
  if ! dpkg -s postfix-sqlite >/dev/null 2>&1 || ! dpkg -s roundcube-core >/dev/null 2>&1; then
    echo "Instalando pacotes de e-mail e Roundcube Webmail..."
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y postfix-sqlite roundcube roundcube-mysql roundcube-plugins || true
  fi

  # Cria o grupo e o utilizador vmail (virtual mail) com UID/GID 5000 se não existirem
  if ! getent group vmail >/dev/null; then
    groupadd -g 5000 vmail || true
  fi
  if ! getent passwd vmail >/dev/null; then
    useradd -r -g vmail -u 5000 -d /var/mail/vhosts -m -s /usr/sbin/nologin vmail || true
  fi

  # Garante diretórios e permissões das caixas de e-mail virtuais
  mkdir -p /var/mail/vhosts
  chown -R vmail:vmail /var/mail/vhosts
  chmod -R 770 /var/mail/vhosts

  # Adiciona os utilizadores do Postfix e Dovecot ao grupo bcp para que possam aceder à base de dados SQLite do painel
  usermod -aG bcp postfix 2>/dev/null || true
  usermod -aG bcp dovecot 2>/dev/null || true

  # Ajusta permissões de leitura/escrita do diretório backend e base de dados para o grupo bcp (para suportar WAL)
  chown -R bcp:bcp /opt/bestcode-cp/backend
  chmod 770 /opt/bestcode-cp/backend
  chmod 660 /opt/bestcode-cp/backend/database.db 2>/dev/null || true
  chmod 660 /opt/bestcode-cp/backend/database.db-wal 2>/dev/null || true
  chmod 660 /opt/bestcode-cp/backend/database.db-shm 2>/dev/null || true

  # Configura virtual maps do Postfix com SQLite
  cat <<EOF > /etc/postfix/sqlite-virtual-mailbox-domains.cf
dbpath = /opt/bestcode-cp/backend/database.db
query = SELECT 1 FROM sites WHERE domain='%s'
EOF

  cat <<EOF > /etc/postfix/sqlite-virtual-mailbox-maps.cf
dbpath = /opt/bestcode-cp/backend/database.db
query = SELECT 1 FROM emails WHERE email_address='%s'
EOF

  # Aplica parâmetros essenciais no /etc/postfix/main.cf (inclui SASL Auth via Dovecot e LMTP)
  postconf -e "virtual_mailbox_domains = sqlite:/etc/postfix/sqlite-virtual-mailbox-domains.cf"
  postconf -e "virtual_mailbox_maps = sqlite:/etc/postfix/sqlite-virtual-mailbox-maps.cf"
  postconf -e "virtual_transport = lmtp:unix:private/dovecot-lmtp"
  postconf -e "smtpd_sasl_type = dovecot"
  postconf -e "smtpd_sasl_path = private/auth"
  postconf -e "smtpd_sasl_auth_enable = yes"
  postconf -e "smtpd_recipient_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination"

  # Configura o Dovecot para autenticar com base no banco do BestCode CP
  cat <<EOF > /etc/dovecot/dovecot-sqlite.conf.ext
driver = sqlite
connect = /opt/bestcode-cp/backend/database.db
default_pass_scheme = BLF-CRYPT
password_query = SELECT email_address as user, password FROM emails WHERE email_address='%u'
user_query = SELECT '/var/mail/vhosts/'||domain||'/'||email_address as home, 'maildir:/var/mail/vhosts/'||domain||'/'||email_address||'/Maildir' as mail, 5000 as uid, 5000 as gid FROM emails WHERE email_address='%u'
EOF

  # Habilita o SQLite nas configurações de autenticação do Dovecot
  sed -i 's/#!include auth-sql.conf.ext/!include auth-sql.conf.ext/' /etc/dovecot/conf.d/10-auth.conf 2>/dev/null || true
  sed -i 's/!include auth-system.conf.ext/#!include auth-system.conf.ext/' /etc/dovecot/conf.d/10-auth.conf 2>/dev/null || true

  cat <<EOF > /etc/dovecot/conf.d/auth-sql.conf.ext
passdb {
  driver = sql
  args = /etc/dovecot/dovecot-sqlite.conf.ext
}
userdb {
  driver = sql
  args = /etc/dovecot/dovecot-sqlite.conf.ext
}
EOF

  # Cria o arquivo de configuração personalizada para LMTP, SASL e Pastas Automáticas do Dovecot
  cat <<EOF > /etc/dovecot/conf.d/99-bcp-mail.conf
# Configurações do BCP para LMTP, Autenticação SASL e Pastas de E-mail

service lmtp {
  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    mode = 0660
    group = postfix
    user = postfix
  }
}

service auth {
  unix_listener /var/spool/postfix/private/auth {
    mode = 0660
    group = postfix
    user = postfix
  }
}

namespace inbox {
  inbox = yes
  
  mailbox Drafts {
    special_use = \\Drafts
    auto = subscribe
  }
  mailbox Junk {
    special_use = \\Junk
    auto = subscribe
  }
  mailbox Trash {
    special_use = \\Trash
    auto = subscribe
  }
  mailbox Sent {
    special_use = \\Sent
    auto = subscribe
  }
  mailbox "Sent Messages" {
    special_use = \\Sent
  }
}
EOF

  # Reinicia os serviços de e-mail para aplicar as alterações
  systemctl restart postfix dovecot || true
fi

# Corrige e atualiza a configuração do Nginx do painel com cabeçalhos de segurança e sem loops (de forma dinâmica)
PANEL_NGINX="/etc/nginx/sites-available/bestcode-cp"
if [ -f "$PANEL_NGINX" ]; then
  echo "Atualizando a configuração do Nginx do painel com cabeçalhos de segurança e correção de loops..."
  
  # Garanta que o snippet do Roundcube existe e está correto
  cat <<EOF > /etc/nginx/snippets/roundcube.conf
location /webmail/ {
    alias /var/lib/roundcube/;
    index index.php index.html index.htm;
    location ~ ^/webmail/(config|temp|logs)/ {
        deny all;
    }
    location ~ ^/webmail/(.+\.php)$ {
        alias /var/lib/roundcube/\$1;
        fastcgi_pass unix:/run/php/php-fpm.sock;
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME \$request_filename;
        include fastcgi_params;
    }
    location ~* ^/webmail/(.+\.(jpg|jpeg|gif|css|png|js|ico|html|xml|txt))$ {
        alias /var/lib/roundcube/\$1;
    }
}
location /webmail {
    return 301 /webmail/;
}
location /roundcube {
    return 301 /webmail/;
}
EOF

  # Inicia serviço FPM se necessário para gerar o socket e detecta o socket correto
  PHP_FPM_SOCK=$(ls /run/php/php*-fpm.sock 2>/dev/null | head -n 1)
  if [ -n "$PHP_FPM_SOCK" ]; then
      sed -i "s|fastcgi_pass unix:/run/php/php-fpm.sock;|fastcgi_pass unix:$PHP_FPM_SOCK;|" /etc/nginx/snippets/roundcube.conf 2>/dev/null || true
  fi
  
  # 1. Extrai o domínio (server_name) atual configurado
  CURRENT_DOMAINS=$(grep -E "^\s*server_name" "$PANEL_NGINX" | head -n 1 | sed 's/server_name//g' | tr -d ';')
  CURRENT_DOMAINS=$(echo "$CURRENT_DOMAINS" | xargs) # trim
  # Remove duplicados e ordena domínios para evitar erros no Nginx
  CURRENT_DOMAINS=$(echo "$CURRENT_DOMAINS" | tr ' ' '\n' | sort -u | tr '\n' ' ' | xargs)
  if [ -z "$CURRENT_DOMAINS" ]; then
    CURRENT_DOMAINS="_"
  fi

  # 2. Verifica se o painel tem SSL ativo
  HAS_SSL=false
  if grep -q "listen 443" "$PANEL_NGINX" || grep -q "ssl_certificate" "$PANEL_NGINX"; then
    HAS_SSL=true
  fi

  # 3. Extrai as diretivas SSL existentes para preservar
  SSL_LINES=""
  if [ "$HAS_SSL" = true ]; then
    # Captura todas as linhas com ssl_certificate, ssl_certificate_key, ssl_dhparam, etc.
    SSL_LINES=$(grep -E "^\s*ssl_" "$PANEL_NGINX" | sed 's/^[ \t]*//' | tr -d '\r')
    # Captura também a linha include do Let's Encrypt se existir
    LE_INCLUDE=$(grep -E "options-ssl-nginx.conf" "$PANEL_NGINX" | sed 's/^[ \t]*//' | tr -d '\r')
    if [ -n "$LE_INCLUDE" ]; then
      SSL_LINES="$SSL_LINES"$'\n'"$LE_INCLUDE"
    fi
    # Remove duplicados nas diretivas SSL
    SSL_LINES=$(echo "$SSL_LINES" | sort -u)
  fi

  # 4. Reconstrói o ficheiro Nginx dinamicamente
  if [ "$HAS_SSL" = true ]; then
    # Configuração HTTPS ativa: gera bloco 443 + redirecionador 80
    cat <<EOF > "$PANEL_NGINX"
server {
    listen 443 ssl;
    server_name $CURRENT_DOMAINS;

    # Oculta versão do Nginx nos cabeçalhos de resposta
    server_tokens off;

    # Diretivas SSL preservadas
    $SSL_LINES

    root /opt/bestcode-cp/frontend;
    index index.html;

    # Cabeçalhos de Segurança (Security Headers)
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://accounts.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https://lh3.googleusercontent.com; connect-src 'self' ws: wss: https://api.github.com https://raw.githubusercontent.com; frame-src https://accounts.google.com;" always;

    include snippets/phpmyadmin.conf;
    include snippets/roundcube.conf;

    # Redireciona acessos diretos a .html no browser para URL limpa (evita loop interno)
    if (\$request_uri ~* "/login\.html") {
        return 301 /login;
    }

    # Clean login path (evita cair no SPA e gerar loop de redirecionamento)
    location = /login {
        try_files /login.html =404;
    }

    # Backend API e WebSocket Proxy (sem barra final no proxy_pass)
    location /api {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Tratamento para SPA (redireciona rotas para o index.html)
    location / {
        try_files \$uri \$uri/ /index.html;
    }
}

server {
    listen 80;
    server_name $CURRENT_DOMAINS;

    # Oculta versão do Nginx nos cabeçalhos de resposta
    server_tokens off;

    # Redireciona tráfego HTTP para HTTPS
    if (\$http_x_forwarded_proto = "http") {
        return 301 https://\$host\$request_uri;
    }
    if (\$http_x_forwarded_proto = "") {
        return 301 https://\$host\$request_uri;
    }

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # Para proxy reverso ou tráfego local/interno no porto 80
    root /opt/bestcode-cp/frontend;
    index index.html;

    # Cabeçalhos de Segurança (Security Headers)
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://accounts.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https://lh3.googleusercontent.com; connect-src 'self' ws: wss: https://api.github.com https://raw.githubusercontent.com; frame-src https://accounts.google.com;" always;

    include snippets/phpmyadmin.conf;
    include snippets/roundcube.conf;

    if (\$request_uri ~* "/login\.html") {
        return 301 /login;
    }

    location = /login {
        try_files /login.html =404;
    }

    location /api {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF
  else
    # Configuração HTTP padrão (sem SSL ativo)
    cat <<EOF > "$PANEL_NGINX"
server {
    listen 80;
    server_name $CURRENT_DOMAINS;

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
    include snippets/roundcube.conf;

    # Redireciona acessos diretos a .html no browser para URL limpa (evita loop interno)
    if (\$request_uri ~* "/login\.html") {
        return 301 /login;
    }

    # Clean login path (evita cair no SPA e gerar loop de redirecionamento)
    location = /login {
        try_files /login.html =404;
    }

    # Backend API e WebSocket Proxy (sem barra final no proxy_pass)
    location /api {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Tratamento para SPA (redireciona rotas para o index.html)
    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF
  fi

  if nginx -t; then
    systemctl reload nginx
    echo "Configuração do Nginx atualizada e recarregada com sucesso."
  else
    echo "[AVISO] Configuração do Nginx gerada em $PANEL_NGINX é inválida. Por favor, reveja."
  fi
fi

# Se for apenas a formatação do Nginx, encerra aqui
if [ "$1" = "--nginx-only" ]; then
  exit 0
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

# Remove o script temporário de stage 2 se aplicável
if [ "$1" = "--stage2" ]; then
  rm -f "$0"
fi

echo "Atualização concluída com sucesso!"
