import { Client } from 'ssh2';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Coordenadas da máquina-alvo via env — SEM defaults reveladores no repo público.
// Define no shell antes do deploy:
//   export BCP_SSH_HOST=<ip-ou-domínio>
//   export BCP_SSH_USER=<user-com-sudo>
//   export BCP_SSH_PORT=<porta-ssh>
//   export BCP_SUDO_PASS=<password-do-sudo>   # opcional (NOPASSWD ignora)
const SSH_HOST = process.env.BCP_SSH_HOST;
const SSH_USER = process.env.BCP_SSH_USER;
const SSH_PORT = parseInt(process.env.BCP_SSH_PORT || "22", 10);
const SSH_PATH = "/opt/bestcode-cp";
const SUDO_PASS = process.env.BCP_SUDO_PASS || "";

if (!SSH_HOST || !SSH_USER) {
  console.error("❌ Faltam variáveis de ambiente obrigatórias.");
  console.error("   Define BCP_SSH_HOST e BCP_SSH_USER (e opcionalmente BCP_SSH_PORT, BCP_SUDO_PASS).");
  console.error("   Exemplo: BCP_SSH_HOST=meu.servidor BCP_SSH_USER=admin BCP_SSH_PORT=2222 BCP_SUDO_PASS='...' npm run deploy");
  process.exit(1);
}

const privateKeyPath = path.join(os.homedir(), '.ssh', 'id_ed25519');

console.log("==================================================");
console.log("   Iniciando Deploy Direto via SSH (BestCode CP)  ");
console.log("==================================================");
console.log(`Servidor: ${SSH_USER}@${SSH_HOST}:${SSH_PORT}`);
console.log(`Destino:  ${SSH_PATH}`);
console.log("--------------------------------------------------\n");

function bumpVersion() {
  // Incrementa automaticamente o patch da versão do painel (backend/package.json) a cada deploy.
  try {
    const pkgPath = path.resolve('backend', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const parts = (pkg.version || '1.0.0').split('.').map(n => parseInt(n, 10) || 0);
    while (parts.length < 3) parts.push(0);
    parts[2] += 1; // bump do patch
    const newVersion = parts.join('.');
    pkg.version = newVersion;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    console.log(`[Versão] ${newVersion} (incrementada automaticamente)\n`);
    return newVersion;
  } catch (e) {
    console.warn("⚠ Não foi possível incrementar a versão: " + e.message + "\n");
    return null;
  }
}

async function main() {
  console.log("[0/3] A incrementar versão do painel...");
  bumpVersion();

  console.log("[1/3] A empacotar ficheiros do projeto (deploy.tar.gz)...");
  const archiveName = "deploy.tar.gz";
  try {
    if (fs.existsSync(archiveName)) fs.unlinkSync(archiveName);
    
    // Package backend, frontend, daemon
    // Exclui dados de runtime do servidor para NÃO os sobrepor com os locais:
    //  - backend/temp        → histórico do terminal
    //  - backend/database.db* → base de dados SQLite (bds criadas, utilizadores, etc.)
    const excludes = [
      '--exclude="node_modules"',
      '--exclude="backend/temp"',
      '--exclude="backend/database.db"',
      '--exclude="backend/database.db-shm"',
      '--exclude="backend/database.db-wal"',
      '--exclude="backend/.jwt-secret"',
      '--exclude="backend/.secret-key"',
    ].join(' ');
    execSync(`tar -czf ${archiveName} ${excludes} backend frontend daemon`, { stdio: 'inherit' });
    console.log("✓ Pacote criado com sucesso.\n");
  } catch (error) {
    console.error("❌ Erro ao empacotar ficheiros: " + error.message);
    process.exit(1);
  }

  if (!fs.existsSync(privateKeyPath)) {
    console.error(`❌ Chave privada SSH não encontrada em: ${privateKeyPath}`);
    if (fs.existsSync(archiveName)) fs.unlinkSync(archiveName);
    process.exit(1);
  }
  const privateKey = fs.readFileSync(privateKeyPath);

  console.log("[2/3] A ligar ao servidor e a enviar ficheiros (SFTP)...");
  const conn = new Client();

  conn.on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) {
        console.error("❌ Erro ao abrir sessão SFTP: " + err.message);
        conn.end();
        if (fs.existsSync(archiveName)) fs.unlinkSync(archiveName);
        process.exit(1);
      }

      const localFile = path.resolve(archiveName);
      // O user SSH normalmente não escreve em /opt → envia para /tmp e o sudo move/extrai
      const remoteFile = `/tmp/${archiveName}`;

      sftp.fastPut(localFile, remoteFile, {}, (uploadErr) => {
        if (uploadErr) {
          console.error("❌ Erro no envio SFTP: " + uploadErr.message);
          conn.end();
          if (fs.existsSync(archiveName)) fs.unlinkSync(archiveName);
          process.exit(1);
        }

        console.log("✓ Pacote transferido com sucesso.\n");
        
        console.log("[3/3] A instalar dependências e a reiniciar serviços no servidor (via sudo)...");
        // Extrai, instala dependências e reinicia serviços — tudo via sudo (o user SSH não é root).
        const inner = `mkdir -p ${SSH_PATH} && mv /tmp/${archiveName} ${SSH_PATH}/ && cd ${SSH_PATH} && tar -xzf ${archiveName} && rm -f ${archiveName} && cd backend && PUPPETEER_SKIP_DOWNLOAD=true npm install --omit=dev && cd ../daemon && npm install --omit=dev && systemctl restart bestcode-cp && systemctl restart bestcode-cp-daemon`;
        const cmd = `sudo -S -p '' bash -c ${JSON.stringify(inner)}`;

        conn.exec(cmd, (execErr, stream) => {
          if (execErr) {
            console.error("❌ Erro ao executar comandos remotos: " + execErr.message);
            conn.end();
            if (fs.existsSync(archiveName)) fs.unlinkSync(archiveName);
            process.exit(1);
          }

          // Fornece a password ao sudo -S (lê do stdin). Se for NOPASSWD, é ignorada.
          if (SUDO_PASS) stream.write(SUDO_PASS + "\n");

          stream.on('close', (code) => {
            conn.end();
            if (fs.existsSync(archiveName)) fs.unlinkSync(archiveName);
            
            if (code === 0) {
              console.log("\n==================================================");
              console.log("✓ DEPLOY CONCLUÍDO COM SUCESSO!");
              console.log("==================================================");
              console.log("Se esta foi a sua primeira instalação, pode verificar a password em:");
              console.log(`ssh -p ${SSH_PORT} ${SSH_USER}@${SSH_HOST} "sudo cat /opt/bestcode-cp/first-boot.txt"\n`);
              process.exit(0);
            } else {
              console.error(`\n❌ Erro durante a execução remota (código: ${code})`);
              process.exit(1);
            }
          }).on('data', (data) => {
            process.stdout.write(data.toString());
          }).stderr.on('data', (data) => {
            process.stderr.write(data.toString());
          });
        });
      });
    });
  }).on('error', (err) => {
    console.error("❌ Falha na ligação SSH: " + err.message);
    if (fs.existsSync(archiveName)) fs.unlinkSync(archiveName);
    process.exit(1);
  }).connect({
    host: SSH_HOST,
    port: SSH_PORT,
    username: SSH_USER,
    privateKey: privateKey
  });
}

main().catch(console.error);
