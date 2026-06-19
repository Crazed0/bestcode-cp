import { Client } from 'ssh2';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SSH_HOST = "38.19.201.33";
const SSH_USER = "root";
const SSH_PORT = 22;
const SSH_PATH = "/opt/bestcode-cp";

const privateKeyPath = path.join(os.homedir(), '.ssh', 'id_ed25519');

console.log("==================================================");
console.log("   Iniciando Deploy Direto via SSH (BestCode CP)  ");
console.log("==================================================");
console.log(`Servidor: ${SSH_USER}@${SSH_HOST}:${SSH_PORT}`);
console.log(`Destino:  ${SSH_PATH}`);
console.log("--------------------------------------------------\n");

async function main() {
  console.log("[1/3] A empacotar ficheiros do projeto (deploy.tar.gz)...");
  const archiveName = "deploy.tar.gz";
  try {
    if (fs.existsSync(archiveName)) fs.unlinkSync(archiveName);
    
    // Package backend, frontend, daemon
    execSync(`tar -czf ${archiveName} backend frontend daemon`, { stdio: 'inherit' });
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
      const remoteFile = path.join(SSH_PATH, archiveName).replace(/\\/g, '/');

      sftp.fastPut(localFile, remoteFile, {}, (uploadErr) => {
        if (uploadErr) {
          console.error("❌ Erro no envio SFTP: " + uploadErr.message);
          conn.end();
          if (fs.existsSync(archiveName)) fs.unlinkSync(archiveName);
          process.exit(1);
        }

        console.log("✓ Pacote transferido com sucesso.\n");
        
        console.log("[3/3] A instalar dependências e a reiniciar serviços no servidor...");
        // Command to extract, install backend dependencies, install daemon dependencies, and restart services
        const cmd = `cd ${SSH_PATH} && tar -xzf ${archiveName} && rm ${archiveName} && cd backend && npm install --omit=dev && cd ../daemon && npm install --omit=dev && systemctl restart bestcode-cp && systemctl restart bestcode-cp-daemon`;
        
        conn.exec(cmd, (execErr, stream) => {
          if (execErr) {
            console.error("❌ Erro ao executar comandos remotos: " + execErr.message);
            conn.end();
            if (fs.existsSync(archiveName)) fs.unlinkSync(archiveName);
            process.exit(1);
          }

          stream.on('close', (code) => {
            conn.end();
            if (fs.existsSync(archiveName)) fs.unlinkSync(archiveName);
            
            if (code === 0) {
              console.log("\n==================================================");
              console.log("✓ DEPLOY CONCLUÍDO COM SUCESSO!");
              console.log("==================================================");
              console.log("Se esta foi a sua primeira instalação, pode verificar a password em:");
              console.log("root@38.19.201.33 -> cat /opt/bestcode-cp/first-boot.txt\n");
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
