const express = require('express')
const fs = require('fs')
const path = require('path');
const listeners = require('process');

const app = express();
const PORT = process.env.PORT || 8080;

const playlist = [
'faixa-4.mp3',
'faixa-6.mp3',
'faixa-8.mp3',
'faixa-9.mp3'
].map(f => path.join(__dirname, 'audio', f));

const clients = new Set();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/stream', (req, res) => {
    res.set({
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache'
    });

    res.flushHeaders?.();

    clients.add(res);
    console.log('Novo ouvinte - Total: ',clients.size)

    req.on('close', () => {
        clients.delete(res);
        console.log('Ouvinte desconectados - total: ', clients.size)
    });
});

app.get('/status', (req, res) => {
    res.join({listeners: clients.size});
});

app.listen(PORT, ()=>{
    console.log(`Servidor Rodando em http:/localhost:${PORT}`);
    startBroadcastloop();
});

async function startBroadcastloop() {
    while (true) {
        for (const trackPath of playlist){
            try {
                console.log('Tocando: ', path.basename(trackPath));
                await streamFileToClients(trackPath);
            } catch (err) {
                console.error('Erro ao tocar: ', trackPath, err)
            }
        }
        console.log('Fim da playlist - Reiniciando loop');
    }
}

function streamFileToClients(filePath) {
    return new Promise((resolve, reject) =>{
        const stream = fs.createReadStream(filePath);
        stream.on('error', err => {
            reject(err);
        });

        stream.on('end', () => {
            setTimeout(resolve, 200);
        });
        stream.on('data', chunk =>{
            for (const res of clients){

                const ok = res.write(chunk);
                if (!ok){
                    res.once('drain', () => {
                        
                    })
                }
            }
        })
    })    
}
