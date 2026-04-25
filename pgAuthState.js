const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

async function usePostgresAuthState(pool, sessionId) {
    // Inicializar tabla si no existe
    await pool.query(`
        CREATE TABLE IF NOT EXISTS baileys_auth (
            session_id VARCHAR(255),
            key_name VARCHAR(255),
            data JSONB,
            PRIMARY KEY (session_id, key_name)
        );
    `);

    const writeData = async (key_name, data) => {
        const jsonStr = JSON.stringify(data, BufferJSON.replacer);
        await pool.query(`
            INSERT INTO baileys_auth (session_id, key_name, data)
            VALUES ($1, $2, $3::jsonb)
            ON CONFLICT (session_id, key_name)
            DO UPDATE SET data = EXCLUDED.data
        `, [sessionId, key_name, jsonStr]);
    };

    const readData = async (key_name) => {
        const res = await pool.query(
            `SELECT data FROM baileys_auth WHERE session_id = $1 AND key_name = $2`, 
            [sessionId, key_name]
        );
        if (res.rowCount > 0 && res.rows[0].data) {
            return JSON.parse(JSON.stringify(res.rows[0].data), BufferJSON.reviver);
        }
        return null;
    };

    const removeData = async (key_name) => {
        await pool.query(
            `DELETE FROM baileys_auth WHERE session_id = $1 AND key_name = $2`, 
            [sessionId, key_name]
        );
    };

    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
        await writeData('creds', creds);
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(key, value));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData('creds', creds);
        },
        deleteSession: async () => {
            await pool.query(`DELETE FROM baileys_auth WHERE session_id = $1`, [sessionId]);
        }
    };
}

module.exports = { usePostgresAuthState };
