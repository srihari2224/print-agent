/**
 * printer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles PDF normalization (Ghostscript), image conversion (ImageMagick),
 * and print submission (CUPS lp on Linux / SumatraPDF + pdf-to-printer on Windows).
 *
 * Ported from KIOSK/frontend/src/main/main.js — now runs as a standalone service.
 */

const fs   = require("fs")
const path = require("path")
const os   = require("os")
const { exec } = require("child_process")
const log  = require("./logger")

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

/**
 * Normalize a PDF to A4 using Ghostscript.
 * Returns the output path, or the original path if GS is unavailable.
 */
async function normalizePdfToA4(inputPath) {
  const gsCmd = await findGhostscript()
  if (!gsCmd) {
    log.warn(`Ghostscript not found — skipping normalization. Install: sudo apt install ghostscript`)
    return inputPath
  }

  const outputPath = inputPath.replace(/\.pdf$/i, "_A4.pdf")

  const args = [
    gsCmd,
    "-dBATCH",
    "-dNOPAUSE",
    "-dQUIET",
    "-sDEVICE=pdfwrite",
    "-sPAPERSIZE=a4",
    "-dFIXEDMEDIA",
    "-dPDFFitPage",
    "-dAutoRotatePages=/PageByPage",
    `-sOutputFile="${outputPath}"`,
    `"${inputPath}"`
  ].join(" ")

  log.info(`Normalizing PDF → A4: ${path.basename(inputPath)}`)

  return new Promise((resolve) => {
    exec(args, (err, _stdout, stderr) => {
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

/**
 * Convert an image (JPG/PNG/etc) to A4 PDF using ImageMagick.
 * Falls back to original path if ImageMagick is not installed.
 */
async function imageToA4Pdf(inputPath) {
  const outputPath = inputPath + "_A4.pdf"

  const args = [
    "convert",
    "-page", "A4",
    "-gravity", "Center",
    "-background", "white",
    `"${inputPath}"`,
    `"${outputPath}"`
  ].join(" ")

  log.info(`Converting image → A4 PDF: ${path.basename(inputPath)}`)

  return new Promise((resolve) => {
    exec(args, (err) => {
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
    exec("lpstat -a 2>/dev/null | awk '{print $1}' | head -1", (err, stdout) => {
      const name = (stdout || "").trim()
      if (!name) log.warn("lpstat found no printers in CUPS.")
      resolve(name || null)
    })
  })
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

// ── Page range helper ────────────────────────────────────────────────────────

function buildLpPageRange(pageRange) {
  if (!pageRange || pageRange === "all" || pageRange.trim() === "") return ""
  return `-o page-ranges=${pageRange.trim()}`
}

// ── Main print function ──────────────────────────────────────────────────────

/**
 * Print a file with the given options.
 * Handles both Linux (CUPS) and Windows (SumatraPDF / pdf-to-printer).
 */
async function printFile(filePath, printOptions) {
  const opts      = printOptions || {}
  const copies    = Math.max(1, parseInt(opts.copies) || 1)
  const colorBW   = opts.colorMode === "bw"
  const duplex    = opts.duplex === "double"
  const pageRange = buildLpPageRange(opts.pageRange)

  log.info(`Printing: ${path.basename(filePath)} | Copies:${copies} | BW:${colorBW} | Duplex:${duplex} | Pages:${opts.pageRange || "all"}`)

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
      return
    }

    const printerName = validPrinters[0].deviceId || validPrinters[0].name
    log.info(`Using printer: ${printerName}`)

    const sumatraOk = await trySumatraPrint(filePath, printerName, copies)
    if (sumatraOk) return

    await pdfToPrinter.print(filePath, { printer: printerName, copies })
    log.info(`Print submitted (pdf-to-printer): ${path.basename(filePath)}`)
    return
  }

  // ── Linux / macOS — CUPS lp ───────────────────────────────────────────────
  const printerName = await getCupsPrinter()
  if (!printerName) {
    throw new Error("No CUPS printer found. Add a printer via: sudo system-config-printer")
  }

  log.info(`Using CUPS printer: ${printerName}`)

  const lpArgs = [
    "lp",
    `-d "${printerName}"`,
    `-n ${copies}`,
    "-o media=A4",
    "-o fit-to-page",
    duplex ? "-o sides=two-sided-long-edge" : "-o sides=one-sided",
    colorBW ? "-o ColorModel=Gray" : "",
    pageRange,
    `"${filePath}"`
  ].filter(Boolean).join(" ")

  log.info(`lp command: ${lpArgs}`)

  return new Promise((resolve, reject) => {
    exec(lpArgs, (error, stdout, stderr) => {
      if (error) {
        log.error(`lp error: ${error.message}`)
        reject(new Error(`Print failed: ${error.message}`))
        return
      }
      log.info(`Print submitted: ${path.basename(filePath)} | ${stdout.trim()}`)
      resolve(stdout)
    })
  })
}


// ── Print to explicitly-named printer (SX/DX routing) ────────────────────────

/**
 * Print a file to a SPECIFIC named printer.
 * Used by the SX/DX router in agent.js — bypasses auto-detection.
 * @param {string} filePath     - Path to the file to print
 * @param {string} printerName  - Exact OS printer name from config.json
 * @param {object} printOptions - { copies, colorMode, duplex, pageRange }
 */
async function printFileToNamed(filePath, printerName, printOptions) {
  const opts      = printOptions || {}
  const copies    = Math.max(1, parseInt(opts.copies) || 1)
  const colorBW   = opts.colorMode !== "color"
  const duplex    = opts.duplex === "double"
  const pageRange = buildLpPageRange(opts.pageRange)

  log.info(`Routing to printer: "${printerName}" | Copies:${copies} | BW:${colorBW} | Duplex:${duplex}`)

  // ── Windows ──────────────────────────────────────────────────────────────
  if (process.platform === "win32") {
    let pdfToPrinter
    try { pdfToPrinter = require("pdf-to-printer") } catch (_) {
      throw new Error("pdf-to-printer not installed. Run: npm install pdf-to-printer")
    }

    const sumatraOk = await trySumatraPrint(filePath, printerName, copies)
    if (sumatraOk) return

    await pdfToPrinter.print(filePath, { printer: printerName, copies })
    log.info(`Print submitted (pdf-to-printer) → "${printerName}": ${path.basename(filePath)}`)
    return
  }

  // ── Linux / macOS — CUPS lp ──────────────────────────────────────────
  const { execFile } = require("child_process")

  const lpArgs = [
    "-d", printerName,
    "-n", String(copies),
    "-o", "media=A4",
    "-o", "fit-to-page",
    "-o", duplex ? "sides=two-sided-long-edge" : "sides=one-sided",
  ]

  if (pageRange) {
    // pageRange from buildLpPageRange returns e.g. "-o page-ranges=1-3"
    const pr = pageRange.replace(/^-o /, "")
    if (pr) lpArgs.push("-o", pr)
  }

  lpArgs.push(filePath)

  log.info(`lp command (named): lp ${lpArgs.join(" ")}`)

  return new Promise((resolve, reject) => {
    execFile("lp", lpArgs, (error, stdout, stderr) => {
      if (error) {
        log.error(`lp error: ${error.message}`)
        if (stderr) log.error(`lp stderr: ${stderr}`)
        reject(new Error(`Print failed: ${error.message}`))
        return
      }
      log.info(`Print submitted → "${printerName}": ${path.basename(filePath)} | ${stdout.trim()}`)
      resolve(stdout)
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

module.exports = {
  getWorkDir,
  normalizePdfToA4,
  imageToA4Pdf,
  printFile,
  printFileToNamed,
  cleanup
}


