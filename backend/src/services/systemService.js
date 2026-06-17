const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

const isLinux = process.platform === 'linux';

// Pastas de simulação para Windows
const MOCK_DIRS = {
  nginx: path.resolve(__dirname, '../../temp/etc/nginx/sites-available'),
  nginxEnabled: path.resolve(__dirname, '../../temp/etc/nginx/sites-enabled'),
  www: path.resolve(__dirname, '../../temp/var/www'),
  mail: path.resolve(__dirname, '../../temp/etc/postfix'),
  cron: path.resolve(__dirname, '../../temp/var/spool/cron')
};

// Inicializa diretórios mock no Windows
async function initMockDirs() {
  if (!isLinux) {
    for (const dir of Object.values(MOCK_DIRS)) {
      await fs.mkdir(dir, { recursive: true });
    }
  }
}
initMockDirs().catch(console.error);

/**
 * Executa comandos no terminal de forma segura.
 * No Windows, intercepta e simula respostas para comandos específicos do Linux.
 */
function execCommand(command) {
  return new Promise((resolve, reject) => {
    if (!isLinux) {
      console.log(`[MOCK EXEC] ${command}`);
      // Simulações de comandos comuns
      if (command.includes('systemctl status') || command.includes('service')) {
        return resolve({ stdout: 'active (running)', stderr: '' });
      }
      if (command.includes('ufw status')) {
        return resolve({ stdout: 'Status: active\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW       Anywhere\n80/tcp                     ALLOW       Anywhere\n443/tcp                    ALLOW       Anywhere', stderr: '' });
      }
      if (command.includes('fail2ban-client')) {
        return resolve({ stdout: 'Status for the jail: nginx-http-auth\n|- Filter\n|  |- Currently failed:\t0\n|  |- Total failed:\t12\n|  `- File list:\t/var/log/nginx/error.log\n`- Actions\n   |- Currently banned:\t1\n   |- Total banned:\t3\n   `- Banned IP list:\t192.168.1.100', stderr: '' });
      }
      if (command.includes('mysql -u') || command.includes('mariadb')) {
        return resolve({ stdout: 'Query OK, 1 row affected', stderr: '' });
      }
      return resolve({ stdout: `Success mock execution for: ${command}`, stderr: '' });
    }

    let cmdToRun = command;
    try {
      const os = require('os');
      const currentUser = os.userInfo().username;
      if (currentUser !== 'root') {
        const privilegedCmds = ['systemctl', 'ufw', 'fail2ban-client', 'certbot', 'nginx', 'mysql', 'mariadb', 'chown', 'rm', 'crontab', 'ln'];
        const trimmed = command.trim();
        const firstWord = trimmed.split(' ')[0];
        if (privilegedCmds.includes(firstWord) && !trimmed.startsWith('sudo')) {
          cmdToRun = 'sudo ' + command;
        }
      }
    } catch (e) {}

    exec(cmdToRun, (error, stdout, stderr) => {
      if (error) {
        resolve({ error, stdout, stderr });
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Reinicia serviços do sistema
 */
async function restartService(serviceName) {
  if (isLinux) {
    const result = await execCommand(`systemctl restart ${serviceName}`);
    if (result.error) {
      throw new Error(`Falha ao reiniciar o serviço ${serviceName}: ${result.stderr || result.error.message}`);
    }
    return true;
  } else {
    console.log(`[MOCK RESTART] Serviço: ${serviceName}`);
    return true;
  }
}

/**
 * Recarrega a configuração de um serviço (graceful reload)
 */
async function reloadService(serviceName) {
  if (isLinux) {
    const result = await execCommand(`systemctl reload ${serviceName}`);
    if (result.error) {
      // Se falhar o reload (ex: serviço não suporta), faz restart como fallback
      return restartService(serviceName);
    }
    return true;
  } else {
    console.log(`[MOCK RELOAD] Serviço: ${serviceName}`);
    return true;
  }
}

/**
 * Retorna o caminho real ou o mock para configurações
 */
function getSystemPath(type, domain = '') {
  if (isLinux) {
    switch (type) {
      case 'nginx-avail': return `/etc/nginx/sites-available/${domain}`;
      case 'nginx-enabled': return `/etc/nginx/sites-enabled/${domain}`;
      case 'www': return `/var/www/${domain}`;
      case 'mail-config': return `/etc/postfix/virtual_domains`;
      default: return '';
    }
  } else {
    switch (type) {
      case 'nginx-avail': return path.join(MOCK_DIRS.nginx, domain);
      case 'nginx-enabled': return path.join(MOCK_DIRS.nginxEnabled, domain);
      case 'www': return path.join(MOCK_DIRS.www, domain);
      case 'mail-config': return path.join(MOCK_DIRS.mail, 'virtual_domains');
      default: return '';
    }
  }
}

module.exports = {
  isLinux,
  execCommand,
  restartService,
  reloadService,
  getSystemPath,
  MOCK_DIRS
};
