const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');

const db = require('./config/db');
const apiRoutes = require('./routes/api');
const { JWT_SECRET } = require('./config/auth');
const { getLatestMetrics, getMetricsHistory } = require('./controllers/monitorController');
const dockerService = require('./services/dockerService');

// Limpar o ficheiro de logs do terminal de sistema no arranque do servidor para começar limpo
try {
  const terminalLogPath = path.resolve(__dirname, '../temp/terminal.log');
  if (fs.existsSync(terminalLogPath)) {
    fs.truncateSync(terminalLogPath, 0);
    console.log('[Terminal Log] Ficheiro terminal.log limpo no arranque do servidor.');
  }
} catch (err) {
  console.error('[Terminal Log] Erro ao limpar terminal.log no arranque:', err);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Proxy transparente do phpMyAdmin para o Nginx (porta 80) no ambiente de desenvolvimento
// DEVE vir ANTES dos body-parsers para que o stream de dados da requisição (req) não seja consumido.
const pmaPath = process.env.PMA_PATH || '/phpmyadmin';
app.use(pmaPath, (req, res) => {
  const headers = { ...req.headers };
  headers['host'] = '127.0.0.1';

  const proxyReq = http.request({
    host: '127.0.0.1',
    port: 80,
    path: `${pmaPath}${req.url}`,
    method: req.method,
    headers: headers
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error('[Proxy Error] Falha ao proxyar para phpMyAdmin:', err.message);
    res.status(502).send('Erro: O servidor Nginx ou PHP-FPM em WSL não está ativo na porta 80.');
  });

  req.pipe(proxyReq, { end: true });
});

// Middleware global - Injeta cabeçalhos de segurança (CSP, X-Frame, XSS, nosniff)
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  // Content-Security-Policy (CSP) robusto
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://accounts.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https://lh3.googleusercontent.com; connect-src 'self' ws: wss: https://api.github.com https://raw.githubusercontent.com; frame-src https://accounts.google.com;");
  next();
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware de log de requisições simples
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.path}`);
  next();
});

// Rotas da API
app.use('/api', apiRoutes);

// Servir a página de Login sem a extensão .html
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/login.html'));
});

// Redirecionar acessos diretos com .html para a URL limpa
app.get('/login.html', (req, res) => {
  res.redirect(301, '/login');
});

// Servir o Frontend estático do painel
app.use(express.static(path.join(__dirname, '../../frontend')));

// Rota de fallback para o Single Page Application (SPA)
app.get('*', (req, res) => {
  // Ignora chamadas da API
  if (req.url.startsWith('/api')) {
    return res.status(404).json({ error: 'Endpoint não encontrado.' });
  }
  res.sendFile(path.join(__dirname, '../../frontend/index.html'));
});

// Inicializa o servidor HTTP
const server = http.createServer(app);

// Inicializa o servidor WebSocket (WS)
const wss = new WebSocket.Server({ noServer: true });

// Lida com o upgrade HTTP para WebSocket com verificação de JWT
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const token = url.searchParams.get('token');

  if (!token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
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

// Conexões WebSocket ativas
wss.on('connection', (ws, request, user) => {
  console.log(`[WS] Novo cliente conectado: ${user.username}`);

  let activeLogStream = null;
  let activeShell = null;

  // Envia histórico de métricas acumulado ao conectar
  ws.send(JSON.stringify({
    type: 'metrics_history',
    data: getMetricsHistory()
  }));

  // Envia métricas imediatas ao conectar
  sendMetrics(ws);

  // Loop de envio de métricas a cada 2 segundos
  const metricsInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      sendMetrics(ws);
    }
  }, 2000);

  const cleanStreams = () => {
    if (activeLogStream) {
      if (typeof activeLogStream.kill === 'function') activeLogStream.kill();
      activeLogStream = null;
    }
    if (activeShell) {
      try {
        activeShell.removeAllListeners('close');
      } catch (e) {}
      activeShell.kill();
      activeShell = null;
    }
  };

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (data.type === 'close_console') {
        console.log(`[WS] Cliente solicitou encerramento de consolas ativas para: ${user.username}`);
        cleanStreams();
      } else if (data.type === 'join_console') {
        cleanStreams();

        const { gameServerId } = data;
        if (!gameServerId) return;

        console.log(`[WS] Cliente conectou ao console do servidor #${gameServerId}`);
        activeLogStream = dockerService.streamLogs(gameServerId, (logLine) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'console_log',
              gameServerId,
              data: logLine
            }));
          }
        });
      } else if (data.type === 'console_command') {
        const { gameServerId, command } = data;
        if (!gameServerId || !command) return;

        dockerService.runConsoleCommand(gameServerId, command);
      } else if (data.type === 'join_root_console') {
        cleanStreams();

        const logFilePath = path.resolve(__dirname, '../temp/terminal.log');
        const tempDir = path.dirname(logFilePath);
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        // Se o arquivo de log não existir, cria-o com mensagem inicial
        if (!fs.existsSync(logFilePath)) {
          const timestamp = new Date().toLocaleString('pt-PT');
          const bootInfoPath = path.resolve(__dirname, '../../first-boot.txt');
          let initialMessage = '';

          if (fs.existsSync(bootInfoPath)) {
            // Primeira inicialização / instalação concluída
            const bootInfo = fs.readFileSync(bootInfoPath, 'utf8');
            initialMessage = `[${timestamp}] - ===================================================\n` +
                             `[${timestamp}] - 🚀 BESTCODE CONTROL PANEL (BCP) INSTALADO COM SUCESSO\n` +
                             `[${timestamp}] - 🔑 CREDENCIAIS DO ADMINISTRADOR INICIAL (ROOT)\n` +
                             `[${timestamp}] - ${bootInfo.replace(/\n/g, `\n[${timestamp}] - `)}\n` +
                             `[${timestamp}] - ===================================================\n`;
          } else {
            initialMessage = `[${timestamp}] - Terminal de sistema inicializado.\n`;
          }
          fs.writeFileSync(logFilePath, initialMessage, 'utf8');
        }



        const isWin = process.platform === 'win32';
        const shell = isWin ? 'powershell.exe' : 'bash';
        const args = isWin ? ['-NoLogo'] : [];

        console.log(`[WS] Cliente conectou ao console de root`);
        activeShell = spawn(shell, args, {
          env: process.env,
          shell: false
        });

        let lineBuffer = '';

        function handleShellData(dataChunk) {
          lineBuffer += dataChunk.toString();
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop(); // Mantém o pedaço incompleto no buffer

          const timestamp = new Date().toLocaleString('pt-PT');
          let outputToSend = '';

          lines.forEach(line => {
            const cleanLine = line.replace(/\r/g, '').trim();
            if (cleanLine) {
              const formattedLine = `[${timestamp}] - ${cleanLine}\n`;
              try {
                fs.appendFileSync(logFilePath, formattedLine, 'utf8');
              } catch (e) {
                console.error('Erro ao escrever no terminal.log:', e);
              }
              outputToSend += formattedLine;
            }
          });

          if (outputToSend && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'root_console_log',
              data: outputToSend
            }));
          }
        }

        activeShell.on('error', (err) => {
          console.error('[WS] Erro ao iniciar shell de root:', err.message);
          const timestamp = new Date().toLocaleString('pt-PT');
          const errorLine = `[${timestamp}] - Erro ao iniciar terminal do sistema: ${err.message}\n`;
          fs.appendFileSync(logFilePath, errorLine, 'utf8');
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'root_console_log',
              data: errorLine
            }));
          }
        });

        activeShell.stdout.on('data', handleShellData);
        activeShell.stderr.on('data', handleShellData);

        activeShell.on('close', () => {
          const timestamp = new Date().toLocaleString('pt-PT');
          const closeLine = `[${timestamp}] - *** Terminal Fechado ***\n`;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'root_console_log',
              data: closeLine
            }));
          }
          activeShell = null;
        });
      } else if (data.type === 'root_console_command') {
        const { command } = data;
        if (activeShell && command) {
          const isClear = command.trim().toLowerCase() === 'clear' || command.trim().toLowerCase() === 'cls';
          
          if (isClear) {
            try {
              fs.writeFileSync(path.resolve(__dirname, '../temp/terminal.log'), '', 'utf8');
            } catch (e) {
              console.error('Erro ao limpar terminal.log:', e);
            }
          } else {
            const timestamp = new Date().toLocaleString('pt-PT');
            const logLine = `[${timestamp}] ${user.username}: ${command}\n`;
            try {
              fs.appendFileSync(path.resolve(__dirname, '../temp/terminal.log'), logLine, 'utf8');
            } catch (e) {
              console.error('Erro ao escrever comando no terminal.log:', e);
            }
            // Envia o comando instantaneamente de volta ao ecrã para resposta visual
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'root_console_log',
                data: logLine
              }));
            }
          }
          activeShell.stdin.write(command + '\n');
        }
      } else if (data.type === 'root_console_sigint') {
        if (activeShell) {
          const isWin = process.platform === 'win32';
          if (isWin) {
            activeShell.kill('SIGINT');
          } else {
            // Envia SIGINT para os processos filhos da shell ativa (ex: ping)
            const pkill = spawn('pkill', ['-INT', '-P', activeShell.pid.toString()]);
            pkill.on('error', (err) => {
              console.error('Erro ao executar pkill:', err);
              activeShell.kill('SIGINT');
            });
          }
        }
      } else if (data.type === 'join_site_console') {
        cleanStreams();

        const { domain } = data;
        if (!domain) return;

        const isWin = process.platform === 'win32';
        const sitePath = isWin ? path.join('C:\\var\\www', domain) : `/var/www/${domain}`;
        const shell = isWin ? 'powershell.exe' : 'bash';
        const args = isWin ? ['-NoLogo'] : [];

        console.log(`[WS] Cliente conectou ao console do site ${domain}`);
        activeShell = spawn(shell, args, {
          cwd: sitePath,
          env: process.env,
          shell: false
        });

        activeShell.on('error', (err) => {
          console.error(`[WS] Erro ao iniciar shell do site ${domain}:`, err.message);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'site_console_log',
              domain,
              data: `\r\nErro ao iniciar terminal do site: ${err.message}\r\n`
            }));
          }
        });

        activeShell.stdout.on('data', (chunk) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'site_console_log',
              domain,
              data: chunk.toString()
            }));
          }
        });

        activeShell.stderr.on('data', (chunk) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'site_console_log',
              domain,
              data: chunk.toString()
            }));
          }
        });

        activeShell.on('close', () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'site_console_log',
              domain,
              data: '\r\n*** Terminal Fechado ***\r\n'
            }));
          }
          activeShell = null;
        });
      } else if (data.type === 'site_console_command') {
        const { command } = data;
        if (activeShell && command) {
          activeShell.stdin.write(command + '\n');
        }
      }
    } catch (e) {
      console.error('[WS] Mensagem inválida recebida:', e.message);
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Cliente desconectado: ${user.username}`);
    clearInterval(metricsInterval);
    cleanStreams();
  });
});

function sendMetrics(ws) {
  const metrics = getLatestMetrics();
  ws.send(JSON.stringify({
    type: 'metrics',
    data: metrics
  }));
}

// Inicia o servidor escutando na porta
server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`🚀 BESTCODE CONTROL PANEL (BCP) INICIADO COM SUCESSO`);
  console.log(`🌐 Servidor rodando em: http://localhost:${PORT}`);
  console.log(`===================================================`);
});
