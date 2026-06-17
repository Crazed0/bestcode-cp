const si = require('systeminformation');
const fs = require('fs').promises;
const path = require('path');
const { isLinux, execCommand } = require('../services/systemService');

// Cache para estatísticas de rede e disco anteriores
let prevRx = 0;
let prevTx = 0;
let lastTime = Date.now();
let cachedDisk = null;
let lastDiskQuery = 0;
let cachedSpecs = null;

/**
 * Obtém especificações estáticas do hardware e sistema
 */
async function getSystemSpecs() {
  if (cachedSpecs) return cachedSpecs;
  try {
    const cpu = await si.cpu();
    const os = await si.osInfo();
    const system = await si.system();
    const memory = await si.mem();
    
    cachedSpecs = {
      cpuModel: `${cpu.manufacturer} ${cpu.brand}`.trim(),
      cpuCores: `${cpu.physicalCores} Cores / ${cpu.cores} Threads`,
      cpuSpeed: `${cpu.speed} GHz`,
      osDistro: `${os.distro} (${os.arch})`,
      osKernel: os.kernel || os.release,
      ramTotal: (memory.total / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
      sysModel: `${system.manufacturer} ${system.model}`.trim()
    };
  } catch (err) {
    cachedSpecs = {
      cpuModel: 'Intel Core i7 / AMD Ryzen 5',
      cpuCores: '8 Cores / 16 Threads',
      cpuSpeed: '3.6 GHz',
      osDistro: 'Ubuntu 22.04 LTS (x64)',
      osKernel: '5.15.0-generic',
      ramTotal: '16.00 GB',
      sysModel: 'Generic Server'
    };
  }
  return cachedSpecs;
}

/**
 * Obtém o status dos serviços do sistema de forma otimizada (executa apenas 1 subprocesso)
 */
let cachedServices = null;
let lastServicesQuery = 0;

let phpServiceName = null;

async function detectPhpService() {
  if (phpServiceName) return phpServiceName;
  if (!isLinux) {
    phpServiceName = 'php8.2-fpm';
    return phpServiceName;
  }
  try {
    const res = await execCommand("systemctl list-units --type=service --all | grep -o -E 'php[0-9.]+-fpm' | head -n 1");
    const name = (res.stdout || '').trim();
    if (name) {
      phpServiceName = name;
    } else {
      phpServiceName = 'php-fpm';
    }
  } catch (err) {
    phpServiceName = 'php-fpm';
  }
  return phpServiceName;
}

async function getServicesStatus() {
  if (!isLinux) {
    // Simulação no Windows (tudo online)
    return { nginx: true, mysql: true, php: true, docker: true, postfix: true, dovecot: true };
  }
  try {
    const phpSrv = await detectPhpService();
    // Consulta todos os serviços de uma só vez para evitar sobrecarga de CPU
    const res = await execCommand(`systemctl is-active nginx mysql ${phpSrv} docker postfix dovecot`);
    const outputs = (res.stdout || '').split('\n').map(s => s.trim());
    return {
      nginx: outputs[0] === 'active',
      mysql: outputs[1] === 'active',
      php: outputs[2] === 'active',
      docker: outputs[3] === 'active',
      postfix: outputs[4] === 'active',
      dovecot: outputs[5] === 'active'
    };
  } catch (err) {
    return { nginx: false, mysql: false, php: false, docker: false, postfix: false, dovecot: false };
  }
}

async function getServicesStatusCached() {
  const now = Date.now();
  if (!cachedServices || (now - lastServicesQuery > 10000)) {
    cachedServices = await getServicesStatus();
    lastServicesQuery = now;
  }
  return cachedServices;
}

/**
 * Coleta todas as métricas do sistema de forma síncrona/assíncrona otimizada
 */
async function getSystemMetrics() {
  try {
    const cpuLoad = await si.currentLoad();
    const memory = await si.mem();
    const specs = await getSystemSpecs();
    const services = await getServicesStatusCached();
    
    // Otimização: Consulta o tamanho do disco a cada 30s para economizar I/O
    let disks = cachedDisk;
    const nowTime = Date.now();
    if (!cachedDisk || (nowTime - lastDiskQuery > 30000)) {
      try {
        disks = await si.fsSize();
        cachedDisk = disks;
        lastDiskQuery = nowTime;
      } catch (err) {
        disks = cachedDisk || [];
      }
    }

    const net = await si.networkStats();

    // Calcula tráfego de rede (B/s)
    let rxSpeed = 0;
    let txSpeed = 0;
    const now = Date.now();
    const intervalSec = (now - lastTime) / 1000;
    
    if (net && net.length > 0) {
      const activeNet = net[0]; // primeira interface ativa
      if (prevRx > 0 && intervalSec > 0) {
        rxSpeed = (activeNet.rx_bytes - prevRx) / intervalSec;
        txSpeed = (activeNet.tx_bytes - prevTx) / intervalSec;
      }
      prevRx = activeNet.rx_bytes;
      prevTx = activeNet.tx_bytes;
    }
    lastTime = now;

    // Disco principal (primeiro retornado ou barra '/')
    const rootDisk = disks.find(d => d.mount === '/') || disks[0] || { size: 0, used: 0, use: 0 };

    return {
      cpu: {
        load: Math.round(cpuLoad.currentLoad)
      },
      ram: {
        total: memory.total,
        used: memory.active, // memória realmente ativa/em uso
        percent: Math.round((memory.active / memory.total) * 100)
      },
      disk: {
        total: rootDisk.size,
        used: rootDisk.used,
        percent: Math.round(rootDisk.use)
      },
      network: {
        rx: Math.round(rxSpeed), // Bytes recebidos por segundo
        tx: Math.round(txSpeed)  // Bytes enviados por segundo
      },
      uptime: si.time().uptime,
      specs,
      services
    };
  } catch (error) {
    console.error('Erro ao ler métricas do sistema:', error);
    return {
      cpu: { load: 10 },
      ram: { total: 8589934592, used: 4294967296, percent: 50 },
      disk: { total: 107374182400, used: 32212254720, percent: 30 },
      network: { rx: 1024, tx: 512 },
      uptime: 3600,
            specs: {
        cpuModel: 'Intel Core i7 / AMD Ryzen 5',
        cpuCores: '8 Cores / 16 Threads',
        cpuSpeed: '3.6 GHz',
        osDistro: 'Ubuntu 22.04 LTS (x64)',
        osKernel: '5.15.0-generic',
        ramTotal: '16.00 GB',
        sysModel: 'Generic Server'
      },
      services: { nginx: true, mysql: true, php: true, docker: true, postfix: true, dovecot: true }
    };
  }
}

/**
 * Retorna as últimas N linhas de um arquivo de log
 */
async function readLastLinesOfFile(filePath, maxLines = 100) {
  try {
    // Verifica se arquivo existe
    await fs.access(filePath);
    
    if (isLinux) {
      const result = await execCommand(`tail -n ${maxLines} "${filePath}"`);
      return result.stdout || '';
    } else {
      // Simulação no Windows
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.split('\n');
      return lines.slice(-maxLines).join('\n');
    }
  } catch (err) {
    return `[ERRO] Arquivo de log não pôde ser aberto ou não existe em: ${filePath}\n`;
  }
}

/**
 * Carregar logs selecionados pelo painel
 */
async function getLogs(req, res) {
  const { type } = req.query; // 'nginx-access', 'nginx-error', 'mail', 'panel'

  let logPath = '';
  if (isLinux) {
    switch (type) {
      case 'nginx-access': logPath = '/var/log/nginx/access.log'; break;
      case 'nginx-error': logPath = '/var/log/nginx/error.log'; break;
      case 'mail': logPath = '/var/log/mail.log'; break;
      case 'panel': logPath = path.resolve(__dirname, '../../temp/panel.log'); break; // custom log
      default: return res.status(400).json({ error: 'Tipo de log inválido.' });
    }
  } else {
    // Mock no Windows
    const mockLogDir = path.resolve(__dirname, '../../temp/var/log');
    await fs.mkdir(mockLogDir, { recursive: true });

    switch (type) {
      case 'nginx-access': 
        logPath = path.join(mockLogDir, 'nginx-access.log'); 
        await fs.writeFile(logPath, '127.0.0.1 - - [16/Jun/2026:22:15:00 +0100] "GET / HTTP/1.1" 200 1245\n127.0.0.1 - - [16/Jun/2026:22:15:30 +0100] "GET /api/status HTTP/1.1" 200 450', 'utf8');
        break;
      case 'nginx-error': 
        logPath = path.join(mockLogDir, 'nginx-error.log'); 
        await fs.writeFile(logPath, '2026/06/16 22:15:00 [error] 1420#1420: *12 open() "/var/www/favicon.ico" failed (2: No such file or directory)', 'utf8');
        break;
      case 'mail': 
        logPath = path.join(mockLogDir, 'mail.log'); 
        await fs.writeFile(logPath, 'Jun 16 22:15:00 server postfix/smtpd[2450]: connect from mail-sender.com\nJun 16 22:15:01 server postfix/smtp[2451]: Sent to contact@domain.com (250 2.0.0 OK)', 'utf8');
        break;
      case 'panel':
        logPath = path.join(mockLogDir, 'panel.log');
        await fs.writeFile(logPath, '[2026-06-16 22:15:00] INFO: BestCode CP backend started on port 3000\n[2026-06-16 22:15:30] INFO: SSO session token created for admin', 'utf8');
        break;
      default:
        return res.status(400).json({ error: 'Tipo de log inválido.' });
    }
  }

  try {
    const content = await readLastLinesOfFile(logPath, 100);
    res.json({ content });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao carregar logs: ' + error.message });
  }
}

/**
 * Obter informações do UFW (Firewall) e Fail2ban
 */
async function getSecurityStatus(req, res) {
  try {
    let ufwOutput = '';
    let fail2banOutput = '';

    if (isLinux) {
      const ufwRes = await execCommand('ufw status verbose');
      ufwOutput = ufwRes.stdout || ufwRes.stderr || 'Status: Inativo';

      const f2bRes = await execCommand('fail2ban-client status');
      fail2banOutput = f2bRes.stdout || f2bRes.stderr || 'Fail2ban não instalado';
    } else {
      ufwOutput = 'Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing)\nTo                         Action      From\n--                         ------      ----\n22/tcp (SSH)               ALLOW       Anywhere\n80,443/tcp (Web)           ALLOW       Anywhere\n25,587,993/tcp (Mail)      ALLOW       Anywhere';
      fail2banOutput = 'Status\n|- Number of jail:\t2\n`- Jail list:\tsshd, nginx-http-auth';
    }

    res.json({ ufw: ufwOutput, fail2ban: fail2banOutput });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar dados de segurança: ' + error.message });
  }
}

/**
 * Alterar estado de porta no firewall (UFW)
 */
async function toggleFirewallPort(req, res) {
  const { port, protocol, action } = req.body; // port: '80', protocol: 'tcp', action: 'allow' ou 'delete'

  if (!port) {
    return res.status(400).json({ error: 'Porta é obrigatória.' });
  }

  try {
    let cmd = '';
    if (action === 'allow') {
      cmd = `ufw allow ${port}/${protocol || 'tcp'}`;
    } else {
      cmd = `ufw delete allow ${port}/${protocol || 'tcp'}`;
    }

    const result = await execCommand(cmd);
    if (isLinux) {
      await execCommand('ufw reload');
    }

    res.json({ message: `Regra de firewall atualizada: ${result.stdout || 'OK'}` });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao alterar firewall: ' + error.message });
  }
}

// Monitorização Global em Tempo Real (Evita consultas duplicadas ao hardware por múltiplos navegadores)
let latestMetrics = null;
const metricsHistory = Array(20).fill(null).map(() => ({ cpu: 0, ram: 0 }));

async function startSystemMonitoring() {
  try {
    latestMetrics = await getSystemMetrics();
    // Preenche o histórico inicial com a primeira leitura para não começar zerado
    for (let i = 0; i < 20; i++) {
      metricsHistory[i] = {
        cpu: latestMetrics.cpu.load,
        ram: latestMetrics.ram.percent
      };
    }
  } catch (err) {
    console.error('Erro na primeira coleta do monitoramento:', err);
  }

  setInterval(async () => {
    try {
      latestMetrics = await getSystemMetrics();
      metricsHistory.push({
        cpu: latestMetrics.cpu.load,
        ram: latestMetrics.ram.percent
      });
      if (metricsHistory.length > 20) {
        metricsHistory.shift();
      }
    } catch (err) {
      console.error('Erro no loop de monitorização:', err);
    }
  }, 2000);
}

// Inicializa a coleta em background
startSystemMonitoring();

function getLatestMetrics() {
  return latestMetrics || {
    cpu: { load: 0 },
    ram: { total: 16 * 1024 * 1024 * 1024, used: 0, percent: 0 },
    disk: { total: 100 * 1024 * 1024 * 1024, used: 0, percent: 0 },
    network: { rx: 0, tx: 0 },
    uptime: 0,
    specs: null
  };
}

function getMetricsHistory() {
  return metricsHistory;
}

async function getFirewallRules(req, res) {
  try {
    let rules = [];
    if (isLinux) {
      const ufwRes = await execCommand('ufw status numbered');
      const stdout = ufwRes.stdout || '';
      const lines = stdout.split('\n');
      
      lines.forEach(line => {
        // Exemplo: [ 1] 22/tcp                     ALLOW IN    Anywhere
        const match = line.match(/^\[\s*(\d+)\]\s+([^\s]+)\s+(ALLOW|DENY|ALLOW IN|DENY IN)\s+(.*)$/i);
        if (match) {
          rules.push({
            index: parseInt(match[1], 10),
            port: match[2],
            action: match[3].trim().toUpperCase(),
            from: match[4].trim()
          });
        }
      });
    } else {
      // Mock no Windows
      rules = [
        { index: 1, port: '22/tcp', action: 'ALLOW', from: 'Anywhere' },
        { index: 2, port: '80,443/tcp', action: 'ALLOW', from: 'Anywhere' },
        { index: 3, port: '25,587,993/tcp', action: 'ALLOW', from: 'Anywhere' },
        { index: 4, port: '3306/tcp', action: 'ALLOW', from: 'Anywhere' }
      ];
    }
    res.json({ rules });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar regras de firewall: ' + error.message });
  }
}

async function deleteFirewallRule(req, res) {
  const { port, protocol } = req.body;
  if (!port) {
    return res.status(400).json({ error: 'Porta é obrigatória.' });
  }

  try {
    const proto = protocol || 'tcp';
    // Remove a regra pelo porto
    const cmd = `ufw delete allow ${port}/${proto}`;
    await execCommand(cmd);
    
    if (isLinux) {
      await execCommand('ufw reload');
    }

    res.json({ message: `Regra de firewall removida para a porta: ${port}/${proto}` });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao excluir regra de firewall: ' + error.message });
  }
}

module.exports = {
  getSystemMetrics,
  getLatestMetrics,
  getMetricsHistory,
  getLogs,
  getSecurityStatus,
  toggleFirewallPort,
  getFirewallRules,
  deleteFirewallRule
};
