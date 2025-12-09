// server.js - Rádio com FFmpeg: um stream contínuo (todos ouvintes sincronizados)
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 8080;
const audioDir = path.join(__dirname, 'audio');
const playlistFile = path.join(__dirname, 'playlist.txt');

let ffmpeg = null;
let clients = new Set();
let restarting = false;

// --- util: monta playlist.txt com os mp3 da pasta /audio (ordem alfabética) ---
function buildPlaylistTxt() {
  if (!fs.existsSync(audioDir)) {
    console.warn('Pasta /audio não encontrada. Crie-a e adicione MP3s.');
    fs.writeFileSync(playlistFile, '');
    return;
  }
  const mp3s = fs.readdirSync(audioDir)
    .filter(f => f.toLowerCase().endsWith('.mp3'))
    .sort()
    .map(f => `file '${path.join(audioDir, f).replace(/\\/g, "/")}'`);
  fs.writeFileSync(playlistFile, mp3s.join('\n'), 'utf8');
  console.log('playlist.txt atualizada — faixas:', mp3s.length);
}

// --- inicia ffmpeg que concatena playlist.txt em loop e envia mp3 para stdout ---
function startFfmpeg() {
  if (ffmpeg) return;
  if (!fs.existsSync(playlistFile) || fs.readFileSync(playlistFile, 'utf8').trim() === '') {
    console.error('playlist.txt vazia — não foi possível iniciar o ffmpeg.');
    return;
  }

  // ffmpeg vai ler o arquivo de concat e fazer loop infinito com -stream_loop -1 via concat demuxer não aceita stream_loop
  // solução: usar -re -f concat -safe 0 -i playlist.txt -codec:a libmp3lame -b:a 128k -f mp3 pipe:1
  // e quando ffmpeg terminar, reiniciamos. Para loop contínuo confiável, reiniciamos ffmpeg no 'close'.
  console.log('Iniciando FFmpeg (gera MP3 contínuo)...');

  ffmpeg = spawn('ffmpeg', [
    '-re',
    '-f', 'concat',
    '-safe', '0',
    '-i', playlistFile,
    '-codec:a', 'libmp3lame',
    '-b:a', '128k',
    '-f', 'mp3',
    'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'inherit'] });

  ffmpeg.stdout.on('data', chunk => {
    // reencaminha bytes para todos os clients conectados
    for (const res of Array.from(clients)) {
      try {
        const ok = res.write(chunk);
        if (!ok) {
          // se write retorna false, o socket está em backpressure; deixamos que o handler 'drain' cuide
          // mas para segurança, se demorar muito, o cliente será removido por timeout/clean
        }
      } catch (_) {
        cleanupClient(res);
      }
    }
  });

  ffmpeg.on('error', err => {
    console.error('FFmpeg error:', err);
  });

  ffmpeg.on('close', (code, sig) => {
    console.warn(`FFmpeg finalizou (code=${code}, sig=${sig}). Reiniciando em 1s...`);
    ffmpeg = null;
    if (!restarting) {
      restarting = true;
      setTimeout(() => { restarting = false; startFfmpeg(); }, 1000);
    }
  });
}

// --- encerra ffmpeg se existir ---
function stopFfmpeg() {
  if (!ffmpeg) return;
  try { ffmpeg.kill('SIGTERM'); } catch(_) {}
  ffmpeg = null;
}

// --- cleanup de cliente ---
function cleanupClient(res) {
  try { res.end(); } catch(_) {}
  clients.delete(res);
}

// --- endpoints ---
app.use(express.static(path.join(__dirname)));
app.use('/audio', express.static(audioDir, { index: false }));

app.get('/status', (req, res) => {
  res.json({ listeners: clients.size, ffmpeg: !!ffmpeg });
});

app.get('/stream', (req, res) => {
  // Cabeçalhos para stream MP3 contínuo
  res.set({
    'Content-Type': 'audio/mpeg',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // adiciona cliente
  clients.add(res);
  console.log(`[${new Date().toISOString()}] novo cliente — total: ${clients.size}`);

  // remove cliente quando desconectar
  req.on('close', () => {
    clients.delete(res);
    console.log(`[${new Date().toISOString()}] cliente desconectou — total: ${clients.size}`);
  });
});

// --- inicialização ---
buildPlaylistTxt();
startFfmpeg();

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log('Abra /stream para ouvir. Todos os ouvintes ouvirão o mesmo ponto do stream.');
});

// --- (opcional) watcher: se a pasta /audio mudar, atualiza playlist e reinicia ffmpeg ---
fs.watch(audioDir, { persistent: false }, (evt, filename) => {
  try {
    console.log('Mudança detectada em /audio — rebuild playlist e reinicio ffmpeg.');
    buildPlaylistTxt();
    // reinicia ffmpeg para carregar a nova playlist
    if (ffmpeg) {
      stopFfmpeg();
      setTimeout(startFfmpeg, 800);
    } else {
      startFfmpeg();
    }
  } catch (e) {
    console.error('Erro no watch audioDir:', e);
  }
});
