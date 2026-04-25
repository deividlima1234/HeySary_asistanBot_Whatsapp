require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Client, RemoteAuth, LocalAuth } = require('whatsapp-web.js');
const { PostgresStore } = require('wwebjs-postgres');
const { Pool } = require('pg');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');

// Capturar cualquier error para que no tire el servidor silenciosamente
process.on('uncaughtException', (err) => {
    console.error('🔥 UNCAUGHT EXCEPTION 🔥:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 UNHANDLED REJECTION 🔥:', reason);
});

// Forzar la liberación de memoria cada 10 segundos
setInterval(() => {
    if (global.gc) {
        try {
            global.gc();
        } catch (e) {
            console.error("GC Error:", e);
        }
    }
}, 10000);

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
let currentQrBase64 = null;
let currentStatus = 'STARTING'; // STARTING, WAITING_QR, CONNECTED, DISCONNECTED

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
            dataPath: './', // Fix: wwebjs-postgres hardcodea la búsqueda de RemoteAuth.zip en el directorio actual
            backupSyncIntervalMs: 300000 // Respaldo cada 5 min
        }),
        webVersionCache: { type: 'none' }, // Evita que WhatsApp recargue la página buscando actualizaciones (Evita Execution Context Destroyed)
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', // Evitar detecciones de Headless
        puppeteer: {
            // Render necesita executablePath si instalamos chromium por Docker
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--mute-audio',
                '--js-flags="--max-old-space-size=200"'
            ]
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

client.on('qr', async (qr) => {
    currentStatus = 'WAITING_QR';
    try {
        currentQrBase64 = await QRCode.toDataURL(qr);
    } catch (err) {
        console.error('Error generando QR Base64', err);
    }
    // Genera el código QR en la terminal por debuging extra
    qrcodeTerminal.generate(qr, { small: true });
    console.log('Escanea el código QR con tu aplicación HeySary o en terminal.');
});

client.on('ready', () => {
    console.log('Cliente de WhatsApp está listo!');
    isReady = true;
    currentStatus = 'CONNECTED';
    currentQrBase64 = null; // Borrar de memoria por seguridad al logearse
});

client.on('disconnected', (reason) => {
    console.log('Cliente desconectado: ', reason);
    isReady = false;
    currentStatus = 'DISCONNECTED';
    currentQrBase64 = null;
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

// Endpoint: Estado del servidor genérico
app.get('/api/status', (req, res) => {
    res.json({
        server: 'online',
        whatsapp_ready: isReady
    });
});

// Endpoint: Obtener QR visual e información detallada de estado (Protegido)
app.get('/api/whatsapp/status', authMiddleware, (req, res) => {
    res.json({
        state: currentStatus,
        isReady: isReady,
        qrCodeBase64: currentQrBase64 
    });
});

// Endpoint: Cerrar y destruir sesión activa / Revocar sesión (Protegido)
app.post('/api/whatsapp/logout', authMiddleware, async (req, res) => {
    if (!isReady && currentStatus !== 'CONNECTED') {
        return res.status(400).json({ error: 'No hay ninguna sesión de WhatsApp activa para revocar.' });
    }
    try {
        console.log("Cerrando sesión de WhatsApp solicitada por usuario...");
        await client.logout();
        isReady = false;
        currentStatus = 'DISCONNECTED';
        currentQrBase64 = null;
        res.json({ success: true, message: 'Sesión revocada exitosamente.' });
        
        // Normalmente cliente.initialize() se debe llamar de nuevo si queremos que ofrezca QR automáticamente tras logout.
        // Esperamos un segundo y forzamos reinicio:
        setTimeout(() => {
            console.log("Reiniciando cliente generador de QR...");
            client.initialize().catch(e => console.error(e));
        }, 2000);

    } catch (e) {
        console.error("Error cerrando sesión remota: ", e);
        res.status(500).json({ error: 'Error del servidor al cerrar sesión' });
    }
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
