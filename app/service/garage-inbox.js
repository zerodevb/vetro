'use strict';

// Local addition for Garage Player: add a playlist from a phone. Garage Player shows a QR code to
// /garage/setup?code=NNNN; the phone posts the playlist here; Garage Player (opaque origin) collects it
// by its code. Items expire after 10 minutes and are handed out once.

var url = require('url');

var pending = {};
var TTL = 10 * 60000;

function json(res, code, body, cors) {
    var headers = {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'};
    if (cors) { headers['Access-Control-Allow-Origin'] = 'null'; headers.Vary = 'Origin'; }
    res.writeHead(code, headers);
    res.end(JSON.stringify(body));
}
function sweep() { var now = Date.now(); Object.keys(pending).forEach(function (k) { if (now - pending[k].at > TTL) delete pending[k]; }); }
function web(s) { return typeof s === 'string' && /^https?:\/\/\S+$/i.test(s.trim()) && s.length < 4000; }
function text(s, max) { return typeof s === 'string' ? s.trim().slice(0, max) : ''; }

function validate(p) {
    if (!p || !/^\d{4}$/.test(String(p.code))) throw Error('Enter the 4-digit code shown on the TV');
    var item = {type: p.type === 'xtream' ? 'xtream' : 'm3u', name: text(p.name, 60) || 'Playlist'};
    if (item.type === 'xtream') {
        if (!web(p.server)) throw Error('The server must start with http:// or https://');
        item.server = p.server.trim(); item.user = text(p.user, 200); item.pass = text(p.pass, 200);
        if (!item.user || !item.pass) throw Error('Enter the username and password');
    } else {
        if (!web(p.url)) throw Error('The playlist link must start with http:// or https://');
        item.url = p.url.trim();
    }
    if (p.epg && web(p.epg)) item.epg = p.epg.trim();
    return item;
}

function post(req, res, readJsonBody) {
    readJsonBody(req, res, function (p) {
        try {
            sweep();
            if (Object.keys(pending).length > 20) throw Error('Too many pending playlists; try again in a few minutes');
            pending[String(p.code)] = {at: Date.now(), item: validate(p)};
            json(res, 200, {ok: true});
        } catch (e) { json(res, 400, {ok: false, error: e.message}); }
    });
}

// TV apps send an opaque "null" origin, or (apps allowed to reach any host) no origin at all;
// Garage Player marks its requests with X-Garage-App so a plain browser can't pass.
function fromTvApp(req) {
    var h = req.headers || {};
    return h.origin === 'null' || (!h.origin && h['x-garage-app'] === '1');
}

function collect(req, res) {
    if (!fromTvApp(req)) return json(res, 403, {error: 'TV apps only'});
    sweep();
    var code = String(url.parse(req.url, true).query.code || ''), entry = pending[code];
    if (entry) delete pending[code];
    json(res, 200, {item: entry ? entry.item : null}, true);
}

function page(req, res) {
    var code = String(url.parse(req.url, true).query.code || '').replace(/\D/g, '').slice(0, 4);
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
    res.end(PAGE.replace('__CODE__', code));
}

var PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>Garage Player setup</title><style>' +
':root{--night:#0f2326;--deep:#163a3d;--deep2:#1d4a4d;--teal:#0e968a;--mint:#9fe6dc;--chalk:#eef5f4;--muted:#8fa6a8}' +
'*{box-sizing:border-box}body{margin:0;background:var(--night);color:var(--chalk);font:16px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;padding:24px 16px 48px}' +
'main{max-width:520px;margin:0 auto}.mark{font-size:28px;letter-spacing:-.5px}.mark b{font-weight:800}.mark span{font-weight:300;color:var(--mint)}' +
'h1{font-size:20px;font-weight:600;margin:18px 0 4px}p{color:var(--muted);margin:0 0 20px}label{display:block;margin:14px 0 6px;color:var(--muted);font-size:14px}' +
'input,textarea{width:100%;padding:12px 14px;border:0;border-radius:12px;background:var(--deep);color:var(--chalk);font:inherit}textarea{min-height:110px;resize:vertical}' +
'input:focus,textarea:focus{outline:2px solid var(--mint)}.tabs{display:flex;background:var(--deep);border-radius:12px;padding:4px;margin-top:8px}' +
'.tabs button{flex:1;border:0;border-radius:9px;padding:10px;background:none;color:var(--muted);font:inherit;font-weight:600}.tabs button.on{background:var(--mint);color:var(--night)}' +
'.send{width:100%;margin-top:24px;padding:14px;border:0;border-radius:14px;background:var(--mint);color:var(--night);font:inherit;font-weight:700;font-size:17px}' +
'.msg{margin-top:16px;padding:12px 14px;border-radius:12px;background:var(--deep2)}.msg.err{background:#4a1d1d}[hidden]{display:none}' +
'</style></head><body><main><div class="mark"><b>garage</b><span>player</span></div>' +
'<h1>Add a playlist to your TV</h1><p>Paste your playlist here; your TV asks you to confirm.</p>' +
'<form id="f"><label for="code">Code on the TV</label><input id="code" inputmode="numeric" maxlength="4" value="__CODE__" required>' +
'<div class="tabs"><button type="button" class="on" data-t="m3u">M3U link</button><button type="button" data-t="xtream">Xtream login</button></div>' +
'<label for="name">Name</label><input id="name" placeholder="e.g. My TV">' +
'<div id="m3u"><label for="url">Playlist link</label><textarea id="url" placeholder="https://…/playlist.m3u"></textarea></div>' +
'<div id="xt" hidden><label for="server">Server</label><input id="server" placeholder="http://server:port" inputmode="url">' +
'<label for="user">Username</label><input id="user" autocapitalize="off"><label for="pass">Password</label><input id="pass" type="password"></div>' +
'<label for="epg">EPG link (optional)</label><input id="epg" placeholder="https://…/guide.xml.gz" inputmode="url">' +
'<button class="send">Send to TV</button><div class="msg" id="msg" hidden></div></form></main><script>' +
'var t="m3u",$=function(i){return document.getElementById(i)};' +
'document.querySelectorAll(".tabs button").forEach(function(b){b.onclick=function(){t=b.dataset.t;document.querySelectorAll(".tabs button").forEach(function(x){x.classList.toggle("on",x===b)});$("m3u").hidden=t!=="m3u";$("xt").hidden=t!=="xtream";}});' +
'$("f").onsubmit=function(e){e.preventDefault();var m=$("msg");m.hidden=false;m.className="msg";m.textContent="Sending…";' +
'fetch("/garage/inbox",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:$("code").value,type:t,name:$("name").value,url:$("url").value,server:$("server").value,user:$("user").value,pass:$("pass").value,epg:$("epg").value})})' +
'.then(function(r){return r.json()}).then(function(d){if(!d.ok)throw Error(d.error);m.textContent="Sent. Confirm on your TV.";}).catch(function(err){m.className="msg err";m.textContent=err.message||"Sending failed";});};' +
'</script></body></html>';

module.exports = {page: page, post: post, collect: collect, validate: validate, fromTvApp: fromTvApp};
