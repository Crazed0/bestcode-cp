#!/bin/bash
set -e

echo "=== Instalando dependências PHP ==="
sudo apt-get update
sudo apt-get install -y unzip php-fpm php-mysql php-json php-mbstring php-zip php-gd php-xml php-curl php-sqlite3

echo "=== Instalando phpMyAdmin ==="
PMA_VERSION="5.2.1"
sudo wget -q https://files.phpmyadmin.net/phpMyAdmin/${PMA_VERSION}/phpMyAdmin-${PMA_VERSION}-all-languages.zip -O /tmp/pma.zip
sudo unzip -q /tmp/pma.zip -d /usr/share/
sudo rm -rf /usr/share/phpmyadmin
sudo mv /usr/share/phpMyAdmin-${PMA_VERSION}-all-languages /usr/share/phpmyadmin
sudo rm -f /tmp/pma.zip

# Cria pasta temporária para o phpMyAdmin
sudo mkdir -p /usr/share/phpmyadmin/tmp
sudo chmod 777 /usr/share/phpmyadmin/tmp

# Configura o config.inc.php do phpMyAdmin para SSO (Signon)
sudo cat <<EOF > /usr/share/phpmyadmin/config.inc.php
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
sudo cp /opt/bestcode-cp/scripts/phpmyadmin-signon.php /usr/share/phpmyadmin/signon.php
sudo chmod 644 /usr/share/phpmyadmin/signon.php

echo "=== Configurando Nginx ==="
# Cria arquivo de bloco de servidor Nginx para o phpMyAdmin global
sudo cat <<EOF > /etc/nginx/snippets/phpmyadmin.conf
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
sudo systemctl start php-fpm || sudo service php-fpm start || true
PHP_FPM_SOCK=$(ls /run/php/php*-fpm.sock | head -n 1)

if [ -n "$PHP_FPM_SOCK" ]; then
    echo "FPM Socket encontrado: $PHP_FPM_SOCK"
    sudo sed -i "s|fastcgi_pass unix:/run/php/php-fpm.sock;|fastcgi_pass unix:$PHP_FPM_SOCK;|" /etc/nginx/snippets/phpmyadmin.conf
else
    echo "AVISO: Socket PHP-FPM não foi gerado automaticamente."
fi

# Cria/atualiza a configuração do bloco do Nginx do BestCode CP com o snippet do phpMyAdmin
if [ -f "/opt/bestcode-cp/scripts/update.sh" ]; then
    echo "=== Formatando Nginx com o atualizador do painel ==="
    bash /opt/bestcode-cp/scripts/update.sh --nginx-only
else
    # Fallback caso o script de atualização não exista
    echo "=== Configurando Nginx padrão (fallback) ==="
    sudo cat <<EOF > /etc/nginx/sites-available/bestcode-cp
server {
    listen 80;
    server_name _;

    root /opt/bestcode-cp/frontend;
    index index.html;

    include snippets/phpmyadmin.conf;
    include snippets/roundcube.conf;

    # Cabeçalhos de Segurança (Security Headers)
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://accounts.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https://lh3.googleusercontent.com; connect-src 'self' ws: wss: https://api.github.com https://raw.githubusercontent.com; frame-src 'self' https://accounts.google.com;" always;

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

# Habilita o site bestcode-cp e desabilita o default
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/bestcode-cp /etc/nginx/sites-enabled/bestcode-cp

# Inicia/Reinicia serviços
sudo systemctl restart nginx || sudo service nginx restart
PHP_SERVICE=$(basename $(ls /lib/systemd/system/php*-fpm.service | head -n 1) .service || echo "")
if [ -n "$PHP_SERVICE" ]; then
    sudo systemctl restart $PHP_SERVICE || sudo service $PHP_SERVICE restart || true
fi

echo "=== Configuração Concluída com Sucesso! ==="
