const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000; // O Render vai preencher process.env.PORT automaticamente

// CONFIGURAÇÃO DA RÁDIO
const AUDIO_DIR = path.join(__dirname, 'audio');
const BITRATE = 128000; // 128kbps (Padrão mais comum)
const SAMPLE_RATE = 44100; 

// Cálculo do "Pulo do Gato" (Controle de Fluxo)
// 128kbps = 128000 bits / 8 = 16000 bytes por segundo
const BYTES_PER_SECOND = BITRATE / 8;
// Vamos enviar pedaços a cada 100ms (0.1s) para não sobrecarregar
const CHUNK_SIZE = BYTES_PER_SECOND * 0.1; // 1600 bytes por envio
const TICK_INTERVAL = 100; // 100ms

let clients = [];
let currentSongIndex = 0;
let bufferQueue = Buffer.alloc(0); // Buffer temporário

// Função para listar músicas
function getPlaylist() {
    try {
        return fs.readdirSync(AUDIO_DIR).filter(file => file.endsWith('.mp3'));
    } catch (e) {
        return [];
    }
}

// Lógica de Broadcast (Transmissão)
function broadcast(chunk) {
    for (let i = clients.length - 1; i >= 0; i--) {
        const client = clients[i];
        try {
            client.write(chunk);
        } catch (err) {
            // Se der erro ao enviar, remove o cliente
            console.log('Cliente desconectado (erro de escrita)');
            clients.splice(i, 1);
        }
    }
}

function playLoop() {
    const playlist = getPlaylist();

    if (playlist.length === 0) {
        console.log("Pasta 'audio' vazia. Tentando novamente em 5s...");
        setTimeout(playLoop, 5000);
        return;
    }

    const songName = playlist[currentSongIndex];
    const songPath = path.join(AUDIO_DIR, songName);
    
    console.log(`\n>>> Tocando: ${songName}`);

    // Abrimos o arquivo em modo de leitura baixo nível
    fs.open(songPath, 'r', (err, fd) => {
        if (err) {
            console.error("Erro ao abrir arquivo:", err);
            goToNextSong(playlist);
            return;
        }

        const buffer = Buffer.alloc(CHUNK_SIZE);
        
        // Função recursiva que simula o "Clock" da rádio
        const streamInterval = setInterval(() => {
            fs.read(fd, buffer, 0, CHUNK_SIZE, null, (err, bytesRead) => {
                if (err || bytesRead === 0) {
                    // Fim da música ou erro
                    clearInterval(streamInterval);
                    fs.close(fd, () => {});
                    goToNextSong(playlist);
                    return;
                }

                // Se leu menos que o tamanho do chunk (finalzinho da música), corta o buffer
                const dataToSend = (bytesRead < CHUNK_SIZE) 
                    ? buffer.subarray(0, bytesRead) 
                    : buffer;

                // Envia para todos os ouvintes conectados
                broadcast(dataToSend);
            });
        }, TICK_INTERVAL); // Executa a cada 100ms
    });
}

function goToNextSong(playlist) {
    currentSongIndex = (currentSongIndex + 1) % playlist.length;
    // Pequeno delay para garantir que o buffer do cliente não encavale
    setTimeout(playLoop, 100); 
}

// Endpoint da Rádio
app.get('/stream', (req, res) => {
    // Cabeçalhos para forçar o navegador a tratar como stream de áudio
    res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });

    console.log('Novo ouvinte conectado!');
    clients.push(res);

    // Quando o ouvinte fecha a aba
    req.on('close', () => {
        clients = clients.filter(c => c !== res);
        console.log('Ouvinte saiu.');
    });
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', ()=> {
    console.log(`Rádio ON em: https://lovesong.theabyssus.shop/stream`);
    console.log(`Pasta de áudio: ${AUDIO_DIR}`);
    console.log(`IMPORTANTE: Use MP3s de ${BITRATE/1000}kbps`);
    
    playLoop(); // Inicia a transmissão automaticamente
});
