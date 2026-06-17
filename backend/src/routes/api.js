const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const db = require('../config/db');
const { authenticateToken, JWT_SECRET } = require('../config/auth');
const totp = require('../config/totp');

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

async function verifyGoogleIdToken(credential) {
  if (!credential) throw new Error("Token do Google não fornecido");
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  if (!response.ok) {
    throw new Error("Falha ao validar token com a API do Google");
  }
  const payload = await response.json();
  const clientId = "375047373627-obmrc23n7gvntfm9dreu416rgvs9dj1p.apps.googleusercontent.com";
  if (payload.aud !== clientId) {
    throw new Error("Audiência do token incorreta");
  }
  return payload;
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

// ==========================================
// ROTAS DE AUTENTICAÇÃO
// ==========================================

// Login no painel
router.post('/auth/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
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

    res.json({ token, username: user.username, role: user.role });
  } catch (error) {
    res.status(500).json({ error: 'Erro no servidor: ' + error.message });
  }
});

// Login no painel com o Google
router.post('/auth/google-login', async (req, res) => {
  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ error: 'Token do Google não fornecido.' });
  }

  try {
    const payload = await verifyGoogleIdToken(credential);
    const email = String(payload.email || "").toLowerCase().trim();

    const user = db.prepare('SELECT * FROM users WHERE LOWER(gmail) = ?').get(email);
    if (!user) {
      return res.status(401).json({ 
        error: 'Esta conta Google não está associada a nenhum utilizador do BCP. Aceda com utilizador/palavra-passe e associe o seu Gmail no seu perfil.' 
      });
    }

    // Se o 2FA estiver ativado para este utilizador, retorna necessidade de 2FA
    if (user.two_factor_enabled === 1) {
      const tempToken = jwt.sign({ tempUserId: user.id }, JWT_SECRET, { expiresIn: '5m' });
      return res.json({ need2FA: true, tempToken });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, {
      expiresIn: '24h'
    });

    res.json({ token, username: user.username, role: user.role });
  } catch (error) {
    res.status(400).json({ error: 'Falha na autenticação com Google: ' + error.message });
  }
});

// Verificar código 2FA no login
router.post('/auth/login-2fa', (req, res) => {
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

    res.json({ token, username: user.username, role: user.role });
  } catch (error) {
    res.status(400).json({ error: 'Token temporário inválido ou expirado.' });
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

// ==========================================
// ROTAS DE MONITORAMENTO E SEGURANÇA (Protegidas)
// ==========================================
router.get('/monitor/logs', authenticateToken, monitorController.getLogs);
router.get('/monitor/security', authenticateToken, monitorController.getSecurityStatus);
router.post('/monitor/firewall', authenticateToken, monitorController.toggleFirewallPort);
router.get('/monitor/firewall/rules', authenticateToken, monitorController.getFirewallRules);
router.post('/monitor/firewall/delete', authenticateToken, monitorController.deleteFirewallRule);

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
    res.json({ message: 'Senha do utilizador redefinida com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao redefinir senha: ' + error.message });
  }
});

// ==========================================
// ROTAS DE PERFIL DE UTILIZADOR (Protegidas)
// ==========================================
router.get('/profile', authenticateToken, (req, res) => {
  try {
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
    res.json({ id: user.id, username: user.username, role: user.role, gmail: user.gmail, avatarUrl });
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
      
      return res.json({ 
        message: 'Conta Gmail associada com sucesso!', 
        gmail: email, 
        avatarUrl: picture 
      });
    }

    // Se gmail for explicitamente nulo ou vazio, remove a associação
    if (gmail === null || gmail === undefined || gmail === '') {
      db.prepare('UPDATE users SET gmail = NULL, avatar_url = NULL WHERE id = ?').run(req.user.id);
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
    res.json({ message: 'Conta Gmail associada com sucesso!', gmail, avatarUrl });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao associar Gmail: ' + error.message });
  }
});

module.exports = router;
