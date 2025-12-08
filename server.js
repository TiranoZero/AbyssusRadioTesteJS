const express = require('express');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const app = express();
const PORT = process.env.PORT || 8080;

const playlist = fs.existsSync(audioDir)
  ? fs.readdirSync(audioDir).filter(f => f.toLowerCase().endsWith('.mp3')).map(f => path.join(audioDir, f))
  : [];

const clients = new Set();
const clientEvents = new EventEmitter();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/stream', (req, res) => {
  // botei keep-alive
  res.set({
    'Content-Type': 'audio/mpeg',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive'
  });

  // opcional para alguns ambientes
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  clients.add(res);
  console.log('Novo ouvinte - Total: ', clients.size);
  // sinaliza que temos cliente(s)
  clientEvents.emit('added');

  // quando o cliente fecha a conexão
  req.on('close', () => {
    clients.delete(res);
    console.log('Ouvinte desconectado - total: ', clients.size);
  });
});

app.get('/status', (req, res) => {
  res.json({ listeners: clients.size });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  startBroadcastLoop();
});

async function startBroadcastLoop() {
  while (true) {
    for (const trackPath of playlist) {
      try {
        console.log('Próxima faixa: ', path.basename(trackPath));

        // se não houver ouvinte aguarda até um conectar
        if (clients.size === 0) {
          console.log('Nenhum ouvinte. Aguardando cliente conectar...');
          await waitForClient();
          console.log('Cliente conectado. Iniciando transmissão.');
        }

        await streamFileToClients(trackPath);
      } catch (err) {
        console.error('Erro ao tocar: ', trackPath, err);
      }
    }
    console.log('Fim da playlist - Reiniciando loop');
  }
}

function waitForClient() {
  return new Promise(resolve => {
    // se ja tem cliente resolve imediatamente
    if (clients.size > 0) return resolve();
    // caso contrário aguarda o evento added
    const onAdded = () => {
      clientEvents.removeListener('added', onAdded);
      resolve();
    };
    clientEvents.on('added', onAdded);
  });
}

function streamFileToClients(filePath) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);

    stream.on('error', err => {
      reject(err);
    });

    stream.on('end', () => {
      // pequeno gap entre faixas
      setTimeout(resolve, 200);
    });

    stream.on('data', chunk => {
      // escreve o chunk para cada cliente
      for (const res of clients) {
        // se o socket já estiver fechado, remove
        if (res.writableEnded || res.destroyed) {
          clients.delete(res);
          continue;
        }

        const ok = res.write(chunk);
        if (!ok) {
          // backpressure: se algum cliente retornar false, pausamos o stream
          // e esperamos pelo primeiro drain para retomar
          // registramos um listener único de drain
          stream.pause();

          const onDrain = () => {
            // remover este listener de todos os clientes se houve
            for (const r of clients) {
              try { r.removeListener('drain', onDrain); } catch (_) {}
            }
            // retoma o stream
            try { stream.resume(); } catch (_) {}
          };

          for (const r of clients) {
            try { r.once('drain', onDrain); } catch (_) {}
          }
          //interrompe o loop for-of (os chunks já foram escritos para os que aceitaram)
          break;
        }
      }
    });
  });
}
