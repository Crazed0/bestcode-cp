<?php
/**
 * Script de Autenticação Única (SSO / Signon) para phpMyAdmin
 * Integrado ao BestCode Control Panel (BCP).
 *
 * Este script deve ser colocado no diretório raiz do phpMyAdmin
 * (ex: /usr/share/phpmyadmin/signon.php)
 *
 * O phpMyAdmin correspondente deve ser configurado em config.inc.php com:
 * $cfg['Servers'][$i]['auth_type'] = 'signon';
 * $cfg['Servers'][$i]['SignonSession'] = 'BestCodeSignonSession';
 * $cfg['Servers'][$i]['SignonURL'] = '/phpmyadmin/signon.php';
 */

// Caminho do banco SQLite do painel (usado apenas como fallback se o Redis não tiver o token).
// Suporta dev (WSL mount) e produção. Pode ficar vazio — só importa no fallback.
$db_paths = [
    '/mnt/c/Users/Deyvi/Desktop/sites/BestCode/bestcode-cp/backend/database.db',
    '/opt/bestcode-cp/backend/database.db'
];
$db_path = '';
foreach ($db_paths as $path) {
    if (file_exists($path)) {
        $db_path = $path;
        break;
    }
}
define('DB_PATH', $db_path);

session_name('BestCodeSignonSession');
session_start();

$token = isset($_GET['token']) ? preg_replace('/[^a-f0-9]/', '', $_GET['token']) : '';

if (!$token) {
    // Se houve erro na tentativa de login anterior no phpMyAdmin, exibe a mensagem de erro
    if (isset($_SESSION['PMA_single_signon_error_message']) && !empty($_SESSION['PMA_single_signon_error_message'])) {
        $error_msg = $_SESSION['PMA_single_signon_error_message'];
        // Limpa a sessão para evitar loop infinito de redirecionamento
        unset($_SESSION['PMA_single_signon_user']);
        unset($_SESSION['PMA_single_signon_password']);
        unset($_SESSION['PMA_single_signon_error_message']);
        session_write_close();
        die("Erro ao autenticar no phpMyAdmin: " . htmlspecialchars($error_msg) . "<br><br>" . 
            "Isto geralmente ocorre se o utilizador ou senha gravados no painel não corresponderem ao servidor MySQL/MariaDB real.<br>" .
            "Por favor, volte ao painel BCP e verifique os dados de acesso do banco de dados.");
    }

    // Se não há token e não estamos autenticados, nega o acesso
    if (!isset($_SESSION['PMA_single_signon_user'])) {
        die("Acesso Negado: Token de login inválido ou expirado. Acesse pelo painel da BestCode.");
    }
    // Se já estiver autenticado na sessão, redireciona para a home do phpMyAdmin
    header('Location: index.php');
    exit;
}

// Verifica o token: tenta primeiro o Redis (caminho principal) e usa o SQLite só como fallback
try {
    $session = null;
    $redis_success = false;

    // Tenta obter os dados da sessão do Redis (onde o backend grava por omissão)
    if (class_exists('Redis')) {
        try {
            $redis = new Redis();
            // Conecta com timeout de 1.0s
            if (@$redis->connect('127.0.0.1', 6379, 1.0)) {
                $redisKey = "bcp:sso:" . $token;
                $cachedData = $redis->get($redisKey);
                if ($cachedData) {
                    $session = json_decode($cachedData, true);
                    $redis->del($redisKey); // Consome o token (OTC)
                    $redis_success = true;
                }
            }
        } catch (Exception $e) {
            // Ignora erro e faz fallback para SQLite
        }
    }

    if (!$redis_success) {
        // Fallback: consulta a sessão no SQLite do painel.
        // Só aqui o ficheiro é necessário; se faltar, dá erro claro a apontar para o Redis.
        if (!DB_PATH || !file_exists(DB_PATH)) {
            die("Erro de Integração: token não encontrado no Redis e o banco de dados do painel não está acessível. " .
                "Confirme que a extensão 'php-redis' está instalada e que o serviço Redis está ativo.");
        }

        $db = new PDO('sqlite:' . DB_PATH);
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

        // Consulta os dados da sessão no SQLite (fallback)
        $stmt = $db->prepare("SELECT db_user, db_pass, expires_at FROM sso_sessions WHERE token = :token");
        $stmt->execute([':token' => $token]);
        $session = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$session) {
            die("Sessão inválida: O token fornecido não foi encontrado.");
        }

        // Verifica se o token expirou (limite de 60 segundos)
        $currentTimeMs = round(microtime(true) * 1000);
        if ($currentTimeMs > $session['expires_at']) {
            // Exclui o token expirado
            $del = $db->prepare("DELETE FROM sso_sessions WHERE token = :token");
            $del->execute([':token' => $token]);
            die("Sessão expirada: O token de acesso expirou. Volte ao painel e tente novamente.");
        }

        // Apaga o token do banco para que não seja reutilizado (Token de Uso Único - OTC)
        $del = $db->prepare("DELETE FROM sso_sessions WHERE token = :token");
        $del->execute([':token' => $token]);
    }

    // Grava as credenciais na sessão para que o phpMyAdmin as recolha
    $_SESSION['PMA_single_signon_user'] = $session['db_user'];
    $_SESSION['PMA_single_signon_password'] = $session['db_pass'];
    $_SESSION['PMA_single_signon_host'] = '127.0.0.1'; // ou localhost
    $_SESSION['PMA_single_signon_port'] = 3306;

    // Fecha a sessão para liberar o lock e permitir que o phpMyAdmin a leia imediatamente
    session_write_close();

    // Redireciona para o phpMyAdmin para concluir o login
    header('Location: index.php');
    exit;

} catch (PDOException $e) {
    die("Erro interno no banco do painel: " . $e->getMessage());
}
