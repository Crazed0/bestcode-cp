const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.DAEMON_PORT || 8080;
const DAEMON_SECRET = process.env.DAEMON_SECRET || 'bcp-daemon-node-secret-key-2026';

app.use(express.json());

// Inicializa o Docker (tenta conectar ao socket unix, senão fallback para simulação)
let docker;
let isDockerAvailable = false;
try {
  docker = new Docker({ socketPath: '/var/run/docker.sock' });
  // Teste de conexão rápido
  docker.ping((err) => {
    if (err) {
      console.warn('[DOCKER] Socket do Docker indisponível. Rodando em modo simulação.', err.message);
    } else {
      isDockerAvailable = true;
      console.log('[DOCKER] Conectado com sucesso ao socket do Docker Engine.');
    }
  });
} catch (e) {
  console.warn('[DOCKER] Falha ao instanciar Dockerode. Modo simulação ativo.');
}

// Middleware de Autenticação JWT
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token de autorização do painel ausente.' });
  }

  jwt.verify(token, DAEMON_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Token de autorização inválido ou expirado.' });
    }
    req.panel = decoded;
    next();
  });
}

// Pasta raiz local para servidores de jogos no nó
const GAMES_ROOT = '/var/games';
if (!fs.existsSync(GAMES_ROOT)) {
  try {
    fs.mkdirSync(GAMES_ROOT, { recursive: true });
  } catch (err) {
    console.error('Falha ao criar diretório /var/games:', err.message);
  }
}

// ==========================================
// ENDPOINTS REST (Protegidos)
// ==========================================

// Status do Nó
app.get('/api/status', authenticate, (req, res) => {
  res.json({
    status: 'online',
    platform: os.platform(),
    release: os.release(),
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    cpus: os.cpus().length,
    docker: isDockerAvailable ? 'active' : 'simulated'
  });
});

// Criar Container
app.post('/api/servers', authenticate, async (req, res) => {
  const { id, gameType, hostPort, ramLimitMb, cpuLimit } = req.body;

  if (!id || !gameType || !hostPort) {
    return res.status(400).json({ error: 'Parâmetros insuficientes para criar servidor.' });
  }

  const serverDir = path.join(GAMES_ROOT, String(id));
  if (!fs.existsSync(serverDir)) {
    fs.mkdirSync(serverDir, { recursive: true });
  }

  // Grava arquivo de configuração padrão do jogo
  if (gameType === 'minecraft') {
    fs.writeFileSync(
      path.join(serverDir, 'server.properties'),
      `# Minecraft properties\nserver-port=25565\nmotd=BCP Node Server ${id}\n`,
      'utf8'
    );
  } else {
    fs.writeFileSync(
      path.join(serverDir, 'config.txt'),
      `# Config para ${gameType}\nport=${hostPort}\n`,
      'utf8'
    );
  }

  if (!isDockerAvailable) {
    // Modo simulação
    const mockContainerId = 'mock_node_' + Math.random().toString(36).substring(2, 15);
    return res.json({ containerId: mockContainerId, message: 'Container criado (Simulado)' });
  }

  try {
    let image = 'itzg/minecraft-server';
    let portBindings = { '25565/tcp': [{ HostPort: String(hostPort) }] };
    let env = ['EULA=TRUE', 'ONLINE_MODE=FALSE'];
    let binds = [`${serverDir}:/data`];

    switch (gameType) {
      case 'fivem':
        image = 'sprits/fivem';
        portBindings = {
          '30120/tcp': [{ HostPort: String(hostPort) }],
          '30120/udp': [{ HostPort: String(hostPort) }]
        };
        binds = [`${serverDir}:/opt/cfx-server-data`];
        env = [];
        break;
      case 'cs2':
        image = 'joedeshon/cs2';
        portBindings = {
          '27015/tcp': [{ HostPort: String(hostPort) }],
          '27015/udp': [{ HostPort: String(hostPort) }]
        };
        binds = [`${serverDir}:/home/steam/cs2-server`];
        env = [];
        break;
      case 'mta':
        image = 'debian:latest';
        portBindings = {
          '22003/tcp': [{ HostPort: String(hostPort) }],
          '22003/udp': [{ HostPort: String(hostPort) }]
        };
        binds = [`${serverDir}:/server`];
        env = [];
        break;
    }

    // Puxa imagem do Docker se não existir
    console.log(`[DOCKER] Puxando imagem ${image} se necessário...`);
    await new Promise((resolve, reject) => {
      docker.pull(image, {}, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, onFinished, onProgress);
        function onFinished(err, output) {
          if (err) return reject(err);
          resolve(output);
        }
        function onProgress(event) {
          // Pode logar o progresso do pull se necessário
        }
      });
    });

    // Cria o container com limites de RAM e CPU
    const container = await docker.createContainer({
      Image: image,
      name: `bcp-game-${id}`,
      ExposedPorts: Object.keys(portBindings),
      HostConfig: {
        PortBindings: portBindings,
        Binds: binds,
        Memory: ramLimitMb * 1024 * 1024,
        NanoCpus: cpuLimit * 1000000000,
        RestartPolicy: { Name: 'unless-stopped' }
      },
      Env: env
    });

    res.json({ containerId: container.id, message: 'Container criado com sucesso.' });
  } catch (err) {
    console.error('[DOCKER ERROR] Falha ao criar container:', err.message);
    res.status(500).json({ error: 'Erro no Docker do Nó: ' + err.message });
  }
});

// Controlar Container (start, stop, restart, kill)
app.post('/api/servers/:id/power', authenticate, async (req, res) => {
  const { id } = req.params;
  const { action } = req.body;

  if (!isDockerAvailable) {
    return res.json({ message: `Ação "${action}" executada (Simulado)` });
  }

  try {
    const containerName = `bcp-game-${id}`;
    const container = docker.getContainer(containerName);

    if (action === 'start') {
      await container.start();
    } else if (action === 'stop') {
      await container.stop();
    } else if (action === 'restart') {
      await container.restart();
    } else if (action === 'kill') {
      await container.kill();
    } else {
      return res.status(400).json({ error: 'Ação inválida.' });
    }

    res.json({ message: `Container ${action} concluído.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar Container
app.delete('/api/servers/:id', authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    if (isDockerAvailable) {
      const containerName = `bcp-game-${id}`;
      const container = docker.getContainer(containerName);
      try {
        await container.stop();
      } catch (e) {}
      await container.remove({ force: true });
    }

    // Limpa pasta local
    const serverDir = path.join(GAMES_ROOT, String(id));
    if (fs.existsSync(serverDir)) {
      fs.rmSync(serverDir, { recursive: true, force: true });
    }

    res.json({ message: 'Servidor removido do nó com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inicializa o Servidor HTTP
const server = http.createServer(app);

// Inicializa o WebSocket
const wss = new WebSocket.Server({ noServer: true });

// Upgrade HTTP para WS com autenticação via Query Token
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const token = url.searchParams.get('token');

  if (!token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  jwt.verify(token, DAEMON_SECRET, (err, decoded) => {
    if (err) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, decoded);
    });
  });
});

// Conexões WebSocket
wss.on('connection', (ws, request, decoded) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const gameServerId = url.searchParams.get('gameServerId');

  console.log(`[WS] Painel conectou ao WebSocket do Servidor #${gameServerId}`);

  let logStream = null;
  let statsInterval = null;

  if (isDockerAvailable && gameServerId) {
    const containerName = `bcp-game-${gameServerId}`;
    const container = docker.getContainer(containerName);

    // 1. Stream de Logs
    container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 50
    }, (err, stream) => {
      if (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Erro nos logs: ' + err.message }));
        return;
      }
      logStream = stream;
      stream.on('data', (chunk) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'console_log',
            data: chunk.toString()
          }));
        }
      });
    });

    // 2. Stream de Métricas (Stats) a cada 2 segundos
    statsInterval = setInterval(async () => {
      try {
        const stats = await container.stats({ stream: false });
        // Calcula CPU (%)
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
        let cpuPercent = 0.0;
        if (systemDelta > 0 && cpuDelta > 0) {
          cpuPercent = (cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100.0;
        }

        // Calcula RAM (MB)
        const ramUsedBytes = stats.memory_stats.usage;
        const ramUsedMb = (ramUsedBytes / (1024 * 1024)).toFixed(1);

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'metrics',
            cpu: cpuPercent.toFixed(1) + '%',
            ram: ramUsedMb + ' MB'
          }));
        }
      } catch (e) {
        // Envia mock caso de erro de container desligado
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'metrics', cpu: '0%', ram: '0 MB' }));
        }
      }
    }, 2000);
  } else {
    // Logs Simulados para ambiente sem Docker/Windows
    let counter = 0;
    const mockLogInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'console_log',
          data: `[${new Date().toLocaleTimeString()}] [SIMULADO] Servidor de Jogo rodando... Linha ${++counter}\n`
        }));
      }
    }, 1500);

    statsInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'metrics',
          cpu: (Math.random() * 10 + 2).toFixed(1) + '%',
          ram: (Math.random() * 150 + 350).toFixed(1) + ' MB'
        }));
      }
    }, 2000);

    ws.on('close', () => {
      clearInterval(mockLogInterval);
    });
  }

  // Recebe comandos do Painel para injetar no container
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'command' && gameServerId && isDockerAvailable) {
        const containerName = `bcp-game-${gameServerId}`;
        const container = docker.getContainer(containerName);
        
        // Executa o comando via docker exec
        const execInstance = await container.exec({
          Cmd: ['sh', '-c', data.command],
          AttachStdout: true,
          AttachStderr: true
        });

        const stream = await execInstance.start();
        stream.on('data', (chunk) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'console_log',
              data: chunk.toString()
            }));
          }
        });
      }
    } catch (e) {
      console.error('Erro ao processar comando WS do daemon:', e.message);
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Conexão encerrada para o Servidor #${gameServerId}`);
    if (logStream && typeof logStream.destroy === 'function') {
      logStream.destroy();
    }
    if (statsInterval) {
      clearInterval(statsInterval);
    }
  });
});

server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`⚡ BCP DAEMON WINGS AGENT RODANDO NA PORTA ${PORT}`);
  console.log(`🔑 Segredo compartilhado de autenticação ativo.`);
  console.log(`===================================================`);
});
