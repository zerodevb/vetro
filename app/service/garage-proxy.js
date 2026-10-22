'use strict';

// Local addition for Garage Home / Garage Player: fetch a playlist or EPG for a TV app when the
// provider doesn't allow cross-origin requests. Streams the response through unchanged.
// Only http(s), no loopback/link-local targets, redirects followed (max 5), 30 s idle timeout.

var http = require('http');
var https = require('https');
var url = require('url');

var BLOCKED_HOST = /^(localhost|127\.|0\.0\.0\.0|169\.254\.|\[?::1\]?$|\[?fe80:)/i;
var MAX_REDIRECTS = 5;

function check(target) {
    var u;
    try { u = url.parse(target); } catch (e) { return null; }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
    if (BLOCKED_HOST.test(u.hostname)) return null;
    return u;
}

function fail(res, code, message) {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(code, {'content-type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': 'null', 'Vary': 'Origin'});
    res.end(JSON.stringify({error: message}));
}

function handle(req, res) {
    var query = url.parse(req.url, true).query;
    var u = check(query.url);
    if (!u) return fail(res, 400, 'Only http and https addresses on the internet can be fetched');
    var hops = 0;
    (function get(target) {
        var client = target.protocol === 'https:' ? https : http;
        var upstream = client.get({
            protocol: target.protocol, hostname: target.hostname, port: target.port, path: target.path,
            headers: {'User-Agent': query.ua || 'GaragePlayer/1.0', 'Accept': '*/*'}
        }, function (up) {
            if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location) {
                up.resume();
                var next = check(url.resolve(url.format(target), up.headers.location));
                if (!next || ++hops > MAX_REDIRECTS) return fail(res, 502, 'Too many or unsafe redirects');
                return get(next);
            }
            var headers = {'Access-Control-Allow-Origin': 'null', 'Vary': 'Origin',
                'content-type': up.headers['content-type'] || 'application/octet-stream'};
            if (up.headers['content-length']) headers['content-length'] = up.headers['content-length'];
            res.writeHead(up.statusCode, headers);
            up.pipe(res);
        });
        upstream.setTimeout(30000, function () { upstream.abort(); fail(res, 504, 'The server did not answer'); });
        upstream.on('error', function (e) { fail(res, 502, String(e.message || e)); });
        req.on('close', function () { upstream.abort(); });
    })(u);
}

module.exports = {handle: handle, check: check};
