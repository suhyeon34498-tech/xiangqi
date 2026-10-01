/* Pikafish WASM Worker —— 结构参照 obsidian-xiangqi 插件的已验证实现：
   wasm/data transfer 进来 → Pikafish(Module).then(pf => send uci)，
   输出走 print + read_stdout 双通道（去重）。
   关键约束：引擎输出回调里绝不能同步重入 send_command（会重入 wasm 炸掉输出缓冲），
   所有回复命令一律走 queueCmd 宏任务队列。
   坐标系：file 'a'..'i' = x 0..8，rank 9..0 = y 0..9 */
'use strict';

var _pf = null;
var pending = null;          // {id} 正在搜索的请求
var lastInfoPost = 0;
var lastLine = null;

self.addEventListener('error', function (e) {
  self.postMessage({ type: 'error', message: 'worker error: ' + (e.message || e.filename) });
});
console.log = function () {};
console.warn = function () {};

var cmdQueue = [];
var cmdTimer = null;
function queueCmd(cmd) {
  cmdQueue.push(cmd);
  if (!cmdTimer) {
    cmdTimer = setTimeout(function () {
      cmdTimer = null;
      var cmds = cmdQueue.splice(0);
      for (var i = 0; i < cmds.length; i++) {
        try { _pf.send_command(cmds[i]); } catch (e) {}
      }
    }, 0);
  }
}

function toMove(mv) {
  if (!mv || mv === '(none)') return null;
  var x0 = mv.charCodeAt(0) - 97, y0 = 9 - (+mv[1]);
  var x1 = mv.charCodeAt(2) - 97, y1 = 9 - (+mv[3]);
  if ([x0, y0, x1, y1].some(function (v) { return Number.isNaN(v) || v < 0; })) return null;
  return { from: { x: x0, y: y0 }, to: { x: x1, y: y1 } };
}

function handleLine(line) {
  if (!line) return;
  if (line === lastLine) return;    // print/read_stdout 双通道去重
  lastLine = line;
  if (line.indexOf('uciok') === 0) {
    queueCmd('setoption name Hash value 64');
    queueCmd('isready');
    return;
  }
  if (line === 'readyok') {
    self.postMessage({ type: 'ready' });
    return;
  }
  if (line.indexOf('info') === 0) {
    var now = Date.now();
    if (now - lastInfoPost < 300) return;      // 节流进度消息
    var dm = line.match(/\bdepth (\d+)/);
    var sm = line.match(/\bscore (cp|mate) (-?\d+)/);
    var nm = line.match(/\bnodes (\d+)/);
    if (dm && sm) {
      lastInfoPost = now;
      self.postMessage({
        type: 'info',
        depth: +dm[1],
        score: +sm[2],
        mate: sm[1] === 'mate',
        nodes: nm ? +nm[1] : 0,
      });
    }
    return;
  }
  if (line.indexOf('bestmove') === 0) {
    var mv = line.split(/\s+/)[1];
    var p = pending; pending = null;
    self.postMessage({ type: 'bestmove', id: p && p.id, move: toMove(mv) });
  }
}

self.onmessage = function (e) {
  var msg = e.data;
  try {
    if (msg && msg.cmd === 'init') {
      if (_pf) { self.postMessage({ type: 'ready' }); return; }
      importScripts('pikafish.js');
      var Module = {};
      Module.wasmBinary = new Uint8Array(msg.wasm);
      Module.getPreloadedPackage = function () { return msg.data; };
      Module.print = function (text) {
        if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
        handleLine(String(text));
      };
      Module.printErr = function () {};
      Pikafish(Module).then(function (pf) {
        _pf = pf;
        _pf.read_stdout = function (text) { handleLine(String(text)); };
        _pf.send_command('uci');
      }).catch(function (err) {
        self.postMessage({ type: 'error', message: '初始化失败: ' + String(err && err.message || err) });
      });
    } else if (!_pf) {
      self.postMessage({ type: 'error', message: '引擎尚未就绪' });
    } else if (msg && msg.cmd === 'search') {
      pending = { id: msg.id };
      _pf.send_command('position fen ' + msg.fen);
      _pf.send_command('go movetime ' + msg.movetime);
    } else if (msg && msg.cmd === 'stop') {
      _pf.send_command('stop');
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
