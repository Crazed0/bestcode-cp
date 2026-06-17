const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const db = require('../config/db');
const { execCommand, restartService, getSystemPath, isLinux } = require('../services/systemService');

/**
 * Detecta dinamicamente a socket PHP-FPM ativa no sistema
 */
function getPhpSocket(phpVersion) {
  if (!isLinux) {
    return 'unix:/run/php/php8.2-fpm.sock'; // mock local para Windows
  }

  const requestedSocket = `/run/php/php${phpVersion}-fpm.sock`;
  if (fsSync.existsSync(requestedSocket)) {
    return `unix:${requestedSocket}`;
  }

  try {
    if (fsSync.existsSync('/run/php')) {
      const files = fsSync.readdirSync('/run/php');
      const fpmSock = files.find(f => f.startsWith('php') && f.endsWith('-fpm.sock'));
      if (fpmSock) {
        return `unix:/run/php/${fpmSock}`;
      }
    }
  } catch (err) {}

  return 'unix:/run/php/php-fpm.sock'; // fallback padrão
}

/**
 * Retorna template de configuração do Nginx para PHP/Estático/WordPress/React/Python
 */
function getNginxTemplate(domain, rootPath, phpVersion, siteType, appPort) {
  const phpSocket = getPhpSocket(phpVersion);

  let locationBlock = '';
  let phpBlock = '';
  let indexFile = 'index.php index.html index.htm';

  if (siteType === 'react') {
    indexFile = 'index.html';
    locationBlock = `
    location / {
        try_files $uri $uri/ /index.html;
    }`;
  } else if (siteType === 'wordpress') {
    locationBlock = `
    location / {
        try_files $uri $uri/ /index.php?$args;
    }`;
  } else if (siteType === 'static') {
    indexFile = 'index.html index.htm';
    locationBlock = `
    location / {
        try_files $uri $uri/ =404;
    }`;
  } else if (siteType === 'python') {
    indexFile = 'index.html';
    const port = appPort || 5000;
    locationBlock = `
    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }`;
  } else { // PHP/Padrão
    locationBlock = `
    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }`;
  }

  if (siteType === 'php' || siteType === 'wordpress' || !siteType) {
    phpBlock = `
    location ~ \\.php$ {
        include fastcgi_params;
        fastcgi_pass ${phpSocket};
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }`;
  }

  return `server {
    listen 80;
    listen [::]:80;

    server_name ${domain} www.${domain};
    root ${rootPath};
    index ${indexFile};

    charset utf-8;
    ${locationBlock}

    location = /favicon.ico { access_log off; log_not_found off; }
    location = /robots.txt  { access_log off; log_not_found off; }

    error_page 404 /index.html;
    ${phpBlock}

    location ~ /\\.(?!well-known).* {
        deny all;
    }
}`;
}

/**
 * Listar todos os sites
 */
async function getSites(req, res) {
  try {
    const sites = db.prepare('SELECT * FROM sites ORDER BY created_at DESC').all();
    res.json(sites);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar sites: ' + error.message });
  }
}

/**
 * Criar um novo site (HTML/PHP/WordPress/React)
 */
async function createSite(req, res) {
  const { domain, phpVersion, siteType } = req.body;

  if (!domain) {
    return res.status(400).json({ error: 'Domínio é obrigatório.' });
  }

  const type = siteType || 'php';

  try {
    const existing = db.prepare('SELECT id FROM sites WHERE domain = ?').get(domain);
    if (existing) {
      return res.status(400).json({ error: 'Este domínio já está cadastrado.' });
    }

    const wwwPath = getSystemPath('www', domain);
    const nginxAvailPath = getSystemPath('nginx-avail', domain);
    const nginxEnabledPath = getSystemPath('nginx-enabled', domain);

    // 1. Criar diretório do site
    await fs.mkdir(wwwPath, { recursive: true });

    // 2. Inicializar arquivos com base no tipo do site
    let appPort = null;
    if (type === 'wordpress') {
      if (isLinux) {
        // Baixa e extrai WordPress de forma segura em WSL/Linux
        const wpCmd = `wget -q https://wordpress.org/latest.tar.gz -O /tmp/wp.tar.gz && tar -xzf /tmp/wp.tar.gz -C "${wwwPath}" --strip-components=1 && rm -f /tmp/wp.tar.gz && chown -R www-data:www-data "${wwwPath}"`;
        await execCommand(wpCmd);
      } else {
        // Simulação local no Windows
        const indexContent = `<?php
        echo "<h1>WordPress (Simulação Local no Windows)</h1>";
        echo "<p>No servidor Linux/WSL real, os arquivos do WordPress foram extraídos aqui e as permissões de www-data configuradas.</p>";
        phpinfo();
        ?>`;
        await fs.writeFile(path.join(wwwPath, 'index.php'), indexContent, 'utf8');
      }
    } else if (type === 'react') {
      const indexContent = `<!DOCTYPE html>
<html lang="pt-PT">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>React SPA | ${domain}</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0b0f19;
            --card-bg: rgba(17, 24, 39, 0.8);
            --border-color: rgba(255, 255, 255, 0.08);
            --accent-blue: #00d2ff;
            --text-color: #f8fafc;
            --text-muted: #94a3b8;
        }
        body { margin: 0; padding: 0; background-color: var(--bg-color); color: var(--text-color); font-family: 'Outfit', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; overflow: hidden; }
        .glow-circle { position: absolute; width: 450px; height: 450px; background: radial-gradient(circle, rgba(0, 210, 255, 0.08) 0%, rgba(0,0,0,0) 70%); border-radius: 50%; z-index: -1; }
        .glow-1 { top: -100px; left: -100px; }
        .glow-2 { bottom: -100px; right: -100px; }
        .card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 20px; padding: 45px; width: 90%; max-width: 550px; text-align: center; backdrop-filter: blur(16px); box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5); }
        .logo-wrapper { display: inline-flex; align-items: center; justify-content: center; width: 80px; height: 80px; border-radius: 20px; background: rgba(0, 210, 255, 0.05); border: 1px solid rgba(0, 210, 255, 0.2); color: var(--accent-blue); font-size: 32px; font-weight: 800; margin-bottom: 25px; box-shadow: 0 0 20px rgba(0, 210, 255, 0.15); }
        h1 { font-size: 2.2rem; margin: 0 0 10px 0; font-weight: 800; background: linear-gradient(135deg, #ffffff 30%, #a5b4fc 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .domain { font-family: 'JetBrains Mono', monospace; color: var(--accent-blue); font-size: 1.1rem; margin-bottom: 20px; }
        p { color: var(--text-muted); font-size: 1.05rem; line-height: 1.6; margin: 0 0 30px 0; }
        .badge { display: inline-block; padding: 6px 16px; border-radius: 30px; font-size: 0.85rem; font-weight: 600; background: rgba(0, 229, 255, 0.1); color: #00e5ff; border: 1px solid rgba(0, 229, 255, 0.2); margin-bottom: 30px; }
        .footer { border-top: 1px solid var(--border-color); padding-top: 20px; font-size: 0.85rem; color: var(--text-muted); }
    </style>
</head>
<body>
    <div class="glow-circle glow-1"></div>
    <div class="glow-circle glow-2"></div>
    <div id="root"></div>
    <script>
        document.getElementById('root').innerHTML = \`
            <div class="card">
                <div class="logo-wrapper">RE</div>
                <h1>React SPA Online!</h1>
                <div class="domain">${domain}</div>
                <p>Esta é uma página SPA base. O Nginx está devidamente configurado com try_files para suporte a roteamento dinâmico React Router.</p>
                <span class="badge">React Single Page App</span>
                <div class="footer">Desenvolvido por BestCode &bull; Servido via Nginx</div>
            </div>
        \`;
    </script>
</body>
</html>`;
      await fs.writeFile(path.join(wwwPath, 'index.html'), indexContent, 'utf8');
    } else if (type === 'static') {
      const indexContent = `<!DOCTYPE html>
<html lang="pt-PT">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Site Estático | ${domain}</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0b0f19;
            --card-bg: rgba(17, 24, 39, 0.8);
            --border-color: rgba(255, 255, 255, 0.08);
            --accent-blue: #00d2ff;
            --text-color: #f8fafc;
            --text-muted: #94a3b8;
        }
        body { margin: 0; padding: 0; background-color: var(--bg-color); color: var(--text-color); font-family: 'Outfit', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; overflow: hidden; }
        .glow-circle { position: absolute; width: 450px; height: 450px; background: radial-gradient(circle, rgba(0, 210, 255, 0.08) 0%, rgba(0,0,0,0) 70%); border-radius: 50%; z-index: -1; }
        .glow-1 { top: -100px; left: -100px; }
        .glow-2 { bottom: -100px; right: -100px; }
        .card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 20px; padding: 45px; width: 90%; max-width: 550px; text-align: center; backdrop-filter: blur(16px); box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5); }
        .logo-wrapper { display: inline-flex; align-items: center; justify-content: center; width: 80px; height: 80px; border-radius: 20px; background: rgba(0, 210, 255, 0.05); border: 1px solid rgba(0, 210, 255, 0.2); color: var(--accent-blue); font-size: 32px; font-weight: 800; margin-bottom: 25px; box-shadow: 0 0 20px rgba(0, 210, 255, 0.15); }
        h1 { font-size: 2.2rem; margin: 0 0 10px 0; font-weight: 800; background: linear-gradient(135deg, #ffffff 30%, #a5b4fc 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .domain { font-family: 'JetBrains Mono', monospace; color: var(--accent-blue); font-size: 1.1rem; margin-bottom: 20px; }
        p { color: var(--text-muted); font-size: 1.05rem; line-height: 1.6; margin: 0 0 30px 0; }
        .badge { display: inline-block; padding: 6px 16px; border-radius: 30px; font-size: 0.85rem; font-weight: 600; background: rgba(255, 255, 255, 0.05); color: var(--text-muted); border: 1px solid rgba(255, 255, 255, 0.1); margin-bottom: 30px; }
        .footer { border-top: 1px solid var(--border-color); padding-top: 20px; font-size: 0.85rem; color: var(--text-muted); }
    </style>
</head>
<body>
    <div class="glow-circle glow-1"></div>
    <div class="glow-circle glow-2"></div>
    <div class="card">
        <div class="logo-wrapper">ST</div>
        <h1>Website Estático Online!</h1>
        <div class="domain">${domain}</div>
        <p>Este website foi criado com sucesso no painel **BestCode Control Panel (BCP)** e está pronto para o teu código.</p>
        <span class="badge">Static Application</span>
        <div class="footer">Desenvolvido por BestCode &bull; Servido via Nginx</div>
    </div>
</body>
</html>`;
      await fs.writeFile(path.join(wwwPath, 'index.html'), indexContent, 'utf8');
    } else if (type === 'python') {
      // Aloca uma porta livre para a aplicação Python
      let port = 5000;
      const highestPortRow = db.prepare('SELECT MAX(app_port) as max_port FROM sites').get();
      if (highestPortRow && highestPortRow.max_port) {
        port = highestPortRow.max_port + 1;
      }
      appPort = port;

      // Cria template inicial da aplicação Flask
      const appContent = `from flask import Flask
app = Flask(__name__)

@app.route("/")
def hello():
    return """<!DOCTYPE html>
<html lang="pt-PT">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Python Flask App | BestCode CP</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0b0f19;
            --card-bg: rgba(17, 24, 39, 0.8);
            --border-color: rgba(255, 255, 255, 0.08);
            --accent-blue: #00d2ff;
            --text-color: #f8fafc;
            --text-muted: #94a3b8;
        }
        body { margin: 0; padding: 0; background-color: var(--bg-color); color: var(--text-color); font-family: 'Outfit', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; overflow: hidden; }
        .glow-circle { position: absolute; width: 450px; height: 450px; background: radial-gradient(circle, rgba(0, 210, 255, 0.08) 0%, rgba(0,0,0,0) 70%); border-radius: 50%; z-index: -1; }
        .glow-1 { top: -100px; left: -100px; }
        .glow-2 { bottom: -100px; right: -100px; }
        .card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 20px; padding: 45px; width: 90%; max-width: 550px; text-align: center; backdrop-filter: blur(16px); box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5); }
        .logo-wrapper { display: inline-flex; align-items: center; justify-content: center; width: 80px; height: 80px; border-radius: 20px; background: rgba(0, 210, 255, 0.05); border: 1px solid rgba(0, 210, 255, 0.2); color: var(--accent-blue); font-size: 32px; font-weight: 800; margin-bottom: 25px; box-shadow: 0 0 20px rgba(0, 210, 255, 0.15); }
        h1 { font-size: 2.2rem; margin: 0 0 10px 0; font-weight: 800; background: linear-gradient(135deg, #ffffff 30%, #a5b4fc 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .domain { font-family: 'JetBrains Mono', monospace; color: var(--accent-blue); font-size: 1.1rem; margin-bottom: 20px; }
        p { color: var(--text-muted); font-size: 1.05rem; line-height: 1.6; margin: 0 0 30px 0; }
        .badge { display: inline-block; padding: 6px 16px; border-radius: 30px; font-size: 0.85rem; font-weight: 600; background: rgba(59, 130, 246, 0.15); color: #3b82f6; border: 1px solid rgba(59, 130, 246, 0.25); margin-bottom: 30px; }
        .footer { border-top: 1px solid var(--border-color); padding-top: 20px; font-size: 0.85rem; color: var(--text-muted); }
    </style>
</head>
<body>
    <div class="glow-circle glow-1"></div>
    <div class="glow-circle glow-2"></div>
    <div class="card">
        <div class="logo-wrapper">PY</div>
        <h1>Python App Online!</h1>
        <div class="domain">${domain}</div>
        <p>A tua aplicação Flask está ativa e a correr no ambiente virtual gerido pelo **BestCode CP**.</p>
        <span class="badge">Python Flask Application</span>
        <div class="footer">Desenvolvido por BestCode &bull; Servido via PM2 + Nginx Proxy</div>
    </div>
</body>
</html>"""

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=${appPort})
`;
      await fs.writeFile(path.join(wwwPath, 'app.py'), appContent, 'utf8');

      // Cria o ambiente virtual e inicializa a aplicação se for Linux/WSL
      if (isLinux) {
        const pyCmd = `cd "${wwwPath}" && python3 -m venv venv && venv/bin/pip install flask && pm2 start app.py --name "site-${domain}" --interpreter venv/bin/python -- --port ${appPort}`;
        execCommand(pyCmd).catch(err => console.error(`[PYTHON SETUP ERROR] ${domain}:`, err));
      } else {
        // Simulação local no Windows
        const indexContent = `<!DOCTYPE html>
<html lang="pt-PT">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Python App (Local) | ${domain}</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0b0f19;
            --card-bg: rgba(17, 24, 39, 0.8);
            --border-color: rgba(255, 255, 255, 0.08);
            --accent-blue: #00d2ff;
            --text-color: #f8fafc;
            --text-muted: #94a3b8;
        }
        body { margin: 0; padding: 0; background-color: var(--bg-color); color: var(--text-color); font-family: 'Outfit', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; overflow: hidden; }
        .glow-circle { position: absolute; width: 450px; height: 450px; background: radial-gradient(circle, rgba(0, 210, 255, 0.08) 0%, rgba(0,0,0,0) 70%); border-radius: 50%; z-index: -1; }
        .glow-1 { top: -100px; left: -100px; }
        .glow-2 { bottom: -100px; right: -100px; }
        .card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 20px; padding: 45px; width: 90%; max-width: 550px; text-align: center; backdrop-filter: blur(16px); box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5); }
        .logo-wrapper { display: inline-flex; align-items: center; justify-content: center; width: 80px; height: 80px; border-radius: 20px; background: rgba(0, 210, 255, 0.05); border: 1px solid rgba(0, 210, 255, 0.2); color: var(--accent-blue); font-size: 32px; font-weight: 800; margin-bottom: 25px; box-shadow: 0 0 20px rgba(0, 210, 255, 0.15); }
        h1 { font-size: 2.2rem; margin: 0 0 10px 0; font-weight: 800; background: linear-gradient(135deg, #ffffff 30%, #a5b4fc 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .domain { font-family: 'JetBrains Mono', monospace; color: var(--accent-blue); font-size: 1.1rem; margin-bottom: 20px; }
        p { color: var(--text-muted); font-size: 1.05rem; line-height: 1.6; margin: 0 0 30px 0; }
        .badge { display: inline-block; padding: 6px 16px; border-radius: 30px; font-size: 0.85rem; font-weight: 600; background: rgba(59, 130, 246, 0.15); color: #3b82f6; border: 1px solid rgba(59, 130, 246, 0.25); margin-bottom: 30px; }
        .footer { border-top: 1px solid var(--border-color); padding-top: 20px; font-size: 0.85rem; color: var(--text-muted); }
    </style>
</head>
<body>
    <div class="glow-circle glow-1"></div>
    <div class="glow-circle glow-2"></div>
    <div class="card">
        <div class="logo-wrapper">PY</div>
        <h1>Python App (Simulação Local)</h1>
        <div class="domain">${domain}</div>
        <p>A aplicação Flask está configurada para a porta local ${appPort} via PM2 no host de produção real.</p>
        <span class="badge">Python Flask (Windows Mock)</span>
        <div class="footer">Desenvolvido por BestCode</div>
    </div>
</body>
</html>`;
        await fs.writeFile(path.join(wwwPath, 'index.html'), indexContent, 'utf8');
      }
    } else { // PHP
      const indexContent = `<?php
// Template PHP inicial
?>
<!DOCTYPE html>
<html lang="pt-PT">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PHP Website | ${domain}</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0b0f19;
            --card-bg: rgba(17, 24, 39, 0.8);
            --border-color: rgba(255, 255, 255, 0.08);
            --accent-blue: #00d2ff;
            --text-color: #f8fafc;
            --text-muted: #94a3b8;
        }
        body { margin: 0; padding: 0; background-color: var(--bg-color); color: var(--text-color); font-family: 'Outfit', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; overflow: hidden; }
        .glow-circle { position: absolute; width: 450px; height: 450px; background: radial-gradient(circle, rgba(0, 210, 255, 0.08) 0%, rgba(0,0,0,0) 70%); border-radius: 50%; z-index: -1; }
        .glow-1 { top: -100px; left: -100px; }
        .glow-2 { bottom: -100px; right: -100px; }
        .card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 20px; padding: 45px; width: 90%; max-width: 550px; text-align: center; backdrop-filter: blur(16px); box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5); }
        .logo-wrapper { display: inline-flex; align-items: center; justify-content: center; width: 80px; height: 80px; border-radius: 20px; background: rgba(0, 210, 255, 0.05); border: 1px solid rgba(0, 210, 255, 0.2); color: var(--accent-blue); font-size: 32px; font-weight: 800; margin-bottom: 25px; box-shadow: 0 0 20px rgba(0, 210, 255, 0.15); }
        h1 { font-size: 2.2rem; margin: 0 0 10px 0; font-weight: 800; background: linear-gradient(135deg, #ffffff 30%, #a5b4fc 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .domain { font-family: 'JetBrains Mono', monospace; color: var(--accent-blue); font-size: 1.1rem; margin-bottom: 20px; }
        p { color: var(--text-muted); font-size: 1.05rem; line-height: 1.6; margin: 0 0 30px 0; }
        .badge { display: inline-block; padding: 6px 16px; border-radius: 30px; font-size: 0.85rem; font-weight: 600; background: rgba(168, 85, 247, 0.1); color: #a855f7; border: 1px solid rgba(168, 85, 247, 0.2); margin-bottom: 30px; }
        .footer { border-top: 1px solid var(--border-color); padding-top: 20px; font-size: 0.85rem; color: var(--text-muted); }
    </style>
</head>
<body>
    <div class="glow-circle glow-1"></div>
    <div class="glow-circle glow-2"></div>
    <div class="card">
        <div class="logo-wrapper">PH</div>
        <h1>Website PHP Online!</h1>
        <div class="domain">${domain}</div>
        <p>O teu website PHP está ativo com versão ${phpVersion || '8.2'} executando de forma otimizada via PHP-FPM.</p>
        <span class="badge">PHP Application</span>
        <div class="footer">Desenvolvido por BestCode &bull; Servido via Nginx</div>
    </div>
</body>
</html>`;
      await fs.writeFile(path.join(wwwPath, 'index.php'), indexContent, 'utf8');
    }

    // 3. Escrever configuração do Nginx
    const nginxConfig = getNginxTemplate(domain, wwwPath, phpVersion, type, appPort);
    await fs.writeFile(nginxAvailPath, nginxConfig, 'utf8');

    // 4. Criar link simbólico para ativar o site (apenas no Linux)
    if (isLinux) {
      await execCommand(`ln -sf "${nginxAvailPath}" "${nginxEnabledPath}"`);
      await restartService('nginx');
    } else {
      // Simulação no Windows (escreve o arquivo na pasta enabled também)
      await fs.writeFile(nginxEnabledPath, nginxConfig, 'utf8');
    }

    // 5. Inserir no banco de dados do painel
    db.prepare('INSERT INTO sites (domain, root_path, php_version, ssl_enabled, site_type, app_port) VALUES (?, ?, ?, 0, ?, ?)')
      .run(domain, wwwPath, phpVersion || '8.2', type, appPort);

    res.json({ message: 'Site criado com sucesso!', domain });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar site: ' + error.message });
  }
}

/**
 * Excluir um site e suas configurações
 */
async function deleteSite(req, res) {
  const { id } = req.body;

  try {
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
    if (!site) {
      return res.status(404).json({ error: 'Site não encontrado.' });
    }

    const domain = site.domain;
    const wwwPath = getSystemPath('www', domain);
    const nginxAvailPath = getSystemPath('nginx-avail', domain);
    const nginxEnabledPath = getSystemPath('nginx-enabled', domain);

    // Parar/Remover processo PM2 se for aplicação Python
    if (site.site_type === 'python' && isLinux) {
      try {
        await execCommand(`pm2 delete "site-${domain}"`);
      } catch (e) {
        console.error(`Erro ao parar PM2 do site ${domain}:`, e.message);
      }
    }

    // 1. Remover configurações do Nginx
    try {
      await fs.unlink(nginxAvailPath);
    } catch (e) {}
    try {
      await fs.unlink(nginxEnabledPath);
    } catch (e) {}

    // 2. Reiniciar o Nginx
    if (isLinux) {
      await restartService('nginx');
    }

    // 3. Remover arquivos do site (Opcional: movemos para uma pasta backup ou excluímos)
    try {
      await fs.rm(wwwPath, { recursive: true, force: true });
    } catch (e) {}

    // 4. Excluir do banco
    db.prepare('DELETE FROM sites WHERE id = ?').run(id);

    res.json({ message: 'Site excluído com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao excluir site: ' + error.message });
  }
}

/**
 * Ativar SSL com Let's Encrypt (Certbot)
 */
async function toggleSSL(req, res) {
  const { id } = req.body;

  try {
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
    if (!site) {
      return res.status(404).json({ error: 'Site não encontrado.' });
    }

    const domain = site.domain;

    if (site.ssl_enabled === 0) {
      // Ativar SSL
      if (isLinux) {
        // Roda o Certbot com o plugin do Nginx
        const certbotResult = await execCommand(`certbot --nginx -d ${domain} -d www.${domain} --non-interactive --agree-tos --register-unsafely-without-email`);
        
        if (certbotResult.error) {
          return res.status(500).json({ error: 'Erro no Certbot: ' + certbotResult.stderr });
        }
      }
      
      db.prepare('UPDATE sites SET ssl_enabled = 1 WHERE id = ?').run(id);
      res.json({ message: 'SSL ativado com sucesso para ' + domain, ssl_enabled: 1 });
    } else {
      // Desativar SSL (reverter o Nginx para o template HTTP padrão)
      const nginxAvailPath = getSystemPath('nginx-avail', domain);
      const nginxConfig = getNginxTemplate(domain, site.root_path, site.php_version, site.site_type, site.app_port);
      await fs.writeFile(nginxAvailPath, nginxConfig, 'utf8');

      if (isLinux) {
        await restartService('nginx');
      }

      db.prepare('UPDATE sites SET ssl_enabled = 0 WHERE id = ?').run(id);
      res.json({ message: 'SSL desativado com sucesso (revertido para HTTP).', ssl_enabled: 0 });
    }
  } catch (error) {
    res.status(500).json({ error: 'Erro ao gerenciar SSL: ' + error.message });
  }
}

/**
 * Obter a configuração do Nginx de um site
 */
async function getSiteConfig(req, res) {
  const { domain } = req.query;
  if (!domain) {
    return res.status(400).json({ error: 'Domínio é obrigatório.' });
  }

  try {
    const nginxAvailPath = getSystemPath('nginx-avail', domain);
    const content = await fs.readFile(nginxAvailPath, 'utf8');
    res.json({ content });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao ler a configuração: ' + error.message });
  }
}

/**
 * Salvar a configuração do Nginx de um site e recarregar o Nginx
 */
async function saveSiteConfig(req, res) {
  const { domain, content } = req.body;
  if (!domain || content === undefined) {
    return res.status(400).json({ error: 'Domínio e conteúdo são obrigatórios.' });
  }

  try {
    const nginxAvailPath = getSystemPath('nginx-avail', domain);
    await fs.writeFile(nginxAvailPath, content, 'utf8');

    if (isLinux) {
      // Testa a configuração antes de reiniciar para evitar derrubar o servidor
      const testResult = await execCommand('nginx -t');
      if (testResult.error) {
        throw new Error('Configuração do Nginx inválida: ' + testResult.stderr);
      }
      await restartService('nginx');
    }

    res.json({ message: 'Configuração do Nginx salva e recarregada com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao salvar configuração: ' + error.message });
  }
}

module.exports = {
  getSites,
  createSite,
  deleteSite,
  toggleSSL,
  getSiteConfig,
  saveSiteConfig
};
