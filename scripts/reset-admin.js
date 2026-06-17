const path = require('path');
const bcrypt = require('bcryptjs');

// Configura o caminho relativo para o banco de dados
const db = require('../backend/src/config/db');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('\x1b[33mUso: node reset-admin.js <username> <nova_senha>\x1b[0m');
  process.exit(1);
}

const username = args[0];
const newPassword = args[1];

try {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    console.error(`\x1b[31mErro: Utilizador "${username}" não encontrado.\x1b[0m`);
    process.exit(1);
  }

  const salt = bcrypt.genSaltSync(10);
  const hashedPassword = bcrypt.hashSync(newPassword, salt);

  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPassword, user.id);
  console.log(`\x1b[32mSucesso: Palavra-passe do utilizador "${username}" redefinida com sucesso!\x1b[0m`);
} catch (err) {
  console.error('\x1b[31mErro ao redefinir palavra-passe:\x1b[0m', err.message);
  process.exit(1);
}
