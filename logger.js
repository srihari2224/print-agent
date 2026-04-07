/**
 * logger.js — File + console logging with rotation
 */
const fs = require("fs")
const path = require("path")

const LOG_DIR = path.join(process.cwd(), "logs")
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })

const LOG_FILE = path.join(LOG_DIR, "agent.log")
const MAX_LOG_BYTES = 5 * 1024 * 1024  // 5 MB rotation

function ts() {
  return new Date().toISOString()
}

function write(level, msg) {
  const line = `[${ts()}] [${level}] ${msg}\n`
  process.stdout.write(line)
  try {
    // Simple rotation: if log exceeds 5MB, rename and start fresh
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE)
      if (stat.size > MAX_LOG_BYTES) {
        fs.renameSync(LOG_FILE, LOG_FILE + ".old")
      }
    }
    fs.appendFileSync(LOG_FILE, line)
  } catch (_) {}
}

module.exports = {
  info:  (msg) => write("INFO ", msg),
  warn:  (msg) => write("WARN ", msg),
  error: (msg) => write("ERROR", msg),
  debug: (msg) => write("DEBUG", msg),
  logFile: LOG_FILE
}
