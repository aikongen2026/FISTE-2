const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const root = path.resolve(__dirname, '..');
const pub = path.join(root, 'public');
function must(cond, message) {
  if (!cond) { console.error(`DEPLOY BLOCKED: ${message}`); process.exit(1); }
}
for (const name of ['index.html','app.js','style.css','sw.js','manifest.webmanifest']) {
  must(fs.existsSync(path.join(pub, name)), `public/${name} mangler.`);
}
const index = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
must(index.includes('Vestfjella Fiske'), 'public/index.html er ikke Vestfjella Fiske.');
must(index.includes('STABLE 1.0'), 'public/index.html mangler STABLE 1.0.');
must(index.includes('v=1.0'), 'public/index.html peker ikke på STABLE 1.0-assets.');
must(sw.includes('vestfjella-fiste-stable-1'), 'public/sw.js bruker ikke riktig cache.');
must(sw.includes('v=1.0'), 'public/sw.js cacher ikke STABLE 1.0-assets.');
must(app.includes("/sw.js?v=1.0"), 'public/app.js registrerer ikke riktig service worker.');
const lures = JSON.parse(fs.readFileSync(path.join(pub,'data','user-lures.json'),'utf8'));
must(Array.isArray(lures.lures) && lures.lures.length >= 20, 'Vestfjella-slukboksen er ikke lastet.');
console.log(`Layout OK: Vestfjella Fiske STABLE 1.0 serveres fra /public med ${lures.lures.length} enkeltagn.`);
