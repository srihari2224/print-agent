/**
 * agent.js — PixelPrint Print Agent
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs as a systemd / PM2 service on each kiosk machine.
 *
 * Config (read from config.json):
 *   {
 *     "kioskId":        "NIT_CALICUT_MILMA",
 *     "backendUrl":     "https://printing-pixel-1.onrender.com",
 *     "kioskBackendUrl":"https://kiosk-backend-t1mi.onrender.com",
 *     "secret":         "pixelprint-agent-2026",
 *     "printer1":       "EPSON_L6460_Series_USB_3",   // Color / primary (SX & DX)
 *     "printer2":       "Brother_HL_L5210DN_series_USB" // B&W (DX only; null for SX)
 *   }
 *
 * DX kiosks: color files → printer1, B&W files → printer2, run IN PARALLEL.
 * SX kiosks: all files → printer1, sequential (one printer only).
 */

const fs   = require("fs")
const path = require("path")
const axios = require("axios")
const { io } = require("socket.io-client")

const log     = require("./logger")
const printer = require("./printer")

// ── Load config ──────────────────────────────────────────────────────────────

const CONFIG_PATH = process.env.CONFIG_PATH || "/etc/pixelprint/config.json"
const DEV_CONFIG  = path.join(__dirname, "config.json")

let config
try {
  const configFile = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : DEV_CONFIG
  config = JSON.parse(fs.readFileSync(configFile, "utf8"))
  log.info(`Loaded config from: ${configFile}`)
} catch (err) {
  log.error(`Failed to read config: ${err.message}`)
  process.exit(1)
}

const KIOSK_ID      = config.kioskId
const BACKEND       = (config.backendUrl       || "https://printing-pixel-1.onrender.com").replace(/\/$/, "")
const KIOSK_BACKEND = (config.kioskBackendUrl  || "https://kiosk-backend-t1mi.onrender.com").replace(/\/$/, "")
const SECRET        = config.secret || "pixelprint-agent-2026"
const VERSION       = require("./package.json").version

const PRINTER1 = config.printer1 || null   // color / primary
const PRINTER2 = config.printer2 || null   // B&W (DX only)
const VARIANT  = PRINTER2 ? "DX" : "SX"

log.info(`PixelPrint Agent v${VERSION} | Kiosk: ${KIOSK_ID} | Backend: ${BACKEND}`)
log.info(`Variant: ${VARIANT} | Printer1: "${PRINTER1 || 'auto'}" | Printer2: ${PRINTER2 ? `"${PRINTER2}"` : 'N/A (SX)'}`)

// ── Version check ────────────────────────────────────────────────────────────
async function checkVersion() {
  try {
    const { data } = await axios.get(`${BACKEND}/api/agent/version`, { timeout: 5000 })
    if (data?.version && data.version !== VERSION) {
      log.warn(`Update available: ${VERSION} → ${data.version}. Run: git pull && pm2 restart pixelprint-agent`)
    }
  } catch (_) {}
}

// ── Socket.IO connection ─────────────────────────────────────────────────────

log.info(`Connecting to backend socket: ${BACKEND}`)

const socket = io(BACKEND, {
  auth: { kioskId: KIOSK_ID, secret: SECRET },
  reconnection: true,
  reconnectionDelay: 3000,
  reconnectionDelayMax: 15000,
  reconnectionAttempts: Infinity,
  timeout: 20000
})

socket.on("connect", () => {
  log.info(`Connected to backend | Socket ID: ${socket.id}`)
  socket.emit("kiosk:register", {
    kioskId: KIOSK_ID, version: VERSION,
    platform: process.platform, hostname: require("os").hostname()
  })
  checkVersion()
})
socket.on("connect_error", (err) => log.error(`Connection error: ${err.message}`))
socket.on("disconnect",    (r)   => log.warn(`Disconnected: ${r}`))
socket.on("reconnect",     (n)   => log.info(`Reconnected after ${n} attempt(s)`))

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

// ── Helpers ──────────────────────────────────────────────────────────────────

function emitProgress(printJobId, printerSlot, printerName, status, extra = {}) {
  socket.emit("print:printer_progress", {
    printJobId, printer: printerSlot, printerName,
    status, ...extra
  })
}

function countSheets(file) {
  const pageCount = file.pageCount || 1
  const copies    = file.printOptions?.copies || 1
  const duplex    = file.printOptions?.duplex === "double"
  const pages     = pageCount * copies
  return duplex ? Math.ceil(pages / 2) : pages
}

// ── Per-printer job runner ───────────────────────────────────────────────────
/**
 * Download, normalise, and print all files routed to one printer.
 * Runs entirely independently — safe to call with Promise.all for DX.
 *
 * @param {object} opts
 * @param {string}  opts.printJobId
 * @param {Array}   opts.files         — the subset of files for this printer
 * @param {string}  opts.printerName   — exact CUPS printer name
 * @param {string}  opts.printerSlot   — "printer1" | "printer2"
 * @returns {{ sheets: number, results: Array }}
 */
async function runPrinterGroup({ printJobId, files, printerName, printerSlot }) {
  const workDir   = printer.getWorkDir()
  const tempFiles = []
  const results   = []
  let   sheets    = 0

  const filesTotal = files.length

  for (let fi = 0; fi < files.length; fi++) {
    const file          = files[fi]
    const filesDone     = fi
    const pagesTotal    = (file.pageCount || 1) * (file.printOptions?.copies || 1)

    log.info(`[${printerSlot}] [${fi + 1}/${filesTotal}] ${file.originalName} → "${printerName}"`)

    // ── DOWNLOADING ────────────────────────────────────────────────────────
    emitProgress(printJobId, printerSlot, printerName, "DOWNLOADING", {
      filesDone, filesTotal, pagesDone: 0, pagesTotal,
      currentFile: file.originalName, error: null
    })

    let rawPath = null
    try {
      socket.emit("print:progress", { printJobId, status: "DOWNLOADING", fileIndex: fi })
      const response = await axios({
        method: "GET", url: file.url,
        responseType: "arraybuffer", timeout: 120_000
      })
      const safeName = file.originalName.replace(/[^a-zA-Z0-9._-]/g, "_")
      rawPath = path.join(workDir, `${Date.now()}_${safeName}`)
      fs.writeFileSync(rawPath, Buffer.from(response.data))
      tempFiles.push(rawPath)
      log.info(`  [${printerSlot}] Downloaded: ${path.basename(rawPath)}`)
    } catch (err) {
      log.error(`  [${printerSlot}] Download failed: ${err.message}`)
      emitProgress(printJobId, printerSlot, printerName, "FAILED", {
        filesDone, filesTotal, pagesDone: 0, pagesTotal,
        currentFile: file.originalName, error: `Download failed: ${err.message}`
      })
      results.push({ filename: file.originalName, success: false, error: `Download failed: ${err.message}` })
      continue
    }

    // ── PROCESSING (normalize PDF / convert image) ─────────────────────────
    let processedPath = null
    try {
      socket.emit("print:progress", { printJobId, status: "PROCESSING", fileIndex: fi })
      emitProgress(printJobId, printerSlot, printerName, "PROCESSING", {
        filesDone, filesTotal, pagesDone: 0, pagesTotal,
        currentFile: file.originalName, error: null
      })
      const isPdf   = /\.pdf$/i.test(file.originalName) || (file.mimeType || "").includes("pdf")
      const isImage = /\.(jpe?g|png|gif|webp|bmp)$/i.test(file.originalName)
      if (isPdf)        processedPath = await printer.normalizePdfToA4(rawPath)
      else if (isImage) processedPath = await printer.imageToA4Pdf(rawPath)
      else              processedPath = rawPath
      if (processedPath && processedPath !== rawPath) tempFiles.push(processedPath)
    } catch (err) {
      log.error(`  [${printerSlot}] Normalization failed: ${err.message}`)
      processedPath = rawPath
    }

    // ── PRINTING ───────────────────────────────────────────────────────────
    const finalPath = processedPath || rawPath
    socket.emit("print:progress", { printJobId, status: "PRINTING", fileIndex: fi })
    emitProgress(printJobId, printerSlot, printerName, "PRINTING", {
      filesDone, filesTotal, pagesDone: 0, pagesTotal,
      currentFile: file.originalName, error: null
    })

    try {
      const { jobId } = await printer.printFileToNamed(finalPath, printerName, file.printOptions)

      // ── Poll real CUPS status until the job finishes ─────────────────────
      if (jobId) {
        await printer.waitForCupsJob(jobId, {
          timeoutMs:   300_000,
          intervalMs:  1500,
          onStatus: ({ state, reason, active }) => {
            // Map CUPS state → UI status
            let uiStatus = "PRINTING"
            let uiError  = null

            if (state === "stopped" || state === "held") {
              uiStatus = "STOPPED"
              uiError  = reason || "Printer stopped — check printer panel"
            } else if (!active) {
              uiStatus = "COMPLETED"
            }

            emitProgress(printJobId, printerSlot, printerName, uiStatus, {
              filesDone, filesTotal,
              pagesDone: uiStatus === "COMPLETED" ? pagesTotal : null,
              pagesTotal,
              currentFile: uiStatus === "COMPLETED" ? null : file.originalName,
              error: uiError,
              cupsJobId: jobId,
              cupsState: state
            })
          }
        })
      }

      // Count sheets
      const fileSheets = countSheets(file)
      sheets += fileSheets
      results.push({ filename: file.originalName, success: true })
      log.info(`  [${printerSlot}] ✅ Done: ${file.originalName} (${fileSheets} sheets)`)

      // Emit final COMPLETED for this file
      const isLastFile = fi + 1 >= filesTotal
      emitProgress(printJobId, printerSlot, printerName,
        isLastFile ? "COMPLETED" : "PRINTING",
        {
          filesDone: fi + 1, filesTotal,
          pagesDone: pagesTotal, pagesTotal,
          currentFile: null, error: null
        }
      )

    } catch (err) {
      log.error(`  [${printerSlot}] Print failed: ${err.message}`)
      emitProgress(printJobId, printerSlot, printerName, "FAILED", {
        filesDone, filesTotal, pagesDone: 0, pagesTotal,
        currentFile: file.originalName, error: err.message
      })
      results.push({ filename: file.originalName, success: false, error: err.message })
    }
  }

  printer.cleanup(tempFiles)
  return { sheets, results }
}

// ── Print job handler ────────────────────────────────────────────────────────

let isProcessing = false

socket.on("print:job", async (job) => {
  const { printJobId, files, totalPages } = job

  if (isProcessing) {
    log.warn(`Job ${printJobId} received but agent is busy — rejecting (queue via backend)`)
    return
  }

  isProcessing = true
  log.info(`\n${"─".repeat(60)}`)
  log.info(`Print job received | ID: ${printJobId} | Files: ${files.length} | Pages: ${totalPages}`)

  // Acknowledge receipt
  socket.emit("print:ack", { printJobId, kioskId: KIOSK_ID })

  // ── Classify files: color vs B&W ─────────────────────────────────────────
  const colorFiles = files.filter(f => (f.printOptions?.colorMode || "bw") === "color")
  const bwFiles    = files.filter(f => (f.printOptions?.colorMode || "bw") !== "color")

  log.info(`[${VARIANT}] Routing: ${colorFiles.length} color → "${PRINTER1}" | ${bwFiles.length} B&W → "${VARIANT === "DX" ? PRINTER2 : PRINTER1}"`)

  // ── Build printer groups ──────────────────────────────────────────────────
  let groups = []

  if (VARIANT === "SX") {
    // SX: everything goes to printer1 sequentially
    groups = [{
      printerSlot: "printer1",
      printerName: PRINTER1,
      files:       files
    }]
  } else {
    // DX: color → printer1, B&W → printer2 — run both IN PARALLEL
    if (colorFiles.length > 0) {
      groups.push({ printerSlot: "printer1", printerName: PRINTER1, files: colorFiles })
    }
    if (bwFiles.length > 0) {
      groups.push({ printerSlot: "printer2", printerName: PRINTER2 || PRINTER1, files: bwFiles })
    }
    // Edge case: all files same color mode — both go to one printer
    if (groups.length === 0) {
      groups = [{ printerSlot: "printer1", printerName: PRINTER1, files }]
    }
  }

  // ── Emit initial QUEUED status for each printer group ────────────────────
  for (const g of groups) {
    emitProgress(printJobId, g.printerSlot, g.printerName, "QUEUED", {
      filesDone: 0, filesTotal: g.files.length,
      pagesDone: 0, pagesTotal: 0, currentFile: null, error: null
    })
  }

  // ── Run printer groups (parallel for DX) ─────────────────────────────────
  let allResults = []
  let sheetsP1   = 0
  let sheetsP2   = 0

  try {
    const groupResults = await Promise.all(
      groups.map(g => runPrinterGroup({ printJobId, ...g }))
    )

    for (let gi = 0; gi < groups.length; gi++) {
      const gr = groupResults[gi]
      allResults = allResults.concat(gr.results)
      if (groups[gi].printerSlot === "printer1") sheetsP1 += gr.sheets
      if (groups[gi].printerSlot === "printer2") sheetsP2 += gr.sheets
    }
  } catch (err) {
    log.error(`Fatal job error: ${err.message}`)
    allResults.push({ filename: "unknown", success: false, error: err.message })
  }

  // ── Report overall result ─────────────────────────────────────────────────
  const allOk = allResults.every(r => r.success)
  const anyOk = allResults.some(r => r.success)
  const status = allOk ? "COMPLETED" : anyOk ? "PARTIAL_FAILURE" : "FAILED"

  const failedResults = allResults.filter(r => !r.success)
  const failureReason = failedResults.length > 0
    ? failedResults.map(r => `${r.filename}: ${r.error || 'Unknown error'}`).join(" | ")
    : null

  socket.emit("print:result", {
    printJobId, kioskId: KIOSK_ID,
    success: allOk, status,
    results: allResults, failureReason
  })

  log.info(`\nJob ${printJobId} → ${status} | P1: −${sheetsP1} sheets | P2: −${sheetsP2} sheets`)
  log.info(`Results: ${allResults.filter(r => r.success).length}/${allResults.length} files OK`)

  // ── Update paper counts on KIOSK backend ─────────────────────────────────
  if (sheetsP1 > 0 || sheetsP2 > 0) {
    try {
      const kioskRes = await axios.get(
        `${KIOSK_BACKEND}/api/kiosk/${KIOSK_ID}`, { timeout: 10_000 }
      )
      const kiosk = kioskRes.data?.kiosk
      if (kiosk) {
        const curP1 = kiosk.printer1Paper ?? 250
        const curP2 = kiosk.printer2Paper ?? 250
        const newP1 = Math.max(0, curP1 - sheetsP1)
        const newP2 = Math.max(0, curP2 - sheetsP2)
        await axios.put(
          `${KIOSK_BACKEND}/api/kiosk/${KIOSK_ID}/paper`,
          { printer1Paper: newP1, printer2Paper: newP2 },
          { timeout: 10_000 }
        )
        log.info(`Paper updated → P1: ${curP1}→${newP1}  P2: ${curP2}→${newP2}`)
      }
    } catch (err) {
      log.warn(`Paper count update failed (non-fatal): ${err.message}`)
    }
  }

  isProcessing = false
  log.info(`${"─".repeat(60)}\n`)
})

// ── Remote restart ───────────────────────────────────────────────────────────

socket.on("agent:restart", () => {
  log.info("Remote restart command received")
  const { exec } = require("child_process")
  exec("pm2 restart pixelprint-agent", (err) => {
    if (err) { log.warn(`pm2 restart failed — falling back to process.exit`); process.exit(0) }
  })
})

// ── OTA self-update ──────────────────────────────────────────────────────────

socket.on("agent:update", async (data) => {
  const targetVersion = data?.version || "latest"
  log.info(`\n${"─".repeat(60)}`)
  log.info(`🔄 OTA Update received — pulling ${targetVersion}`)
  socket.emit("update:started", { kioskId: KIOSK_ID, version: VERSION })

  try {
    const { execSync } = require("child_process")
    execSync("git fetch origin", { cwd: __dirname, timeout: 60_000, encoding: "utf8" })
    const resetOutput = execSync("git reset --hard origin/main", { cwd: __dirname, timeout: 30_000, encoding: "utf8" }).trim()
    execSync("npm install --production", { cwd: __dirname, timeout: 120_000, encoding: "utf8" })

    log.info(`  ✅ Update complete: ${resetOutput}`)
    socket.emit("update:done", { kioskId: KIOSK_ID, success: true, previousVersion: VERSION, output: resetOutput })

    setTimeout(() => {
      const { exec } = require("child_process")
      exec("pm2 restart pixelprint-agent", (err) => {
        if (err) { log.warn(`pm2 restart failed — process.exit`); process.exit(0) }
      })
    }, 1200)
  } catch (err) {
    log.error(`  ❌ Update failed: ${err.message}`)
    socket.emit("update:done", { kioskId: KIOSK_ID, success: false, error: err.message })
  }
})

// ── Graceful shutdown ────────────────────────────────────────────────────────

process.on("SIGTERM", () => { log.info("SIGTERM — shutting down"); socket.disconnect(); process.exit(0) })
process.on("SIGINT",  () => { log.info("SIGINT — shutting down");  socket.disconnect(); process.exit(0) })
process.on("uncaughtException", (err) => {
  log.error(`Uncaught exception: ${err.message}`)
  log.error(err.stack)
})
