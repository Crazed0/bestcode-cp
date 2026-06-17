const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const dbPath = path.resolve(__dirname, '../../database.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

// Inicialização das tabelas
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin', -- 'admin', 'client'
    two_factor_secret TEXT DEFAULT NULL,
    two_factor_enabled INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT UNIQUE NOT NULL,
    root_path TEXT NOT NULL,
    php_version TEXT DEFAULT '8.2',
    ssl_enabled INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS databases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    db_name TEXT UNIQUE NOT NULL,
    db_user TEXT NOT NULL,
    db_pass TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_address TEXT UNIQUE NOT NULL,
    domain TEXT NOT NULL,
    password TEXT NOT NULL,
    quota_mb INTEGER DEFAULT 1024,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS crons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT NOT NULL,
    schedule TEXT NOT NULL,
    description TEXT,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sso_sessions (
    token TEXT PRIMARY KEY,
    db_user TEXT NOT NULL,
    db_pass TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL, -- 'system', 'nginx', 'mail', 'auth'
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS game_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    game_type TEXT NOT NULL,           -- 'minecraft', 'fivem', 'mta', 'cs2'
    container_id TEXT UNIQUE,          -- ID do container Docker
    host_port INTEGER NOT NULL,        -- Porta de entrada atribuída no host (ex: 25565)
    ram_limit_mb INTEGER NOT NULL,     -- Limite de memória RAM
    cpu_limit REAL DEFAULT 1.0,        -- Limite de CPU (ex: 1 core = 1.0)
    status TEXT DEFAULT 'stopped',     -- 'running', 'stopped', 'installing'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  CREATE INDEX IF NOT EXISTS idx_sites_domain ON sites(domain);
  CREATE INDEX IF NOT EXISTS idx_databases_db_name ON databases(db_name);
  CREATE INDEX IF NOT EXISTS idx_emails_address ON emails(email_address);
`);

// Adiciona coluna site_type de forma segura
try {
  db.exec("ALTER TABLE sites ADD COLUMN site_type TEXT DEFAULT 'php';");
} catch (e) {}

// Adiciona coluna app_port de forma segura
try {
  db.exec("ALTER TABLE sites ADD COLUMN app_port INTEGER DEFAULT NULL;");
} catch (e) {}

// Adiciona coluna gmail de forma segura na tabela de utilizadores
try {
  db.exec("ALTER TABLE users ADD COLUMN gmail TEXT DEFAULT NULL;");
} catch (e) {}

// Adiciona coluna avatar_url de forma segura na tabela de utilizadores
try {
  db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT NULL;");
} catch (e) {}

// Auto-inicialização do Administrador Root
try {
  const userCount = db.prepare('SELECT count(*) as total FROM users').get().total;
  if (userCount === 0) {
    // Gera uma palavra-passe aleatória segura
    const randomPass = 'BCP-' + crypto.randomBytes(3).toString('hex').toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(randomPass, salt);

    // Insere o utilizador 'root' como admin principal
    db.prepare("INSERT INTO users (username, password, role) VALUES ('root', ?, 'admin')").run(hashedPassword);

    // Salva as credenciais em um arquivo local para o instalador ler e exibir
    const bootInfoPath = path.resolve(__dirname, '../../first-boot.txt');
    fs.writeFileSync(bootInfoPath, `USER: root\nPASSWORD: ${randomPass}\n`, 'utf8');

    console.log(`\n===================================================`);
    console.log(`🔑 CREDENCIAIS DO ADMINISTRADOR INICIAL (ROOT)`);
    console.log(`👤 Utilizador: root`);
    console.log(`🔒 Palavra-passe: ${randomPass}`);
    console.log(`📂 Credenciais gravadas em: first-boot.txt`);
    console.log(`===================================================\n`);
  }
} catch (err) {
  console.error('Erro ao inicializar administrador padrão:', err);
}

module.exports = db;
