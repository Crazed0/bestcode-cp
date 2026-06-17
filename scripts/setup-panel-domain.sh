#!/bin/bash
# scripts/setup-panel-domain.sh
# Configura um domínio personalizado e SSL (Certbot) para o próprio Painel do BestCode CP

if [ "$EUID" -ne 0 ]; then
  echo -e "\033[0;31m[ERRO] Este script deve ser executado como ROOT (use sudo).\033[0;m"
  exit 1
fi

DOMAIN=$1

if [ -z "$DOMAIN" ]; then
  echo -e "\033[0;33m[USO] bash setup-panel-domain.sh <seu-dominio.com>\033[0;m"
  exit 1
fi

echo -e "\033[0;34m==================================================\033[0;m"
echo -e "\033[0;34mConfigurando Domínio do Painel: $DOMAIN\033[0;m"
echo -e "\033[0;34m==================================================\033[0;m"

# 1. Atualiza o Nginx com o novo domínio
NGINX_CONF="/etc/nginx/sites-available/bestcode-cp"

if [ ! -f "$NGINX_CONF" ]; then
  echo -e "\033[0;31m[ERRO] Configuração do Nginx (/etc/nginx/sites-available/bestcode-cp) não encontrada!\033[0;m"
  exit 1
fi

# Sobrescreve o arquivo com o server_name correto e escuta na porta 80
cat <<EOF > "$NGINX_CONF"
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;

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

# Testa configuração do Nginx
nginx -t
if [ $? -ne 0 ]; then
  echo -e "\033[0;31m[ERRO] Configuração do Nginx é inválida!\033[0;m"
  exit 1
fi

systemctl reload nginx

# 2. Executa o Certbot para obter o SSL grátis da Let's Encrypt
echo -e "\033[0;33mSolicitando certificado SSL via Certbot para $DOMAIN...\033[0;m"
certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email

if [ $? -eq 0 ]; then
  echo -e "\033[0;32m==================================================\033[0;m"
  echo -e "\033[0;32m🎉 SSL ATIVADO E CONFIGURADO COM SUCESSO!\033[0;m"
  echo -e "\033[0;32m==================================================\033[0;m"
  echo -e "O painel agora está acessível de forma segura através do link:"
  echo -e "\033[0;34mhttps://$DOMAIN/\033[0;m"
  echo -e "=================================================="
else
  echo -e "\033[0;31m[AVISO] Certbot não conseguiu gerar o SSL. Certifique-se de que o domínio está apontando (registro A) para o IP deste servidor.\033[0;m"
  echo -e "O painel continuará acessível via HTTP em: http://$DOMAIN/"
fi
