const crypto = require('crypto');
const db = require('../config/db');
const { execCommand, isLinux } = require('../services/systemService');
const redisClient = require('../config/redis');

/**
 * Helper para executar comandos SQL no MySQL/MariaDB do servidor
 */
async function runMysqlQuery(sql) {
  if (isLinux) {
    // Passa o SQL via stdin (heredoc) para evitar injeções ou substituições indesejadas pelo bash (como crases/backticks)
    const result = await execCommand(`mysql -u root <<'EOF'\n${sql}\nEOF`);
    if (result.error) {
      throw new Error(`Erro no MySQL: ${result.stderr || result.error.message}`);
    }
    return result.stdout;
  } else {
    console.log(`[MOCK MYSQL QUERY]: ${sql}`);
    return 'Query OK, 0 rows affected';
  }
}

/**
 * Listar todos os bancos de dados
 */
async function getDatabases(req, res) {
  try {
    const list = db.prepare('SELECT id, db_name, db_user, created_at FROM databases ORDER BY created_at DESC').all();
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar bancos: ' + error.message });
  }
}

/**
 * Criar um novo banco de dados e usuário associado
 */
async function createDatabase(req, res) {
  const { dbName, dbUser, dbPass } = req.body;

  if (!dbName || !dbUser || !dbPass) {
    return res.status(400).json({ error: 'Nome do banco, usuário e senha são obrigatórios.' });
  }

  // Sanitização simples (apenas letras, números e underlines)
  const safeDbName = dbName.replace(/[^a-zA-Z0-9_]/g, '');
  const safeDbUser = dbUser.replace(/[^a-zA-Z0-9_]/g, '');

  if (!safeDbName || !safeDbUser) {
    return res.status(400).json({ error: 'Nome de banco ou usuário contém caracteres inválidos.' });
  }

  const reservedUsers = ['root', 'mysql', 'mariadb', 'admin', 'debian-sys-maint'];
  if (reservedUsers.includes(safeDbUser.toLowerCase())) {
    return res.status(400).json({ error: 'O nome de usuário root ou outros usuários reservados do sistema não podem ser criados.' });
  }

  try {
    const existing = db.prepare('SELECT id FROM databases WHERE db_name = ?').get(safeDbName);
    if (existing) {
      return res.status(400).json({ error: 'Este banco de dados já está cadastrado.' });
    }

    // 1. Criar o banco e o usuário no MySQL do sistema
    const sqlCommands = `
      CREATE DATABASE IF NOT EXISTS \`${safeDbName}\`;
      CREATE USER IF NOT EXISTS '${safeDbUser}'@'localhost' IDENTIFIED BY '${dbPass}';
      GRANT ALL PRIVILEGES ON \`${safeDbName}\`.* TO '${safeDbUser}'@'localhost';
      FLUSH PRIVILEGES;
    `;
    await runMysqlQuery(sqlCommands);

    // 2. Salvar no SQLite do painel
    db.prepare('INSERT INTO databases (db_name, db_user, db_pass) VALUES (?, ?, ?)')
      .run(safeDbName, safeDbUser, dbPass);

    res.json({ message: 'Banco de dados criado com sucesso!', dbName: safeDbName });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar banco de dados: ' + error.message });
  }
}

/**
 * Excluir banco de dados e seu usuário
 */
async function deleteDatabase(req, res) {
  const { id } = req.body;

  try {
    const dbRecord = db.prepare('SELECT * FROM databases WHERE id = ?').get(id);
    if (!dbRecord) {
      return res.status(404).json({ error: 'Banco de dados não encontrado.' });
    }

    const { db_name, db_user } = dbRecord;

    // 1. Deletar do MySQL do sistema
    const sqlCommands = [`DROP DATABASE IF EXISTS \`${db_name}\`;`];
    const reservedUsers = ['root', 'mysql', 'mariadb', 'admin', 'debian-sys-maint'];
    
    // Apenas remove o usuário MySQL associado se não for um usuário do sistema/root
    if (!reservedUsers.includes(db_user.toLowerCase())) {
      sqlCommands.push(`DROP USER IF EXISTS '${db_user}'@'localhost';`);
    }
    
    await runMysqlQuery(sqlCommands.join('\n'));

    // 2. Deletar do SQLite do painel
    db.prepare('DELETE FROM databases WHERE id = ?').run(id);

    res.json({ message: 'Banco de dados excluído com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao excluir banco de dados: ' + error.message });
  }
}

/**
 * Gerar Token SSO (Single Sign-On) para login automático no phpMyAdmin
 */
async function generateSsoToken(req, res) {
  const { id } = req.body;

  try {
    const dbRecord = db.prepare('SELECT * FROM databases WHERE id = ?').get(id);
    if (!dbRecord) {
      return res.status(404).json({ error: 'Banco de dados não encontrado.' });
    }

    // Gerar token randômico seguro
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 60 * 1000; // Expira em 60 segundos

    if (redisClient.isReady) {
      // Salva no Redis com TTL de 60 segundos
      const sessionData = JSON.stringify({
        db_user: dbRecord.db_user,
        db_pass: dbRecord.db_pass,
        expires_at: expiresAt
      });
      await redisClient.setEx(`bcp:sso:${token}`, 60, sessionData);
      console.log(`[REDIS] Token SSO gerado em memória: ${token}`);
    } else {
      // Fallback para SQLite
      db.prepare('INSERT INTO sso_sessions (token, db_user, db_pass, expires_at) VALUES (?, ?, ?, ?)')
        .run(token, dbRecord.db_user, dbRecord.db_pass, expiresAt);
      console.log(`[SQLITE] Token SSO gravado no banco de dados (fallback): ${token}`);
    }

    res.json({ token });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao gerar sessão do phpMyAdmin: ' + error.message });
  }
}

/**
 * Alterar a senha de um usuário de banco de dados
 */
async function changeDatabasePassword(req, res) {
  const { id, newPass } = req.body;

  if (!id || !newPass) {
    return res.status(400).json({ error: 'ID do banco e nova senha são obrigatórios.' });
  }

  try {
    const dbRecord = db.prepare('SELECT * FROM databases WHERE id = ?').get(id);
    if (!dbRecord) {
      return res.status(404).json({ error: 'Banco de dados não encontrado.' });
    }

    const { db_user } = dbRecord;

    // 1. Atualizar a senha no MySQL do sistema
    const sqlCommands = `
      ALTER USER '${db_user}'@'localhost' IDENTIFIED BY '${newPass}';
      FLUSH PRIVILEGES;
    `;
    await runMysqlQuery(sqlCommands);

    // 2. Atualizar no SQLite
    db.prepare('UPDATE databases SET db_pass = ? WHERE id = ?').run(newPass, id);

    res.json({ message: 'Senha do banco de dados alterada com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao alterar a senha: ' + error.message });
  }
}

module.exports = {
  getDatabases,
  createDatabase,
  deleteDatabase,
  generateSsoToken,
  changeDatabasePassword
};
