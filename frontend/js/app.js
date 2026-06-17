let wsConnection = null;
let remoteConsoleWs = null;
let terminalOffset = 0;
const terminalLimit = 100;
let terminalHasMore = true;
let terminalIsLoading = false;

// Modal global functions
window.openModal = function(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('active');
  if (id === 'modal-create-game-server') {
    populateNodesDropdown();
  }
};
window.closeModal = function(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('active');
  if (id === 'modal-files') {
    window.activeFmContext = null;
  }
  if (id === 'modal-game-console' || id === 'modal-site-console') {
    if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
      wsConnection.send(JSON.stringify({ type: 'close_console' }));
    }
    if (remoteConsoleWs) {
      try {
        remoteConsoleWs.close();
      } catch (e) {}
      remoteConsoleWs = null;
    }
  }
};
window.closeAllModals = function() {
  const activeModals = document.querySelectorAll('.modal-overlay.active');
  activeModals.forEach(modal => {
    const id = modal.id;
    if (id) {
      if (id === 'modal-monaco-editor') {
        if (typeof window.closeEditorModal === 'function') {
          window.closeEditorModal();
        } else {
          window.closeModal(id);
        }
      } else {
        window.closeModal(id);
      }
    }
  });
};
// Clipboard Helper
window.copyToClipboard = function(text) {
  if (!navigator.clipboard) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
      showToast('Copiado para a área de transferência!', 'success');
    } catch (err) {
      showToast('Falha ao copiar.', 'error');
    }
    document.body.removeChild(textArea);
    return;
  }
  navigator.clipboard.writeText(text).then(() => {
    showToast('Copiado para a área de transferência!', 'success');
  }, () => {
    showToast('Falha ao copiar.', 'error');
  });
};

// Search list filter helpers
window.filterSitesList = function() {
  const query = document.getElementById('sites-search').value.toLowerCase().trim();
  const rows = document.querySelectorAll('#sites-list-body tr');
  rows.forEach(row => {
    const text = row.innerText.toLowerCase();
    if (text.includes(query) || row.querySelector('td[colspan]')) {
      row.style.display = '';
    } else {
      row.style.display = 'none';
    }
  });
};

window.filterDatabasesList = function() {
  const query = document.getElementById('db-search').value.toLowerCase().trim();
  const rows = document.querySelectorAll('#db-list-body tr');
  rows.forEach(row => {
    const text = row.innerText.toLowerCase();
    if (text.includes(query) || row.querySelector('td[colspan]')) {
      row.style.display = '';
    } else {
      row.style.display = 'none';
    }
  });
};

window.filterEmailsList = function() {
  const query = document.getElementById('email-search').value.toLowerCase().trim();
  const rows = document.querySelectorAll('#email-list-body tr');
  rows.forEach(row => {
    const text = row.innerText.toLowerCase();
    if (text.includes(query) || row.querySelector('td[colspan]')) {
      row.style.display = '';
    } else {
      row.style.display = 'none';
    }
  });
};

window.filterLogsOutput = function() {
  const query = document.getElementById('logs-filter').value.toLowerCase().trim();
  const lines = document.querySelectorAll('#logs-terminal-box .terminal-line');
  lines.forEach(line => {
    const text = line.innerText.toLowerCase();
    if (text.includes(query)) {
      line.style.display = '';
    } else {
      line.style.display = 'none';
    }
  });
};

// Inicialização principal
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  connectWebSocket();
  setupForms();
  setupGamesForms();
  setupNodesForms();
  setupProfileForms();
  
  // Carrega perfil e atualiza avatar
  loadUserProfile();
  
  // Verifica se o usuário é admin para exibir o menu de utilizadores
  const role = localStorage.getItem('bcp_role');
  if (role === 'admin') {
    const navUsers = document.getElementById('nav-item-users');
    if (navUsers) navUsers.style.display = '';
  }

  // Se houver um hash no URL (migração/compatibilidade), redireciona para a rota limpa
  if (window.location.hash) {
    const hashTab = window.location.hash.substring(1);
    window.history.replaceState(null, '', '/' + hashTab);
  } else if (window.location.pathname === '/' || window.location.pathname === '/index.html') {
    window.history.replaceState(null, '', '/dashboard');
  }
  handleRouting();

  // Tratamento de Logout
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.clear();
      window.location.href = '/login';
    });
  }
});

// Navegação SPA (Abas) baseada no path da URL (HTML5 History API)
function setupNavigation() {
  const menuItems = document.querySelectorAll('.nav-item');
  menuItems.forEach(item => {
    item.addEventListener('click', (e) => {
      const tabId = item.getAttribute('data-tab');
      if (tabId) {
        e.preventDefault();
        window.history.pushState(null, '', '/' + tabId);
        handleRouting();
      }
    });
  });

  window.addEventListener('popstate', handleRouting);
}

window.handleRouting = function() {
  // Remover os estilos de roteamento rápido para evitar conflitos posteriores
  const earlyTabStyle = document.getElementById('early-active-tab-style');
  if (earlyTabStyle) earlyTabStyle.remove();
  const earlySidebarStyle = document.getElementById('early-active-sidebar-style');
  if (earlySidebarStyle) earlySidebarStyle.remove();

  // Fecha todos os modais ao mudar de página/aba
  if (typeof window.closeAllModals === 'function') {
    window.closeAllModals();
  }

  // Limpar auto-refresh de processos ao navegar
  if (window.processesIntervalId) {
    clearInterval(window.processesIntervalId);
    window.processesIntervalId = null;
  }

  let path = window.location.pathname.substring(1) || 'dashboard';
  if (path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  const tabId = path;



  const menuItems = document.querySelectorAll('.nav-item');
  const panes = document.querySelectorAll('.tab-pane');
  const pageTitle = document.getElementById('page-title');
  
  // Encontra o item de menu correspondente
  const matchingItem = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
  if (!matchingItem && tabId !== 'profile') {
    // Se o path for inválido/desconhecido, redireciona para o dashboard
    window.history.replaceState(null, '', '/dashboard');
    handleRouting();
    return;
  }
  
  // O utilizador prefere a cor padrão do sistema (Hacker Green) para todas as páginas
  let targetThemeClass = ''; 

  if (document.body.className !== targetThemeClass) {
    document.body.className = targetThemeClass;
    if (typeof window.updateChartColors === 'function') {
      window.updateChartColors();
    }
  }
  
  // Atualiza a classe ativa na barra lateral
  menuItems.forEach(item => {
    if (item.getAttribute('data-tab') === tabId) {
      item.classList.add('active');
      // Altera o título do cabeçalho
      pageTitle.innerText = item.textContent.trim();
    } else {
      item.classList.remove('active');
    }
  });

  if (tabId === 'profile' && pageTitle) {
    pageTitle.innerText = 'Meu Perfil';
  }

  // Exibe o painel correspondente
  panes.forEach(pane => {
    if (pane.id === `tab-${tabId}`) {
      pane.classList.add('active');
    } else {
      pane.classList.remove('active');
    }
  });

  // Dispara carregamentos específicos ao mudar de aba
  switch (tabId) {
    case 'dashboard':
      if (window.performanceChart) {
        window.performanceChart.resize();
        window.performanceChart.update('none');
      }
      loadGameDashboard(); // Carrega estatísticas do Docker/Jogos junto no dashboard principal
      checkPanelVersion(); // Verifica a versão do painel no GitHub
      break;
    case 'sites':
      loadSites();
      break;
    case 'databases':
      loadDatabases();
      break;
    case 'emails':
      loadEmails();
      break;
    case 'files':
      if (typeof window.pendingDirectoryToLoad !== 'undefined') {
        loadDirectory(window.pendingDirectoryToLoad);
        delete window.pendingDirectoryToLoad;
      } else {
        loadDirectory('');
      }
      break;
    case 'crons':
      loadCrons();
      break;
    case 'security':
      loadSecurity();
      break;
    case 'logs':
      loadSystemLogs();
      break;
    case 'users':
      loadUsers();
      load2FAStatus();
      break;
    case 'game-servers':
      loadGameServers();
      break;
    case 'nodes':
      loadNodes();
      break;
    case 'processes':
      loadProcesses();
      // Auto-refresh a cada 2 segundos quando nesta aba
      window.processesIntervalId = setInterval(loadProcesses, 2000);
      break;
    case 'console':
      loadRootConsole();
      break;
    case 'profile':
      loadUserProfile();
      break;
  }
  updateConsoleTabState();
};

window.modulesPreloaded = false;
async function preloadAllModules() {
  if (window.modulesPreloaded) return;
  window.modulesPreloaded = true;
  console.log('[BCP] A iniciar pré-carregamento dos módulos em segundo plano...');
  
  // 1. Segunda coisa a carregar: Consola Terminal
  try {
    loadRootConsole();
  } catch (e) {
    console.error('Erro ao pré-carregar Consola:', e);
  }

  // 2. Pré-carregar Websites e Servidores de Jogos (500ms de atraso)
  setTimeout(async () => {
    try {
      await loadSites();
      if (typeof window.loadGameServers === 'function') {
        await window.loadGameServers();
      }
    } catch (e) {
      console.error('Erro ao pré-carregar Websites/Jogos:', e);
    }
  }, 500);

  // 3. Pré-carregar Bases de Dados e E-mails (1000ms de atraso)
  setTimeout(async () => {
    try {
      await loadDatabases();
      await loadEmails();
    } catch (e) {
      console.error('Erro ao pré-carregar DBs/Emails:', e);
    }
  }, 1000);

  // 4. Pré-carregar Crons, Segurança e Utilizadores (1500ms de atraso)
  setTimeout(async () => {
    try {
      await loadCrons();
      await loadSecurity();
      const role = localStorage.getItem('bcp_role');
      if (role === 'admin') {
        await loadUsers();
      }
    } catch (e) {
      console.error('Erro ao pré-carregar Crons/Segurança/Utilizadores:', e);
    }
  }, 1500);
}

// Conexão WebSocket para estatísticas em tempo real
function connectWebSocket() {
  const token = localStorage.getItem('bcp_token');
  if (!token) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}?token=${token}`;

  wsConnection = new WebSocket(wsUrl);

  wsConnection.onopen = () => {
    console.log('[WS] Conectado ao servidor de monitorização.');
    preloadAllModules();
  };

  wsConnection.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'metrics_history') {
        if (typeof window.updateChartHistory === 'function') {
          window.updateChartHistory(msg.data);
        }
      } else if (msg.type === 'metrics') {
        updateDashboardUI(msg.data);
      } else if (msg.type === 'console_log') {
        if (window.selectedGameServerId && msg.gameServerId === window.selectedGameServerId) {
          const consoleBox = document.getElementById('game-console-box');
          if (consoleBox) {
            if (consoleBox.innerHTML.includes('Carregando logs')) {
              consoleBox.innerHTML = '';
            }
            const isScrolledToBottom = consoleBox.scrollHeight - consoleBox.clientHeight <= consoleBox.scrollTop + 100;
            const span = document.createElement('span');
            span.textContent = msg.data;
            consoleBox.appendChild(span);
            if (isScrolledToBottom || consoleBox.childNodes.length <= 10) {
              consoleBox.scrollTop = consoleBox.scrollHeight;
            }
          }
        }
      } else if (msg.type === 'root_console_log') {
        const consoleBox = document.getElementById('root-console-box');
        if (consoleBox) {
          if (consoleBox.innerHTML.includes('Conectando ao terminal')) {
            consoleBox.innerHTML = '';
          }
          const isScrolledToBottom = consoleBox.scrollHeight - consoleBox.clientHeight <= consoleBox.scrollTop + 100;

          // Divide a mensagem por quebras de linha para estilizar cada uma individualmente
          const lines = msg.data.split('\n');
          lines.forEach(line => {
            if (!line.trim()) return;

            const div = document.createElement('div');
            div.style.lineHeight = '1.6';
            div.style.whiteSpace = 'pre-wrap';

            // Regex para identificar se a linha é um comando (ex: [data-hora] username: comando)
            const isCommand = /^\[[^\]]+\]\s+[a-zA-Z0-9_-]+:/.test(line);

            if (isCommand) {
              div.style.color = '#00d2ff'; // Azul brilhante para comandos
              div.style.fontWeight = '500';
            } else {
              div.style.color = '#ffffff'; // Branco para respostas
            }

            div.textContent = line;
            consoleBox.appendChild(div);
          });

          if (isScrolledToBottom || consoleBox.childNodes.length <= 120) {
            consoleBox.scrollTop = consoleBox.scrollHeight;
          }

          // Ativa o input e o botão de envio quando houver ligação iniciada
          const inputEl = document.getElementById('root-console-input');
          const sendBtn = document.getElementById('root-console-send-btn');
          if (inputEl && inputEl.disabled) {
            inputEl.disabled = false;
            inputEl.placeholder = "Digite um comando shell... (ex: whoami, docker ps)";
            inputEl.focus();
          }
          if (sendBtn && sendBtn.disabled) {
            sendBtn.disabled = false;
          }
        }
      } else if (msg.type === 'site_console_log') {
        if (msg.domain === window.activeSiteConsoleDomain) {
          const consoleBox = document.getElementById('site-console-box');
          if (consoleBox) {
            if (consoleBox.innerHTML.includes('Conectando ao console')) {
              consoleBox.innerHTML = '';
            }
            const isScrolledToBottom = consoleBox.scrollHeight - consoleBox.clientHeight <= consoleBox.scrollTop + 50;
            const span = document.createElement('span');
            span.textContent = msg.data;
            consoleBox.appendChild(span);
            if (isScrolledToBottom) {
              consoleBox.scrollTop = consoleBox.scrollHeight;
            }
          }
        }
      }
    } catch (err) {
      console.error('[WS] Erro ao ler mensagens WebSocket:', err);
    }
  };

  wsConnection.onclose = () => {
    console.log('[WS] Desconectado. Tentando reconectar em 5 segundos...');
    setTimeout(connectWebSocket, 5000);
  };
}

// Atualiza a tela de Dashboard com os dados recebidos via WS
function updateDashboardUI(metrics) {
  // CPU
  animateValue('stat-cpu-val', metrics.cpu.load, 800, '%');
  animateValue('stat-cpu-text', metrics.cpu.load, 800, '%');
  setRingProgress('stat-cpu-ring', metrics.cpu.load);

  // RAM
  animateValue('stat-ram-val', metrics.ram.percent, 800, '%');
  animateValue('stat-ram-text', metrics.ram.percent, 800, '%');
  document.getElementById('stat-ram-sub').innerText = `${formatBytes(metrics.ram.used)} / ${formatBytes(metrics.ram.total)}`;
  setRingProgress('stat-ram-ring', metrics.ram.percent);

  // Disco
  animateValue('stat-disk-val', metrics.disk.percent, 800, '%');
  animateValue('stat-disk-text', metrics.disk.percent, 800, '%');
  document.getElementById('stat-disk-sub').innerText = `${formatBytes(metrics.disk.used)} / ${formatBytes(metrics.disk.total)}`;
  setRingProgress('stat-disk-ring', metrics.disk.percent);

  // Rede
  document.getElementById('stat-net-rx').innerText = `${formatBytes(metrics.network.rx)}/s`;
  document.getElementById('stat-net-tx').innerText = `${formatBytes(metrics.network.tx)}/s enviados`;

  // Uptime
  document.getElementById('header-uptime').innerText = formatUptime(metrics.uptime);

  // Informações de Sistema (Especificações da Máquina)
  if (metrics.specs) {
    const s = metrics.specs;
    document.getElementById('sys-spec-cpu').innerText = s.cpuModel || '-';
    document.getElementById('sys-spec-cores').innerText = s.cpuCores || '-';
    document.getElementById('sys-spec-ram').innerText = s.ramTotal || '-';
    document.getElementById('sys-spec-os').innerText = s.osDistro || '-';
    document.getElementById('sys-spec-kernel').innerText = s.osKernel || '-';
    document.getElementById('sys-ip').innerText = window.location.host.split(':')[0];
  }

  // Atualiza estado dos serviços do sistema
  if (metrics.services) {
    const svcs = metrics.services;
    updateServiceBadge('srv-status-nginx', svcs.nginx);
    updateServiceBadge('srv-status-mysql', svcs.mysql);
    updateServiceBadge('srv-status-php', svcs.php);
    updateServiceBadge('srv-status-docker', svcs.docker);
    updateServiceBadge('srv-status-postfix', svcs.postfix);
    updateServiceBadge('srv-status-dovecot', svcs.dovecot);
  }

  // Atualiza histórico do Chart.js
  updateChartData(metrics.cpu.load, metrics.ram.percent);
}

// Auxiliar para atualizar badges de estado do serviço
function updateServiceBadge(id, isActive) {
  const el = document.getElementById(id);
  if (!el) return;
  if (isActive) {
    el.innerText = 'ONLINE';
    el.className = 'badge badge-success';
  } else {
    el.innerText = 'INATIVO';
    el.className = 'badge badge-danger';
  }
}

// Auxiliar para preencher o progresso do anel circular SVG
function setRingProgress(elementId, percent) {
  const circle = document.getElementById(elementId);
  if (!circle) return;

  const radius = circle.r.baseVal.value;
  const circumference = radius * 2 * Math.PI;

  const offset = circumference - (percent / 100) * circumference;
  circle.style.strokeDashoffset = offset;
}

// Auxiliares de formatação
function formatUptime(uptime) {
  if (!uptime) return '0h 0m';
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  return `${h}h ${m}m`;
}

function processPlatform(uptime) {
  return window.navigator.platform.includes('Win') ? 'Windows (Simulação local)' : 'Linux (Ubuntu)';
}

// ==========================================
// MÓDULO: WEBSITES
// ==========================================
window.toggleSitePhpField = function() {
  const type = document.getElementById('site-type').value;
  const phpGroup = document.getElementById('site-php-ver-group');
  if (phpGroup) {
    if (type === 'static' || type === 'react' || type === 'python') {
      phpGroup.style.display = 'none';
    } else {
      phpGroup.style.display = 'flex';
    }
  }
};

async function loadSites() {
  const container = document.getElementById('sites-list-body');
  if (!container) return;

  try {
    const sites = await apiGet('/sites');
    if (!sites || sites.length === 0) {
      container.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Nenhum website configurado.</td></tr>`;
      return;
    }

    container.innerHTML = '';
    sites.forEach(site => {
      const sslBadge = site.ssl_enabled 
        ? `<span class="badge badge-success" style="cursor:pointer;" onclick="toggleSSL(${site.id})">HTTPS ATIVO</span>` 
        : `<span class="badge badge-danger" style="cursor:pointer;" onclick="toggleSSL(${site.id})">HTTP (INSEGURO)</span>`;

      const siteType = site.site_type || 'php';
      let typeBadge = '';
      if (siteType === 'wordpress') {
        typeBadge = `<span class="badge" style="background: rgba(161, 36, 255, 0.1); color: #a124ff; border: 1px solid rgba(161, 36, 255, 0.2);">WordPress</span>`;
      } else if (siteType === 'react') {
        typeBadge = `<span class="badge" style="background: rgba(0, 229, 255, 0.1); color: #00e5ff; border: 1px solid rgba(0, 229, 255, 0.2);">React SPA</span>`;
      } else if (siteType === 'static') {
        typeBadge = `<span class="badge badge-secondary">Estático</span>`;
      } else if (siteType === 'python') {
        typeBadge = `<span class="badge" style="background: rgba(59, 130, 246, 0.15); color: #3b82f6; border: 1px solid rgba(59, 130, 246, 0.25);">Python App</span>`;
      } else {
        typeBadge = `<span class="badge badge-success">PHP</span>`;
      }

      const phpVerText = (siteType === 'static' || siteType === 'react' || site.php_version === 'none') 
        ? '-' 
        : (siteType === 'python') 
          ? `Porta ${site.app_port || 5000}` 
          : `PHP ${site.php_version}`;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${site.domain}</strong></td>
        <td style="font-family: var(--font-mono); font-size: 12px;">${site.root_path}</td>
        <td>${typeBadge}</td>
        <td>${phpVerText}</td>
        <td>${sslBadge}</td>
        <td style="text-align: right;">
          <button class="btn-secondary" style="display:inline-flex; padding:6px 12px; font-size:12px; margin-right:6px;" onclick="openSiteConsole('${site.domain}')">
            Consola
          </button>
          <button class="btn-secondary" style="display:inline-flex; padding:6px 12px; font-size:12px; margin-right:6px;" onclick="openNginxConfigModal('${site.domain}')">
            Configurar Nginx
          </button>
          <button class="btn-secondary" style="display:inline-flex; padding:6px 12px; font-size:12px; margin-right:6px;" onclick="goToDirectory('${site.root_path}', '${site.domain}')">
            Ficheiros
          </button>
          <button class="btn-danger-outline" onclick="deleteSite(${site.id}, '${site.domain}')">
            Eliminar
          </button>
        </td>
      `;
      container.appendChild(tr);
    });
  } catch (err) {}
}

async function deleteSite(id, domain) {
  if (!confirm(`Tem a certeza que deseja eliminar o website "${domain}"? Isso removerá as configurações do Nginx e todos os ficheiros associados.`)) return;
  
  try {
    const data = await apiPost('/sites/delete', { id });
    if (data) {
      showToast(data.message, 'success');
      loadSites();
    }
  } catch (err) {}
}

async function toggleSSL(id) {
  try {
    showToast('A processar certificado SSL... Por favor aguarde.', 'info');
    const data = await apiPost('/sites/ssl', { id });
    if (data) {
      showToast(data.message, 'success');
      loadSites();
    }
  } catch (err) {}
}

window.goToDirectory = function(rootPath, domain) {
  window.activeFmContext = {
    type: 'site',
    path: rootPath,
    name: domain || 'Site'
  };
  const titleEl = document.getElementById('fm-modal-title');
  if (titleEl) titleEl.innerText = `Gestor de Arquivos - Site: ${domain || 'Site'}`;
  loadDirectory(rootPath);
  openModal('modal-files');
};

// ==========================================
// MÓDULO: BASES DE DADOS
// ==========================================
async function loadDatabases() {
  const container = document.getElementById('db-list-body');
  if (!container) return;

  try {
    const databases = await apiGet('/databases');
    if (!databases || databases.length === 0) {
      container.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Nenhuma base de dados configurada.</td></tr>`;
      return;
    }

    container.innerHTML = '';
    databases.forEach(db => {
      const date = new Date(db.created_at).toLocaleDateString('pt-PT');
      
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${db.db_name}</strong></td>
        <td>${db.db_user}</td>
        <td>${date}</td>
        <td style="text-align: right;">
          <button class="btn-secondary" style="display:inline-flex; padding:6px 12px; font-size:12px; margin-right:6px;" onclick="openChangeDbPassModal(${db.id})">
            Alterar Palavra-passe
          </button>
          <button class="btn-primary" style="display:inline-flex; padding:6px 12px; font-size:12px; margin-right:6px;" onclick="accessDbSSO(${db.id})">
            Aceder ao phpMyAdmin
          </button>
          <button class="btn-danger-outline" onclick="deleteDatabase(${db.id}, '${db.db_name}')">
            Eliminar
          </button>
        </td>
      `;
      container.appendChild(tr);
    });
  } catch (err) {}
}

window.openChangeDbPassModal = function(id) {
  document.getElementById('change-db-pass-id').value = id;
  document.getElementById('change-db-new-pass').value = '';
  openModal('modal-change-db-pass');
};

async function deleteDatabase(id, dbName) {
  if (!confirm(`Tem a certeza que deseja eliminar a base de dados "${dbName}"? Todos os dados serão permanentemente eliminados.`)) return;

  try {
    const data = await apiPost('/databases/delete', { id });
    if (data) {
      showToast(data.message, 'success');
      loadDatabases();
    }
  } catch (err) {}
}

async function accessDbSSO(id) {
  try {
    showToast('A gerar sessão segura no phpMyAdmin...', 'info');
    const data = await apiPost('/databases/sso', { id });
    if (data && data.token) {
      const ssoUrl = `${window.location.protocol}//${window.location.host}${window.pmaPath || '/phpmyadmin'}/signon.php?token=${data.token}`;
      window.open(ssoUrl, '_blank');
    }
  } catch (err) {}
}

// ==========================================
// MÓDULO: E-MAILS
// ==========================================
async function loadEmails() {
  const container = document.getElementById('email-list-body');
  if (!container) return;

  try {
    const emails = await apiGet('/emails');
    if (!emails || emails.length === 0) {
      container.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Nenhuma conta de e-mail criada.</td></tr>`;
      return;
    }

    container.innerHTML = '';
    emails.forEach(email => {
      const date = new Date(email.created_at).toLocaleDateString('pt-PT');
      
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${email.email_address}</strong></td>
        <td>${email.quota_mb} MB</td>
        <td>${date}</td>
        <td style="text-align: right;">
          <button class="btn-secondary" style="display:inline-flex; padding:6px 12px; font-size:12px; margin-right:6px;" onclick="openChangeMailPassModal(${email.id})">
            Palavra-passe
          </button>
          <button class="btn-secondary" style="display:inline-flex; padding:6px 12px; font-size:12px; margin-right:6px;" onclick="openChangeMailQuotaModal(${email.id}, ${email.quota_mb})">
            Cota
          </button>
          <button class="btn-secondary" style="display:inline-flex; padding:6px 12px; font-size:12px; margin-right:6px;" onclick="viewDnsRecords('${email.domain}')">
            Registos DNS
          </button>
          <button class="btn-danger-outline" onclick="deleteEmail(${email.id}, '${email.email_address}')">
            Eliminar
          </button>
        </td>
      `;
      container.appendChild(tr);
    });
  } catch (err) {}
}

window.openChangeMailPassModal = function(id) {
  document.getElementById('change-email-pass-id').value = id;
  document.getElementById('change-email-new-pass').value = '';
  openModal('modal-change-email-pass');
};

window.openChangeMailQuotaModal = function(id, currentQuota) {
  document.getElementById('change-email-quota-id').value = id;
  document.getElementById('change-email-new-quota').value = currentQuota;
  openModal('modal-change-email-quota');
};

async function deleteEmail(id, emailAddress) {
  if (!confirm(`Tem a certeza que deseja eliminar a conta de e-mail "${emailAddress}"? Esta caixa de correio e todos os seus ficheiros de e-mail serão eliminados.`)) return;

  try {
    const data = await apiPost('/emails/delete', { id });
    if (data) {
      showToast(data.message, 'success');
      loadEmails();
    }
  } catch (err) {}
}

async function viewDnsRecords(domain) {
  try {
    const data = await apiGet(`/emails/dns?domain=${encodeURIComponent(domain)}`);
    if (!data) return;

    document.getElementById('dns-modal-title').innerText = `Registros DNS para ${domain}`;
    const tbody = document.getElementById('dns-records-table-body');
    tbody.innerHTML = '';

    data.records.forEach(rec => {
      const tr = document.createElement('tr');
      const valShort = rec.value.length > 30 ? rec.value.substring(0, 30) + '...' : rec.value;
      tr.innerHTML = `
        <td><strong style="color: var(--color-secondary);">${rec.type}</strong></td>
        <td style="font-family: var(--font-mono); font-size: 11px;">${rec.name}</td>
        <td style="font-family: var(--font-mono); font-size: 11px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="word-break: break-all; max-width: 280px;" title="${rec.value}">${valShort}</span>
            <button class="btn-copy" onclick="copyToClipboard('${rec.value.replace(/'/g, "\\'")}')" title="Copiar Valor">⎘</button>
          </div>
        </td>
        <td style="color: var(--text-secondary);">${rec.description}</td>
      `;
      tbody.appendChild(tr);
    });

    openModal('modal-dns-records');
  } catch (err) {}
}

// ==========================================
// MÓDULO: TAREFAS AGENDADAS (CRON JOBS)
// ==========================================
async function loadCrons() {
  const container = document.getElementById('cron-list-body');
  if (!container) return;

  try {
    const crons = await apiGet('/crons');
    if (!crons || crons.length === 0) {
      container.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Nenhuma tarefa agendada.</td></tr>`;
      return;
    }

    container.innerHTML = '';
    crons.forEach(cron => {
      const activeBadge = cron.enabled 
        ? `<span class="badge badge-success" style="cursor:pointer;" onclick="toggleCron(${cron.id}, false)">ATIVADO</span>` 
        : `<span class="badge badge-danger" style="cursor:pointer;" onclick="toggleCron(${cron.id}, true)">DESATIVADO</span>`;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family: var(--font-mono); font-weight: 600;">${cron.schedule}</td>
        <td style="font-family: var(--font-mono); font-size: 12px; color: var(--color-secondary);">${cron.command}</td>
        <td>${activeBadge}</td>
        <td style="text-align: right;">
          <button class="btn-secondary" style="display:inline-flex; padding:6px 12px; font-size:12px; margin-right:6px;" onclick="runCron(${cron.id})">
            Executar
          </button>
          <button class="btn-danger-outline" onclick="deleteCron(${cron.id})">
            Eliminar
          </button>
        </td>
      `;
      container.appendChild(tr);
    });
  } catch (err) {}
}

window.applyCronPreset = function(preset) {
  if (preset) {
    document.getElementById('cron-schedule').value = preset;
  }
};

window.runCron = async function(id) {
  try {
    showToast('A executar a tarefa agendada imediatamente...', 'info');
    const data = await apiPost('/crons/run', { id });
    if (data) {
      let output = `[STDOUT]\n${data.stdout || '(Sem saída)'}\n\n[STDERR]\n${data.stderr || '(Sem erros)'}`;
      if (data.error) {
        output += `\n\n[ERRO SISTEMA]\n${data.error}`;
      }
      document.getElementById('cron-run-output-box').innerText = output;
      openModal('modal-cron-run-output');
    }
  } catch (err) {
    showToast('Erro ao executar o cron.', 'error');
  }
};

async function toggleCron(id, enabled) {
  try {
    const data = await apiPost('/crons/toggle', { id, enabled });
    if (data) {
      showToast(data.message, 'success');
      loadCrons();
    }
  } catch (err) {}
}

async function deleteCron(id) {
  if (!confirm('Tem a certeza que deseja eliminar esta tarefa agendada?')) return;
  try {
    const data = await apiPost('/crons/delete', { id });
    if (data) {
      showToast(data.message, 'success');
      loadCrons();
    }
  } catch (err) {}
}

// ==========================================
// MÓDULO: SEGURANÇA E FIREWALL (UFW)
// ==========================================
async function loadSecurity() {
  try {
    // 1. Carrega status do Fail2ban
    const data = await apiGet('/monitor/security');
    if (data) {
      const f2bBox = document.getElementById('fail2ban-status-box');
      if (f2bBox) f2bBox.innerText = data.fail2ban;
    }

    // 2. Carrega as regras numeradas do firewall
    const fwData = await apiGet('/monitor/firewall/rules');
    const container = document.getElementById('fw-rules-list-body');
    if (container) {
      if (!fwData || !fwData.rules || fwData.rules.length === 0) {
        container.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Nenhuma regra ativa no firewall.</td></tr>`;
        return;
      }

      container.innerHTML = '';
      fwData.rules.forEach(rule => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${rule.port}</strong></td>
          <td><span class="badge ${rule.action.includes('ALLOW') ? 'badge-success' : 'badge-danger'}">${rule.action}</span></td>
          <td>${rule.from}</td>
          <td style="text-align: right;">
            <button class="btn-danger-outline" onclick="deleteFirewallRule('${rule.port}')">
              Eliminar
            </button>
          </td>
        `;
        container.appendChild(tr);
      });
    }
  } catch (err) {
    console.error('Erro ao carregar segurança:', err);
  }
}

window.deleteFirewallRule = async function(rulePort) {
  if (!confirm(`Tem a certeza que deseja remover a regra de firewall para a porta "${rulePort}"?`)) return;

  let port = rulePort;
  let protocol = 'tcp';
  if (rulePort.includes('/')) {
    const parts = rulePort.split('/');
    port = parts[0];
    protocol = parts[1];
  }

  try {
    showToast('A remover a regra de firewall...', 'info');
    const data = await apiPost('/monitor/firewall/delete', { port, protocol });
    if (data) {
      showToast(data.message, 'success');
      loadSecurity();
    }
  } catch (err) {
    showToast('Erro ao remover regra.', 'error');
  }
};

async function addFirewallPort() {
  const port = document.getElementById('fw-port').value;
  const proto = document.getElementById('fw-proto').value;

  if (!port) {
    showToast('Insira uma porta válida.', 'error');
    return;
  }

  try {
    const data = await apiPost('/monitor/firewall', {
      port,
      protocol: proto,
      action: 'allow'
    });
    if (data) {
      showToast(data.message, 'success');
      document.getElementById('fw-port').value = '';
      loadSecurity();
    }
  } catch (err) {}
}

// ==========================================
// MÓDULO: LOGS DO SISTEMA
// ==========================================
async function loadSystemLogs() {
  const type = document.getElementById('log-selector').value;
  const terminal = document.getElementById('logs-terminal-box');

  try {
    terminal.innerHTML = '<div class="terminal-line">Lendo registros do log...</div>';
    const data = await apiGet(`/monitor/logs?type=${type}`);
    if (data) {
      terminal.innerHTML = '';
      
      const lines = data.content.split('\n');
      lines.forEach(line => {
        if (!line.trim()) return;
        const div = document.createElement('div');
        div.className = 'terminal-line';
        div.innerText = line;
        terminal.appendChild(div);
      });

      // Rola para o fim
      terminal.scrollTop = terminal.scrollHeight;
    }
  } catch (err) {
    terminal.innerHTML = '<div class="terminal-line" style="color: var(--color-danger);">Erro ao carregar o log.</div>';
  }
}

// ==========================================
// FORMULÁRIOS DE CRIAÇÃO (SUBMIT HANDLERS)
// ==========================================
function setupForms() {
  // Criar Site
  document.getElementById('create-site-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const domain = document.getElementById('site-domain').value.trim();
    const siteType = document.getElementById('site-type').value;
    const phpVersion = (siteType === 'static' || siteType === 'react') ? 'none' : document.getElementById('site-php-ver').value;

    try {
      showToast('A criar o website e a configurar o Nginx...', 'info');
      const data = await apiPost('/sites/create', { domain, phpVersion, siteType });
      if (data) {
        showToast(data.message, 'success');
        closeModal('modal-create-site');
        document.getElementById('create-site-form').reset();
        window.toggleSitePhpField(); // reseta a visibilidade
        loadSites();
      }
    } catch (err) {}
  });

  // Criar Banco de Dados
  document.getElementById('create-db-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dbName = document.getElementById('db-name').value;
    const dbUser = document.getElementById('db-user').value;
    const dbPass = document.getElementById('db-pass').value;

    try {
      const data = await apiPost('/databases/create', { dbName, dbUser, dbPass });
      if (data) {
        showToast(data.message, 'success');
        closeModal('modal-create-db');
        document.getElementById('create-db-form').reset();
        loadDatabases();
      }
    } catch (err) {}
  });

  // Alterar Palavra-passe da Base de Dados
  document.getElementById('change-db-pass-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('change-db-pass-id').value;
    const newPass = document.getElementById('change-db-new-pass').value;

    try {
      showToast('A alterar a palavra-passe da base de dados...', 'info');
      const data = await apiPost('/databases/change-password', { id, newPass });
      if (data) {
        showToast(data.message, 'success');
        closeModal('modal-change-db-pass');
        document.getElementById('change-db-pass-form').reset();
      }
    } catch (err) {}
  });

  // Criar E-mail
  document.getElementById('create-email-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailAddress = document.getElementById('email-addr').value;
    const password = document.getElementById('email-pass').value;
    const quotaMb = document.getElementById('email-quota').value;

    try {
      const data = await apiPost('/emails/create', { emailAddress, password, quotaMb });
      if (data) {
        showToast(data.message, 'success');
        closeModal('modal-create-email');
        document.getElementById('create-email-form').reset();
        loadEmails();
      }
    } catch (err) {}
  });

  // Alterar Palavra-passe da Conta de E-mail
  document.getElementById('change-email-pass-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('change-email-pass-id').value;
    const newPass = document.getElementById('change-email-new-pass').value;

    try {
      showToast('A alterar a palavra-passe da conta de e-mail...', 'info');
      const data = await apiPost('/emails/change-password', { id, newPass });
      if (data) {
        showToast(data.message, 'success');
        closeModal('modal-change-email-pass');
        document.getElementById('change-email-pass-form').reset();
      }
    } catch (err) {}
  });

  // Alterar Cota Email
  document.getElementById('change-email-quota-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('change-email-quota-id').value;
    const quotaMb = document.getElementById('change-email-new-quota').value;

    try {
      showToast('A alterar a cota da conta de e-mail...', 'info');
      const data = await apiPost('/emails/change-quota', { id, quotaMb });
      if (data) {
        showToast(data.message, 'success');
        closeModal('modal-change-email-quota');
        document.getElementById('change-email-quota-form').reset();
        loadEmails();
      }
    } catch (err) {}
  });

  // Criar Cron Job
  document.getElementById('create-cron-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const schedule = document.getElementById('cron-schedule').value;
    const command = document.getElementById('cron-command').value;
    const description = document.getElementById('cron-desc').value;

    try {
      const data = await apiPost('/crons/create', { schedule, command, description });
      if (data) {
        showToast(data.message, 'success');
        document.getElementById('create-cron-form').reset();
        loadCrons();
      }
    } catch (err) {}
  });

  // Criar Utilizador
  document.getElementById('create-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('new-user-username').value.trim();
    const password = document.getElementById('new-user-pass').value;
    const role = document.getElementById('new-user-role').value;

    try {
      const data = await apiPost('/users/create', { username, password, role });
      if (data) {
        showToast(data.message, 'success');
        closeModal('modal-create-user');
        document.getElementById('create-user-form').reset();
        loadUsers();
      }
    } catch (err) {}
  });

  // Redefinir Palavra-passe de Utilizador (Admin)
  document.getElementById('reset-user-pass-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('reset-user-pass-id').value;
    const newPassword = document.getElementById('reset-user-new-pass').value;

    try {
      showToast('A atualizar a palavra-passe do utilizador...', 'info');
      const data = await apiPost('/users/reset-password', { id, newPassword });
      if (data) {
        showToast(data.message, 'success');
        closeModal('modal-reset-user-pass');
        document.getElementById('reset-user-pass-form').reset();
      }
    } catch (err) {}
  });

  // Ativar 2FA (Confirmar código de teste)
  document.getElementById('setup-2fa-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = document.getElementById('2fa-verify-code').value.trim();

    try {
      const data = await apiPost('/auth/2fa/enable', { code });
      if (data) {
        showToast(data.message, 'success');
        closeModal('modal-setup-2fa');
        load2FAStatus();
        if (localStorage.getItem('bcp_role') === 'admin') loadUsers(); // Atualiza tabela se for admin
      }
    } catch (err) {}
  });
}

// ==========================================
// MÓDULO: UTILIZADORES E 2FA
// ==========================================

async function loadUsers() {
  const container = document.getElementById('users-list-body');
  if (!container) return;

  try {
    const users = await apiGet('/users');
    if (!users || users.length === 0) {
      container.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Nenhum utilizador configurado.</td></tr>`;
      return;
    }

    container.innerHTML = '';
    users.forEach(user => {
      const is2faActive = user.two_factor_enabled === 1;
      const badge2fa = is2faActive 
        ? `<span class="badge badge-success">ATIVADO</span>` 
        : `<span class="badge badge-danger">DESATIVADO</span>`;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${user.username}</strong></td>
        <td><span class="badge badge-warning" style="border-color: rgba(0, 255, 65, 0.2);">${user.role.toUpperCase()}</span></td>
        <td>${badge2fa}</td>
        <td style="text-align: right;">
          <button class="btn-secondary" style="display:inline-flex; padding:6px 12px; font-size:12px; margin-right:6px;" onclick="openResetUserPassModal(${user.id}, '${user.username}')">
            Palavra-passe
          </button>
          <button class="btn-danger-outline" onclick="deleteUser(${user.id}, '${user.username}')" ${user.username === 'root' ? 'disabled' : ''}>
            Eliminar
          </button>
        </td>
      `;
      container.appendChild(tr);
    });
  } catch (err) {}
}

window.openResetUserPassModal = function(id, username) {
  document.getElementById('reset-user-pass-id').value = id;
  document.getElementById('reset-user-new-pass').value = '';
  openModal('modal-reset-user-pass');
};

window.deleteUser = async function(id, username) {
  if (username === 'root') {
    showToast('Não é possível eliminar o utilizador root do painel.', 'error');
    return;
  }
  if (!confirm(`Tem a certeza que deseja eliminar o utilizador "${username}"?`)) return;

  try {
    const data = await apiPost('/users/delete', { id });
    if (data) {
      showToast(data.message, 'success');
      loadUsers();
    }
  } catch (err) {}
};

async function load2FAStatus() {
  const container = document.getElementById('2fa-status-container');
  if (!container) return;

  try {
    const data = await apiGet('/auth/2fa/status');
    if (data) {
      if (data.enabled) {
        container.innerHTML = `
          <span class="badge badge-success" style="padding: 6px 12px; font-size: 12px; box-shadow: 0 0 10px rgba(0,255,65,0.2); margin-bottom:14px;">🔒 GOOGLE 2FA ATIVADO</span>
          <button class="btn-danger-outline" style="width: 100%; height: 38px; font-size: 13px;" onclick="disableTwoFactor()">Desativar Google 2FA</button>
        `;
      } else {
        container.innerHTML = `
          <span class="badge badge-danger" style="padding: 6px 12px; font-size: 12px; margin-bottom:14px;">🔓 GOOGLE 2FA DESATIVADO</span>
          <button class="btn-primary" style="width: 100%; height: 38px; font-size: 13px; justify-content: center;" onclick="setupTwoFactor()">Configurar Google 2FA</button>
        `;
      }
    }
  } catch (err) {}
}

window.setupTwoFactor = async function() {
  try {
    showToast('Gerando chave secreta 2FA...', 'info');
    const data = await apiPost('/auth/2fa/setup');
    if (data) {
      document.getElementById('2fa-secret-text').innerText = formatSecretKey(data.secret);
      
      const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(data.qrUrl)}`;
      document.getElementById('2fa-qr-code-img').src = qrCodeUrl;

      document.getElementById('2fa-verify-code').value = '';
      openModal('modal-setup-2fa');
    }
  } catch (err) {}
};

window.disableTwoFactor = async function() {
  if (!confirm('Deseja realmente desativar a autenticação de dois fatores? Isso tornará a sua conta menos segura.')) return;

  try {
    const data = await apiPost('/auth/2fa/disable');
    if (data) {
      showToast(data.message, 'success');
      load2FAStatus();
      if (localStorage.getItem('bcp_role') === 'admin') loadUsers(); // Atualiza tabela se for admin
    }
  } catch (err) {}
};

function formatSecretKey(secret) {
  return secret.match(/.{1,4}/g).join(' ');
}

// ==========================================
// MÓDULO DE SERVIDORES DE JOGOS (PTERODACTYL STYLE)
// ==========================================
window.selectedGameServerId = null;
window.selectedGameServerName = '';
window.selectedGameServerPort = '';
window.selectedGameServerDockerId = '';

let gameStatsInterval = null;

window.switchContextTab = function(tabId) {
  window.history.pushState(null, '', '/' + tabId);
  handleRouting();
};

function updateConsoleTabState() {
  // Root Console is always active
}

window.loadGameDashboard = async function() {
  const logsContainer = document.getElementById('game-dashboard-logs');
  try {
    const games = await apiGet('/games');
    const totalCount = games.length;
    const runningCount = games.filter(g => g.status === 'running').length;
    
    let totalRam = 0;
    games.forEach(g => {
      totalRam += g.ram_limit_mb || 0;
    });

    document.getElementById('game-stat-servers-count').innerText = `${runningCount} / ${totalCount}`;
    document.getElementById('game-stat-ram-allocated').innerText = `${totalRam} MB`;

    // Metadados do Docker
    const isLinuxOS = !navigator.platform.includes('Win');
    document.getElementById('game-stat-docker-status').innerText = 'Ativo';
    document.getElementById('game-stat-docker-engine').innerText = isLinuxOS ? 'v24.0.7 (Ubuntu)' : 'v24.0.7 (Mock CLI)';

    if (logsContainer) {
      logsContainer.innerHTML = '';
      if (games.length === 0) {
        logsContainer.innerHTML = `<div class="system-detail-item"><span>Nenhum evento registrado. Crie um servidor para iniciar.</span></div>`;
      } else {
        games.slice(0, 5).forEach(srv => {
          const div = document.createElement('div');
          div.className = 'system-detail-item';
          div.innerHTML = `
            <span>Servidor #${srv.id} (${srv.name}) está no estado: ${srv.status.toUpperCase()}</span>
            <strong style="color: ${srv.status === 'running' ? 'var(--color-primary)' : 'var(--text-secondary)'};">${srv.status.toUpperCase()}</strong>
          `;
          logsContainer.appendChild(div);
        });
      }
    }
  } catch (err) {
    console.error('Erro ao carregar dashboard de jogos:', err);
  }
};

window.loadGameServers = async function() {
  const container = document.getElementById('game-servers-list-body');
  if (!container) return;

  try {
    const games = await apiGet('/games');
    if (!games || games.length === 0) {
      container.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Nenhum servidor de jogo cadastrado.</td></tr>`;
      return;
    }

    container.innerHTML = '';
    games.forEach(srv => {
      let statusBadge = '';
      if (srv.status === 'running') {
        statusBadge = `<span class="badge badge-success">ONLINE</span>`;
      } else if (srv.status === 'stopped') {
        statusBadge = `<span class="badge badge-secondary" style="opacity: 0.7;">DESLIGADO</span>`;
      } else if (srv.status === 'installing') {
        statusBadge = `<span class="badge badge-warning" style="animation: pulse 1.5s infinite;">INSTALANDO</span>`;
      } else {
        statusBadge = `<span class="badge badge-danger">ERRO</span>`;
      }

      const nodeBadge = srv.node_name 
        ? `<span class="badge badge-warning" style="font-size:10px; padding:2px 6px; margin-left:6px; opacity:0.8;">WINGS: ${srv.node_name}</span>`
        : `<span class="badge badge-success" style="font-size:10px; padding:2px 6px; margin-left:6px; opacity:0.8;">LOCAL</span>`;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <strong>${srv.name}</strong>
          <div style="margin-top: 4px;">${nodeBadge}</div>
        </td>
        <td><span style="font-family: var(--font-mono); font-size:12px; color: var(--color-secondary);">${srv.game_type.toUpperCase()}</span></td>
        <td><strong style="font-family: var(--font-mono);">${srv.host_port}</strong></td>
        <td>RAM: ${srv.ram_limit_mb}MB / CPU: ${srv.cpu_limit}x</td>
        <td>CPU: ${srv.cpu_usage || '0%'} / RAM: ${srv.ram_usage || '0MB'}</td>
        <td>${statusBadge}</td>
        <td style="text-align: right;">
          <button class="btn-secondary" style="display:inline-flex; padding:6px 12px; font-size:12px; margin-right:6px;" onclick="openGameConsole(${srv.id}, '${srv.name}', ${srv.host_port}, '${srv.status}', '${srv.container_id}', ${srv.ram_limit_mb})">
            Consola
          </button>
          <button class="btn-secondary" style="display:inline-flex; padding:6px 12px; font-size:12px; margin-right:6px;" onclick="openGameFiles(${srv.id}, '${srv.name}')">
            Ficheiros
          </button>
          <button class="btn-icon-sm" style="margin-right:6px;" onclick="controlGameServer(${srv.id}, 'start')" title="Iniciar" ${srv.status === 'running' || srv.status === 'installing' ? 'disabled' : ''}>
            ▶
          </button>
          <button class="btn-icon-sm" style="margin-right:6px; background: rgba(255, 51, 51, 0.15); border-color: rgba(255, 51, 51, 0.3); color: var(--color-danger);" onclick="controlGameServer(${srv.id}, 'stop')" title="Parar" ${srv.status !== 'running' ? 'disabled' : ''}>
            ■
          </button>
          <button class="btn-danger-outline" onclick="deleteGameServer(${srv.id}, '${srv.name}')">
            Eliminar
          </button>
        </td>
      `;
      container.appendChild(tr);
    });
  } catch (err) {
    console.error('Erro ao listar servidores de jogo:', err);
  }
};

window.controlGameServer = async function(id, action) {
  try {
    showToast(`A enviar a ação "${action}" para o servidor...`, 'info');
    const res = await apiPost('/games/action', { id, action });
    if (res) {
      showToast(res.message, 'success');
      loadGameServers();
      if (window.selectedGameServerId === id) {
        loadGameConsole(id, window.selectedGameServerName);
      }
    }
  } catch (err) {}
};

window.deleteGameServer = async function(id, name) {
  if (!confirm(`Tem a certeza que deseja eliminar permanentemente o servidor de jogo "${name}"? Todos os ficheiros e dados associados serão eliminados.`)) return;

  try {
    showToast('A eliminar o servidor de jogo...', 'info');
    const res = await apiPost('/games/delete', { id });
    if (res) {
      showToast(res.message, 'success');
      if (window.selectedGameServerId === id) {
        window.selectedGameServerId = null;
        window.selectedGameServerName = '';
        updateConsoleTabState();
      }
      loadGameServers();
    }
  } catch (err) {}
};

window.openGameConsole = function(id, name, hostPort, status, containerId, ramLimit) {
  window.selectedGameServerId = id;
  window.selectedGameServerName = name;
  window.selectedGameServerPort = hostPort;
  window.selectedGameServerDockerId = containerId;
  window.selectedGameServerRamLimit = ramLimit || 1024;

  openModal('modal-game-console');
  loadGameConsole(id, name);
};

window.loadGameConsole = async function(id, name) {
  document.getElementById('game-console-servername').innerText = name;
  
  const consoleBox = document.getElementById('game-console-box');
  if (consoleBox) {
    consoleBox.innerHTML = `<div style="color: #666;">Conectando ao console do servidor #${id}...</div>`;
  }

  const inputEl = document.getElementById('game-console-input');
  const btnEl = document.getElementById('game-console-send-btn');
  if (inputEl) {
    inputEl.disabled = false;
    inputEl.focus();
  }
  if (btnEl) btnEl.disabled = false;

  // Atualiza botões rápidos de controle no topo do console
  const actionsContainer = document.getElementById('game-console-status-actions');
  if (actionsContainer) {
    actionsContainer.innerHTML = `
      <button class="btn-secondary" style="padding:6px 12px; font-size:12px;" onclick="controlGameServer(${id}, 'start')">▶ Ligar</button>
      <button class="btn-secondary" style="padding:6px 12px; font-size:12px; background:rgba(255,51,51,0.15); color:var(--color-danger); border-color:rgba(255,51,51,0.3);" onclick="controlGameServer(${id}, 'stop')">■ Desligar</button>
      <button class="btn-secondary" style="padding:6px 12px; font-size:12px;" onclick="controlGameServer(${id}, 'restart')">↻ Reiniciar</button>
    `;
  }

  // Fecha qualquer conexão remota anterior
  if (remoteConsoleWs) {
    try {
      remoteConsoleWs.close();
    } catch (e) {}
    remoteConsoleWs = null;
  }

  try {
    const config = await apiGet(`/games/${id}/console`);
    if (config && config.is_remote) {
      console.log('[WS-REMOTE] Conectando diretamente ao daemon Wings:', config.ip_address, config.api_port);
      
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const remoteWsUrl = `${protocol}//${config.ip_address}:${config.api_port}/?token=${config.token}&gameServerId=${id}`;
      
      remoteConsoleWs = new WebSocket(remoteWsUrl);
      
      remoteConsoleWs.onopen = () => {
        console.log('[WS-REMOTE] Conectado com sucesso ao nó remoto.');
        if (consoleBox) {
          consoleBox.innerHTML = `<div style="color: var(--color-primary);">[Conectado ao nó Wings ${config.ip_address}] Carregando logs...\n</div>`;
        }
      };
      
      remoteConsoleWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'console_log') {
            if (consoleBox) {
              if (consoleBox.innerHTML.includes('Conectando ao console') || consoleBox.innerHTML.includes('Carregando logs')) {
                consoleBox.innerHTML = '';
              }
              const isScrolledToBottom = consoleBox.scrollHeight - consoleBox.clientHeight <= consoleBox.scrollTop + 50;
              const span = document.createElement('span');
              span.textContent = msg.data;
              consoleBox.appendChild(span);
              if (isScrolledToBottom) {
                consoleBox.scrollTop = consoleBox.scrollHeight;
              }
            }
          } else if (msg.type === 'metrics') {
            document.getElementById('game-console-cpu-val').innerText = msg.cpu || '0%';
            document.getElementById('game-console-cpu-bar').style.width = msg.cpu || '0%';
            
            document.getElementById('game-console-ram-val').innerText = msg.ram || '0 MB';
            const used = parseFloat(msg.ram) || 0;
            const limit = window.selectedGameServerRamLimit || 1024;
            const pct = Math.min(100, (used / limit) * 100);
            document.getElementById('game-console-ram-bar').style.width = `${pct}%`;
          }
        } catch (e) {
          console.error('[WS-REMOTE] Erro ao processar mensagem do daemon:', e);
        }
      };
      
      remoteConsoleWs.onclose = () => {
        console.log('[WS-REMOTE] Conexão encerrada com o nó remoto.');
      };
      
      remoteConsoleWs.onerror = (err) => {
        console.error('[WS-REMOTE] Erro na conexão:', err);
        if (consoleBox) {
          consoleBox.innerHTML += `<div style="color: var(--color-danger);">[ERRO] Falha ao conectar ao daemon Wings do host ${config.ip_address}.\n</div>`;
        }
      };
      
      // Limpa estatísticas iniciais
      document.getElementById('game-console-cpu-val').innerText = '0%';
      document.getElementById('game-console-cpu-bar').style.width = '0%';
      document.getElementById('game-console-ram-val').innerText = '0 MB';
      document.getElementById('game-console-ram-bar').style.width = '0%';
      document.getElementById('game-console-port-val').innerText = window.selectedGameServerPort || '-';
      document.getElementById('game-console-dockerid-val').innerText = (window.selectedGameServerDockerId || '').substring(0, 12) || '-';

    } else {
      // Servidor local: usa a conexão WebSocket do painel padrão
      if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        wsConnection.send(JSON.stringify({
          type: 'join_console',
          gameServerId: id
        }));
      }
      
      // Inicializa estatísticas locais via polling
      startGameStatsPolling(id);
    }
  } catch (err) {
    console.error('Erro ao buscar configuração do console:', err);
    if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
      wsConnection.send(JSON.stringify({
        type: 'join_console',
        gameServerId: id
      }));
    }
    startGameStatsPolling(id);
  }
};

window.sendConsoleCommand = function() {
  const inputEl = document.getElementById('game-console-input');
  if (!inputEl || !inputEl.value.trim() || !window.selectedGameServerId) return;

  const cmd = inputEl.value.trim();
  inputEl.value = '';

  if (remoteConsoleWs && remoteConsoleWs.readyState === WebSocket.OPEN) {
    remoteConsoleWs.send(JSON.stringify({
      type: 'command',
      command: cmd
    }));
    return;
  }

  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify({
      type: 'console_command',
      gameServerId: window.selectedGameServerId,
      command: cmd
    }));
  }
};

window.handleConsoleInput = function(e) {
  if (e.key === 'Enter') {
    sendConsoleCommand();
  }
};

window.openGameFiles = function(id, name) {
  window.selectedGameServerId = id;
  window.selectedGameServerName = name;
  updateConsoleTabState();

  window.activeFmContext = {
    type: 'game',
    id: id,
    name: name
  };
  const titleEl = document.getElementById('fm-modal-title');
  if (titleEl) titleEl.innerText = `Gestor de Arquivos - Servidor: ${name}`;

  goToGameFiles();
};

window.goToGameFiles = function() {
  if (window.selectedGameServerId && !window.activeFmContext) {
    window.activeFmContext = {
      type: 'game',
      id: window.selectedGameServerId,
      name: window.selectedGameServerName
    };
    const titleEl = document.getElementById('fm-modal-title');
    if (titleEl) titleEl.innerText = `Gestor de Arquivos - Servidor: ${window.selectedGameServerName}`;
  }
  loadDirectory('');
  openModal('modal-files');
};

function startGameStatsPolling(id) {
  if (gameStatsInterval) clearInterval(gameStatsInterval);
  
  // Limpa campos na UI inicialmente
  document.getElementById('game-console-cpu-val').innerText = '0%';
  document.getElementById('game-console-cpu-bar').style.width = '0%';
  document.getElementById('game-console-ram-val').innerText = '0 MB';
  document.getElementById('game-console-ram-bar').style.width = '0%';
  document.getElementById('game-console-port-val').innerText = window.selectedGameServerPort || '-';
  document.getElementById('game-console-dockerid-val').innerText = (window.selectedGameServerDockerId || '').substring(0, 12) || '-';

  gameStatsInterval = setInterval(async () => {
    const modalActive = document.getElementById('modal-game-console').classList.contains('active');
    if (!modalActive || window.selectedGameServerId !== id) {
      clearInterval(gameStatsInterval);
      return;
    }
    try {
      const games = await apiGet('/games');
      const srv = games.find(g => g.id === id);
      if (srv) {
        if (srv.status === 'running') {
          document.getElementById('game-console-cpu-val').innerText = srv.cpu_usage || '0%';
          document.getElementById('game-console-cpu-bar').style.width = srv.cpu_usage || '0%';
          
          document.getElementById('game-console-ram-val').innerText = srv.ram_usage || '0 MB';
          
          const used = parseFloat(srv.ram_usage) || 0;
          const limit = srv.ram_limit_mb || 1024;
          const pct = Math.min(100, (used / limit) * 100);
          document.getElementById('game-console-ram-bar').style.width = `${pct}%`;
        } else {
          document.getElementById('game-console-cpu-val').innerText = '0%';
          document.getElementById('game-console-cpu-bar').style.width = '0%';
          document.getElementById('game-console-ram-val').innerText = '0 MB';
          document.getElementById('game-console-ram-bar').style.width = '0%';
        }
        document.getElementById('game-console-port-val').innerText = srv.host_port || '-';
        document.getElementById('game-console-dockerid-val').innerText = (srv.container_id || '').substring(0, 12) || '-';
      }
    } catch (e) {
      console.error('Erro ao buscar stats do jogo:', e);
    }
  }, 2000);
}

window.setupGamesForms = function() {
  const form = document.getElementById('create-game-server-form');
  if (!form) return;

  // Evita binds duplicados
  const newForm = form.cloneNode(true);
  form.parentNode.replaceChild(newForm, form);

  newForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = document.getElementById('game-server-name').value;
    const game_type = document.getElementById('game-server-type').value;
    const ram_limit_mb = document.getElementById('game-server-ram').value;
    const cpu_limit = document.getElementById('game-server-cpu').value;
    const node_id = document.getElementById('game-server-node-id').value || null;

    try {
      showToast('Iniciando criação do servidor de jogo...', 'info');
      const res = await apiPost('/games/create', { name, game_type, ram_limit_mb, cpu_limit, node_id });
      if (res) {
        showToast(res.message, 'success');
        newForm.reset();
        closeModal('modal-create-game-server');
        loadGameServers();
      }
    } catch (err) {}
  });
};

const activeNumberAnimations = {};

function animateValue(elementId, endValue, duration = 800, suffix = '') {
  const element = document.getElementById(elementId);
  if (!element) return;
  
  const startValue = parseInt(element.innerText) || 0;
  if (startValue === endValue) return;

  const startTime = performance.now();
  
  // Cancela a animação anterior se já estivesse rodando neste elemento
  if (activeNumberAnimations[elementId]) {
    cancelAnimationFrame(activeNumberAnimations[elementId]);
  }
  
  function updateNumber(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    
    // Easing simples outQuad
    const ease = progress * (2 - progress);
    const currentValue = Math.round(startValue + (endValue - startValue) * ease);
    
    element.innerText = currentValue + suffix;
    
    if (progress < 1) {
      activeNumberAnimations[elementId] = requestAnimationFrame(updateNumber);
    } else {
      delete activeNumberAnimations[elementId];
    }
  }
  
  activeNumberAnimations[elementId] = requestAnimationFrame(updateNumber);
}

window.loadRootConsole = async function() {
  const consoleBox = document.getElementById('root-console-box');
  const inputEl = document.getElementById('root-console-input');
  
  // Se a consola já estiver conectada e com logs carregados, apenas foca
  if (inputEl && !inputEl.disabled && consoleBox && !consoleBox.innerHTML.includes('Conectando ao terminal')) {
    inputEl.focus();
    return;
  }

  if (consoleBox) {
    consoleBox.innerHTML = `<div style="color: #666;">Conectando ao terminal de sistema...</div>`;
  }

  const sendBtn = document.getElementById('root-console-send-btn');
  if (inputEl) {
    inputEl.disabled = true;
    inputEl.placeholder = "A aguardar ligação...";
  }
  if (sendBtn) {
    sendBtn.disabled = true;
  }

  // Reseta estado do lazy loading
  terminalOffset = 0;
  terminalHasMore = true;
  terminalIsLoading = false;

  // Carrega as primeiras linhas (histórico recente)
  try {
    const res = await apiGet(`/terminal/history?offset=0&limit=${terminalLimit}`);
    if (consoleBox) {
      consoleBox.innerHTML = '';
    }
    if (res && res.lines && res.lines.length > 0) {
      res.lines.forEach(line => {
        const div = document.createElement('div');
        div.style.lineHeight = '1.6';
        div.style.whiteSpace = 'pre-wrap';
        
        const isCommand = /^\[[^\]]+\]\s+[a-zA-Z0-9_-]+:/.test(line);
        if (isCommand) {
          div.style.color = '#00d2ff';
          div.style.fontWeight = '500';
        } else {
          div.style.color = '#ffffff';
        }
        div.textContent = line + '\n';
        consoleBox.appendChild(div);
      });
      
      // Ajusta o offset inicial
      terminalOffset = res.lines.length;
      terminalHasMore = res.hasMore;

      // Scroll para a última linha (final do terminal)
      consoleBox.scrollTop = consoleBox.scrollHeight;
    }
  } catch (err) {
    console.error('Erro ao buscar histórico inicial:', err);
  }

  // Conecta ao stream WebSocket
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify({
      type: 'join_root_console'
    }));
  }

  // Configura escutador de scroll para lazy loading
  if (consoleBox) {
    consoleBox.onscroll = () => {
      if (consoleBox.scrollTop === 0) {
        loadOlderTerminalLogs();
      }
    };
  }
};

window.sendRootConsoleCommand = function() {
  const inputEl = document.getElementById('root-console-input');
  if (!inputEl || inputEl.disabled || !inputEl.value.trim()) return;

  const cmd = inputEl.value.trim();
  inputEl.value = '';

  // Limpa instantaneamente a consola no ecrã do cliente
  if (cmd.toLowerCase() === 'clear' || cmd.toLowerCase() === 'cls') {
    const consoleBox = document.getElementById('root-console-box');
    if (consoleBox) {
      consoleBox.innerHTML = '';
    }
  }

  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify({
      type: 'root_console_command',
      command: cmd
    }));
  }
};

window.sendRootConsoleSigint = function() {
  const inputEl = document.getElementById('root-console-input');
  if (!inputEl || inputEl.disabled) return;

  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify({
      type: 'root_console_sigint'
    }));
  }
};

window.handleRootConsoleInput = function(e) {
  if (e.key === 'Enter') {
    sendRootConsoleCommand();
  }
};

window.openSiteConsole = function(domain) {
  window.activeSiteConsoleDomain = domain;
  openModal('modal-site-console');

  const titleEl = document.getElementById('site-console-domain');
  if (titleEl) titleEl.innerText = domain;

  const consoleBox = document.getElementById('site-console-box');
  if (consoleBox) {
    consoleBox.innerHTML = `<div style="color: #666;">Conectando ao console do site ${domain}...</div>`;
  }

  const inputEl = document.getElementById('site-console-input');
  if (inputEl) {
    inputEl.focus();
  }

  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify({
      type: 'join_site_console',
      domain: domain
    }));
  }
};

window.sendSiteConsoleCommand = function() {
  const inputEl = document.getElementById('site-console-input');
  if (!inputEl || !inputEl.value.trim() || !window.activeSiteConsoleDomain) return;

  const cmd = inputEl.value.trim();
  inputEl.value = '';

  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify({
      type: 'site_console_command',
      domain: window.activeSiteConsoleDomain,
      command: cmd
    }));
  }
};

window.handleSiteConsoleInput = function(e) {
  if (e.key === 'Enter') {
    sendSiteConsoleCommand();
  }
};

window.loadUserProfile = async function() {
  try {
    const data = await apiGet('/profile');
    if (data) {
      window.pmaPath = data.pmaPath || '/phpmyadmin';
      const idEl = document.getElementById('profile-id-display');
      const userEl = document.getElementById('profile-username-display');
      const roleEl = document.getElementById('profile-role-badge');
      const gmailEl = document.getElementById('profile-gmail-display');
      
      const gmailStatus = document.getElementById('profile-gmail-status');
      const gmailSubtext = document.getElementById('profile-gmail-subtext');
      const btnAssociate = document.getElementById('btn-associate-google');
      const btnDisassociate = document.getElementById('btn-disassociate-google');
      
      const avatarContainer = document.getElementById('profile-avatar-container');
      const gmailBadge = document.getElementById('gmail-badge');
      
      if (idEl) idEl.innerText = data.id || '-';
      if (userEl) userEl.innerText = data.username || '-';
      if (roleEl) {
        roleEl.innerText = data.role === 'admin' ? 'Administrador' : 'Cliente';
        roleEl.className = data.role === 'admin' ? 'badge badge-success' : 'badge badge-secondary';
      }
      
      const gmail = data.gmail || '';
      if (gmailEl) gmailEl.innerText = gmail || 'Nenhuma conta Gmail associada';
      
      // Atualiza estado do painel de associação Gmail
      if (gmail) {
        if (gmailStatus) gmailStatus.innerText = `Estado: Associado (${gmail})`;
        if (gmailSubtext) gmailSubtext.innerText = 'Conta Google associada com sucesso!';
        if (btnAssociate) {
          const span = btnAssociate.querySelector('span');
          if (span) span.innerText = 'Alterar Conta';
        }
        if (btnDisassociate) btnDisassociate.style.display = 'inline-flex';
      } else {
        if (gmailStatus) gmailStatus.innerText = 'Estado: Nenhuma conta associada';
        if (gmailSubtext) gmailSubtext.innerText = 'Clique no botão para autenticar e associar a sua conta Gmail.';
        if (btnAssociate) {
          const span = btnAssociate.querySelector('span');
          if (span) span.innerText = 'Iniciar sessão com o Google';
        }
        if (btnDisassociate) btnDisassociate.style.display = 'none';
      }
      
      const sidebarAvatar = document.getElementById('user-avatar');
      const sidebarUsername = document.getElementById('sidebar-username');
      const sidebarRole = document.getElementById('sidebar-role');
      
      // Atualiza sidebar e salva no localStorage para cache
      if (sidebarUsername) sidebarUsername.innerText = data.username;
      if (sidebarRole) sidebarRole.innerText = data.role === 'admin' ? 'Administrador' : 'Cliente';
      localStorage.setItem('bcp_username', data.username);
      localStorage.setItem('bcp_role', data.role === 'admin' ? 'Admin' : 'Cliente');
      
      if (gmail && data.avatarUrl) {
        if (avatarContainer) avatarContainer.innerHTML = `<img src="${data.avatarUrl}" alt="Avatar" style="width:100%; height:100%; object-fit:cover;">`;
        if (gmailBadge) gmailBadge.style.display = 'flex';
        if (sidebarAvatar) {
          sidebarAvatar.innerHTML = `<img src="${data.avatarUrl}" alt="Avatar" style="width:100%; height:100%; object-fit:cover; border-radius:50%;">`;
        }
      } else {
        const firstLetter = (data.username || 'U').charAt(0).toUpperCase();
        if (avatarContainer) {
          avatarContainer.innerHTML = firstLetter;
          avatarContainer.style.background = 'var(--bg-panel-hover)';
        }
        if (gmailBadge) gmailBadge.style.display = 'none';
        if (sidebarAvatar) {
          sidebarAvatar.innerHTML = firstLetter;
          sidebarAvatar.style.background = 'var(--bg-panel-hover)';
        }
      }
      loadLoginHistory();
    }
  } catch (err) {
    console.error('Erro ao carregar perfil:', err);
  } finally {
    if (!window.isRedirecting) {
      document.body.style.opacity = '1';
    }
  }
};

window.associateGoogleAuth = function() {
  const token = localStorage.getItem('bcp_token');
  if (!token) {
    showToast('Sessão expirada. Faça login novamente.', 'error');
    return;
  }
  
  // Abre o popup do Google Iniciar Sessão simulado
  const width = 500;
  const height = 600;
  const left = (window.screen.width / 2) - (width / 2);
  const top = (window.screen.height / 2) - (height / 2);
  
  window.open(
    `/google-auth.html?token=${encodeURIComponent(token)}`,
    'GoogleAuthPopup',
    `width=${width},height=${height},top=${top},left=${left},status=no,toolbar=no,menubar=no,location=no`
  );
};

window.disassociateGoogleAuth = async function() {
  if (!confirm('Tem a certeza que deseja desassociar a sua conta Gmail?')) return;
  try {
    showToast('A remover associação com Gmail...', 'info');
    const data = await apiPost('/profile/gmail', { gmail: null });
    if (data) {
      showToast('Conta Gmail desassociada com sucesso.', 'success');
      loadUserProfile();
    }
  } catch (err) {
    showToast(err.message || 'Erro ao desassociar Gmail.', 'error');
  }
};

window.setupProfileForms = function() {
  // Listener para capturar o evento de sucesso do popup do Google Auth
  window.removeEventListener('message', handleGoogleAuthMessage); // garante que não duplicamos listeners
  window.addEventListener('message', handleGoogleAuthMessage);

  // Password Form
  const passwordForm = document.getElementById('profile-password-form');
  if (passwordForm) {
    passwordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = document.getElementById('profile-curr-pass').value;
      const newPassword = document.getElementById('profile-new-pass').value;
      const confirmPassword = document.getElementById('profile-new-pass-confirm').value;

      if (newPassword !== confirmPassword) {
        showToast('As palavras-passe não coincidem.', 'error');
        return;
      }

      try {
        showToast('A atualizar a palavra-passe...', 'info');
        const data = await apiPost('/profile/password', { currentPassword, newPassword });
        if (data) {
          showToast(data.message, 'success');
          passwordForm.reset();
        }
      } catch (err) {
        showToast(err.message || 'Erro ao atualizar a palavra-passe.', 'error');
      }
    });
  }
};

function handleGoogleAuthMessage(event) {
  if (event.data && event.data.type === 'google-auth-success') {
    showToast(`Conta Google (${event.data.email}) associada com sucesso!`, 'success');
    loadUserProfile();
  }
}

// Ativa atalho de teclado Ctrl+C para as consolas (Root e Site)
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
    const activeEl = document.activeElement;
    
    // Elementos da consola de Root
    const rootConsoleBox = document.getElementById('root-console-box');
    const rootInputEl = document.getElementById('root-console-input');
    
    // Elementos da consola do Site
    const siteConsoleBox = document.getElementById('site-console-box');
    const siteInputEl = document.getElementById('site-console-input');
    
    // Se o foco estiver na consola de Root
    if (activeEl === rootInputEl || activeEl === rootConsoleBox || (rootConsoleBox && rootConsoleBox.contains(activeEl))) {
      if (activeEl === rootInputEl) {
        e.preventDefault();
        sendRootConsoleSigint();
      } else {
        const selection = window.getSelection().toString();
        if (!selection) {
          e.preventDefault();
          sendRootConsoleSigint();
        }
      }
    }
    // Se o foco estiver na consola do Site
    else if (activeEl === siteInputEl || activeEl === siteConsoleBox || (siteConsoleBox && siteConsoleBox.contains(activeEl))) {
      if (activeEl === siteInputEl) {
        e.preventDefault();
        sendRootConsoleSigint(); // O backend usa activeShell para a shell ativa (seja root ou site)
      } else {
        const selection = window.getSelection().toString();
        if (!selection) {
          e.preventDefault();
          sendRootConsoleSigint();
        }
      }
    }
  }
});

// ==========================================
// MÓDULO DE NÓS DE SERVIDOR (WINGS)
// ==========================================
async function populateNodesDropdown() {
  const select = document.getElementById('game-server-node-id');
  if (!select) return;

  try {
    const nodes = await apiGet('/nodes');
    select.innerHTML = '<option value="">🖥️ Servidor Local (Docker Principal)</option>';
    nodes.forEach(node => {
      const option = document.createElement('option');
      option.value = node.id;
      option.textContent = `🖥️ ${node.name} (${node.ip_address}:${node.api_port})`;
      select.appendChild(option);
    });
  } catch (err) {
    console.error('Erro ao buscar nós para o dropdown:', err);
  }
}

window.loadNodes = async function() {
  const container = document.getElementById('nodes-list-body');
  if (!container) return;

  try {
    const nodes = await apiGet('/nodes');
    if (!nodes || nodes.length === 0) {
      container.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Nenhum nó de servidor cadastrado.</td></tr>`;
      return;
    }

    container.innerHTML = '';
    nodes.forEach(node => {
      const tr = document.createElement('tr');
      const maskedSecret = node.daemon_token_secret.substring(0, 6) + '...' + node.daemon_token_secret.substring(node.daemon_token_secret.length - 4);
      const dateStr = new Date(node.created_at).toLocaleString();

      tr.innerHTML = `
        <td><strong>${node.name}</strong></td>
        <td><span style="font-family: var(--font-mono); font-size:12px; color: var(--color-secondary);">${node.ip_address}</span></td>
        <td><strong style="font-family: var(--font-mono);">${node.api_port}</strong></td>
        <td><span style="font-family: var(--font-mono); font-size: 11px; opacity: 0.6;">${maskedSecret}</span></td>
        <td><span style="font-size: 12px; color: var(--text-secondary);">${dateStr}</span></td>
        <td style="text-align: right;">
          <button class="btn-danger-outline" onclick="deleteNode(${node.id}, '${node.name}')">
            Remover
          </button>
        </td>
      `;
      container.appendChild(tr);
    });
  } catch (err) {
    console.error('Erro ao carregar nós:', err);
    container.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--color-danger);">Erro ao carregar nós de servidor.</td></tr>`;
  }
};

window.deleteNode = async function(id, name) {
  if (!confirm(`Tem certeza de que deseja remover o nó "${name}"? Servidores associados a este nó poderão falhar ao comunicar.`)) {
    return;
  }

  try {
    const res = await apiPost('/nodes/delete', { id });
    if (res) {
      showToast(res.message, 'success');
      loadNodes();
    }
  } catch (err) {
    console.error('Erro ao excluir nó:', err);
  }
};

window.setupNodesForms = function() {
  const form = document.getElementById('create-node-form');
  if (!form) return;

  const newForm = form.cloneNode(true);
  form.parentNode.replaceChild(newForm, form);

  newForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = document.getElementById('node-name').value;
    const ipAddress = document.getElementById('node-ip').value;
    const apiPort = parseInt(document.getElementById('node-port').value, 10);
    const daemonTokenSecret = document.getElementById('node-secret').value;

    try {
      showToast('A registrar novo nó de servidor...', 'info');
      const res = await apiPost('/nodes/create', { name, ipAddress, apiPort, daemonTokenSecret });
      if (res) {
        showToast(res.message, 'success');
        newForm.reset();
        closeModal('modal-add-node');
        loadNodes();
      }
    } catch (err) {}
  });
};

async function loadOlderTerminalLogs() {
  if (terminalIsLoading || !terminalHasMore) return;
  
  const consoleBox = document.getElementById('root-console-box');
  if (!consoleBox) return;

  terminalIsLoading = true;
  
  // Guardamos a altura atual e scrolltop antes de inserir logs antigos
  const previousScrollHeight = consoleBox.scrollHeight;
  const previousScrollTop = consoleBox.scrollTop;

  try {
    const res = await apiGet(`/terminal/history?offset=${terminalOffset}&limit=${terminalLimit}`);
    if (res && res.lines) {
      if (res.lines.length === 0) {
        terminalHasMore = false;
        terminalIsLoading = false;
        return;
      }

      const fragment = document.createDocumentFragment();
      res.lines.forEach(line => {
        const div = document.createElement('div');
        div.style.lineHeight = '1.6';
        div.style.whiteSpace = 'pre-wrap';
        
        const isCommand = /^\[[^\]]+\]\s+[a-zA-Z0-9_-]+:/.test(line);
        if (isCommand) {
          div.style.color = '#00d2ff';
          div.style.fontWeight = '500';
        } else {
          div.style.color = '#ffffff';
        }
        div.textContent = line + '\n';
        fragment.appendChild(div);
      });

      // Insere no início do terminal
      consoleBox.insertBefore(fragment, consoleBox.firstChild);

      // Incrementa o offset
      terminalOffset += res.lines.length;
      terminalHasMore = res.hasMore;

      // Ajusta o scrolltop para manter a mesma posição visual
      const newScrollHeight = consoleBox.scrollHeight;
      consoleBox.scrollTop = previousScrollTop + (newScrollHeight - previousScrollHeight);
    }
  } catch (err) {
    console.error('Erro ao carregar histórico antigo do terminal:', err);
  } finally {
    terminalIsLoading = false;
  }
}

// ==========================================
// MÓDULO DE GESTÃO DE PROCESSOS (TASK MANAGER)
// ==========================================
window.loadProcesses = async function() {
  const container = document.getElementById('processes-list-body');
  if (!container) return;

  try {
    const data = await apiGet('/system/processes');
    const list = data.processes || [];
    const sentinelEnabled = data.sentinelEnabled;

    // Atualiza o estado visual do Sentinela
    const statusCard = document.getElementById('sentinel-status-card');
    const statusDot = document.getElementById('sentinel-status-dot');
    const statusText = document.getElementById('sentinel-status-text');
    const toggleBtn = document.getElementById('btn-toggle-sentinel');

    if (statusCard && statusDot && statusText && toggleBtn) {
      window.sentinelEnabled = sentinelEnabled;
      if (sentinelEnabled) {
        statusCard.style.borderColor = 'rgba(16, 185, 129, 0.2)';
        statusCard.style.background = 'linear-gradient(135deg, rgba(16, 185, 129, 0.05), rgba(0,0,0,0.4))';
        statusDot.style.backgroundColor = '#10b981';
        statusDot.style.boxShadow = '0 0 10px #10b981';
        statusText.innerText = 'Proteção: Ativa';
        statusText.style.color = '#10b981';
        toggleBtn.innerText = 'Desativar';
        toggleBtn.style.background = 'transparent';
        toggleBtn.style.color = 'var(--color-danger)';
        toggleBtn.style.border = '1px solid var(--color-danger)';
      } else {
        statusCard.style.borderColor = 'rgba(239, 68, 68, 0.2)';
        statusCard.style.background = 'linear-gradient(135deg, rgba(239, 68, 68, 0.05), rgba(0,0,0,0.4))';
        statusDot.style.backgroundColor = '#ef4444';
        statusDot.style.boxShadow = '0 0 10px #ef4444';
        statusText.innerText = 'Proteção: Desativada';
        statusText.style.color = '#ef4444';
        toggleBtn.innerText = 'Ativar';
        toggleBtn.style.background = '#10b981';
        toggleBtn.style.color = '#ffffff';
        toggleBtn.style.border = '1px solid #10b981';
      }
    }

    if (!list || list.length === 0) {
      container.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Nenhum processo ativo encontrado.</td></tr>`;
      return;
    }

    container.innerHTML = '';
    list.forEach(proc => {
      const tr = document.createElement('tr');
      
      // Estilização diferenciada se estiver sob risco elevado ou quarentena
      if (proc.isQuarantined) {
        tr.style.opacity = '0.7';
        tr.style.backgroundColor = 'rgba(239, 68, 68, 0.02)';
      } else if (proc.crashRisk) {
        tr.style.backgroundColor = 'rgba(245, 158, 11, 0.02)';
      }

      tr.innerHTML = `
        <td><strong style="font-family: var(--font-mono); color: var(--color-primary);">${proc.pid}</strong></td>
        <td>
          <div style="display: flex; align-items: center; gap: 8px;">
            <div style="font-family: var(--font-mono); font-size: 13px; font-weight: 500; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${proc.name}">
              ${proc.name}
            </div>
            ${proc.isQuarantined ? `
              <span style="font-size: 10px; background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4); color: #ef4444; padding: 1px 6px; border-radius: 3px; font-weight: 600; text-transform: uppercase;">Quarentena</span>
            ` : ''}
            ${proc.crashRisk && !proc.isQuarantined ? `
              <span style="font-size: 10px; background: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.4); color: #f59e0b; padding: 1px 6px; border-radius: 3px; font-weight: 600;" title="Consumo extremo! Risco elevado de crash ou lentidão.">⚠️ Risco Crash</span>
            ` : ''}
          </div>
        </td>
        <td><span style="font-size: 12px; color: var(--text-secondary);">${proc.user}</span></td>
        <td><strong style="font-family: var(--font-mono); color: ${proc.crashRisk ? '#f59e0b' : 'var(--color-secondary)'};">${proc.cpu}%</strong></td>
        <td><span style="font-family: var(--font-mono); opacity: 0.85;">${proc.mem}%</span></td>
        <td style="text-align: right;">
          <div style="display: flex; gap: 8px; justify-content: flex-end;">
            ${proc.isQuarantined ? `
              <button class="btn-success-outline" style="padding: 4px 10px; font-size: 12px; color: #10b981; border: 1px solid rgba(16, 185, 129, 0.4); background: transparent; border-radius: 4px; cursor: pointer;" onclick="resumeProcess(${proc.pid}, '${proc.name.replace(/'/g, "\\'")}')">
                Libertar
              </button>
            ` : `
              <button class="btn-warning-outline" style="padding: 4px 10px; font-size: 12px; color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.4); background: transparent; border-radius: 4px; cursor: pointer;" onclick="quarantineProcess(${proc.pid}, '${proc.name.replace(/'/g, "\\'")}')">
                Quarentena
              </button>
            `}
            <button class="btn-danger-outline" style="padding: 4px 10px; font-size: 12px;" onclick="killProcess(${proc.pid}, '${proc.name.replace(/'/g, "\\'")}')">
              Terminar
            </button>
          </div>
        </td>
      `;
      container.appendChild(tr);
    });
  } catch (err) {
    console.error('Erro ao carregar lista de processos:', err);
    container.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--color-danger);">Erro ao carregar lista de processos.</td></tr>`;
  }
};

window.killProcess = async function(pid, name) {
  if (!confirm(`Tem certeza de que deseja forçar o encerramento do processo "${name}" (PID: ${pid})?`)) {
    return;
  }

  try {
    showToast(`A tentar terminar o processo ${pid}...`, 'info');
    const res = await apiPost('/system/processes/kill', { pid });
    if (res) {
      showToast(res.message, 'success');
      loadProcesses();
    }
  } catch (err) {
    showToast(err.message || 'Erro ao terminar processo.', 'error');
  }
};

window.quarantineProcess = async function(pid, name) {
  if (!confirm(`Deseja colocar o processo "${name}" (PID: ${pid}) em quarentena?\n\nIsto irá suspender a sua execução imediatamente (SIGSTOP) libertando a CPU, sem terminar o processo definitivamente.`)) {
    return;
  }

  try {
    showToast(`A aplicar quarentena ao processo ${pid}...`, 'info');
    const res = await apiPost('/system/processes/quarantine', { pid });
    if (res) {
      showToast(res.message, 'success');
      loadProcesses();
    }
  } catch (err) {
    showToast(err.message || 'Erro ao colocar processo em quarentena.', 'error');
  }
};

window.resumeProcess = async function(pid, name) {
  try {
    showToast(`A libertar o processo ${pid} da quarentena...`, 'info');
    const res = await apiPost('/system/processes/resume', { pid });
    if (res) {
      showToast(res.message, 'success');
      loadProcesses();
    }
  } catch (err) {
    showToast(err.message || 'Erro ao libertar processo da quarentena.', 'error');
  }
};

window.toggleSentinel = async function() {
  const nextState = !window.sentinelEnabled;
  try {
    showToast(nextState ? 'A ativar Sentinela Anti-Crash...' : 'A desativar Sentinela Anti-Crash...', 'info');
    const res = await apiPost('/system/processes/sentinel', { enabled: nextState });
    if (res) {
      showToast(res.message, 'success');
      loadProcesses();
    }
  } catch (err) {
    showToast(err.message || 'Erro ao alterar estado do Sentinela.', 'error');
  }
};

window.loadLoginHistory = async function() {
  const container = document.getElementById('profile-login-history-body');
  if (!container) return;

  try {
    const data = await apiGet('/auth/login-history');
    if (!data || data.length === 0) {
      container.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Nenhum início de sessão registado.</td></tr>`;
      return;
    }

    let html = '';
    data.forEach(item => {
      const dateStr = new Date(item.created_at).toLocaleString('pt-PT');
      const stateBadge = item.is_unknown_location === 1 
        ? `<span class="badge badge-warning" style="font-size: 10px; padding: 2px 8px; border-radius: 4px; color: #fff;">Novo Local</span>`
        : `<span class="badge badge-success" style="font-size: 10px; padding: 2px 8px; border-radius: 4px; color: #fff;">Conhecido</span>`;
      
      const locText = item.location === 'Rede Local / Localhost' 
        ? `<span style="color: var(--color-primary); font-weight: 500;">${item.location}</span>`
        : item.location;

      html += `
        <tr>
          <td style="font-family: var(--font-mono); font-size: 11px;">${dateStr}</td>
          <td style="font-family: var(--font-mono);">${item.ip_address}</td>
          <td>${locText}</td>
          <td style="color: var(--text-secondary);">${item.user_agent || '-'}</td>
          <td style="text-align: right;">${stateBadge}</td>
        </tr>
      `;
    });
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Falha ao carregar histórico: ${err.message}</td></tr>`;
  }
};

window.checkPanelVersion = async function() {
  const versionEl = document.getElementById('sys-panel-version');
  const updateBtn = document.getElementById('btn-update-panel');
  if (!versionEl) return;

  try {
    const data = await apiGet('/system/version');
    if (data) {
      versionEl.innerText = `v${data.localVersion}`;
      
      const role = localStorage.getItem('bcp_role');
      if (data.updateAvailable && role === 'admin') {
        versionEl.innerHTML = `v${data.localVersion} <span style="color: var(--color-danger); font-size: 10px; margin-left: 6px;">(Nova: v${data.remoteVersion})</span>`;
        if (updateBtn) updateBtn.style.display = 'inline-flex';
      } else {
        if (updateBtn) updateBtn.style.display = 'none';
      }
    }
  } catch (err) {
    console.error('Erro ao verificar versão do painel:', err);
    versionEl.innerText = 'Desconhecida';
  }
};

window.updatePanel = async function() {
  if (!confirm('Deseja realmente atualizar o BestCode CP para a última versão do GitHub?\n\nO painel irá descarregar os ficheiros e reiniciar os serviços. O painel ficará indisponível por alguns segundos.')) {
    return;
  }

  const overlay = document.getElementById('modal-updating-overlay');
  if (overlay) overlay.style.display = 'flex';

  try {
    showToast('A iniciar processo de atualização...', 'info');
    const res = await apiPost('/system/update');
    
    if (res) {
      showToast(res.message, 'success');
      
      // Começa a tentar reconectar ao servidor periodicamente até voltar a estar online
      let checkAttempts = 0;
      const checkInterval = setInterval(async () => {
        checkAttempts++;
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 1000);
          
          const response = await fetch('/api/profile', {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('bcp_token') },
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          if (response.status === 200) {
            clearInterval(checkInterval);
            showToast('Painel atualizado e online com sucesso!', 'success');
            setTimeout(() => {
              window.location.reload();
            }, 1000);
          }
        } catch (e) {
          // Ignora falha de rede temporária
        }
        
        if (checkAttempts > 30) {
          clearInterval(checkInterval);
          if (overlay) overlay.style.display = 'none';
          showToast('O servidor está a demorar muito para reiniciar. Por favor, recarregue a página manualmente.', 'warning');
        }
      }, 1500);
    }
  } catch (err) {
    if (overlay) overlay.style.display = 'none';
    showToast(err.message || 'Erro ao iniciar atualização.', 'error');
  }
};


