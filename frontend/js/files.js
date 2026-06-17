let currentFmPath = '';
let fmBasePath = '';
let monacoEditorInstance = null;
let currentEditingFilePath = '';
let allLoadedFiles = []; // Cache local dos arquivos da pasta atual
let currentEditorFontSize = 14;


// Mapeamento de extensões para linguagens do Monaco Editor
const fileExtensionMap = {
  'js': 'javascript',
  'ts': 'typescript',
  'json': 'json',
  'html': 'html',
  'htm': 'html',
  'css': 'css',
  'php': 'php',
  'py': 'python',
  'sh': 'shell',
  'bash': 'shell',
  'yml': 'yaml',
  'yaml': 'yaml',
  'md': 'markdown',
  'sql': 'sql',
  'conf': 'nginx',
  'ini': 'ini'
};

/**
 * Carrega a listagem de arquivos de uma determinada pasta
 */
async function loadDirectory(targetPath = '') {
  try {
    const data = await apiGet(`/files/list?path=${encodeURIComponent(targetPath)}`);
    if (!data) return;

    currentFmPath = data.currentPath;
    fmBasePath = data.basePath;
    allLoadedFiles = data.files || [];

    // Limpa o campo de busca
    const searchInput = document.getElementById('fm-search');
    if (searchInput) searchInput.value = '';

    updateBreadcrumbs();
    renderFiles(allLoadedFiles);
  } catch (err) {
    console.error('Erro ao carregar diretório:', err);
  }
}

// Filtro de arquivos local (rápido, sem requisição extra ao backend)
window.filterFmFiles = function() {
  const query = document.getElementById('fm-search').value.toLowerCase().trim();
  if (!query) {
    renderFiles(allLoadedFiles);
    return;
  }
  const filtered = allLoadedFiles.filter(f => f.name.toLowerCase().includes(query));
  renderFiles(filtered);
};


/**
 * Atualiza o breadcrumb de navegação da barra de ferramentas
 */
function updateBreadcrumbs() {
  const container = document.getElementById('fm-breadcrumb');
  if (!container) return;

  container.innerHTML = '';

  // Determina a parte relativa do caminho para exibição
  let displayPath = currentFmPath;
  const isWindows = !currentFmPath.startsWith('/');
  
  const separator = isWindows ? '\\' : '/';
  const parts = displayPath.split(separator).filter(Boolean);

  // Botão raiz / home
  const homeSpan = document.createElement('span');
  homeSpan.className = 'breadcrumb-item';
  homeSpan.innerText = isWindows ? 'Home' : 'root';
  homeSpan.onclick = () => loadDirectory(fmBasePath);
  container.appendChild(homeSpan);

  let accumulatedPath = isWindows ? '' : '/';
  
  parts.forEach((part, index) => {
    // Evita acumular a letra do drive duas vezes no Windows (ex: C:)
    if (isWindows && index === 0 && part.includes(':')) {
      accumulatedPath = part + separator;
    } else {
      accumulatedPath = pathJoin(accumulatedPath, part, separator);
    }

    const sep = document.createElement('span');
    sep.className = 'breadcrumb-separator';
    sep.innerText = ' / ';
    container.appendChild(sep);

    const item = document.createElement('span');
    item.className = 'breadcrumb-item';
    item.innerText = part;
    
    const target = accumulatedPath;
    item.onclick = () => loadDirectory(target);
    container.appendChild(item);
  });
}

function pathJoin(base, part, separator) {
  if (base.endsWith(separator)) {
    return base + part;
  }
  return base + separator + part;
}

/**
 * Renderiza os arquivos na tabela
 */
function renderFiles(files) {
  const container = document.getElementById('fm-file-list');
  if (!container) return;

  container.innerHTML = '';

  if (files.length === 0) {
    container.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--text-muted);">Pasta vazia.</div>`;
    return;
  }

  // Se não estivermos na pasta raiz/base, adiciona opção de subir um nível ".."
  const isWindows = !currentFmPath.startsWith('/');
  const separator = isWindows ? '\\' : '/';
  
  if (currentFmPath !== fmBasePath) {
    const parentFolder = currentFmPath.substring(0, currentFmPath.lastIndexOf(separator)) || (isWindows ? '' : '/');
    const row = document.createElement('div');
    row.className = 'file-list-row';
    row.onclick = () => loadDirectory(parentFolder);
    row.innerHTML = `
      <div class="file-list-col-name">
        <span class="file-icon folder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
        </span>
        <strong>..</strong>
      </div>
      <div class="file-list-col-size">-</div>
      <div class="file-list-col-perms">-</div>
      <div class="file-list-col-actions"></div>
    `;
    container.appendChild(row);
  }

  files.forEach(file => {
    const row = document.createElement('div');
    row.className = 'file-list-row';
    
    // Clique duplo abre ou entra no diretório
    row.onclick = (e) => {
      // Ignora clique se clicou nos botões de ação
      if (e.target.closest('.file-list-col-actions') || e.target.closest('button')) {
        return;
      }
      if (file.isDirectory) {
        loadDirectory(file.path);
      } else {
        openFileInEditor(file.path);
      }
    };

    const sizeStr = file.isDirectory ? '-' : formatBytes(file.size);
    const iconClass = file.isDirectory ? 'folder' : 'file';
    
    // Ícone SVG correspondente
    const iconSvg = file.isDirectory 
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`;

    // Botões adicionais (Extrair se for ZIP, ou Descarregar se for arquivo)
    let extraAction = '';
    if (!file.isDirectory) {
      if (file.name.endsWith('.zip') || file.name.endsWith('.tar.gz') || file.name.endsWith('.tgz')) {
        extraAction = `
          <button class="btn-icon-sm" onclick="extractArchive('${file.path}')" title="Extrair Arquivo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="21 15 16 20 11 15"></polyline><line x1="16" y1="10" x2="16" y2="20"></line><path d="M8 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-4"></path></svg>
          </button>
        `;
      }
      extraAction += `
        <button class="btn-icon-sm" onclick="downloadFmFile('${file.path}', '${file.name}')" title="Descarregar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"></path></svg>
        </button>
      `;
    }

    row.innerHTML = `
      <div class="file-list-col-name">
        <span class="file-icon ${iconClass}">${iconSvg}</span>
        <span>${file.name}</span>
      </div>
      <div class="file-list-col-size">${sizeStr}</div>
      <div class="file-list-col-perms">${file.permissions}</div>
      <div class="file-list-col-actions">
        ${extraAction}
        <button class="btn-icon-sm" onclick="compressFmItem('${file.path}', '${file.name}')" title="Compactar para ZIP">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>
        </button>
        <button class="btn-icon-sm" onclick="openChmodModal('${file.path}', '${file.permissions}')" title="Permissões">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
        </button>
        <button class="btn-icon-sm" onclick="renameFmItem('${file.path}', '${file.name}')" title="Renomear">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polygon points="14 2 18 6 7 17 3 17 3 13 14 2"></polygon></svg>
        </button>
        <button class="btn-icon-sm danger" onclick="deleteFmItem('${file.path}', '${file.name}')" title="Excluir">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
        </button>
      </div>
    `;
    container.appendChild(row);
  });
}

// downloadFmFile helper function
window.downloadFmFile = function(filePath, fileName) {
  const token = localStorage.getItem('bcp_token');
  const url = `/api/files/download?path=${encodeURIComponent(filePath)}&token=${token}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

// Drag and drop initialization
document.addEventListener('DOMContentLoaded', () => {
  const dragArea = document.getElementById('fm-drag-area');
  const dragOverlay = document.getElementById('fm-drag-overlay');
  
  if (dragArea && dragOverlay) {
    ['dragenter', 'dragover'].forEach(eventName => {
      dragArea.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragOverlay.style.display = 'flex';
      }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dragArea.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragOverlay.style.display = 'none';
      }, false);
    });

    dragArea.addEventListener('drop', async (e) => {
      const dt = e.dataTransfer;
      const files = dt.files;

      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          await uploadSingleFile(files[i]);
        }
      }
    }, false);
  }
});

async function uploadSingleFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  try {
    showToast(`Enviando ${file.name}...`, 'info');
    const data = await apiUpload(`/files/upload?path=${encodeURIComponent(currentFmPath)}`, formData);
    if (data) {
      showToast(`Ficheiro ${file.name} enviado com sucesso!`, 'success');
    }
  } catch (err) {
    showToast(`Erro ao subir ${file.name}: ${err.message}`, 'error');
  } finally {
    reloadFiles();
  }
}

function reloadFiles() {
  loadDirectory(currentFmPath);
}

/**
 * Inicialização e carregamento do Monaco Editor
 */
function initMonacoEditor(containerId, initialValue = '', language = 'javascript') {
  return new Promise((resolve) => {
    // Carrega o Monaco via require.js CDN
    require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs' } });
    
    // Configura o loader do RequireJS para forçar o Monaco no escopo window
    require(['vs/editor/editor.main'], function() {
      // Se já houver uma instância, a destrói para evitar vazamento de memória
      if (monacoEditorInstance) {
        monacoEditorInstance.dispose();
      }

      // Restaura o select de tema para vs-dark padrão
      const themeSelect = document.getElementById('editor-theme-select');
      if (themeSelect) themeSelect.value = 'vs-dark';

      monacoEditorInstance = monaco.editor.create(document.getElementById(containerId), {
        value: initialValue,
        language: language,
        theme: 'vs-dark',
        automaticLayout: true,
        fontSize: currentEditorFontSize,
        fontFamily: 'JetBrains Mono, Courier New, monospace',
        minimap: { enabled: true },
        cursorBlinking: 'smooth',
        roundedSelection: true
      });

      // Atalho de teclado: Ctrl + S para salvar alterações
      monacoEditorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function() {
        saveCurrentFile();
      });

      resolve(monacoEditorInstance);
    });
  });
}

// Funções para controle do Monaco
window.changeEditorTheme = function() {
  if (!monacoEditorInstance) return;
  const theme = document.getElementById('editor-theme-select').value;
  monaco.editor.setTheme(theme);
};

window.zoomEditor = function(direction) {
  if (!monacoEditorInstance) return;
  currentEditorFontSize = Math.max(10, Math.min(30, currentEditorFontSize + direction * 2));
  monacoEditorInstance.updateOptions({ fontSize: currentEditorFontSize });
};

window.toggleEditorFullscreen = function() {
  const modalBox = document.querySelector('#modal-monaco-editor .modal-box');
  const btn = document.getElementById('btn-editor-fullscreen');
  if (modalBox.classList.toggle('fullscreen-editor')) {
    btn.innerText = 'Sair Full';
    btn.style.borderColor = 'var(--color-primary)';
  } else {
    btn.innerText = 'Full';
    btn.style.borderColor = '';
  }
  if (monacoEditorInstance) {
    monacoEditorInstance.layout();
  }
};


/**
 * Abre o arquivo no Monaco Editor
 */
async function openFileInEditor(filePath) {
  try {
    currentEditingFilePath = filePath;
    document.getElementById('editor-file-path').innerText = filePath;

    // Busca o conteúdo
    const data = await apiGet(`/files/read?path=${encodeURIComponent(filePath)}`);
    if (!data) return;

    // Determina a linguagem com base na extensão
    const ext = filePath.split('.').pop().toLowerCase();
    const language = fileExtensionMap[ext] || 'plaintext';

    // Configura a UI do editor integrado
    const editorToolbar = document.getElementById('fm-editor-toolbar');
    const editorPlaceholder = document.getElementById('fm-editor-placeholder');
    if (editorToolbar) editorToolbar.style.display = 'flex';
    if (editorPlaceholder) editorPlaceholder.style.display = 'none';

    // Inicializa o Monaco com o conteúdo
    await initMonacoEditor('monaco-container', data.content, language);
  } catch (err) {
    console.error('Falha ao abrir arquivo:', err);
  }
}

/**
 * Salva o arquivo atual que está sendo editado
 */
window.currentEditingNginxDomain = null;

async function saveCurrentFile() {
  if (!monacoEditorInstance) return;

  const content = monacoEditorInstance.getValue();

  if (window.currentEditingNginxDomain) {
    try {
      const data = await apiPost('/sites/config', {
        domain: window.currentEditingNginxDomain,
        content: content
      });
      if (data) {
        showToast('Configuração do Nginx salva e recarregada com sucesso!', 'success');
      }
    } catch (err) {
      showToast('Falha ao salvar configuração: ' + err.message, 'error');
    }
    return;
  }

  if (!currentEditingFilePath) return;

  try {
    const data = await apiPost('/files/save', {
      path: currentEditingFilePath,
      content: content
    });
    
    if (data) {
      showToast('Ficheiro guardado com sucesso!', 'success');
    }
  } catch (err) {
    showToast('Falha ao salvar arquivo: ' + err.message, 'error');
  }
}

window.closeEmbeddedEditor = function() {
  // Mostra a barra lateral e a barra de ferramentas do gestor de ficheiros de volta
  const fmListContainer = document.getElementById('fm-file-list-container');
  const fmToolbar = document.querySelector('.filemanager-toolbar');
  if (fmListContainer) fmListContainer.style.display = 'flex';
  if (fmToolbar) fmToolbar.style.display = 'flex';

  // Habilita o placeholder do editor e esconde a toolbar do editor
  const editorToolbar = document.getElementById('fm-editor-toolbar');
  const editorPlaceholder = document.getElementById('fm-editor-placeholder');
  if (editorToolbar) editorToolbar.style.display = 'none';
  if (editorPlaceholder) editorPlaceholder.style.display = 'flex';

  if (monacoEditorInstance) {
    monacoEditorInstance.dispose();
    monacoEditorInstance = null;
  }
  currentEditingFilePath = '';
  
  if (window.currentEditingNginxDomain) {
    window.currentEditingNginxDomain = null;
    // Se estávamos a editar as configurações do Nginx de um site, regressa ao separador de sites
    switchContextTab('sites');
  }
};

window.closeEditorModal = function() {
  window.closeEmbeddedEditor();
};

window.openNginxConfigModal = async function(domain) {
  try {
    window.currentEditingNginxDomain = domain;
    currentEditingFilePath = '';
    
    showToast('Lendo configuração do Nginx...', 'info');
    const data = await apiGet(`/sites/config?domain=${encodeURIComponent(domain)}`);
    if (!data) return;

    switchContextTab('files');

    // Esconde a barra lateral e a barra de ferramentas do gestor de ficheiros
    const fmListContainer = document.getElementById('fm-file-list-container');
    const fmToolbar = document.querySelector('.filemanager-toolbar');
    if (fmListContainer) fmListContainer.style.display = 'none';
    if (fmToolbar) fmToolbar.style.display = 'none';

    // Configura o título do arquivo
    document.getElementById('editor-file-path').innerText = `Nginx Config: ${domain}`;

    // Mostra a barra de ferramentas do editor e remove o placeholder
    const editorToolbar = document.getElementById('fm-editor-toolbar');
    const editorPlaceholder = document.getElementById('fm-editor-placeholder');
    if (editorToolbar) editorToolbar.style.display = 'flex';
    if (editorPlaceholder) editorPlaceholder.style.display = 'none';

    await initMonacoEditor('monaco-container', data.content, 'nginx');
  } catch (err) {
    console.error('Falha ao carregar Nginx config:', err);
    showToast('Falha ao ler configuração: ' + err.message, 'error');
  }
};


/**
 * Upload de arquivos
 */
async function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  try {
    showToast(`Enviando ${file.name}...`, 'info');
    // Envia o caminho de destino na query string para o Multer interceptar
    const data = await apiUpload(`/files/upload?path=${encodeURIComponent(currentFmPath)}`, formData);
    if (data) {
      showToast('Arquivo enviado com sucesso!', 'success');
      reloadFiles();
    }
  } catch (err) {
    showToast('Erro ao subir arquivo: ' + err.message, 'error');
  } finally {
    event.target.value = ''; // Limpa o input
  }
}

/**
 * Criar arquivo/pasta
 */
function openCreateItemModal(type) {
  document.getElementById('create-fm-type').value = type;
  document.getElementById('create-fm-title').innerText = type === 'folder' ? 'Criar Nova Pasta' : 'Criar Novo Ficheiro';
  document.getElementById('create-fm-name').value = '';
  document.getElementById('create-fm-name').placeholder = type === 'folder' ? 'ex: assets' : 'ex: index.html';
  openModal('modal-create-fm-item');
}

document.getElementById('create-fm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('create-fm-name').value;
  const type = document.getElementById('create-fm-type').value;

  try {
    const data = await apiPost('/files/create', {
      parentPath: currentFmPath,
      name,
      type
    });

    if (data) {
      showToast(data.message, 'success');
      closeModal('modal-create-fm-item');
      reloadFiles();
    }
  } catch (err) {}
});

/**
 * Excluir arquivo/pasta
 */
async function deleteFmItem(itemPath, itemName) {
  if (!confirm(`Tem a certeza que deseja excluir "${itemName}"? Esta ação não pode ser desfeita.`)) {
    return;
  }

  try {
    const data = await apiDelete('/files/delete', { path: itemPath });
    if (data) {
      showToast(data.message, 'success');
      reloadFiles();
    }
  } catch (err) {}
}

/**
 * Renomear item
 */
async function renameFmItem(itemPath, itemName) {
  const newName = prompt(`Introduza o novo nome para "${itemName}":`, itemName);
  if (!newName || newName === itemName) return;

  // Monta o novo caminho mantendo a mesma pasta de origem
  const separator = currentFmPath.includes('\\') ? '\\' : '/';
  const newPath = currentFmPath + separator + newName;

  try {
    const data = await apiPost('/files/rename', {
      oldPath: itemPath,
      newPath: newPath
    });
    if (data) {
      showToast(data.message, 'success');
      reloadFiles();
    }
  } catch (err) {}
}

/**
 * Chmod Permissões
 */
function openChmodModal(itemPath, currentPerms) {
  document.getElementById('chmod-file-path').value = itemPath;
  // Extrai apenas os últimos 3 caracteres (octais simples)
  document.getElementById('chmod-mode').value = currentPerms.slice(-3);
  openModal('modal-chmod');
}

document.getElementById('chmod-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const filePath = document.getElementById('chmod-file-path').value;
  const mode = document.getElementById('chmod-mode').value;

  try {
    const data = await apiPost('/files/permissions', {
      path: filePath,
      mode: mode
    });
    if (data) {
      showToast(data.message, 'success');
      closeModal('modal-chmod');
      reloadFiles();
    }
  } catch (err) {}
});

/**
 * Extrair ZIP/TAR
 */
async function extractArchive(filePath) {
  try {
    showToast('Extraindo arquivo, por favor aguarde...', 'info');
    const data = await apiPost('/files/extract', { path: filePath });
    if (data) {
      showToast(data.message, 'success');
      reloadFiles();
    }
  } catch (err) {}
}

// Helpers de formatação
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0.00 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(dm) + ' ' + sizes[i];
}

/**
 * Compactar arquivo ou pasta em ZIP
 */
window.compressFmItem = async function(filePath, itemName) {
  try {
    const zipName = itemName + '.zip';
    showToast(`A compactar ${itemName} para ${zipName}...`, 'info');
    
    const data = await apiPost('/files/compress', {
      parentPath: currentFmPath,
      items: [itemName],
      zipName: zipName,
      gameServerId: window.selectedGameServerId || null,
      sitePath: window.activeFmContext === 'site' ? currentFmPath : null
    });
    
    if (data) {
      showToast(data.message, 'success');
      reloadFiles();
    }
  } catch (err) {
    console.error('Falha ao compactar:', err);
    showToast('Falha ao compactar: ' + err.message, 'error');
  }
};
