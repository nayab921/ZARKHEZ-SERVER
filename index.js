const express = require("express");

const admin = require("firebase-admin");

const cron = require("node-cron");

const fs = require("fs");

const app = express();

console.log("========================================");

console.log("🚀 ZARKHEZ ULTIMATE SERVER STARTING...");

console.log("========================================");

let serviceAccount;

if (fs.existsSync("/etc/secrets/serviceAccountKey.json")) {
  console.log("☁️ Render Environment Detected! Loading secret key...");

  serviceAccount = require("/etc/secrets/serviceAccountKey.json");
} else {
  console.log("💻 Local Environment Detected! Loading local key...");

  serviceAccount = require("./serviceAccountKey.json");
}

try {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

  console.log("✅ Firebase Connected Successfully!");
} catch (err) {
  console.error("❌ Firebase Connection Error:", err);
}

const db = admin.firestore();

// 🕒 Pakistan Time Helper Function

function getPKTTime() {
  const nowStr = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Karachi",
  });

  return new Date(nowStr);
}

// =========================================================

// 🔔 1. BULLETPROOF NOTIFICATION SYSTEM

// =========================================================

async function sendPush(userName, title, body) {
  if (!userName || userName === "System" || userName === "null") return;

  try {
    const userQuery = await db
      .collection("users")
      .where("name", "==", userName)
      .get();

    if (userQuery.empty) return;

    const userEmail = userQuery.docs[0].data().email;

    if (!userEmail) return;

    const tokenDoc = await db.collection("users").doc(userEmail).get();

    if (!tokenDoc.exists || !tokenDoc.data().fcmToken) return;

    const fcmToken = tokenDoc.data().fcmToken;

    // High Priority + Unique Tag (Taake notification hamesha popup ho)

    const payload = {
      token: fcmToken,

      notification: { title: String(title), body: String(body) },

      android: {
        priority: "high",

        notification: {
          sound: "default",
          channelId: "alerts",
          tag: Date.now().toString(),
        },
      },
    };

    await admin.messaging().send(payload);

    console.log(`✅ NOTIFICATION SENT: [${userName}] -> ${title}`);
  } catch (err) {
    console.error(`❌ NOTIFICATION ERROR:`, err.message);
  }
}

// =========================================================

// ⚙️ 2. SAFETY SETTINGS & VARIABLES

// =========================================================

let safetySettings = { minV: 190, maxV: 240, maxA: 12, controlMode: "auto" };

let manualNotifCount = 0;

let lastWarningTime = 0;

db.collection("settings")
  .doc("safety_config")
  .onSnapshot((doc) => {
    if (doc.exists) safetySettings = { ...safetySettings, ...doc.data() };
  });

console.log("👀 Listening for Database Changes...");

// =========================================================
// ⚡ 3. MOTOR ON/OFF & BILLING LOGIC (STATELESS)
// =========================================================
db.collection("iot_data").doc("relay").onSnapshot(async (doc) => {
  try {
    if (!doc.exists) return;
    const data = doc.data();
    
    const status = data.status; // "on" ya "off"
    const activeUser = data.activeUser;
    const mode = data.mode || "manual";
    const sessionStartTime = data.sessionStartTime; 

    // --- MOTOR ON LOGIC ---
    if (status === "on" && !sessionStartTime) {
      console.log(`⏳ Motor ON process started for ${activeUser}...`);
      
      const nowTime = Date.now();
      await db.collection("iot_data").doc("relay").update({ sessionStartTime: nowTime });

      // 🔥 FIXED: 3 second delay ke baad HAMESHA notification bheje ga
      setTimeout(async () => {
        try {
          const recentEvents = await db.collection("events").where("type", "==", "MOTOR_ON").orderBy("timestamp", "desc").limit(1).get();
          let appDidIt = false;
          if (!recentEvents.empty && Date.now() - recentEvents.docs[0].data().timestamp?.toDate().getTime() < 10000) appDidIt = true;

          // Event duplicate na bane is liye appDidIt check hoga
          if (!appDidIt) {
            await db.collection("events").add({
              type: "MOTOR_ON",
              message: `Motor started by ${activeUser}`,
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
              userName: activeUser || "System",
            });
          }
          
          // 🔥 PUSH HAMESHA BHEJO (If block se bahar nikal diya)
          sendPush(activeUser, "⚡ Motor Started", `Motor turned ON by ${activeUser}`);
          
        } catch (e) {
          console.log("❌ ON Event Error:", e.message);
        }
      }, 3000);

      manualNotifCount = 0;
      lastWarningTime = 0;
    }

    // --- MOTOR OFF & BILLING LOGIC ---
    if (status === "off" && sessionStartTime) {
      const durationMins = (Date.now() - sessionStartTime) / 60000;
      console.log(`🛑 Motor OFF process started. Duration: ${durationMins.toFixed(2)} mins`);

      // 🔥 OFF EVENT & NOTIFICATION
      setTimeout(async () => {
        try {
          const recentEvents = await db.collection("events").where("type", "==", "MOTOR_OFF").orderBy("timestamp", "desc").limit(1).get();
          let appDidIt = false;
          if (!recentEvents.empty && Date.now() - recentEvents.docs[0].data().timestamp?.toDate().getTime() < 10000) appDidIt = true;

          if (!appDidIt) {
            await db.collection("events").add({
              type: "MOTOR_OFF",
              message: `Motor stopped. Duration: ${durationMins.toFixed(2)} mins`,
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
              userName: activeUser || "System",
            });
          }
          
          // 🔥 PUSH HAMESHA BHEJO
          sendPush(activeUser, "🛑 Motor Stopped", `Motor turned OFF.`);
          
        } catch (e) { console.log("❌ OFF Event Error:", e.message); }
      }, 3000);

      // BILLING
      if (durationMins > 0.05) {
        const rateDoc = await db.collection("settings").doc("billing_config").get();
        const rate = rateDoc.data()?.currentRate || 200;
        const billAmount = (durationMins / 60) * rate;

        await db.collection("billing_history").add({
          userName: activeUser || "System",
          duration: durationMins.toFixed(2),
          billAmount: billAmount.toFixed(2),
          status: "pending",
          mode: mode,
          startTime: admin.firestore.Timestamp.fromMillis(sessionStartTime),
          endTime: admin.firestore.Timestamp.now(),
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`💰 Bill Created! Rs ${billAmount.toFixed(2)}`);
        sendPush(activeUser, "💰 Bill Generated", `Duration: ${durationMins.toFixed(2)} mins. Bill: Rs. ${billAmount.toFixed(2)}`);
      }

      // Database Cleanup
      await db.collection("iot_data").doc("relay").update({ 
        activeUser: null, 
        sessionStartTime: null 
      });
    }

  } catch (err) {
    console.error("❌ Relay Logic Error:", err);
  }
});

// =========================================================

// 🛡️ 4. SAFETY LOGIC (AUTO / MANUAL SENSORS)

// =========================================================

db.collection("iot_data")
  .doc("sensors")
  .onSnapshot(async (doc) => {
    try {
      if (!doc.exists) return;

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
          const relay = await db.collection("iot_data").doc("relay").get();

          if (relay.exists && relay.data().status === "on") {
            const activeUser = relay.data().activeUser || "System";

            if (controlMode === "auto") {
              console.log(`⚠️ Safety Triggered: ${reason} (AUTO MODE)`);

              await db
                .collection("iot_data")
                .doc("relay")
                .update({ command: "off", status: "off" });

              sendPush(
                activeUser,
                "⚠️ AUTO STOPPED",
                `Safety Shutdown: ${reason}`,
              );
            } else {
              // MANUAL MODE LOGIC (WITH 10 SECONDS COOLDOWN)

              const now = Date.now();

              if (now - lastWarningTime > 10000) {
                lastWarningTime = now;

                if (manualNotifCount < 2) {
                  manualNotifCount++;

                  console.log(
                    `⚠️ WARNING (${manualNotifCount}/2) SENT (MANUAL MODE)`,
                  );

                  sendPush(
                    activeUser,
                    `⚠️ WARNING (${manualNotifCount}/2)`,
                    `Critical: ${reason}. Please turn off motor!`,
                  );
                } else {
                  console.log("🛑 FORCED SHUTDOWN (MANUAL MODE)");

                  await db
                    .collection("iot_data")
                    .doc("relay")
                    .update({ command: "off", status: "off" });

                  sendPush(
                    activeUser,
                    "🛑 FORCED STOP",
                    "Motor stopped after 2 ignored warnings.",
                  );

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
      console.error("❌ Safety Logic Error:", err);
    }
  });


app.get("/", (req, res) => {
  res.send("Zarkhez Server Running...🟢");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🌐 Web Server running on port ${PORT}`);
});
