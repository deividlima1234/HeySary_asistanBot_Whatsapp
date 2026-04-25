# Usa la imagen oficial de Node.js ligera basada en Debian
FROM node:18-bullseye-slim

# Instalar dependencias necesarias para Chrome/Puppeteer en entorno Linux
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Evitar que Puppeteer descargue su propio Chromium, usaremos el del sistema operativo que acabamos de instalar
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Configuración del entorno de Node
ENV NODE_ENV=production

# Crear directorio de la aplicación
WORKDIR /usr/src/app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar las librerías del bot
RUN npm install

# Copiar el código fuente
COPY . .

# Exponer el puerto del API Gateway
EXPOSE 3000

# Comando para iniciar el bot
CMD ["npm", "start"]
