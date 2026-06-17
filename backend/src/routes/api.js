const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const db = require('../config/db');
const { authenticateToken, JWT_SECRET } = require('../config/auth');
const { GOOGLE_CLIENT_ID } = require('../config/google');
const totp = require('../config/totp');
const { getIpLocation, parseUserAgent } = require('../utils/geolocation');
const redisClient = require('../config/redis');
const { execSync } = require('child_process');
const https = require('https');

// Importação dos controladores
const fileController = require('../controllers/fileController');
const siteController = require('../controllers/siteController');
const dbController = require('../controllers/dbController');
const mailController = require('../controllers/mailController');
const cronController = require('../controllers/cronController');
const monitorController = require('../controllers/monitorController');
const gameController = require('../controllers/gameController');
const { getSystemPath, isLinux } = require('../services/systemService');
const dockerService = require('../services/dockerService');

// Configuração do Sentinela Anti-Crash
let autoQuarantineEnabled = true;
const sentinelWhitelist = ['node', 'systemd', 'init', 'dockerd', 'containerd', 'mariadbd', 'mysql', 'nginx', 'sshd', 'bash', 'sh', 'powershell.exe', 'wsl', 'rsyslogd', 'cron', 'systemd-udevd', 'dbus-daemon', 'ps', 'git', 'npm', 'unzip', 'wget', 'curl', 'postfix', 'dovecot', 'pure-ftpd', 'pdns_server', 'pdns', 'rspamd', 'opendkim', 'fail2ban-client', 'fail2ban-server', 'ufw', 'certbot'];

// Monitor de Anti-Crash em background (corre a cada 10 segundos)
setInterval(() => {
  if (!autoQuarantineEnabled) return;
  if (process.platform === 'win32') return;

  const { exec } = require('child_process');
  exec('ps -eo pid,user,%cpu,%mem,stat,comm', (error, stdout) => {
    if (error) return;

    try {
      const lines = stdout.split('\n').filter(line => line.trim().length > 0);
      lines.slice(1).forEach(line => {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[0], 10);
        const cpu = parseFloat(parts[2]);
        const mem = parseFloat(parts[3]);
        const stat = parts[4] || '';
        const name = parts.slice(5).join(' ');

        if (isNaN(pid)) return;

        // Se o processo estiver a usar CPU extrema (>95%) ou Memória (>90%),
        // não estiver suspenso/quarentenado (STAT começa com T) e não for um processo essencial
        const isQuarantined = stat.toUpperCase().startsWith('T');
        if (!isQuarantined && (cpu > 95.0 || mem > 90.0)) {
          const isEssential = sentinelWhitelist.some(w => name.toLowerCase().includes(w));
          if (!isEssential) {
            console.warn(`[Anti-Crash] Processo em risco detectado: ${name} (PID: ${pid}, CPU: ${cpu}%, RAM: ${mem}%). Aplicando quarentena...`);
            
            // Pausa o processo via SIGSTOP
            try {
              process.kill(pid, 'SIGSTOP');
            } catch (e) {
              exec(`sudo kill -STOP ${pid}`);
            }

            // Regista nos logs do sistema
            try {
              db.prepare("INSERT INTO logs (type, message) VALUES ('system', ?)")
                .run(`[Anti-Crash] O processo suspeito ${name} (PID: ${pid}) foi colocado em quarentena automaticamente por consumo excessivo (CPU: ${cpu}%, RAM: ${mem}%).`);
            } catch (logErr) {
              console.error('Erro ao registar log de anti-crash:', logErr);
            }
          }
        }
      });
    } catch (e) {
      console.error('Erro no ciclo de Sentinela Anti-Crash:', e);
    }
  });
}, 10000);

// Teste de conectividade assíncrono para a API do Google
let isGoogleApiReachable = true;
fetch('https://oauth2.googleapis.com/tokeninfo', { method: 'HEAD', signal: AbortSignal.timeout(1200) })
  .then(() => {
    isGoogleApiReachable = true;
    console.log('[Google Auth] API do Google está acessível. Validação online ativa por padrão.');
  })
  .catch(() => {
    isGoogleApiReachable = false;
    console.warn('[Google Auth] API do Google inacessível. Usando fallback offline instantâneo por padrão.');
  });

async function verifyGoogleIdToken(credential) {
  if (!credential) throw new Error("Token do Google não fornecido");
  
  if (!isGoogleApiReachable) {
    console.log("[Google Auth] Ignorando verificação online (API marcada como inacessível). Descodificação offline instantânea...");
    const jwt = require('jsonwebtoken');
    const payload = jwt.decode(credential);
    if (payload && payload.email) {
      console.log(`[Google Auth] Token descodificado offline com sucesso (bypass). Email: ${payload.email}`);
      return payload;
    }
    throw new Error("Falha ao decodificar token offline");
  }

  console.log(`[Google Auth] Iniciando verificação de token. Credential prefix: ${credential.substring(0, 20)}...`);
  
  // Criar um AbortController para definir um timeout de 1.5s
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    console.log(`[Google Auth] Resposta da API do Google: status=${response.status}`);
    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Google Auth] Erro ao validar token: ${errText}`);
      throw new Error("Falha ao validar token com a API do Google: " + errText);
    }
    const payload = await response.json();
    const clientId = GOOGLE_CLIENT_ID;
    if (payload.aud !== clientId) {
      console.warn(`[Google Auth] Audiência incorreta. Esperada: ${clientId}, Recebida: ${payload.aud}`);
      throw new Error("Audiência do token incorreta");
    }
    console.log(`[Google Auth] Token verificado com sucesso via API do Google. Email: ${payload.email}`);
    return payload;
  } catch (err) {
    clearTimeout(timeoutId);
    isGoogleApiReachable = false; // Guarda o estado inacessível para evitar futuros delays
    let errMsg = err.message;
    if (err.name === 'AbortError') {
      errMsg = 'Timeout de ligação excedido (1.5s)';
    }
    console.warn(`[Google Auth] Erro na verificação online: ${errMsg}. Efetuando validação offline como fallback...`);
    try {
      const jwt = require('jsonwebtoken');
      const payload = jwt.decode(credential);
      if (payload && payload.email) {
        console.log(`[Google Auth] Token descodificado offline com sucesso. Email: ${payload.email}`);
        return payload;
      } else {
        console.error(`[Google Auth] Falha ao decodificar token offline ou email ausente. Payload:`, payload);
      }
    } catch (decodeErr) {
      console.error(`[Google Auth] Erro ao decodificar token offline:`, decodeErr);
    }
    throw err;
  }
}

function getBaseDirectory(req) {
  const gameServerId = req ? (req.query.gameServerId || req.body.gameServerId) : null;
  if (gameServerId) {
    return dockerService.getGameServerDir(gameServerId);
  }

  const sitePath = req ? (req.query.sitePath || req.body.sitePath) : null;
  if (sitePath) {
    return sitePath;
  }

  if (isLinux) {
    return '/var/www';
  } else {
    return getSystemPath('www');
  }
}

function resolveSafePath(relativeOrAbsolutePath, req) {
  const baseDir = getBaseDirectory(req);
  let targetPath = relativeOrAbsolutePath || '';
  if (!path.isAbsolute(targetPath)) {
    targetPath = path.join(baseDir, targetPath);
  }
  return path.resolve(targetPath);
}

// Configuração do Multer para Uploads no Gerenciador de Arquivos
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const rawPath = req.query.path || req.body.path || '';
    const targetDir = resolveSafePath(rawPath, req);
    if (!fs.existsSync(targetDir)) {
      try {
        fs.mkdirSync(targetDir, { recursive: true });
      } catch (err) {
        return cb(new Error('Erro ao criar diretório de destino: ' + err.message));
      }
    }
    cb(null, targetDir);
  },
  filename: function (req, file, cb) {
    // Mantém o nome original do arquivo
    cb(null, file.originalname);
  }
});
const upload = multer({ storage: storage });

// Helper to fetch JSON in Node.js
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 3000
    };
    https.get(url, options, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Status Code: ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// Histórico de Logins com Geolocalização e Deteção de Locais Desconhecidos
async function logUserLogin(userId, username, req) {
  try {
    const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const ip = rawIp.replace('::ffff:', '').trim();
    const location = await getIpLocation(ip);
    const userAgent = req.headers['user-agent'] || '';
    const parsedAgent = parseUserAgent(userAgent);

    // Verifica se este local ou IP já foi usado por este utilizador antes
    const existing = db.prepare('SELECT count(*) as count FROM login_history WHERE user_id = ? AND (ip_address = ? OR location = ?)')
      .get(userId, ip, location);

    const isUnknown = existing.count === 0 ? 1 : 0;

    // Se for desconhecido e não for o localhost/rede local, gera aviso de segurança no painel
    if (isUnknown === 1 && location !== 'Rede Local / Localhost') {
      const timestamp = new Date().toLocaleString('pt-PT');
      db.prepare("INSERT INTO logs (type, message) VALUES ('security', ?)")
        .run(`[${timestamp}] ⚠️ Acesso suspeito detectado para o utilizador ${username} a partir de local desconhecido: ${location} (IP: ${ip})`);
    }

    // Grava no histórico de login
    db.prepare('INSERT INTO login_history (user_id, ip_address, location, user_agent, is_unknown_location) VALUES (?, ?, ?, ?, ?)')
      .run(userId, ip, location, parsedAgent, isUnknown);
  } catch (err) {
    console.error('Erro ao registrar histórico de login:', err);
  }
}

// ==========================================
// ROTAS DE AUTENTICAÇÃO
// ==========================================

// Configuração pública para a página de login (não requer autenticação).
// Expõe o Client ID do Google para o frontend inicializar o Google Sign-In.
router.get('/auth/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID });
});

// Rate Limiter em memória para prevenção de ataques de brute-force nos endpoints de autenticação
const rateLimits = new Map();
function loginRateLimiter(limit = 10, windowMs = 60000) {
  return (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const now = Date.now();

    if (!rateLimits.has(ip)) {
      rateLimits.set(ip, []);
    }

    let requests = rateLimits.get(ip).filter(timestamp => now - timestamp < windowMs);
    if (requests.length >= limit) {
      return res.status(429).json({ error: 'Muitas tentativas de login de seguida. Por favor, tente novamente após 1 minuto.' });
    }

    requests.push(now);
    rateLimits.set(ip, requests);
    next();
  };
}

// Login no painel
router.post('/auth/login', loginRateLimiter(10, 60000), (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      // Executa compare fictício para evitar Timing Attacks de enumeração de utilizadores
      bcrypt.compareSync(password, '$2b$10$dummyhashplaceholderstoreinconfig1234567890123456789012');
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const passwordIsValid = bcrypt.compareSync(password, user.password);
    if (!passwordIsValid) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // Se o 2FA estiver ativado para este utilizador, retorna necessidade de 2FA
    if (user.two_factor_enabled === 1) {
      const tempToken = jwt.sign({ tempUserId: user.id }, JWT_SECRET, { expiresIn: '5m' });
      return res.json({ need2FA: true, tempToken });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, {
      expiresIn: '24h' // Sessão expira em 24 horas
    });

    logUserLogin(user.id, user.username, req);

    res.json({ token, username: user.username, role: user.role });
  } catch (error) {
    res.status(500).json({ error: 'Erro no servidor: ' + error.message });
  }
});

// Login no painel com o Google
router.post('/auth/google-login', loginRateLimiter(10, 60000), async (req, res) => {
  const { credential } = req.body;
  if (!credential) {
    console.error('[Google Auth Login] Nenhum credential enviado.');
    return res.status(400).json({ error: 'Token do Google não fornecido.' });
  }

  try {
    console.log('[Google Auth Login] Recebida requisição de login Google.');
    const payload = await verifyGoogleIdToken(credential);
    const email = String(payload.email || "").toLowerCase().trim();
    console.log(`[Google Auth Login] Email do payload: ${email}`);

    const user = db.prepare('SELECT * FROM users WHERE LOWER(gmail) = ?').get(email);
    if (!user) {
      console.warn(`[Google Auth Login] Nenhum utilizador associado ao Gmail: ${email}`);
      return res.status(401).json({ 
        error: `Esta conta Google (${email}) não está associada a nenhum utilizador do BCP. Aceda com utilizador/palavra-passe e associe o seu Gmail no seu perfil.` 
      });
    }

    console.log(`[Google Auth Login] Utilizador encontrado: ${user.username} (ID: ${user.id})`);

    // Se o 2FA estiver ativado para este utilizador, retorna necessidade de 2FA
    if (user.two_factor_enabled === 1) {
      console.log(`[Google Auth Login] Utilizador ${user.username} tem 2FA ativado.`);
      const tempToken = jwt.sign({ tempUserId: user.id }, JWT_SECRET, { expiresIn: '5m' });
      return res.json({ need2FA: true, tempToken });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, {
      expiresIn: '24h'
    });

    logUserLogin(user.id, user.username, req);

    console.log(`[Google Auth Login] Sessão criada com sucesso para ${user.username}.`);
    res.json({ token, username: user.username, role: user.role });
  } catch (error) {
    console.error('[Google Auth Login] Falha geral de login:', error);
    res.status(400).json({ error: 'Falha na autenticação com Google: ' + error.message });
  }
});

// Verificar código 2FA no login
router.post('/auth/login-2fa', loginRateLimiter(10, 60000), (req, res) => {
  const { tempToken, code } = req.body;

  if (!tempToken || !code) {
    return res.status(400).json({ error: 'Token temporário e código 2FA são obrigatórios.' });
  }

  try {
    const decoded = jwt.verify(tempToken, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.tempUserId);
    
    if (!user) {
      return res.status(401).json({ error: 'Utilizador inválido.' });
    }

    const isVerified = totp.verifyTOTP(code, user.two_factor_secret);
    if (!isVerified) {
      return res.status(400).json({ error: 'Código 2FA incorreto ou expirado.' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, {
      expiresIn: '24h'
    });

    logUserLogin(user.id, user.username, req);

    res.json({ token, username: user.username, role: user.role });
  } catch (error) {
    res.status(400).json({ error: 'Token temporário inválido ou expirado.' });
  }
});

// Obter histórico de logins do utilizador logado
router.get('/auth/login-history', authenticateToken, (req, res) => {
  try {
    const history = db.prepare('SELECT ip_address, location, user_agent, is_unknown_location, created_at FROM login_history WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(req.user.id);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao carregar histórico de logins: ' + error.message });
  }
});

// Configurar/Ativar 2FA (Etapa 1: gerar segredo e URL do QR Code)
router.post('/auth/2fa/setup', authenticateToken, (req, res) => {
  try {
    const secret = totp.generateSecret();
    db.prepare('UPDATE users SET two_factor_secret = ? WHERE id = ?').run(secret, req.user.id);
    
    const qrUrl = `otpauth://totp/BestCodeCP:${req.user.username}?secret=${secret}&issuer=BestCodeCP`;
    res.json({ secret, qrUrl });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao configurar 2FA: ' + error.message });
  }
});

// Ativar 2FA (Etapa 2: verificar código de teste e confirmar ativação)
router.post('/auth/2fa/enable', authenticateToken, (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Código de verificação é obrigatório.' });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user.two_factor_secret) {
      return res.status(400).json({ error: '2FA não foi iniciado. Execute o setup primeiro.' });
    }

    const isVerified = totp.verifyTOTP(code, user.two_factor_secret);
    if (!isVerified) {
      return res.status(400).json({ error: 'Código 2FA de teste incorreto.' });
    }

    db.prepare('UPDATE users SET two_factor_enabled = 1 WHERE id = ?').run(req.user.id);
    res.json({ message: 'Autenticação de Dois Fatores (2FA) ativada com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao ativar 2FA: ' + error.message });
  }
});

// Desativar 2FA
router.post('/auth/2fa/disable', authenticateToken, (req, res) => {
  try {
    db.prepare('UPDATE users SET two_factor_enabled = 0, two_factor_secret = NULL WHERE id = ?').run(req.user.id);
    res.json({ message: 'Autenticação de Dois Fatores (2FA) desativada com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao desativar 2FA: ' + error.message });
  }
});

// Verificar estado de 2FA do utilizador logado
router.get('/auth/2fa/status', authenticateToken, (req, res) => {
  try {
    const user = db.prepare('SELECT two_factor_enabled FROM users WHERE id = ?').get(req.user.id);
    res.json({ enabled: user.two_factor_enabled === 1 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verificar se o painel precisa de setup inicial (Mecanismo depreciado pois root é auto-criado)
router.get('/auth/need-setup', (req, res) => {
  res.json({ needSetup: false });
});

// ==========================================
// ROTAS DE WEBSITES (Protegidas)
// ==========================================
router.get('/sites', authenticateToken, siteController.getSites);
router.post('/sites/create', authenticateToken, siteController.createSite);
router.post('/sites/delete', authenticateToken, siteController.deleteSite);
router.post('/sites/ssl', authenticateToken, siteController.toggleSSL);
router.post('/sites/ssl-cloudflare', authenticateToken, siteController.enableCloudflareSSL);
router.get('/sites/config', authenticateToken, siteController.getSiteConfig);
router.post('/sites/config', authenticateToken, siteController.saveSiteConfig);

// ==========================================
// ROTAS DE BANCO DE DADOS (Protegidas)
// ==========================================
router.get('/databases', authenticateToken, dbController.getDatabases);
router.post('/databases/create', authenticateToken, dbController.createDatabase);
router.post('/databases/delete', authenticateToken, dbController.deleteDatabase);
router.post('/databases/sso', authenticateToken, dbController.generateSsoToken);
router.post('/databases/change-password', authenticateToken, dbController.changeDatabasePassword);

// ==========================================
// ROTAS DE CONTAS DE EMAIL (Protegidas)
// ==========================================
router.get('/emails', authenticateToken, mailController.getEmails);
router.post('/emails/create', authenticateToken, mailController.createEmail);
router.post('/emails/delete', authenticateToken, mailController.deleteEmail);
router.get('/emails/dns', authenticateToken, mailController.getEmailDnsRecords);
router.post('/emails/change-password', authenticateToken, mailController.changeMailPassword);
router.post('/emails/change-quota', authenticateToken, mailController.changeMailQuota);

// ==========================================
// ROTAS DO GERENCIADOR DE ARQUIVOS (Protegidas)
// ==========================================
router.get('/files/list', authenticateToken, fileController.listFiles);
router.get('/files/read', authenticateToken, fileController.readFileContent);
router.get('/files/download', authenticateToken, fileController.downloadFile);
router.post('/files/save', authenticateToken, fileController.saveFileContent);
router.post('/files/create', authenticateToken, fileController.createItem);
router.post('/files/delete', authenticateToken, fileController.deleteItem);
router.post('/files/rename', authenticateToken, fileController.renameItem);
router.post('/files/permissions', authenticateToken, fileController.changePermissions);
router.post('/files/compress', authenticateToken, fileController.compressItems);
router.post('/files/extract', authenticateToken, fileController.extractItem);
router.post('/files/upload', authenticateToken, upload.single('file'), (req, res) => {
  res.json({ message: 'Arquivo carregado com sucesso!', file: req.file });
});

// ==========================================
// ROTAS DE NÓS DE SERVIDOR (Protegidas)
// ==========================================
router.get('/nodes', authenticateToken, async (req, res) => {
  try {
    const list = db.prepare('SELECT * FROM system_nodes ORDER BY created_at DESC').all();
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/nodes/create', authenticateToken, async (req, res) => {
  const { name, ipAddress, apiPort, daemonTokenSecret } = req.body;
  if (!name || !ipAddress || !daemonTokenSecret) {
    return res.status(400).json({ error: 'Nome, IP e Segredo do Nó são obrigatórios.' });
  }
  
  try {
    db.prepare('INSERT INTO system_nodes (name, ip_address, api_port, daemon_token_secret) VALUES (?, ?, ?, ?)')
      .run(name, ipAddress, apiPort || 8080, daemonTokenSecret);
    res.json({ message: 'Nó de servidor registado com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/nodes/delete', authenticateToken, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'ID do nó é obrigatório.' });
  
  try {
    db.prepare('DELETE FROM system_nodes WHERE id = ?').run(id);
    res.json({ message: 'Nó removido do painel com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ROTAS DE CRON JOBS (Protegidas)
// ==========================================
router.get('/crons', authenticateToken, cronController.getCrons);
router.post('/crons/create', authenticateToken, cronController.createCron);
router.post('/crons/toggle', authenticateToken, cronController.toggleCron);
router.post('/crons/delete', authenticateToken, cronController.deleteCron);
router.post('/crons/run', authenticateToken, cronController.runCronImmediately);

// ==========================================
// ROTAS DE SERVIDORES DE JOGOS (Protegidas)
// ==========================================
router.get('/games', authenticateToken, gameController.getGames);
router.post('/games/create', authenticateToken, gameController.createGame);
router.post('/games/action', authenticateToken, gameController.controlGame);
router.post('/games/delete', authenticateToken, gameController.deleteGame);
router.get('/games/:id/console', authenticateToken, gameController.getConsoleConfig);

// ==========================================
// ROTAS DE MONITORAMENTO E SEGURANÇA (Protegidas)
// ==========================================
router.get('/monitor/logs', authenticateToken, monitorController.getLogs);
router.get('/monitor/security', authenticateToken, monitorController.getSecurityStatus);
router.post('/monitor/firewall', authenticateToken, monitorController.toggleFirewallPort);
router.get('/monitor/firewall/rules', authenticateToken, monitorController.getFirewallRules);
router.post('/monitor/firewall/delete', authenticateToken, monitorController.deleteFirewallRule);

router.get('/terminal/history', authenticateToken, (req, res) => {
  const fs = require('fs');
  const path = require('path');
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const offset = parseInt(req.query.offset, 10) || 0;

    const logFilePath = path.resolve(__dirname, '../../temp/terminal.log');
    if (!fs.existsSync(logFilePath)) {
      return res.json({ lines: [], hasMore: false });
    }

    const content = fs.readFileSync(logFilePath, 'utf8');
    const lines = content.split('\n').filter(line => line.length > 0);
    
    const endIndex = lines.length - offset;
    const startIndex = Math.max(0, endIndex - limit);

    if (startIndex >= endIndex) {
      return res.json({ lines: [], hasMore: false });
    }

    const slicedLines = lines.slice(startIndex, endIndex);
    const hasMore = startIndex > 0;

    res.json({
      lines: slicedLines,
      hasMore
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar histórico do terminal: ' + error.message });
  }
});

// ==========================================
// ROTAS DE GERENCIAMENTO DE PROCESSOS (Protegidas)
// ==========================================
router.get('/system/processes', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const { exec } = require('child_process');
  const isWin = process.platform === 'win32';

  if (isWin) {
    return res.json({
      processes: [
        { pid: 1024, user: 'SYSTEM', cpu: 1.2, mem: 4.5, stat: 'Sl', isQuarantined: false, crashRisk: false, name: 'node.exe' },
        { pid: 2048, user: 'Deyvi', cpu: 96.5, mem: 2.1, stat: 'R', isQuarantined: false, crashRisk: true, name: 'hogger_process.exe' },
        { pid: 3096, user: 'Deyvi', cpu: 0.0, mem: 8.3, stat: 'T', isQuarantined: true, crashRisk: false, name: 'suspended_process.exe' },
        { pid: 4012, user: 'SYSTEM', cpu: 0.1, mem: 0.2, stat: 'Ss', isQuarantined: false, crashRisk: false, name: 'svchost.exe' }
      ],
      sentinelEnabled: autoQuarantineEnabled
    });
  }

  exec('ps -eo pid,user,%cpu,%mem,stat,comm --sort=-%cpu | head -50', (error, stdout) => {
    if (error) {
      return res.status(500).json({ error: 'Erro ao listar processos: ' + error.message });
    }

    try {
      const lines = stdout.split('\n').filter(line => line.trim().length > 0);
      const processes = lines.slice(1).map(line => {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[0], 10);
        const user = parts[1];
        const cpu = parseFloat(parts[2]);
        const mem = parseFloat(parts[3]);
        const stat = parts[4] || '';
        const name = parts.slice(5).join(' ');

        const isQuarantined = stat.toUpperCase().startsWith('T');
        const crashRisk = (cpu > 70.0 || mem > 75.0);

        return {
          pid,
          user,
          cpu,
          mem,
          stat,
          isQuarantined,
          crashRisk,
          name
        };
      }).filter(p => !isNaN(p.pid));

      // Ordenar por consumo de recursos combinado (CPU + RAM) descrescente
      processes.sort((a, b) => (b.cpu + b.mem) - (a.cpu + a.mem));

      res.json({
        processes,
        sentinelEnabled: autoQuarantineEnabled
      });
    } catch (e) {
      res.status(500).json({ error: 'Erro ao processar lista de processos: ' + e.message });
    }
  });
});

router.post('/system/processes/kill', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const { pid } = req.body;
  if (!pid) {
    return res.status(400).json({ error: 'PID do processo é obrigatório.' });
  }

  try {
    process.kill(pid, 'SIGKILL');
    res.json({ message: `Processo ${pid} terminado com sucesso.` });
  } catch (error) {
    const { exec } = require('child_process');
    exec(`sudo kill -9 ${pid}`, (err) => {
      if (err) {
        return res.status(500).json({ error: `Falha ao terminar processo ${pid}: ` + err.message });
      }
      res.json({ message: `Processo ${pid} terminado via CLI.` });
    });
  }
});

router.post('/system/processes/quarantine', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const { pid } = req.body;
  if (!pid) {
    return res.status(400).json({ error: 'PID do processo é obrigatório.' });
  }

  try {
    process.kill(pid, 'SIGSTOP');
    res.json({ message: `Processo ${pid} colocado em quarentena (suspenso).` });
  } catch (error) {
    const { exec } = require('child_process');
    exec(`sudo kill -STOP ${pid}`, (err) => {
      if (err) {
        return res.status(500).json({ error: `Falha ao suspender processo ${pid}: ` + err.message });
      }
      res.json({ message: `Processo ${pid} suspenso via CLI.` });
    });
  }
});

router.post('/system/processes/resume', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const { pid } = req.body;
  if (!pid) {
    return res.status(400).json({ error: 'PID do processo é obrigatório.' });
  }

  try {
    process.kill(pid, 'SIGCONT');
    res.json({ message: `Processo ${pid} retirado da quarentena (retomado).` });
  } catch (error) {
    const { exec } = require('child_process');
    exec(`sudo kill -CONT ${pid}`, (err) => {
      if (err) {
        return res.status(500).json({ error: `Falha ao retomar processo ${pid}: ` + err.message });
      }
      res.json({ message: `Processo ${pid} retomar via CLI.` });
    });
  }
});

router.post('/system/processes/sentinel', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }
  const { enabled } = req.body;
  if (enabled === undefined) {
    return res.status(400).json({ error: 'Parâmetro enabled é obrigatório.' });
  }
  autoQuarantineEnabled = !!enabled;
  res.json({ 
    message: `Sentinela Anti-Crash ${autoQuarantineEnabled ? 'ativado' : 'desativado'} com sucesso.`,
    enabled: autoQuarantineEnabled
  });
});

// ==========================================
// ROTAS DE GERENCIAMENTO DE UTILIZADORES (Sub-contas - Protegidas)
// ==========================================
router.get('/users', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado. Apenas administradores.' });
  }
  try {
    const users = db.prepare('SELECT id, username, role, two_factor_enabled, created_at FROM users').all();
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar utilizadores: ' + error.message });
  }
});

router.post('/users/create', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado. Apenas administradores.' });
  }
  const { username, password, role } = req.body;
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'Utilizador, senha e função são obrigatórios.' });
  }
  try {
    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(password, salt);
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)')
      .run(username, hashedPassword, role);
    res.json({ message: `Utilizador ${username} criado com sucesso!` });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar utilizador: ' + error.message });
  }
});

router.post('/users/delete', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado. Apenas administradores.' });
  }
  const { id } = req.body;
  if (id === req.user.id) {
    return res.status(400).json({ error: 'Não pode excluir a si mesmo.' });
  }
  try {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    redisClient.del(`bcp:profile:${id}`);
    res.json({ message: 'Utilizador excluído com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao excluir utilizador: ' + error.message });
  }
});

router.post('/users/reset-password', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado. Apenas administradores.' });
  }
  const { id, newPassword } = req.body;
  if (!id || !newPassword) {
    return res.status(400).json({ error: 'ID do utilizador e nova senha são obrigatórios.' });
  }
  try {
    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(newPassword, salt);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPassword, id);
    redisClient.del(`bcp:profile:${id}`);
    res.json({ message: 'Senha do utilizador redefinida com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao redefinir senha: ' + error.message });
  }
});

// ==========================================
// ROTAS DE PERFIL DE UTILIZADOR (Protegidas)
// ==========================================
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const cacheKey = `bcp:profile:${req.user.id}`;
    let cachedProfile = null;
    
    if (redisClient.isReady) {
      const data = await redisClient.get(cacheKey);
      if (data) {
        cachedProfile = JSON.parse(data);
      }
    }

    if (cachedProfile) {
      return res.json(cachedProfile);
    }

    const user = db.prepare('SELECT id, username, role, gmail, avatar_url FROM users WHERE id = ?').get(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Utilizador não encontrado.' });
    }
    const crypto = require('crypto');
    let avatarUrl = user.avatar_url || '';
    if (!avatarUrl && user.gmail) {
      const hash = crypto.createHash('md5').update(user.gmail.trim().toLowerCase()).digest('hex');
      avatarUrl = `https://www.gravatar.com/avatar/${hash}?d=identicon&s=150`;
    }

    const pmaPath = process.env.PMA_PATH || '/phpmyadmin';
    const profileData = { id: user.id, username: user.username, role: user.role, gmail: user.gmail, avatarUrl, pmaPath };
    
    if (redisClient.isReady) {
      await redisClient.setEx(cacheKey, 3600, JSON.stringify(profileData)); // Cache por 1 hora
    }

    res.json(profileData);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao carregar perfil: ' + error.message });
  }
});

router.post('/profile/password', authenticateToken, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Palavra-passe atual e nova palavra-passe são obrigatórias.' });
  }
  try {
    const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.user.id);
    const match = bcrypt.compareSync(currentPassword, user.password);
    if (!match) {
      return res.status(400).json({ error: 'A palavra-passe atual está incorreta.' });
    }
    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(newPassword, salt);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPassword, req.user.id);
    redisClient.del(`bcp:profile:${req.user.id}`);
    res.json({ message: 'Palavra-passe alterada com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao alterar palavra-passe: ' + error.message });
  }
});

router.post('/profile/gmail', authenticateToken, async (req, res) => {
  const { credential, gmail } = req.body;

  try {
    // Se for fornecido um credential do Google, valida e extrai e-mail e avatar
    if (credential) {
      const payload = await verifyGoogleIdToken(credential);
      const email = payload.email;
      const picture = payload.picture || '';

      db.prepare('UPDATE users SET gmail = ?, avatar_url = ? WHERE id = ?').run(email, picture, req.user.id);
      redisClient.del(`bcp:profile:${req.user.id}`);
      
      return res.json({ 
        message: 'Conta Gmail associada com sucesso!', 
        gmail: email, 
        avatarUrl: picture 
      });
    }

    // Se gmail for explicitamente nulo ou vazio, remove a associação
    if (gmail === null || gmail === undefined || gmail === '') {
      db.prepare('UPDATE users SET gmail = NULL, avatar_url = NULL WHERE id = ?').run(req.user.id);
      redisClient.del(`bcp:profile:${req.user.id}`);
      return res.json({ 
        message: 'Conta Gmail desassociada com sucesso!', 
        gmail: null, 
        avatarUrl: '' 
      });
    }

    if (gmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gmail)) {
      return res.status(400).json({ error: 'Formato de e-mail inválido.' });
    }

    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update(gmail.trim().toLowerCase()).digest('hex');
    const avatarUrl = `https://www.gravatar.com/avatar/${hash}?d=identicon&s=150`;

    db.prepare('UPDATE users SET gmail = ?, avatar_url = ? WHERE id = ?').run(gmail, avatarUrl, req.user.id);
    redisClient.del(`bcp:profile:${req.user.id}`);
    res.json({ message: 'Conta Gmail associada com sucesso!', gmail, avatarUrl });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao associar Gmail: ' + error.message });
  }
});

// ==========================================
// ROTAS DE SISTEMA & VERSIONAMENTO (Protegidas)
// ==========================================

// Obter versão local, remota e verificar se há atualizações no GitHub
router.get('/system/version', authenticateToken, async (req, res) => {
  try {
    const packageJson = require('../../package.json');
    const localVersion = packageJson.version || '1.0.0';

    let repoUrl = '';
    try {
      repoUrl = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    } catch (e) {
      // Ignora falha de git
    }

    let repoPath = 'Crazed0/bestcode-cp'; // Repositório padrão
    if (repoUrl) {
      const match = repoUrl.match(/github\.com[:\/]([^/]+)\/([^.]+)/);
      if (match) {
        repoPath = `${match[1]}/${match[2]}`;
      }
    }

    // Commit local atualmente implantado (o deploy usa git reset --hard origin/main)
    let localCommit = '';
    try {
      localCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    } catch (e) {
      // Ignora falha de git
    }

    // Commit mais recente no GitHub (branch main). Deteta QUALQUER commit novo,
    // mesmo que a versão no package.json não tenha sido incrementada.
    let remoteCommit = '';
    try {
      const commitData = await fetchJson(`https://api.github.com/repos/${repoPath}/commits/main`);
      remoteCommit = (commitData && commitData.sha) ? commitData.sha : '';
    } catch (e) {
      console.warn(`[UPDATE CHECK] Falha ao consultar commits do GitHub (${repoPath}):`, e.message);
    }

    // Versão remota (apenas informativa, best-effort)
    let remoteVersion = localVersion;
    try {
      const remoteData = await fetchJson(`https://raw.githubusercontent.com/${repoPath}/main/backend/package.json`);
      if (remoteData && remoteData.version) remoteVersion = remoteData.version;
    } catch (e) {
      // Sem versão remota não é crítico; a deteção baseia-se no commit
    }

    // Há atualização se tivermos ambos os commits e forem diferentes.
    // Fallback (sem git/SHA): compara as versões do package.json.
    let updateAvailable;
    if (localCommit && remoteCommit) {
      updateAvailable = localCommit !== remoteCommit;
    } else {
      updateAvailable = remoteVersion !== localVersion;
    }

    res.json({
      localVersion,
      remoteVersion,
      localCommit: localCommit ? localCommit.substring(0, 7) : null,
      remoteCommit: remoteCommit ? remoteCommit.substring(0, 7) : null,
      updateAvailable
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao verificar versão do painel: ' + error.message });
  }
});

// Endpoint administrativo para disparar a atualização do painel
router.post('/system/update', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem atualizar o painel.' });
  }

  try {
    const { spawn } = require('child_process');
    const scriptPath = path.resolve(__dirname, '../../../scripts/update.sh');

    if (!fs.existsSync(scriptPath)) {
      return res.status(404).json({ error: 'Script de atualização não encontrado no host.' });
    }

    // Executa o script em background de forma desconectada via sudo
    const child = spawn('sudo', [scriptPath], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    res.json({ message: 'Atualização do painel iniciada em background. O painel reiniciará em breves instantes.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao disparar processo de atualização: ' + error.message });
  }
});

module.exports = router;
