const db = require('../config/db');
const dockerService = require('../services/dockerService');
const jwt = require('jsonwebtoken');

// Portas base por tipo de jogo
const GAME_BASE_PORTS = {
  minecraft: 25565,
  fivem: 30120,
  mta: 22003,
  cs2: 27015
};

/**
 * Autodetecta a próxima porta disponível para o tipo de jogo
 */
function getNextFreePort(gameType) {
  const basePort = GAME_BASE_PORTS[gameType] || 25000;
  
  // Lista todas as portas já alocadas no banco
  const allocatedPorts = db.prepare('SELECT host_port FROM game_servers').all().map(r => r.host_port);
  
  let port = basePort;
  while (allocatedPorts.includes(port)) {
    port++;
  }
  return port;
}

/**
 * Listar todos os servidores de jogos e seus status em tempo real
 */
async function getGames(req, res) {
  try {
    const servers = db.prepare(`
      SELECT gs.*, n.name AS node_name
      FROM game_servers gs
      LEFT JOIN system_nodes n ON gs.node_id = n.id
      ORDER BY gs.id DESC
    `).all();
    
    // Obtém estatísticas do Docker em paralelo para todos os servidores rodando
    const serversWithStats = await Promise.all(servers.map(async (server) => {
      let stats = { cpu: '0%', ram: '0 MB' };
      if (server.status === 'running') {
        try {
          stats = await dockerService.getContainerStats(server.id);
        } catch (e) {
          console.error(`Erro ao obter métricas do container ${server.id}:`, e);
        }
      }
      return {
        ...server,
        cpu_usage: stats.cpu,
        ram_usage: stats.ram
      };
    }));

    res.json(serversWithStats);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar servidores de jogo: ' + error.message });
  }
}

/**
 * Criar um novo servidor de jogo (Docker Container + Registro no DB)
 */
async function createGame(req, res) {
  const { name, game_type, ram_limit_mb, cpu_limit, node_id } = req.body;

  if (!name || !game_type || !ram_limit_mb) {
    return res.status(400).json({ error: 'Nome, tipo de jogo e limite de RAM são obrigatórios.' });
  }

  const ram = parseInt(ram_limit_mb, 10);
  const cpu = parseFloat(cpu_limit) || 1.0;
  
  if (isNaN(ram) || ram < 256) {
    return res.status(400).json({ error: 'Limite de RAM inválido (mínimo 256MB).' });
  }

  try {
    // 1. Aloca porta disponível automaticamente
    const hostPort = getNextFreePort(game_type);

    // 2. Insere no DB em estado "installing"
    const insertResult = db.prepare(`
      INSERT INTO game_servers (name, game_type, host_port, ram_limit_mb, cpu_limit, status, node_id)
      VALUES (?, ?, ?, ?, ?, 'installing', ?)
    `).run(name, game_type, hostPort, ram, cpu, node_id || null);

    const serverId = insertResult.lastInsertRowid;

    // 3. Executa o provisionamento do Docker de forma assíncrona para não travar a API
    // (A resposta retorna imediatamente ao front-end que exibe estado 'instalando')
    provisionDockerContainer(serverId, game_type, hostPort, ram, cpu);

    res.json({ 
      message: 'Instalação do servidor iniciada com sucesso!', 
      serverId,
      hostPort
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao registrar servidor: ' + error.message });
  }
}

/**
 * Provisionamento assíncrono do container Docker
 */
async function provisionDockerContainer(serverId, gameType, hostPort, ram, cpu) {
  try {
    const { containerId, error } = await dockerService.createContainer(serverId, gameType, hostPort, ram, cpu);
    
    if (error) {
      console.error(`[DOCKER PROVISION ERROR] Server #${serverId}:`, error);
      db.prepare("UPDATE game_servers SET status = 'error' WHERE id = ?").run(serverId);
      db.prepare("INSERT INTO logs (type, message) VALUES ('system', ?)").run(`Falha ao criar container do servidor de jogo #${serverId}: ${error}`);
      return;
    }

    // Provisionado com sucesso! Atualiza para 'running'
    db.prepare("UPDATE game_servers SET container_id = ?, status = 'running' WHERE id = ?")
      .run(containerId, serverId);

    db.prepare("INSERT INTO logs (type, message) VALUES ('system', ?)").run(`Servidor de jogo #${serverId} (${gameType}) provisionado e iniciado na porta ${hostPort}.`);
  } catch (err) {
    console.error(`[DOCKER PROVISION CRITICAL] Server #${serverId}:`, err);
    db.prepare("UPDATE game_servers SET status = 'error' WHERE id = ?").run(serverId);
  }
}

/**
 * Controlar estado do servidor (start, stop, restart)
 */
async function controlGame(req, res) {
  const { id, action } = req.body;

  if (!id || !action) {
    return res.status(400).json({ error: 'ID do servidor e ação (start, stop, restart) são obrigatórios.' });
  }

  try {
    const server = db.prepare('SELECT * FROM game_servers WHERE id = ?').get(id);
    if (!server) {
      return res.status(404).json({ error: 'Servidor de jogo não encontrado.' });
    }

    if (server.status === 'installing') {
      return res.status(400).json({ error: 'O servidor ainda está em processo de instalação.' });
    }

    // Executa controle de container
    await dockerService.controlContainer(id, action, server.game_type);

    // Atualiza status no banco
    let newStatus = 'stopped';
    if (action === 'start' || action === 'restart') {
      newStatus = 'running';
    }

    db.prepare('UPDATE game_servers SET status = ? WHERE id = ?').run(newStatus, id);
    res.json({ message: `Ação "${action}" executada com sucesso!`, status: newStatus });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao controlar servidor de jogo: ' + error.message });
  }
}

/**
 * Excluir servidor de jogo (Docker Container + Diretórios + Registro DB)
 */
async function deleteGame(req, res) {
  const { id } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'ID do servidor é obrigatório.' });
  }

  try {
    const server = db.prepare('SELECT * FROM game_servers WHERE id = ?').get(id);
    if (!server) {
      return res.status(404).json({ error: 'Servidor de jogo não encontrado.' });
    }

    // Remove do docker (deleta container e remove pasta do host)
    await dockerService.removeContainer(id);

    // Deleta do DB
    db.prepare('DELETE FROM game_servers WHERE id = ?').run(id);

    db.prepare("INSERT INTO logs (type, message) VALUES ('system', ?)")
      .run(`Servidor de jogo #${id} (${server.name}) foi excluído permanentemente.`);

    res.json({ message: 'Servidor de jogo excluído com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao excluir servidor de jogo: ' + error.message });
  }
}

/**
 * Obter configuração de conexão do console (Redirecionamento para o nó remoto se necessário)
 */
async function getConsoleConfig(req, res) {
  const { id } = req.params;
  try {
    const server = db.prepare('SELECT * FROM game_servers WHERE id = ?').get(id);
    if (!server) {
      return res.status(404).json({ error: 'Servidor de jogo não encontrado.' });
    }

    if (!server.node_id) {
      return res.json({ is_remote: false });
    }

    const node = db.prepare('SELECT * FROM system_nodes WHERE id = ?').get(server.node_id);
    if (!node) {
      return res.status(404).json({ error: 'Nó de servidor associado não encontrado.' });
    }

    // Gera um token JWT assinado com o segredo do nó
    const token = jwt.sign({ panel: true, gameServerId: id }, node.daemon_token_secret, { expiresIn: '15m' });

    res.json({
      is_remote: true,
      ip_address: node.ip_address,
      api_port: node.api_port,
      token: token
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao obter configuração de conexão do console: ' + error.message });
  }
}

module.exports = {
  getGames,
  createGame,
  controlGame,
  deleteGame,
  getConsoleConfig
};
