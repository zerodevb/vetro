'use strict';
// Garage Home additions: Samsung's Home is closed after Garage Home opens, and Autorun Smart Hub is switched off once.
const assert = require('assert').strict;
const auto = require('../service/garage-autostart.js');

(async () => {
  // homeGuard runs one background shell that closes Samsung's Home five times over about 3 s.
  const ran = [];
  await auto.homeGuard(cmd => { ran.push(cmd); return Promise.resolve({exit_code: 0}); });
  assert.equal(ran.length, 1);
  assert.equal((ran[0].match(/app_launcher -k com\.samsung\.tv\.csfs/g) || []).length, 5);
  assert.match(ran[0], /&$/, 'runs in the background');
  await auto.homeGuard(() => Promise.reject(new Error('agent gone')));   // never throws

  // Autorun: only switched off when it was on, and only the first time (a backup file marks it).
  assert.match(auto.AUTORUN_OFF, /if \[ ! -f "\$b" \]/);
  assert.match(auto.AUTORUN_OFF, /\[ "\$v" = 1 \] && vconftool set -f -t int db\/menu\/smart_hub\/ontvsetting\/auto_start 0/);
  assert.match(auto.AUTORUN_RESTORE, /vconftool set -f -t int db\/menu\/smart_hub\/ontvsetting\/auto_start "\$\(cat "\$b"\)"/);

  // Leaving an app that falls back to Samsung's Home: Garage Home opens and Samsung's Home is closed.
  const cmds = [], launched = [];
  let fg = 'MCmYXNxgcu.DisneyPlus';
  const execute = cmd => {
    cmds.push(cmd);
    if (/current_fullscreen_appid/.test(cmd)) return Promise.resolve({stdout: 'memory/appfw/current_fullscreen_appid, value = ' + fg + ' (string)\n'});
    return Promise.resolve({exit_code: 0});
  };
  const realSetInterval = global.setInterval; let tick;
  global.setInterval = fn => { tick = fn; return {unref() {}}; };
  auto.watchExits(() => true, id => { launched.push(id); return Promise.resolve(); }, execute);
  global.setInterval = realSetInterval;
  tick(); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  fg = 'com.samsung.tv.csfs';
  tick(); for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.deepEqual(launched, ['GarageHome.launcher']);
  assert.ok(cmds.some(c => /app_launcher -k com\.samsung\.tv\.csfs/.test(c)), 'Samsung Home closed after the fallback');
  console.log('PASS garage autostart: Samsung Home closed after Home and after leaving an app, Autorun switched off once');
})().catch(e => { console.error(e); process.exitCode = 1; });
