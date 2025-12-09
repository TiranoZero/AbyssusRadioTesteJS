# Base com FFmpeg + Ubuntu
FROM jrottenberg/ffmpeg:4.4-ubuntu

# Instalar Node.js 20
RUN apt-get update && \
    apt-get install -y curl gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g npm@latest

# Diretório da aplicação
WORKDIR /app

# Copia arquivos da rádio
COPY package.json .
COPY server.js .
COPY index.html .
COPY audio ./audio

# Instala dependências
RUN npm install

# Porta usada pelo Render
EXPOSE 8080

# Executar rádio
CMD ["npm", "start"]
