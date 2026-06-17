const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

try {
  const pkgPath = path.resolve(__dirname, '../backend/package.json');
  if (!fs.existsSync(pkgPath)) {
    console.error('[BUMP-VERSION] backend/package.json not found.');
    process.exit(1);
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
    
    // Auto-stage the changed package.json so it is included in the commit
    execSync('git add backend/package.json');
  } else {
    console.error('[BUMP-VERSION] Invalid version format in backend/package.json:', oldVersion);
    process.exit(1);
  }
} catch (error) {
  console.error('[BUMP-VERSION] Error bumping version:', error.message);
  process.exit(1);
}
