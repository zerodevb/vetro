'use strict';

// Local addition for Garage Home: open the launcher when the TV wakes from standby, and once after
// the service starts (a full boot), as soon as the root agent can launch apps. The TV reports its
// power state ("on" / "standby") on its own local API at 127.0.0.1:8001/api/v2/.

var http = require('http');

var APP_ID = 'GarageHome.launcher';
var POLL_MS = 1000;   // a tiny local request; notices a wake within a second
var GIVE_UP_MS = 3 * 60000;
var CHECK_AFTER_MS = 6000, MAX_TRIES = 3, RETRY_WINDOW_MS = 90000;

// With our Public certificate the installer drops on-boot, so the TV stops Vetro at power-off and never
// starts it again. Approved by the owner (2026-10-22): mark Vetro's own service start-at-boot and
// auto-restart in the TV's app database. Reinstalling resets the flags, so this runs once per service start.
// Original values are kept in /home/owner/share/vetro/startup-backups/vetrotvapp.svc.garage.
var DB = '/opt/dbspace/.pkgmgr_parser.db';
var SELF_START = 'set -e\nmkdir -p /home/owner/share/vetro/startup-backups\n' +
    'b=/home/owner/share/vetro/startup-backups/vetrotvapp.svc.garage\n' +
    'if [ ! -f "$b" ]; then sqlite3 -readonly ' + DB + ' "SELECT app_onboot,app_autorestart FROM package_app_info WHERE app_id=\'vetrotvapp.svc\';" > "$b"; fi\n' +
    'if [ "$(sqlite3 -readonly ' + DB + ' "SELECT app_onboot||app_autorestart FROM package_app_info WHERE app_id=\'vetrotvapp.svc\';")" != "truetrue" ]; then ' +
    'sqlite3 -bail ' + DB + ' "BEGIN IMMEDIATE; UPDATE package_app_info SET app_onboot=\'true\', app_autorestart=\'true\' WHERE app_id=\'vetrotvapp.svc\'; COMMIT;"; fi';
function ensureSelfStart(execute) { return execute(SELF_START, 15000).catch(function () {}); }

// Samsung's Home (the bar over Live TV) is started by the Home key whatever else happens, and then sits behind
// Garage Home using memory. As Vetro's own launcher does, close it a few times after each Home press, since its
// start is slow (0.15, 0.45, 0.9, 1.6 and 2.8 s). One background shell; the worst case is the TV as before.
var SAMSUNG_HOME = 'com.samsung.tv.csfs';
var HOME_GUARD = '( sleep 0.15; app_launcher -k ' + SAMSUNG_HOME + '; sleep 0.3; app_launcher -k ' + SAMSUNG_HOME +
    '; sleep 0.45; app_launcher -k ' + SAMSUNG_HOME + '; sleep 0.7; app_launcher -k ' + SAMSUNG_HOME +
    '; sleep 1.2; app_launcher -k ' + SAMSUNG_HOME + ' ) >/dev/null 2>&1 &';
function homeGuard(execute) { return execute(HOME_GUARD, 5000).catch(function () {}); }

// "Autorun Smart Hub" opens Samsung's Home at every power-on, in front of Garage Home. Approved by the owner
// (2026-10-26): switch it off once, keeping the old value in startup-backups/autorun.garage. Turning it back on
// in the TV's Settings (General > Smart Features) is respected: this only switches it off the first time.
var AUTORUN_KEY = 'db/menu/smart_hub/ontvsetting/auto_start';
var AUTORUN_OFF = 'mkdir -p /home/owner/share/vetro/startup-backups\n' +
    'b=/home/owner/share/vetro/startup-backups/autorun.garage\n' +
    'if [ ! -f "$b" ]; then v=$(vconftool get ' + AUTORUN_KEY + ' 2>/dev/null | sed -n "s/.*value = \\([0-9]*\\).*/\\1/p"); ' +
    '[ -n "$v" ] || exit 0; echo "$v" > "$b"; [ "$v" = 1 ] && vconftool set -f -t int ' + AUTORUN_KEY + ' 0; fi; exit 0';
// Puts the value from before Garage Home back (by hand, or with `node tools/garage-debloat.mjs --restore-autorun`).
var AUTORUN_RESTORE = 'b=/home/owner/share/vetro/startup-backups/autorun.garage\n' +
    '[ -f "$b" ] && vconftool set -f -t int ' + AUTORUN_KEY + ' "$(cat "$b")" && rm -f "$b"; exit 0';
function autorunOff(execute) { return execute(AUTORUN_OFF, 8000).catch(function () {}); }

function powerState(cb) {
    var req = http.get({host: '127.0.0.1', port: 8001, path: '/api/v2/', timeout: 3000}, function (res) {
        var body = '';
        res.on('data', function (c) { body += c; });
        res.on('end', function () {
            try { cb(String(JSON.parse(body).device.PowerState || '').toLowerCase()); } catch (e) { cb(null); }
        });
    });
    req.on('timeout', function () { req.destroy(); });
    req.on('error', function () { cb(null); });
}

// agentReady(): true when root can launch apps. launch(appId): returns a promise.
// foreground(): promise of the app id in front (optional). The TV's own startup (Live TV, Smart Hub) can
// come up after us, so check a few seconds later and try again a couple of times.
function start(agentReady, launch, foreground, execute) {
    var selfStartDone = false;
    function attempt(tries, since) {
        launch(APP_ID).catch(function () {}).then(function () {
            if (!foreground || tries >= MAX_TRIES) return;
            setTimeout(function () {
                if (Date.now() - since > RETRY_WINDOW_MS) return;
                foreground().then(function (id) { if (id && id.indexOf(APP_ID) < 0) attempt(tries + 1, since); }, function () {});
            }, CHECK_AFTER_MS);
        });
    }
    var previous = null, pendingSince = Date.now();   // service start counts as a boot
    var lastTick = Date.now();
    var timer = setInterval(function () {
        // In standby the TV may freeze this service; a long gap between ticks means we just woke up.
        var now = Date.now(), resumed = now - lastTick > 5000;
        lastTick = now;
        if (!selfStartDone && execute && agentReady()) { selfStartDone = true; ensureSelfStart(execute).then(function () { return autorunOff(execute); }); }
        powerState(function (state) {
            if (state === 'on' && (previous === 'standby' || resumed)) pendingSince = Date.now();
            if (state) previous = state;
            if (pendingSince === null) return;
            if (Date.now() - pendingSince > GIVE_UP_MS) { pendingSince = null; return; }
            if (state !== 'on' || !agentReady()) return;
            pendingSince = null;
            attempt(1, Date.now());
        });
    }, POLL_MS);
    if (timer.unref) timer.unref();
    if (execute) watchExits(agentReady, launch, execute);
    return timer;
}

// Leaving an app (Back/Exit) hands control to Samsung's home bar over Live TV. When the app you were in was
// not Garage Home and the TV falls back to the TV viewer / home bar, open Garage Home instead. Choosing Live TV
// or a source from Garage Home does not trigger this, because the previous app was Garage Home itself.
var TV_SIDE = /^(org\.tizen\.tv-viewer|com\.samsung\.tv\.csfs)$/;
var NOT_AN_APP = /^(org\.tizen\.tv-viewer|com\.samsung\.tv\.csfs|com\.samsung\.tv\.coba\.|org\.tizen\.menu|vetrotvapp|com\.samsung\.tv\.(screeneffectorapp|multiscreen|quickpanel)|org\.tizen\.(hbbtv|welcome-mode))/;
var EXIT_CMD = 'vconftool get memory/appfw/current_fullscreen_appid; vconftool get memory/appfw/current_partial_appid';
function watchExits(agentReady, launch, execute) {
    var prev = '', busy = false, lastLaunch = 0;
    var t = setInterval(function () {
        if (busy || !agentReady()) return;
        busy = true;
        execute(EXIT_CMD, 4000).then(function (r) {
            var v = String(r.stdout || '').split('\n').map(function (l) { var m = /value = (\S+)/.exec(l); return m ? m[1] : ''; });
            var full = v[0] || '';
            if (full && full !== prev) {
                var left = prev && !NOT_AN_APP.test(prev) && prev.indexOf(APP_ID) < 0;
                if (left && TV_SIDE.test(full) && Date.now() - lastLaunch > 3000) {
                    lastLaunch = Date.now();
                    launch(APP_ID).catch(function () {}).then(function () { if (full === SAMSUNG_HOME) homeGuard(execute); });
                }
                prev = full;
            }
        }, function () {}).then(function () { busy = false; });
    }, POLL_MS);
    if (t.unref) t.unref();
}

module.exports = {start: start, powerState: powerState, SELF_START: SELF_START, watchExits: watchExits,
    homeGuard: homeGuard, HOME_GUARD: HOME_GUARD, AUTORUN_OFF: AUTORUN_OFF, AUTORUN_RESTORE: AUTORUN_RESTORE};
