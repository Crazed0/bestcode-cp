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
NC='\033[0;m' # No Color

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
apt install -y build-essential curl wget git unzip zip ca-certificates gnupg lsb-release software-properties-common net-tools cron ufw fail2ban sqlite3

# Adicionar repositório PHP Sury para suporte a multi-versões
if [ -f /etc/debian_version ]; then
  echo -e "Configurando repositório PHP Sury para Debian..."
  curl -sSL https://packages.sury.org/php/apt.gpg -o /etc/apt/trusted.gpg.d/sury-php.gpg
  echo "deb https://packages.sury.org/php/ $(lsb_release -sc) main" > /etc/apt/sources.list.d/sury-php.list
else
  echo -e "Configurando repositório PHP Ondrej para Ubuntu..."
  add-apt-repository -y ppa:ondrej/php
fi

# Configurar repositório NodeSource v20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -

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
apt install -y redis-server memcached php-memcached

# Instalar Certbot (SSL Let's Encrypt)
echo -e "${YELLOW}Instalando Certbot para Nginx...${NC}"
apt install -y certbot python3-certbot-nginx

# Instalar Servidor DNS (PowerDNS com backend MySQL)
echo -e "${YELLOW}Instalando PowerDNS com MySQL backend...${NC}"
DEBIAN_FRONTEND=noninteractive apt install -y pdns-server pdns-backend-mysql

# Instalar Servidor de E-mail completo (Postfix, Dovecot, OpenDKIM, OpenDMARC, Rspamd)
echo -e "${YELLOW}Instalando Servidor de E-mail (Postfix, Dovecot, OpenDKIM, OpenDMARC, Rspamd)...${NC}"
DEBIAN_FRONTEND=noninteractive apt install -y \
  postfix postfix-mysql \
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

# Torna o script de atualização executável
chmod +x /opt/bestcode-cp/scripts/update.sh

# Garante que o Git aceita o diretório como confiável para atualizações do root
git config --global --add safe.directory /opt/bestcode-cp

# Ajustando permissões
chown -R root:root /opt/bestcode-cp
chmod -R 755 /opt/bestcode-cp

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
unzip -q /tmp/pma.zip -d /usr/share/
mv /usr/share/phpMyAdmin-${PMA_VERSION}-all-languages /usr/share/phpmyadmin
rm /tmp/pma.zip

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
\$cfg['Servers'][\$i]['SignonURL'] = '/phpmyadmin/signon.php';
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

# Cria arquivo de bloco de servidor Nginx para o phpMyAdmin global
cat <<EOF > /etc/nginx/snippets/phpmyadmin.conf
location /phpmyadmin {
    alias /usr/share/phpmyadmin/;
    index index.php index.html index.htm;
    location ~ ^/phpmyadmin/(.+\.php)$ {
        alias /usr/share/phpmyadmin/\$1;
        fastcgi_pass unix:/run/php/php-fpm.sock;
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME \$request_filename;
        include fastcgi_params;
    }
    location ~* ^/phpmyadmin/(.+\.(jpg|jpeg|gif|css|png|js|ico|html|xml|txt))$ {
        alias /usr/share/phpmyadmin/\$1;
    }
}
EOF

# Inicia serviço FPM se necessário para gerar o socket
systemctl start php8.2-fpm || systemctl start php-fpm || true
PHP_FPM_SOCK=$(ls /run/php/php*-fpm.sock | head -n 1)
if [ -n "$PHP_FPM_SOCK" ]; then
    echo -e "FPM Socket encontrado: $PHP_FPM_SOCK"
    sed -i "s|fastcgi_pass unix:/run/php/php-fpm.sock;|fastcgi_pass unix:$PHP_FPM_SOCK;|" /etc/nginx/snippets/phpmyadmin.conf
else
    echo -e "AVISO: Socket PHP-FPM não foi encontrado."
fi

# Cria a configuração do bloco do Nginx do BestCode CP (Porta 80 e proxy reverso da API)
cat <<EOF > /etc/nginx/sites-available/bestcode-cp
server {
    listen 80;
    server_name _; # Responde a qualquer IP ou domínio apontado

    root /opt/bestcode-cp/frontend;
    index index.html;

    include snippets/phpmyadmin.conf;

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

# Ativa o painel no Nginx e desativa o default antigo
ln -sf /etc/nginx/sites-available/bestcode-cp /etc/nginx/sites-enabled/bestcode-cp
rm -f /etc/nginx/sites-enabled/default

# 7. Configuração dos Serviços Systemd do Painel e Daemon
echo -e "${YELLOW}[7/9] Configurando serviços systemd do Painel e Daemon (Wings)...${NC}"
cat <<EOF > /etc/systemd/system/bestcode-cp.service
[Unit]
Description=BestCode Control Panel Backend Agent
After=network.target mariadb.service nginx.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/bestcode-cp/backend
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
Environment=NODE_ENV=production PORT=3000 JWT_SECRET=$(openssl rand -base64 32)

[Install]
WantedBy=multi-user.target
EOF

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
Environment=NODE_ENV=production DAEMON_PORT=8080 DAEMON_SECRET=bcp-daemon-node-secret-key-2026

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

# Aplica parâmetros essenciais no /etc/postfix/main.cf
postconf -e "virtual_mailbox_domains = sqlite:/etc/postfix/sqlite-virtual-mailbox-domains.cf"
postconf -e "virtual_mailbox_maps = sqlite:/etc/postfix/sqlite-virtual-mailbox-maps.cf"
postconf -e "virtual_transport = lmtp:unix:private/dovecot-lmtp"

# Configura o Dovecot para autenticar com base no banco do BestCode CP
cat <<EOF > /etc/dovecot/dovecot-sqlite.conf.ext
driver = sqlite
connect = /opt/bestcode-cp/backend/database.db
default_pass_scheme = BLF-CRYPT
password_query = SELECT email_address as user, password FROM emails WHERE email_address='%u'
user_query = SELECT '/var/mail/vhosts/'||domain||'/'||email_address as home, 5000 as uid, 5000 as gid FROM emails WHERE email_address='%u'
EOF

# Habilita o SQLite nas configurações de autenticação do Dovecot
sed -i 's/#!include auth-sql.conf.ext/!include auth-sql.conf.ext/' /etc/dovecot/conf.d/10-auth.conf
sed -i 's/!include auth-system.conf.ext/#!include auth-system.conf.ext/' /etc/dovecot/conf.d/10-auth.conf

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

# 9. Firewall (UFW) e Fail2ban
echo -e "${YELLOW}[9/9] Configurando Segurança e Firewall (UFW)...${NC}"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp      # SSH
ufw allow 80/tcp      # HTTP (Nginx/Painel)
ufw allow 443/tcp     # HTTPS (Nginx/Painel SSL)
ufw allow 25/tcp      # SMTP (E-mail envio)
ufw allow 587/tcp     # SMTP seguro
ufw allow 993/tcp     # IMAP SSL (E-mail recebimento)
ufw --force enable

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

# Aguarda o serviço iniciar e criar o banco/credenciais
sleep 5
FIRST_BOOT_FILE="/opt/bestcode-cp/first-boot.txt"
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
echo -e "⚠️  IMPORTANT: Configure o Google 2FA na aba de Utilizadores para máxima segurança."
echo -e "O phpMyAdmin está integrado e acessível direto pelo painel de Banco de Dados."
echo -e "=================================================================="
