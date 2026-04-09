/**
 * agent.js — PixelPrint Print Agent
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs as a systemd / PM2 service on each kiosk machine.
 *
 * Config (read from config.json in the same directory):
 *   {
 *     "kioskId":    "NIT_CALICUT_MILMA",
 *     "backendUrl": "https://printing-pixel-1.onrender.com",
 *     "secret":     "pixelprint-agent-2026",
 *     "printer1":   "HP_Color_LaserJet",   // Color / primary printer (SX & DX)
 *     "printer2":   null                    // B&W printer — null for SX, name for DX
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

// ── SX / DX routing constants ────────────────────────────────────────────────
// printer2 being null/absent means SX (single printer). Both colour and B&W
// go to printer1. When printer2 is set, this is a DX kiosk: colour → printer1,
// B&W → printer2.
const PRINTER1   = config.printer1 || null           // colour / primary printer
const PRINTER2   = config.printer2 || null           // B&W printer (DX only)
const VARIANT    = PRINTER2 ? "DX" : "SX"           // auto-detected from config

log.info(`PixelPrint Agent v${VERSION} | Kiosk: ${KIOSK_ID} | Backend: ${BACKEND}`)
log.info(`Variant: ${VARIANT} | Printer1: "${PRINTER1 || 'auto'}" | Printer2: ${PRINTER2 ? `"${PRINTER2}"` : 'N/A (SX)'}`)

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
  const { printJobId, files, totalPages } = job

  if (isProcessing) {
    log.warn(`Job ${printJobId} received but agent is busy — will retry via queue`)
    return
  }

  isProcessing = true
  log.info(`\n${"─".repeat(60)}`)
  log.info(`Print job received | ID: ${printJobId} | Files: ${files.length} | Pages: ${totalPages}`)

  // Acknowledge receipt
  socket.emit("print:ack", { printJobId, kioskId: KIOSK_ID })

  const workDir   = printer.getWorkDir()
  const results   = []
  const tempFiles = []

  // ── Classify files: color vs B&W ────────────────────────────────────────
  const colorFiles = files.filter(f => (f.printOptions?.colorMode || "bw") === "color")
  const bwFiles    = files.filter(f => (f.printOptions?.colorMode || "bw") !== "color")

  log.info(`[${VARIANT}] Routing: ${colorFiles.length} color → "${PRINTER1 || 'auto'}" | ${bwFiles.length} B&W → "${VARIANT === "DX" ? (PRINTER2 || PRINTER1 || 'auto') : (PRINTER1 || 'auto')}"`)

  // ── Build routing table ──────────────────────────────────────────────────
  // SX: all jobs → printer1
  // DX: color → printer1, B&W → printer2 (fallback to printer1 if unset)
  const jobQueue = VARIANT === "SX"
    ? files.map(f => ({ file: f, targetPrinter: PRINTER1 }))
    : [
        ...colorFiles.map(f => ({ file: f, targetPrinter: PRINTER1 })),
        ...bwFiles.map(f => ({ file: f, targetPrinter: PRINTER2 || PRINTER1 }))
      ]

  // ── Sheet counting per printer ────────────────────────────────────────────
  // Duplex: 1 sheet per 2 pages. Single-side: 1 sheet per page.
  function countSheets(file) {
    const pageCount = file.pageCount || 1
    const copies    = file.printOptions?.copies || 1
    const duplex    = file.printOptions?.duplex === "double"
    const pages     = pageCount * copies
    return duplex ? Math.ceil(pages / 2) : pages
  }

  let sheetsP1 = 0   // sheets consumed on printer1
  let sheetsP2 = 0   // sheets consumed on printer2

  // ── Process each routed job ──────────────────────────────────────────────
  for (let i = 0; i < jobQueue.length; i++) {
    const { file, targetPrinter } = jobQueue[i]
    log.info(`\n[${i + 1}/${jobQueue.length}] ${file.originalName} → "${targetPrinter || 'auto'}"`)

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
        timeout: 120_000
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
      if (isPdf)        processedPath = await printer.normalizePdfToA4(rawPath)
      else if (isImage) processedPath = await printer.imageToA4Pdf(rawPath)
      else              processedPath = rawPath
      if (processedPath && processedPath !== rawPath) tempFiles.push(processedPath)
    } catch (err) {
      log.error(`  Normalization failed: ${err.message}`)
      processedPath = rawPath
    }

    // ── 3. Print to routed printer ───────────────────────────────────────────
    try {
      socket.emit("print:progress", { printJobId, status: "PRINTING", fileIndex: i })
      const finalPath = processedPath || rawPath

      if (targetPrinter) {
        await printer.printFileToNamed(finalPath, targetPrinter, file.printOptions)
      } else {
        await printer.printFile(finalPath, file.printOptions)
      }

      // Count sheets used per printer
      const sheets = countSheets(file)
      if (targetPrinter === PRINTER2 && VARIANT === "DX") sheetsP2 += sheets
      else                                                  sheetsP1 += sheets

      results.push({ filename: file.originalName, success: true })
      log.info(`  ✅ Done: ${file.originalName} (${sheets} sheet${sheets !== 1 ? 's' : ''})`)
    } catch (err) {
      log.error(`  Print failed: ${err.message}`)
      results.push({ filename: file.originalName, success: false, error: err.message })
    }
  }

  // ── 4. Report result ──────────────────────────────────────────────────────
  const allOk  = results.every(r => r.success)
  const anyOk  = results.some(r => r.success)
  const status = allOk ? "COMPLETED" : anyOk ? "PARTIAL_FAILURE" : "FAILED"

  socket.emit("print:result", { printJobId, kioskId: KIOSK_ID, success: allOk, status, results })
  log.info(`\nJob ${printJobId} → ${status} | P1: −${sheetsP1} sheets | P2: −${sheetsP2} sheets`)
  log.info(`Results: ${results.filter(r => r.success).length}/${results.length} files OK`)

  // ── 5. Update paper counts on KIOSK backend ───────────────────────────────
  // Read current counts, subtract used sheets, write back.
  // Non-fatal: paper tracking failure never blocks printing.
  if (sheetsP1 > 0 || sheetsP2 > 0) {
    try {
      const kioskRes = await axios.get(
        `${BACKEND}/api/kiosk/${KIOSK_ID}`,
        { timeout: 10_000 }
      )
      const kiosk = kioskRes.data?.kiosk
      if (kiosk) {
        const curP1 = kiosk.printer1Paper ?? 250
        const curP2 = kiosk.printer2Paper ?? 250
        const newP1 = Math.max(0, curP1 - sheetsP1)
        const newP2 = Math.max(0, curP2 - sheetsP2)
        await axios.put(
          `${BACKEND}/api/kiosk/${KIOSK_ID}/paper`,
          { printer1Paper: newP1, printer2Paper: newP2 },
          { timeout: 10_000 }
        )
        log.info(`Paper updated → P1: ${curP1}→${newP1}  P2: ${curP2}→${newP2}`)
      }
    } catch (err) {
      log.warn(`Paper count update failed (non-fatal): ${err.message}`)
    }
  }

  // ── 6. Cleanup temp files ─────────────────────────────────────────────────
  printer.cleanup(tempFiles)
  isProcessing = false
  log.info(`${"─".repeat(60)}\n`)
})

// ── Remote restart command ──────────────────────────────────────────────────

socket.on("agent:restart", () => {
  log.info("Remote restart command received — restarting via PM2")
  process.exit(0)   // PM2 restarts automatically
})

// ── OTA self-update command ─────────────────────────────────────────────────
// Triggered by backend "agent:update" event.
// Agent pulls latest code from GitHub, then restarts itself.

socket.on("agent:update", async (data) => {
  const targetVersion = data?.version || "latest"
  log.info(`\n${"─".repeat(60)}`)
  log.info(`🔄 OTA Update received — pulling ${targetVersion}`)

  // Notify backend we started the update
  socket.emit("update:started", { kioskId: KIOSK_ID, version: VERSION })

  try {
    const { execSync } = require("child_process")

    // 1. Git pull latest code
    log.info("  Running: git pull...")
    const pullOutput = execSync("git pull", {
      cwd: __dirname,
      timeout: 60_000,
      encoding: "utf8"
    }).trim()
    log.info(`  git pull: ${pullOutput}`)

    // 2. Install any new dependencies
    if (pullOutput !== "Already up to date.") {
      log.info("  Running: npm install...")
      execSync("npm install --production", {
        cwd: __dirname,
        timeout: 120_000,
        encoding: "utf8"
      })
    }

    log.info(`  ✅ Update complete — restarting agent`)
    socket.emit("update:done", {
      kioskId: KIOSK_ID,
      success: true,
      previousVersion: VERSION,
      output: pullOutput
    })

    // Brief delay so the socket message goes through before exit
    setTimeout(() => process.exit(0), 1000)

  } catch (err) {
    log.error(`  ❌ Update failed: ${err.message}`)
    socket.emit("update:done", {
      kioskId: KIOSK_ID,
      success: false,
      error: err.message
    })
  }
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
