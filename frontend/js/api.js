const API_URL = window.location.origin + '/api';

// Redireciona para o login caso não tenha token
function checkAuth() {
  const token = localStorage.getItem('bcp_token');
  if (!token && window.location.pathname !== '/login') {
    window.location.href = '/login';
  }
  return token;
}

// Configura dados do utilizador na UI
function setupUserUI() {
  const username = localStorage.getItem('bcp_username') || '';
  const role = localStorage.getItem('bcp_role') || '';

  const userEl = document.getElementById('sidebar-username');
  const roleEl = document.getElementById('sidebar-role');
  const avatarEl = document.getElementById('user-avatar');

  if (userEl) userEl.innerText = username || '...';
  if (roleEl) roleEl.innerText = role ? role.toUpperCase() : '...';
  if (avatarEl) avatarEl.innerText = username ? username.charAt(0).toUpperCase() : '...';
}

// Exibe notificações flutuantes (Toasts)
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerText = message;
  container.appendChild(toast);

  // Animação de fade out
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Faz requisições HTTP autenticadas com tratamento global de erros
async function apiRequest(endpoint, method = 'GET', body = null, isMultipart = false) {
  // Injeta automaticamente parâmetros de contexto se o File Manager estiver ativo
  if (window.activeFmContext) {
    if (endpoint.startsWith('/files')) {
      if (window.activeFmContext.type === 'game') {
        const gameServerId = window.activeFmContext.id;
        if (method === 'GET' || isMultipart) {
          const separator = endpoint.includes('?') ? '&' : '?';
          endpoint += `${separator}gameServerId=${gameServerId}`;
        } else if (body && typeof body === 'object' && !isMultipart) {
          body.gameServerId = gameServerId;
        } else if (!body && !isMultipart) {
          body = { gameServerId };
        }
      } else if (window.activeFmContext.type === 'site') {
        const sitePath = window.activeFmContext.path;
        if (method === 'GET' || isMultipart) {
          const separator = endpoint.includes('?') ? '&' : '?';
          endpoint += `${separator}sitePath=${encodeURIComponent(sitePath)}`;
        } else if (body && typeof body === 'object' && !isMultipart) {
          body.sitePath = sitePath;
        } else if (!body && !isMultipart) {
          body = { sitePath };
        }
      }
    }
  } else {
    // Caso padrão fora do File Manager (ex: ações/métricas de console de jogos)
    if (window.selectedGameServerId) {
      if (endpoint.startsWith('/games')) {
        if (method === 'GET' || isMultipart) {
          const separator = endpoint.includes('?') ? '&' : '?';
          endpoint += `${separator}gameServerId=${window.selectedGameServerId}`;
        } else if (body && typeof body === 'object' && !isMultipart) {
          body.gameServerId = window.selectedGameServerId;
        } else if (!body && !isMultipart) {
          body = { gameServerId: window.selectedGameServerId };
        }
      }
    }
  }

  const token = checkAuth();
  
  const headers = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  if (!isMultipart) {
    headers['Content-Type'] = 'application/json';
  }

  const config = {
    method,
    headers
  };

  if (body) {
    config.body = isMultipart ? body : JSON.stringify(body);
  }

  try {
    const response = await fetch(API_URL + endpoint, config);
    
    // Tratamento de expiração de token ou falta de autorização
    if (response.status === 401 || response.status === 403) {
      localStorage.clear();
      window.isRedirecting = true;
      window.location.href = '/login';
      return null;
    }

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Erro na requisição.');
    }
    return data;
  } catch (error) {
    showToast(error.message, 'error');
    throw error;
  }
}

// Helpers rápidos
const apiGet = (endpoint) => apiRequest(endpoint, 'GET');
const apiPost = (endpoint, body) => apiRequest(endpoint, 'POST', body);
const apiDelete = (endpoint, body) => apiRequest(endpoint, 'POST', body); // usando POST com corpo para exclusão por simplicidade
const apiUpload = (endpoint, formData) => apiRequest(endpoint, 'POST', formData, true);

// Executa na inicialização
checkAuth();
document.addEventListener('DOMContentLoaded', setupUserUI);
