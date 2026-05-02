/**
 * agent.js — PixelPrint Print Agent
 * Polls both printers via IPP every 1 second.
 * Pipelines download+print so next file downloads while current prints.
 * DX: runs color (printer1) and B&W (printer2) groups in parallel.
 *
 * FIX: onStatus now maps specific IPP reason codes to specific UI statuses:
 *   PAPER_OUT, PAPER_JAM, COVER_OPEN, INK_EMPTY, OFFLINE, ERROR
 * instead of generic ERROR for everything.
 * Also reads printer-alert-description for human-readable messages.
 */

const fs = require("fs")
const path = require("path")
const axios = require("axios")
const { io } = require("socket.io-client")
const log = require("./logger")
const printer = require("./printer")

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG_PATH = process.env.CONFIG_PATH || "/etc/pixelprint/config.json"
const DEV_CONFIG = path.join(__dirname, "config.json")
let config
try {
  const f = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : DEV_CONFIG
  config = JSON.parse(fs.readFileSync(f, "utf8"))
  log.info(`Config: ${f}`)
} catch (e) { log.error(e.message); process.exit(1) }

const KIOSK_ID = config.kioskId
const BACKEND = (config.backendUrl || "https://printing-pixel-1.onrender.com").replace(/\/$/, "")
const KIOSK_BACKEND = (config.kioskBackendUrl || "https://kiosk-backend-t1mi.onrender.com").replace(/\/$/, "")
const SECRET = config.secret || "pixelprint-agent-2026"
const VERSION = require("./package.json").version
const PRINTER1 = config.printer1 || null
const PRINTER2 = config.printer2 || null
const PRINTER1_URL = config.printer1Url || null   // e.g. "ipp://172.21.12.37/ipp/print"
const PRINTER2_URL = config.printer2Url || null
const VARIANT = PRINTER2 ? "DX" : "SX"

log.info(`v${VERSION} | ${KIOSK_ID} | ${VARIANT} | P1:${PRINTER1}${PRINTER1_URL ? " (" + PRINTER1_URL + ")" : ""} | P2:${PRINTER2 || "N/A"}${PRINTER2_URL ? " (" + PRINTER2_URL + ")" : ""}`)

// ── Socket ────────────────────────────────────────────────────────────────────
const socket = io(BACKEND, {
  auth: { kioskId: KIOSK_ID, secret: SECRET },
  reconnection: true, reconnectionDelay: 3000, reconnectionDelayMax: 15000,
  reconnectionAttempts: Infinity, timeout: 20000
})

socket.on("connect", () => { log.info(`Socket connected: ${socket.id}`); socket.emit("kiosk:register", { kioskId: KIOSK_ID, version: VERSION, platform: process.platform, hostname: require("os").hostname() }) })
socket.on("connect_error", e => log.error(`Socket error: ${e.message}`))
socket.on("disconnect", r => log.warn(`Disconnected: ${r}`))
socket.on("reconnect", n => log.info(`Reconnected after ${n} tries`))

// ── Heartbeat ─────────────────────────────────────────────────────────────────
setInterval(() => {
  if (socket.connected) socket.emit("kiosk:heartbeat", { kioskId: KIOSK_ID, timestamp: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()) })
}, 30_000)

// ── IPP Printer Status — poll every 1 second ──────────────────────────────────
async function pollAllPrinters() {
  try {
    const [p1, p2] = await Promise.all([
      PRINTER1 ? printer.pollPrinterIPP(PRINTER1, PRINTER1_URL) : null,
      PRINTER2 ? printer.pollPrinterIPP(PRINTER2, PRINTER2_URL) : null,
    ])
    const printers = {}
    if (p1) printers.printer1 = { name: PRINTER1, url: PRINTER1_URL, ...p1 }
    if (p2) printers.printer2 = { name: PRINTER2, url: PRINTER2_URL, ...p2 }
    socket.emit("kiosk:printer_status", { kioskId: KIOSK_ID, printers, timestamp: new Date().toISOString() })
  } catch (e) {
    log.warn(`IPP poll error: ${e.message}`)
  }
}

// Start immediately, then every 1s
pollAllPrinters()
setInterval(pollAllPrinters, 1000)

// ── UI Status Mapper ──────────────────────────────────────────────────────────
/**
 * Maps IPP reason code → specific UI status string.
 *
 * These statuses are emitted in print:printer_progress so the frontend
 * can show the right message to the user:
 *
 *   "PRINTING"    → 🖨️ Printing your document...
 *   "PAPER_OUT"   → 🔴 Out of paper — please refill
 *   "PAPER_JAM"   → 🔴 Paper jam — please clear printer
 *   "COVER_OPEN"  → 🔴 Printer cover is open
 *   "INK_EMPTY"   → 🔴 Ink / Toner is empty
 *   "OFFLINE"     → 🔴 Printer is offline
 *   "COMPLETED"   → ✅ Done!
 *   "FAILED"      → ❌ Print failed
 *   "ERROR"       → 🔴 Printer error — check printer
 */
function mapCodeToUiStatus(code) {
  if (!code) return "ERROR"
  const c = code.toLowerCase()

  if (c.includes("media-empty") || c.includes("media-needed") || c === "input-tray-missing")
    return "PAPER_OUT"

  if (c.includes("media-jam"))
    return "PAPER_JAM"

  if (c === "cover-open" || c === "door-open")
    return "COVER_OPEN"

  if (c.includes("marker-supply-empty") || c.includes("toner-empty") || c.includes("marker-waste-full"))
    return "INK_EMPTY"

  if (c === "offline-report" || c === "offline" || c === "shutdown")
    return "OFFLINE"

  return "ERROR"
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function emitPP(printJobId, printerSlot, printerName, status, extra = {}) {
  socket.emit("print:printer_progress", { printJobId, printer: printerSlot, printerName, status, ...extra })
}

function countSheets(file) {
  const pages = (file.pageCount || 1) * (file.printOptions?.copies || 1)
  return file.printOptions?.duplex === "double" ? Math.ceil(pages / 2) : pages
}

// ── Download + normalize a single file ───────────────────────────────────────
async function prepareFile(file, workDir, tempFiles) {
  const response = await axios({ method: "GET", url: file.url, responseType: "arraybuffer", timeout: 120_000 })
  const safeName = file.originalName.replace(/[^a-zA-Z0-9._-]/g, "_")
  const rawPath = path.join(workDir, `${Date.now()}_${safeName}`)
  fs.writeFileSync(rawPath, Buffer.from(response.data))
  tempFiles.push(rawPath)

  const isPdf = /\.pdf$/i.test(file.originalName) || (file.mimeType || "").includes("pdf")
  const isImage = /\.(jpe?g|png|gif|webp|bmp)$/i.test(file.originalName)
  let processedPath = rawPath
  if (isPdf) processedPath = await printer.normalizePdfToA4(rawPath)
  else if (isImage) processedPath = await printer.imageToA4Pdf(rawPath)
  if (processedPath !== rawPath) tempFiles.push(processedPath)
  return processedPath
}

// ── Per-printer pipeline: download next while current prints ──────────────────
async function runPrinterGroup({ printJobId, files, printerName, printerSlot, printerUrl }) {
  const workDir = printer.getWorkDir()
  const tempFiles = []
  const results = []
  let sheets = 0
  const filesTotal = files.length

  // Emit QUEUED for all files upfront so frontend knows total count
  emitPP(printJobId, printerSlot, printerName, "QUEUED", {
    filesDone: 0, filesTotal, pagesDone: 0, pagesTotal: 0,
    currentFile: null, error: null
  })

  // Start downloading file[0] immediately
  let nextPreparePromise = prepareFile(files[0], workDir, tempFiles)
    .catch(e => { throw new Error(`Download failed: ${e.message}`) })

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const pagesTotal = (file.pageCount || 1) * (file.printOptions?.copies || 1)

    // Wait for current file to be ready
    let processedPath
    try {
      processedPath = await nextPreparePromise
    } catch (err) {
      log.error(`[${printerSlot}] Prepare failed [${i}]: ${err.message}`)
      if (i + 1 < files.length) {
        nextPreparePromise = prepareFile(files[i + 1], workDir, tempFiles)
          .catch(e => { throw new Error(`Download failed: ${e.message}`) })
      }
      emitPP(printJobId, printerSlot, printerName, "FAILED", {
        filesDone: i, filesTotal, pagesTotal,
        currentFile: file.originalName, error: err.message
      })
      results.push({ filename: file.originalName, success: false, error: err.message })
      continue
    }

    // File is ready — immediately kick off download of next file in parallel
    if (i + 1 < files.length) {
      nextPreparePromise = prepareFile(files[i + 1], workDir, tempFiles)
        .catch(e => { throw new Error(`Download failed: ${e.message}`) })
    }

    // Emit PRINTING (user sees this — not "downloading")
    emitPP(printJobId, printerSlot, printerName, "PRINTING", {
      filesDone: i, filesTotal, pagesDone: 0, pagesTotal,
      currentFile: file.originalName, error: null
    })

    // Submit to CUPS and poll live status
    try {
      const { jobId } = await printer.printFileToNamed(processedPath, printerName, file.printOptions)

      if (jobId) {
        await printer.waitForCupsJob(jobId, {
          timeoutMs: 300_000,
          intervalMs: 1000,
          printerName: printerName,
          printerUrl: printerUrl,    // FIX: pass LAN URL so IPP polling uses direct printer IP
          onStatus: ({ state, reason, code, active, alertDescription, inkLevels, inkColors }) => {
            // ── FIX: Map specific IPP codes to specific UI statuses ────────
            let uiStatus = "PRINTING"
            let uiError = null

            if (!active) {
              // Job left the queue — it's done
              uiStatus = "COMPLETED"
            } else if (state === "stopped" || state === "held") {
              // Map specific hardware issue → specific UI status
              uiStatus = mapCodeToUiStatus(code)
              // Use printer-alert-description if available (most human-readable)
              // e.g. Epson sends "paper out" as alert-description
              uiError = alertDescription || reason || "Printer error — check printer panel"
            }

            log.debug(`[${printerSlot}] onStatus: state=${state} code=${code} uiStatus=${uiStatus}`)

            emitPP(printJobId, printerSlot, printerName, uiStatus, {
              filesDone: i,
              filesTotal,
              pagesTotal,
              currentFile: uiStatus === "COMPLETED" ? null : file.originalName,
              error: uiError,
              errorCode: code || null,
              cupsJobId: jobId,
              cupsState: state,
              // FIX: Also emit ink levels with every status update
              inkLevels: inkLevels || [],
              inkColors: inkColors || [],
            })
          }
        })
      }

      sheets += countSheets(file)
      results.push({ filename: file.originalName, success: true })
      log.info(`[${printerSlot}] ✅ ${file.originalName}`)

      emitPP(printJobId, printerSlot, printerName,
        i + 1 >= filesTotal ? "COMPLETED" : "PRINTING",
        { filesDone: i + 1, filesTotal, pagesDone: pagesTotal, pagesTotal, currentFile: null, error: null }
      )
    } catch (err) {
      log.error(`[${printerSlot}] Print failed: ${err.message}`)
      emitPP(printJobId, printerSlot, printerName, "FAILED", {
        filesDone: i, filesTotal, pagesTotal,
        currentFile: file.originalName, error: err.message
      })
      results.push({ filename: file.originalName, success: false, error: err.message })
    }
  }

  printer.cleanup(tempFiles)
  return { sheets, results }
}

// ── Print job handler ─────────────────────────────────────────────────────────
let isProcessing = false

socket.on("print:job", async (job) => {
  if (isProcessing) { log.warn(`Job ${job.printJobId} received but busy`); return }
  isProcessing = true

  const { printJobId, files } = job
  log.info(`\n${"─".repeat(60)}\nJob ${printJobId} | ${files.length} files`)
  socket.emit("print:ack", { printJobId, kioskId: KIOSK_ID })

  const colorFiles = files.filter(f => (f.printOptions?.colorMode || "bw") === "color")
  const bwFiles = files.filter(f => (f.printOptions?.colorMode || "bw") !== "color")

  const groups = VARIANT === "SX"
    ? [{ printerSlot: "printer1", printerName: PRINTER1, printerUrl: PRINTER1_URL, files }]
    : [
      ...(colorFiles.length > 0 ? [{ printerSlot: "printer1", printerName: PRINTER1, printerUrl: PRINTER1_URL, files: colorFiles }] : []),
      ...(bwFiles.length > 0 ? [{ printerSlot: "printer2", printerName: PRINTER2 || PRINTER1, printerUrl: PRINTER2_URL || PRINTER1_URL, files: bwFiles }] : []),
    ].filter(Boolean)

  if (groups.length === 0) groups.push({ printerSlot: "printer1", printerName: PRINTER1, printerUrl: PRINTER1_URL, files })

  let allResults = [], sheetsP1 = 0, sheetsP2 = 0
  try {
    const groupResults = await Promise.all(groups.map(g => runPrinterGroup({ printJobId, ...g })))
    groups.forEach((g, gi) => {
      allResults = allResults.concat(groupResults[gi].results)
      if (g.printerSlot === "printer1") sheetsP1 += groupResults[gi].sheets
      if (g.printerSlot === "printer2") sheetsP2 += groupResults[gi].sheets
    })
  } catch (e) {
    log.error(`Fatal: ${e.message}`)
    allResults.push({ filename: "unknown", success: false, error: e.message })
  }

  const allOk = allResults.every(r => r.success)
  const anyOk = allResults.some(r => r.success)
  const status = allOk ? "COMPLETED" : anyOk ? "PARTIAL_FAILURE" : "FAILED"
  const failureReason = allResults.filter(r => !r.success).map(r => `${r.filename}: ${r.error}`).join(" | ") || null

  socket.emit("print:result", { printJobId, kioskId: KIOSK_ID, success: allOk, status, results: allResults, failureReason })
  log.info(`Job ${printJobId} → ${status}`)

  // Update paper counts
  if (sheetsP1 > 0 || sheetsP2 > 0) {
    try {
      const { data } = await axios.get(`${KIOSK_BACKEND}/api/kiosk/${KIOSK_ID}`, { timeout: 10_000 })
      const kiosk = data?.kiosk
      if (kiosk) {
        await axios.put(`${KIOSK_BACKEND}/api/kiosk/${KIOSK_ID}/paper`, {
          printer1Paper: Math.max(0, (kiosk.printer1Paper ?? 250) - sheetsP1),
          printer2Paper: Math.max(0, (kiosk.printer2Paper ?? 250) - sheetsP2),
        }, { timeout: 10_000 })
      }
    } catch (e) { log.warn(`Paper update failed: ${e.message}`) }
  }

  isProcessing = false
  log.info(`${"─".repeat(60)}\n`)
})

// ── Remote restart / OTA ──────────────────────────────────────────────────────
socket.on("agent:restart", () => {
  const { exec } = require("child_process")
  exec("pm2 restart pixelprint-agent", e => { if (e) process.exit(0) })
})

socket.on("agent:update", async (data) => {
  socket.emit("update:started", { kioskId: KIOSK_ID, version: VERSION })
  try {
    const { execSync } = require("child_process")
    execSync("git fetch origin", { cwd: __dirname, timeout: 60_000 })
    const out = execSync("git reset --hard origin/main", { cwd: __dirname, timeout: 30_000, encoding: "utf8" }).trim()
    execSync("npm install --production", { cwd: __dirname, timeout: 120_000 })
    socket.emit("update:done", { kioskId: KIOSK_ID, success: true, previousVersion: VERSION, output: out })
    setTimeout(() => { require("child_process").exec("pm2 restart pixelprint-agent", e => { if (e) process.exit(0) }) }, 1200)
  } catch (e) {
    socket.emit("update:done", { kioskId: KIOSK_ID, success: false, error: e.message })
  }
})

// ── Retry job on a printer (cupsenable + resubmit) ───────────────────────────
socket.on("print:retry_job", async ({ printJobId, printerSlot }) => {
  const printerName = printerSlot === "printer2" ? PRINTER2 : PRINTER1
  if (!printerName) return
  log.info(`Retry requested for ${printerName}`)
  try {
    const { execFile } = require("child_process")
    await new Promise(r => execFile("cupsenable", [printerName], () => r()))
    log.info(`cupsenable ${printerName} done`)
    socket.emit("print:retry_ack", { printJobId, printerSlot, kioskId: KIOSK_ID })
  } catch (e) {
    log.warn(`cupsenable failed: ${e.message}`)
  }
})

process.on("SIGTERM", () => { socket.disconnect(); process.exit(0) })
process.on("SIGINT", () => { socket.disconnect(); process.exit(0) })
process.on("uncaughtException", e => { log.error(e.message); log.error(e.stack) })










