const http = require('http');

/**
 * Obtém a localização geográfica a partir de um IP público usando a API gratuita ip-api.com.
 * @param {string} ip Endereço IP do cliente
 * @returns {Promise<string>} Cidade e país ou 'Rede Local / Localhost'
 */
function getIpLocation(ip) {
  return new Promise((resolve) => {
    // Normaliza IPs locais/loopback
    if (!ip) {
      resolve('Localização Desconhecida');
      return;
    }

    const cleanIp = ip.replace('::ffff:', '').trim();

    if (
      cleanIp === '127.0.0.1' ||
      cleanIp === '::1' ||
      cleanIp.startsWith('192.168.') ||
      cleanIp.startsWith('10.') ||
      cleanIp.startsWith('172.16.') ||
      cleanIp.startsWith('172.17.') || // Docker default bridge
      cleanIp === 'localhost'
    ) {
      resolve('Rede Local / Localhost');
      return;
    }

    // ip-api.com aceita chamadas via HTTP simples
    const url = `http://ip-api.com/json/${cleanIp}`;

    const request = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        resolve('Localização Desconhecida');
        return;
      }

      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json && json.status === 'success') {
            resolve(`${json.city}, ${json.country}`);
          } else {
            resolve('Localização Desconhecida');
          }
        } catch (e) {
          resolve('Localização Desconhecida');
        }
      });
    });

    request.on('error', () => {
      resolve('Localização Desconhecida');
    });

    // Timeout de 2 segundos para não atrasar logins por problemas de rede
    request.setTimeout(2000, () => {
      request.destroy();
      resolve('Localização Desconhecida (Timeout)');
    });
  });
}

/**
 * Converte um User Agent bruto em uma string amigável de navegador e SO.
 * @param {string} ua User Agent string
 * @returns {string} Descrição amigável
 */
function parseUserAgent(ua) {
  if (!ua) return 'Desconhecido';
  
  let os = 'Desconhecido';
  let browser = 'Desconhecido';

  // Deteção de Sistema Operativo
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Macintosh') || ua.includes('Mac OS')) os = 'macOS';
  else if (ua.includes('Linux')) {
    if (ua.includes('Android')) os = 'Android';
    else os = 'Linux';
  }
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';

  // Deteção de Navegador
  if (ua.includes('Firefox')) browser = 'Firefox';
  else if (ua.includes('Edge') || ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('Chrome')) {
    if (ua.includes('OPR') || ua.includes('Opera')) browser = 'Opera';
    else browser = 'Chrome';
  }
  else if (ua.includes('Safari')) {
    if (ua.includes('Chrome')) browser = 'Chrome';
    else browser = 'Safari';
  }

  if (browser === 'Desconhecido' && os === 'Desconhecido') {
    return 'Dispositivo Desconhecido';
  }

  return `${browser} no ${os}`;
}

module.exports = {
  getIpLocation,
  parseUserAgent
};
