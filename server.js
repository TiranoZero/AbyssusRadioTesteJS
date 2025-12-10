/**
 * radio-sync-advanced - servidor que sincroniza novos clientes no mesmo ponto da rádio.
 *
 * Como funciona:
 *  - Lê todos MP3 em /audio
 *  - Extrai duração (segundos) e tamanho bytes de cada faixa (usando music-metadata)
 *  - Mantém um relógio global (radioStartTimestamp)
 *  - Quando cliente conecta, calcula elapsed = (now - radioStart) % totalDuration
 *  - Determina faixa atual e offset (segundos) dentro dela
 *  - Aproxima byteOffset = (offsetSec / durationSec) * fileSize
 *  - Serve stream a partir desse byteOffset e emenda faixas seguintes automaticamente (loop)
 *
 * Limitações:
 *  - Precisão depende de CBR vs VBR. Para melhor precisão use MP3 CBR (re-encode com libmp3lame CBR).
 *  - Pequeno desvio de rede entre clientes é normal (< 200ms).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const mm = require('music-metadata');

const app = express();
const PORT = process.env.PORT || 8080;
const audioDir = path.join(__dirname, 'audio');

if (!fs.existsSync(audioDir)) {
  console.error('Pasta /audio não existe. Crie e coloque arquivos .mp3');
  process.exit(1);
}

let playlist = []; // { file, path, duration (s), size (bytes) }
let totalDuration = 0; // em segundos

// Radio global start (inicia agora). Pode ser ajustado para persistir.
const radioStartTimestamp = Date.now(); // ms

// --- build playlist metadata (async) ---
async function buildPlaylist() {
  const names = fs.readdirSync(audioDir).filter(f => f.toLowerCase().endsWith('.mp3')).sort();
  playlist = [];

  for (const name of names) {
    const p = path.join(audioDir, name);
    const stat = fs.statSync(p);
    let duration = null;
    try {
      // music-metadata tenta extrair a duração (em segundos)
      const meta = await mm.parseFile(p, { duration: true });
      duration = meta.format.duration || null;
    } catch (e) {
      console.warn('Não foi possível ler metadata (duracao) de', name, e.message || e);
    }
    // fallback: se não conseguiu obter duração, estimativa via bitrate não disponível => assume 1s (evita crash)
    if (!duration || Number.isNaN(duration)) {
      console.warn('Duração não encontrada para', name, '- usando estimativa de 1s (recomendo re-encodar).');
      duration = 1;
    }

    playlist.push({
      file: name,
      path: p,
      duration: Number(duration),
      size: stat.size
    });
  }

  totalDuration = playlist.reduce((s, it) => s + it.duration, 0);
  console.log('Playlist carregada:', playlist.map(p => p.file));
  console.log('Total duration (s):', totalDuration.toFixed(2));
}

function getPlaybackPositionNow() {
  const now = Date.now();
  const elapsedMs = now - radioStartTimestamp;
  if (totalDuration <= 0) return { trackIndex: 0, offsetSec: 0 };
  const elapsedSec = (elapsedMs / 1000) % totalDuration; // posição cíclica
  // localizar faixa
  let acc = 0;
  for (let i = 0; i < playlist.length; i++) {
    const dur = playlist[i].duration;
    if (elapsedSec < acc + dur) {
      return { trackIndex: i, offsetSec: elapsedSec - acc };
    }
    acc += dur;
  }
  // fallback
  return { trackIndex: 0, offsetSec: 0 };
}

// calcula byte offset aproximado baseado em proporção (offsetSec / duration) * sizeBytes
function approximateByteOffset(track, offsetSec) {
  if (!track || track.duration <= 0) return 0;
  let frac = offsetSec / track.duration;
  if (frac < 0) frac = 0;
  if (frac > 0.9999) frac = 0.9999;
  return Math.floor(frac * track.size);
}

// stream para um cliente iniciando em um trackIndex e byteOffset
function streamFromPositionForClient(res, startTrackIndex, startByteOffset) {
  let idx = startTrackIndex;
  let startOffset = startByteOffset;
  let destroyed = false;

  // função que cria readStream para a faixa atual (começando em startOffset quando first true)
  function streamCurrentTrack(first = false) {
    if (destroyed) return;
    const track = playlist[idx];
    if (!track) {
      // playlist vazia ou erro
      try { res.end(); } catch (_) {}
      return;
    }
    const start = first ? startOffset : 0;
    const rs = fs.createReadStream(track.path, { start });
    console.log(`[client] streamando ${track.file} startByte=${start} size=${track.size} (idx=${idx})`);

    // on data: escreve diretamente no response
    rs.on('data', chunk => {
      if (destroyed) {
        try { rs.destroy(); } catch(_) {}
        return;
      }
      try {
        const ok = res.write(chunk);
        // ignoramos backpressure por cliente (não compartilhamos stream)
        // se precisar, poderíamos pausar/resume, mas cada client tem próprio stream
        if (!ok) {
          // opcional: aguardar 'drain' - aqui o Node cuida internamente
        }
      } catch (e) {
        console.warn('[client] erro escrevendo chunk -> encerrando client', e && e.message);
        cleanup();
      }
    });

    rs.on('end', () => {
      // próxima faixa
      idx = (idx + 1) % playlist.length;
      // small gap (200ms)
      setTimeout(() => streamCurrentTrack(false), 200);
    });

    rs.on('error', err => {
      console.error('[client] erro readStream', err && err.code);
      // tenta next
      idx = (idx + 1) % playlist.length;
      setTimeout(() => streamCurrentTrack(false), 200);
    });

    // cleanup se client fechar
    res.once('close', () => {
      destroyed = true;
      try { rs.destroy(); } catch(_) {}
    });
  }

  // iniciar
  streamCurrentTrack(true);

  // retorno função para forçar cleanup externo
  return () => {
    destroyed = true;
    try { res.end(); } catch(_) {}
  };
}

// rota stream
app.get('/stream', (req, res) => {
  // headers adequados
  res.set({
    'Content-Type': 'audio/mpeg',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // calcula posição global agora
  const pos = getPlaybackPositionNow();
  const track = playlist[pos.trackIndex];
  const approxByte = approximateByteOffset(track, pos.offsetSec);

  console.log(`[connect] novo cliente -> track=${track.file} trackIndex=${pos.trackIndex} offsetSec=${pos.offsetSec.toFixed(3)} approxByte=${approxByte}`);

  // inicia streaming para esse cliente a partir do byte aproximado
  const stopFn = streamFromPositionForClient(res, pos.trackIndex, approxByte);

  // quando cliente desconectar, cleanup
  req.on('close', () => {
    try { stopFn(); } catch(_) {}
    console.log('[connect] cliente desconectou');
  });
});

// status
app.get('/status', (req, res) => {
  const pos = getPlaybackPositionNow();
  res.json({
    listeners: undefined, // opcional: você pode manter set de clients se quiser contagem
    now: {
      trackIndex: pos.trackIndex,
      track: playlist[pos.trackIndex] ? playlist[pos.trackIndex].file : null,
      offsetSec: pos.offsetSec
    },
    totalDuration
  });
});

// inicialização
(async () => {
  await buildPlaylist();
  if (playlist.length === 0) {
    console.error('Nenhuma faixa encontrada em /audio. Coloque arquivos .mp3 e reinicie.');
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log('Radio start timestamp (ms):', radioStartTimestamp);
    console.log('Acesse /stream para ouvir — novos clientes entram sincronizados.');
  });
})();
