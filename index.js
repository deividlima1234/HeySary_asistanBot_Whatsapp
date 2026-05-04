require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const { usePostgresAuthState } = require('./pgAuthState');
const { Groq } = require('groq-sdk');

const BEARER_TOKEN = process.env.BEARER_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

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
let linkedNumber = null;
let linkedName = null;

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Autopilot State
let lastPingTime = Date.now();
let isAutopilotEnabled = false;
const AUTOPILOT_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutos

let groqClient = null;
if (GROQ_API_KEY) {
    groqClient = new Groq({ apiKey: GROQ_API_KEY });
    console.log("Cliente Groq AI inicializado.");
} else {
    console.warn("GROQ_API_KEY no encontrada en .env, la IA no podrá responder de forma autónoma.");
}

// Inicializar tabla para Autopilot
async function initOfflineDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS offline_logs (
                id SERIAL PRIMARY KEY,
                contact_id VARCHAR(255),
                contact_name VARCHAR(255),
                message_received TEXT,
                response_generated TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("Tabla offline_logs asegurada en BD.");
    } catch (e) {
        console.error("Error creando tabla offline_logs:", e);
    }
}
initOfflineDB();

// Vigía del Piloto Automático
setInterval(() => {
    if (!isAutopilotEnabled && (Date.now() - lastPingTime > AUTOPILOT_TIMEOUT_MS)) {
        console.log('⏳ Timeout alcanzado (3 min). Entrando en Piloto Automático...');
        isAutopilotEnabled = true;
    }
}, 10000); // Revisar cada 10 segundos

async function connectToWhatsApp() {
    console.log("Activando Autenticación con PostgreSQL y Baileys...");
    const { state, saveCreds, deleteSession } = await usePostgresAuthState(pool, 'heysary_session');

    let version = [2, 3000, 1015901307];
    let isLatest = false;
    try {
        const result = await fetchLatestBaileysVersion();
        version = result.version;
        isLatest = result.isLatest;
    } catch (e) { }
    console.log(`Usando WA v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        logger: pino({ level: 'info' }), // Habilitado para diagnosticar el stream error
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
            const user = sock.user;
            linkedNumber = user.id.split(':')[0];
            linkedName = user.name || 'Usuario';
            console.log(`Cliente de WhatsApp listo: ${linkedName} (${linkedNumber})`);
            currentStatus = 'CONNECTED';
            currentQrBase64 = null;
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (!isAutopilotEnabled || !sock) return;

        try {
            console.log("[DEBUG-AUTOPILOT] Evento messages.upsert recibido:", JSON.stringify(m, null, 2));
            const msg = m.messages[0];
            // Ignorar si no hay mensaje, si es nuestro, de un grupo, o de estado
            if (!msg || !msg.message || msg.key.fromMe || msg.key.remoteJid.includes('@g.us') || msg.key.remoteJid === 'status@broadcast') {
                console.log("[DEBUG-AUTOPILOT] Mensaje ignorado. (fromMe/grupo/estado/sin-mensaje)");
                return;
            }

            const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (!textMessage) {
                console.log("[DEBUG-AUTOPILOT] Mensaje no tiene texto. Ignorando.");
                return;
            }

            const contactId = msg.key.remoteJid;
            const contactName = msg.pushName || 'Contacto';

            // Comprobar Cooldown en BD (¿Ya le respondimos mientras estamos offline?)
            // Buscamos si hay un registro de este contacto desde que entramos en modo offline.
            // Para simplificar, buscamos si hay ALGÚN registro de este contacto que aún no se ha sincronizado (porque al reconectar borramos la tabla).
            const recentLog = await pool.query(
                `SELECT id FROM offline_logs WHERE contact_id = $1 LIMIT 1`, 
                [contactId]
            );

            if (recentLog.rowCount > 0) {
                // Ya le respondimos. Solo guardamos el mensaje en bitácora silenciosamente.
                await pool.query(
                    `INSERT INTO offline_logs (contact_id, contact_name, message_received, response_generated) VALUES ($1, $2, $3, $4)`,
                    [contactId, contactName, textMessage, "[Mensaje Anotado - Sin auto-respuesta por Cooldown]"]
                );
                return;
            }

            console.log(`[AUTOPILOT] Nuevo mensaje de ${contactName}. Generando respuesta IA...`);

            let responseText = "El Sr. Eddam está fuera de cobertura en este momento. He anotado tu mensaje y se lo notificaré en cuanto recupere la conexión.";

            if (groqClient) {
                try {
                    const promptText = `Eres Sary, la IA asistente del Sr. Eddam. Actualmente él está sin conexión a internet. Responde a este mensaje de forma MUY BREVE, cortés y natural. Dile a la persona que has anotado su mensaje y que Eddam lo verá apenas vuelva a estar en línea. No ofrezcas ayuda en su lugar, solo informa. NO incluyas ninguna firma al final, yo la pondré. El mensaje lo envía: ${contactName}. Contexto del mensaje: "${textMessage}"`;
                    
                    const chatCompletion = await groqClient.chat.completions.create({
                        messages: [{ role: "system", content: promptText }],
                        model: "llama3-8b-8192",
                        temperature: 0.6,
                        max_tokens: 150,
                    });
                    responseText = chatCompletion.choices[0]?.message?.content?.trim() || responseText;
                } catch (aiError) {
                    console.error("Error en Groq API:", aiError);
                }
            }

            const finalMessage = responseText + "\\n\\n— Sary 🤖";

            // Simular tipeo humano
            await sock.sendPresenceUpdate('composing', contactId);
            const typingDelay = Math.min(Math.max(finalMessage.length * 50, 2000), 4000);
            await new Promise(resolve => setTimeout(resolve, typingDelay));
            await sock.sendPresenceUpdate('paused', contactId);

            // Enviar
            await sock.sendMessage(contactId, { text: finalMessage });

            // Guardar en bitácora
            await pool.query(
                `INSERT INTO offline_logs (contact_id, contact_name, message_received, response_generated) VALUES ($1, $2, $3, $4)`,
                [contactId, contactName, textMessage, finalMessage]
            );

        } catch (err) {
            console.error("Error procesando mensaje en Autopilot:", err);
        }
    });
}

connectToWhatsApp();

// Endpoint de Heartbeat y Handshake (Piloto Automático)
app.post('/api/heartbeat', authMiddleware, async (req, res) => {
    lastPingTime = Date.now();
    
    if (isAutopilotEnabled) {
        console.log('🟢 Dispositivo reconectado (Heartbeat). Desactivando Piloto Automático. Sincronizando bitácora...');
        isAutopilotEnabled = false;
        
        try {
            // Recuperar bitácora
            const logsRes = await pool.query(`SELECT contact_name, message_received, response_generated, created_at FROM offline_logs ORDER BY created_at ASC`);
            const logs = logsRes.rows;
            
            // Vaciar bitácora
            await pool.query(`DELETE FROM offline_logs`);
            
            return res.json({ 
                status: 'ONLINE', 
                message: 'Welcome back. Piloto automático desactivado.',
                recovered_messages: logs 
            });
        } catch (err) {
            console.error("Error sincronizando bitácora:", err);
            return res.status(500).json({ error: "Error recuperando bitácora de BD" });
        }
    }

    res.json({ status: 'ONLINE', message: 'Heartbeat recibido. Piloto automático inactivo.' });
});

// Soportar ambas rutas (La antigua de WhatsappGatewayClient y la nueva)
app.post(['/api/whatsapp/send', '/api/messages/send'], authMiddleware, async (req, res) => {
    // La App Android via WhatsappGatewayClient envía "to", pero nosotros usábamos "phone"
    const phone = req.body.phone || req.body.to;
    const message = req.body.message;

    if (!phone || !message) {
        return res.status(400).json({ error: "Missing 'phone' (or 'to') or 'message'" });
    }

    if (currentStatus !== 'CONNECTED' || !sock) {
        return res.status(503).json({ error: "WhatsApp Client no está listo", currentStatus });
    }

    try {
        let cleanPhone = phone.replace(/\D/g, '');
        // Baileys usa el código de país. Si el número tiene 9 dígitos (Perú), le agregamos el 51
        if (cleanPhone.length === 9) {
            cleanPhone = "51" + cleanPhone;
        }

        const jid = `${cleanPhone}@s.whatsapp.net`;

        // Comprobar si existe el número
        const [result] = await sock.onWhatsApp(jid);
        if (!result || !result.exists) {
            return res.status(400).json({ error: "El numero no existe en WhatsApp" });
        }

        // --- Humanizar Envío ---
        // 1. Activar estado 'escribiendo'
        await sock.sendPresenceUpdate('composing', result.jid);

        // 2. Delay dinámico (aprox 100ms por carácter, min 1s, max 4s)
        const typingDelay = Math.min(Math.max(message.length * 50, 1500), 4000);
        await new Promise(resolve => setTimeout(resolve, typingDelay));

        // 3. Detener 'escribiendo' y enviar con Marca de Agua
        await sock.sendPresenceUpdate('paused', result.jid);

        const watermark = "\n\n— SΛRY IПTΞLLIGΞПCΞ // HUD.v2";
        const finalMessage = message.trim() + watermark;

        await sock.sendMessage(result.jid, { text: finalMessage });
        res.status(200).json({ success: true, message: "Mensaje enviado exitosamente vía Sockets" });
    } catch (e) {
        console.error("Error al enviar mensaje:", e);
        res.status(500).json({ error: e.toString() });
    }
});

app.get('/api/whatsapp/status', authMiddleware, (req, res) => {
    res.json({
        state: currentStatus,
        status: currentStatus,
        qrCodeBase64: currentQrBase64,
        phone: linkedNumber,
        name: linkedName
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
