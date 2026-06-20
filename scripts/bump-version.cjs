const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

try {
  const pkgPath = path.resolve(__dirname, '../backend/package.json');
  if (!fs.existsSync(pkgPath)) {
    // backend/ pode não existir neste checkout (ex.: repo público só com scripts).
    // Não bloquear o commit por isso.
    console.warn('[BUMP-VERSION] backend/package.json ausente — bump ignorado.');
    process.exit(0);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const oldVersion = pkg.version || '1.0.0';
  const versionParts = oldVersion.split('.').map(Number);

  if (versionParts.length === 3 && !versionParts.some(isNaN)) {
    versionParts[2] += 1;
    const newVersion = versionParts.join('.');
    pkg.version = newVersion;
    
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    console.log(`[BUMP-VERSION] Bumped backend version from ${oldVersion} to ${newVersion}`);

    // Tenta incluir o package.json no commit. Em repos onde backend/ está
    // gitignored (ex.: repo público só de scripts), o git add falha — e isso
    // NÃO deve bloquear o commit.
    try {
      execSync('git add backend/package.json', { stdio: 'ignore' });
    } catch (e) {
      console.warn('[BUMP-VERSION] backend/ não tracked aqui — bump não foi staged (ok).');
    }
  } else {
    console.error('[BUMP-VERSION] Invalid version format in backend/package.json:', oldVersion);
    process.exit(1);
  }
} catch (error) {
  console.error('[BUMP-VERSION] Error bumping version:', error.message);
  process.exit(1);
}
