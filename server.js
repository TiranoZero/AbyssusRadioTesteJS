// server.js - inicia o broadcast automaticamente
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

// REMOVE sistema start/stop
let broadcasting = false;
let currentStream = null;
let stopRequested = false;

// SERVIDOR + inicia o broadcast automaticamente
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  
  // inicia a transmissão automaticamente
  if (!broadcasting) {
    broadcasting = true;
    console.log('Iniciando transmissão automaticamente...');
    startBroadcastFrom(0).catch(err => {
      console.error('Erro no broadcast:', err);
      broadcasting = false;
    });
  }
});

/* --- lógica do broadcast --- */

async function startBroadcastFrom(indexStart = 0) {
  if (!playlist.length) {
    console.warn('Nenhuma faixa encontrada na pasta /audio.');
    broadcasting = false;
    return;
  }

  for (let i = indexStart; broadcasting; i = (i + 1) % playlist.length) {
    const trackPath = playlist[i];
    if (!fs.existsSync(trackPath)) {
      console.warn('Faixa inexistente, pulando:', trackPath);
      continue;
    }

    console.log('=== Tocar:', path.basename(trackPath), '===');

    // aguarda um ouvinte antes de tocar
    if (clients.size === 0) {
      console.log('Sem ouvintes — esperando alguém entrar...');
      await waitForClient();
      console.log('Ouvinte entrou — iniciando faixa.');
    }

    try {
      await broadcastFile(trackPath);
    } catch (err) {
      console.error('Erro transmitindo arquivo:', err);
    }
  }
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
    const stream = fs.createReadStream(filePath, { highWaterMark: 8 * 1024 });
    currentStream = stream;

    let chunks = 0, bytesSent = 0;
    const MAX_FAILS = 500;

    stream.on('error', (err) => {
      console.error('ReadStream error:', err);
      currentStream = null;
      reject(err);
    });

    stream.on('end', () => {
      console.log(`Faixa terminou: ${path.basename(filePath)} bytesSent=${bytesSent} chunks=${chunks}`);
      currentStream = null;
      setTimeout(resolve, 200);
    });

    stream.on('data', chunk => {
      chunks++;
      bytesSent += chunk.length;

      const snapshot = Array.from(clients);
      if (snapshot.length === 0) {
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

            const flags = attachedListeners.get(res) || { drainAttached: false, closeAttached: false };

            if (!flags.drainAttached) {
              try { res.once('drain', () => { failCounts.set(res, 0); }); } catch(_) {}
              flags.drainAttached = true;
            }

            if (!flags.closeAttached) {
              try { res.once('close', () => { failCounts.delete(res); attachedListeners.delete(res); }); } catch(_) {}
              flags.closeAttached = true;
            }

            attachedListeners.set(res, flags);

            if (now >= MAX_FAILS) {
              console.log('Cliente lento — desconectando...');
              try { res.end(); } catch(_) {}
              clients.delete(res);
            }

          } else {
            if ((failCounts.get(res) || 0) > 0) failCounts.set(res, 0);
          }

        } catch (_) {
          clients.delete(res);
          failCounts.delete(res);
          attachedListeners.delete(res);
        }
      }
    });
  });
}
