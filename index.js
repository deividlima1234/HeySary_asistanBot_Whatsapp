require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const { usePostgresAuthState } = require('./pgAuthState');

const BEARER_TOKEN = process.env.BEARER_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const app = express();
app.use(cors());
app.use(express.json());

// Capturar cualquier error para que no tire el servidor silenciosamente
process.on('uncaughtException', (err) => {
    console.error('🔥 UNCAUGHT EXCEPTION 🔥:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 UNHANDLED REJECTION 🔥:', reason);
});

// Seguridad del Gateway
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${BEARER_TOKEN}`) {
        return res.status(401).json({ error: 'Unauthorized: Invalid Bearer Token' });
    }
    next();
};

let sock;
let currentQrBase64 = null;
let currentStatus = 'STARTING'; // STARTING, WAITING_QR, CONNECTED, DISCONNECTED

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function connectToWhatsApp() {
    console.log("Activando Autenticación con PostgreSQL y Baileys...");
    const { state, saveCreds, deleteSession } = await usePostgresAuthState(pool, 'heysary_session');
    
    let version = [2, 3000, 1015901307];
    let isLatest = false;
    try {
        const result = await fetchLatestBaileysVersion();
        version = result.version;
        isLatest = result.isLatest;
    } catch(e) {}
    console.log(`Usando WA v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }), // Evita prints masivos innecesarios de Baileys
        printQRInTerminal: true,
        auth: state,
        generateHighQualityLinkPreview: true,
        browser: ['HeySary Bot', 'Chrome', '1.0.0']
    });

    sock.deleteSessionPostgres = deleteSession;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            currentStatus = 'WAITING_QR';
            try {
                currentQrBase64 = await QRCode.toDataURL(qr, {
                    color: { dark: '#000000', light: '#FFFFFF' }
                });
            } catch (err) {
                console.error("Error generando QR Base64:", err);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log('Conexión cerrada. Razón:', lastDisconnect.error?.message, ', Re-conectar:', shouldReconnect);
            
            if (shouldReconnect) {
                currentStatus = 'STARTING';
                setTimeout(connectToWhatsApp, 3000);
            } else {
                currentStatus = 'DISCONNECTED';
                currentQrBase64 = null;
                console.log('Desconectado explícitamente (Logout). Eliminando sesión en BD...');
                await deleteSession();
                
                console.log('Reiniciando conexión para nuevo emparejamiento...');
                setTimeout(connectToWhatsApp, 2000);
            }
        } else if (connection === 'open') {
            console.log('Cliente de WhatsApp está listo! (Vía Baileys Sockets)');
            currentStatus = 'CONNECTED';
            currentQrBase64 = null;
        }
    });
}

connectToWhatsApp();

app.post('/api/whatsapp/send', authMiddleware, async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) {
        return res.status(400).json({ error: "Missing 'phone' or 'message'" });
    }

    if (currentStatus !== 'CONNECTED' || !sock) {
        return res.status(503).json({ error: "WhatsApp Client no está listo", currentStatus });
    }

    try {
        let cleanPhone = phone.replace(/\D/g, '');
        const jid = `${cleanPhone}@s.whatsapp.net`;
        
        // Comprobar si existe el número
        const [result] = await sock.onWhatsApp(jid);
        if (!result || !result.exists) {
            return res.status(400).json({ error: "El numero no existe en WhatsApp" });
        }

        await sock.sendMessage(result.jid, { text: message });
        res.status(200).json({ success: true, message: "Mensaje enviado exitosamente vía Sockets" });
    } catch (e) {
        console.error("Error al enviar mensaje:", e);
        res.status(500).json({ error: e.toString() });
    }
});

app.get('/api/whatsapp/status', authMiddleware, (req, res) => {
    res.json({
        status: currentStatus,
        qrCodeBase64: currentQrBase64
    });
});

app.post('/api/whatsapp/logout', authMiddleware, async (req, res) => {
    console.log("Cerrando sesión de WhatsApp solicitada por usuario...");
    if (sock && currentStatus === 'CONNECTED') {
        await sock.logout('User explicit logout');
    }
    res.json({ success: true, message: "Sesión revocada y cerrada exitosamente." });
});

const PORT = 10000;
app.listen(PORT, () => {
    console.log(`Servidor API Gateway escuchando en el puerto ${PORT}`);
});
