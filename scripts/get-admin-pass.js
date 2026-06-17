const fs = require('fs');
const path = require('path');

const bootInfoPath = path.resolve(__dirname, '../first-boot.txt');

if (fs.existsSync(bootInfoPath)) {
  const content = fs.readFileSync(bootInfoPath, 'utf8');
  console.log('\x1b[32m=== Credenciais Iniciais de Instalação ===\x1b[0m');
  console.log(content.trim());
  console.log('\x1b[32m==========================================\x1b[0m');
} else {
  console.log('\x1b[33mAviso: O ficheiro first-boot.txt com as credenciais originais já não existe.\x1b[0m');
  console.log('Se alterou a palavra-passe ou eliminou o ficheiro por segurança,');
  console.log('pode redefinir uma nova palavra-passe executando:');
  console.log('\x1b[36m👉 sudo bash scripts/reset-admin.sh root <nova_senha>\x1b[0m');
}
