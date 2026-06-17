const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { execCommand, isLinux, getSystemPath } = require('../services/systemService');
const dockerService = require('../services/dockerService');

// Determina a pasta base padrão para navegação
function getBaseDirectory(req) {
  const gameServerId = req ? (req.query.gameServerId || req.body.gameServerId) : null;
  if (gameServerId) {
    return dockerService.getGameServerDir(gameServerId);
  }

  const sitePath = req ? (req.query.sitePath || req.body.sitePath) : null;
  if (sitePath) {
    return sitePath;
  }

  if (isLinux) {
    return '/var/www';
  } else {
    // No Windows, usa a pasta temp/var/www como root
    return getSystemPath('www');
  }
}

// Helper para validar caminhos e evitar Path Traversal
function resolveSafePath(relativeOrAbsolutePath, req) {
  const baseDir = getBaseDirectory(req);
  
  let targetPath = relativeOrAbsolutePath || '';
  if (!path.isAbsolute(targetPath)) {
    targetPath = path.join(baseDir, targetPath);
  }
  
  const resolved = path.resolve(targetPath);
  
  // Restrição de segurança: se baseDir for específico de site ou jogo, impede de subir acima
  const gameServerId = req ? (req.query.gameServerId || req.body.gameServerId) : null;
  const sitePath = req ? (req.query.sitePath || req.body.sitePath) : null;
  
  if (gameServerId || sitePath) {
    if (!resolved.startsWith(baseDir)) {
      return baseDir;
    }
  }
  
  return resolved;
}

/**
 * Listagem otimizada de arquivos e pastas
 */
async function listFiles(req, res) {
  try {
    const rawPath = req.query.path || '';
    const targetPath = resolveSafePath(rawPath, req);
    
    // Verifica se o diretório existe
    try {
      const stats = await fs.stat(targetPath);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'O caminho informado não é um diretório.' });
      }
    } catch (err) {
      return res.status(404).json({ error: 'Diretório não encontrado.' });
    }

    // Lê entradas com tipos para evitar chamadas extras desnecessárias
    const entries = await fs.readdir(targetPath, { withFileTypes: true });

    // Busca os metadados de todos em paralelo (alta performance para muitos arquivos)
    const result = await Promise.all(entries.map(async (entry) => {
      const filePath = path.join(targetPath, entry.name);
      let size = 0;
      let modified = new Date();
      let permissions = '0644';
      let owner = 0;
      let group = 0;

      try {
        const stats = await fs.stat(filePath);
        size = stats.size;
        modified = stats.mtime;
        permissions = '0' + (stats.mode & parseInt('777', 8)).toString(8);
        owner = stats.uid;
        group = stats.gid;
      } catch (statErr) {
        // Fallback em caso de falha de leitura (ex: permissões rígidas)
      }

      return {
        name: entry.name,
        path: filePath,
        isDirectory: entry.isDirectory(),
        size,
        modified,
        permissions,
        owner,
        group
      };
    }));

    // Ordena: pastas primeiro, depois arquivos alfabeticamente
    result.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json({
      currentPath: targetPath,
      basePath: getBaseDirectory(req),
      files: result
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar arquivos: ' + error.message });
  }
}

/**
 * Ler conteúdo de um arquivo (para o editor Monaco)
 */
async function readFileContent(req, res) {
  try {
    const targetPath = resolveSafePath(req.query.path, req);
    const stats = await fs.stat(targetPath);

    if (stats.isDirectory()) {
      return res.status(400).json({ error: 'Não é possível ler um diretório.' });
    }

    // Evita ler arquivos gigantes (maiores que 10MB) de uma vez
    if (stats.size > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Arquivo muito grande para abrir no editor. Limite de 10MB.' });
    }

    const content = await fs.readFile(targetPath, 'utf8');
    res.json({ content, path: targetPath });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao ler arquivo: ' + error.message });
  }
}

/**
 * Salvar conteúdo do arquivo (editado no Monaco)
 */
async function saveFileContent(req, res) {
  try {
    const targetPath = resolveSafePath(req.body.path, req);
    const content = req.body.content || '';

    await fs.writeFile(targetPath, content, 'utf8');
    res.json({ message: 'Arquivo salvo com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao salvar arquivo: ' + error.message });
  }
}

/**
 * Criar novo arquivo ou pasta
 */
async function createItem(req, res) {
  try {
    const parentPath = resolveSafePath(req.body.parentPath, req);
    const name = req.body.name;
    const type = req.body.type; // 'file' ou 'folder'

    const targetPath = path.join(parentPath, name);

    if (type === 'folder') {
      await fs.mkdir(targetPath, { recursive: true });
    } else {
      await fs.writeFile(targetPath, '', 'utf8');
    }

    res.json({ message: `${type === 'folder' ? 'Pasta' : 'Arquivo'} criado com sucesso!`, path: targetPath });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar item: ' + error.message });
  }
}

/**
 * Excluir arquivos ou pastas recursivamente
 */
async function deleteItem(req, res) {
  try {
    const targetPath = resolveSafePath(req.body.path, req);
    const stats = await fs.stat(targetPath);

    if (stats.isDirectory()) {
      await fs.rm(targetPath, { recursive: true, force: true });
    } else {
      await fs.unlink(targetPath);
    }

    res.json({ message: 'Item excluído com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao excluir item: ' + error.message });
  }
}

/**
 * Renomear ou mover arquivos/pastas
 */
async function renameItem(req, res) {
  try {
    const oldPath = resolveSafePath(req.body.oldPath, req);
    const newPath = resolveSafePath(req.body.newPath, req);

    await fs.rename(oldPath, newPath);
    res.json({ message: 'Item renomeado/movido com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao renomear item: ' + error.message });
  }
}

/**
 * Alterar permissões (chmod) e proprietário (chown)
 */
async function changePermissions(req, res) {
  try {
    const targetPath = resolveSafePath(req.body.path, req);
    const mode = req.body.mode; // ex: '755' ou '644'
    const owner = req.body.owner; // ex: 'www-data'

    if (mode) {
      const modeOctal = parseInt(mode, 8);
      await fs.chmod(targetPath, modeOctal);
    }

    if (owner && isLinux) {
      await execCommand(`chown -R ${owner}:${owner} "${targetPath}"`);
    }

    res.json({ message: 'Permissões atualizadas com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao mudar permissões: ' + error.message });
  }
}

/**
 * Compactar arquivos (zip)
 */
async function compressItems(req, res) {
  try {
    const parentPath = resolveSafePath(req.body.parentPath, req);
    const items = req.body.items; // Array de nomes de arquivos/pastas
    const zipName = req.body.zipName || 'archive.zip';

    const targetZip = path.join(parentPath, zipName);

    if (isLinux) {
      const itemsString = items.map(item => `"${item}"`).join(' ');
      const cmd = `cd "${parentPath}" && zip -r "${targetZip}" ${itemsString}`;
      const result = await execCommand(cmd);
      if (result.error) {
        return res.status(500).json({ error: 'Erro na compactação: ' + result.stderr });
      }
    } else {
      // No Windows mock, apenas cria um arquivo zip fake
      await fs.writeFile(targetZip, 'MOCK ZIP CONTENT', 'utf8');
    }

    res.json({ message: 'Arquivos compactados com sucesso!', path: targetZip });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao compactar: ' + error.message });
  }
}

/**
 * Extrair arquivos (unzip)
 */
async function extractItem(req, res) {
  try {
    const zipPath = resolveSafePath(req.body.path, req);
    const parentPath = path.dirname(zipPath);

    if (isLinux) {
      let cmd = '';
      if (zipPath.endsWith('.zip')) {
        cmd = `unzip -o "${zipPath}" -d "${parentPath}"`;
      } else if (zipPath.endsWith('.tar.gz') || zipPath.endsWith('.tgz')) {
        cmd = `tar -xzf "${zipPath}" -C "${parentPath}"`;
      } else {
        return res.status(400).json({ error: 'Formato de arquivo não suportado para extração.' });
      }

      const result = await execCommand(cmd);
      if (result.error) {
        return res.status(500).json({ error: 'Erro na extração: ' + result.stderr });
      }
    } else {
      // No Windows mock, apenas simula a extração criando um arquivo temporário extraído
      const extractedMockFile = path.join(parentPath, 'extracted_file.txt');
      await fs.writeFile(extractedMockFile, 'Extracted mock content', 'utf8');
    }

    res.json({ message: 'Arquivo extraído com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao extrair: ' + error.message });
  }
}

/**
 * Descarregar um ficheiro
 */
async function downloadFile(req, res) {
  try {
    const targetPath = resolveSafePath(req.query.path, req);
    const stats = await fs.stat(targetPath);

    if (stats.isDirectory()) {
      return res.status(400).json({ error: 'Não é possível descarregar um diretório.' });
    }

    res.download(targetPath);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao descarregar ficheiro: ' + error.message });
  }
}

module.exports = {
  listFiles,
  readFileContent,
  saveFileContent,
  createItem,
  deleteItem,
  renameItem,
  changePermissions,
  compressItems,
  extractItem,
  downloadFile
};
