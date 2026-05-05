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

db.collection("iot_data")
  .doc("relay")
  .onSnapshot(async (doc) => {
    try {
      if (!doc.exists) return;

      const data = doc.data();

      const status = data.status; // "on" ya "off"

      const activeUser = data.activeUser;

      const mode = data.mode || "manual";

      const sessionStartTime = data.sessionStartTime; // 🔥 RAM nahi, Firebase mein time save hoga

      // --- MOTOR ON LOGIC ---

      if (status === "on" && !sessionStartTime) {
        console.log(`⏳ Motor ON process started for ${activeUser}...`);

        const nowTime = Date.now();

        // DB mein time save kar do taake server so bhi jaye toh time na bhoole

        await db
          .collection("iot_data")
          .doc("relay")
          .update({ sessionStartTime: nowTime });

        await db.collection("events").add({
          type: "MOTOR_ON",

          message: `Motor started by ${activeUser}`,

          timestamp: admin.firestore.FieldValue.serverTimestamp(),

          userName: activeUser || "System",
        });

        sendPush(
          activeUser,
          "⚡ Motor Started",
          `Motor turned ON by ${activeUser}`,
        );

        manualNotifCount = 0;

        lastWarningTime = 0;
      }

      // --- MOTOR OFF & BILLING LOGIC ---

      if (status === "off" && sessionStartTime) {
        const durationMins = (Date.now() - sessionStartTime) / 60000;

        console.log(
          `🛑 Motor OFF process started. Duration: ${durationMins.toFixed(2)} mins`,
        );

        // 1. Motor Off Event & Notification

        await db.collection("events").add({
          type: "MOTOR_OFF",

          message: `Motor stopped. Duration: ${durationMins.toFixed(2)} mins`,

          timestamp: admin.firestore.FieldValue.serverTimestamp(),

          userName: activeUser || "System",
        });

        sendPush(activeUser, "🛑 Motor Stopped", `Motor turned OFF.`);

        // 2. Bill Generate Karna

        if (durationMins > 0.05) {
          const rateDoc = await db
            .collection("settings")
            .doc("billing_config")
            .get();

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

          sendPush(
            activeUser,
            "💰 Bill Generated",
            `Duration: ${durationMins.toFixed(2)} mins. Bill: Rs. ${billAmount.toFixed(2)}`,
          );
        }

        // 3. Database se waqt aur user clear kar do taake loop na bane

        await db.collection("iot_data").doc("relay").update({
          activeUser: null,

          sessionStartTime: null,
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

      if (c > maxA) {
      reason = `Overload Current (${c}A)`; // Current barhay toh sirf overload kahega
    } else if (v > 0.5 && v < minV) {
      reason = `Low Voltage (${v}V)`;
    } else if (v > maxV) {
      reason = `High Voltage (${v}V)`;
    }

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

// =========================================================

// ⏰ 5. SCHEDULE RUNNER (PAKISTAN TIME FIXED)

// =========================================================

cron.schedule("* * * * *", async () => {
  const now = getPKTTime(); // 🔥 Hamesha Pakistan ka time parhega

  const currentMins = now.getHours() * 60 + now.getMinutes();

  const currentDay = (now.getDay() + 6) % 7;

  try {
    const pendingSchedules = await db
      .collection("schedules")
      .where("status", "in", ["pending", "running"])
      .get();

    pendingSchedules.forEach(async (doc) => {
      const sch = doc.data();

      const user = sch.activeUser;

      if (sch.status === "pending") {
        let isStartDay = false;

        if (sch.repeatType === "today" || sch.repeatType === "custom") {
          const schDate = sch.startTime.toDate();

          if (
            schDate.getDate() === now.getDate() &&
            schDate.getMonth() === now.getMonth()
          )
            isStartDay = true;
        } else if (
          sch.repeatType === "weekly" &&
          sch.daysOfWeek &&
          sch.daysOfWeek.includes(currentDay)
        ) {
          isStartDay = true;
        }

        if (isStartDay && sch.startMinutes === currentMins) {
          console.log(`⏰ Schedule STARTED for ${user}`);

          await db.collection("iot_data").doc("relay").update({
            command: "on",
            status: "on",
            activeUser: user,
            mode: "auto",
          });

          await db
            .collection("schedules")
            .doc(doc.id)
            .update({ status: "running" });

          sendPush(
            user,
            "📅 Schedule Started",
            `Your scheduled watering has started.`,
          );
        }
      }

      if (sch.status === "running" && sch.endMinutes === currentMins) {
        console.log(`⏰ Schedule COMPLETED for ${user}`);

        await db
          .collection("iot_data")
          .doc("relay")
          .update({ command: "off", status: "off" });

        await db
          .collection("schedules")
          .doc(doc.id)
          .update({ status: "completed" });

        sendPush(
          user,
          "✅ Schedule Completed",
          `Your scheduled watering has finished.`,
        );
      }
    });
  } catch (err) {
    console.error("❌ Schedule Error:", err);
  }
});

// =========================================================

// 🔧 6. SERVICE HOURS CHECK (RELIABLE CATCH)

// =========================================================

// 🔥 Render server jab jaag raha ho tabhi check kare (Har 15 minute baad check karega)

cron.schedule("*/15 * * * *", async () => {
  try {
    const stats = await db.collection("motor_stats").doc("runtime").get();

    const settings = await db.collection("settings").doc("safety_config").get();

    if (stats.exists && settings.exists) {
      const hours = stats.data().totalHours || 0;

      const limit = settings.data().serviceLimit || 500;

      if (hours >= limit) {
        console.log(`🔧 Service Limit Exceeded! (${hours}/${limit})`);

        const users = await db.collection("users").get();

        if (!users.empty) {
          sendPush(
            users.docs[0].data().name,
            "🔧 SERVICE REQUIRED",
            `Motor has exceeded ${limit} hours limit.`,
          );
        }
      }
    }
  } catch (err) {}
});

app.get("/", (req, res) => {
  res.send("Zarkhez Server Running...🟢");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🌐 Web Server running on port ${PORT}`);
});
