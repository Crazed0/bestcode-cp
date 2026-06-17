const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isLinux, execCommand } = require('./systemService');
const db = require('../config/db');
const jwt = require('jsonwebtoken');

/**
 * Envia uma requisição HTTP autenticada para um nó de servidor remoto (BCP Wings Daemon)
 */
async function callNodeApi(nodeId, endpoint, method = 'GET', body = null) {
  const node = db.prepare('SELECT * FROM system_nodes WHERE id = ?').get(nodeId);
  if (!node || node.is_active === 0) {
    throw new Error(`Nó de servidor #${nodeId} está inativo ou indisponível.`);
  }

  // Gera um token JWT assinado com o segredo do nó
  const token = jwt.sign({ panel: true }, node.daemon_token_secret, { expiresIn: '1m' });

  const url = `http://${node.ip_address}:${node.api_port}${endpoint}`;
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: body ? JSON.stringify(body) : null
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || `Erro na API do Nó (Status ${response.status})`);
  }

  return response.json();
}

// Pasta raiz para armazenar os arquivos dos servidores de jogos
const GAMES_ROOT = isLinux 
  ? '/var/games' 
  : path.resolve(__dirname, '../../temp/var/games');

// Inicializa a pasta root de jogos
if (!fs.existsSync(GAMES_ROOT)) {
  fs.mkdirSync(GAMES_ROOT, { recursive: true });
}

// Armazena intervalos de logs simulados para Windows
const mockIntervals = {};
const logListeners = {};

/**
 * Retorna o caminho da pasta raiz do servidor de jogo
 */
function getGameServerDir(id) {
  return path.join(GAMES_ROOT, String(id));
}

/**
 * Cria o diretório físico do servidor de jogo no host
 */
function initGameServerDir(id) {
  const dir = getGameServerDir(id);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Exclui o diretório físico do servidor de jogo no host
 */
function deleteGameServerDir(id) {
  const dir = getGameServerDir(id);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Executa comandos Docker CLI
 */
function runDockerCmd(cmd) {
  return new Promise((resolve) => {
    if (!isLinux) {
      console.log(`[MOCK DOCKER] ${cmd}`);
      resolve({ stdout: `Success mock docker execution for: ${cmd}`, stderr: '' });
      return;
    }
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        resolve({ error, stdout, stderr });
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Cria e inicia o container Docker para um jogo
 */
async function createContainer(id, gameType, hostPort, ramLimitMb, cpuLimit) {
  // Verifica se o servidor de jogo está registrado num nó remoto
  const serverObj = db.prepare('SELECT node_id FROM game_servers WHERE id = ?').get(id);
  const nodeId = serverObj ? serverObj.node_id : null;

  if (nodeId) {
    try {
      const response = await callNodeApi(nodeId, '/api/servers', 'POST', {
        id, gameType, hostPort, ramLimitMb, cpuLimit
      });
      return { containerId: response.containerId, error: null };
    } catch (err) {
      console.error(`[DAEMON CREATE ERROR] Falha ao criar container no nó #${nodeId}:`, err.message);
      return { containerId: null, error: err.message };
    }
  }

  const serverDir = initGameServerDir(id);
  
  // Cria arquivo de propriedades inicial para o Minecraft ou outros de forma mock
  if (gameType === 'minecraft') {
    fs.writeFileSync(
      path.join(serverDir, 'server.properties'), 
      `# Minecraft server properties\nserver-port=25565\nmotd=BestCode CP Minecraft Server ${id}\ndifficulty=easy\npvp=true\nmax-players=20\n`,
      'utf8'
    );
  } else {
    fs.writeFileSync(
      path.join(serverDir, 'config.txt'), 
      `# Config para ${gameType}\nport=${hostPort}\nmax_players=32\n`, 
      'utf8'
    );
  }

  let dockerCmd = '';
  let envs = '';
  let portMapping = '';
  let volumeMapping = '';
  let image = '';

  switch (gameType) {
    case 'minecraft':
      image = 'itzg/minecraft-server';
      portMapping = `-p ${hostPort}:25565`;
      envs = `-e EULA=TRUE -e ONLINE_MODE=FALSE`;
      volumeMapping = `-v "${serverDir}:/data"`;
      break;
    case 'fivem':
      image = 'sprits/fivem';
      portMapping = `-p ${hostPort}:30120 -p ${hostPort}:30120/udp`;
      volumeMapping = `-v "${serverDir}:/opt/cfx-server-data"`;
      break;
    case 'mta':
      image = 'debian:latest'; // debian base para rodar o mta script
      portMapping = `-p ${hostPort}:22003 -p ${hostPort}:22003/udp`;
      volumeMapping = `-v "${serverDir}:/server"`;
      break;
    case 'cs2':
      image = 'joedeshon/cs2';
      portMapping = `-p ${hostPort}:27015 -p ${hostPort}:27015/udp`;
      volumeMapping = `-v "${serverDir}:/home/steam/cs2-server"`;
      break;
    default:
      image = 'debian:latest';
      portMapping = `-p ${hostPort}:80`;
      volumeMapping = `-v "${serverDir}:/data"`;
  }

  dockerCmd = `docker run -d --name bcp-game-${id} ${portMapping} -m ${ramLimitMb}m --cpus=${cpuLimit} ${volumeMapping} ${envs} --restart unless-stopped ${image}`;
  
  const result = await runDockerCmd(dockerCmd);
  
  if (!isLinux) {
    // Modo simulação: gera ID de container aleatório
    const mockContainerId = 'mock_' + Math.random().toString(36).substring(2, 15);
    startMockLogs(id, gameType);
    return { containerId: mockContainerId, error: null };
  }

  if (result.error) {
    return { containerId: null, error: result.stderr || result.error.message };
  }

  const containerId = result.stdout.trim();
  return { containerId, error: null };
}

/**
 * Controla o estado de um container (start, stop, restart)
 */
async function controlContainer(id, action, gameType) {
  const serverObj = db.prepare('SELECT node_id FROM game_servers WHERE id = ?').get(id);
  const nodeId = serverObj ? serverObj.node_id : null;

  if (nodeId) {
    await callNodeApi(nodeId, `/api/servers/${id}/power`, 'POST', { action });
    return true;
  }

  const containerName = `bcp-game-${id}`;
  let cmd = `docker ${action} ${containerName}`;
  const result = await runDockerCmd(cmd);

  if (!isLinux) {
    if (action === 'start' || action === 'restart') {
      startMockLogs(id, gameType || 'minecraft');
    } else if (action === 'stop') {
      stopMockLogs(id);
    }
    return true;
  }

  if (result.error) {
    throw new Error(`Falha ao executar "${action}" no container: ${result.stderr || result.error.message}`);
  }
  return true;
}

/**
 * Remove o container Docker
 */
async function removeContainer(id) {
  const serverObj = db.prepare('SELECT node_id FROM game_servers WHERE id = ?').get(id);
  const nodeId = serverObj ? serverObj.node_id : null;

  if (nodeId) {
    await callNodeApi(nodeId, `/api/servers/${id}`, 'DELETE');
    return true;
  }

  const containerName = `bcp-game-${id}`;
  
  // Para o container e remove
  await runDockerCmd(`docker stop ${containerName}`);
  const result = await runDockerCmd(`docker rm -f ${containerName}`);
  
  if (!isLinux) {
    stopMockLogs(id);
    deleteGameServerDir(id);
    return true;
  }

  deleteGameServerDir(id);
  return true;
}

/**
 * Retorna as estatísticas do container (CPU, RAM em tempo real)
 */
async function getContainerStats(id) {
  const serverObj = db.prepare('SELECT node_id FROM game_servers WHERE id = ?').get(id);
  const nodeId = serverObj ? serverObj.node_id : null;

  if (nodeId) {
    return {
      cpu: '0%',
      ram: '0 MB',
      rawCpu: 0,
      rawRam: 0
    };
  }

  if (!isLinux) {
    // Retorna uso mockado aleatório se o servidor estiver rodando
    return {
      cpu: (Math.random() * 15 + 2).toFixed(1) + '%',
      ram: (Math.random() * 200 + 400).toFixed(0) + ' MB',
      rawCpu: Math.random() * 15 + 2,
      rawRam: Math.random() * 200 + 400
    };
  }

  const containerName = `bcp-game-${id}`;
  const cmd = `docker stats --no-stream --format "{{.CPUPerc}};{{.MemUsage}};{{.MemPerc}}" ${containerName}`;
  
  return new Promise((resolve) => {
    exec(cmd, (error, stdout) => {
      if (error || !stdout.trim()) {
        return resolve({ cpu: '0%', ram: '0 MB', rawCpu: 0, rawRam: 0 });
      }
      
      const parts = stdout.trim().split(';');
      if (parts.length < 3) {
        return resolve({ cpu: '0%', ram: '0 MB', rawCpu: 0, rawRam: 0 });
      }

      const cpu = parts[0];
      const memUsage = parts[1].split('/')[0].trim(); // Pega apenas o uso de memória ex: 450MiB
      
      resolve({
        cpu,
        ram: memUsage,
        rawCpu: parseFloat(cpu.replace('%', '')) || 0,
        rawRam: parseFloat(memUsage) || 0
      });
    });
  });
}

/**
 * Lança logs simulados em arquivo no Windows
 */
function startMockLogs(id, gameType) {
  if (mockIntervals[id]) clearInterval(mockIntervals[id]);
  const serverDir = getGameServerDir(id);
  initGameServerDir(id);

  const logFile = path.join(serverDir, 'console.log');
  fs.writeFileSync(logFile, `[BCP Mock Engine] Booting container for game: ${gameType.toUpperCase()}...\n`, 'utf8');

  let count = 0;
  mockIntervals[id] = setInterval(() => {
    count++;
    let line = '';
    const now = new Date().toLocaleTimeString();
    if (gameType === 'minecraft') {
      if (count === 1) line = `[${now} INFO]: Loading properties\n`;
      else if (count === 2) line = `[${now} INFO]: Starting Minecraft server version 1.20.1\n`;
      else if (count === 3) line = `[${now} INFO]: Generating keypair\n`;
      else if (count === 4) line = `[${now} INFO]: Preparing level "world"\n`;
      else if (count === 5) line = `[${now} INFO]: Preparing start region for dimension minecraft:overworld\n`;
      else if (count === 6) line = `[${now} INFO]: Time elapsed: 1420 ms\n`;
      else if (count % 10 === 0) line = `[${now} INFO]: Average tick time: 18.2ms (TPS: 20.0)\n`;
      else if (count % 17 === 0) line = `[${now} INFO]: player_bestcode joined the game\n`;
      else line = `[${now} INFO]: Done (2.45s)! For help, type "help" or "?"\n`;
    } else {
      line = `[${now} BCP-MOCK-LOG-${count}]: Running Game ${gameType} container processes...\n`;
    }
    fs.appendFileSync(logFile, line, 'utf8');
    if (logListeners[id]) {
      logListeners[id].forEach(cb => cb(line));
    }
  }, 3000);
}

/**
 * Para a geração de logs simulados
 */
function stopMockLogs(id) {
  if (mockIntervals[id]) {
    clearInterval(mockIntervals[id]);
    delete mockIntervals[id];
  }
}

/**
 * Transmite logs do container de jogos em tempo real (para WebSockets)
 */
function streamLogs(id, onData) {
  if (!isLinux) {
    // Envia logs iniciais se o arquivo console.log já existir
    const serverDir = getGameServerDir(id);
    const logFile = path.join(serverDir, 'console.log');
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf8');
      onData(content);
    }
    
    // Registra listener em memória
    const listener = (data) => onData(data);
    if (!logListeners[id]) logListeners[id] = new Set();
    logListeners[id].add(listener);
    
    return {
      kill: () => {
        if (logListeners[id]) {
          logListeners[id].delete(listener);
          if (logListeners[id].size === 0) delete logListeners[id];
        }
      }
    };
  } else {
    const { spawn } = require('child_process');
    const proc = spawn('docker', ['logs', '--tail', '100', '-f', `bcp-game-${id}`]);
    
    proc.stdout.on('data', (data) => {
      onData(data.toString());
    });
    proc.stderr.on('data', (data) => {
      onData(data.toString());
    });
    
    return proc; // possui o método .kill() para parar o stream
  }
}

/**
 * Executa um comando no console do servidor de jogo (stdin/exec)
 */
function runConsoleCommand(id, command) {
  if (!isLinux) {
    const logFile = path.join(getGameServerDir(id), 'console.log');
    const now = new Date().toLocaleTimeString();
    
    const inputLine = `[${now} CONSOLE-INPUT]: ${command}\n`;
    fs.appendFileSync(logFile, inputLine, 'utf8');
    if (logListeners[id]) {
      logListeners[id].forEach(cb => cb(inputLine));
    }

    setTimeout(() => {
      let response = '';
      const cmdLower = command.toLowerCase().trim();
      if (cmdLower === 'help' || cmdLower === '?') {
        response = `[${now} INFO]: --- Comandos Disponíveis (Mock) ---\n[${now} INFO]: help - Mostra esta ajuda\n[${now} INFO]: list - Lista jogadores online\n[${now} INFO]: op <user> - Dá administrador a um jogador\n`;
      } else if (cmdLower === 'list') {
        response = `[${now} INFO]: Jogadores online (1/20): player_bestcode\n`;
      } else if (cmdLower.startsWith('op ')) {
        const user = command.substring(3);
        response = `[${now} INFO]: O jogador ${user} agora é um administrador do servidor.\n`;
      } else {
        response = `[${now} INFO]: Comando "${command}" recebido e processado pelo servidor.\n`;
      }
      fs.appendFileSync(logFile, response, 'utf8');
      if (logListeners[id]) {
        logListeners[id].forEach(cb => cb(response));
      }
    }, 800);
    
    return true;
  } else {
    // No Linux, executa o comando injetando no container docker
    // Executa em segundo plano sem bloquear a requisição
    const { exec } = require('child_process');
    const cmd = `echo "${command}" | docker exec -i bcp-game-${id} sh -c "cat - > /proc/1/fd/0" 2>/dev/null || docker exec -i bcp-game-${id} ${command}`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error(`[CONSOLE CMD ERROR] falha ao injetar comando no container #${id}:`, stderr || err.message);
      }
    });
    return true;
  }
}

module.exports = {
  GAMES_ROOT,
  getGameServerDir,
  initGameServerDir,
  deleteGameServerDir,
  createContainer,
  controlContainer,
  removeContainer,
  getContainerStats,
  streamLogs,
  runConsoleCommand
};
