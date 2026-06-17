const fs = require('fs').promises;
const path = require('path');
const db = require('../config/db');
const { execCommand, isLinux } = require('../services/systemService');

/**
 * Atualiza o crontab do sistema operacional Linux com base nos registros ativos do banco SQLite
 */
async function syncSystemCrontab() {
  try {
    const activeCrons = db.prepare('SELECT command, schedule FROM crons WHERE enabled = 1').all();
    
    // Gera as linhas do arquivo crontab
    // Inclui um cabeçalho identificador para sabermos que foi gerado pelo BestCode CP
    let crontabContent = `# GERADO PELO BESTCODE CP - NÃO EDITE MANUALMENTE\n`;
    activeCrons.forEach(cron => {
      crontabContent += `${cron.schedule} ${cron.command}\n`;
    });

    if (isLinux) {
      // Salva em um arquivo temporário e aplica
      const tempPath = '/tmp/bestcode_crons';
      await fs.writeFile(tempPath, crontabContent, 'utf8');
      const result = await execCommand(`crontab ${tempPath} && rm ${tempPath}`);
      if (result.error) {
        throw new Error('Falha ao aplicar crontab: ' + result.stderr);
      }
    } else {
      // No Windows mock, escreve em uma pasta temporária
      const mockCronFile = path.resolve(__dirname, '../../temp/var/spool/cron/root');
      await fs.writeFile(mockCronFile, crontabContent, 'utf8');
      console.log('[MOCK CRON SYNC] Crontab atualizado com sucesso.');
    }
    return true;
  } catch (error) {
    console.error('Erro ao sincronizar crontab:', error);
    throw error;
  }
}

/**
 * Listar tarefas agendadas
 */
async function getCrons(req, res) {
  try {
    const crons = db.prepare('SELECT * FROM crons ORDER BY created_at DESC').all();
    res.json(crons);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar crons: ' + error.message });
  }
}

/**
 * Criar tarefa agendada
 */
async function createCron(req, res) {
  const { command, schedule, description } = req.body;

  if (!command || !schedule) {
    return res.status(400).json({ error: 'Comando e agendamento (cron expression) são obrigatórios.' });
  }

  // Validação simples da sintaxe do cron (5 campos separados por espaços)
  const cronParts = schedule.trim().split(/\s+/);
  if (cronParts.length !== 5) {
    return res.status(400).json({ error: 'Expressão cron inválida. Deve conter exatamente 5 campos (Ex: */5 * * * *).' });
  }

  try {
    db.prepare('INSERT INTO crons (command, schedule, description, enabled) VALUES (?, ?, ?, 1)')
      .run(command, schedule, description || '');

    await syncSystemCrontab();

    res.json({ message: 'Tarefa agendada criada com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar cron: ' + error.message });
  }
}

/**
 * Alternar estado de ativação (Habilitar/Desabilitar)
 */
async function toggleCron(req, res) {
  const { id, enabled } = req.body;

  try {
    db.prepare('UPDATE crons SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    await syncSystemCrontab();
    res.json({ message: `Tarefa agendada ${enabled ? 'habilitada' : 'desabilitada'} com sucesso!` });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar cron: ' + error.message });
  }
}

/**
 * Excluir tarefa agendada
 */
async function deleteCron(req, res) {
  const { id } = req.body;

  try {
    db.prepare('DELETE FROM crons WHERE id = ?').run(id);
    await syncSystemCrontab();
    res.json({ message: 'Tarefa agendada excluída com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao excluir cron: ' + error.message });
  }
}

/**
 * Executa uma tarefa agendada imediatamente e retorna a saída
 */
async function runCronImmediately(req, res) {
  const { id } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'ID do cron é obrigatório.' });
  }

  try {
    const cron = db.prepare('SELECT command FROM crons WHERE id = ?').get(id);
    if (!cron) {
      return res.status(404).json({ error: 'Tarefa agendada não encontrada.' });
    }

    const command = cron.command;
    const result = await execCommand(command);
    
    res.json({
      message: 'Tarefa executada com sucesso!',
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error ? result.error.message : null
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao executar tarefa: ' + error.message });
  }
}

module.exports = {
  getCrons,
  createCron,
  toggleCron,
  deleteCron,
  runCronImmediately
};
