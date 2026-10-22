'use strict';

// Local addition for Garage Home: "watch" mode listens to EVERY remote input at once without grabbing
// any of them, so keys still reach the TV normally. After a reboot the Bluetooth remote can reappear as
// a different /dev/input/eventN (or twice); refresh() follows those changes.

var DEBOUNCE_MS = 600;

function create(Bridge, execute, onKey) {
    var bridges = [], nodes = [], starting = null, last = {};
    var probe = new Bridge(execute, function () {});

    function connected() { return bridges.some(function (b) { return b.status().policy.connected; }); }
    function stop() { bridges.forEach(function (b) { b.stop(); }); bridges = []; nodes = []; }

    function handle(event) {
        if (!event || event.action !== 'down') return;
        // The same press can show up on two nodes of one remote: act once.
        var now = Date.now();
        if (last[event.code] && now - last[event.code] < DEBOUNCE_MS) return;
        last[event.code] = now;
        onKey(event);
    }

    function start(list) {
        if (starting) return starting;
        starting = (list ? Promise.resolve(list) : probe.inventory()).then(function (devices) {
            stop();
            var chosen = devices.filter(function (d) { return d.selectable; });
            if (!chosen.length) throw new Error('no physical remote devices found');
            bridges = chosen.map(function () { return new Bridge(execute, handle); });
            nodes = chosen.map(function (d) { return d.node; }).sort();
            return Promise.all(chosen.map(function (d, i) {
                return bridges[i].start(d.node, 'observe', []).catch(function (e) { return {error: e.message}; });
            }));
        }).then(function () {
            if (!connected()) throw new Error('remote listeners did not connect');
            return status();
        }).then(function (s) { starting = null; return s; }, function (e) { starting = null; throw e; });
        return starting;
    }

    // Restart when nothing listens any more or the set of remote inputs changed.
    function refresh() {
        if (starting) return starting;
        return probe.inventory().then(function (devices) {
            var now = devices.filter(function (d) { return d.selectable; }).map(function (d) { return d.node; }).sort();
            if (connected() && now.join() === nodes.join()) return status();
            return start(devices);
        });
    }

    function status() {
        var events = [];
        bridges.forEach(function (b) { events = events.concat(b.status().events || []); });
        events.sort(function (a, b) { return (a.sequence || 0) - (b.sequence || 0); });
        return {policy: {mode: 'watch', nodes: nodes, connected: connected(), blocked: []}, events: events.slice(-30), error: null};
    }

    return {start: start, stop: stop, refresh: refresh, status: status, connected: connected};
}

module.exports = {create: create};
