const express = require('express');
const admin = require('firebase-admin');
const cron = require('node-cron');
const fs = require('fs');

const app = express();

console.log("========================================");
console.log("🚀 ZARKHEZ ULTIMATE SERVER STARTING...");
console.log("========================================");

// 👇 SMART PATH FINDER
let serviceAccount;
if (fs.existsSync('/etc/secrets/serviceAccountKey.json')) {
    console.log("☁️ Render Environment Detected! Loading secret key...");
    serviceAccount = require('/etc/secrets/serviceAccountKey.json');
} else {
    console.log("💻 Local Environment Detected! Loading local key...");
    serviceAccount = require('./serviceAccountKey.json');
}

try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("✅ Firebase Connected Successfully!");
} catch (err) {
    console.error("❌ Firebase Connection Error:", err);
}

const db = admin.firestore();

// =========================================================
// 🔔 SMART PUSH NOTIFICATION FUNCTION (BACKGROUND FIX)
// =========================================================
async function sendPush(userName, title, body) {
    if (!userName || userName === 'System' || userName === 'null') return;

    try {
        const userQuery = await db.collection('users').where('name', '==', userName).get();
        if (userQuery.empty) return;

        const userEmail = userQuery.docs[0].data().email;
        if (!userEmail) return;

        const tokenDoc = await db.collection('users').doc(userEmail).get();
        if (!tokenDoc.exists || !tokenDoc.data().fcmToken) return;

        const fcmToken = tokenDoc.data().fcmToken;

        const payload = {
            token: fcmToken,
            notification: { 
                title: String(title), 
                body: String(body) 
            },
            data: { // KILLED STATE FIX: App ko neend se jagane ke liye
                title: String(title),
                body: String(body),
                type: 'urgent_alert'
            },
            android: {
                priority: 'high',
                notification: {
                    channelId: 'alerts', // 👈 YEH WAPAS ADD KIYA HAY! Iske baghair phone notification gira deta hai
                    sound: 'default'
                }
            }
        };

        await admin.messaging().send(payload);
        console.log(`✅ SUCCESS: Notification sent to [${userName}] -> ${title}`);
    } catch (err) {
        console.error(`❌ ERROR in sendPush:`, err.message);
    }
}

// =========================================================
// STATE VARIABLES (DON'T DELETE THESE!)
// =========================================================
let activeSessionId = null;
let manualNotifCount = 0;
let lastWarningTime = 0; // 👈 YEH LAZMI HAI SABAR WALE LOGIC KE LIYE
let activeMode = 'manual';
let safetySettings = { minV: 190, maxV: 240, maxA: 12, controlMode: 'auto' };

db.collection('settings').doc('safety_config').onSnapshot(doc => {
    if (doc.exists) safetySettings = { ...safetySettings, ...doc.data() };
});

console.log("👀 Listening for Database Changes...");

// =========================================================
// 1. MOTOR ON/OFF & BILLING LOGIC
// =========================================================
db.collection('iot_data').doc('relay').onSnapshot(async doc => {
    try {
        if (!doc.exists) return;
        
        const data = doc.data();
        const status = data.status;
        const activeUser = data.activeUser;
        activeMode = data.mode || 'manual';

        console.log(`\n👉 RELAY CHANGED -> Status: [${status}], User: [${activeUser}]`);

        if (status === 'on') {
            if (!activeSessionId) {
                activeSessionId = Date.now();
                manualNotifCount = 0;
                lastWarningTime = 0; 
                console.log(`⏳ Motor ON process started for ${activeUser}...`);
                
                setTimeout(async () => {
                    try {
                        const recentEvents = await db.collection('events').where('type', '==', 'MOTOR_ON').orderBy('timestamp', 'desc').limit(1).get();
                        let appDidIt = false;
                        if (!recentEvents.empty && (Date.now() - recentEvents.docs[0].data().timestamp?.toDate().getTime() < 10000)) appDidIt = true;
                        
                        if (!appDidIt) { 
                            await db.collection('events').add({
                                type: 'MOTOR_ON', message: `Motor started by ${activeUser}`,
                                timestamp: admin.firestore.FieldValue.serverTimestamp(), userName: activeUser
                            });
                            sendPush(activeUser, "⚡ Motor Started", `Motor turned ON by ${activeUser}`);
                        }
                    } catch (e) { console.log("❌ ON Event Error:", e.message); }
                }, 3000);
            }
        }

        if (status === 'off') {
            if (activeSessionId) {
                const sessionStartTime = activeSessionId; 
                const durationMins = (Date.now() - activeSessionId) / 60000;
                activeSessionId = null;
                console.log(`🛑 Motor OFF process started. Duration: ${durationMins.toFixed(2)} mins`);

                setTimeout(async () => {
                    try {
                        const recentEvents = await db.collection('events').where('type', '==', 'MOTOR_OFF').orderBy('timestamp', 'desc').limit(1).get();
                        let appDidIt = false;
                        if (!recentEvents.empty && (Date.now() - recentEvents.docs[0].data().timestamp?.toDate().getTime() < 10000)) appDidIt = true;
                        
                        if (!appDidIt) {
                            await db.collection('events').add({
                                type: 'MOTOR_OFF', message: `Motor stopped. Duration: ${durationMins.toFixed(2)} mins`,
                                timestamp: admin.firestore.FieldValue.serverTimestamp(), userName: activeUser
                            });
                            sendPush(activeUser, "🛑 Motor Stopped", `Motor turned OFF.`);
                        }
                    } catch (e) { console.log("❌ OFF Event Error:", e.message); }
                }, 3000);

                if (durationMins > 0.05) {
                    setTimeout(async () => {
                        try {
                            const recentBills = await db.collection('billing_history').orderBy('timestamp', 'desc').limit(1).get();
                            let billGenerated = false;
                            if (!recentBills.empty && (Date.now() - recentBills.docs[0].data().timestamp?.toDate().getTime() < 15000)) billGenerated = true;
                            
                            if (!billGenerated) { 
                                const rateDoc = await db.collection('settings').doc('billing_config').get();
                                const rate = rateDoc.data()?.currentRate || 200;
                                const billAmount = (durationMins / 60) * rate;
                                
                                await db.collection('billing_history').add({
                                    userName: activeUser, 
                                    duration: durationMins.toFixed(2),
                                    billAmount: billAmount.toFixed(2), 
                                    status: 'pending',
                                    mode: activeMode,
                                    startTime: admin.firestore.Timestamp.fromMillis(sessionStartTime),
                                    endTime: admin.firestore.Timestamp.now(), 
                                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                                });
                                console.log(`💰 Bill Created! Rs ${billAmount.toFixed(2)}`);
                                sendPush(activeUser, "💰 Bill Generated", `Duration: ${durationMins.toFixed(2)} mins. Bill: Rs. ${billAmount.toFixed(2)}`);
                            }
                        } catch (e) { console.log("❌ Billing Error:", e.message); }
                    }, 6000); 
                }
            }
        }
    } catch (globalErr) {
        console.error("❌ Crash Prevented in Relay Logic:", globalErr);
    }
});

// =========================================================
// 2. SAFETY LOGIC (Auto / Manual Limits) - BULLETPROOFED
// =========================================================
db.collection('iot_data').doc('sensors').onSnapshot(async doc => {
    try { 
        if (!doc.exists || !activeSessionId) return;
        const data = doc.data();
        const v = data.voltage || 0;
        const c = data.current || 0;
        const { minV, maxV, maxA, controlMode } = safetySettings;

        if (v > 0.5) {
            let reason = "";
            if (v < minV) reason = `Low Voltage (${v}V)`;
            else if (v > maxV) reason = `High Voltage (${v}V)`;
            else if (c > maxA) reason = `Overload (${c}A)`;

            if (reason) {
                const relay = await db.collection('iot_data').doc('relay').get();
                if (relay.exists && relay.data().status === 'on') { 
                    const activeUser = relay.data().activeUser || 'System';
                    
                    if (controlMode === 'auto') {
                        console.log(`⚠️ Safety Triggered: ${reason} (AUTO MODE)`);
                        await db.collection('iot_data').doc('relay').update({ command: 'off', status: 'off' });
                        sendPush(activeUser, "⚠️ AUTO STOPPED", `Safety Shutdown: ${reason}`);
                    } else {
                        // MANUAL MODE LOGIC (WITH 10 SECONDS COOLDOWN)
                        const now = Date.now();
                        
                        if (now - lastWarningTime > 10000) { 
                            lastWarningTime = now; 
                            
                            if (manualNotifCount < 2) {
                                manualNotifCount++;
                                console.log(`⚠️ WARNING (${manualNotifCount}/3) SENT (MANUAL MODE) - Reason: ${reason}`);
                                sendPush(activeUser, `⚠️ WARNING (${manualNotifCount}/3)`, `Critical: ${reason}. Please turn off motor!`);
                            } else {
                                console.log("🛑 FORCED SHUTDOWN (MANUAL MODE - 3 Warnings Reached)");
                                await db.collection('iot_data').doc('relay').update({ command: 'off', status: 'off' });
                                sendPush(activeUser, "🛑 FORCED STOP", "Motor stopped after 3 ignored warnings.");
                                manualNotifCount = 0;
                                lastWarningTime = 0;
                            }
                        }
                    }
                }
            } else {
                manualNotifCount = 0; 
                lastWarningTime = 0;
            }
        }
    } catch (err) {
        console.error("❌ Crash Prevented in Sensor Safety Logic:", err);
    }
});

// =========================================================
// 3. SCHEDULE RUNNER 
// =========================================================
cron.schedule('* * * * *', async () => {
    const now = new Date();
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const currentDay = (now.getDay() + 6) % 7; 

    try {
        const pendingSchedules = await db.collection('schedules').where('status', 'in', ['pending', 'running']).get();
        
        pendingSchedules.forEach(async (doc) => {
            const sch = doc.data();
            const user = sch.activeUser;

            if (sch.status === 'pending') {
                let isStartDay = false;
                if (sch.repeatType === 'today' || sch.repeatType === 'custom') {
                    const schDate = sch.startTime.toDate();
                    if (schDate.getDate() === now.getDate() && schDate.getMonth() === now.getMonth()) isStartDay = true;
                } else if (sch.repeatType === 'weekly' && sch.daysOfWeek && sch.daysOfWeek.includes(currentDay)) {
                    isStartDay = true;
                }

                if (isStartDay && sch.startMinutes === currentMins) {
                    console.log(`⏰ Schedule STARTED for ${user}`);
                    await db.collection('iot_data').doc('relay').update({ command: 'on', status: 'on', activeUser: user, mode: 'auto' });
                    await db.collection('schedules').doc(doc.id).update({ status: 'running' });
                    sendPush(user, "📅 Schedule Started", `Your scheduled watering has started.`);
                }
            }

            if (sch.status === 'running' && sch.endMinutes === currentMins) {
                console.log(`⏰ Schedule COMPLETED for ${user}`);
                await db.collection('iot_data').doc('relay').update({ command: 'off', status: 'off' });
                await db.collection('schedules').doc(doc.id).update({ status: 'completed' });
                sendPush(user, "✅ Schedule Completed", `Your scheduled watering has finished.`);
            }
        });
    } catch (err) {
        console.error("❌ Cron Schedule Error:", err);
    }
});

// =========================================================
// 4. SERVICE HOURS CHECK 
// =========================================================
cron.schedule('0 * * * *', async () => {
    try {
        const stats = await db.collection('motor_stats').doc('runtime').get();
        const settings = await db.collection('settings').doc('safety_config').get();
        if (stats.exists && settings.exists) {
            const hours = stats.data().totalHours || 0;
            const limit = settings.data().serviceLimit || 500;
            if (hours >= limit) {
                console.log(`🔧 Service Limit Exceeded! (${hours}/${limit})`);
                const users = await db.collection('users').get();
                if(!users.empty) {
                    sendPush(users.docs[0].data().name, "🔧 SERVICE REQUIRED", `Motor has exceeded ${limit} hours limit.`);
                }
            }
        }
    } catch (err) {}
});

app.get('/', (req, res) => {
    res.send('Zarkhez Server Running...🟢');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Web Server running on port ${PORT}`);
});