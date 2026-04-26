/**
 * printer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles PDF normalization (Ghostscript), image conversion (ImageMagick),
 * and print submission (CUPS lp on Linux / SumatraPDF + pdf-to-printer on Windows).
 */

const fs            = require("fs")
const path          = require("path")
const os            = require("os")
const { exec, execFile } = require("child_process")
const log           = require("./logger")

// ── Working directory ────────────────────────────────────────────────────────

function getWorkDir() {
  const dir = path.join(os.tmpdir(), "pixelprint_downloads")
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ── Ghostscript detection ────────────────────────────────────────────────────

async function findGhostscript() {
  const candidates = process.platform === "win32"
    ? ["gswin64c", "gswin32c", "gs"]
    : ["gs"]

  for (const cmd of candidates) {
    const found = await new Promise(resolve => {
      exec(`${cmd} --version`, (err) => resolve(!err))
    })
    if (found) return cmd
  }
  return null
}

// ── PDF normalization ────────────────────────────────────────────────────────

async function normalizePdfToA4(inputPath) {
  const gsCmd = await findGhostscript()
  if (!gsCmd) {
    log.warn(`Ghostscript not found — skipping normalization. Install: sudo apt install ghostscript`)
    return inputPath
  }

  const outputPath = inputPath.replace(/\.pdf$/i, "_A4.pdf")

  const args = [
    "-dBATCH", "-dNOPAUSE", "-dQUIET",
    "-sDEVICE=pdfwrite",
    "-sPAPERSIZE=a4",
    "-dFIXEDMEDIA",
    "-dPDFFitPage",
    "-dAutoRotatePages=/PageByPage",
    `-sOutputFile=${outputPath}`,
    inputPath
  ]

  log.info(`Normalizing PDF → A4: ${path.basename(inputPath)}`)

  return new Promise((resolve) => {
    execFile(gsCmd, args, (err, _stdout, stderr) => {
      if (err || !fs.existsSync(outputPath)) {
        log.warn(`Ghostscript failed: ${stderr || err?.message}. Using original.`)
        resolve(inputPath)
      } else {
        log.info(`Normalized → ${path.basename(outputPath)}`)
        resolve(outputPath)
      }
    })
  })
}

// ── Image → A4 PDF conversion ────────────────────────────────────────────────

async function imageToA4Pdf(inputPath) {
  const outputPath = inputPath + "_A4.pdf"

  log.info(`Converting image → A4 PDF: ${path.basename(inputPath)}`)

  return new Promise((resolve) => {
    execFile("convert", ["-page", "A4", "-gravity", "Center", "-background", "white", inputPath, outputPath], (err) => {
      if (err || !fs.existsSync(outputPath)) {
        log.warn(`ImageMagick unavailable — printing image directly. Install: sudo apt install imagemagick`)
        resolve(inputPath)
      } else {
        log.info(`Converted → ${path.basename(outputPath)}`)
        resolve(outputPath)
      }
    })
  })
}

// ── CUPS printer detection ───────────────────────────────────────────────────

function getCupsPrinter() {
  return new Promise(resolve => {
    execFile("lpstat", ["-a"], (err, stdout) => {
      const lines = (stdout || "").trim().split("\n").filter(Boolean)
      const name  = lines.length > 0 ? lines[0].split(" ")[0].trim() : null
      if (!name) log.warn("lpstat found no printers in CUPS.")
      resolve(name || null)
    })
  })
}

// ── Page range helper ────────────────────────────────────────────────────────

function buildPageRangeArgs(pageRange) {
  if (!pageRange || pageRange === "all" || pageRange.trim() === "") return []
  return ["-o", `page-ranges=${pageRange.trim()}`]
}

// ── CUPS job state parser ────────────────────────────────────────────────────
/**
 * Poll the state of a specific CUPS job by ID.
 * Returns { state, reason } where state is one of:
 *   "pending" | "processing" | "stopped" | "held" | "completed" | "unknown"
 * and reason is the human-readable CUPS reason string (e.g. "media-empty").
 */
async function pollCupsJobState(jobId) {
  if (!jobId) return { state: "unknown", reason: null }

  return new Promise(resolve => {
    // lpstat -o lists all active jobs; if the job ID appears, it's still running
    execFile("lpstat", ["-o"], (_err, stdout) => {
      const lines = (stdout || "").split("\n")
      const jobLine = lines.find(l => l.includes(jobId))

      if (!jobLine) {
        // Job no longer in active queue — it's done (completed or cancelled)
        resolve({ state: "completed", reason: null })
        return
      }

      // Parse the status column from lpstat -o output:
      // Format: "PRINTER-42   user  size  date  time  title"
      // State is embedded in the job attributes via lpstat -l
      resolve({ state: "processing", reason: null })
    })
  })
}

/**
 * Extended CUPS job info from `lpstat -l -j <jobId>` output.
 * Parses Job-state-reasons to detect error conditions.
 */
async function getCupsJobInfo(jobId) {
  if (!jobId) return { state: "unknown", reason: null, active: false }

  return new Promise(resolve => {
    // First check if it's still in the queue at all
    execFile("lpstat", ["-o"], (_err, stdout) => {
      // lpstat -o format: "PRINTERNAME-JOBNUMBER  user  size  date  time"
      // jobId may be full "PRINTER-42" or just "42" — handle both
      const active = (stdout || "").split("\n").some(l => {
        const parts = l.trim().split(/\s+/)
        const col0  = parts[0] || ""
        return col0 === String(jobId) || col0.endsWith(`-${jobId}`)
      })

      if (!active) {
        resolve({ state: "completed", reason: null, active: false })
        return
      }

      // Job is active — get detailed state from lpstat -l
      execFile("lpstat", ["-l", "-o"], (_e2, out2) => {
        const raw = (out2 || "").toLowerCase()
        let reason = null
        let state  = "processing"

        // Detect common CUPS error reasons
        if (raw.includes("media-empty") || raw.includes("media-needed") || raw.includes("tray-missing"))
          reason = "Paper Out — Please refill the tray"
        else if (raw.includes("toner-empty") || raw.includes("marker-supply-empty"))
          reason = "Toner/Ink Empty"
        else if (raw.includes("cover-open") || raw.includes("door-open"))
          reason = "Printer cover/door is open"
        else if (raw.includes("offline") || raw.includes("connecting-to-device"))
          reason = "Printer offline or not responding"
        else if (raw.includes("jammed") || raw.includes("paper-jam"))
          reason = "Paper jam — please clear the printer"
        else if (raw.includes("stopped") || raw.includes("paused"))
          reason = "Printer stopped — check printer panel"

        if (reason) state = "stopped"

        resolve({ state, reason, active: true })
      })
    })
  })
}

// ── CUPS job completion waiter with real status polling ──────────────────────
/**
 * Wait for a CUPS job to finish, polling every `intervalMs`.
 * Calls `onStatus({ state, reason })` on each poll for live reporting.
 * Returns when the job disappears from the active queue (done/cancelled/failed).
 */
async function waitForCupsJob(jobId, { timeoutMs = 300_000, intervalMs = 1000, onStatus, printerName } = {}) {
  if (!jobId) return { state: "completed", reason: null }

  log.info(`  Polling CUPS job: ${jobId} on printer: ${printerName || "unknown"}`)
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    // Poll both job state AND printer IPP state simultaneously
    const [info, pStatus] = await Promise.all([
      getCupsJobInfo(jobId),
      printerName ? pollPrinterIPP(printerName) : Promise.resolve(null)
    ])

    // Hardware errors ALWAYS win over job state
    if (pStatus) {
      const hardwareErrors = pStatus.stateReasons.filter(r => r.severity === "error" && r.code !== "none")
      if (hardwareErrors.length > 0) {
        const worst = hardwareErrors[0]
        info.state  = "stopped"
        info.reason = worst.label
        info.code   = worst.code
        info.active = true   // job is waiting, blocked by hardware
        log.warn(`  Printer error detected: ${worst.code} — ${worst.label}`)
      }
    }

    if (onStatus) onStatus(info)

    if (!info.active) {
      log.info(`  CUPS job ${jobId} finished (${info.state}) ✔`)
      return info
    }

    await new Promise(r => setTimeout(r, intervalMs))
  }

  log.warn(`  CUPS job ${jobId} timed out after ${timeoutMs / 1000}s`)
  return { state: "timeout", reason: "Print job timed out", active: false }
}

// ── SumatraPDF print (Windows) ───────────────────────────────────────────────

function trySumatraPrint(filePath, printerName, copies) {
  return new Promise(resolve => {
    const sumatraPaths = [
      "C:\\Program Files\\SumatraPDF\\SumatraPDF.exe",
      "C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe",
    ]
    const sumatraExe = sumatraPaths.find(p => fs.existsSync(p))
    if (!sumatraExe) {
      log.info("SumatraPDF not found — falling back to pdf-to-printer.")
      return resolve(false)
    }

    const settings = `paper=A4,fit,copies=${copies}`
    const cmd = `"${sumatraExe}" -print-to "${printerName}" -print-settings "${settings}" "${filePath}"`
    log.info(`SumatraPDF: ${cmd}`)

    exec(cmd, (err) => {
      if (err) { log.warn(`SumatraPDF failed: ${err.message}`); resolve(false) }
      else { log.info("SumatraPDF print submitted."); resolve(true) }
    })
  })
}

// ── Main print function (auto-detect printer) ────────────────────────────────

async function printFile(filePath, printOptions) {
  const opts    = printOptions || {}
  const copies  = Math.max(1, parseInt(opts.copies) || 1)
  const isBW    = opts.colorMode !== "color"
  const duplex  = opts.duplex === "double"
  const prArgs  = buildPageRangeArgs(opts.pageRange)

  log.info(`Printing: ${path.basename(filePath)} | Copies:${copies} | BW:${isBW} | Duplex:${duplex}`)

  // ── Windows ──────────────────────────────────────────────────────────────
  if (process.platform === "win32") {
    let pdfToPrinter
    try { pdfToPrinter = require("pdf-to-printer") } catch (_) {
      throw new Error("pdf-to-printer not installed. Run: npm install pdf-to-printer")
    }

    let printers = []
    try { printers = await pdfToPrinter.getPrinters() } catch (e) {
      log.warn(`Failed to list printers: ${e.message}`)
    }

    const virtualKeywords = [
      "pdf", "xps", "onenote", "fax", "writer", "virtual",
      "microsoft print", "adobe", "nitro", "foxit", "cute",
      "dopdf", "primopdf", "bluebeam", "software", "soda"
    ]
    const validPrinters = printers.filter(p => {
      const name = (p.deviceId || p.name || "").toLowerCase()
      return !virtualKeywords.some(kw => name.includes(kw))
    })

    if (validPrinters.length === 0) {
      log.warn("No physical printer detected — simulating.")
      await new Promise(r => setTimeout(r, 1500))
      return { jobId: null }
    }

    const printerName = validPrinters[0].deviceId || validPrinters[0].name
    log.info(`Using printer: ${printerName}`)

    const sumatraOk = await trySumatraPrint(filePath, printerName, copies)
    if (sumatraOk) return { jobId: null }

    await pdfToPrinter.print(filePath, { printer: printerName, copies })
    log.info(`Print submitted (pdf-to-printer): ${path.basename(filePath)}`)
    return { jobId: null }
  }

  // ── Linux / macOS — CUPS lp ───────────────────────────────────────────────
  const printerName = await getCupsPrinter()
  if (!printerName) {
    throw new Error("No CUPS printer found. Add a printer via: sudo system-config-printer")
  }

  return printFileToNamed(filePath, printerName, printOptions)
}


// ── Print to explicitly-named printer (SX/DX routing) ────────────────────────

/**
 * Print a file to a SPECIFIC named CUPS printer.
 * Returns { jobId } — the CUPS job ID string (e.g. "EPSON_L6460_Series_USB_3-42")
 * The caller is responsible for waiting/polling using waitForCupsJob().
 */
async function printFileToNamed(filePath, printerName, printOptions) {
  const opts    = printOptions || {}
  const copies  = Math.max(1, parseInt(opts.copies) || 1)
  const isBW    = opts.colorMode !== "color"
  const duplex  = opts.duplex === "double"
  const prArgs  = buildPageRangeArgs(opts.pageRange)

  log.info(`Routing to printer: "${printerName}" | Copies:${copies} | BW:${isBW} | Duplex:${duplex}`)

  // ── Windows ──────────────────────────────────────────────────────────────
  if (process.platform === "win32") {
    let pdfToPrinter
    try { pdfToPrinter = require("pdf-to-printer") } catch (_) {
      throw new Error("pdf-to-printer not installed. Run: npm install pdf-to-printer")
    }

    const sumatraOk = await trySumatraPrint(filePath, printerName, copies)
    if (sumatraOk) return { jobId: null }

    await pdfToPrinter.print(filePath, { printer: printerName, copies })
    log.info(`Print submitted (pdf-to-printer) → "${printerName}": ${path.basename(filePath)}`)
    return { jobId: null }
  }

  // ── Linux / macOS — CUPS lp via execFile ────────────────────────────────
  // Build argument array — NO shell quoting needed with execFile
  const lpArgs = [
    "-d", printerName,
    "-n", String(copies),
    "-o", "media=A4",
    "-o", "fit-to-page",
    "-o", duplex ? "sides=two-sided-long-edge" : "sides=one-sided",
  ]

  // Grayscale: use print-color-mode which is supported by IPP/CUPS 2.x
  if (isBW) lpArgs.push("-o", "print-color-mode=monochrome")

  // Page range
  lpArgs.push(...prArgs)

  // File MUST be the last argument
  lpArgs.push(filePath)

  log.info(`lp ${lpArgs.join(" ")}`)

  return new Promise((resolve, reject) => {
    execFile("lp", lpArgs, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr ? stderr.trim() : error.message
        log.error(`lp error for "${printerName}": ${detail}`)
        reject(new Error(`Print failed on "${printerName}": ${detail}`))
        return
      }

      const out = (stdout || "").trim()
      log.info(`Submitted → "${printerName}": ${path.basename(filePath)} | ${out}`)

      // Extract CUPS job ID: "request id is PRINTER_NAME-42 (1 file(s))"
      const jobId = (out.match(/request id is (\S+)/) || [])[1] || null
      log.info(`  CUPS job ID: ${jobId || "(unknown)"}`)

      resolve({ jobId })
    })
  })
}


// ── Safe file cleanup ────────────────────────────────────────────────────────

function cleanup(filePaths) {
  for (const f of filePaths) {
    try {
      if (f && fs.existsSync(f)) {
        fs.unlinkSync(f)
        log.debug(`Cleaned: ${path.basename(f)}`)
      }
    } catch (_) {}
  }
}

// ── IPP Printer Status Poll ───────────────────────────────────────────────────
// Uses ipptool to query live CUPS printer attributes every second.
// Returns a rich status object for the frontend.

const CUPS_STATE_REASON_MAP = {
  // Paper
  "none":                    { label: "All Good",              severity: "ok"      },
  "media-empty":             { label: "Out of Paper",           severity: "error"   },
  "media-empty-warning":     { label: "Paper Low",              severity: "warning" },
  "media-needed":            { label: "Load Paper",             severity: "error"   },
  "media-jam":               { label: "Paper Jam",              severity: "error"   },
  "media-low":               { label: "Paper Running Low",      severity: "warning" },
  "input-tray-missing":      { label: "Paper Tray Missing",     severity: "error"   },
  "output-tray-missing":     { label: "Output Tray Missing",    severity: "error"   },
  // Ink / Toner
  "marker-supply-empty":     { label: "Ink / Toner Empty",      severity: "error"   },
  "marker-supply-low":       { label: "Ink / Toner Low",        severity: "warning" },
  "marker-waste-full":       { label: "Waste Ink Box Full",     severity: "error"   },
  "toner-empty":             { label: "Toner Empty",            severity: "error"   },
  "toner-low":               { label: "Toner Low",              severity: "warning" },
  // Hardware
  "cover-open":              { label: "Cover Open",             severity: "error"   },
  "door-open":               { label: "Door Open",              severity: "error"   },
  // Connectivity
  "offline-report":          { label: "Printer Offline",        severity: "error"   },
  "offline":                 { label: "Printer Offline",        severity: "error"   },
  "connecting-to-device":    { label: "Connecting…",            severity: "warning" },
  // State
  "stopped":                 { label: "Printer Stopped",        severity: "error"   },
  "paused":                  { label: "Printer Paused",         severity: "warning" },
  "shutdown":                { label: "Printer Off",            severity: "error"   },
}

const IPP_TEST_PATHS = [
  "/usr/share/cups/ipptool/get-printer-attributes.test",
  "/usr/share/ipptool/get-printer-attributes.test",
  "/usr/lib/cups/ipptool/get-printer-attributes.test",
]

let _ippTestFile = null
function findIppTestFile() {
  if (_ippTestFile) return _ippTestFile
  for (const p of IPP_TEST_PATHS) {
    if (fs.existsSync(p)) { _ippTestFile = p; return p }
  }
  return null
}

async function pollPrinterIPP(printerName) {
  const offline = {
    online: false, state: "stopped",
    stateReasons: [{ code: "offline-report", label: "Printer Offline", severity: "error" }],
    inkLevels: [], jobsInQueue: 0
  }

  const testFile = findIppTestFile()
  if (!testFile) {
    log.warn("ipptool test file not found — falling back to lpstat")
    return pollPrinterLpstat(printerName)
  }

  const ippUrl = `ipp://localhost/printers/${printerName}`

  return new Promise(resolve => {
    execFile("ipptool", ["-t", ippUrl, testFile], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout || stdout.includes("FAIL")) {
        resolve(offline)
        return
      }

      // printer-state: CUPS returns integers OR strings
      // 3 = idle, 4 = processing, 5 = stopped
      const stateMatch = stdout.match(/printer-state\s*[=(]\s*(\w+)/)
      const rawState   = stateMatch ? stateMatch[1].toLowerCase() : "unknown"
      const state = (rawState === "3" || rawState === "idle")         ? "idle"
                  : (rawState === "4" || rawState === "processing")   ? "processing"
                  : (rawState === "5" || rawState === "stopped")      ? "stopped"
                  : "unknown"

      // printer-state-reasons (can be comma-separated)
      const reasonsMatch = stdout.match(/printer-state-reasons\s*[=(]\s*(.+)/)
      const reasonCodes  = reasonsMatch
        ? reasonsMatch[1].trim().split(/[,\s]+/).map(r => r.trim().toLowerCase()).filter(Boolean)
        : ["none"]
      const stateReasons = reasonCodes.map(code => ({
        code,
        label:    (CUPS_STATE_REASON_MAP[code] || CUPS_STATE_REASON_MAP["none"]).label,
        severity: (CUPS_STATE_REASON_MAP[code] || { severity: "ok" }).severity,
      }))

      // marker-levels: comma-separated integers (ink/toner %)
      const inkMatch  = stdout.match(/marker-levels\s*[=(]\s*(.+)/)
      const inkLevels = inkMatch
        ? inkMatch[1].trim().split(",").map(v => parseInt(v.trim(), 10)).filter(n => !isNaN(n) && n >= 0)
        : []

      // marker-names: identifies ink colors (Cyan, Magenta, Yellow, Black)
      const inkNamesMatch = stdout.match(/marker-names\s*[=(]\s*(.+)/)
      const inkColors = inkNamesMatch
        ? inkNamesMatch[1].trim().split(",").map(v => v.trim().replace(/^'|\'$/g, ""))
        : inkLevels.length === 4 ? ["Cyan", "Magenta", "Yellow", "Black"] : ["Toner"]

      // queued-job-count
      const jobsMatch  = stdout.match(/queued-job-count\s*[=(]\s*(\d+)/)
      const jobsInQueue = jobsMatch ? parseInt(jobsMatch[1], 10) : 0

      const hasError = stateReasons.some(r => r.severity === "error" && r.code !== "none")
      // online = printer is reachable and not in a hard error state
      const online = !hasError && state !== "stopped"

      resolve({ online, state, stateReasons, inkLevels, inkColors, jobsInQueue })
    })
  })
}

// Fallback: use lpstat if ipptool is unavailable
async function pollPrinterLpstat(printerName) {
  return new Promise(resolve => {
    execFile("lpstat", ["-p", printerName], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve({ online: false, state: "stopped", stateReasons: [{ code: "offline-report", label: "Printer Offline", severity: "error" }], inkLevels: [], jobsInQueue: 0 })
        return
      }
      const online = stdout.toLowerCase().includes("enabled")
      resolve({ online, state: online ? "idle" : "stopped", stateReasons: [{ code: "none", label: "All Good", severity: "ok" }], inkLevels: [], jobsInQueue: 0 })
    })
  })
}

module.exports = {
  getWorkDir,
  normalizePdfToA4,
  imageToA4Pdf,
  printFile,
  printFileToNamed,
  waitForCupsJob,
  getCupsJobInfo,
  pollPrinterIPP,
  CUPS_STATE_REASON_MAP,
  cleanup
}
