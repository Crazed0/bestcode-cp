# BestCode Control Panel (BCP)

Painel de controlo do ecossistema **BestCode.PT** — webhosting, servidores de jogo
(CS2) e IPTV numa única interface em português.

> ⚠️ Este repositório contém **apenas os scripts de infraestrutura e deploy**.
> O código do painel (backend, frontend, daemon) é **privado** e chega ao servidor
> via `npm run deploy` a partir da máquina do programador.

## O que faz

- Gestão de **sites** (nginx + SSL Let's Encrypt + per-site Unix user com jail)
- **Bases de dados** MariaDB + SSO para phpMyAdmin
- **Email** virtual (Postfix + Dovecot + SQLite) + webmail Roundcube
- **Servidores de jogo** via Pterodactyl/Wings (CS2 e outros)
- **Ficheiros** (file manager com editor Monaco) + FTP (Pure-FTPd) + DNS (PowerDNS)
- **2FA** TOTP, lockout exponencial, audit log, impersonation para superadmins
- **WireGuard mesh** gerida pela UI
- **Cifra de segredos at-rest** (AES-256-GCM), JWT secret persistente

## Instalação (servidor fresco)

Numa máquina **Debian 12** ou **Ubuntu 22.04/24.04 LTS** limpa, com acesso root:

```bash
# 1) Buscar o instalador da última versão de main
wget -qO /tmp/install.sh https://raw.githubusercontent.com/Crazed0/bestcode-cp/main/scripts/install.sh

# 2) Correr como root (idempotente — pode ser corrido várias vezes)
sudo bash /tmp/install.sh
```

O instalador prepara: Nginx, MariaDB, PHP-FPM (8.1/8.2/8.3), Node 20, PM2, Redis,
Postfix+Dovecot, Roundcube, phpMyAdmin (SSO), PowerDNS, Pure-FTPd, certbot,
fail2ban, UFW e os serviços `systemd` (`bestcode-cp` + `bestcode-cp-daemon`).
Não destrói dados existentes — pode reinstalar-se sem perder `database.db`,
`/var/www`, `/var/lib/mysql`, `/var/mail/vhosts`, segredos.

Depois, **do PC do programador** (onde o código privado está), enviar o painel:

```bash
# Variáveis OBRIGATÓRIAS (sem defaults — não há coordenadas da prod no repo):
export BCP_SSH_HOST=ip-do-servidor
export BCP_SSH_USER=bmw                  # ou outro user com sudo
export BCP_SSH_PORT=2222                 # ou 22, conforme o SSH hardening
export BCP_SUDO_PASS='password do sudo'  # se o user precisar de password

npm run deploy
```

O `deploy.js` compacta `backend`/`frontend`/`daemon` (excluindo `node_modules`,
`database.db*`, `.jwt-secret`, `.secret-key`), envia por SFTP para `/tmp`,
extrai em `/opt/bestcode-cp/`, corre `npm install --omit=dev` e reinicia os
serviços. Na **primeira boot**, o painel gera um admin `root` com password
aleatória em `/opt/bestcode-cp/first-boot.txt`:

```bash
ssh -p $BCP_SSH_PORT $BCP_SSH_USER@$BCP_SSH_HOST "sudo cat /opt/bestcode-cp/first-boot.txt"
```

## Domínio + SSL para o painel (opcional)

Depois do deploy, no servidor:

```bash
sudo bash /opt/bestcode-cp/scripts/setup-panel-domain.sh painel.exemplo.com
```

Aponta o domínio (CNAME/A) ao IP do servidor antes de correr — o script trata do
Let's Encrypt via Certbot.

## Atualizar

A atualização é o **mesmo comando de deploy** — não há `git pull` na produção
(o repo do código é privado e o deploy faz tar+SFTP, não clone):

```bash
npm run deploy
```

Sessões e segredos cifrados ficam preservados (o `.jwt-secret` e `.secret-key`
não são incluídos no tar; a `database.db` também não).

## Manutenção pós-deploy

Se mudaste pacotes do sistema (mail, php-redis, sudoers, virtual maps), o
`update.sh` re-aplica esses items sem tocar no código:

```bash
sudo bash /opt/bestcode-cp/scripts/update.sh
```

Para reaplicar **só** a config de Nginx do painel:

```bash
sudo bash /opt/bestcode-cp/scripts/update.sh --nginx-only
```

## Recuperação de password

```bash
sudo bash /opt/bestcode-cp/scripts/get-admin-pass.sh           # mostra credenciais do first-boot
sudo bash /opt/bestcode-cp/scripts/reset-admin.sh <username>   # nova password para um admin
```

## Estrutura do repo

```
scripts/install.sh                 # instalador idempotente da infra
scripts/setup-panel-domain.sh      # configura domínio + SSL para o painel
scripts/update.sh                  # manutenção da infra (não atualiza código)
scripts/phpmyadmin-signon.php      # SSO phpMyAdmin
scripts/{get-admin-pass,reset-admin}.{sh,js}   # recuperação de admin
deploy.js                          # deploy SSH+SFTP (lê BCP_SSH_* do env)
```

## Requisitos

- **OS**: Debian 12 ou Ubuntu 22.04/24.04 LTS
- **Recursos**: mínimo 2 vCPU, 4 GB RAM, 40 GB de disco
- **Acesso**: root inicial via SSH (o instalador endurece depois)

---

*© 2026 BestCode Ecosystem.*
