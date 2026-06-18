#!/bin/bash

# ==============================================================================
# SCRIPT DE INSTALAÇÃO AUTOMÁTICA DO BESTCODE CONTROL PANEL (BCP)
# SISTEMA OPERACIONAL RECOMENDADO: Ubuntu 22.04 LTS / 24.04 LTS ou Debian 12
# ==============================================================================

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0;m' # Exporta frontend não-interativo para evitar popups de debconf bloqueantes
export DEBIAN_FRONTEND=noninteractive

# Verifica se está rodando como root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ERRO] Este script deve ser executado como ROOT (use sudo).${NC}"
  exit 1
fi

echo -e "${BLUE}==================================================================${NC}"
echo -e "${BLUE}🚀 INICIANDO INSTALAÇÃO DO BESTCODE CONTROL PANEL (BCP)${NC}"
echo -e "${BLUE}==================================================================${NC}"

# 1. Atualização do Sistema e Dependências Base
echo -e "${YELLOW}[1/9] Atualizando pacotes do sistema...${NC}"
apt update && apt upgrade -y

# 2. Adicionando Repositórios Extras e Dependências
echo -e "${YELLOW}[2/9] Configurando repositórios extras (PHP Sury, NodeSource)...${NC}"
if [ -f /etc/debian_version ]; then
  # Debian: Não instala software-properties-common (específico do Ubuntu)
  apt install -y build-essential curl wget git unzip zip ca-certificates gnupg lsb-release net-tools cron ufw fail2ban sqlite3
  
  echo -e "Configurando repositório PHP Sury para Debian..."
  curl -sSL https://packages.sury.org/php/apt.gpg -o /etc/apt/trusted.gpg.d/sury-php.gpg
  CODENAME=$(lsb_release -sc 2>/dev/null)
  if [ -z "$CODENAME" ]; then
    CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  fi
  if [ -z "$CODENAME" ]; then
    CODENAME="bookworm"
  fi
  echo "deb https://packages.sury.org/php/ $CODENAME main" > /etc/apt/sources.list.d/sury-php.list
else
  # Ubuntu: Instala software-properties-common para add-apt-repository
  apt install -y build-essential curl wget git unzip zip ca-certificates gnupg lsb-release software-properties-common net-tools cron ufw fail2ban sqlite3
  
  echo -e "Configurando repositório PHP Ondrej para Ubuntu..."
  add-apt-repository -y ppa:ondrej/php
fi

# Configurar repositório NodeSource v20 LTS
echo -e "Configurando repositório NodeSource v20 LTS..."
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list

apt update

# Instalar Runtimes & Banco de Dados
echo -e "${YELLOW}Instalando Runtimes (Node.js, Python 3) e Banco de Dados (MariaDB)...${NC}"
apt install -y nodejs mariadb-server mariadb-client python3 python3-pip python3-venv

# Instalar PM2 globalmente
npm install -g pm2

# Instalar Nginx e PHP (8.1 / 8.2 / 8.3) multi-versões
echo -e "${YELLOW}Instalando Nginx, PHP (8.1, 8.2, 8.3) e extensões...${NC}"
apt install -y nginx

for v in 8.1 8.2 8.3; do
  apt install -y \
    php$v-fpm php$v-cli php$v-common php$v-mysql php$v-curl \
    php$v-gd php$v-mbstring php$v-xml php$v-zip php$v-bcmath \
    php$v-intl php$v-soap php$v-imagick php$v-opcache php$v-readline php$v-redis
done

# Instalar Composer
echo -e "${YELLOW}Instalando PHP Composer...${NC}"
curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# Instalar Servidores de Cache
echo -e "${YELLOW}Instalando Redis e Memcached...${NC}"
apt install -y redis-server memcached php-memcached php-redis

# Instalar Certbot (SSL Let's Encrypt)
echo -e "${YELLOW}Instalando Certbot para Nginx...${NC}"
apt install -y certbot python3-certbot-nginx

# Instalar Servidor DNS (PowerDNS com backend MySQL)
echo -e "${YELLOW}Instalando PowerDNS com MySQL backend...${NC}"
DEBIAN_FRONTEND=noninteractive apt install -y pdns-server pdns-backend-mysql

# Instalar Servidor de E-mail completo (Postfix, Dovecot, OpenDKIM, OpenDMARC, Rspamd)
echo -e "${YELLOW}Instalando Servidor de E-mail (Postfix, Dovecot, OpenDKIM, OpenDMARC, Rspamd)...${NC}"
DEBIAN_FRONTEND=noninteractive apt install -y \
  postfix postfix-mysql postfix-sqlite \
  dovecot-core dovecot-imapd dovecot-pop3d dovecot-lmtpd dovecot-sqlite dovecot-mysql \
  opendkim opendkim-tools opendmarc \
  rspamd

# Instalar Webmail (Roundcube)
echo -e "${YELLOW}Instalando Webmail Roundcube...${NC}"
DEBIAN_FRONTEND=noninteractive apt install -y roundcube roundcube-mysql roundcube-plugins

# Instalar Servidor FTP (Pure-FTPd com backend MySQL)
echo -e "${YELLOW}Instalando Pure-FTPd com MySQL...${NC}"
DEBIAN_FRONTEND=noninteractive apt install -y pure-ftpd-mysql

# Instalar utilitários de Backup (BorgBackup, Restic)
echo -e "${YELLOW}Instalando BorgBackup e Restic...${NC}"
apt install -y borgbackup restic

# 3. Configurando Diretórios do BestCode CP
echo -e "${YELLOW}[3/9] Configurando arquivos do BestCode CP...${NC}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(dirname "$SCRIPT_DIR")"

mkdir -p /opt/bestcode-cp

if [ -d "$PARENT_DIR/.git" ]; then
  echo -e "Copiando repositório Git existente para /opt/bestcode-cp..."
  # Copia todo o conteúdo incluindo o diretório oculto .git
  cp -r "$PARENT_DIR/." /opt/bestcode-cp/
else
  echo -e "Clonando repositório Git em /opt/bestcode-cp..."
  git clone https://github.com/Crazed0/bestcode-cp.git /opt/bestcode-cp
fi

# Torna os scripts utilitários executáveis
chmod +x /opt/bestcode-cp/scripts/update.sh
chmod +x /opt/bestcode-cp/scripts/setup-panel-domain.sh

# Garante que o Git aceita o diretório como confiável para atualizações do root
git config --global --add safe.directory /opt/bestcode-cp

# 3. Criação do utilizador bcp e configuração de permissões
echo -e "${YELLOW}Configurando utilizador bcp e permissões restritas...${NC}"
id -u bcp &>/dev/null || useradd -r -m -s /bin/bash bcp
usermod -aG docker bcp 2>/dev/null || true

# Permite que o utilizador bcp configure o Nginx e o web root
mkdir -p /var/www
chown -R root:bcp /var/www
chmod -R 775 /var/www

mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
chown -R root:bcp /etc/nginx/sites-available /etc/nginx/sites-enabled
chmod -R 775 /etc/nginx/sites-available /etc/nginx/sites-enabled

# Diretório para certificados SSL personalizados (ex: Cloudflare Origin Certificate).
# Acessível ao grupo bcp para escrita, fechado a outros para proteger as chaves privadas.
mkdir -p /etc/ssl/bestcode
chown -R root:bcp /etc/ssl/bestcode
chmod -R 770 /etc/ssl/bestcode

# Configura regras sudoers exclusivas para o utilizador bcp (segurança reforçada)
cat <<EOF > /etc/sudoers.d/bestcode-cp
bcp ALL=(ALL) NOPASSWD: /usr/sbin/ufw, /sbin/ufw, /usr/bin/fail2ban-client, /usr/bin/certbot, /usr/bin/systemctl, /bin/systemctl, /usr/sbin/nginx, /usr/bin/mysql, /usr/bin/mariadb, /usr/bin/chown, /bin/chown, /usr/bin/rm, /bin/rm, /usr/bin/crontab, /usr/bin/ln, /bin/ln, /bin/bash, /usr/bin/bash, /usr/bin/pkill, /bin/pkill, /bin/kill, /usr/bin/kill, /usr/bin/systemd-run, /bin/systemd-run, /opt/bestcode-cp/scripts/update.sh
EOF
chmod 440 /etc/sudoers.d/bestcode-cp

# Ajustando permissões do diretório do painel
chown -R bcp:bcp /opt/bestcode-cp
chmod -R 755 /opt/bestcode-cp
chmod -R 700 /opt/bestcode-cp/backend
chmod -R 700 /opt/bestcode-cp/daemon
git config --global --add safe.directory /opt/bestcode-cp

# 4. Instalando dependências do Backend e do Daemon
echo -e "${YELLOW}[4/9] Instalando dependências da API do Painel e do Daemon...${NC}"
cd /opt/bestcode-cp/backend
npm install --prefer-offline --no-audit --no-fund --omit=dev

echo -e "Instalando dependências do Wings Daemon..."
cd /opt/bestcode-cp/daemon
npm install --prefer-offline --no-audit --no-fund --omit=dev

# 5. Instalação e Configuração do phpMyAdmin com Autologin (SSO)
echo -e "${YELLOW}[5/9] Instalando e configurando o phpMyAdmin...${NC}"
PMA_VERSION="5.2.1"
wget https://files.phpmyadmin.net/phpMyAdmin/${PMA_VERSION}/phpMyAdmin-${PMA_VERSION}-all-languages.zip -O /tmp/pma.zip
# Remove pastas residuais de tentativas anteriores para evitar conflitos de caminhos ou prompts
rm -rf /usr/share/phpMyAdmin-${PMA_VERSION}-all-languages
rm -rf /usr/share/phpmyadmin
unzip -o -q /tmp/pma.zip -d /usr/share/
mv /usr/share/phpMyAdmin-${PMA_VERSION}-all-languages /usr/share/phpmyadmin
rm -f /tmp/pma.zip

# Gera o caminho aleatório do phpMyAdmin
PMA_SUFFIX=$(openssl rand -hex 4)
PMA_PATH="/pma-${PMA_SUFFIX}"

# Cria pasta temporária para o phpMyAdmin
mkdir -p /usr/share/phpmyadmin/tmp
chmod 777 /usr/share/phpmyadmin/tmp

# Configura o config.inc.php do phpMyAdmin para SSO (Signon)
cat <<EOF > /usr/share/phpmyadmin/config.inc.php
<?php
\$cfg['blowfish_secret'] = '$(openssl rand -hex 16)';
\$i = 0;
\$i++;
\$cfg['Servers'][\$i]['auth_type'] = 'signon';
\$cfg['Servers'][\$i]['SignonSession'] = 'BestCodeSignonSession';
\$cfg['Servers'][\$i]['SignonURL'] = '${PMA_PATH}/signon.php';
\$cfg['Servers'][\$i]['host'] = '127.0.0.1';
\$cfg['Servers'][\$i]['compress'] = false;
\$cfg['Servers'][\$i]['AllowNoPassword'] = false;
\$cfg['UploadDir'] = '';
\$cfg['SaveDir'] = '';
EOF

# Copia o script phpmyadmin-signon.php para a pasta do phpMyAdmin
cp /opt/bestcode-cp/scripts/phpmyadmin-signon.php /usr/share/phpmyadmin/signon.php
chmod 644 /usr/share/phpmyadmin/signon.php

# 6. Configuração do Nginx (Servidor Web Principal)
echo -e "${YELLOW}[6/9] Configurando o Nginx...${NC}"

# Cria arquivo de bloco de servidor Nginx para o phpMyAdmin global com alias aleatório
cat <<EOF > /etc/nginx/snippets/phpmyadmin.conf
location ${PMA_PATH} {
    alias /usr/share/phpmyadmin/;
    index index.php index.html index.htm;
    location ~ ^${PMA_PATH}/(.+\.php)$ {
        alias /usr/share/phpmyadmin/\$1;
        fastcgi_pass unix:/run/php/php-fpm.sock;
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME \$request_filename;
        include fastcgi_params;
    }
    location ~* ^${PMA_PATH}/(.+\.(jpg|jpeg|gif|css|png|js|ico|html|xml|txt))$ {
        alias /usr/share/phpmyadmin/\$1;
    }
}
EOF

# Cria arquivo de bloco de servidor Nginx para o Roundcube Webmail global (/webmail)
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

# Inicia serviço FPM se necessário para gerar o socket
systemctl start php8.3-fpm php8.2-fpm php8.1-fpm 2>/dev/null || systemctl start php-fpm 2>/dev/null || true
PHP_FPM_SOCK=$(ls /run/php/php*-fpm.sock 2>/dev/null | head -n 1 || echo "")
if [ -n "$PHP_FPM_SOCK" ]; then
    echo -e "FPM Socket encontrado: $PHP_FPM_SOCK"
    sed -i "s|fastcgi_pass unix:/run/php/php-fpm.sock;|fastcgi_pass unix:$PHP_FPM_SOCK;|" /etc/nginx/snippets/phpmyadmin.conf
    sed -i "s|fastcgi_pass unix:/run/php/php-fpm.sock;|fastcgi_pass unix:$PHP_FPM_SOCK;|" /etc/nginx/snippets/roundcube.conf 2>/dev/null || true
else
    echo -e "AVISO: Socket PHP-FPM não foi encontrado."
fi

# Cria a configuração do bloco do Nginx do BestCode CP (Porta 80 e proxy reverso da API)
cat <<EOF > /etc/nginx/sites-available/bestcode-cp
server {
    listen 80;
    server_name _; # Responde a qualquer IP ou domínio apontado

    # Oculta versão do Nginx nos cabeçalhos de resposta
    server_tokens off;

    # Cabeçalhos de Segurança (Security Headers)
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://accounts.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https://lh3.googleusercontent.com; connect-src 'self' ws: wss: https://api.github.com https://raw.githubusercontent.com; frame-src 'self' https://accounts.google.com;" always;

    root /opt/bestcode-cp/frontend;
    index index.html;

    include snippets/phpmyadmin.conf;
    include snippets/roundcube.conf;

    # Backend API e WebSocket Proxy
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

    # Redireciona acessos diretos a .html no browser para URL limpa (evita loop interno)
    if (\$request_uri ~* "/login\.html") {
        return 301 /login;
    }

    # Clean login path
    location = /login {
        try_files /login.html =404;
    }

    # Tratamento para SPA (redireciona rotas para o index.html)
    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF

# Ativa o painel no Nginx e desativa o default antigo
ln -sf /etc/nginx/sites-available/bestcode-cp /etc/nginx/sites-enabled/bestcode-cp
rm -f /etc/nginx/sites-enabled/default

# Gera segredo aleatório do Daemon (segurança reforçada)
DAEMON_SECRET=$(openssl rand -base64 24 | tr -d '/+=')

# 7. Configuração dos Serviços Systemd do Painel e Daemon
echo -e "${YELLOW}[7/9] Configurando serviços systemd do Painel e Daemon (Wings)...${NC}"
cat <<EOF > /etc/systemd/system/bestcode-cp.service
[Unit]
Description=BestCode Control Panel Backend Agent
After=network.target mariadb.service nginx.service

[Service]
Type=simple
User=bcp
WorkingDirectory=/opt/bestcode-cp/backend
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
Environment=NODE_ENV=production PORT=3000 JWT_SECRET=$(openssl rand -base64 32) PMA_PATH=${PMA_PATH}
# Ficheiro de overrides por instalação (opcional). Permite definir, p.ex.,
# GOOGLE_CLIENT_ID=... sem editar este unit. O '-' torna-o opcional.
EnvironmentFile=-/opt/bestcode-cp/backend/bcp.env

[Install]
WantedBy=multi-user.target
EOF

# Cria um template de overrides por instalação, se ainda não existir
if [ ! -f /opt/bestcode-cp/backend/bcp.env ]; then
  cat <<'ENVEOF' > /opt/bestcode-cp/backend/bcp.env
# Overrides de ambiente do BestCode CP (carregado pelo systemd).
# Descomenta e define o teu próprio Google OAuth Client ID, registado para o
# teu domínio na Google Cloud Console (Authorized JavaScript origins).
# GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
ENVEOF
  chown bcp:bcp /opt/bestcode-cp/backend/bcp.env
  chmod 640 /opt/bestcode-cp/backend/bcp.env
fi

cat <<EOF > /etc/systemd/system/bestcode-cp-daemon.service
[Unit]
Description=BestCode Control Panel Daemon Agent (Wings)
After=network.target docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/bestcode-cp/daemon
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
Environment=NODE_ENV=production DAEMON_PORT=8080 DAEMON_SECRET=${DAEMON_SECRET}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable bestcode-cp
systemctl start bestcode-cp

systemctl enable bestcode-cp-daemon
systemctl start bestcode-cp-daemon

# 8. Configuração de Postfix e Dovecot com SQLite Virtual Maps
echo -e "${YELLOW}[8/9] Configurando Integração de E-mail com SQLite...${NC}"

# Cria o grupo e o utilizador vmail (virtual mail) com UID/GID 5000 se não existirem
groupadd -g 5000 vmail 2>/dev/null || true
useradd -r -g vmail -u 5000 -d /var/mail/vhosts -m -s /usr/sbin/nologin vmail 2>/dev/null || true

# Garante diretórios e permissões das caixas de e-mail virtuais
mkdir -p /var/mail/vhosts
chown -R vmail:vmail /var/mail/vhosts
chmod -R 770 /var/mail/vhosts

# Adiciona os utilizadores do Postfix e Dovecot ao grupo bcp para que possam ler/escrever a base de dados
usermod -aG bcp postfix 2>/dev/null || true
usermod -aG bcp dovecot 2>/dev/null || true

# Ajusta permissões de leitura/escrita do diretório backend e base de dados para o grupo bcp (para suportar WAL)
chown -R bcp:bcp /opt/bestcode-cp/backend
chmod 770 /opt/bestcode-cp/backend
chmod 660 /opt/bestcode-cp/backend/database.db 2>/dev/null || true
chmod 660 /opt/bestcode-cp/backend/database.db-wal 2>/dev/null || true
chmod 660 /opt/bestcode-cp/backend/database.db-shm 2>/dev/null || true

# Configura o Postfix para ler os domínios virtuais do SQLite
cat <<EOF > /etc/postfix/sqlite-virtual-mailbox-domains.cf
dbpath = /opt/bestcode-cp/backend/database.db
query = SELECT 1 FROM sites WHERE domain='%s'
EOF

# Configura o Postfix para mapear caixas de e-mail ativas do SQLite
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
postconf -e "inet_interfaces = all"
postconf -e "inet_protocols = all"
postconf -e "myhostname = $(hostname -f 2>/dev/null || hostname || echo localhost)"

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

# Cria arquivo de configuração personalizada para LMTP, SASL e Pastas Automáticas do Dovecot
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

# Configura SMTP e IMAP do Roundcube para usar o Postfix/Dovecot locais
if [ -f /etc/roundcube/config.inc.php ]; then
  echo -e "${YELLOW}Configurando SMTP/IMAP no Roundcube...${NC}"
  # Limpa configurações antigas do BCP se existirem
  sed -i '/\/\/ BCP Mail Server Integration/Q' /etc/roundcube/config.inc.php
  # Remove a tag de fecho do PHP se existir no fim do ficheiro para podermos anexar com segurança
  sed -i 's/?>//g' /etc/roundcube/config.inc.php
  
  cat <<'EOF' >> /etc/roundcube/config.inc.php

// BCP Mail Server Integration
$config['imap_host'] = '127.0.0.1:143';
$config['smtp_host'] = '127.0.0.1:25';
$config['smtp_user'] = '%u';
$config['smtp_pass'] = '%p';
$config['imap_conn_options'] = array(
  'ssl' => array(
    'verify_peer'       => false,
    'verify_peer_name'  => false,
    'allow_self_signed' => true,
  ),
);
$config['smtp_conn_options'] = array(
  'ssl' => array(
    'verify_peer'       => false,
    'verify_peer_name'  => false,
    'allow_self_signed' => true,
  ),
);
EOF
fi

# 9. Firewall (UFW) e Fail2ban
echo -e "${YELLOW}[9/9] Configurando Segurança e Firewall (UFW)...${NC}"
ufw default deny incoming
ufw default allow outgoing
ufw allow in on lo    # Permitir tráfego na interface local (loopback)
ufw allow 22/tcp      # SSH
ufw allow 80/tcp      # HTTP (Nginx/Painel)
ufw allow 443/tcp     # HTTPS (Nginx/Painel SSL)
ufw allow 25/tcp      # SMTP (E-mail envio)
ufw allow 587/tcp     # SMTP seguro
ufw allow 993/tcp     # IMAP SSL (E-mail recebimento)
ufw allow 3306/tcp    # MariaDB/MySQL
ufw --force enable

# Garante que o MariaDB/MySQL aceita conexões remotas
echo -e "${YELLOW}Configurando MariaDB/MySQL para conexões remotas...${NC}"
mkdir -p /etc/mysql/mariadb.conf.d /etc/mysql/conf.d
cat <<EOF > /etc/mysql/mariadb.conf.d/99-bcp-mysql.cnf
[mysqld]
bind-address = 0.0.0.0
EOF
cat <<EOF > /etc/mysql/conf.d/99-bcp-mysql.cnf
[mysqld]
bind-address = 0.0.0.0
EOF

# Reinicia todos os serviços
echo -e "${YELLOW}Reiniciando serviços...${NC}"
systemctl restart nginx
systemctl restart mariadb
systemctl restart postfix
systemctl restart dovecot
systemctl restart bestcode-cp || true
systemctl restart bestcode-cp-daemon || true
PHP_SERVICE=$(basename $(ls /lib/systemd/system/php*-fpm.service | head -n 1) .service 2>/dev/null || echo "")
if [ -n "$PHP_SERVICE" ]; then
    systemctl restart $PHP_SERVICE
fi

# Aguarda o painel arrancar e semear o admin (poll em vez de sleep fixo).
# Avança assim que as credenciais estiverem prontas; teto de segurança de 60s
# para servidores lentos, evitando "credenciais inválidas" logo após instalar.
FIRST_BOOT_FILE="/opt/bestcode-cp/first-boot.txt"
echo -e "${YELLOW}Aguardando o painel iniciar e gerar as credenciais...${NC}"
for i in $(seq 1 60); do
  if [ -f "$FIRST_BOOT_FILE" ] && grep -q "PASSWORD:" "$FIRST_BOOT_FILE" 2>/dev/null; then
    echo -e "${GREEN}Painel pronto (após ${i}s).${NC}"
    break
  fi
  sleep 1
done

# Garante permissões restritas e seguras nos ficheiros criados
chmod 660 /opt/bestcode-cp/backend/database.db 2>/dev/null || true
chown bcp:bcp /opt/bestcode-cp/backend/database.db 2>/dev/null || true
chmod 600 /opt/bestcode-cp/first-boot.txt 2>/dev/null || true
chown bcp:bcp /opt/bestcode-cp/first-boot.txt 2>/dev/null || true

# Salva a chave secreta do Daemon Wings num ficheiro seguro do root
echo "$DAEMON_SECRET" > /opt/bestcode-cp/daemon-secret.txt
chmod 600 /opt/bestcode-cp/daemon-secret.txt

# Desativa o Debian Banner no SSH para evitar fuga de informação
if [ -f /etc/ssh/sshd_config ]; then
  echo "Desativando o DebianBanner no SSH..."
  if grep -q "^#DebianBanner" /etc/ssh/sshd_config || grep -q "^DebianBanner" /etc/ssh/sshd_config; then
    sed -i 's/^#*DebianBanner.*/DebianBanner no/' /etc/ssh/sshd_config
  else
    echo "DebianBanner no" >> /etc/ssh/sshd_config
  fi
  systemctl restart ssh || systemctl restart sshd || true
fi

ROOT_PASSWORD="Falha ao carregar senha gerada automaticamente."

if [ -f "$FIRST_BOOT_FILE" ]; then
  ROOT_PASSWORD=$(grep "PASSWORD:" "$FIRST_BOOT_FILE" | cut -d' ' -f2)
fi

# Obtém o IP público ou local para exibição
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
PUBLIC_IP=$(curl -s --max-time 3 https://api.ipify.org || curl -s --max-time 3 https://ifconfig.me || wget -qO- --timeout=3 https://api.ipify.org 2>/dev/null || echo "")

DISPLAY_IP="${PUBLIC_IP:-$LOCAL_IP}"
if [ -z "$DISPLAY_IP" ]; then
  DISPLAY_IP="127.0.0.1"
fi

echo -e "${GREEN}==================================================================${NC}"
echo -e "${GREEN}🎉 BESTCODE CONTROL PANEL INSTALADO COM SUCESSO!${NC}"
echo -e "${GREEN}==================================================================${NC}"
echo -e "Você já pode aceder ao seu painel via navegador através do IP do servidor:"
if [ -n "$PUBLIC_IP" ] && [ -n "$LOCAL_IP" ] && [ "$PUBLIC_IP" != "$LOCAL_IP" ]; then
  echo -e "${BLUE}http://${DISPLAY_IP}/${NC}  (Local: ${BLUE}http://${LOCAL_IP}/${NC})"
else
  echo -e "${BLUE}http://${DISPLAY_IP}/${NC}"
fi
echo -e ""
echo -e "🔑 CREDENCIAIS DO ADMINISTRADOR INICIAL:"
echo -e "👤 Utilizador: ${GREEN}root${NC}"
echo -e "🔒 Palavra-passe: ${GREEN}${ROOT_PASSWORD}${NC}"
echo -e ""
echo -e "🛡️  CHAVES DE SEGURANÇA GERADAS (COPIE E GUARDE):"
echo -e "🔑 Wings Daemon Secret: ${YELLOW}${DAEMON_SECRET}${NC}"
echo -e "🌐 phpMyAdmin Alias (Aleatório): ${YELLOW}${PMA_PATH}${NC}"
echo -e "*(Salvo e protegido no servidor em /opt/bestcode-cp/daemon-secret.txt)*"
echo -e ""
echo -e "🚀 DOMÍNIO PERSONALIZADO & SSL:"
echo -e "Para configurar um domínio e ativar SSL (HTTPS) no próprio painel, execute:"
echo -e "👉 ${GREEN}sudo bash /opt/bestcode-cp/scripts/setup-panel-domain.sh seu-dominio.com${NC}"
echo -e ""
echo -e "⚠️  IMPORTANT: Configure o Google 2FA na aba de Utilizadores para máxima segurança."
echo -e "O phpMyAdmin está integrado e acessível direto pelo painel de Banco de Dados."
echo -e "=================================================================="
