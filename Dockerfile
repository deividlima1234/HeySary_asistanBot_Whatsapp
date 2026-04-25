# Usa la imagen oficial de Node.js versión 20 (Requerimiento de Baileys)
FROM node:20-bullseye-slim

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
