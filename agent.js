/**
 * agent.js — PixelPrint Print Agent
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs as a systemd / PM2 service on each kiosk machine.
 *
 * Config (read from config.json in the same directory):
 *   {
 *     "kioskId":   "NIT_CALICUT_MILMA",
 *     "backendUrl": "https://printing-pixel-1.onrender.com",
 *     "secret":    "pixelprint-agent-2026"
 *   }
 */

const fs    = require("fs")
const path  = require("path")
const axios = require("axios")
const { io } = require("socket.io-client")

const log     = require("./logger")
const printer = require("./printer")

// ── Load config ──────────────────────────────────────────────────────────────

const CONFIG_PATH = process.env.CONFIG_PATH
  || path.join("/etc/pixelprint/config.json")   // production (Linux)

// Dev fallback: use config.json in the current directory
const DEV_CONFIG = path.join(__dirname, "config.json")

let config
try {
  const configFile = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : DEV_CONFIG
  config = JSON.parse(fs.readFileSync(configFile, "utf8"))
  log.info(`Loaded config from: ${configFile}`)
} catch (err) {
  log.error(`Failed to read config: ${err.message}`)
  log.error(`Please create config.json or /etc/pixelprint/config.json`)
  log.error(`See config.example.json for format.`)
  process.exit(1)
}

const KIOSK_ID   = config.kioskId
const BACKEND    = (config.backendUrl || "https://printing-pixel-1.onrender.com").replace(/\/$/, "")
const SECRET     = config.secret || "pixelprint-agent-2026"
const VERSION    = require("./package.json").version

log.info(`PixelPrint Agent v${VERSION} | Kiosk: ${KIOSK_ID} | Backend: ${BACKEND}`)

// ── Version check (optional auto-update hook) ────────────────────────────────
async function checkVersion() {
  try {
    const { data } = await axios.get(`${BACKEND}/api/agent/version`, { timeout: 5000 })
    if (data?.version && data.version !== VERSION) {
      log.warn(`Update available: ${VERSION} → ${data.version}. Run: git pull && pm2 restart pixelprint-agent`)
    }
  } catch (_) {
    // Version check is non-critical — ignore errors
  }
}

// ── Socket.IO connection ─────────────────────────────────────────────────────

log.info(`Connecting to backend socket...`)

const socket = io(BACKEND, {
  auth: { kioskId: KIOSK_ID, secret: SECRET },
  reconnection: true,
  reconnectionDelay: 3000,
  reconnectionDelayMax: 15000,
  reconnectionAttempts: Infinity,
  timeout: 20000
})

// ── Connection events ────────────────────────────────────────────────────────

socket.on("connect", () => {
  log.info(`Connected to backend | Socket ID: ${socket.id}`)

  socket.emit("kiosk:register", {
    kioskId: KIOSK_ID,
    version: VERSION,
    platform: process.platform,
    hostname: require("os").hostname()
  })

  checkVersion()
})

socket.on("connect_error", (err) => {
  log.error(`Connection error: ${err.message}`)
})

socket.on("disconnect", (reason) => {
  log.warn(`Disconnected: ${reason}`)
})

socket.on("reconnect", (attempt) => {
  log.info(`Reconnected after ${attempt} attempt(s)`)
})

// ── Heartbeat ────────────────────────────────────────────────────────────────

setInterval(() => {
  if (socket.connected) {
    socket.emit("kiosk:heartbeat", {
      kioskId: KIOSK_ID,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime())
    })
  }
}, 30_000)

// ── Print job handler ────────────────────────────────────────────────────────

let isProcessing = false  // Prevent concurrent jobs

socket.on("print:job", async (job) => {
  const { printJobId, uploadId, files, totalPages } = job

  if (isProcessing) {
    log.warn(`Job ${printJobId} received but agent is busy — will retry via queue`)
    return
  }

  isProcessing = true
  log.info(`\n${"─".repeat(60)}`)
  log.info(`Print job received | ID: ${printJobId} | Files: ${files.length} | Pages: ${totalPages}`)

  // Acknowledge receipt
  socket.emit("print:ack", { printJobId, kioskId: KIOSK_ID })

  const workDir  = printer.getWorkDir()
  const results  = []
  const tempFiles = []

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    log.info(`\n[${i + 1}/${files.length}] ${file.originalName}`)

    let rawPath       = null
    let processedPath = null

    // ── 1. Download ─────────────────────────────────────────────────────────
    try {
      socket.emit("print:progress", { printJobId, status: "DOWNLOADING", fileIndex: i })

      log.info(`  Downloading from S3...`)
      const response = await axios({
        method: "GET",
        url: file.url,
        responseType: "arraybuffer",
        timeout: 120_000    // 2 min download timeout
      })

      const safeName = file.originalName.replace(/[^a-zA-Z0-9._-]/g, "_")
      rawPath = path.join(workDir, `${Date.now()}_${safeName}`)
      fs.writeFileSync(rawPath, Buffer.from(response.data))
      tempFiles.push(rawPath)
      log.info(`  Saved: ${path.basename(rawPath)}`)

    } catch (err) {
      log.error(`  Download failed: ${err.message}`)
      results.push({ filename: file.originalName, success: false, error: `Download failed: ${err.message}` })
      continue
    }

    // ── 2. Normalize to A4 ──────────────────────────────────────────────────
    try {
      socket.emit("print:progress", { printJobId, status: "PROCESSING", fileIndex: i })

      const isPdf   = /\.pdf$/i.test(file.originalName) || (file.mimeType || "").includes("pdf")
      const isImage = /\.(jpe?g|png|gif|webp|bmp)$/i.test(file.originalName)

      if (isPdf) {
        processedPath = await printer.normalizePdfToA4(rawPath)
      } else if (isImage) {
        processedPath = await printer.imageToA4Pdf(rawPath)
      } else {
        processedPath = rawPath
        log.warn(`  Unknown file type — sending as-is`)
      }

      if (processedPath && processedPath !== rawPath) {
        tempFiles.push(processedPath)
      }
    } catch (err) {
      log.error(`  Normalization failed: ${err.message}`)
      processedPath = rawPath   // fallback to original
    }

    // ── 3. Print ────────────────────────────────────────────────────────────
    try {
      socket.emit("print:progress", { printJobId, status: "PRINTING", fileIndex: i })

      await printer.printFile(processedPath || rawPath, file.printOptions)

      results.push({ filename: file.originalName, success: true })
      log.info(`  ✅ Done: ${file.originalName}`)

    } catch (err) {
      log.error(`  Print failed: ${err.message}`)
      results.push({ filename: file.originalName, success: false, error: err.message })
    }
  }

  // ── 4. Report result ──────────────────────────────────────────────────────
  const allOk  = results.every(r => r.success)
  const anyOk  = results.some(r => r.success)
  const status = allOk ? "COMPLETED" : anyOk ? "PARTIAL_FAILURE" : "FAILED"

  socket.emit("print:result", {
    printJobId,
    kioskId: KIOSK_ID,
    success: allOk,
    status,
    results
  })

  log.info(`\nJob ${printJobId} → ${status}`)
  log.info(`Results: ${results.filter(r => r.success).length}/${results.length} files OK`)

  // ── 5. Cleanup temp files ─────────────────────────────────────────────────
  printer.cleanup(tempFiles)

  isProcessing = false
  log.info(`${"─".repeat(60)}\n`)
})

// ── Remote restart command ──────────────────────────────────────────────────

socket.on("agent:restart", () => {
  log.info("Remote restart command received — exiting (PM2/systemd will restart)")
  process.exit(0)
})

// ── Graceful shutdown ────────────────────────────────────────────────────────

process.on("SIGTERM", () => {
  log.info("SIGTERM received — shutting down")
  socket.disconnect()
  process.exit(0)
})

process.on("SIGINT", () => {
  log.info("SIGINT received — shutting down")
  socket.disconnect()
  process.exit(0)
})

process.on("uncaughtException", (err) => {
  log.error(`Uncaught exception: ${err.message}`)
  log.error(err.stack)
  // Don't exit — let PM2 restart handle critical failures
})
