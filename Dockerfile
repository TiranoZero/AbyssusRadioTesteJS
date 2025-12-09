# Imagem base com Node + FFmpeg já disponível
FROM jrottenberg/ffmpeg:4.4-ubuntu

# Instala Node.js (versão 18)
RUN apt-get update && \
    apt-get install -y curl gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g npm@latest

# Define diretório
WORKDIR /app

# Copia arquivos
COPY . .

# Instala dependências
RUN npm install

# Porta usada pelo Render
EXPOSE 8080

# Comando principal
CMD ["npm", "start"]
