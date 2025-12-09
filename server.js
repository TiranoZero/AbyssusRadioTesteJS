// server.js - broadcast controlável por /start-broadcast e /stop-broadcast
const express = require('express');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const audioDir = path.join(__dirname, 'audio');

const playlist = fs.existsSync(audioDir)
  ? fs.readdirSync(audioDir).filter(f => f.toLowerCase().endsWith('.mp3')).map(f => path.join(audioDir, f))
  : [];

console.log('Playlist:', playlist.map(p => path.basename(p)));

const clients = new Set();
const failCounts = new WeakMap();
const attachedListeners = new WeakMap();
const clientEvents = new EventEmitter();

app.use(express.static(path.join(__dirname)));
app.use('/audio', express.static(path.join(__dirname, 'audio'), { index: false }));

app.get('/status', (req, res) => {
  res.json({ listeners: clients.size, broadcasting: !!broadcasting });
});

app.get('/stream', (req, res) => {
  // registro do cliente
  try { req.socket.setKeepAlive(true, 60000); } catch(_) {}
  try { res.setMaxListeners && res.setMaxListeners(0); } catch(_) {}

  res.set({
    'Content-Type': 'audio/mpeg',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  clients.add(res);
  failCounts.set(res, 0);
  attachedListeners.set(res, { drainAttached: false, closeAttached: false });
  console.log(`[${new Date().toISOString()}] novo cliente - total: ${clients.size}`);
  clientEvents.emit('added');

  req.on('close', () => {
    // cleanup listeners do response
    try {
      const flags = attachedListeners.get(res);
      if (flags) {
        if (flags.drainAttached) try { res.removeAllListeners('drain'); } catch(_) {}
        if (flags.closeAttached) try { res.removeAllListeners('close'); } catch(_) {}
      }
    } catch(_) {}
    clients.delete(res);
    try { failCounts.delete(res); attachedListeners.delete(res); } catch(_) {}
    console.log(`[${new Date().toISOString()}] cliente desconectou - total: ${clients.size}`);
  });
});

let broadcasting = false;
let currentStream = null;
let stopRequested = false;

app.post('/start-broadcast', (req, res) => {
  if (broadcasting) {
    console.log('Start solicitado, mas já broadcasting -> ok');
    return res.json({ ok: true, broadcasting: true });
  }
  stopRequested = false;
  broadcasting = true;
  console.log('Start broadcast solicitado -> iniciando loop a partir do começo');
  startBroadcastFrom(0).catch(err => {
    console.error('Erro no broadcast:', err);
    broadcasting = false;
  });
  res.json({ ok: true, broadcasting: true });
});

app.post('/stop-broadcast', (req, res) => {
  if (!broadcasting) return res.json({ ok: true, broadcasting: false });
  console.log('Stop broadcast solicitado -> parando após fechar stream atual');
  stopRequested = true;
  // se ha currentStream, destruí-lo para interromper imediatamente
  if (currentStream) {
    try { currentStream.destroy(); } catch(_) {}
  }
  broadcasting = false;
  res.json({ ok: true, broadcasting: false });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  // não inicia automaticamente; aguarda /start-broadcast
});

/* --- logica do broadcast --- */
async function startBroadcastFrom(indexStart = 0) {
  if (!playlist.length) {
    console.warn('Nenhuma faixa em /audio.');
    broadcasting = false;
    return;
  }
  // começa do índice fornecido (normalmente 0)
  for (let i = indexStart; broadcasting && !stopRequested; i = (i + 1) % playlist.length) {
    const trackPath = playlist[i];
    if (!fs.existsSync(trackPath)) {
      console.warn('Faixa inexistente, pulando:', trackPath);
      continue;
    }
    console.log('=== Tocar:', path.basename(trackPath), '===');

    // espera cliente caso não exista ninguém: pausa até /stream conectar
    if (clients.size === 0) {
      console.log('Sem ouvintes — aguardando conexão para iniciar a faixa...');
      await waitForClient();
      if (!broadcasting || stopRequested) break;
      console.log('Ouvinte chegou — iniciando transmissão.');
    }

    try {
      await broadcastFile(trackPath);
    } catch (err) {
      console.error('Erro transmitindo arquivo:', err);
      // se houve erro e broadcasting ainda true, continua proxima faixa
    }

    if (!broadcasting || stopRequested) break;
    // continua para próxima faixa (loop)
  }
  console.log('Broadcast loop finalizado.');
  broadcasting = false;
  stopRequested = false;
}

function waitForClient() {
  return new Promise(resolve => {
    if (clients.size > 0) return resolve();
    const onAdded = () => { clientEvents.removeListener('added', onAdded); resolve(); };
    clientEvents.on('added', onAdded);
  });
}

function broadcastFile(filePath) {
  return new Promise((resolve, reject) => {
    // chunks menores ajudam compatibilidade
    const stream = fs.createReadStream(filePath, { highWaterMark: 8 * 1024 });
    currentStream = stream;
    console.log('Abrindo readStream para', path.basename(filePath));
    let chunks = 0, bytesSent = 0;
    const MAX_FAILS = 500;

    // se o stream for destruído por stopBroadcast ou erro, tratamos
    stream.on('error', (err) => {
      console.error('ReadStream error:', err && err.code ? err.code : err);
      currentStream = null;
      // rejeita para o loop decidir o que fazer
      reject(err);
    });

    stream.on('end', () => {
      console.log(`Faixa terminou: ${path.basename(filePath)} bytesSent=${bytesSent} chunks=${chunks}`);
      currentStream = null;
      setTimeout(resolve, 200);
    });

    stream.on('data', chunk => {
      chunks++; bytesSent += chunk.length;
      if (chunks === 1) console.log('-> primeiro chunk lido, iniciando envio aos clientes');

      const snapshot = Array.from(clients);
      if (snapshot.length === 0) {
        // pausa e espera um cliente antes de continuar
        stream.pause();
        clientEvents.once('added', () => { try { stream.resume(); } catch(_) {} });
        return;
      }

      for (const res of snapshot) {
        if (!res || res.writableEnded || res.destroyed) {
          clients.delete(res);
          try { failCounts.delete(res); attachedListeners.delete(res); } catch(_) {}
          continue;
        }
        try {
          const ok = res.write(chunk);
          if (!ok) {
            const prev = failCounts.get(res) || 0;
            const now = prev + 1;
            failCounts.set(res, now);

            // anexa listeners apenas uma vez
            const flags = attachedListeners.get(res) || { drainAttached: false, closeAttached: false };
            if (!flags.drainAttached) {
              try { res.once('drain', () => { try { failCounts.set(res, 0); } catch(_) {} }); } catch(_) {}
              flags.drainAttached = true;
            }
            if (!flags.closeAttached) {
              try { res.once('close', () => { try { failCounts.delete(res); attachedListeners.delete(res); } catch(_) {} }); } catch(_) {}
              flags.closeAttached = true;
            }
            attachedListeners.set(res, flags);

            if (now > 0 && now % 100 === 0) console.log(` -> client backpressure (fails=${now})`);
            if (now >= MAX_FAILS) {
              console.log(' -> cliente muito lento — desconectando');
              try {
                const fl = attachedListeners.get(res);
                if (fl && fl.drainAttached) try { res.removeAllListeners('drain'); } catch(_) {}
                if (fl && fl.closeAttached) try { res.removeAllListeners('close'); } catch(_) {}
                res.end();
              } catch(_) {}
              clients.delete(res);
              try { failCounts.delete(res); attachedListeners.delete(res); } catch(_) {}
            }
          } else {
            if ((failCounts.get(res) || 0) > 0) failCounts.set(res, 0);
          }
        } catch (err) {
          clients.delete(res);
          try { failCounts.delete(res); attachedListeners.delete(res); } catch(_) {}
        }
      } 
    });
  }); 
}
