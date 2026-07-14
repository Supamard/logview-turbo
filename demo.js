#!/usr/bin/env node
/*
 * demo.js — emits fake Turborepo-style output so you can try logview without
 * starting the real dev servers.
 *
 *   node logview.js node demo.js
 *   npm run demo
 */
'use strict';

const apps = ['app-1','service-2','app-3','app-4','service-5'];
const colors = { // just to mimic turbo coloring the prefix
  'app-1': 39, 'app-4': 208, 'service-2': 41,
  'app-3': 170, 'service-5': 220,
};

function ts() {
  return new Date().toLocaleTimeString('en-US');
}
function prefix(app) {
  return `\x1b[38;5;${colors[app]}m[${app}]\x1b[0m`;
}

const messages = [
  a => `${prefix(a)} [${ts()}] Starting compilation in watch mode...`,
  a => `${prefix(a)}  ✓ Ready in ${(Math.random() * 20 + 2).toFixed(1)}s`,
  a => `${prefix(a)} [${ts()}] Found 0 errors. Watching for file changes.`,
  a => `${prefix(a)}  ○ Compiling /src/middleware ...`,
  a => `${prefix(a)}  ⚠ warning: unused variable 'foo'`,
  a => `${prefix(a)} \x1b[31merror\x1b[0m TS2304: Cannot find name 'bar'.`,
  a => `${prefix(a)}  GET /api/health 200 in 4ms`,
];

// A couple of non-prefixed turbo banner lines at the start.
console.log('\x1b[2m• Packages in scope: ' + apps.join(', ') + '\x1b[0m');
console.log('\x1b[2m• Running dev in ' + apps.length + ' packages\x1b[0m');

setInterval(() => {
  const app = apps[Math.floor(Math.random() * apps.length)];
  const msg = messages[Math.floor(Math.random() * messages.length)];
  console.log(msg(app));
}, 350);
