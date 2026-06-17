// Client ID do Google OAuth, configurável por instalação via variável de ambiente.
// Cada deployment pode definir GOOGLE_CLIENT_ID (ex: no systemd ou em bcp.env) com o
// seu próprio OAuth client, registado para o seu domínio na Google Cloud Console.
// O valor por omissão mantém a compatibilidade com instalações existentes.
const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ||
  '375047373627-obmrc23n7gvntfm9dreu416rgvs9dj1p.apps.googleusercontent.com';

module.exports = { GOOGLE_CLIENT_ID };
