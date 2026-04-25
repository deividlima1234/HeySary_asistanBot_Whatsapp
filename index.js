require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Client, RemoteAuth, LocalAuth } = require('whatsapp-web.js');
const { PostgresStore } = require('wwebjs-postgres');
const { Pool } = require('pg');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BEARER_TOKEN = process.env.BEARER_TOKEN;

// URL de la base de datos PostgreSQL (proporcionada por el usuario en .env)
const DATABASE_URL = process.env.DATABASE_URL;

// Estado del cliente
let isReady = false;
let client;

if (DATABASE_URL) {
    // Modo Nube (Render + Postgres)
    console.log("Activando RemoteAuth con PostgreSQL...");
    const pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    const store = new PostgresStore({ pool: pool });

    client = new Client({
        authStrategy: new RemoteAuth({
            store: store,
            backupSyncIntervalMs: 300000 // Respaldo cada 5 min
        }),
        puppeteer: {
            // Render necesita executablePath si instalamos chromium por Docker
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        }
    });

    client.on('remote_session_saved', () => {
        console.log('Sesión de WhatsApp guardada en PostgreSQL exitosamente.');
    });

} else {
    // Modo Local Normal (Para testing sin Postgres)
    console.log("No se detectó DATABASE_URL. Iniciando en Modo LocalAuth...");
    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        }
    });
}

client.on('qr', (qr) => {
    // Genera el código QR en la terminal
    qrcode.generate(qr, { small: true });
    console.log('Escanea el código QR con tu aplicación de WhatsApp.');
});

client.on('ready', () => {
    console.log('Cliente de WhatsApp está listo!');
    isReady = true;
});

client.on('disconnected', (reason) => {
    console.log('Cliente desconectado: ', reason);
    isReady = false;
});

client.initialize();

// Middleware de Autenticación
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token no proporcionado o inválido' });
    }

    const token = authHeader.split(' ')[1];
    if (token !== BEARER_TOKEN) {
        return res.status(403).json({ error: 'Acceso denegado' });
    }

    next();
};

// Endpoint: Estado del servidor (No requiere token para que el asistente pueda verificar rápido)
app.get('/api/status', (req, res) => {
    res.json({
        server: 'online',
        whatsapp_ready: isReady
    });
});

// Endpoint: Enviar Mensaje
app.post('/api/messages/send', authMiddleware, async (req, res) => {
    if (!isReady) {
        return res.status(503).json({ error: 'Cliente de WhatsApp no está listo todavía' });
    }

    const { to, message } = req.body;
    console.log(`\n[⏳ ENCOLANDO] Para: ${to}`);

    if (!to || !message) {
        return res.status(400).json({ error: 'Faltan parámetros requeridos: "to" o "message"' });
    }

    // Asegurarse de que el número tenga el sufijo correcto para chats directos (y no grupos)
    // El formato esperado es "numero@c.us" (ejemplo: 521xxxxxxxxxx@c.us)
    let chatId = to;
    if (!chatId.includes('@')) {
        chatId = `${chatId}@c.us`;
    }

    if (chatId.endsWith('@g.us')) {
        return res.status(400).json({ error: 'El envío a grupos no está permitido en este momento.' });
    }

    try {
        const chat = await client.getChatById(chatId);

        // --- Estrategia Anti-Baneo ---
        // 1. Simular estado "escribiendo"
        await chat.sendStateTyping();

        // 2. Demora aleatoria entre 2000 y 5000 ms (2 a 5 segundos)
        const delay = Math.floor(Math.random() * (5000 - 2000 + 1)) + 2000;
        
        setTimeout(async () => {
            try {
                // 3. Enviar el mensaje
                await client.sendMessage(chatId, message);
                await chat.clearState();
                console.log(`[🚀 ENVIADO EXITOSAMENTE]`);
                console.log(`➔ Destino: ${chatId}`);
                console.log(`➔ Mensaje: "${message}"\n`);
            } catch (err) {
                console.error('Error al enviar el mensaje tras el delay:', err);
            }
        }, delay);

        // Responder inmediatamente al Gateway que la petición fue encolada
        return res.json({ status: 'success', message: 'Mensaje encolado para envío' });

    } catch (error) {
        console.error('Error procesando el envío:', error);
        return res.status(500).json({ error: 'Error interno del servidor al procesar el mensaje. Verifique si el número es válido.' });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor API Gateway escuchando en el puerto ${PORT}`);
});
