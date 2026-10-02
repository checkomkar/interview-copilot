import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

const MAX_FILE_BYTES = 15 * 1024 * 1024

export const RESUME_EXTENSIONS = ['pdf', 'docx', 'txt', 'md']

/** Extract plain text from a resume file (PDF, DOCX, TXT/MD). Throws a user-facing Error. */
export async function extractDocumentText(path: string): Promise<{ fileName: string; text: string }> {
  const fileName = basename(path)
  const ext = extname(path).slice(1).toLowerCase()
  if (!RESUME_EXTENSIONS.includes(ext)) throw new Error(`Unsupported file type ".${ext}". Use PDF, DOCX or TXT.`)
  const { size } = await stat(path)
  if (size > MAX_FILE_BYTES) throw new Error('File is larger than 15 MB.')
  const buf = await readFile(path)

  let text: string
  if (ext === 'pdf') {
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: new Uint8Array(buf) })
    try {
      text = (await parser.getText()).text
    } finally {
      await parser.destroy()
    }
  } else if (ext === 'docx') {
    const mammoth = await import('mammoth')
    text = (await mammoth.extractRawText({ buffer: buf })).value
  } else {
    text = buf.toString('utf8')
  }

  text = normalize(text)
  if (!text) throw new Error('No text found in this file (is it a scanned image?). Paste the text instead.')
  return { fileName, text }
}

/** Collapse runs of blank lines and trailing spaces left by PDF extraction. */
export function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/^-- \d+ of \d+ --$/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
