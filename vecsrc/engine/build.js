const fs = require('fs'), p = require('path'), d = __dirname;
const shell = fs.readFileSync(p.join(d, 'studio_shell.html'), 'utf8');
const order = ['veccore.js', 'studio_app.js'];
const libs = order.map(f => '<script>\n' + fs.readFileSync(p.join(d, f), 'utf8') + '\n</script>').join('\n');
const out = shell.replace('<!--LIBS-->', libs);
const dest = p.join(d, '..', 'vector-studio.html');
fs.writeFileSync(dest, out);
// index.html → redirect so the static server root opens the app
const idx = p.join(d, '..', 'index.html');
fs.writeFileSync(idx, '<!DOCTYPE html><meta charset="utf-8"><title>Aquamentor Vector Studio</title>\n<meta http-equiv="refresh" content="0; url=vector-studio.html">\n<a href="vector-studio.html">Open Aquamentor Vector Studio</a>\n');
console.log('built', dest, Math.round(out.length / 1024) + 'KB', '(+ index.html redirect)');
