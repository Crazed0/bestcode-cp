#!/bin/bash

# ==============================================================================
# SCRIPT DE INSTALAÇÃO / REINSTALAÇÃO DO BESTCODE CONTROL PANEL (BCP)
# SO RECOMENDADO: Ubuntu 22.04/24.04 LTS ou Debian 12
# ------------------------------------------------------------------------------
# IDEMPOTENTE: pode correr-se as vezes que forem precisas. Reconfigura tudo
# (serviços, segurança, firewall) sem partir o que já está.
#
# PRESERVA OS DADOS (nunca apaga):
#   - /opt/bestcode-cp/backend/database.db*  (sites, utilizadores, BDs, emails, projetos…)
#   - /opt/bestcode-cp/backend/.jwt-secret + .secret-key  (segredo JWT + chave de cifra → sessões/segredos mantêm-se)
#   - /var/www/*            (ficheiros dos sites)
#   - /var/lib/mysql/*      (bases de dados reais)
#   - /var/mail/vhosts/*    (caixas de correio)
# Só o CÓDIGO e a CONFIGURAÇÃO são reinstalados. A segurança (permissões por site,
# cifra de segredos, audit log, etc.) é (re)aplicada automaticamente no arranque do painel.
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
  apt install -y build-essential curl wget git unzip zip p7zip-full unrar-free tar gzip bzip2 xz-utils ca-certificates gnupg lsb-release net-tools cron ufw fail2ban sqlite3
  
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
  apt install -y build-essential curl wget git unzip zip p7zip-full unrar-free tar gzip bzip2 xz-utils ca-certificates gnupg lsb-release software-properties-common net-tools cron ufw fail2ban sqlite3
  
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

# WireGuard + qrencode — o painel tem uma página WireGuard que cria o hub e os peers.
# Sem estes pacotes, o backend tenta auto-instalar em runtime na 1ª utilização (lento
# e falha se não houver internet). Pré-instalar deixa a página WG pronta a usar.
echo -e "${YELLOW}Instalando WireGuard, wireguard-tools e qrencode...${NC}"
DEBIAN_FRONTEND=noninteractive apt install -y wireguard wireguard-tools qrencode

# Updates automáticos de segurança — referenciado pelo doc de hardening.
# Mantém-se a postura segura entre reinstalações sem ação manual.
echo -e "${YELLOW}Instalando unattended-upgrades (security updates automáticos)...${NC}"
DEBIAN_FRONTEND=noninteractive apt install -y unattended-upgrades
# Ativa o ficheiro de auto-upgrades sem prompt interativo
echo 'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades

# 3. Configurando Diretórios do BestCode CP
echo -e "${YELLOW}[3/9] Configurando arquivos do BestCode CP...${NC}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(dirname "$SCRIPT_DIR")"

mkdir -p /opt/bestcode-cp
mkdir -p /opt/bestcode-cp/scripts
# Cria as pastas alvo do deploy (backend/daemon/frontend) já vazias, para que
# os chmod/chown/cat que se seguem não falhem na PRIMEIRA instalação (antes do
# `npm run deploy` lá pôr o código). Numa reinstalação, estas pastas já existem
# e o mkdir é no-op.
mkdir -p /opt/bestcode-cp/backend /opt/bestcode-cp/daemon /opt/bestcode-cp/frontend

echo -e "Descarregando scripts essenciais do repositório..."
wget -qO /opt/bestcode-cp/scripts/update.sh https://raw.githubusercontent.com/Crazed0/bestcode-cp/main/scripts/update.sh
wget -qO /opt/bestcode-cp/scripts/setup-panel-domain.sh https://raw.githubusercontent.com/Crazed0/bestcode-cp/main/scripts/setup-panel-domain.sh
wget -qO /opt/bestcode-cp/scripts/phpmyadmin-signon.php https://raw.githubusercontent.com/Crazed0/bestcode-cp/main/scripts/phpmyadmin-signon.php

# Torna os scripts utilitários executáveis
chmod +x /opt/bestcode-cp/scripts/update.sh
chmod +x /opt/bestcode-cp/scripts/setup-panel-domain.sh

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

# 4. (Pular a instalação do Backend/Daemon, será feito pelo deploy via SSH)
echo -e "${YELLOW}[4/9] O código do Painel será instalado via SSH Deploy...${NC}"

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

    # Cabeçalhos de Segurança (alinhados com os do painel; o backend reforça-os também)
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header Permissions-Policy "geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), accelerometer=(), gyroscope=(), interest-cohort=()" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://accounts.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; img-src 'self' data: blob: https://lh3.googleusercontent.com; connect-src 'self' wss: https://api.github.com https://raw.githubusercontent.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; frame-src 'self' https://accounts.google.com; object-src 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'self';" always;

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
        # Algumas operações chamam APIs externas lentas (ex.: Overpass na página
        # de Leads, que pode levar 60-90s). Default do Nginx é 60s → 502.
        # Aumentamos para 3 min, cobrindo o tempo razoável de qualquer pesquisa.
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
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
# Corre como root: o painel cria utilizadores Unix por site, gere o nginx/PM2/fail2ban
# e abre consolas isoladas (runuser) — operações que exigem privilégios de root.
User=root
WorkingDirectory=/opt/bestcode-cp/backend
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
# NÃO definimos JWT_SECRET aqui: o painel gera/persiste um segredo aleatório em
# backend/.jwt-secret (sobrevive a reinstalações → as sessões NÃO caem ao reinstalar).
Environment=NODE_ENV=production PORT=3000 PMA_PATH=${PMA_PATH}
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
# Apenas ENABLE aqui — não START. Na primeira instalação o código ainda não está
# no servidor (chega via `npm run deploy`); um `systemctl start` agora falharia
# em loop até o deploy ocorrer. O deploy faz `systemctl restart` no fim, que
# arranca os serviços com o código já presente. Em reinstalações, o restart
# final desta script (mais abaixo) também trata disso.
systemctl enable bestcode-cp
systemctl enable bestcode-cp-daemon

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

# Reencaminhamento de email (forward). O Postfix consulta esta query ANTES do
# virtual_mailbox_maps: se devolver algo, é a lista para onde entregar.
#   - keep_local_copy=1 → retorna 'email_address, forward_to' (mantém cópia local)
#   - keep_local_copy=0 → retorna apenas 'forward_to' (puro redirect)
#   - forward_to vazio  → query devolve NULL e o mail é entregue normalmente
cat <<EOF > /etc/postfix/sqlite-virtual-alias-maps.cf
dbpath = /opt/bestcode-cp/backend/database.db
query = SELECT CASE WHEN keep_local_copy=1 THEN email_address || ',' || forward_to ELSE forward_to END FROM emails WHERE email_address='%s' AND forward_to IS NOT NULL AND forward_to != ''
EOF

# IMPORTANTE: tirar o chroot do Postfix. Caso contrário, smtpd/trivial-rewrite/cleanup
# correm dentro de /var/spool/postfix e NÃO vêem /opt/bestcode-cp/backend/database.db
# (onde estão os virtual_mailbox_domains/_maps), falhando com "disk I/O error?" e a queue
# nunca se entrega. Idempotente — só muda 'y' para 'n' na 5ª coluna do master.cf.
awk 'BEGIN{OFS=" "} /^[a-z]/ && NF>=8 && $5=="y" { $5="n" } { print }' /etc/postfix/master.cf > /etc/postfix/master.cf.new \
  && mv /etc/postfix/master.cf.new /etc/postfix/master.cf

# Aplica parâmetros essenciais no /etc/postfix/main.cf (inclui SASL Auth via Dovecot e LMTP)
postconf -e "virtual_mailbox_domains = sqlite:/etc/postfix/sqlite-virtual-mailbox-domains.cf"
postconf -e "virtual_mailbox_maps = sqlite:/etc/postfix/sqlite-virtual-mailbox-maps.cf"
postconf -e "virtual_alias_maps = sqlite:/etc/postfix/sqlite-virtual-alias-maps.cf"
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
# NOTA: a ES2 usa UFW porque o painel BestCode CP gere o firewall por aqui
# (página de Segurança → abrir/fechar portas) e também o fail2ban. NÃO apliques
# também a nftables.conf "crua" do documento mestre NESTA máquina — escolhe uma
# só fonte de verdade. A nftables crua do doc é para a node1/local (sem painel).
ufw default deny incoming
ufw default allow outgoing
ufw allow in on lo                 # loopback

# SSH — abre 22 E 2222 (rate-limited). O doc mestre move o SSH para 2222; abrir
# ambas evita trancares-te fora numa reinstalação, seja qual for a porta ativa.
ufw limit 22/tcp                   # SSH (porta default)
ufw limit 2222/tcp                 # SSH (porta endurecida do doc)

# Web — Nginx/Painel. Fica atrás de Cloudflare e o middleware do painel já bloqueia
# acesso direto por IP (Host = IP → 403). Para fechar a origem SÓ ao Cloudflare,
# vê o bloco OPCIONAL comentado no fim desta secção.
ufw allow 80/tcp
ufw allow 443/tcp

# Mail (não passa por Cloudflare — usa sempre TLS)
ufw allow 25/tcp                   # SMTP
ufw allow 587/tcp                  # Submission (STARTTLS)
ufw allow 465/tcp                  # SMTPS
ufw allow 993/tcp                  # IMAPS
ufw allow 995/tcp                  # POP3S

# MariaDB/MySQL — NÃO exposta à internet. Só pela mesh WireGuard (interface wg0),
# por isso o plugin CS2 (node1) liga pela mesh e a 3306 não aparece no Shodan.
# Restringir por interface (wg0) funciona seja qual for a subnet (10.0.0.x ou 10.8.0.x).
# Para acesso PÚBLICO/IP-FIXO a uma DB, abre o IP específico (o painel faz isto na
# página de Segurança):  ufw allow from <IP> to any port 3306
ufw allow in on wg0 to any port 3306

# node_exporter (monitorização Prometheus na 'local') — só pela mesh
ufw allow in on wg0 to any port 9100

ufw --force enable

# --- OPCIONAL: restringir a Web (80/443) só ao Cloudflare (defesa em profundidade) ---
# Corre UMA vez depois de teres o domínio em Cloudflare. Mantém a lista atualizada.
# ATENÇÃO: isto bloqueia o acesso direto por IP — só conseguirás chegar via domínio CF.
#   ufw delete allow 80/tcp; ufw delete allow 443/tcp
#   for ip in $(curl -s https://www.cloudflare.com/ips-v4) $(curl -s https://www.cloudflare.com/ips-v6); do
#     ufw allow from "$ip" to any port 80,443 proto tcp
#   done
#   ufw reload

# Fail2ban: protege o SSH (e mais) contra brute-force. O painel gere o ignoreip por aqui.
echo -e "${YELLOW}Configurando fail2ban (jail.local)...${NC}"
if [ ! -f /etc/fail2ban/jail.local ]; then
  cat <<EOF > /etc/fail2ban/jail.local
[DEFAULT]
# Nunca banir o loopback nem a mesh (acrescenta aqui IPs de confiança, ex.: IP de deploy)
ignoreip = 127.0.0.1/8 ::1 10.0.0.0/24 10.8.0.0/24
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled = true
# Protege ambas as portas: a default e a endurecida (2222) do doc mestre
port    = ssh,2222

[nginx-http-auth]
enabled = true

[nginx-botsearch]
enabled = true

[postfix]
enabled = true

[dovecot]
enabled = true
EOF
fi
systemctl enable fail2ban 2>/dev/null || true
systemctl restart fail2ban 2>/dev/null || true

# MariaDB escuta em todas as interfaces (0.0.0.0). Quem REALMENTE chega à 3306 é
# decidido pelo FIREWALL (UFW), não pelo bind — por defeito só a mesh wg0 (secção 9).
# Bind a 0.0.0.0 (em vez de a um IP de mesh) evita o MariaDB falhar no arranque
# quando a interface wg0 ainda não existe.
echo -e "${YELLOW}Configurando MariaDB/MySQL (bind 0.0.0.0, acesso filtrado pelo UFW)...${NC}"
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

# Garante permissões restritas e seguras nos ficheiros base
chmod 660 /opt/bestcode-cp/backend/database.db 2>/dev/null || true
chown bcp:bcp /opt/bestcode-cp/backend/database.db 2>/dev/null || true

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

# Obtém o IP público ou local para exibição
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
PUBLIC_IP=$(curl -s --max-time 3 https://api.ipify.org || curl -s --max-time 3 https://ifconfig.me || wget -qO- --timeout=3 https://api.ipify.org 2>/dev/null || echo "")

DISPLAY_IP="${PUBLIC_IP:-$LOCAL_IP}"
if [ -z "$DISPLAY_IP" ]; then
  DISPLAY_IP="127.0.0.1"
fi

echo -e "${GREEN}==================================================================${NC}"
echo -e "${GREEN}🎉 INFRAESTRUTURA DO BESTCODE CP PREPARADA COM SUCESSO!${NC}"
echo -e "${GREEN}==================================================================${NC}"
echo -e "Os servidores (Nginx, MariaDB, Postfix, Dovecot) estão prontos!"
echo -e ""
echo -e "⚠️  ${YELLOW}FALTA APENAS ENVIAR O CÓDIGO DO PAINEL${NC}"
echo -e "Como o código é privado, vá ao seu PC local (onde tem o projeto original) e execute:"
echo -e "${BLUE}npm run deploy${NC}"
echo -e ""
echo -e "Isso enviará os ficheiros de forma segura e iniciará o sistema automaticamente."
echo -e "Após o deploy, a sua palavra-passe inicial ficará guardada no ficheiro:"
echo -e "${YELLOW}/opt/bestcode-cp/first-boot.txt${NC}"
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
