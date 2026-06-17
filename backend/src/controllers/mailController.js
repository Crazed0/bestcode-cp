const fs = require('fs').promises;
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { execCommand, isLinux } = require('../services/systemService');

/**
 * Helper para gerar senha no formato suportado pelo Dovecot (BCRYPT)
 * Dovecot suporta BCRYPT se prefixado com {BLF-CRYPT} ou se configurado corretamente.
 * Por simplicidade e segurança, geramos hash bcrypt padrão.
 */
function hashMailPassword(password) {
  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync(password, salt);
  // O Dovecot espera que o hash bcrypt tenha o prefixo {BLF-CRYPT} para saber que algoritmo usar
  return `{BLF-CRYPT}${hash}`;
}

/**
 * Listar todas as caixas de e-mail cadastradas
 */
async function getEmails(req, res) {
  try {
    const list = db.prepare('SELECT id, email_address, domain, quota_mb, created_at FROM emails ORDER BY created_at DESC').all();
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar contas de e-mail: ' + error.message });
  }
}

/**
 * Criar uma nova conta de e-mail (Mailbox)
 */
async function createEmail(req, res) {
  const { emailAddress, password, quotaMb } = req.body;

  if (!emailAddress || !password) {
    return res.status(400).json({ error: 'Endereço de e-mail e senha são obrigatórios.' });
  }

  // Validação simples de formato de e-mail
  const emailRegex = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;
  const match = emailAddress.match(emailRegex);
  if (!match) {
    return res.status(400).json({ error: 'Formato de e-mail inválido.' });
  }

  const domain = match[1];

  try {
    // Verifica se o domínio do e-mail existe nos sites do servidor
    const siteExists = db.prepare('SELECT id FROM sites WHERE domain = ?').get(domain);
    if (!siteExists) {
      return res.status(400).json({ error: `O domínio ${domain} não está cadastrado como site neste servidor. Cadastre-o primeiro.` });
    }

    // Verifica se a conta de e-mail já existe
    const existing = db.prepare('SELECT id FROM emails WHERE email_address = ?').get(emailAddress);
    if (existing) {
      return res.status(400).json({ error: 'Esta conta de e-mail já existe.' });
    }

    const hashedPassword = hashMailPassword(password);
    const quota = quotaMb ? parseInt(quotaMb, 10) : 1024;

    // Salva na tabela SQLite
    // Postfix/Dovecot serão configurados no instalador para consultar esta tabela em tempo real!
    db.prepare('INSERT INTO emails (email_address, domain, password, quota_mb) VALUES (?, ?, ?, ?)')
      .run(emailAddress, domain, hashedPassword, quota);

    res.json({ message: 'Conta de e-mail criada com sucesso!', emailAddress });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar conta de e-mail: ' + error.message });
  }
}

/**
 * Excluir conta de e-mail
 */
async function deleteEmail(req, res) {
  const { id } = req.body;

  try {
    const email = db.prepare('SELECT * FROM emails WHERE id = ?').get(id);
    if (!email) {
      return res.status(404).json({ error: 'Conta de e-mail não encontrada.' });
    }

    // Deleta do SQLite
    db.prepare('DELETE FROM emails WHERE id = ?').run(id);

    // No Linux, opcionalmente deletamos a pasta física de e-mails para liberar espaço
    if (isLinux) {
      const maildir = `/var/mail/vhosts/${email.domain}/${email.email_address}`;
      await execCommand(`rm -rf "${maildir}"`);
    }

    res.json({ message: 'Conta de e-mail excluída com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao excluir conta de e-mail: ' + error.message });
  }
}

/**
 * Obter registros DNS recomendados para o domínio de e-mail (SPF, DKIM, DMARC)
 */
async function getEmailDnsRecords(req, res) {
  const { domain } = req.query;

  if (!domain) {
    return res.status(400).json({ error: 'Domínio é obrigatório.' });
  }

  try {
    // Simula a chave DKIM gerada pelo OpenDKIM no servidor.
    // Em produção, o instalador gera a chave DKIM em /etc/opendkim/keys/domain.txt
    let dkimTxt = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0y...';
    
    if (isLinux) {
      try {
        const dkimFile = `/etc/opendkim/keys/${domain}/default.txt`;
        const content = await fs.readFile(dkimFile, 'utf8');
        // Extrai o conteúdo do registro TXT gerado pelo OpenDKIM
        const match = content.match(/\(([^)]+)\)/s);
        if (match) {
          dkimTxt = match[1].replace(/"/g, '').replace(/\s+/g, '');
        }
      } catch (err) {
        // Se ainda não gerado, exibe um valor padrão mockado
      }
    }

    res.json({
      domain,
      records: [
        { type: 'MX', name: '@', value: `mail.${domain}`, priority: 10, description: 'Servidor de E-mail de Entrada' },
        { type: 'A', name: `mail`, value: 'IP_DO_SEU_SERVIDOR', priority: null, description: 'Apontamento do servidor de e-mail' },
        { type: 'TXT', name: '@', value: 'v=spf1 mx ip4:IP_DO_SEU_SERVIDOR ~all', priority: null, description: 'Registro SPF (Validação de remetente)' },
        { type: 'TXT', name: 'default._domainkey', value: dkimTxt, priority: null, description: 'Assinatura DKIM (Evita falsificação)' },
        { type: 'TXT', name: '_dmarc', value: 'v=DMARC1; p=none; rua=mailto:postmaster@' + domain, priority: null, description: 'Política DMARC' }
      ]
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar registros DNS de e-mail: ' + error.message });
  }
}

/**
 * Alterar a senha de uma conta de e-mail
 */
async function changeMailPassword(req, res) {
  const { id, newPass } = req.body;

  if (!id || !newPass) {
    return res.status(400).json({ error: 'ID e nova senha são obrigatórios.' });
  }

  try {
    const emailRecord = db.prepare('SELECT id FROM emails WHERE id = ?').get(id);
    if (!emailRecord) {
      return res.status(404).json({ error: 'Conta de e-mail não encontrada.' });
    }

    const hashedPassword = hashMailPassword(newPass);

    db.prepare('UPDATE emails SET password = ? WHERE id = ?').run(hashedPassword, id);
    res.json({ message: 'Senha do e-mail alterada com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao alterar a senha do e-mail: ' + error.message });
  }
}

/**
 * Alterar a cota de uma conta de e-mail
 */
async function changeMailQuota(req, res) {
  const { id, quotaMb } = req.body;

  if (!id || !quotaMb) {
    return res.status(400).json({ error: 'ID e nova cota são obrigatórios.' });
  }

  try {
    const emailRecord = db.prepare('SELECT id FROM emails WHERE id = ?').get(id);
    if (!emailRecord) {
      return res.status(404).json({ error: 'Conta de e-mail não encontrada.' });
    }

    const quota = parseInt(quotaMb, 10);
    if (isNaN(quota) || quota < 100) {
      return res.status(400).json({ error: 'Cota de e-mail inválida. Mínimo 100 MB.' });
    }

    db.prepare('UPDATE emails SET quota_mb = ? WHERE id = ?').run(quota, id);
    res.json({ message: 'Cota de e-mail alterada com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao alterar a cota do e-mail: ' + error.message });
  }
}

module.exports = {
  getEmails,
  createEmail,
  deleteEmail,
  getEmailDnsRecords,
  changeMailPassword,
  changeMailQuota
};
