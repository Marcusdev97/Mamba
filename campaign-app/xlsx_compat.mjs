// Compatibility shim for the old "@oai/artifact-tool" sandbox module.
//
// The original scripts were generated inside an agent sandbox that provided a
// built-in "@oai/artifact-tool" package. That package does not exist on the
// public npm registry, so the scripts could not run outside the sandbox.
//
// This module re-implements the small slice of that API the scripts actually
// use (FileBlob, SpreadsheetFile, Workbook -> worksheets.getItemAt ->
// getUsedRange().values) on top of SheetJS (the "xlsx" package).
//
// It also adds transparent support for Apple Numbers (.numbers) files: SheetJS
// cannot read Numbers' native format, so on macOS we ask the Numbers app to
// export a temporary .xlsx copy, then read that. This means you can keep your
// leads in Numbers and never have to export by hand.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as XLSX from "xlsx";

const execFileAsync = promisify(execFile);

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// If the requested file isn't there, look for a sibling with the same name but a
// different supported extension. This lets the default "Untitled spreadsheet.xlsx"
// transparently fall back to "Untitled spreadsheet.numbers" (or .csv).
async function resolveSource(requestedPath) {
  if (await fileExists(requestedPath)) return requestedPath;
  const dir = path.dirname(requestedPath);
  const base = path.basename(requestedPath, path.extname(requestedPath));
  for (const ext of [".xlsx", ".numbers", ".csv", ".tsv", ".xlsm"]) {
    const candidate = path.join(dir, base + ext);
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error(`ENOENT: no such file or directory, open '${requestedPath}'`);
}

// Use the macOS Numbers app to export a .numbers file to a temporary .xlsx.
// Requires macOS + Numbers installed. The first run will pop a one-time macOS
// prompt asking to allow controlling Numbers — click "OK"/"Allow".
//
// macOS protects Desktop/Documents/Downloads (TCC). Numbers, driven via
// automation, is denied permission to open files there ("Operation not
// permitted"). To avoid that we copy the .numbers file to /Users/Shared (a
// non-protected location every app can read) and run Numbers against the copy.
async function convertNumbersToXlsx(numbersPath) {
  if (process.platform !== "darwin") {
    throw new Error(
      `Cannot read "${path.basename(numbersPath)}": .numbers files need the macOS Numbers app to convert. ` +
      `Export the file to .xlsx or .csv instead.`
    );
  }

  const workDir = path.join("/Users/Shared", "mamba_numbers_tmp");
  await fs.mkdir(workDir, { recursive: true });
  const stamp = Date.now();
  const srcCopy = path.join(workDir, `src_${stamp}.numbers`);
  try {
    await fs.copyFile(numbersPath, srcCopy);
  } catch (err) {
    throw new Error(
      `Could not stage "${path.basename(numbersPath)}" for conversion (${err.message}). ` +
      `If this is a permissions error, grant Terminal "Full Disk Access" in ` +
      `System Settings > Privacy & Security.`
    );
  }
  const outPath = path.join(workDir, `export_${stamp}.xlsx`);
  // Note: Numbers' `open` command returns `missing value`, so we must reference
  // `front document` after the open completes rather than the return value.
  const script = `
on run argv
  set inPath to item 1 of argv
  set outPath to item 2 of argv
  tell application "Numbers"
    launch
    activate
    set beforeCount to count of documents
    open (POSIX file inPath)
    set waited to 0
    repeat until (count of documents) > beforeCount
      delay 0.5
      set waited to waited + 0.5
      if waited > 60 then error "Numbers did not open the document in time"
    end repeat
    set theDoc to front document
    export theDoc to (POSIX file outPath) as Microsoft Excel
    close theDoc saving no
  end tell
end run`;
  try {
    await execFileAsync("osascript", ["-e", script, srcCopy, outPath]);
  } catch (err) {
    await fs.rm(srcCopy, { force: true }).catch(() => {});
    throw new Error(
      `Failed to convert "${path.basename(numbersPath)}" via Numbers. ` +
      `Make sure Numbers is installed and you allowed automation access. ` +
      `Original error: ${err.message}`
    );
  }
  await fs.rm(srcCopy, { force: true }).catch(() => {});
  if (!(await fileExists(outPath))) {
    throw new Error(`Numbers export did not produce a file for "${path.basename(numbersPath)}".`);
  }
  return outPath;
}

// Read a spreadsheet file into a SheetJS workbook, handling .numbers transparently.
async function readWorkbookFromPath(filePath) {
  const resolved = await resolveSource(filePath);
  const ext = path.extname(resolved).toLowerCase();
  if (ext === ".numbers") {
    const xlsxPath = await convertNumbersToXlsx(resolved);
    const buffer = await fs.readFile(xlsxPath);
    await fs.rm(xlsxPath, { force: true }).catch(() => {});
    return XLSX.read(buffer, { type: "buffer", cellDates: true });
  }
  const buffer = await fs.readFile(resolved);
  return XLSX.read(buffer, { type: "buffer", cellDates: true });
}

// Turn a SheetJS worksheet into the { values: [][] } "used range" shape the
// scripts expect: a rectangular array of rows, each an array of cell values.
function sheetToUsedRange(worksheet) {
  const values = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,      // return arrays of cells, not objects keyed by header
    raw: true,      // keep numbers/dates as values rather than formatted strings
    defval: null,   // fill empty cells so column positions stay aligned
    blankrows: true // keep blank rows so row indexes match the spreadsheet
  });
  return { values };
}

function wrapWorkbook(workbook) {
  return {
    worksheets: {
      getItemAt(index) {
        const name = workbook.SheetNames[index];
        const worksheet = workbook.Sheets[name];
        if (!worksheet) {
          throw new Error(`Worksheet at index ${index} not found`);
        }
        return {
          // Accept (and ignore) the optional `valuesOnly` argument the old API took.
          getUsedRange() {
            return sheetToUsedRange(worksheet);
          }
        };
      }
    }
  };
}

export const FileBlob = {
  // Returns a lightweight handle. Conversion/reading happens in importXlsx so we
  // only touch Numbers once, lazily.
  async load(filePath) {
    return { __path: filePath };
  }
};

export const SpreadsheetFile = {
  async importXlsx(blob) {
    const workbook = await readWorkbookFromPath(blob.__path);
    return wrapWorkbook(workbook);
  }
};

export const Workbook = {
  async fromCSV(csvText, _options = {}) {
    const workbook = XLSX.read(csvText, { type: "string", cellDates: true });
    return wrapWorkbook(workbook);
  }
};

export default { FileBlob, SpreadsheetFile, Workbook };
